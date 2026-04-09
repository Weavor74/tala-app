/**
 * MemoryRepairExecutionService.ts — Memory Repair Execution Layer
 *
 * Consumes memory.repair_trigger and memory.health_transition signals and
 * executes bounded, deterministic recovery actions against the memory subsystem.
 *
 * Design invariants
 * ─────────────────
 * 1. Bounded  — max attempts per action, cooldown between cycles, storm
 *               prevention cap.  No infinite retry loops.
 * 2. Deterministic — same MemoryHealthStatus produces the same repair plan.
 * 3. Observable  — structured telemetry events emitted before and after each
 *                  action and cycle.
 * 4. Capability-aware — each failure reason maps to a specific set of repair
 *                       actions.  Backlog-only issues drain deferred work, not
 *                       restart everything.
 * 5. Canonical authority — deferred work is only replayed when canonical memory
 *                          is confirmed healthy.
 * 6. Strict-mode aware — when hardDisabled is true and state is 'disabled' (strict policy),
 *                        the system remains blocked rather than partially recovering into a
 *                        non-policy-compliant state, unless the failure is canonical.
 *
 * Architecture
 * ────────────
 * MemoryRepairTriggerService / TelemetryBus
 *   → MemoryRepairExecutionService.handleRepairTrigger()
 *   → _buildRepairPlan(MemoryHealthStatus) → ordered RepairActionKind[]
 *   → execute serially, re-evaluate health after each action
 *   → emit memory.repair_started / repair_action_* / repair_completed
 *   → drain deferred work if canonical is healthy after recovery
 *
 * Callers (e.g. AgentService / main.ts) must:
 *   1. Call setHealthStatusProvider(() => memoryService.getHealthStatus())
 *   2. Register RepairActionHandlers for each action kind they can service
 *   3. Optionally call setDeferredWorkDrainCallback(cb) to drain backlog on recovery
 *   4. Call start() to subscribe to TelemetryBus
 */

import { TelemetryBus } from '../telemetry/TelemetryBus';
import type { RuntimeEventHandler } from '../telemetry/TelemetryBus';
import type {
    MemoryFailureReason,
    MemoryHealthStatus,
    MemoryRepairTrigger,
    MemorySubsystemState,
} from '../../../shared/memory/MemoryHealthStatus';

// ---------------------------------------------------------------------------
// Repair action kinds
// ---------------------------------------------------------------------------

/**
 * Enumeration of repair actions the executor may attempt.
 *
 * Each kind maps to a caller-registered RepairActionHandler.  The built-in
 * pseudo-actions 're_evaluate_health' and 'drain_deferred_work' are handled
 * internally and do not require a registered handler.
 */
export type RepairActionKind =
    | 'reconnect_canonical'
    | 'reinit_canonical'
    | 'reconnect_mem0'
    | 're_resolve_providers'
    | 'reconnect_graph'
    | 'reconnect_rag'
    | 'drain_deferred_work'
    | 're_evaluate_health';

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

/**
 * Async function that attempts a single repair action.
 * Returns true when the action succeeded, false when it failed but was
 * non-fatal (executor will continue to the next action).
 * May throw — the executor catches all errors and treats them as failure.
 */
export type RepairActionHandler = () => Promise<boolean>;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type RepairActionResult = {
    action: RepairActionKind;
    success: boolean;
    durationMs: number;
    skipped: boolean;
    error?: string;
};

export type MemoryRepairCycleOutcome = 'recovered' | 'partial' | 'failed' | 'skipped';

export type MemoryRepairCycleResult = {
    cycleId: string;
    outcome: MemoryRepairCycleOutcome;
    reason: string;
    actionsExecuted: RepairActionResult[];
    finalState: MemorySubsystemState;
    durationMs: number;
};

// ---------------------------------------------------------------------------
// Executor observable state
// ---------------------------------------------------------------------------

