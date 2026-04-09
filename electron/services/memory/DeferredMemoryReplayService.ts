/**
 * DeferredMemoryReplayService.ts — Bounded deferred-work replay
 *
 * Manages the lifecycle of deferred memory tasks that could not execute
 * immediately because a required capability was unavailable at write time.
 * Works in concert with DeferredMemoryWorkRepository (persistent storage)
 * and MemoryRepairExecutionService (drain trigger).
 *
 * Design invariants
 * ─────────────────
 * 1. Bounded   — drain() processes at most DRAIN_BATCH_SIZE items per call.
 * 2. Policy-gated — health status is checked before each drain; capability
 *                   flags gate individual work kinds.
 * 3. Persistent — work items survive crash/restart (stored in Postgres).
 * 4. Observable  — structured telemetry events emitted for enqueue/drain/
 *                  item-complete/item-fail.
 * 5. Idempotent  — completed items are never retried; failed items get
 *                  exponential backoff up to maxAttempts, then dead-letter.
 * 6. Canonical authority — no items are replayed when canonical is unhealthy.
 *
 * Integration
 * ───────────
 * AgentService._wireRepairExecutor():
 *   executor.setDeferredWorkDrainCallback(() =>
 *       DeferredMemoryReplayService.getInstance().drain());
 *
 * AgentService.storeMemories() (suppressed write paths):
 *   DeferredMemoryReplayService.getInstance().enqueue({
 *       kind: 'graph_projection',
 *       canonicalMemoryId,
 *       turnId,
 *       payload: { ... },
 *   });
 */

import { TelemetryBus } from '../telemetry/TelemetryBus';
import type { DeferredMemoryWorkRepository, DeferredMemoryWorkKind, DeferredMemoryWorkItem, EnqueueDeferredWorkInput, DeferredWorkStats } from '../db/DeferredMemoryWorkRepository';
import type { MemoryHealthStatus } from '../../../shared/memory/MemoryHealthStatus';

// ---------------------------------------------------------------------------
// Worker handler type
// ---------------------------------------------------------------------------

/**
 * Async handler that attempts to execute a single deferred work item.
 * Returns true on success, false on a recoverable failure (item will be
 * retried with backoff).  May throw — the service catches all errors.
 */
export type DeferredWorkHandler = (item: DeferredMemoryWorkItem) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum items processed per drain() call. Callers may request less. */
const DRAIN_BATCH_SIZE = 25;

/** Hard cap on batchSize to enforce the bounded-drain invariant. */
const DRAIN_BATCH_SIZE_MAX = 100;

// ---------------------------------------------------------------------------
// DeferredMemoryReplayService
// ---------------------------------------------------------------------------

export class DeferredMemoryReplayService {
    private static _instance: DeferredMemoryReplayService | null = null;

    /** Persistent queue repository. Null until injected by AgentService. */
    private _repo: DeferredMemoryWorkRepository | null = null;

    /** Per-kind worker handlers. */
    private readonly _handlers = new Map<DeferredMemoryWorkKind, DeferredWorkHandler>();

    /** Health status provider injected by AgentService. */
    private _getHealthStatus: (() => MemoryHealthStatus) | null = null;

    /** True while a drain() call is executing (prevents double-drain). */
    private _draining = false;

    private constructor() {}

    static getInstance(): DeferredMemoryReplayService {
        if (!DeferredMemoryReplayService._instance) {
            DeferredMemoryReplayService._instance = new DeferredMemoryReplayService();
        }
        return DeferredMemoryReplayService._instance;
    }

    // ── Configuration ────────────────────────────────────────────────────────

    /** Inject the persistent repository (must be called before enqueue/drain). */
    setRepository(repo: DeferredMemoryWorkRepository): void {
        this._repo = repo;
    }

    /** Inject the health status provider. */
    setHealthStatusProvider(provider: () => MemoryHealthStatus): void {
        this._getHealthStatus = provider;
    }

