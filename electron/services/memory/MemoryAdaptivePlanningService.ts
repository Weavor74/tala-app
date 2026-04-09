/**
 * MemoryAdaptivePlanningService.ts — Adaptive repair planning layer
 *
 * Consumes a MemoryRepairInsightSummary (produced by MemoryRepairAnalyticsService)
 * and produces a MemoryAdaptivePlan describing priority adjustments, cadence
 * recommendations, and escalation bias for the current maintenance window.
 *
 * Design invariants
 * ─────────────────
 * 1. Deterministic — same summary input produces the same plan output
 *    (except generatedAt, which reflects the wall clock).
 * 2. Pure — generatePlan() is synchronous, performs no I/O, emits no telemetry,
 *    and writes nothing to DB or settings.
 * 3. Bounded — all scores are clamped to [0, 100]; all multipliers are fixed
 *    constants; no unbounded accumulation.
 * 4. Explainable — every priority, cadence, and escalation recommendation
 *    includes structured evidence tied to concrete repair history counts.
 * 5. Non-authoritative — the plan adjusts prioritisation and cadence hints;
 *    MemoryIntegrityPolicy and existing cooldowns remain authoritative.
 * 6. No config mutation — does not write provider settings, integrity mode,
 *    user configuration, or database configuration.
 *
 * Architecture position
 * ─────────────────────
 *   MemoryRepairAnalyticsService
 *     → MemoryAdaptivePlanningService.generatePlan(summary)
 *       → MemoryAdaptivePlan
 *         → MemoryRepairSchedulerService (repair trigger targeting)
 *         → MemorySelfMaintenanceService (escalation / subsystem flagging)
 *
 * Usage
 * ─────
 * const planner = new MemoryAdaptivePlanningService();
 * const plan = planner.generatePlan(summary);
 */

import type { MemoryRepairInsightSummary } from '../../../shared/memory/MemoryRepairInsights';
import type {
    MemoryAdaptivePlan,
    MemoryAdaptivePriority,
    MemoryAdaptiveCadence,
    MemoryAdaptiveEscalation,
    MemoryAdaptiveTarget,
} from '../../../shared/memory/MemoryAdaptivePlan';

// ---------------------------------------------------------------------------
// Static mapping tables
// ---------------------------------------------------------------------------

/**
 * Maps MemoryFailureReason strings to the corresponding adaptive target.
 * Failure reasons not listed fall through to undefined (skipped).
 */
const REASON_TO_TARGET: Record<string, MemoryAdaptiveTarget> = {
    canonical_unavailable:          'canonical',
    canonical_init_failed:          'canonical',
    mem0_unavailable:               'mem0',
    mem0_mode_canonical_only:       'mem0',
    graph_projection_unavailable:   'graph',
    rag_logging_unavailable:        'rag',
    extraction_provider_unavailable:'replay_extraction',
    embedding_provider_unavailable: 'replay_embedding',
    runtime_mismatch:               'canonical',
};

/**
 * Maps repair action type strings to the adaptive target they address.
 * Used to look up action effectiveness when scoring a target.
 */
const ACTION_TO_TARGET: Record<string, MemoryAdaptiveTarget> = {
    reconnect_canonical:   'canonical',
    reinit_canonical:      'canonical',
    reconnect_mem0:        'mem0',
    reconnect_graph:       'graph',
    reconnect_rag:         'rag',
    re_resolve_providers:  'canonical',
    drain_deferred_work:   'replay_extraction', // proxy; replay targets checked separately
};

/**
 * Maps subsystem label strings (from escalation candidate evidence) to targets.
 */
const SUBSYSTEM_TO_TARGET: Record<string, MemoryAdaptiveTarget> = {
    canonical:  'canonical',
    mem0:       'mem0',
    graph:      'graph',
    rag:        'rag',
    extraction: 'replay_extraction',
    embedding:  'replay_embedding',
};

/**
 * All replay-queue targets.  Scored from queue behaviour rather than
 * recurring failure data.
 */
const REPLAY_TARGETS: MemoryAdaptiveTarget[] = [
    'replay_extraction',
    'replay_embedding',
    'replay_graph',
];

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

/** Maximum allowed score for any single target. */
const SCORE_MAX = 100;

/** Score per occurrence count in the failure frequency component. */
const SCORE_FREQUENCY_PER_OCCURRENCE = 10;

