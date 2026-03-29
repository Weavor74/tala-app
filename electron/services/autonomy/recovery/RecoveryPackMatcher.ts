/**
 * RecoveryPackMatcher.ts — Phase 4.3 P4.3C
 *
 * Deterministic failure-pattern matching engine.
 *
 * Design principles:
 * - Fully deterministic: same input → same output, no randomness, no model calls.
 * - Explicit and inspectable: every decision is recorded with a rationale string.
 * - Bounded: disqualifying conditions are checked before scoring begins.
 * - Conservative: strong_match requires score ≥ 60 AND confidence ≥ 0.6.
 *
 * Matching algorithm:
 *   For each enabled pack (from the registry):
 *     1. Check disqualifying conditions — if any triggers, mark disqualified and skip scoring.
 *     2. Evaluate each applicability rule against the goal.
 *        - If any `required` rule fails → score = 0.
 *        - Sum weights of passing rules.
 *     3. Determine match strength from score + confidence.
 *   Sort candidates by score descending.
 *   Select the highest-scoring non-disqualified strong_match (or weak_match if policy permits).
 *
 * Confidence thresholds (conservative defaults):
 *   strong_match: score ≥ 60 AND pack.confidence.current ≥ 0.60
 *   weak_match:   score ≥ 30 AND pack.confidence.current ≥ 0.40
 *
 * P4.3H safety controls enforced here:
 *   - goal.subsystemId in hardBlockedSubsystems → disqualified
 *   - pack.enabled === false → skipped
 *   - pack.requiresHumanReview === true → disqualified for autonomous selection
 *   - pack.confidence.current < pack.confidence.floor → disqualified
 *   - attemptCount for (packId, goalId) >= pack.maxAttemptsPerGoal → disqualified
 */

import type {
    RecoveryPack,
    RecoveryPackApplicabilityRule,
    RecoveryPackMatch,
    RecoveryPackMatchResult,
    RecoveryPackMatchStrength,
    RecoveryPackId,
} from '../../../../shared/recoveryPackTypes';
import type { AutonomousGoal } from '../../../../shared/autonomyTypes';
import type { RecoveryPackRegistry } from './RecoveryPackRegistry';
import { telemetry } from '../../TelemetryService';

// ─── Match score thresholds ───────────────────────────────────────────────────

const STRONG_MATCH_SCORE_MIN = 60;
const WEAK_MATCH_SCORE_MIN = 30;
const STRONG_MATCH_CONFIDENCE_MIN = 0.60;
const WEAK_MATCH_CONFIDENCE_MIN = 0.40;

// ─── RecoveryPackMatcher ──────────────────────────────────────────────────────

export class RecoveryPackMatcher {
    constructor(private readonly registry: RecoveryPackRegistry) {}

    /**
     * Evaluates all enabled packs against the given goal and returns the full
     * match result including all candidates and the selected pack (if any).
     *
     * @param goal                  The autonomous goal to match against.
     * @param hardBlockedSubsystems Subsystem IDs that can never be addressed by any pack.
     * @param packAttemptCounts     Per-pack attempt counts for this specific goal.
     *                              Used to enforce maxAttemptsPerGoal disqualifier.
     */
    match(
        goal: AutonomousGoal,
        hardBlockedSubsystems: string[],
        packAttemptCounts: Map<RecoveryPackId, number> = new Map(),
    ): RecoveryPackMatchResult {
        const evaluatedAt = new Date().toISOString();
        const packs = this.registry.getAll(/* enabledOnly= */ false);
        const candidates: RecoveryPackMatch[] = [];

        for (const pack of packs) {
            if (!pack.enabled) continue; // Skip disabled packs entirely

            const candidate = this._evaluatePack(
                pack, goal, hardBlockedSubsystems, packAttemptCounts,
            );
            candidates.push(candidate);
        }

        // Sort by score descending (disqualified packs float to bottom)
        candidates.sort((a, b) => {
            if (a.disqualified !== b.disqualified) return a.disqualified ? 1 : -1;
            return b.matchScore - a.matchScore;
        });

        // Find the best valid candidate
        const best = candidates.find(c => !c.disqualified && c.matchStrength !== 'no_match');

        const result: RecoveryPackMatchResult = {
            goalId: goal.goalId,
            evaluatedAt,
            candidates,
            selectedPackId: best?.packId ?? null,
            selectedMatchStrength: best?.matchStrength ?? 'no_match',
            fallbackToStandardPlanning: !best,
            rationale: best
                ? `Selected pack '${best.packId}' (${best.matchStrength}, score ${best.matchScore}): ${best.rationale}`
                : `No suitable recovery pack found — falling back to standard planning. ` +
                  `Evaluated ${candidates.length} pack(s).`,
        };

        telemetry.operational(
            'autonomy',
            'recovery_pack_match_attempted',
            'debug',
            'RecoveryPackMatcher',
            `Match for goal ${goal.goalId}: selected=${result.selectedPackId ?? 'none'} ` +
            `(${result.selectedMatchStrength}), evaluated ${candidates.length} pack(s)`,
        );

        return result;
    }

    // ── Private ─────────────────────────────────────────────────────────────────

