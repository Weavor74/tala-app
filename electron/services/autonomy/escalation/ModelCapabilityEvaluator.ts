/**
 * ModelCapabilityEvaluator.ts — Phase 5.1 P5.1B
 *
 * Deterministic evaluator that assesses whether the active model can handle
 * a given autonomous goal.
 *
 * Assessment algorithm (all rules are evaluated; first canHandle=false wins):
 *
 *   Signal 1: Context size
 *     estimatedContextTokens / modelContextLimit >= contextSizeThresholdRatio
 *     AND recentLocalFailures >= minFailuresForContextTrigger
 *     → context_size_exceeded
 *
 *   Signal 2: Repeated local failures
 *     recentLocalFailures >= minLocalFailuresBeforeEscalation
 *     → repeated_local_failures
 *
 *   Signal 3: High complexity
 *     complexityScore >= highComplexityThreshold
 *     AND recentLocalFailures >= minFailuresForContextTrigger
 *     → high_complexity_task
 *
 *   Signal 4: Multi-file repair scope
 *     goal description contains multi-file indicators
 *     AND recentLocalFailures >= minFailuresForContextTrigger
 *     → multi_file_repair_scope
 *
 *   Signal 5: Recovery pack exhausted
 *     recoveryPacksExhausted=true
 *     → recovery_pack_exhausted
 *
 * Complexity score is derived from:
 *   - goal.description length (longer = potentially more complex)
 *   - number of recent failures (more = higher complexity score)
 *   - multi-file indicators in goal title/description
 *   - subsystem ID (some subsystems are inherently more complex)
 *
 * Design principle: DETERMINISTIC FIRST — same inputs → same result.
 * No model calls, no network I/O.
 */

import type { AutonomousGoal } from '../../../../shared/autonomyTypes';
import type {
    TaskCapabilityAssessment,
    CapabilityInsufficiencyReason,
    EscalationPolicy,
} from '../../../../shared/escalationTypes';

// ─── Complexity heuristics ────────────────────────────────────────────────────

/** Subsystem IDs considered inherently higher-complexity. */
const HIGH_COMPLEXITY_SUBSYSTEMS = new Set([
    'inference',
    'execution',
    'context_assembly',
    'memory_graph',
    'governance',
    'autonomy',
]);

/**
 * Keywords in goal title/description that indicate multi-file repair scope.
 * All lowercased for matching.
 */
const MULTI_FILE_KEYWORDS = [
    'multiple files',
    'multi-file',
    'multifile',
    'across files',
    'several files',
    'all files',
    'many files',
    'batch fix',
    'codebase-wide',
    'refactor',
    'migration',
];

// ─── Complexity scoring constants ─────────────────────────────────────────────

/** Max complexity contribution from description length. */
const MAX_DESCRIPTION_LENGTH_SCORE = 25;
/** Max complexity contribution from failure count. */
const MAX_FAILURE_SCORE = 30;
/** Complexity bonus for high-complexity subsystems. */
const HIGH_COMPLEXITY_SUBSYSTEM_BONUS = 20;
/** Complexity bonus for multi-file indicators. */
const MULTI_FILE_BONUS = 25;

// ─── Context size estimation ──────────────────────────────────────────────────

/**
 * Rough token estimate multiplier.
 * We assume ~4 characters per token (conservative estimate).
 */
const CHARS_PER_TOKEN = 4;

/** Base overhead tokens for system prompt, tool schemas, identity context, etc. */
const BASE_OVERHEAD_TOKENS = 2048;

// ─── ModelCapabilityEvaluator ─────────────────────────────────────────────────