export type MemoryRepairExecutorState = {
    isRunning: boolean;
    lastRunAt?: string;
    lastOutcome?: MemoryRepairCycleOutcome;
    activeReason?: string;
    attemptCounters: Record<string, number>;
    cycleCount: number;
    lastCycleId?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum ms between repair cycles for the same primary failure reason. */
const CYCLE_COOLDOWN_MS = 30_000;

/** Maximum repair actions executed per cycle (prevents runaway plans). */
const MAX_ACTIONS_PER_CYCLE = 6;

/**
 * Maximum total repair cycles in CYCLE_STORM_WINDOW_MS.
 * Prevents restart storms when the subsystem is persistently unavailable.
 */
const MAX_CYCLES_PER_WINDOW = 10;

/** Rolling window for storm prevention (1 hour). */
const CYCLE_STORM_WINDOW_MS = 3_600_000;

/**
 * Maximum accumulated attempts per action kind across all cycles.
 * Ensures the executor gives up on unresolvable failures.
 */
const MAX_ATTEMPTS_PER_ACTION = 3;

// ---------------------------------------------------------------------------
// MemoryRepairExecutionService
// ---------------------------------------------------------------------------

export class MemoryRepairExecutionService {
    private static _instance: MemoryRepairExecutionService | null = null;

    // ── State ────────────────────────────────────────────────────────────────

    private _isRunning = false;
    private _lastRunAt: string | undefined;
    private _lastOutcome: MemoryRepairCycleOutcome | undefined;
    private _activeReason: string | undefined;
    private _attemptCounters: Record<string, number> = {};
    private _cycleCount = 0;
    private _lastCycleId: string | undefined;

    /** Timestamps (ms) of recent cycle starts — used for storm detection. */
    private readonly _recentCycleTimes: number[] = [];

    /** Last cycle start time per primary reason — used for cooldown. */
    private readonly _lastCycleAtByReason = new Map<string, number>();

    /** Registered repair action handlers keyed by action kind. */
    private readonly _handlers = new Map<RepairActionKind, RepairActionHandler>();

    /** Health status provider injected by the caller. */
    private _getHealthStatus: (() => MemoryHealthStatus) | null = null;

    /**
     * Optional deferred-work drain callback.
     * Called after a successful recovery cycle when canonical memory is healthy.
     * May be async — the executor awaits it so that drain results are reflected
     * in telemetry before the cycle completes.
     */
    private _drainDeferredWork: (() => Promise<void> | void) | null = null;

    /** TelemetryBus unsubscribe handle (non-null when started). */
    private _unsub: (() => void) | null = null;

    private constructor() {}

    static getInstance(): MemoryRepairExecutionService {
        if (!MemoryRepairExecutionService._instance) {
            MemoryRepairExecutionService._instance = new MemoryRepairExecutionService();
        }
        return MemoryRepairExecutionService._instance;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /**
     * Subscribe to 'memory.repair_trigger' events from TelemetryBus.
     * Safe to call multiple times — repeated calls are no-ops when already started.
     */
    start(): void {
        if (this._unsub !== null) return;

        const handler: RuntimeEventHandler = (event) => {
            if (event.event !== 'memory.repair_trigger') return;
            const trigger = event.payload as unknown as MemoryRepairTrigger;
            if (!trigger || typeof trigger !== 'object') return;
            // Fire-and-forget; errors are caught inside handleRepairTrigger
            this.handleRepairTrigger(trigger).catch(() => {});
        };

        this._unsub = TelemetryBus.getInstance().subscribe(handler);
    }

    /**
     * Unsubscribe from TelemetryBus.
     * Does not abort an in-progress cycle — it will complete naturally.
     */
    stop(): void {
        if (this._unsub) {
            this._unsub();
            this._unsub = null;
        }
    }

    // ── Configuration ────────────────────────────────────────────────────────

    /**
     * Register a handler for a repair action kind.
     * When the action is planned, the handler is called and its boolean return
     * value indicates success.  If no handler is registered for an action,
     * the action is recorded as skipped.
     */
    registerRepairHandler(action: RepairActionKind, handler: RepairActionHandler): void {
        this._handlers.set(action, handler);
    }

    /**
     * Provide the health status source.
     * Must be set before the first repair cycle.
     * Example: svc.setHealthStatusProvider(() => memoryService.getHealthStatus())
     */
    setHealthStatusProvider(provider: () => MemoryHealthStatus): void {
        this._getHealthStatus = provider;
    }

    /**
     * Register a callback invoked to drain deferred-work backlog after recovery.
     * Only called when canonical memory is confirmed healthy after a cycle.
     * The callback may return a Promise — it will be awaited.
     */
    setDeferredWorkDrainCallback(cb: () => Promise<void> | void): void {
        this._drainDeferredWork = cb;
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Handle an incoming MemoryRepairTrigger.
     *
     * Applies cooldown and storm-prevention guards first.  If guards reject,
     * returns a 'skipped' result without starting a cycle.
     */
    async handleRepairTrigger(trigger: MemoryRepairTrigger): Promise<MemoryRepairCycleResult> {
        const reason = trigger.reason;
        const now = Date.now();

        const lastAt = this._lastCycleAtByReason.get(reason) ?? 0;
        if (now - lastAt < CYCLE_COOLDOWN_MS) {
            return this._skippedResult(reason);
        }

        return this.runRepairCycle(reason);
    }

    /**
     * Run a complete repair cycle for the given reason string.
     *
     * 1. Evaluates current health via the registered health status provider.
     * 2. Builds a deterministic repair plan from the health status.
     * 3. Executes each planned action serially.
     * 4. Re-evaluates health after each action; stops when health is acceptable.
     * 5. Drains deferred work if canonical is healthy after recovery.
     * 6. Emits structured telemetry throughout.
     *
     * Returns a MemoryRepairCycleResult describing the outcome.
     */
    async runRepairCycle(reason?: string): Promise<MemoryRepairCycleResult> {
        // ── Concurrency guard ──────────────────────────────────────────────
        if (this._isRunning) {
            return this._skippedResult(reason ?? 'unknown');
        }

        // ── Storm prevention ───────────────────────────────────────────────
        const now = Date.now();
        this._pruneRecentCycles(now);
        if (this._recentCycleTimes.length >= MAX_CYCLES_PER_WINDOW) {
            return this._skippedResult(reason ?? 'unknown');
        }

        // ── Require health status provider ─────────────────────────────────
        const initialStatus = this._evalHealth();
        if (!initialStatus) {
            return this._skippedResult(reason ?? 'unknown');
        }

        // ── Begin cycle ────────────────────────────────────────────────────
        this._isRunning = true;
        this._activeReason = reason;
        const cycleId = `repair-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this._lastCycleId = cycleId;
        const cycleStartMs = Date.now();
        this._recentCycleTimes.push(now);
        this._lastCycleAtByReason.set(reason ?? 'unknown', now);
        this._cycleCount++;

        this._emitCycleStarted(cycleId, reason ?? 'unknown', initialStatus);

        const actionsExecuted: RepairActionResult[] = [];

        // ── Strict-mode pre-check ──────────────────────────────────────────
        // In strict mode with hard-disable not caused by canonical failure,
        // the policy requires the system to remain blocked rather than partially
        // recovering into a non-strict-compliant state.
        if (
            initialStatus.hardDisabled &&
            initialStatus.state === 'disabled' &&
            !initialStatus.reasons.includes('canonical_unavailable') &&
            !initialStatus.reasons.includes('canonical_init_failed')
        ) {
            const result = this._buildResult(
                cycleId, 'failed', reason ?? 'unknown',
                actionsExecuted, initialStatus.state, cycleStartMs,
            );
            this._finalizeCycle(result);
            return result;
        }

        // ── Build repair plan ──────────────────────────────────────────────
        const plan = this._buildRepairPlan(
            initialStatus,
            reason as MemoryFailureReason | undefined,
        );

        let currentStatus = initialStatus;
        let actionsRun = 0;

        // ── Execute actions serially ───────────────────────────────────────
        for (const action of plan) {
            if (actionsRun >= MAX_ACTIONS_PER_CYCLE) break;

            // Stop early if health is already acceptable
            if (this._isHealthAcceptable(currentStatus)) break;

            // ── Handle built-in pseudo-actions ─────────────────────────────
            if (action === 're_evaluate_health') {
                const reEval = this._evalHealth();
                if (reEval) currentStatus = reEval;
                actionsExecuted.push({ action, success: true, durationMs: 0, skipped: false });
                actionsRun++;
                if (this._isHealthAcceptable(currentStatus)) break;
                continue;
            }

            if (action === 'drain_deferred_work') {
                if (this._drainDeferredWork && currentStatus.capabilities.canonical) {
                    const drainStart = Date.now();
                    try {
                        await this._drainDeferredWork();
                        actionsExecuted.push({ action, success: true, durationMs: Date.now() - drainStart, skipped: false });
                    } catch (err) {
                        actionsExecuted.push({
                            action,
                            success: false,
                            durationMs: Date.now() - drainStart,
                            skipped: false,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                } else {
                    actionsExecuted.push({ action, success: false, durationMs: 0, skipped: true });
                }
                actionsRun++;
                continue;
            }

            // ── Attempt cap check ──────────────────────────────────────────
            const sessionAttempts = this._attemptCounters[action] ?? 0;
            if (sessionAttempts >= MAX_ATTEMPTS_PER_ACTION) {
                actionsExecuted.push({
                    action,
                    success: false,
                    durationMs: 0,
                    skipped: true,
                    error: 'max_attempts_reached',
                });
                actionsRun++;
                continue;
            }

            // ── Execute via registered handler ─────────────────────────────
            const handler = this._handlers.get(action);
            if (!handler) {
                actionsExecuted.push({ action, success: false, durationMs: 0, skipped: true });
                actionsRun++;
                continue;
            }

            this._emitActionStarted(cycleId, action);
            const actionStart = Date.now();
            let success = false;
            let error: string | undefined;

            try {
                success = await handler();
            } catch (err) {
                error = err instanceof Error ? err.message : String(err);
                success = false;
            }

            const durationMs = Date.now() - actionStart;
            this._attemptCounters[action] = sessionAttempts + 1;
            actionsExecuted.push({ action, success, durationMs, skipped: false, error });
            actionsRun++;

            this._emitActionCompleted(cycleId, action, success, durationMs, error);

            // Re-evaluate health after each action
            const reEval = this._evalHealth();
            if (reEval) currentStatus = reEval;
        }

        // ── Post-cycle deferred work drain ────────────────────────────────
        // Only when canonical is confirmed healthy to avoid premature replay.
        if (this._isHealthAcceptable(currentStatus) && currentStatus.capabilities.canonical) {
            if (this._drainDeferredWork) {
                try {
                    await this._drainDeferredWork();
                } catch {
                    // drain errors are non-fatal
                }
            }
        }

        // ── Determine outcome ──────────────────────────────────────────────
        const outcome = this._deriveOutcome(currentStatus, actionsExecuted, initialStatus);
        const result = this._buildResult(
            cycleId, outcome, reason ?? 'unknown',
            actionsExecuted, currentStatus.state, cycleStartMs,
        );

        this._finalizeCycle(result);
        return result;
    }

    /** Returns a snapshot of the current executor state. */
    getState(): MemoryRepairExecutorState {
        return {
            isRunning: this._isRunning,
            lastRunAt: this._lastRunAt,
            lastOutcome: this._lastOutcome,
            activeReason: this._activeReason,
            attemptCounters: { ...this._attemptCounters },
            cycleCount: this._cycleCount,
            lastCycleId: this._lastCycleId,
        };
    }

    /**
     * Resets all executor state.  Intended for use in tests only.
     * Also unregisters all handlers and clears the health provider reference.
     */
    reset(): void {
        this.stop();
        this._isRunning = false;
        this._lastRunAt = undefined;
        this._lastOutcome = undefined;
        this._activeReason = undefined;
        this._attemptCounters = {};
        this._cycleCount = 0;
        this._lastCycleId = undefined;
        this._recentCycleTimes.length = 0;
        this._lastCycleAtByReason.clear();
        this._handlers.clear();
        this._getHealthStatus = null;
        this._drainDeferredWork = null;
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /**
     * Builds a deterministic, ordered repair plan from the provided health status
     * and optional primary failure reason.
     *
     * Priority order:
     *   1. Canonical failures  (highest priority — canonical is authority)
     *   2. mem0 failures
     *   3. Provider resolution failures
     *   4. Auxiliary failures  (graph, rag)
     *   5. Health re-evaluation  (always appended when plan has real actions)
     *   6. Deferred-work drain   (added when canonical is healthy and backlog-only)
     */
    private _buildRepairPlan(
        status: MemoryHealthStatus,
        _primaryReason?: MemoryFailureReason,
    ): RepairActionKind[] {
        const plan: RepairActionKind[] = [];
        const reasons = status.reasons;

        // Canonical failures (highest priority)
        if (reasons.includes('canonical_unavailable')) {
            plan.push('reconnect_canonical');
        }
        if (reasons.includes('canonical_init_failed')) {
            plan.push('reinit_canonical');
        }

        // mem0 failures
        if (reasons.includes('mem0_unavailable') || reasons.includes('mem0_mode_canonical_only')) {
            plan.push('reconnect_mem0');
        }

        // Provider resolution failures
        if (
            reasons.includes('extraction_provider_unavailable') ||
            reasons.includes('embedding_provider_unavailable') ||
            reasons.includes('runtime_mismatch')
        ) {
            plan.push('re_resolve_providers');
        }

        // Auxiliary failures
        if (reasons.includes('graph_projection_unavailable')) {
            plan.push('reconnect_graph');
        }
        if (reasons.includes('rag_logging_unavailable')) {
            plan.push('reconnect_rag');
        }

        // Always re-evaluate health at the end of a real plan
        if (plan.length > 0) {
            plan.push('re_evaluate_health');
        }

        // Backlog drain: add when canonical is healthy or when plan is empty
        // (backlog-only scenarios should drain without restarting everything)
        if (status.capabilities.canonical) {
            plan.push('drain_deferred_work');
        }

        return plan;
    }

    /** True when the current health state is acceptable and repair should stop. */
    private _isHealthAcceptable(status: MemoryHealthStatus): boolean {
        return status.state === 'healthy' || status.state === 'reduced';
    }

    /** Safe wrapper around the injected health status provider. */
    private _evalHealth(): MemoryHealthStatus | null {
        if (!this._getHealthStatus) return null;
        try {
            return this._getHealthStatus();
        } catch {
            return null;
        }
    }

    /**
     * Derive the cycle outcome from the final health status and action results.
     *
     * recovered — final health state is acceptable (healthy or reduced)
     * partial   — some improvement occurred but not fully recovered
     * failed    — no improvement; all actions failed or were skipped
     */
    private _deriveOutcome(
        finalStatus: MemoryHealthStatus,
        actions: RepairActionResult[],
        initialStatus: MemoryHealthStatus,
    ): MemoryRepairCycleOutcome {
        if (this._isHealthAcceptable(finalStatus)) return 'recovered';

        // Check if any real action succeeded (not just skipped / re-evaluate)
        const anySuccess = actions.some(a => a.success && !a.skipped &&
            a.action !== 're_evaluate_health' && a.action !== 'drain_deferred_work');

        if (finalStatus.state !== initialStatus.state) {
            // State improved (e.g. critical → degraded) but not fully acceptable
            return 'partial';
        }

        return anySuccess ? 'partial' : 'failed';
    }

    private _buildResult(
        cycleId: string,
        outcome: MemoryRepairCycleOutcome,
        reason: string,
        actions: RepairActionResult[],
        finalState: MemorySubsystemState,
        startMs: number,
    ): MemoryRepairCycleResult {
        return {
            cycleId,
            outcome,
            reason,
            actionsExecuted: actions,
            finalState,
            durationMs: Date.now() - startMs,
        };
    }

    private _finalizeCycle(result: MemoryRepairCycleResult): void {
        this._isRunning = false;
        this._lastRunAt = new Date().toISOString();
        this._lastOutcome = result.outcome;
        this._activeReason = undefined;
        this._emitCycleCompleted(result);
    }

    private _skippedResult(reason: string): MemoryRepairCycleResult {
        const currentStatus = this._evalHealth();
        return {
            cycleId: `skipped-${Date.now()}`,
            outcome: 'skipped',
            reason,
            actionsExecuted: [],
            finalState: currentStatus?.state ?? 'degraded',
            durationMs: 0,
        };
    }

    private _pruneRecentCycles(now: number): void {
        const cutoff = now - CYCLE_STORM_WINDOW_MS;
        while (this._recentCycleTimes.length > 0 && this._recentCycleTimes[0] < cutoff) {
            this._recentCycleTimes.shift();
        }
    }

    // ── Telemetry emission ───────────────────────────────────────────────────

    private _emitCycleStarted(cycleId: string, reason: string, status: MemoryHealthStatus): void {
        TelemetryBus.getInstance().emit({
            event: 'memory.repair_started',
            subsystem: 'memory',
            executionId: cycleId,
            payload: {
                cycleId,
                reason,
                initialState: status.state,
                initialMode: status.mode,
                reasons: status.reasons,
                hardDisabled: status.hardDisabled,
            },
        });
    }

    private _emitActionStarted(cycleId: string, action: RepairActionKind): void {
        TelemetryBus.getInstance().emit({
            event: 'memory.repair_action_started',
            subsystem: 'memory',
            executionId: cycleId,
            payload: { cycleId, action },
        });
    }

    private _emitActionCompleted(
        cycleId: string,
        action: RepairActionKind,
        success: boolean,
        durationMs: number,
        error?: string,
    ): void {
        TelemetryBus.getInstance().emit({
            event: 'memory.repair_action_completed',
            subsystem: 'memory',
            executionId: cycleId,
            payload: {
                cycleId,
                action,
                success,
                durationMs,
                ...(error !== undefined && { error }),
            },
        });
    }

    private _emitCycleCompleted(result: MemoryRepairCycleResult): void {
        TelemetryBus.getInstance().emit({
            event: 'memory.repair_completed',
            subsystem: 'memory',
            executionId: result.cycleId,
            payload: {
                cycleId: result.cycleId,
                outcome: result.outcome,
                reason: result.reason,
                finalState: result.finalState,
                durationMs: result.durationMs,
                actionsCount: result.actionsExecuted.length,
                actionsSucceeded: result.actionsExecuted.filter(a => a.success).length,
            },
        });
    }
}