/** Maximum contribution from failure frequency (occurrenceCount × SCORE_FREQUENCY_PER_OCCURRENCE). */
const SCORE_FREQUENCY_MAX = 50;

/** Bonus when target subsystem appears in an escalation candidate. */
const SCORE_ESCALATION_BONUS = 20;

/** Bonus when the target's best action has successRate < EFFECTIVENESS_LOW_THRESHOLD. */
const SCORE_EFFECTIVENESS_LOW_BONUS = 15;

/** Additional bonus when successRate === 0. */
const SCORE_EFFECTIVENESS_ZERO_BONUS = 10;

/** Bonus when lastSeenAt is within the past hour. */
const SCORE_RECENCY_BONUS = 10;

/** Base score for a replay target when the dead-letter queue has items. */
const SCORE_REPLAY_DL_BASE = 5;

/** Additional base when dead-letter queue is actively growing. */
const SCORE_REPLAY_DL_GROWING_EXTRA = 10;

/** Per-item score contribution for dead-letter depth (capped at SCORE_REPLAY_DL_DEPTH_CAP). */
const SCORE_REPLAY_DL_DEPTH_PER = 3;

/** Maximum score contribution from dead-letter depth. */
const SCORE_REPLAY_DL_DEPTH_CAP = 30;

/** Threshold below which action effectiveness is considered "low". */
const EFFECTIVENESS_LOW_THRESHOLD = 0.4;

/** Age threshold in ms below which a failure is considered "recent" (1 hour). */
const RECENCY_THRESHOLD_MS = 60 * 60 * 1_000;

/** Minimum executions before effectiveness scores apply. */
const EFFECTIVENESS_MIN_EXECUTIONS = 2;

/** Minimum executions before effectiveness scores apply to unstable detection. */
const EFFECTIVENESS_UNSTABLE_MIN_EXECUTIONS = 3;

// ---------------------------------------------------------------------------
// Cadence constants
// ---------------------------------------------------------------------------

/** Minimum priority score for a target to be considered an unstable subsystem. */
const UNSTABLE_SCORE_THRESHOLD = 30;

/** Min recurring failures to recommend tightening the cadence. */
const CADENCE_TIGHTEN_FAILURE_MIN = 3;

/** Min dead-letter items (when growing) to recommend tightening. */
const CADENCE_TIGHTEN_DL_MIN = 3;

/** Min escalation candidates to recommend tightening the cadence. */
const CADENCE_TIGHTEN_ESCALATION_MIN = 2;

/** Min repair cycles required to consider relaxing (evidence floor). */
const CADENCE_RELAX_CYCLES_MIN = 1;

export class MemoryAdaptivePlanningService {

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Generate an adaptive maintenance plan from a repair insight summary.
     *
     * The method is synchronous and pure — it does not query the DB,
     * emit telemetry, or write to any external state.
     *
     * @param summary — Output of MemoryRepairAnalyticsService.generateSummary().
     */
    generatePlan(summary: MemoryRepairInsightSummary): MemoryAdaptivePlan {
        const generatedAt = new Date().toISOString();

        const priorities       = this._buildPriorities(summary);
        const cadence          = this._buildCadence(summary);
        const escalation       = this._buildEscalation(summary);
        const unstableSubsystems = this._buildUnstableSubsystems(summary, priorities);
        const preferReplayOverRestart = this._buildReplayPreference(summary);
        const planSummary      = this._buildSummaryText(
            priorities, cadence, escalation, unstableSubsystems, preferReplayOverRestart,
        );

        return {
            generatedAt,
            windowHours:          summary.windowHours,
            priorities,
            cadence,
            escalation,
            unstableSubsystems,
            preferReplayOverRestart,
            summary:              planSummary,
        };
    }

    // ── Priority scoring ──────────────────────────────────────────────────────