export class ModelCapabilityEvaluator {
    /**
     * Assesses whether the active model can handle the given goal.
     *
     * Deterministic: same inputs → same TaskCapabilityAssessment.
     *
     * @param goal                  The autonomous goal to assess.
     * @param recentLocalFailures   Number of recent local failures for this goal/subsystem.
     * @param policy                The active escalation policy.
     * @param modelContextLimit     Active model's context window (tokens). 0 = unknown.
     * @param recoveryPacksExhausted Whether all matched recovery packs have been tried and failed.
     */
    evaluate(
        goal: AutonomousGoal,
        recentLocalFailures: number,
        policy: EscalationPolicy,
        modelContextLimit: number = 0,
        recoveryPacksExhausted: boolean = false,
    ): TaskCapabilityAssessment {
        const assessedAt = new Date().toISOString();

        // ── Estimate context size ───────────────────────────────────────────────
        const estimatedContextTokens = this._estimateContextTokens(goal);

        // ── Compute complexity score ────────────────────────────────────────────
        const complexityScore = this._computeComplexityScore(goal, recentLocalFailures);

        // ── Evaluate insufficiency signals ─────────────────────────────────────
        const insufficiencyReasons: CapabilityInsufficiencyReason[] = [];

        // Signal 1: Context size exceeded
        if (
            modelContextLimit > 0
            && recentLocalFailures >= policy.minFailuresForContextTrigger
            && estimatedContextTokens / modelContextLimit >= policy.contextSizeThresholdRatio
        ) {
            insufficiencyReasons.push('context_size_exceeded');
        }

        // Signal 2: Repeated local failures
        if (recentLocalFailures >= policy.minLocalFailuresBeforeEscalation) {
            insufficiencyReasons.push('repeated_local_failures');
        }

        // Signal 3: High complexity
        if (
            complexityScore >= policy.highComplexityThreshold
            && recentLocalFailures >= policy.minFailuresForContextTrigger
        ) {
            insufficiencyReasons.push('high_complexity_task');
        }

        // Signal 4: Multi-file repair scope
        if (
            this._hasMultiFileIndicators(goal)
            && recentLocalFailures >= policy.minFailuresForContextTrigger
        ) {
            insufficiencyReasons.push('multi_file_repair_scope');
        }

        // Signal 5: Recovery pack exhausted
        if (recoveryPacksExhausted) {
            insufficiencyReasons.push('recovery_pack_exhausted');
        }

        const canHandle = insufficiencyReasons.length === 0;

        const rationale = canHandle
            ? `Active model is assessed as capable: recentFailures=${recentLocalFailures}, ` +
              `complexity=${complexityScore}, estimatedTokens=${estimatedContextTokens}`
            : `Active model insufficient: ${insufficiencyReasons.join(', ')}. ` +
              `recentFailures=${recentLocalFailures}, complexity=${complexityScore}, ` +
              `estimatedTokens=${estimatedContextTokens}` +
              (modelContextLimit > 0 ? `, modelLimit=${modelContextLimit}` : '');

        return {
            goalId: goal.goalId,
            assessedAt,
            canHandle,
            insufficiencyReasons,
            estimatedContextTokens,
            modelContextLimit,
            recentLocalFailures,
            complexityScore,
            rationale,
        };
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    /**
     * Estimates the context size in tokens for this goal.
     * Based on goal description length plus a base overhead.
     */
    private _estimateContextTokens(goal: AutonomousGoal): number {
        const descLen = (goal.description?.length ?? 0) + (goal.title?.length ?? 0);
        const contentTokens = Math.ceil(descLen / CHARS_PER_TOKEN);
        return BASE_OVERHEAD_TOKENS + contentTokens;
    }

    /**
     * Computes a 0-100 complexity score for a goal.
     *
     * Components:
     *   - Description length (0–25 points)
     *   - Recent failure count (0–30 points)
     *   - High-complexity subsystem (0 or 20 points)
     *   - Multi-file indicators (0 or 25 points)
     *
     * Clamped to [0, 100].
     */
    private _computeComplexityScore(goal: AutonomousGoal, recentLocalFailures: number): number {
        let score = 0;

        // Description length component
        const descLen = (goal.description?.length ?? 0) + (goal.title?.length ?? 0);
        const descScore = Math.min(MAX_DESCRIPTION_LENGTH_SCORE, Math.floor(descLen / 40));
        score += descScore;

        // Failure count component (more failures = harder task)
        const failureScore = Math.min(MAX_FAILURE_SCORE, recentLocalFailures * 10);
        score += failureScore;

        // High-complexity subsystem
        if (HIGH_COMPLEXITY_SUBSYSTEMS.has(goal.subsystemId)) {
            score += HIGH_COMPLEXITY_SUBSYSTEM_BONUS;
        }

        // Multi-file indicators
        if (this._hasMultiFileIndicators(goal)) {
            score += MULTI_FILE_BONUS;
        }

        return Math.min(100, Math.max(0, score));
    }

    /**
     * Returns true if the goal description or title contains multi-file keywords.
     */
    private _hasMultiFileIndicators(goal: AutonomousGoal): boolean {
        const text = `${goal.title ?? ''} ${goal.description ?? ''}`.toLowerCase();
        return MULTI_FILE_KEYWORDS.some(kw => text.includes(kw));
    }
}
