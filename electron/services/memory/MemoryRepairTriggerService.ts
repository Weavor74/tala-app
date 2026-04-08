/**
 * MemoryRepairTriggerService.ts — Memory repair signal emitter
 *
 * Emits structured MemoryRepairTrigger events when the memory subsystem
 * transitions into a state that warrants a self-repair attempt.
 *
 * Design intent
 * ─────────────
 * This service does NOT perform repair logic itself.  It is a lightweight
 * signal bus that:
 *   1. Emits MemoryRepairTrigger objects via TelemetryBus so that Phase 4+
 *      repair loops, diagnostic panels, and audit trails can subscribe.
 *   2. Tracks the last emitted trigger so callers can avoid flooding.
 *   3. Guards against emitting duplicate triggers for the same failure
 *      within a configurable de-duplication window.
 *
 * Usage
 * ─────
 * const repairService = MemoryRepairTriggerService.getInstance();
 * repairService.maybeEmit(healthStatus);
 *
 * Subscribers register via TelemetryBus for events of type
 * 'memory.repair_trigger'.
 */

import { TelemetryBus } from '../telemetry/TelemetryBus';
import type {
    MemoryFailureReason,
    MemoryHealthStatus,
    MemoryRepairTrigger,
    MemorySubsystemState,
} from '../../../shared/memory/MemoryHealthStatus';

// ---------------------------------------------------------------------------
// De-duplication window
// ---------------------------------------------------------------------------

/**
 * Minimum milliseconds between two triggers for the same failure reason.
 * Prevents flooding during persistent failure states (e.g. Postgres down).
 */
const DEDUP_WINDOW_MS = 30_000; // 30 seconds

// ---------------------------------------------------------------------------
// MemoryRepairTriggerService
// ---------------------------------------------------------------------------

export class MemoryRepairTriggerService {
    private static _instance: MemoryRepairTriggerService | null = null;

    /** Last trigger emitted per failure reason, keyed by reason string. */
    private readonly _lastEmittedAt = new Map<MemoryFailureReason, number>();
    /** Full log of all triggers emitted this session (capped at 200). */
    private readonly _triggerLog: MemoryRepairTrigger[] = [];

    private constructor() {}

    static getInstance(): MemoryRepairTriggerService {
        if (!MemoryRepairTriggerService._instance) {
            MemoryRepairTriggerService._instance = new MemoryRepairTriggerService();
        }
        return MemoryRepairTriggerService._instance;
    }

    /**
     * Inspect the supplied MemoryHealthStatus and emit a MemoryRepairTrigger
     * via TelemetryBus if the state warrants it.
     *
     * A trigger is emitted when:
     *   - shouldTriggerRepair = true in the status, AND
     *   - the de-duplication window has elapsed since the last trigger for the
     *     same primary failure reason.
     */
    maybeEmit(status: MemoryHealthStatus): void {
        if (!status.shouldTriggerRepair) return;

        const primaryReason = this._pickPrimaryReason(status);
        const severity = this._mapSeverity(status.state);

        const now = Date.now();
        const lastAt = this._lastEmittedAt.get(primaryReason) ?? 0;
        if (now - lastAt < DEDUP_WINDOW_MS) return;

        this._lastEmittedAt.set(primaryReason, now);

        const trigger: MemoryRepairTrigger = {
            severity,
            reason: primaryReason,
            state: status.state,
            emittedAt: status.evaluatedAt,
            details: {
                mode: status.mode,
                capabilities: status.capabilities,
                allReasons: status.reasons,
                hardDisabled: status.hardDisabled,
                summary: status.summary,
            },
        };

        this._recordTrigger(trigger);
        this._emit(trigger);
    }

    /**
     * Directly emit a MemoryRepairTrigger for a specific failure reason
     * without consulting MemoryHealthStatus.  Used when a failure is detected
     * inline (e.g. canonical memory init failure during startup).
     */
    emitDirect(
        reason: MemoryFailureReason,
        state: MemorySubsystemState,
        severity: MemoryRepairTrigger['severity'],
        details?: Record<string, unknown>,
    ): void {
        const now = Date.now();
        const lastAt = this._lastEmittedAt.get(reason) ?? 0;
        if (now - lastAt < DEDUP_WINDOW_MS) return;

        this._lastEmittedAt.set(reason, now);

        const trigger: MemoryRepairTrigger = {
            severity,
            reason,
            state,
            emittedAt: new Date().toISOString(),
            details,
        };

        this._recordTrigger(trigger);
        this._emit(trigger);
    }

    /** Returns a snapshot of all triggers emitted this session. */
    getTriggerLog(): ReadonlyArray<MemoryRepairTrigger> {
        return this._triggerLog;
    }

    /** Resets de-duplication state and trigger log (primarily for testing). */
    reset(): void {
        this._lastEmittedAt.clear();
        this._triggerLog.length = 0;
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private _emit(trigger: MemoryRepairTrigger): void {
        const bus = TelemetryBus.getInstance();
        bus.emit({
            event: 'memory.repair_trigger',
            subsystem: 'memory',
            executionId: 'memory-repair',
            payload: trigger as unknown as Record<string, unknown>,
        });
    }

    private _recordTrigger(trigger: MemoryRepairTrigger): void {
        this._triggerLog.push(trigger);
        if (this._triggerLog.length > 200) {
            this._triggerLog.shift();
        }
    }

    /**
     * Pick the single most important failure reason from the status.
     * Priority: canonical > mem0 > extraction > embeddings > graph > rag > unknown
     */
    private _pickPrimaryReason(status: MemoryHealthStatus): MemoryFailureReason {
        const PRIORITY: MemoryFailureReason[] = [
            'canonical_unavailable',
            'canonical_init_failed',
            'mem0_unavailable',
            'mem0_mode_canonical_only',
            'extraction_provider_unavailable',
            'embedding_provider_unavailable',
            'graph_projection_unavailable',
            'rag_logging_unavailable',
            'runtime_mismatch',
        ];
        for (const r of PRIORITY) {
            if (status.reasons.includes(r)) return r;
        }
        return 'unknown';
    }

    private _mapSeverity(state: MemorySubsystemState): MemoryRepairTrigger['severity'] {
        switch (state) {
            case 'critical':  return 'critical';
            case 'degraded':  return 'error';
            case 'reduced':   return 'warning';
            case 'disabled':  return 'warning';
            default:          return 'info';
        }
    }
}
