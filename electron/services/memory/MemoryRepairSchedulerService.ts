/**
 * MemoryRepairSchedulerService.ts — Scheduled memory repair analytics loop
 *
 * Runs on a fixed cadence (default: every 10 minutes) to:
 *   1. Compute recent repair analytics via MemoryRepairAnalyticsService
 *   2. Generate a reflection report via MemoryRepairReflectionService
 *   3. Derive a bounded maintenance decision via MemorySelfMaintenanceService
 *   4. Emit telemetry for the Reflection Dashboard / diagnostics
 *   5. Optionally request additional repair cycles or escalate via TelemetryBus
 *
 * Design invariants
 * ─────────────────
 * 1. Bounded cadence — fixed interval, no runaway loops.
 * 2. Concurrency guard — only one scheduled run at a time; overlapping calls
 *    are skipped (not queued) and recorded as skipped runs.
 * 3. No provider authority — does not change provider settings, integrity
 *    mode, or user config.  MemoryIntegrityPolicy remains authoritative.
 * 4. Graceful degradation — if the outcome repository is unavailable the
 *    run is skipped and logged.
 * 5. Observable — all run starts, completions, skips, and decisions are
 *    emitted to TelemetryBus.
 *
 * Usage
 * ─────
 * const scheduler = new MemoryRepairSchedulerService(outcomeRepo);
 * scheduler.start();   // begin the periodic loop
 * scheduler.stop();    // stop the loop (clears the interval)
 * await scheduler.runNow('manual');  // execute a run immediately
 */

import { MemoryRepairAnalyticsService } from './MemoryRepairAnalyticsService';
import { MemoryRepairReflectionService } from './MemoryRepairReflectionService';
import { MemorySelfMaintenanceService } from './MemorySelfMaintenanceService';
import { MemoryRepairTriggerService } from './MemoryRepairTriggerService';
import { DeferredMemoryReplayService } from './DeferredMemoryReplayService';
import { MemoryAdaptivePlanningService } from './MemoryAdaptivePlanningService';
import { TelemetryBus } from '../telemetry/TelemetryBus';
import type { MemoryRepairOutcomeRepository } from '../db/MemoryRepairOutcomeRepository';
import type {
    MemoryRepairScheduledRunResult,
    MemoryMaintenancePosture,
} from '../../../shared/memory/MemoryMaintenanceState';
import type {
    MemoryFailureReason,
    MemorySubsystemState,
    MemoryRepairTrigger,
} from '../../../shared/memory/MemoryHealthStatus';
import type { MemoryAdaptivePlan, MemoryAdaptiveTarget } from '../../../shared/memory/MemoryAdaptivePlan';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the scheduler.  All values have safe, fixed defaults.
 * The cadence and window are intentionally not runtime-configurable in this
 * pass to ensure predictable, bounded behavior.
 */
export type SchedulerConfig = {
    /** Interval between scheduled runs in milliseconds (default: 10 minutes). */
    intervalMs: number;
    /** Analysis window passed to MemoryRepairAnalyticsService (default: 24 hours). */
    windowHours: number;
};

const DEFAULT_CONFIG: SchedulerConfig = {
    intervalMs: 10 * 60 * 1_000, // 10 minutes
    windowHours: 24,
};

// ---------------------------------------------------------------------------
// Adaptive target → failure reason mapping
// ---------------------------------------------------------------------------

/**
 * Maps an MemoryAdaptiveTarget to the most representative MemoryFailureReason
 * for that target.  Used when the adaptive plan recommends a specific target
 * as the highest priority and we need to pass a typed reason to
 * MemoryRepairTriggerService.emitDirect().
 */
const TARGET_TO_FAILURE_REASON: Record<MemoryAdaptiveTarget, MemoryFailureReason> = {
    canonical:         'canonical_unavailable',
    mem0:              'mem0_unavailable',
    graph:             'graph_projection_unavailable',
    rag:               'rag_logging_unavailable',
    replay_extraction: 'extraction_provider_unavailable',
    replay_embedding:  'embedding_provider_unavailable',
    replay_graph:      'graph_projection_unavailable',
};

// ---------------------------------------------------------------------------
// MemoryRepairSchedulerService
// ---------------------------------------------------------------------------

