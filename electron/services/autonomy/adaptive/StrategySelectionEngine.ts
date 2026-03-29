/**
 * StrategySelectionEngine.ts — Phase 5 P5C
 *
 * Deterministic strategy selection for autonomous goal execution.
 *
 * Decides which execution strategy to use for a goal based on:
 *   - Adaptive value score (from GoalValueScoringEngine)
 *   - Recovery pack availability and confidence
 *   - Subsystem profile strategy preference and recent failure history
 *   - Configurable thresholds
 *
 * Selection algorithm (applied in order):
 *
 *   Stage 1: Value gate
 *     - valueScore < suppressBelow → suppress
 *     - valueScore < deferBelow    → defer
 *
 *   Stage 2: Pack eligibility
 *     packEligible = selectedPackId != null
 *                    AND packConfidence >= packConfidenceFloor
 *                    AND not recently failing repeatedly
 *
 *   Stage 3: Strategy decision
 *     - packEligible AND profile prefers pack (or no preference) → recovery_pack
 *     - packEligible AND profile prefers standard AND pack not clearly better → standard_planning
 *     - packEligible AND recent consecutive pack failures            → standard_planning
 *     - no pack → standard_planning
 *
 * Standard planning is always reachable as a fallback.
 * Every rejected strategy is listed in alternativesConsidered with a rejection reason.
 *
 * Design principle: DETERMINISTIC FIRST — same inputs → same result.
 */

import type {
    StrategySelectionResult,
    StrategyKind,
    AdaptiveReasonCode,
    StrategyAlternative,
    AdaptiveThresholds,
    SubsystemProfile,
    GoalValueScore,
} from '../../../../shared/adaptiveTypes';
import type { AutonomousGoal } from '../../../../shared/autonomyTypes';
import type { RecoveryPackMatchResult } from '../../../../shared/recoveryPackTypes';

// ─── StrategySelectionEngine ──────────────────────────────────────────────────