    private _evaluatePack(
        pack: RecoveryPack,
        goal: AutonomousGoal,
        hardBlockedSubsystems: string[],
        packAttemptCounts: Map<RecoveryPackId, number>,
    ): RecoveryPackMatch {
        // ── Check disqualifying conditions ────────────────────────────────────

        if (pack.requiresHumanReview) {
            return this._disqualified(pack, 'pack_requires_human_review',
                `Pack ${pack.packId} requires human review — not eligible for autonomous selection.`);
        }

        if (hardBlockedSubsystems.includes(goal.subsystemId)) {
            return this._disqualified(pack, 'subsystem_hard_blocked',
                `Goal subsystem '${goal.subsystemId}' is hard-blocked by autonomy policy.`);
        }

        if (pack.confidence.current <= pack.confidence.floor) {
            return this._disqualified(pack, 'confidence_below_floor',
                `Pack confidence ${pack.confidence.current.toFixed(3)} is at or below floor ${pack.confidence.floor.toFixed(3)}.`);
        }

        const attempts = packAttemptCounts.get(pack.packId) ?? 0;
        if (attempts >= pack.maxAttemptsPerGoal) {
            return this._disqualified(pack, 'max_attempts_reached',
                `Pack ${pack.packId} has been attempted ${attempts} time(s) for this goal (max: ${pack.maxAttemptsPerGoal}).`);
        }

        // ── Check scope.allowedSubsystems filter (non-empty = explicit allowlist) ─
        if (pack.scope.allowedSubsystems.length > 0 &&
            !pack.scope.allowedSubsystems.includes(goal.subsystemId)) {
            return this._disqualified(pack, 'subsystem_not_in_scope',
                `Goal subsystem '${goal.subsystemId}' is not in pack's allowedSubsystems.`);
        }

        // ── Evaluate applicability rules ──────────────────────────────────────

        let totalScore = 0;
        const matchedRuleIds: string[] = [];
        const ruleReasons: string[] = [];

        for (const rule of pack.applicabilityRules) {
            const matched = this._evaluateRule(rule, goal);
            if (matched) {
                totalScore += rule.weight;
                matchedRuleIds.push(rule.ruleId);
                ruleReasons.push(`rule '${rule.ruleId}' matched (+${rule.weight})`);
            } else if (rule.required) {
                // Required rule failed — score is 0, candidate does not qualify
                return {
                    packId: pack.packId,
                    packVersion: pack.version,
                    matchStrength: 'no_match',
                    matchScore: 0,
                    matchedRuleIds: [],
                    rationale: `Required rule '${rule.ruleId}' did not match (kind: ${rule.kind}, matchValue: ${rule.matchValue}).`,
                    disqualified: false,
                };
            } else {
                ruleReasons.push(`rule '${rule.ruleId}' did not match (optional, +0)`);
            }
        }

        // ── Determine match strength ──────────────────────────────────────────

        const confidence = pack.confidence.current;
        let matchStrength: RecoveryPackMatchStrength = 'no_match';

        if (totalScore >= STRONG_MATCH_SCORE_MIN && confidence >= STRONG_MATCH_CONFIDENCE_MIN) {
            matchStrength = 'strong_match';
        } else if (totalScore >= WEAK_MATCH_SCORE_MIN && confidence >= WEAK_MATCH_CONFIDENCE_MIN) {
            matchStrength = 'weak_match';
        }

        const rationale = ruleReasons.length > 0
            ? `Score ${totalScore}: ${ruleReasons.join(', ')}. Confidence: ${confidence.toFixed(3)}. Strength: ${matchStrength}.`
            : `No rules matched. Score: 0.`;

        return {
            packId: pack.packId,
            packVersion: pack.version,
            matchStrength,
            matchScore: totalScore,
            matchedRuleIds,
            rationale,
            disqualified: false,
        };
    }

    private _evaluateRule(rule: RecoveryPackApplicabilityRule, goal: AutonomousGoal): boolean {
        switch (rule.kind) {
            case 'goal_source_match':
                return goal.source === rule.matchValue;

            case 'keyword_in_title':
                return goal.title.toLowerCase().includes(rule.matchValue.toLowerCase());

            case 'subsystem_id_match':
                return goal.subsystemId === rule.matchValue;

            case 'min_source_count': {
                const threshold = parseInt(rule.matchValue, 10);
                if (isNaN(threshold)) return false;
                const count = this._extractSourceCount(goal);
                return count >= threshold;
            }

            default:
                return false;
        }
    }

    /**
     * Extracts the primary numeric count from the goal's sourceContext.
     * Maps different context types to their relevant count field:
     *   RepeatedExecutionFailureContext → failureCount
     *   GovernanceBlockContext → blockCount
     *   RecurringReflectionGoalContext → recurrenceCount
     *   Others → 0
     */
    private _extractSourceCount(goal: AutonomousGoal): number {
        const ctx = goal.sourceContext;
        if ('failureCount' in ctx && typeof ctx.failureCount === 'number') {
            return ctx.failureCount;
        }
        if ('blockCount' in ctx && typeof ctx.blockCount === 'number') {
            return ctx.blockCount;
        }
        if ('recurrenceCount' in ctx && typeof ctx.recurrenceCount === 'number') {
            return ctx.recurrenceCount;
        }
        return 0;
    }

    private _disqualified(
        pack: RecoveryPack,
        reason: string,
        detail: string,
    ): RecoveryPackMatch {
        return {
            packId: pack.packId,
            packVersion: pack.version,
            matchStrength: 'no_match',
            matchScore: 0,
            matchedRuleIds: [],
            rationale: detail,
            disqualified: true,
            disqualifyingReason: reason,
        };
    }
}
