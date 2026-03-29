/**
 * GoalPrioritizationEngine.ts — Phase 4 P4C / Phase 5 P5B enhancement
 *
 * Scores and ranks GoalCandidate[] into AutonomousGoal[] with priority tiers.
 *
 * Scoring model (all weights configurable via overrides):
 *
 *   severityWeight(0–30)           — how urgent/severe is the signal
 *   recurrenceWeight(0–20)         — how many times has this pattern been seen
 *   subsystemImportanceWeight(0–15) — how many invariants guard this subsystem
 *   confidenceWeight(0–15)         — prior success rate for this pattern
 *   governanceLikelihoodWeight(0–10) — likelihood governance will allow
 *   rollbackConfidenceWeight(0–10) — baseline rollback confidence
 *   executionCostPenalty(0–10)     — estimated effort (higher = lower priority)
 *   protectedPenalty(0..−20)       — penalty if subsystem is hard-blocked
 *
 * Phase 5 enhancement:
 *   When a SubsystemProfileRegistry is provided via setProfileRegistry(),
 *   the confidence weight is blended:
 *     60% from OutcomeLearningRegistry per-pattern confidence
 *     40% from SubsystemProfile.successRate (empirical subsystem success rate)
 *   This improves prioritization accuracy for subsystems with known history.
 *   The change is backward-compatible: scoring is unchanged when no registry is set.
 *
 * Priority tiers (by total score):
 *   critical  ≥ 80
 *   high      ≥ 60
 *   medium    ≥ 40
 *   low       ≥ 20
 *   suppressed < 20 or suppressed by cooldown/dedup/budget
 *
 * Design principle: DETERMINISTIC FIRST — no model calls.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    GoalCandidate,
    AutonomousGoal,
    GoalPriorityTier,
    GoalPriorityScore,
} from '../../../shared/autonomyTypes';
import type { OutcomeLearningRegistry } from './OutcomeLearningRegistry';
import type { AutonomyCooldownRegistry } from './AutonomyCooldownRegistry';
import type { AutonomyBudgetManager } from './AutonomyBudgetManager';
import type { AutonomyBudget, AutonomyPolicy } from '../../../shared/autonomyTypes';
// Phase 5: optional profile registry for blended confidence weight
import type { SubsystemProfileRegistry } from './adaptive/SubsystemProfileRegistry';

// ─── Severity weights by source ───────────────────────────────────────────────

const SOURCE_SEVERITY_WEIGHTS: Record<string, number> = {
    repeated_execution_failure: 25,
    failed_verification: 20,
    repeated_governance_block: 15,
    telemetry_anomaly: 18,
    stale_subsystem: 10,
    recurring_reflection_goal: 12,
    weak_coverage_signal: 8,
    unresolved_backlog_item: 10,
    user_seeded: 20,
};

// Subsystems considered high-importance (more invariants → higher weight)
const HIGH_IMPORTANCE_SUBSYSTEMS = new Set([
    'inference', 'memory', 'reflection', 'governance', 'execution',
    'soul', 'identity', 'mcp',
]);
const MEDIUM_IMPORTANCE_SUBSYSTEMS = new Set([
    'retrieval', 'search', 'context', 'router', 'cognitive',
]);

// ─── GoalPrioritizationEngine ─────────────────────────────────────────────────

export class GoalPrioritizationEngine {
    // ── Phase 5: optional subsystem profile registry for blended confidence ──
    private _profileRegistry: SubsystemProfileRegistry | null = null;

    constructor(
        private readonly learningRegistry: OutcomeLearningRegistry,
        private readonly cooldownRegistry: AutonomyCooldownRegistry,
        private readonly budgetManager: AutonomyBudgetManager,
    ) {}

    /**
     * Injects the Phase 5 SubsystemProfileRegistry.
     * When set, confidence weight is blended with subsystem success rate.
     * When absent, scoring is identical to Phase 4 behavior.
     * Must be called before score() to take effect.
     */
    setProfileRegistry(registry: SubsystemProfileRegistry): void {
        this._profileRegistry = registry;
    }

    /**
     * Scores and ranks candidates, producing AutonomousGoal[] with priorities set.
     *
     * Non-eligible/suppressed goals are still returned with status='suppressed'
     * for dashboard visibility.
     */
    score(
        candidates: GoalCandidate[],
        policy: AutonomyPolicy,
    ): AutonomousGoal[] {
        return candidates.map(c => this._scoreOne(c, policy)).sort((a, b) =>
            b.priorityScore.total - a.priorityScore.total,
        );
    }

    // ── Scoring ─────────────────────────────────────────────────────────────────

    private _scoreOne(candidate: GoalCandidate, policy: AutonomyPolicy): AutonomousGoal {
        const patternKey = candidate.dedupFingerprint;
        const budget = policy.budget;

        // Check suppression conditions first
        const suppressionReason = this._checkSuppression(candidate, policy);

        const score = this._computeScore(candidate, patternKey, policy);
        const tier = this._computeTier(score.total, suppressionReason !== null);

        const humanReviewRequired =
            this.learningRegistry.shouldRouteToHumanReview(patternKey, budget.maxAttemptsPerPattern) ||
            policy.hardBlockedSubsystems.includes(candidate.subsystemId);

        const goal: AutonomousGoal = {
            goalId: uuidv4(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            source: candidate.source,
            subsystemId: candidate.subsystemId,
            title: candidate.title,
            description: candidate.description,
            status: suppressionReason ? 'suppressed' : 'scored',
            priorityTier: tier,
            priorityScore: score,
            autonomyEligible: false, // Set by AutonomyPolicyGate
            attemptCount: 0,
            humanReviewRequired,
            sourceContext: candidate.sourceContext,
            dedupFingerprint: candidate.dedupFingerprint,
        };

        return goal;
    }

    private _computeScore(
        candidate: GoalCandidate,
        patternKey: string,
        policy: AutonomyPolicy,
    ): GoalPriorityScore {
        // Severity weight
        const severityWeight = SOURCE_SEVERITY_WEIGHTS[candidate.source] ?? 10;

        // Recurrence weight — from learning registry failure count
        const learning = this.learningRegistry.get(patternKey);
        const failureCount = learning ? learning.failureCount + learning.rollbackCount : 0;
        const recurrenceWeight = Math.min(20, failureCount * 4);

        // Subsystem importance
        let subsystemImportanceWeight: number;
        if (HIGH_IMPORTANCE_SUBSYSTEMS.has(candidate.subsystemId)) {
            subsystemImportanceWeight = 15;
        } else if (MEDIUM_IMPORTANCE_SUBSYSTEMS.has(candidate.subsystemId)) {
            subsystemImportanceWeight = 8;
        } else {
            subsystemImportanceWeight = 4;
        }

        // Confidence weight — from learning registry modifier
        // Phase 5 enhancement: when profile registry is available, blend with subsystem success rate
        const confidence = this.learningRegistry.getConfidenceModifier(patternKey);
        let blendedConfidence: number;
        if (this._profileRegistry) {
            const profile = this._profileRegistry.get(candidate.subsystemId);
            // 60% per-pattern confidence + 40% empirical subsystem success rate
            // When no history exists (totalAttempts=0), successRate=0 but confidence=0.7
            // so the blend remains reasonable (0.7*0.6 + 0*0.4 = 0.42 → same baseline)
            const subsystemRate = profile.totalAttempts > 0 ? profile.successRate : confidence;
            blendedConfidence = confidence * 0.6 + subsystemRate * 0.4;
        } else {
            blendedConfidence = confidence;
        }
        const confidenceWeight = Math.round(blendedConfidence * 15);

        // Governance likelihood — lower if in hard-blocked list
        const governanceLikelihoodWeight = policy.hardBlockedSubsystems.includes(candidate.subsystemId)
            ? 0
            : 8;

        // Rollback confidence — moderate baseline (no specific signal yet)
        const rollbackConfidenceWeight = 6;

        // Execution cost penalty — higher for 'user_seeded' which are typically larger
        const executionCostPenalty = candidate.source === 'user_seeded' ? 3 : 1;

        // Protected penalty
        const protectedPenalty = policy.hardBlockedSubsystems.includes(candidate.subsystemId)
            ? 20
            : 0;

        const total = Math.max(0,
            severityWeight
            + recurrenceWeight
            + subsystemImportanceWeight
            + confidenceWeight
            + governanceLikelihoodWeight
            + rollbackConfidenceWeight
            - executionCostPenalty
            - protectedPenalty,
        );

        return {
            total,
            severityWeight,
            recurrenceWeight,
            subsystemImportanceWeight,
            confidenceWeight,
            governanceLikelihoodWeight,
            rollbackConfidenceWeight,
            executionCostPenalty,
            protectedPenalty,
        };
    }

    private _computeTier(total: number, suppressed: boolean): GoalPriorityTier {
        if (suppressed) return 'suppressed';
        if (total >= 80) return 'critical';
        if (total >= 60) return 'high';
        if (total >= 40) return 'medium';
        if (total >= 20) return 'low';
        return 'suppressed';
    }

    private _checkSuppression(
        candidate: GoalCandidate,
        policy: AutonomyPolicy,
    ): string | null {
        // Duplicate — already being handled
        if (candidate.isDuplicate) {
            return 'duplicate_active_goal';
        }

        // In cooldown
        if (this.cooldownRegistry.isInCooldown(candidate.subsystemId, candidate.dedupFingerprint)) {
            return 'in_cooldown';
        }

        // Exceeded max attempts — needs human
        if (this.learningRegistry.shouldRouteToHumanReview(
            candidate.dedupFingerprint, policy.budget.maxAttemptsPerPattern,
        )) {
            return 'exceeded_max_attempts_human_review';
        }

        // Global budget exhausted
        if (this.budgetManager.isExhausted(policy.budget)) {
            return 'budget_exhausted';
        }

        return null;
    }
}
