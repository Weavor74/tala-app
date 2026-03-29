/**
 * AutonomyPolicyGate.ts — Phase 4 P4D
 *
 * Deterministic gate that evaluates whether a scored AutonomousGoal
 * may proceed autonomously through the planning/governance/execution pipeline.
 *
 * This gate is SEPARATE from governance (Phase 3.5).
 * It determines whether Tala may even attempt the pipeline autonomously.
 * Governance is the next gate AFTER this one.
 *
 * 11 checks evaluated in order (first failure blocks):
 *
 *   1. global_autonomy_disabled        — globalAutonomyEnabled = false
 *   2. policy_category_disabled        — category policy autonomyEnabled = false
 *   3. protected_subsystem             — hardBlockedSubsystems list
 *   4. recursion_guard                 — active run is already running (concurrent cycle)
 *   5. active_run_exists               — active run for this subsystem already
 *   6. global_run_limit_reached        — global concurrent run limit exceeded
 *   7. in_cooldown                     — within failure/block cooldown window
 *   8. prior_failure_memory            — pattern has exceeded maxAttemptsPerPattern
 *   9. confidence_below_threshold      — confidence modifier too low
 *  10. budget_exhausted                — autonomy run budget for period used up
 *  11. (pass) → permitted
 *
 * All checks are deterministic: same input → same result.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    AutonomousGoal,
    AutonomyPolicyDecision,
    AutonomyBlockReason,
    AutonomyPolicy,
    AutonomyCategoryPolicy,
} from '../../../shared/autonomyTypes';
import type { AutonomyBudgetManager } from './AutonomyBudgetManager';
import type { AutonomyCooldownRegistry } from './AutonomyCooldownRegistry';
import type { OutcomeLearningRegistry } from './OutcomeLearningRegistry';
import { telemetry } from '../TelemetryService';

// ─── Confidence threshold ─────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 0.2; // Below 20% confidence → block

// ─── AutonomyPolicyGate ───────────────────────────────────────────────────────

export class AutonomyPolicyGate {
    constructor(
        private readonly budgetManager: AutonomyBudgetManager,
        private readonly cooldownRegistry: AutonomyCooldownRegistry,
        private readonly learningRegistry: OutcomeLearningRegistry,
    ) {}

    /**
     * Evaluates whether a goal may proceed autonomously.
     *
     * Returns an AutonomyPolicyDecision with `permitted: true` or
     * `permitted: false` with an explicit `blockReason`.
     *
     * Deterministic: same goal + same policy state → same result.
     */
    evaluate(goal: AutonomousGoal, policy: AutonomyPolicy): AutonomyPolicyDecision {
        const categoryPolicy = this._getCategoryPolicy(goal.source, policy);

        const block = this._runChecks(goal, policy, categoryPolicy);

        const decision: AutonomyPolicyDecision = {
            decisionId: uuidv4(),
            goalId: goal.goalId,
            evaluatedAt: new Date().toISOString(),
            permitted: block === null,
            blockReason: block?.reason,
            resolvedCategoryPolicy: categoryPolicy?.categoryId ?? 'none',
            cooldownExpiresAt: block?.cooldownExpiresAt,
            rationale: block ? block.rationale : 'All autonomy policy checks passed.',
            requiresHumanReview: block ? this._isHumanReviewBlock(block.reason) : false,
        };

        telemetry.operational(
            'autonomy',
            decision.permitted ? 'autonomy_goal_selected' : 'autonomy_goal_blocked',
            'info',
            'AutonomyPolicyGate',
            `Goal ${goal.goalId} (${goal.subsystemId}): ${decision.permitted ? 'permitted' : `blocked — ${decision.blockReason}`}`,
        );

        return decision;
    }

    // ── Check pipeline ──────────────────────────────────────────────────────────

    private _runChecks(
        goal: AutonomousGoal,
        policy: AutonomyPolicy,
        categoryPolicy: AutonomyCategoryPolicy | null,
    ): { reason: AutonomyBlockReason; rationale: string; cooldownExpiresAt?: string } | null {
        // Check 1: global autonomy disabled
        if (!policy.globalAutonomyEnabled) {
            return {
                reason: 'global_autonomy_disabled',
                rationale: 'Autonomy is globally disabled. Enable via the Reflection Dashboard toggle.',
            };
        }

        // Check 2: category policy disabled
        if (!categoryPolicy || !categoryPolicy.autonomyEnabled) {
            return {
                reason: 'policy_category_disabled',
                rationale: `Autonomous action is not enabled for goal source category '${goal.source}'. Enable via autonomy policy settings.`,
            };
        }

        // Check 3: hard-blocked subsystem
        if (policy.hardBlockedSubsystems.includes(goal.subsystemId)) {
            return {
                reason: 'protected_subsystem',
                rationale: `Subsystem '${goal.subsystemId}' is hard-blocked and may not be modified autonomously.`,
            };
        }

        // Check 4: protected subsystem per category policy
        if (!categoryPolicy.allowProtectedSubsystems && this._isProtectedSubsystem(goal.subsystemId)) {
            return {
                reason: 'protected_subsystem',
                rationale: `Subsystem '${goal.subsystemId}' is protected and category policy does not allow autonomous action on protected subsystems.`,
            };
        }

        // Check 5: budget exhausted — checked before concurrency to give accurate reason
        if (this.budgetManager.isExhausted(policy.budget)) {
            return {
                reason: 'budget_exhausted',
                rationale: `Autonomous run budget (${policy.budget.maxRunsPerPeriod} per ${policy.budget.periodMs / 60000}min) is exhausted for this period.`,
            };
        }

        // Check 6: active run exists for this subsystem
        if (this.budgetManager.getActiveCountForSubsystem(goal.subsystemId) > 0) {
            return {
                reason: 'active_run_exists',
                rationale: `An autonomous run is already active for subsystem '${goal.subsystemId}'.`,
            };
        }

        // Check 7: global concurrent run limit
        if (!this.budgetManager.canStartGlobal(policy.budget)) {
            return {
                reason: 'global_run_limit_reached',
                rationale: `Global concurrent autonomous run limit (${policy.budget.maxConcurrentRuns}) has been reached.`,
            };
        }

        // Check 8: subsystem in cooldown
        const cooldown = this.cooldownRegistry.getCooldownRecord(goal.subsystemId, goal.dedupFingerprint);
        if (cooldown) {
            return {
                reason: 'in_cooldown',
                rationale: `Subsystem '${goal.subsystemId}' is in cooldown until ${cooldown.expiresAt} (reason: ${cooldown.reason}).`,
                cooldownExpiresAt: cooldown.expiresAt,
            };
        }

        // Check 9: prior failure memory — exceeded maxAttemptsPerPattern
        if (this.learningRegistry.shouldRouteToHumanReview(
            goal.dedupFingerprint, policy.budget.maxAttemptsPerPattern,
        )) {
            return {
                reason: 'prior_failure_memory',
                rationale: `This goal pattern has failed ≥${policy.budget.maxAttemptsPerPattern} times. Routing to human review.`,
            };
        }

        // Check 10: confidence below threshold
        const confidence = this.learningRegistry.getConfidenceModifier(goal.dedupFingerprint);
        if (confidence < CONFIDENCE_THRESHOLD) {
            return {
                reason: 'confidence_below_threshold',
                rationale: `Confidence modifier for this pattern is ${confidence.toFixed(2)}, below threshold ${CONFIDENCE_THRESHOLD}. Too many prior failures.`,
            };
        }

        return null; // All checks passed
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────

    private _getCategoryPolicy(
        source: string,
        policy: AutonomyPolicy,
    ): AutonomyCategoryPolicy | null {
        return policy.categoryPolicies.find(cp => cp.categoryId === source) ?? null;
    }

    /**
     * Subsystems considered "protected" even if not in hardBlockedSubsystems.
     * These require explicit allowProtectedSubsystems = true in the category policy.
     */
    private _isProtectedSubsystem(subsystemId: string): boolean {
        const PROTECTED = new Set([
            'identity', 'soul', 'governance', 'security', 'auth',
            'ipc', 'preload', 'main',
        ]);
        return PROTECTED.has(subsystemId.toLowerCase());
    }

    /**
     * Determines whether a block reason should route the goal to human review
     * vs silently suppressing it until the next cycle.
     *
     * Human review = permanent routing until operator acts.
     * Silent suppress = transient; retry in next cycle.
     */
    private _isHumanReviewBlock(reason?: AutonomyBlockReason): boolean {
        if (!reason) return false;
        return reason === 'prior_failure_memory'
            || reason === 'protected_subsystem'
            || reason === 'policy_category_disabled';
    }
}