    private _buildPriorities(summary: MemoryRepairInsightSummary): MemoryAdaptivePriority[] {
        // Accumulator: target → { score, reasons[], evidence }
        type Acc = { score: number; reasons: string[]; evidence: Record<string, unknown> };
        const scoreMap = new Map<MemoryAdaptiveTarget, Acc>();

        const addScore = (
            target: MemoryAdaptiveTarget,
            delta: number,
            reason: string,
            evidence: Record<string, unknown>,
        ): void => {
            const existing = scoreMap.get(target);
            if (existing) {
                existing.score = Math.min(SCORE_MAX, existing.score + delta);
                existing.reasons.push(reason);
                Object.assign(existing.evidence, evidence);
            } else {
                scoreMap.set(target, {
                    score: Math.min(SCORE_MAX, delta),
                    reasons: [reason],
                    evidence: { ...evidence },
                });
            }
        };

        // 1. Recurring failure frequency
        for (const failure of summary.recurrentFailures) {
            const target = REASON_TO_TARGET[failure.reason];
            if (!target) continue;

            const frequencyScore = Math.min(SCORE_FREQUENCY_MAX, failure.occurrenceCount * SCORE_FREQUENCY_PER_OCCURRENCE);
            addScore(target, frequencyScore,
                `recurring failure '${failure.reason}' × ${failure.occurrenceCount}`,
                { reason: failure.reason, occurrenceCount: failure.occurrenceCount, lastSeenAt: failure.lastSeenAt },
            );

            // Recency bonus — last occurrence within 1 hour
            const ageMs = Date.now() - new Date(failure.lastSeenAt).getTime();
            if (ageMs < RECENCY_THRESHOLD_MS) {
                addScore(target, SCORE_RECENCY_BONUS,
                    'seen within 1 hour',
                    { lastSeenAt: failure.lastSeenAt, ageMs },
                );
            }
        }

        // 2. Escalation candidacy bonus (subsystem-specific candidates)
        const escalatedSubsystems = new Set(
            summary.escalationCandidates
                .filter(c => c.code === 'repeated_failure_reason' && typeof c.evidence['subsystem'] === 'string')
                .map(c => c.evidence['subsystem'] as string),
        );
        for (const subsystem of escalatedSubsystems) {
            const target = SUBSYSTEM_TO_TARGET[subsystem];
            if (target && scoreMap.has(target)) {
                addScore(target, SCORE_ESCALATION_BONUS,
                    `escalation candidate for subsystem '${subsystem}'`,
                    { subsystem, escalationType: 'repeated_failure_reason' },
                );
            }
        }

        // 3. Action effectiveness penalty
        for (const entry of summary.actionEffectiveness) {
            const target = ACTION_TO_TARGET[entry.actionType];
            if (!target) continue;
            if (entry.totalExecutions < EFFECTIVENESS_MIN_EXECUTIONS) continue;

            if (entry.successRate < EFFECTIVENESS_LOW_THRESHOLD) {
                const bonus = entry.successRate === 0
                    ? SCORE_EFFECTIVENESS_LOW_BONUS + SCORE_EFFECTIVENESS_ZERO_BONUS
                    : SCORE_EFFECTIVENESS_LOW_BONUS;
                addScore(target, bonus,
                    `low action effectiveness: '${entry.actionType}' ` +
                    `(${(entry.successRate * 100).toFixed(0)}% over ${entry.totalExecutions} run(s))`,
                    { actionType: entry.actionType, successRate: entry.successRate, totalExecutions: entry.totalExecutions },
                );
            }
        }

        // 4. Replay targets — scored from dead-letter queue behaviour
        if (summary.queueBehavior.deadLetterCount > 0 || summary.queueBehavior.deadLetterGrowing) {
            const base = summary.queueBehavior.deadLetterGrowing
                ? SCORE_REPLAY_DL_BASE + SCORE_REPLAY_DL_GROWING_EXTRA
                : SCORE_REPLAY_DL_BASE;
            const depthBonus = Math.min(
                SCORE_REPLAY_DL_DEPTH_CAP,
                summary.queueBehavior.deadLetterCount * SCORE_REPLAY_DL_DEPTH_PER,
            );
            const replayScore = base + depthBonus;
            const replayEvidence = {
                deadLetterCount: summary.queueBehavior.deadLetterCount,
                deadLetterGrowing: summary.queueBehavior.deadLetterGrowing,
            };
            const replayReason =
                `dead-letter queue: ${summary.queueBehavior.deadLetterCount} item(s)` +
                (summary.queueBehavior.deadLetterGrowing ? ' (growing)' : '');

            for (const target of REPLAY_TARGETS) {
                addScore(target, replayScore, replayReason, replayEvidence);
            }
        }

        // Sort: highest score first; ties broken by target name for stability
        return Array.from(scoreMap.entries())
            .filter(([, v]) => v.score > 0)
            .sort(([ta, a], [tb, b]) => {
                if (b.score !== a.score) return b.score - a.score;
                return ta.localeCompare(tb);
            })
            .map(([target, v]) => ({
                target,
                score: v.score,
                reason: v.reasons.join('; '),
                evidence: v.evidence,
            }));
    }

