/**
 * MemorySelfMaintenanceService.ts — Bounded, threshold-driven decision layer
 *
 * Consumes the output of MemoryRepairAnalyticsService and
 * MemoryRepairReflectionService and produces a MemoryMaintenanceDecision
 * describing what maintenance actions, if any, should be taken.
 *
 * Design invariants
 * ─────────────────
 * 1. Threshold-only — no action on isolated single events unless already
 *    critical.  Patterns must recur before triggering action.
 * 2. No provider authority — does not change provider settings, integrity
 *    mode, or user configuration.  MemoryIntegrityPolicy remains authoritative.
 * 3. Deterministic — same summary + report + thresholds always produce the
 *    same decision.
 * 4. No self-modifying loop — the service makes decisions; a scheduler drives
 *    the cadence.
 * 5. No side effects — the evaluate() method returns a decision object; it is
 *    the caller's responsibility to act on it.
 *
 * Usage
 * ─────
 * const svc = new MemorySelfMaintenanceService();
 * const decision = await svc.evaluate(summary, report);
 */

import type {
    MemoryRepairInsightSummary,
    MemoryRepairReflectionReport,
} from '../../../shared/memory/MemoryRepairInsights';
import type {
    MemoryMaintenanceDecision,
    MemoryMaintenanceAction,
    MemoryMaintenancePosture,
} from '../../../shared/memory/MemoryMaintenanceState';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Configurable decision thresholds.  All defaults are conservative.
 */
export type SelfMaintenanceThresholds = {
    /**
     * Minimum number of recurring failures to trigger a repair cycle.
     * Below this threshold the posture is 'watch' and no repair is triggered.
     */
    repairCycleRecurringFailureMin: number;
    /**
     * Minimum number of escalation candidates to trigger an escalation event.
     */
    escalationCandidateMin: number;
    /**
     * Minimum number of escalation candidates to elevate posture to 'critical'.
     * At or above 'escalationCandidateMin' but below this, posture is 'unstable'.
     */
    criticalEscalationMin: number;
    /**
     * Minimum dead-letter count (combined with growing flag) to prioritize
     * the deferred replay queue.
     */
    deadLetterPrioritizeMin: number;
    /**
     * Success rate at or below which a repair action is considered persistently
     * failing and warrants a flag to mark subsystems as unstable.
     */
    actionSuccessRateCritical: number;
    /**
     * Minimum executions before actionSuccessRateCritical applies.
     */
    actionSuccessRateMinExecutions: number;
};

const DEFAULT_THRESHOLDS: SelfMaintenanceThresholds = {
    repairCycleRecurringFailureMin: 2,
    escalationCandidateMin: 1,
    criticalEscalationMin: 2,
    deadLetterPrioritizeMin: 1,
    actionSuccessRateCritical: 0.2,
    actionSuccessRateMinExecutions: 3,
};

// ---------------------------------------------------------------------------
// MemorySelfMaintenanceService
// ---------------------------------------------------------------------------

export class MemorySelfMaintenanceService {
    private readonly thresholds: SelfMaintenanceThresholds;

