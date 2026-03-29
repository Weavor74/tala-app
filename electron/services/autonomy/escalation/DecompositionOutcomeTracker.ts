/**
 * DecompositionOutcomeTracker.ts — Phase 5.1 P5.1F
 *
 * In-memory tracker for decomposition plan outcomes.
 *
 * Records decomposition results and enforces the post-failure cooldown.
 * Provides KPI data for the escalation dashboard.
 *
 * Cooldown invariant:
 *   After a decomposition plan fully fails, a cooldown is applied per-subsystem.
 *   isCooldownActive(subsystemId) returns true during this window.
 *   Cooldown prevents repeated decomposition spam.
 *
 * Cap:
 *   In-memory records are capped at MAX_RESULTS.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    DecompositionPlan,
    DecompositionResult,
    DecompositionStepResult,
    DecompositionStep,
} from '../../../../shared/escalationTypes';

// ─── Cap ──────────────────────────────────────────────────────────────────────

const MAX_RESULTS = 200;

// ─── In-progress plan tracking ────────────────────────────────────────────────

interface InProgressDecomposition {
    plan: DecompositionPlan;
    subsystemId: string;
    startedAt: string;
    stepResults: DecompositionStepResult[];
}

// ─── DecompositionOutcomeTracker ──────────────────────────────────────────────

export class DecompositionOutcomeTracker {
    private readonly results: DecompositionResult[] = [];
    private readonly inProgress = new Map<string, InProgressDecomposition>();
    // subsystemId → cooldown expiry timestamp (ms)
    private readonly cooldowns = new Map<string, number>();

    // ── Plan lifecycle ─────────────────────────────────────────────────────────

    /**
     * Records the start of a decomposition plan execution.
     *
     * @param plan        The decomposition plan being executed.
     * @param subsystemId The subsystem ID this plan belongs to.
     */
    startPlan(plan: DecompositionPlan, subsystemId: string): void {
        this.inProgress.set(plan.planId, {
            plan,
            subsystemId,
            startedAt: new Date().toISOString(),
            stepResults: [],
        });
    }

    /**
     * Records the result of a single decomposition step.
     * Must be called after startPlan() for this planId.
     *
     * @param planId       The plan this step belongs to.
     * @param step         The step from the plan.
     * @param outcome      Step outcome.
     * @param executionRunId  Optional execution run ID.
     * @param failureReason   Optional failure reason.
     */
    recordStep(
        planId: string,
        step: DecompositionStep,
        outcome: DecompositionStepResult['outcome'],
        executionRunId?: string,
        failureReason?: string,
    ): void {
        const entry = this.inProgress.get(planId);
        if (!entry) return;

        entry.stepResults.push({
            stepId: step.stepId,
            stepIndex: step.stepIndex,
            outcome,
            executionRunId,
            failureReason,
            completedAt: new Date().toISOString(),
        });
    }

    /**
     * Finalizes a decomposition plan and records the overall result.
     * Applies cooldown when the plan fully fails.
     *
     * @param planId             The plan to finalize.
     * @param cooldownMs         Cooldown duration to apply on full failure.
     * @returns The recorded DecompositionResult, or null if planId not found.
     */
    finalizePlan(planId: string, cooldownMs: number): DecompositionResult | null {
        const entry = this.inProgress.get(planId);
        if (!entry) return null;

        this.inProgress.delete(planId);

        const { plan, subsystemId, stepResults } = entry;
        const succeeded = stepResults.filter(r => r.outcome === 'succeeded').length;
        const failed = stepResults.filter(r => r.outcome === 'failed' || r.outcome === 'rolled_back').length;

        let overallOutcome: DecompositionResult['overallOutcome'];
        if (succeeded === plan.totalSteps) {
            overallOutcome = 'succeeded';
        } else if (succeeded > 0) {
            overallOutcome = 'partial';
        } else {
            overallOutcome = 'failed';
        }

        // Apply cooldown on full failure
        if (overallOutcome === 'failed') {
            this.cooldowns.set(subsystemId, Date.now() + cooldownMs);
        }

        const result: DecompositionResult = {
            planId,
            goalId: plan.goalId,
            completedAt: new Date().toISOString(),
            overallOutcome,
            stepsTotal: plan.totalSteps,
            stepsSucceeded: succeeded,
            stepsFailed: failed,
            stepResults,
            rationale:
                `Decomposition ${overallOutcome}: ${succeeded}/${plan.totalSteps} steps succeeded.` +
                (overallOutcome === 'failed'
                    ? ` Cooldown of ${Math.round(cooldownMs / 60000)}min applied for subsystem '${subsystemId}'.`
                    : ''),
        };

        this.results.unshift(result);
        if (this.results.length > MAX_RESULTS) {
            this.results.length = MAX_RESULTS;
        }

        return result;
    }

    // ── Cooldown check ─────────────────────────────────────────────────────────

    /**
     * Returns true if a decomposition cooldown is active for the given subsystem.
     */
    isCooldownActive(subsystemId: string): boolean {
        const expiry = this.cooldowns.get(subsystemId);
        if (expiry === undefined) return false;
        if (Date.now() >= expiry) {
            this.cooldowns.delete(subsystemId);
            return false;
        }
        return true;
    }

    // ── Query ──────────────────────────────────────────────────────────────────

    /**
     * Returns recent decomposition results, newest first.
     * @param limit Max results to return (default: 20).
     */
    getRecent(limit = 20): DecompositionResult[] {
        return this.results.slice(0, limit);
    }

    /**
     * Returns all results for a specific goal, newest first.
     */
    getForGoal(goalId: string): DecompositionResult[] {
        return this.results.filter(r => r.goalId === goalId);
    }

    /**
     * Returns the number of active (in-progress) decompositions.
     */
    getActiveCount(): number {
        return this.inProgress.size;
    }

    /**
     * Returns KPI summary counts.
     */
    getKpis(): {
        total: number;
        succeeded: number;
        partial: number;
        failed: number;
    } {
        const total = this.results.length;
        const succeeded = this.results.filter(r => r.overallOutcome === 'succeeded').length;
        const partial = this.results.filter(r => r.overallOutcome === 'partial').length;
        const failed = this.results.filter(r => r.overallOutcome === 'failed').length;
        return { total, succeeded, partial, failed };
    }

    /**
     * Clears all state. Used in tests only.
     */
    clearAll(): void {
        this.results.length = 0;
        this.inProgress.clear();
        this.cooldowns.clear();
    }
}