    // ── Cadence recommendation ────────────────────────────────────────────────

    private _buildCadence(summary: MemoryRepairInsightSummary): MemoryAdaptiveCadence {
        // Tighten: multiple pressure signals indicate the system needs closer monitoring
        const shouldTighten =
            summary.escalationCandidates.length >= CADENCE_TIGHTEN_ESCALATION_MIN ||
            summary.recurrentFailures.length   >= CADENCE_TIGHTEN_FAILURE_MIN    ||
            (
                summary.queueBehavior.deadLetterGrowing &&
                summary.queueBehavior.deadLetterCount >= CADENCE_TIGHTEN_DL_MIN
            );

        if (shouldTighten) {
            return {
                recommendation: 'tighten',
                suggestedMultiplier: 0.5,
                reason: 'Elevated failure signals warrant more frequent maintenance checks.',
                evidence: {
                    escalationCandidateCount: summary.escalationCandidates.length,
                    recurrentFailureCount:    summary.recurrentFailures.length,
                    deadLetterCount:          summary.queueBehavior.deadLetterCount,
                    deadLetterGrowing:        summary.queueBehavior.deadLetterGrowing,
                },
            };
        }

        // Relax: no active signals and the repair history confirms stability
        const shouldRelax =
            summary.escalationCandidates.length === 0 &&
            summary.recurrentFailures.length     === 0 &&
            summary.queueBehavior.deadLetterCount === 0 &&
            summary.totalCycles >= CADENCE_RELAX_CYCLES_MIN;

        if (shouldRelax) {
            return {
                recommendation: 'relax',
                suggestedMultiplier: 2.0,
                reason: 'No active failure signals; maintenance cadence can be relaxed.',
                evidence: {
                    totalCycles:              summary.totalCycles,
                    escalationCandidateCount: 0,
                    recurrentFailureCount:    0,
                    deadLetterCount:          0,
                },
            };
        }

        // Normal: minor or single-occurrence signals; maintain default cadence
        return {
            recommendation: 'normal',
            suggestedMultiplier: 1.0,
            reason: 'Minor or single-occurrence signals; maintaining default cadence.',
            evidence: {
                escalationCandidateCount: summary.escalationCandidates.length,
                recurrentFailureCount:    summary.recurrentFailures.length,
                deadLetterCount:          summary.queueBehavior.deadLetterCount,
            },
        };
    }

    // ── Escalation bias ───────────────────────────────────────────────────────

    private _buildEscalation(summary: MemoryRepairInsightSummary): MemoryAdaptiveEscalation {
        // Accelerate: critical escalation patterns present (repair cycle fails or prolonged degraded)
        const CRITICAL_CODES = new Set(['repeated_cycle_failure', 'prolonged_degraded']);
        const criticalCandidates = summary.escalationCandidates.filter(c => CRITICAL_CODES.has(c.code));

        if (criticalCandidates.length > 0) {
            return {
                bias: 'accelerate',
                reason:
                    `Critical escalation pattern(s) detected: ` +
                    `${criticalCandidates.map(c => c.code).join(', ')}.`,
                evidence: {
                    codes:          criticalCandidates.map(c => c.code),
                    candidateCount: criticalCandidates.length,
                },
            };
        }

        // Defer: all recurring failures are self-resolving and no escalation candidates
        const allSelfResolving =
            summary.recurrentFailures.length > 0 &&
            summary.recurrentFailures.every(f => f.recoversBetweenFailures) &&
            summary.escalationCandidates.length === 0;

        if (allSelfResolving) {
            return {
                bias: 'defer',
                reason:
                    'All recurring failures show self-resolution between occurrences; ' +
                    'escalation can be deferred.',
                evidence: {
                    recurrentFailureCount:    summary.recurrentFailures.length,
                    allRecoverBetweenFailures: true,
                },
            };
        }

        // Normal: no strong signal either way
        return {
            bias: 'normal',
            reason: 'No critical escalation patterns detected; maintaining standard escalation thresholds.',
            evidence: {
                escalationCandidateCount: summary.escalationCandidates.length,
                recurrentFailureCount:    summary.recurrentFailures.length,
            },
        };
    }