    constructor(thresholds?: Partial<SelfMaintenanceThresholds>) {
        this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Evaluate the analytics summary and reflection report and return a
     * bounded maintenance decision.
     *
     * The method is synchronous and pure — it does not query the DB, emit
     * telemetry, or trigger any actions itself.
     */
    evaluate(
        summary: MemoryRepairInsightSummary,
        report: MemoryRepairReflectionReport,
    ): MemoryMaintenanceDecision {
        const actions: MemoryMaintenanceAction[] = [];

        const posture = this._derivePosture(summary, report);

        const shouldTriggerRepairCycle = this._shouldTriggerRepairCycle(summary, posture);
        const shouldPrioritizeReplay = this._shouldPrioritizeReplay(summary, posture);
        const shouldEscalate = this._shouldEscalate(summary, report, posture);
        const shouldFlagUnstableSubsystems = this._shouldFlagUnstableSubsystems(summary, posture);

        // Build the concrete action list in priority order
        if (shouldEscalate) {
            actions.push({
                type: 'emit_escalation',
                reason: `Posture is '${posture}' with ${summary.escalationCandidates.length} escalation candidate(s).`,
                evidence: {
                    posture,
                    escalationCandidateCount: summary.escalationCandidates.length,
                    threshold: this.thresholds.escalationCandidateMin,
                    hasCriticalFindings: report.hasCriticalFindings,
                },
            });
        }

        if (shouldTriggerRepairCycle) {
            actions.push({
                type: 'trigger_repair',
                reason:
                    `${summary.recurrentFailures.length} recurring failure(s) detected; ` +
                    `requesting additional repair cycle.`,
                evidence: {
                    posture,
                    recurringFailureCount: summary.recurrentFailures.length,
                    threshold: this.thresholds.repairCycleRecurringFailureMin,
                    failedCandidates: summary.escalationCandidates
                        .filter(c => c.code === 'repeated_cycle_failure')
                        .map(c => c.code),
                },
            });
        }

        if (shouldPrioritizeReplay) {
            actions.push({
                type: 'prioritize_replay',
                reason:
                    `Dead-letter queue has ${summary.queueBehavior.deadLetterCount} item(s)` +
                    (summary.queueBehavior.deadLetterGrowing ? ' and is growing' : '') + '.  ' +
                    'Prioritising deferred replay on next drain.',
                evidence: {
                    deadLetterCount: summary.queueBehavior.deadLetterCount,
                    deadLetterGrowing: summary.queueBehavior.deadLetterGrowing,
                    threshold: this.thresholds.deadLetterPrioritizeMin,
                },
            });
        }

        // Always publish the report (no-op action for the caller to log/surface)
        actions.push({
            type: 'publish_report',
            reason: `Scheduled maintenance run complete; posture='${posture}'.`,
            evidence: {
                posture,
                recommendationCount: report.recommendations.length,
                windowHours: summary.windowHours,
                totalCycles: summary.totalCycles,
                totalTriggers: summary.totalTriggers,
            },
        });

        return {
            posture,
            shouldTriggerRepairCycle,
            shouldPrioritizeReplay,
            shouldEscalate,
            shouldFlagUnstableSubsystems,
            actions,
        };
    }

    // ── Private decision methods ──────────────────────────────────────────────

    private _derivePosture(
        summary: MemoryRepairInsightSummary,
        report: MemoryRepairReflectionReport,
    ): MemoryMaintenancePosture {
        // Critical: report has critical findings OR escalation candidate count
        // meets the critical threshold
        if (
            report.hasCriticalFindings ||
            summary.escalationCandidates.length >= this.thresholds.criticalEscalationMin
        ) {
            return 'critical';
        }

        // Unstable: at least one escalation candidate OR recurring failures >= threshold
        if (
            summary.escalationCandidates.length >= this.thresholds.escalationCandidateMin ||
            summary.recurrentFailures.length >= this.thresholds.repairCycleRecurringFailureMin
        ) {
            return 'unstable';
        }

        // Watch: minor signals present (single recurring failure, dead-letter items,
        // or any actionable non-informational recommendation)
        const hasMinorSignals =
            summary.recurrentFailures.length > 0 ||
            summary.queueBehavior.deadLetterCount > 0 ||
            report.recommendations.some(r => r.code !== 'extend_analysis_window');

        if (hasMinorSignals) {
            return 'watch';
        }

        return 'stable';
    }

    private _shouldTriggerRepairCycle(
        summary: MemoryRepairInsightSummary,
        posture: MemoryMaintenancePosture,
    ): boolean {
        if (posture === 'stable' || posture === 'watch') return false;
        // Trigger when recurring failures meet the threshold OR when a
        // repeated_cycle_failure escalation is present
        const hasRepeatedCycleFailure = summary.escalationCandidates.some(
            c => c.code === 'repeated_cycle_failure',
        );
        const hasEnoughRecurring =
            summary.recurrentFailures.length >= this.thresholds.repairCycleRecurringFailureMin;
        return hasEnoughRecurring || hasRepeatedCycleFailure;
    }

    private _shouldPrioritizeReplay(
        summary: MemoryRepairInsightSummary,
        posture: MemoryMaintenancePosture,
    ): boolean {
        // Prioritize replay when there are dead-letter items above threshold
        // (regardless of posture — even in 'watch' a growing queue needs draining)
        return (
            summary.queueBehavior.deadLetterCount >= this.thresholds.deadLetterPrioritizeMin
        );
    }

    private _shouldEscalate(
        summary: MemoryRepairInsightSummary,
        report: MemoryRepairReflectionReport,
        posture: MemoryMaintenancePosture,
    ): boolean {
        if (posture === 'stable' || posture === 'watch') return false;
        return (
            summary.escalationCandidates.length >= this.thresholds.escalationCandidateMin ||
            report.hasCriticalFindings
        );
    }

    private _shouldFlagUnstableSubsystems(
        summary: MemoryRepairInsightSummary,
        posture: MemoryMaintenancePosture,
    ): boolean {
        if (posture === 'stable' || posture === 'watch') return false;
        // Flag subsystems as unstable when there are actions with persistently
        // low success rates (critical threshold)
        return summary.actionEffectiveness.some(
            entry =>
                entry.totalExecutions >= this.thresholds.actionSuccessRateMinExecutions &&
                entry.successRate <= this.thresholds.actionSuccessRateCritical,
        );
    }
}
