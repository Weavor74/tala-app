/**
 * MemoryOptimizationSuggestionService.ts — Human-gated optimization suggestion engine
 *
 * Converts adaptive maintenance learning into explicit operator-facing
 * optimization suggestions.  This layer sits one step above the adaptive
 * planning layer:
 *
 *   repair analytics + reflection report + adaptive plan
 *   → MemoryOptimizationSuggestionService
 *   → MemoryOptimizationSuggestionReport (advisory, human-gated)
 *   → published via TelemetryBus for dashboard / operator surfaces
 *
 * Design invariants
 * ─────────────────
 * 1. Human-gated — no auto-apply, no config writes, no provider mutations.
 *    This pass is advisory only.
 * 2. Evidence-backed — every suggestion is tied to concrete counts,
 *    timestamps, and/or identifiers from the analytics and plan inputs.
 *    Suggestions are never generated without supporting evidence.
 * 3. Deterministic — same inputs always produce the same suggestions
 *    (except generatedAt, which reflects the wall clock).
 * 4. Bounded — the suggestion list is capped to maxSuggestions (default 8).
 *    Suggestions are ordered by priorityScore (integer in [0, 100]).
 * 5. Non-mutating — does not modify DB, settings, provider config, integrity
 *    mode, or scheduler interval.  MemoryIntegrityPolicy remains authoritative.
 * 6. No side effects — the only observable output beyond the returned report
 *    is a single TelemetryBus emission for dashboard consumers.
 *
 * Suggestion categories
 * ─────────────────────
 * provider_tuning      — Recurring subsystem failures suggest provider reconnect/
 *                        timeout/retry configuration should be reviewed.
 * replay_policy        — Dead-letter growth or high replay failure rate suggests
 *                        retry limits, delay policy, or batch size should be tuned.
 * scheduler_cadence    — Adaptive plan cadence signal suggests the scheduler interval
 *                        should be reviewed by an operator.
 * queue_thresholds     — Backlog behaviour suggests warning/critical threshold
 *                        values may need adjustment.
 * subsystem_hardening  — Persistent instability suggests a subsystem warrants
 *                        deeper investigation or hardening investment.
 * escalation_policy    — Escalation candidates suggest escalation sensitivity
 *                        thresholds may need review.
 * observability_gap    — Zero data in the window suggests telemetry or event
 *                        persistence may need attention.
 *
 * Usage
 * ─────
 * const svc = new MemoryOptimizationSuggestionService();
 * const report = svc.generateReport(summary, plan);
 */

import type { MemoryRepairInsightSummary }   from '../../../shared/memory/MemoryRepairInsights';
import type { MemoryAdaptivePlan }            from '../../../shared/memory/MemoryAdaptivePlan';
import type {
    MemoryOptimizationSuggestion,
    MemoryOptimizationSuggestionCategory,
    MemoryOptimizationSuggestionReport,
    MemoryOptimizationSuggestionSeverity,
} from '../../../shared/memory/MemoryOptimizationSuggestion';
import { TelemetryBus } from '../telemetry/TelemetryBus';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type OptimizationSuggestionConfig = {
    /**
     * Maximum suggestions in a single report.
     * Default: 8
     */
    maxSuggestions: number;

    /**
     * Minimum occurrence count for a recurring failure to trigger a
     * provider_tuning or subsystem_hardening suggestion.
     * Default: 2
     */
    minFailureOccurrences: number;

    /**
     * Action success-rate threshold below which a provider_tuning suggestion
     * is issued.  Must be in [0, 1].
     * Default: 0.4
     */
    lowActionSuccessRateThreshold: number;

    /**
     * Minimum action executions required before the success-rate threshold
     * is applied.
     * Default: 2
     */
    minActionExecutions: number;

    /**
     * Dead-letter count at or above which a replay_policy suggestion is issued.
     * Default: 1
     */
    deadLetterTriggerCount: number;

    /**
     * Replay failure rate at or above which a replay_policy suggestion is
     * issued (only when totalReplays >= minReplayExecutions).
     * Default: 0.5
     */
    highReplayFailureRateThreshold: number;

    /**
     * Minimum replay executions required before the failure-rate threshold
     * is applied.
     * Default: 3
     */
    minReplayExecutions: number;

    /**
     * Escalation candidate count at or above which an escalation_policy
     * suggestion is issued.
     * Default: 2
     */
    escalationCandidateThreshold: number;
};