export class StrategySelectionEngine {
    /**
     * Selects an execution strategy for the given goal.
     *
     * Deterministic: same inputs → same StrategySelectionResult.
     *
     * @param goal           The autonomous goal to select a strategy for.
     * @param valueScore     The computed GoalValueScore.
     * @param profile        The subsystem adaptive profile.
     * @param packMatchResult The recovery pack match result (undefined if no packs active).
     * @param thresholds     Configurable thresholds.
     */
    select(
        goal: AutonomousGoal,
        valueScore: GoalValueScore,
        profile: SubsystemProfile,
        packMatchResult: RecoveryPackMatchResult | undefined,
        thresholds: AdaptiveThresholds,
    ): StrategySelectionResult {
        const alternativesConsidered: StrategyAlternative[] = [];

        // ── Stage 1: Value gate ─────────────────────────────────────────────────

        if (valueScore.valueScore < thresholds.suppressBelow) {
            alternativesConsidered.push(
                { strategy: 'recovery_pack', rejectionReason: 'value score below suppress threshold' },
                { strategy: 'standard_planning', rejectionReason: 'value score below suppress threshold' },
                { strategy: 'defer', rejectionReason: 'value score below suppress threshold; suppress is preferred' },
            );
            return this._result(goal.goalId, 'suppress', undefined, undefined,
                `Value score ${valueScore.valueScore} is below suppress threshold (${thresholds.suppressBelow})`,
                ['low_value_score'], alternativesConsidered);
        }

        if (valueScore.valueScore < thresholds.deferBelow) {
            alternativesConsidered.push(
                { strategy: 'recovery_pack', rejectionReason: 'value score below defer threshold' },
                { strategy: 'standard_planning', rejectionReason: 'value score below defer threshold; deferral preferred' },
            );
            return this._result(goal.goalId, 'defer', undefined, undefined,
                `Value score ${valueScore.valueScore} is below defer threshold (${thresholds.deferBelow})`,
                ['low_value_score_defer'], alternativesConsidered);
        }

        // ── Stage 2: Pack eligibility ──────────────────────────────────────────

        const packId = packMatchResult?.selectedPackId ?? null;
        const packEligible = packId !== null
            && valueScore.packAvailable
            && valueScore.packConfidence >= thresholds.packConfidenceFloor;

        // ── Stage 3: Strategy decision ─────────────────────────────────────────

        if (packEligible && packId) {
            // Check if packs have been consistently failing on this subsystem
            const packTotal   = profile.packSuccessCount + profile.packFailureCount;
            const packFailing = packTotal >= 2
                && profile.packFailureCount > profile.packSuccessCount;

            if (packFailing) {
                // Recent pack failures exceed pack successes — prefer standard
                alternativesConsidered.push({
                    strategy: 'recovery_pack',
                    packId,
                    packConfidence: valueScore.packConfidence,
                    rejectionReason:
                        `Recent pack failures (${profile.packFailureCount}) exceed successes ` +
                        `(${profile.packSuccessCount}) on this subsystem`,
                });
                return this._result(goal.goalId, 'standard_planning', undefined, undefined,
                    `Standard planning preferred: recent pack failure ratio too high on ${goal.subsystemId}`,
                    ['repeated_pack_failure'], alternativesConsidered);
            }

            // Profile prefers standard planning explicitly
            if (profile.preferredStrategy === 'standard_planning') {
                alternativesConsidered.push({
                    strategy: 'recovery_pack',
                    packId,
                    packConfidence: valueScore.packConfidence,
                    rejectionReason: 'subsystem profile prefers standard planning',
                });
                return this._result(goal.goalId, 'standard_planning', undefined, undefined,
                    `Standard planning preferred by subsystem profile for ${goal.subsystemId}`,
                    ['standard_preferred_by_profile'], alternativesConsidered);
            }

            // Pack preferred by profile or no preference yet → use pack
            const reasonCodes: AdaptiveReasonCode[] =
                profile.preferredStrategy === 'recovery_pack'
                    ? ['pack_preferred_by_profile', 'pack_high_confidence']
                    : ['pack_high_confidence'];

            alternativesConsidered.push({
                strategy: 'standard_planning',
                rejectionReason: 'recovery pack available with sufficient confidence',
            });

            return this._result(goal.goalId, 'recovery_pack', packId, valueScore.packConfidence,
                `Recovery pack selected (confidence ${(valueScore.packConfidence * 100).toFixed(0)}%)`,
                reasonCodes, alternativesConsidered);
        }

        // No pack, or pack below confidence floor
        if (packId !== null && !packEligible) {
            // Pack matched but confidence below floor
            alternativesConsidered.push({
                strategy: 'recovery_pack',
                packId,
                packConfidence: valueScore.packConfidence,
                rejectionReason:
                    `Pack confidence ${(valueScore.packConfidence * 100).toFixed(0)}% ` +
                    `below floor (${(thresholds.packConfidenceFloor * 100).toFixed(0)}%)`,
            });
            return this._result(goal.goalId, 'standard_planning', undefined, undefined,
                `Standard planning fallback: best pack confidence ${(valueScore.packConfidence * 100).toFixed(0)}% ` +
                `below floor ${(thresholds.packConfidenceFloor * 100).toFixed(0)}%`,
                ['pack_confidence_below_floor'], alternativesConsidered);
        }

        // No pack available at all
        alternativesConsidered.push({
            strategy: 'recovery_pack',
            rejectionReason: 'no recovery pack matched this goal',
        });
        return this._result(goal.goalId, 'standard_planning', undefined, undefined,
            'Standard planning selected: no recovery pack available for this goal',
            ['pack_unavailable'], alternativesConsidered);
    }

    // ── Result builder ─────────────────────────────────────────────────────────

    private _result(
        goalId: string,
        strategy: StrategyKind,
        packId: string | undefined,
        packConfidence: number | undefined,
        reason: string,
        reasonCodes: AdaptiveReasonCode[],
        alternativesConsidered: StrategyAlternative[],
    ): StrategySelectionResult {
        return {
            goalId,
            selectedAt: new Date().toISOString(),
            strategy,
            selectedPackId: packId,
            packConfidence,
            reason,
            reasonCodes,
            alternativesConsidered,
        };
    }
}