    // ── Unstable subsystems ───────────────────────────────────────────────────

    private _buildUnstableSubsystems(
        summary: MemoryRepairInsightSummary,
        priorities: MemoryAdaptivePriority[],
    ): string[] {
        const unstable = new Set<string>();

        // From high-score priority targets
        for (const priority of priorities) {
            if (priority.score >= UNSTABLE_SCORE_THRESHOLD) {
                const subsystem = this._targetToSubsystem(priority.target);
                if (subsystem) unstable.add(subsystem);
            }
        }

        // From low action effectiveness (independent of score path)
        for (const entry of summary.actionEffectiveness) {
            if (
                entry.totalExecutions >= EFFECTIVENESS_UNSTABLE_MIN_EXECUTIONS &&
                entry.successRate < EFFECTIVENESS_LOW_THRESHOLD
            ) {
                const target = ACTION_TO_TARGET[entry.actionType];
                if (target) {
                    const subsystem = this._targetToSubsystem(target);
                    if (subsystem) unstable.add(subsystem);
                }
            }
        }

        // From subsystem-specific escalation candidates
        for (const candidate of summary.escalationCandidates) {
            if (typeof candidate.evidence['subsystem'] === 'string') {
                unstable.add(candidate.evidence['subsystem'] as string);
            }
        }

        return Array.from(unstable).sort();
    }

    private _targetToSubsystem(target: MemoryAdaptiveTarget): string | null {
        switch (target) {
            case 'canonical':         return 'canonical';
            case 'mem0':              return 'mem0';
            case 'graph':             return 'graph';
            case 'rag':               return 'rag';
            case 'replay_extraction': return 'extraction';
            case 'replay_embedding':  return 'embedding';
            case 'replay_graph':      return 'graph';
            default:                  return null;
        }
    }

    // ── Replay preference ─────────────────────────────────────────────────────

    private _buildReplayPreference(summary: MemoryRepairInsightSummary): boolean {
        // Only consider replay preference when there is a dead-letter backlog
        if (
            summary.queueBehavior.deadLetterCount === 0 &&
            !summary.queueBehavior.deadLetterGrowing
        ) {
            return false;
        }

        // Find drain_deferred_work action effectiveness (if any)
        const drainEntry = summary.actionEffectiveness.find(
            e => e.actionType === 'drain_deferred_work',
        );

        // Find reconnect / reinit action effectiveness for comparison
        const restartEntries = summary.actionEffectiveness.filter(
            e => e.actionType.startsWith('reconnect_') || e.actionType.startsWith('reinit_'),
        );

        if (restartEntries.length === 0) {
            // No reconnect data — prefer replay when queue is growing
            return summary.queueBehavior.deadLetterGrowing;
        }

        if (!drainEntry || drainEntry.totalExecutions < EFFECTIVENESS_MIN_EXECUTIONS) {
            // No drain data — prefer replay only when all restarts are failing and queue grows
            return (
                summary.queueBehavior.deadLetterGrowing &&
                restartEntries.every(e => e.successRate < EFFECTIVENESS_LOW_THRESHOLD)
            );
        }

        // Compare drain success rate vs average reconnect/reinit success rate
        const avgRestartRate =
            restartEntries.reduce((sum, e) => sum + e.successRate, 0) / restartEntries.length;

        return drainEntry.successRate >= avgRestartRate;
    }

    // ── Summary text ──────────────────────────────────────────────────────────

    private _buildSummaryText(
        priorities: MemoryAdaptivePriority[],
        cadence: MemoryAdaptiveCadence,
        escalation: MemoryAdaptiveEscalation,
        unstableSubsystems: string[],
        preferReplay: boolean,
    ): string {
        const parts: string[] = [];

        if (priorities.length === 0) {
            parts.push('no active repair targets');
        } else {
            parts.push(`top target: ${priorities[0].target} (score=${priorities[0].score})`);
        }

        if (cadence.recommendation !== 'normal') {
            parts.push(`cadence=${cadence.recommendation} (×${cadence.suggestedMultiplier})`);
        }

        if (escalation.bias !== 'normal') {
            parts.push(`escalation=${escalation.bias}`);
        }

        if (unstableSubsystems.length > 0) {
            parts.push(`unstable=[${unstableSubsystems.join(',')}]`);
        }

        if (preferReplay) {
            parts.push('prefer-replay=true');
        }

        return parts.join('; ');
    }
}