const DEFAULT_CONFIG: OptimizationSuggestionConfig = {
    maxSuggestions:                  8,
    minFailureOccurrences:           2,
    lowActionSuccessRateThreshold:   0.4,
    minActionExecutions:             2,
    deadLetterTriggerCount:          1,
    highReplayFailureRateThreshold:  0.5,
    minReplayExecutions:             3,
    escalationCandidateThreshold:    2,
};

// ---------------------------------------------------------------------------
// Score constants
// ---------------------------------------------------------------------------

const SCORE_MAX            = 100;
const SCORE_CRITICAL_BASE  =  80;
const SCORE_ERROR_BASE     =  60;
const SCORE_WARNING_BASE   =  40;
const SCORE_INFO_BASE      =  20;

// Extra score for dead-letter growth flag
const SCORE_DL_GROWING_EXTRA = 15;
// Extra per dead-letter item (capped)
const SCORE_DL_PER_ITEM      =  5;
const SCORE_DL_DEPTH_CAP     = 20;
// Score for zero-rate actions
const SCORE_ZERO_RATE_EXTRA  = 10;
// Recency bonus for failures seen in the last hour
const SCORE_RECENCY_BONUS    = 10;
const RECENCY_THRESHOLD_MS   = 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

function severityFromScore(score: number): MemoryOptimizationSuggestionSeverity {
    if (score >= SCORE_CRITICAL_BASE) return 'critical';
    if (score >= SCORE_ERROR_BASE)    return 'error';
    if (score >= SCORE_WARNING_BASE)  return 'warning';
    return 'info';
}

// ---------------------------------------------------------------------------
// MemoryOptimizationSuggestionService
// ---------------------------------------------------------------------------

export class MemoryOptimizationSuggestionService {
    private readonly config: OptimizationSuggestionConfig;

