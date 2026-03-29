/**
 * AdaptivePolicyGate.ts — Phase 5 P5D
 *
 * Adaptive policy gate for autonomous goal execution.
 *
 * This gate is applied AFTER Phase 4D (AutonomyPolicyGate) and BEFORE planning.
 * It uses adaptive signals (value score, strategy, subsystem profile) to decide
 * whether to proceed, defer, suppress, or escalate a goal.
 *
 * CRITICAL SAFETY RULE: This gate NEVER overrides a Phase 4D block.
 * When the inner gate (P4D) blocked the goal, this gate returns 'escalate'
 * (not suppress or defer). The block reason is preserved in the decision.
 *
 * Evaluation order (first applicable rule wins):
 *
 *   1. Inner gate blocked → escalate (P4D decision respected)
 *   2. Strategy is 'suppress' → suppress
 *   3. Strategy is 'defer' → defer (with deferUntil computed)
 *   4. Success probability below threshold (non-user-seeded) → defer
 *   5. Oscillation + consecutive failures ≥ threshold → escalate
 *   6. → proceed
 *
 * Every decision includes:
 *   - reasonCodes: why this decision was made
 *   - thresholdsUsed: the exact thresholds in effect at decision time
 *   - deferUntil: only when action === 'defer'
 *
 * Design principle: DETERMINISTIC FIRST — same inputs → same decision.
 */

import type {
    AdaptivePolicyDecision,
    AdaptivePolicyAction,
    AdaptiveReasonCode,
    AdaptiveThresholds,
    SubsystemProfile,
    GoalValueScore,
    StrategySelectionResult,
} from '../../../../shared/adaptiveTypes';
import type { AutonomousGoal, AutonomyPolicyDecision } from '../../../../shared/autonomyTypes';

// ─── Defer duration ───────────────────────────────────────────────────────────

/** Base defer duration in ms (1 hour). Scaled by subsystem cooldownMultiplier. */
const BASE_DEFER_MS = 60 * 60 * 1000;

// ─── AdaptivePolicyGate ───────────────────────────────────────────────────────

export class AdaptivePolicyGate {
    /**
     * Evaluates whether a goal should proceed to planning, be deferred,
     * suppressed, or escalated to human review.
     *
     * @param goal              The autonomous goal being evaluated.
     * @param innerGateResult   The Phase 4D AutonomyPolicyGate decision (must be respected).
     * @param valueScore        The adaptive value score.
     * @param strategyResult    The strategy selection result.
     * @param profile           The subsystem adaptive profile.
     * @param thresholds        The adaptive thresholds to apply.
     */
    evaluate(
        goal: AutonomousGoal,
        innerGateResult: AutonomyPolicyDecision,
        valueScore: GoalValueScore,
        strategyResult: StrategySelectionResult,
        profile: SubsystemProfile,
        thresholds: AdaptiveThresholds,
    ): AdaptivePolicyDecision {
        // ── Rule 1: Inner gate blocked → escalate ───────────────────────────────
        // Phase 4D blocks are NEVER converted to suppress or defer by this gate.
        // They are always escalated to human review.
        if (!innerGateResult.permitted) {
            return this._decision(goal.goalId, 'escalate',
                `Phase 4 policy gate blocked goal: ${innerGateResult.blockReason ?? 'policy_check_failed'}. ` +
                `Escalated to human review.`,
                ['inner_gate_blocked'],
                thresholds,
            );
        }

        // ── Rule 2: Strategy is 'suppress' → suppress ───────────────────────────
        if (strategyResult.strategy === 'suppress') {
            return this._decision(goal.goalId, 'suppress',
                `Strategy selection suppressed this goal: ${strategyResult.reason}`,
                ['low_value_score'],
                thresholds,
            );
        }

        // ── Rule 3: Strategy is 'defer' → defer ────────────────────────────────
        if (strategyResult.strategy === 'defer') {
            const deferUntil = this._computeDeferUntil(profile);
            return this._decision(goal.goalId, 'defer',
                `Strategy selection deferred this goal: ${strategyResult.reason}`,
                ['low_value_score_defer'],
                thresholds,
                deferUntil,
            );
        }

        // ── Rule 4: Low success probability (non-user-seeded) → defer ──────────
        // user_seeded goals bypass this gate — users have expressed intent to act.
        if (goal.source !== 'user_seeded'
            && valueScore.successProbability < thresholds.minSuccessProbability) {
            const deferUntil = this._computeDeferUntil(profile);
            return this._decision(goal.goalId, 'defer',
                `Success probability ${(valueScore.successProbability * 100).toFixed(0)}% ` +
                `is below threshold ${(thresholds.minSuccessProbability * 100).toFixed(0)}%. ` +
                `Deferring until ${deferUntil}.`,
                ['low_success_probability'],
                thresholds,
                deferUntil,
            );
        }

        // ── Rule 5: Oscillation + consecutive failures → escalate ───────────────
        if (profile.oscillationDetected
            && profile.consecutiveFailures >= thresholds.escalateAfterConsecutiveFailures) {
            return this._decision(goal.goalId, 'escalate',
                `Subsystem ${goal.subsystemId} has oscillating outcomes with ` +
                `${profile.consecutiveFailures} consecutive failures. Escalating to human review.`,
                ['recent_oscillation', 'consecutive_failures'],
                thresholds,
            );
        }

        // ── Rule 6: Proceed ─────────────────────────────────────────────────────
        return this._decision(goal.goalId, 'proceed',
            `All adaptive checks passed (valueScore=${valueScore.valueScore}, ` +
            `successProb=${(valueScore.successProbability * 100).toFixed(0)}%, ` +
            `strategy=${strategyResult.strategy})`,
            ['succeeded_above_threshold'],
            thresholds,
        );
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────

    private _decision(
        goalId: string,
        action: AdaptivePolicyAction,
        reason: string,
        reasonCodes: AdaptiveReasonCode[],
        thresholds: AdaptiveThresholds,
        deferUntil?: string,
    ): AdaptivePolicyDecision {
        return {
            goalId,
            decidedAt: new Date().toISOString(),
            action,
            reason,
            reasonCodes,
            thresholdsUsed: { ...thresholds }, // Snapshot at decision time
            deferUntil,
        };
    }

    /**
     * Computes the defer-until timestamp.
     * Base defer duration scaled by the subsystem's cooldownMultiplier.
     */
    private _computeDeferUntil(profile: SubsystemProfile): string {
        const deferMs = BASE_DEFER_MS * profile.cooldownMultiplier;
        return new Date(Date.now() + deferMs).toISOString();
    }
}