    /**
     * Register an async handler for a specific work kind.
     * The handler receives the full DeferredMemoryWorkItem so it has access
     * to canonicalMemoryId, payload, sessionId, turnId, etc.
     */
    registerHandler(kind: DeferredMemoryWorkKind, handler: DeferredWorkHandler): void {
        this._handlers.set(kind, handler);
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Persist a new deferred work item.
     *
     * Safe to call even when the repository has not been injected yet — in
     * that case the enqueue is silently dropped and a warning is logged.
     * This maintains backward-compat with tests and startup sequences where
     * the repository may not be available.
     */
    async enqueue(input: EnqueueDeferredWorkInput): Promise<string | null> {
        if (!this._repo) {
            console.warn(
                '[DeferredMemoryReplayService] enqueue called without repository — ' +
                `kind=${input.kind} canonicalMemoryId=${input.canonicalMemoryId} — item dropped`,
            );
            return null;
        }

        try {
            const id = await this._repo.enqueue(input);
            this._emit('memory.deferred_work_enqueued', {
                id,
                kind: input.kind,
                canonicalMemoryId: input.canonicalMemoryId,
                sessionId: input.sessionId ?? null,
                turnId: input.turnId ?? null,
            });
            return id;
        } catch (err) {
            console.error('[DeferredMemoryReplayService] enqueue failed:', err);
            return null;
        }
    }

    /**
     * Drain a bounded batch of pending deferred work items.
     *
     * Health gates:
     *   - No drain at all if canonical is unhealthy.
     *   - extraction items only if health.capabilities.extraction is true.
     *   - embedding items only if health.capabilities.embeddings is true.
     *   - graph_projection items only if health.capabilities.graphProjection is true.
     *
     * Safe to call concurrently — concurrent calls after the first return
     * immediately without processing.
     */
    async drain(batchSize: number = DRAIN_BATCH_SIZE): Promise<void> {
        if (!this._repo) return;
        if (this._draining) return;

        const safeBatchSize = Math.max(1, Math.min(batchSize, DRAIN_BATCH_SIZE_MAX));
        const health = this._evalHealth();
        if (!health || !health.capabilities.canonical) {
            // Canonical authority is required for safe replay
            return;
        }

        // Determine which kinds are eligible given current health
        const eligibleKinds = this._eligibleKinds(health);
        if (eligibleKinds.length === 0) return;

        this._draining = true;

        this._emit('memory.deferred_work_drain_started', {
            eligibleKinds,
            batchSize: safeBatchSize,
            healthState: health.state,
        });

        let completed = 0;
        let failed = 0;

        try {
            const items = await this._repo.claimBatch(safeBatchSize, eligibleKinds);

            for (const item of items) {
                const handler = this._handlers.get(item.kind);

                if (!handler) {
                    // No handler registered — fail the item immediately so it
                    // re-enters the pending queue with exponential backoff.
                    // It will be retried on the next drain once a handler is registered.
                    await this._failItem(item, 'no_handler_registered');
                    failed++;
                    continue;
                }

                try {
                    const success = await handler(item);
                    if (success) {
                        await this._repo.markCompleted(item.id);
                        this._emit('memory.deferred_work_item_completed', {
                            id: item.id,
                            kind: item.kind,
                            canonicalMemoryId: item.canonicalMemoryId,
                            attemptCount: item.attemptCount + 1,
                        });
                        completed++;
                    } else {
                        await this._failItem(item, 'handler_returned_false');
                        failed++;
                    }
                } catch (err) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    await this._failItem(item, errorMsg);
                    failed++;
                }
            }
        } catch (err) {
            console.error('[DeferredMemoryReplayService] drain batch error:', err);
        } finally {
            this._draining = false;
        }

        this._emit('memory.deferred_work_drain_completed', {
            eligibleKinds,
            completed,
            failed,
            healthState: health.state,
        });
    }

    /**
     * Returns aggregate queue statistics.
     * Returns null when the repository is not available.
     */
    async getStats(): Promise<DeferredWorkStats | null> {
        if (!this._repo) return null;
        try {
            return await this._repo.getStats();
        } catch (err) {
            console.error('[DeferredMemoryReplayService] getStats failed:', err);
            return null;
        }
    }

    /**
     * Resets the singleton instance.  Intended for use in tests only.
     */
    reset(): void {
        this._repo = null;
        this._handlers.clear();
        this._getHealthStatus = null;
        this._draining = false;
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private _eligibleKinds(health: MemoryHealthStatus): DeferredMemoryWorkKind[] {
        const eligible: DeferredMemoryWorkKind[] = [];
        if (health.capabilities.extraction) eligible.push('extraction');
        if (health.capabilities.embeddings) eligible.push('embedding');
        if (health.capabilities.graphProjection) eligible.push('graph_projection');
        return eligible;
    }

    private async _failItem(item: DeferredMemoryWorkItem, error: string): Promise<void> {
        if (!this._repo) return;
        try {
            await this._repo.markFailed(item.id, error);
            this._emit('memory.deferred_work_item_failed', {
                id: item.id,
                kind: item.kind,
                canonicalMemoryId: item.canonicalMemoryId,
                attemptCount: item.attemptCount + 1,
                maxAttempts: item.maxAttempts,
                error,
            });
        } catch (err) {
            console.error('[DeferredMemoryReplayService] markFailed error:', err);
        }
    }

    private _evalHealth(): MemoryHealthStatus | null {
        if (!this._getHealthStatus) return null;
        try {
            return this._getHealthStatus();
        } catch {
            return null;
        }
    }

    private _emit(event: string, payload: Record<string, unknown>): void {
        try {
            TelemetryBus.getInstance().emit({
                event: event as any,
                subsystem: 'memory',
                executionId: 'deferred-work',
                payload,
            });
        } catch {
            // telemetry errors are non-fatal
        }
    }
}