    constructor(config?: Partial<OptimizationSuggestionConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Generate an optimization suggestion report from a repair insight summary
     * and the adaptive plan derived from it.
     *
     * The method is synchronous and pure from the caller's perspective — it
     * does not query the DB and does not write to any external state.  The
     * only side effect is emitting a single telemetry event via TelemetryBus.
     *
     * @param summary — Output of MemoryRepairAnalyticsService.generateSummary().
     * @param plan    — Output of MemoryAdaptivePlanningService.generatePlan(summary).
     */
    generateReport(
        summary: MemoryRepairInsightSummary,
        plan: MemoryAdaptivePlan,
    ): MemoryOptimizationSuggestionReport {
        const generatedAt = new Date().toISOString();

        const raw = this._buildSuggestions(summary, plan, generatedAt);

        // Sort: highest score first; ties broken by id for stability
        raw.sort((a, b) => {
            if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
            return a.id.localeCompare(b.id);
        });

        const suggestions = raw.slice(0, this.config.maxSuggestions);

        const hasHighPrioritySuggestions = suggestions.some(
            s => s.severity === 'critical' || s.severity === 'error',
        );

        const topLineSummary = this._buildTopLineSummary(suggestions);

        const report: MemoryOptimizationSuggestionReport = {
            generatedAt,
            windowHours:             summary.windowHours,
            suggestions,
            hasHighPrioritySuggestions,
            topLineSummary,
        };

        this._emitReportGenerated(report);
        return report;
    }

    // ── Suggestion builders ───────────────────────────────────────────────────

    private _buildSuggestions(
        summary: MemoryRepairInsightSummary,
        plan: MemoryAdaptivePlan,
        generatedAt: string,
    ): MemoryOptimizationSuggestion[] {
        const suggestions: MemoryOptimizationSuggestion[] = [];

        // 1. Provider tuning — recurring subsystem failures
        suggestions.push(...this._buildProviderTuningSuggestions(summary, plan, generatedAt));

        // 2. Subsystem hardening — unstable subsystems from adaptive plan
        suggestions.push(...this._buildSubsystemHardeningSuggestions(summary, plan, generatedAt));

        // 3. Replay policy — dead-letter queue and replay failures
        const replaySuggestion = this._buildReplayPolicySuggestion(summary, plan, generatedAt);
        if (replaySuggestion) suggestions.push(replaySuggestion);

        // 4. Scheduler cadence — adaptive plan recommends non-normal cadence
        const cadenceSuggestion = this._buildSchedulerCadenceSuggestion(summary, plan, generatedAt);
        if (cadenceSuggestion) suggestions.push(cadenceSuggestion);

        // 5. Queue thresholds — backlog depth relative to configured thresholds
        const queueSuggestion = this._buildQueueThresholdSuggestion(summary, plan, generatedAt);
        if (queueSuggestion) suggestions.push(queueSuggestion);

        // 6. Escalation policy — many escalation candidates
        const escalationSuggestion = this._buildEscalationPolicySuggestion(summary, plan, generatedAt);
        if (escalationSuggestion) suggestions.push(escalationSuggestion);

        // 7. Observability gap — no data in window
        const observabilitySuggestion = this._buildObservabilityGapSuggestion(summary, generatedAt);
        if (observabilitySuggestion) suggestions.push(observabilitySuggestion);

        return suggestions;
    }

    // ── 1. Provider tuning ────────────────────────────────────────────────────

    private _buildProviderTuningSuggestions(
        summary: MemoryRepairInsightSummary,
        plan: MemoryAdaptivePlan,
        generatedAt: string,
    ): MemoryOptimizationSuggestion[] {
        const suggestions: MemoryOptimizationSuggestion[] = [];

        // Collect subsystems with low action effectiveness
        const lowEffectivenessMap = new Map<string, {
            actionType: string;
            successRate: number;
            totalExecutions: number;
        }>();

        for (const entry of summary.actionEffectiveness) {
            if (entry.totalExecutions < this.config.minActionExecutions) continue;
            if (entry.successRate >= this.config.lowActionSuccessRateThreshold) continue;

            // Map action type to subsystem
            const subsystem = actionTypeToSubsystem(entry.actionType);
            if (!subsystem) continue;

            const existing = lowEffectivenessMap.get(subsystem);
            if (!existing || entry.successRate < existing.successRate) {
                lowEffectivenessMap.set(subsystem, {
                    actionType: entry.actionType,
                    successRate: entry.successRate,
                    totalExecutions: entry.totalExecutions,
                });
            }
        }

        // Emit one suggestion per subsystem with sufficient evidence
        for (const failure of summary.recurrentFailures) {
            if (failure.occurrenceCount < this.config.minFailureOccurrences) continue;

            const subsystem = failure.subsystem;
            const id = `provider_tuning:${subsystem}`;

            // Base score from frequency
            let score = Math.min(SCORE_ERROR_BASE, failure.occurrenceCount * 10);

            // Recency bonus
            const ageMs = Date.now() - new Date(failure.lastSeenAt).getTime();
            if (ageMs < RECENCY_THRESHOLD_MS) score = Math.min(SCORE_MAX, score + SCORE_RECENCY_BONUS);

            // Low-effectiveness bonus
            const effectivenessEntry = lowEffectivenessMap.get(subsystem);
            if (effectivenessEntry) {
                score = Math.min(SCORE_MAX, score + (effectivenessEntry.successRate === 0 ? 20 : 10));
            }

            // Escalation bonus
            const isEscalated = plan.unstableSubsystems.includes(subsystem) ||
                summary.escalationCandidates.some(c => c.evidence['subsystem'] === subsystem);
            if (isEscalated) score = Math.min(SCORE_MAX, score + 15);

            const severity = severityFromScore(score);

            const evidence: Record<string, unknown> = {
                subsystem,
                reason: failure.reason,
                occurrenceCount: failure.occurrenceCount,
                firstSeenAt: failure.firstSeenAt,
                lastSeenAt: failure.lastSeenAt,
                recoversBetweenFailures: failure.recoversBetweenFailures,
                isEscalated,
            };
            if (effectivenessEntry) {
                evidence['bestActionType']       = effectivenessEntry.actionType;
                evidence['bestActionSuccessRate'] = effectivenessEntry.successRate;
                evidence['bestActionExecutions']  = effectivenessEntry.totalExecutions;
            }

            const lowEffectivenessNote = effectivenessEntry
                ? ` The best available repair action ('${effectivenessEntry.actionType}') succeeds only ` +
                  `${(effectivenessEntry.successRate * 100).toFixed(0)}% of the time, suggesting provider ` +
                  `reconnect timeout, retry count, or wait strategy may need adjustment.`
                : '';

            suggestions.push({
                id,
                category: 'provider_tuning',
                title: `Review provider configuration for '${subsystem}'`,
                summary:
                    `The '${subsystem}' subsystem has failed ${failure.occurrenceCount} time(s) in the last ` +
                    `${summary.windowHours}h.${lowEffectivenessNote} ` +
                    `Consider reviewing provider connection settings, retry limits, or timeout values.`,
                rationale:
                    `Recurring failure '${failure.reason}' on subsystem '${subsystem}' (${failure.occurrenceCount} occurrence(s)) ` +
                    `indicates the current provider configuration may not handle transient failures reliably. ` +
                    (failure.recoversBetweenFailures
                        ? `The subsystem does recover between failures (instability pattern), which suggests ` +
                          `a connection-pool or keepalive tuning opportunity rather than a hard failure. `
                        : `The subsystem does not consistently recover, which suggests more aggressive ` +
                          `reconnect logic or a fallback strategy may be needed. `) +
                    `This is an advisory suggestion — no config is changed automatically.`,
                severity,
                priorityScore: score,
                evidence,
                affectedSubsystems: [subsystem],
                generatedAt,
            });
        }

        // Deduplicate by id (keep highest score)
        return deduplicateById(suggestions);
    }

    // ── 2. Subsystem hardening ────────────────────────────────────────────────

    private _buildSubsystemHardeningSuggestions(
        summary: MemoryRepairInsightSummary,
        plan: MemoryAdaptivePlan,
        generatedAt: string,
    ): MemoryOptimizationSuggestion[] {
        if (plan.unstableSubsystems.length === 0) return [];

        const suggestions: MemoryOptimizationSuggestion[] = [];

        for (const subsystem of plan.unstableSubsystems) {
            const id = `subsystem_hardening:${subsystem}`;

            // Find supporting failure data
            const relatedFailures = summary.recurrentFailures.filter(f => f.subsystem === subsystem);
            const relatedEscalations = summary.escalationCandidates.filter(
                c => c.evidence['subsystem'] === subsystem,
            );
            const relatedActions = summary.actionEffectiveness.filter(
                e => actionTypeToSubsystem(e.actionType) === subsystem,
            );

            const occurrenceCount = relatedFailures.reduce((s, f) => s + f.occurrenceCount, 0);
            const escalationCount = relatedEscalations.length;
            const avgSuccessRate = relatedActions.length > 0
                ? relatedActions.reduce((s, e) => s + e.successRate, 0) / relatedActions.length
                : null;

            // Base score: error-level because the planner has already flagged this as unstable
            let score = SCORE_ERROR_BASE;
            if (escalationCount > 0) score = Math.min(SCORE_MAX, score + 15);
            if (avgSuccessRate !== null && avgSuccessRate < 0.4) score = Math.min(SCORE_MAX, score + 10);

            const severity = severityFromScore(score);

            suggestions.push({
                id,
                category: 'subsystem_hardening',
                title: `Investigate and harden subsystem '${subsystem}'`,
                summary:
                    `Subsystem '${subsystem}' has been flagged as persistently unstable over the last ` +
                    `${summary.windowHours}h (${occurrenceCount} failure occurrence(s), ` +
                    `${escalationCount} escalation candidate(s)). ` +
                    `Consider investing in reliability improvements, circuit-breaker logic, ` +
                    `or fallback strategies for this subsystem.`,
                rationale:
                    `The adaptive planner flagged '${subsystem}' as unstable based on recurring failures, ` +
                    (avgSuccessRate !== null
                        ? `low average repair action success rate (${(avgSuccessRate * 100).toFixed(0)}%), `
                        : '') +
                    `and escalation candidate signals. Hardening suggestions may include: ` +
                    `improving health checks, adding circuit-breaker patterns, improving fallback behavior, ` +
                    `or reviewing the subsystem's dependency chain. ` +
                    `This suggestion is advisory — no changes are applied automatically.`,
                severity,
                priorityScore: score,
                evidence: {
                    subsystem,
                    occurrenceCount,
                    escalationCount,
                    avgSuccessRate,
                    relatedFailureReasons: relatedFailures.map(f => f.reason),
                    escalationCodes: relatedEscalations.map(c => c.code),
                },
                affectedSubsystems: [subsystem],
                generatedAt,
            });
        }

        return suggestions;
    }

    // ── 3. Replay policy ──────────────────────────────────────────────────────

    private _buildReplayPolicySuggestion(
        summary: MemoryRepairInsightSummary,
        plan: MemoryAdaptivePlan,
        generatedAt: string,
    ): MemoryOptimizationSuggestion | null {
        const { queueBehavior } = summary;

        const hasDeadLetters = queueBehavior.deadLetterCount >= this.config.deadLetterTriggerCount;
        const replayFailureRate =
            queueBehavior.totalReplays >= this.config.minReplayExecutions &&
            queueBehavior.totalReplays > 0
                ? queueBehavior.replayFailures / queueBehavior.totalReplays
                : 0;
        const highFailureRate = replayFailureRate >= this.config.highReplayFailureRateThreshold;

        if (!hasDeadLetters && !highFailureRate) return null;

        let score = SCORE_WARNING_BASE;
        if (hasDeadLetters) {
            score = Math.min(SCORE_MAX, score + SCORE_ERROR_BASE - SCORE_WARNING_BASE);
            score = Math.min(
                SCORE_MAX,
                score + Math.min(SCORE_DL_DEPTH_CAP, queueBehavior.deadLetterCount * SCORE_DL_PER_ITEM),
            );
            if (queueBehavior.deadLetterGrowing) score = Math.min(SCORE_MAX, score + SCORE_DL_GROWING_EXTRA);
        }
        if (highFailureRate) score = Math.min(SCORE_MAX, score + 10);

        const severity = severityFromScore(score);

        return {
            id: 'replay_policy:deferred_work',
            category: 'replay_policy',
            title: 'Review deferred-work replay policy',
            summary:
                `The deferred-work queue has ${queueBehavior.deadLetterCount} dead-letter item(s)` +
                (queueBehavior.deadLetterGrowing ? ' (queue is growing)' : '') +
                (highFailureRate
                    ? `, and the replay failure rate is ${(replayFailureRate * 100).toFixed(0)}%` +
                      ` over ${queueBehavior.totalReplays} attempt(s)`
                    : '') +
                `. Consider reviewing retry limits, delay policy, batch size, ` +
                `or dead-letter handling strategy.`,
            rationale:
                `Dead-lettered deferred-work items represent memory operations that could not be ` +
                `replayed successfully within the configured retry limit. ` +
                (queueBehavior.deadLetterGrowing
                    ? `The dead-letter queue is growing, indicating the replay policy is not keeping up. `
                    : '') +
                (highFailureRate
                    ? `A high replay failure rate (${(replayFailureRate * 100).toFixed(0)}%) suggests ` +
                      `the current retry strategy is ineffective for the current failure pattern. `
                    : '') +
                `Tuning the max-attempts limit, adding exponential backoff, or increasing the drain ` +
                `batch size may reduce dead-letter accumulation. ` +
                `This suggestion is advisory — no policy is changed automatically.`,
            severity,
            priorityScore: score,
            evidence: {
                deadLetterCount:  queueBehavior.deadLetterCount,
                deadLetterGrowing: queueBehavior.deadLetterGrowing,
                totalReplays:     queueBehavior.totalReplays,
                replayFailures:   queueBehavior.replayFailures,
                replaySuccesses:  queueBehavior.replaySuccesses,
                replayFailureRate,
                preferReplayOverRestart: plan.preferReplayOverRestart,
            },
            affectedSubsystems: [],
            generatedAt,
        };
    }

    // ── 4. Scheduler cadence ──────────────────────────────────────────────────

    private _buildSchedulerCadenceSuggestion(
        summary: MemoryRepairInsightSummary,
        plan: MemoryAdaptivePlan,
        generatedAt: string,
    ): MemoryOptimizationSuggestion | null {
        // Only suggest cadence review when the plan recommends a non-normal cadence
        if (plan.cadence.recommendation === 'normal') return null;

        const isTighten = plan.cadence.recommendation === 'tighten';
        const score = isTighten ? SCORE_WARNING_BASE + 10 : SCORE_INFO_BASE + 5;
        const severity = severityFromScore(score);

        return {
            id: `scheduler_cadence:${plan.cadence.recommendation}`,
            category: 'scheduler_cadence',
            title: isTighten
                ? 'Consider tightening the maintenance scheduler interval'
                : 'Consider relaxing the maintenance scheduler interval',
            summary:
                `The adaptive planner recommends a '${plan.cadence.recommendation}' cadence ` +
                `(suggested multiplier: ${plan.cadence.suggestedMultiplier}× the current interval). ` +
                `${plan.cadence.reason} ` +
                `An operator may consider adjusting the scheduler's intervalMs configuration.`,
            rationale:
                `The adaptive cadence recommendation is based on current pressure signals: ` +
                `${summary.recurrentFailures.length} recurring failure(s), ` +
                `${summary.escalationCandidates.length} escalation candidate(s), ` +
                `${summary.queueBehavior.deadLetterCount} dead-letter item(s). ` +
                (isTighten
                    ? `Running maintenance more frequently would allow faster detection and response ` +
                      `to emerging failure patterns. `
                    : `The system appears quiet; running maintenance less frequently would reduce ` +
                      `overhead during low-activity periods. `) +
                `This is advisory — the scheduler interval is not changed automatically.`,
            severity,
            priorityScore: score,
            evidence: {
                cadenceRecommendation: plan.cadence.recommendation,
                suggestedMultiplier:   plan.cadence.suggestedMultiplier,
                cadenceReason:         plan.cadence.reason,
                recurrentFailureCount: summary.recurrentFailures.length,
                escalationCount:       summary.escalationCandidates.length,
                deadLetterCount:       summary.queueBehavior.deadLetterCount,
                windowHours:           summary.windowHours,
            },
            affectedSubsystems: [],
            generatedAt,
        };
    }

    // ── 5. Queue thresholds ───────────────────────────────────────────────────

    private _buildQueueThresholdSuggestion(
        summary: MemoryRepairInsightSummary,
        plan: MemoryAdaptivePlan,
        generatedAt: string,
    ): MemoryOptimizationSuggestion | null {
        const { queueBehavior } = summary;

        // Only suggest threshold review when the queue is meaningfully stressed
        // (growing dead-letters AND at least one replay failure)
        if (!queueBehavior.deadLetterGrowing || queueBehavior.replayFailures === 0) return null;

        const score = SCORE_WARNING_BASE + 5;
        const severity = severityFromScore(score);

        return {
            id: 'queue_thresholds:backlog',
            category: 'queue_thresholds',
            title: 'Review backlog warning and critical threshold values',
            summary:
                `The deferred-work queue is growing (${queueBehavior.deadLetterCount} dead-letter item(s), ` +
                `${queueBehavior.replayFailures} replay failure(s)). ` +
                `If the current backlog thresholds are triggering false-positive warnings or missing ` +
                `genuine pressure, consider adjusting the warning (default: 250) and critical ` +
                `(default: 1000) backlog count values.`,
            rationale:
                `Backlog warning and critical thresholds determine when MemoryService escalates ` +
                `to higher severity states and triggers repair cycles.  If the thresholds are too low, ` +
                `they may generate noise during normal burst activity.  If too high, genuine backlog ` +
                `pressure may go undetected. The current pattern — a growing dead-letter queue with ` +
                `replay failures — indicates the thresholds may benefit from tuning. ` +
                `This suggestion is advisory — thresholds are not changed automatically.`,
            severity,
            priorityScore: score,
            evidence: {
                deadLetterCount:    queueBehavior.deadLetterCount,
                deadLetterGrowing:  queueBehavior.deadLetterGrowing,
                totalReplays:       queueBehavior.totalReplays,
                replayFailures:     queueBehavior.replayFailures,
                windowHours:        summary.windowHours,
            },
            affectedSubsystems: [],
            generatedAt,
        };
    }

    // ── 6. Escalation policy ──────────────────────────────────────────────────

    private _buildEscalationPolicySuggestion(
        summary: MemoryRepairInsightSummary,
        plan: MemoryAdaptivePlan,
        generatedAt: string,
    ): MemoryOptimizationSuggestion | null {
        if (summary.escalationCandidates.length < this.config.escalationCandidateThreshold) return null;

        // Only suggest escalation review when the bias is non-normal
        const nonNormalBias = plan.escalation.bias !== 'normal';

        let score = SCORE_WARNING_BASE;
        if (nonNormalBias) score = Math.min(SCORE_MAX, score + 10);
        if (summary.escalationCandidates.length >= 4) score = Math.min(SCORE_MAX, score + 10);

        const severity = severityFromScore(score);
        const codes = summary.escalationCandidates.map(c => c.code);

        return {
            id: 'escalation_policy:thresholds',
            category: 'escalation_policy',
            title: 'Review escalation sensitivity thresholds',
            summary:
                `${summary.escalationCandidates.length} escalation candidate(s) were detected in the ` +
                `last ${summary.windowHours}h (codes: ${codes.join(', ')}). ` +
                `The adaptive planner bias is '${plan.escalation.bias}'. ` +
                `Consider reviewing whether the escalation thresholds (repeat counts, time windows) ` +
                `are calibrated correctly for your deployment.`,
            rationale:
                `Escalation candidates indicate patterns (e.g. repeated cycle failures, prolonged ` +
                `degraded state, growing dead-letter queue) that cross configured thresholds. ` +
                `If these candidates are expected and benign in your environment, lowering ` +
                `escalation sensitivity may reduce noise.  If they represent real problems that ` +
                `have not been addressed, tightening the thresholds would surface them earlier. ` +
                `The adaptive planner's '${plan.escalation.bias}' bias provides additional signal. ` +
                `This suggestion is advisory — escalation thresholds are not changed automatically.`,
            severity,
            priorityScore: score,
            evidence: {
                escalationCandidateCount: summary.escalationCandidates.length,
                escalationCodes:          codes,
                escalationBias:           plan.escalation.bias,
                escalationBiasReason:     plan.escalation.reason,
                windowHours:              summary.windowHours,
            },
            affectedSubsystems: [],
            generatedAt,
        };
    }

    // ── 7. Observability gap ──────────────────────────────────────────────────

    private _buildObservabilityGapSuggestion(
        summary: MemoryRepairInsightSummary,
        generatedAt: string,
    ): MemoryOptimizationSuggestion | null {
        if (summary.totalCycles !== 0 || summary.totalTriggers !== 0) return null;

        const score = SCORE_INFO_BASE;
        const severity = severityFromScore(score);

        return {
            id: 'observability_gap:no_events',
            category: 'observability_gap',
            title: 'No repair events found — verify telemetry and event persistence',
            summary:
                `No repair cycles or triggers were found in the last ${summary.windowHours}h analysis window. ` +
                `This may indicate that telemetry is not being persisted correctly, ` +
                `the analysis window is too short, or the system has been genuinely idle.`,
            rationale:
                `MemoryRepairAnalyticsService requires persisted repair outcome events to generate ` +
                `meaningful recommendations. When the window contains no data, the suggestion engine ` +
                `cannot assess system health.  Consider verifying that MemoryRepairOutcomeRepository ` +
                `is correctly wired and that events are being written to the database.  ` +
                `Alternatively, extending the analysis windowHours may reveal older events. ` +
                `This suggestion is advisory — no configuration is changed automatically.`,
            severity,
            priorityScore: score,
            evidence: {
                windowHours:   summary.windowHours,
                totalCycles:   summary.totalCycles,
                totalTriggers: summary.totalTriggers,
            },
            affectedSubsystems: [],
            generatedAt,
        };
    }

    // ── Top-line summary ──────────────────────────────────────────────────────

    private _buildTopLineSummary(suggestions: MemoryOptimizationSuggestion[]): string {
        if (suggestions.length === 0) {
            return 'No optimization suggestions — system maintenance patterns look healthy.';
        }
        const top = suggestions[0];
        const rest = suggestions.length > 1 ? ` (+${suggestions.length - 1} more)` : '';
        return `[${top.severity.toUpperCase()}] ${top.title}${rest}`;
    }

    // ── Telemetry emission ────────────────────────────────────────────────────

    private _emitReportGenerated(report: MemoryOptimizationSuggestionReport): void {
        TelemetryBus.getInstance().emit({
            event: 'memory.optimization_suggestions_generated',
            subsystem: 'memory',
            executionId: 'optimization-suggestions',
            payload: {
                generatedAt:               report.generatedAt,
                windowHours:               report.windowHours,
                suggestionCount:           report.suggestions.length,
                hasHighPrioritySuggestions: report.hasHighPrioritySuggestions,
                topLineSummary:            report.topLineSummary,
                categories: report.suggestions.map(s => s.category),
                severities:  report.suggestions.map(s => s.severity),
                topSuggestionId: report.suggestions[0]?.id ?? null,
            },
        });
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Maps a repair action type string to the subsystem it primarily affects.
 * Returns undefined when the mapping is unknown.
 */
function actionTypeToSubsystem(actionType: string): string | undefined {
    const map: Record<string, string> = {
        reconnect_canonical: 'canonical',
        reinit_canonical:    'canonical',
        reconnect_mem0:      'mem0',
        re_resolve_providers: 'mem0',
        reconnect_graph:     'graph',
        reconnect_rag:       'rag',
        drain_deferred_work: 'extraction',
    };
    return map[actionType];
}

/**
 * Deduplicate a suggestion array by id, keeping the entry with the highest
 * priorityScore for each id.
 */
function deduplicateById(suggestions: MemoryOptimizationSuggestion[]): MemoryOptimizationSuggestion[] {
    const map = new Map<string, MemoryOptimizationSuggestion>();
    for (const s of suggestions) {
        const existing = map.get(s.id);
        if (!existing || s.priorityScore > existing.priorityScore) {
            map.set(s.id, s);
        }
    }
    return Array.from(map.values());
}