export class MemoryRepairSchedulerService {
    private readonly analytics: MemoryRepairAnalyticsService;
    private readonly reflection: MemoryRepairReflectionService;
    private readonly selfMaintenance: MemorySelfMaintenanceService;
    private readonly planner: MemoryAdaptivePlanningService;
    private readonly config: SchedulerConfig;

    private _intervalHandle: ReturnType<typeof setInterval> | null = null;
    /** True while a run is executing.  Used to prevent overlapping runs. */
    private _running = false;
    /** The result of the most recently completed (or skipped) run. */
    private _lastRun: MemoryRepairScheduledRunResult | null = null;

    constructor(
        private readonly outcomeRepo: MemoryRepairOutcomeRepository,
        config?: Partial<SchedulerConfig>,
        selfMaintenanceSvc?: MemorySelfMaintenanceService,
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.analytics = new MemoryRepairAnalyticsService(outcomeRepo);
        this.reflection = new MemoryRepairReflectionService();
        this.selfMaintenance = selfMaintenanceSvc ?? new MemorySelfMaintenanceService();
        this.planner = new MemoryAdaptivePlanningService();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Start the periodic scheduled loop.
     *
     * Calling start() when already started is a no-op.
     */
    start(): void {
        if (this._intervalHandle !== null) return;
        this._intervalHandle = setInterval(() => {
            // Fire-and-forget; errors are caught inside runNow
            this.runNow('scheduled').catch((err) => {
                console.error('[MemoryRepairSchedulerService] scheduled run error:', err);
            });
        }, this.config.intervalMs);
        console.log(
            `[MemoryRepairSchedulerService] started (interval=${this.config.intervalMs}ms, window=${this.config.windowHours}h)`,
        );
    }

    /**
     * Stop the periodic loop.
     *
     * Any in-progress run is allowed to complete.
     * Calling stop() when not started is a no-op.
     */
    stop(): void {
        if (this._intervalHandle !== null) {
            clearInterval(this._intervalHandle);
            this._intervalHandle = null;
            console.log('[MemoryRepairSchedulerService] stopped.');
        }
    }

    /**
     * Execute an analytics + decision run immediately.
     *
     * If another run is already in flight the call is skipped and returns a
     * skipped result immediately (no queuing).
     *
     * @param reason — human-readable reason for this run (e.g. 'scheduled', 'manual')
     */
    async runNow(reason?: string): Promise<MemoryRepairScheduledRunResult> {
        const startedAt = new Date().toISOString();

        if (this._running) {
            const skipped: MemoryRepairScheduledRunResult = {
                startedAt,
                completedAt: new Date().toISOString(),
                windowHours: this.config.windowHours,
                posture: 'stable',
                actionsTaken: [],
                escalationCount: 0,
                recommendationCount: 0,
                skipped: true,
                reason: 'run_in_progress',
            };
            this._emitRunSkipped(skipped, reason);
            return skipped;
        }

        this._running = true;
        this._emitRunStarted(startedAt, reason);

        try {
            const summary = await this.analytics.generateSummary({
                windowHours: this.config.windowHours,
            });

            const report = this.reflection.generateReport(summary);

            // Generate adaptive plan before passing to self-maintenance so it
            // can influence escalation and subsystem-flagging decisions.
            const plan = this.planner.generatePlan(summary);
            this._emitAdaptivePlan(plan, reason);

            const decision = this.selfMaintenance.evaluate(summary, report, plan);

            // Act on the decision — bounded, threshold-driven side effects
            const actionsTaken: string[] = [];

            if (decision.shouldEscalate) {
                this._emitEscalation(summary, report, decision.posture);
                actionsTaken.push('emit_escalation');
            }

            if (decision.shouldTriggerRepairCycle) {
                this._triggerRepairCycle(summary, decision.posture, plan);
                actionsTaken.push('trigger_repair');
            }

            if (decision.shouldPrioritizeReplay) {
                this._prioritizeReplay(summary).catch((err) => {
                    console.error('[MemoryRepairSchedulerService] prioritizeReplay error:', err);
                });
                actionsTaken.push('prioritize_replay');
            }

            const completedAt = new Date().toISOString();
            const result: MemoryRepairScheduledRunResult = {
                startedAt,
                completedAt,
                windowHours: this.config.windowHours,
                posture: decision.posture,
                actionsTaken,
                escalationCount: summary.escalationCandidates.length,
                recommendationCount: report.recommendations.length,
            };

            this._emitRunCompleted(result, decision, reason);
            this._lastRun = result;
            return result;
        } catch (err) {
            console.error('[MemoryRepairSchedulerService] run error:', err);
            const completedAt = new Date().toISOString();
            const errorResult: MemoryRepairScheduledRunResult = {
                startedAt,
                completedAt,
                windowHours: this.config.windowHours,
                posture: 'stable',
                actionsTaken: [],
                escalationCount: 0,
                recommendationCount: 0,
                skipped: true,
                reason: `run_error: ${err instanceof Error ? err.message : String(err)}`,
            };
            this._lastRun = errorResult;
            return errorResult;
        } finally {
            this._running = false;
        }
    }

    /**
     * Returns the result of the most recently completed (or skipped) run,
     * or null if no run has occurred yet.
     */
    getLastRun(): MemoryRepairScheduledRunResult | null {
        return this._lastRun;
    }

    // ── Bounded action helpers ────────────────────────────────────────────────

    /**
     * Emit a repair escalation signal via TelemetryBus.
     *
     * This does not call MemoryRepairTriggerService.emitDirect() — the
     * escalation is informational and intended for the reflection dashboard /
     * operator-facing surfaces.  An actual repair trigger is separate.
     */
    private _emitEscalation(
        summary: ReturnType<typeof this.analytics.generateSummary> extends Promise<infer T> ? T : never,
        report: ReturnType<typeof this.reflection.generateReport>,
        posture: MemoryMaintenancePosture,
    ): void {
        TelemetryBus.getInstance().emit({
            event: 'memory.maintenance_escalation',
            subsystem: 'memory',
            executionId: 'memory-scheduler',
            payload: {
                posture,
                escalationCandidateCount: summary.escalationCandidates.length,
                escalationCodes: summary.escalationCandidates.map(c => c.code),
                hasCriticalFindings: report.hasCriticalFindings,
                recommendationCount: report.recommendations.length,
                criticalRecommendations: report.recommendations
                    .filter(r => r.priority === 'critical')
                    .map(r => r.code),
                windowHours: summary.windowHours,
                generatedAt: report.generatedAt,
            },
        });
    }

    /**
     * Request an additional repair cycle via MemoryRepairTriggerService.emitDirect().
     *
     * Only fired when recurring failures cross the threshold.  The trigger
     * reason is chosen from the adaptive plan's highest-priority target (if
     * available), falling back to the most common recurring failure reason.
     */
    private _triggerRepairCycle(
        summary: ReturnType<typeof this.analytics.generateSummary> extends Promise<infer T> ? T : never,
        posture: MemoryMaintenancePosture,
        plan?: MemoryAdaptivePlan,
    ): void {
        // Prefer the adaptive plan's top priority target → failure reason mapping
        const planPrimaryReason: MemoryFailureReason | undefined =
            plan && plan.priorities.length > 0
                ? TARGET_TO_FAILURE_REASON[plan.priorities[0].target]
                : undefined;

        // Fall back to most common recurring failure reason, then 'unknown'
        const primaryReason: MemoryFailureReason =
            planPrimaryReason ??
            (summary.recurrentFailures[0]?.reason as MemoryFailureReason | undefined) ??
            'unknown';

        const state: MemorySubsystemState =
            posture === 'critical' ? 'critical' : 'degraded';
        const severity: MemoryRepairTrigger['severity'] =
            posture === 'critical' ? 'error' : 'warning';

        MemoryRepairTriggerService.getInstance().emitDirect(
            primaryReason,
            state,
            severity,
            {
                source: 'MemoryRepairSchedulerService',
                posture,
                recurringFailureCount:    summary.recurrentFailures.length,
                escalationCandidateCount: summary.escalationCandidates.length,
                adaptivePlanTarget:       plan?.priorities[0]?.target ?? null,
                adaptiveTopScore:         plan?.priorities[0]?.score ?? null,
            },
        );
    }

    /**
     * Drain the deferred replay queue to handle dead-letter items.
     *
     * Calls DeferredMemoryReplayService.drain() directly.  The call is
     * intentionally fire-and-forget from the scheduler perspective; the
     * replay service is self-guarded against double-drain.
     */
    private async _prioritizeReplay(
        summary: ReturnType<typeof this.analytics.generateSummary> extends Promise<infer T> ? T : never,
    ): Promise<void> {
        const replay = DeferredMemoryReplayService.getInstance();
        console.log(
            `[MemoryRepairSchedulerService] prioritizing deferred replay ` +
            `(deadLetterCount=${summary.queueBehavior.deadLetterCount})`,
        );
        await replay.drain();
    }

    // ── Telemetry emission ────────────────────────────────────────────────────

    /**
     * Emit the adaptive plan as a telemetry event for dashboard/diagnostic consumers.
     */
    private _emitAdaptivePlan(plan: MemoryAdaptivePlan, reason?: string): void {
        TelemetryBus.getInstance().emit({
            event: 'memory.adaptive_plan_generated',
            subsystem: 'memory',
            executionId: 'memory-scheduler',
            payload: {
                generatedAt:           plan.generatedAt,
                windowHours:           plan.windowHours,
                topTarget:             plan.priorities[0]?.target ?? null,
                topScore:              plan.priorities[0]?.score ?? null,
                priorityCount:         plan.priorities.length,
                cadence:               plan.cadence.recommendation,
                cadenceMultiplier:     plan.cadence.suggestedMultiplier,
                escalationBias:        plan.escalation.bias,
                unstableSubsystems:    plan.unstableSubsystems,
                preferReplayOverRestart: plan.preferReplayOverRestart,
                planSummary:           plan.summary,
                requestedBy:           reason ?? 'scheduled',
            },
        });
    }

    private _emitRunStarted(startedAt: string, reason?: string): void {
        TelemetryBus.getInstance().emit({
            event: 'memory.maintenance_run_started',
            subsystem: 'memory',
            executionId: 'memory-scheduler',
            payload: {
                startedAt,
                windowHours: this.config.windowHours,
                reason: reason ?? 'scheduled',
            },
        });
    }

    private _emitRunCompleted(
        result: MemoryRepairScheduledRunResult,
        decision: ReturnType<MemorySelfMaintenanceService['evaluate']>,
        reason?: string,
    ): void {
        TelemetryBus.getInstance().emit({
            event: 'memory.maintenance_run_completed',
            subsystem: 'memory',
            executionId: 'memory-scheduler',
            payload: {
                startedAt: result.startedAt,
                completedAt: result.completedAt,
                windowHours: result.windowHours,
                posture: result.posture,
                actionsTaken: result.actionsTaken,
                escalationCount: result.escalationCount,
                recommendationCount: result.recommendationCount,
                reason: reason ?? 'scheduled',
                shouldTriggerRepairCycle: decision.shouldTriggerRepairCycle,
                shouldPrioritizeReplay: decision.shouldPrioritizeReplay,
                shouldEscalate: decision.shouldEscalate,
                shouldFlagUnstableSubsystems: decision.shouldFlagUnstableSubsystems,
            },
        });

        // Emit the maintenance decision as a separate event for dashboard consumers
        TelemetryBus.getInstance().emit({
            event: 'memory.maintenance_decision',
            subsystem: 'memory',
            executionId: 'memory-scheduler',
            payload: {
                posture: decision.posture,
                actions: decision.actions.map(a => ({ type: a.type, reason: a.reason })),
                shouldTriggerRepairCycle: decision.shouldTriggerRepairCycle,
                shouldPrioritizeReplay: decision.shouldPrioritizeReplay,
                shouldEscalate: decision.shouldEscalate,
                shouldFlagUnstableSubsystems: decision.shouldFlagUnstableSubsystems,
            },
        });
    }

    private _emitRunSkipped(result: MemoryRepairScheduledRunResult, reason?: string): void {
        TelemetryBus.getInstance().emit({
            event: 'memory.maintenance_run_skipped',
            subsystem: 'memory',
            executionId: 'memory-scheduler',
            payload: {
                startedAt: result.startedAt,
                reason: result.reason ?? 'unknown',
                requestedBy: reason ?? 'scheduled',
            },
        });
    }
}
