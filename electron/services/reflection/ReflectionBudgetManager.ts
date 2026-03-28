/**
 * ReflectionBudgetManager.ts — Phase 2 Budget System
 *
 * Enforces per-run resource budgets for the safe change planning pipeline.
 *
 * Design principle: DETERMINISTIC FIRST. MODEL LAST.
 *
 * Each planning run receives a strict budget at creation time:
 *   - maxModelCalls       (default: 1)
 *   - maxSelfModelQueries (default: 6)
 *   - maxAnalysisPasses   (default: 1)
 *   - maxRetriesPerStage  (default: 1)
 *   - maxDashboardUpdates (default: 5 — one per milestone)
 *
 * If any budget is exceeded the planner stops immediately, marks the run
 * `budget_exhausted`, and persists partial results.
 */

import type {
    PlanRunBudget,
    BudgetUsage,
    BudgetCheckResult,
    PlanningMode,
} from '../../../shared/reflectionPlanTypes';
import { telemetry } from '../TelemetryService';

// ─── Default budgets by planning mode ─────────────────────────────────────────

const DEFAULT_BUDGETS: Record<PlanningMode, PlanRunBudget> = {
    light: {
        maxModelCalls: 0,
        maxSelfModelQueries: 4,
        maxAnalysisPasses: 1,
        maxRetriesPerStage: 0,
        maxDashboardUpdates: 5,
    },
    standard: {
        maxModelCalls: 1,
        maxSelfModelQueries: 6,
        maxAnalysisPasses: 1,
        maxRetriesPerStage: 1,
        maxDashboardUpdates: 5,
    },
    deep: {
        maxModelCalls: 2,
        maxSelfModelQueries: 8,
        maxAnalysisPasses: 2,
        maxRetriesPerStage: 1,
        maxDashboardUpdates: 5,
    },
};

const EMPTY_USAGE = (): BudgetUsage => ({
    modelCallsUsed: 0,
    selfModelQueriesUsed: 0,
    analysisPassesUsed: 0,
    retriesUsed: 0,
    dashboardUpdatesUsed: 0,
});

// ─── Budget Manager ────────────────────────────────────────────────────────────

export class ReflectionBudgetManager {
    /** Per-run usage tracking keyed by runId. */
    private usageMap: Map<string, BudgetUsage> = new Map();

    // ── Public API ──────────────────────────────────────────────────────────────

    /** Returns the default budget for the given planning mode. */
    createBudget(mode: PlanningMode): PlanRunBudget {
        return { ...DEFAULT_BUDGETS[mode] };
    }

    /**
     * Initialises a fresh usage record for a new run.
     * Must be called before any trackUsage calls for this run.
     */
    initRun(runId: string): void {
        this.usageMap.set(runId, EMPTY_USAGE());
    }

    /**
     * Attempts to consume one unit of the given resource.
     *
     * Returns a BudgetCheckResult indicating whether the operation is
     * permitted.  The caller MUST check `allowed` before proceeding.
     * If allowed, the usage counter is incremented atomically.
     *
     * @param runId     The planning run consuming the resource.
     * @param field     The budget dimension to consume.
     * @param budget    The budget limits for this run.
     */
    consume(
        runId: string,
        field: keyof BudgetUsage,
        budget: PlanRunBudget,
    ): BudgetCheckResult {
        const usage = this._ensureUsage(runId);
        const limitKey = this._usageToLimit(field);
        const limit = budget[limitKey];
        const current = usage[field];

        if (current >= limit) {
            telemetry.operational(
                'planning',
                `planning.budget.exceeded.${field}`,
                'warn',
                'ReflectionBudgetManager',
                `Run ${runId}: budget exceeded for ${field} (limit=${limit})`,
            );
            return {
                allowed: false,
                blockedBy: field,
                remaining: this._computeRemaining(usage, budget),
            };
        }

        // Atomically increment
        (usage as any)[field] = current + 1;

        return {
            allowed: true,
            remaining: this._computeRemaining(usage, budget),
        };
    }

    /**
     * Returns true when at least one non-zero-limit budget dimension has
     * been fully consumed.  Dimensions with limit = 0 are "disabled"
     * (not consumable) and are never counted as exhausted.
     */
    isExhausted(runId: string, budget: PlanRunBudget): boolean {
        const usage = this._ensureUsage(runId);
        return (
            (budget.maxModelCalls > 0 && usage.modelCallsUsed >= budget.maxModelCalls) ||
            (budget.maxSelfModelQueries > 0 && usage.selfModelQueriesUsed >= budget.maxSelfModelQueries) ||
            (budget.maxAnalysisPasses > 0 && usage.analysisPassesUsed >= budget.maxAnalysisPasses) ||
            (budget.maxRetriesPerStage > 0 && usage.retriesUsed >= budget.maxRetriesPerStage) ||
            (budget.maxDashboardUpdates > 0 && usage.dashboardUpdatesUsed >= budget.maxDashboardUpdates)
        );
    }

    /** Returns a read-only snapshot of usage for the given run. */
    getUsage(runId: string): BudgetUsage {
        return { ...this._ensureUsage(runId) };
    }

    /**
     * Releases usage tracking memory for a completed or failed run.
     * Call this after persisting the final run record.
     */
    clearRun(runId: string): void {
        this.usageMap.delete(runId);
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _ensureUsage(runId: string): BudgetUsage {
        if (!this.usageMap.has(runId)) {
            this.usageMap.set(runId, EMPTY_USAGE());
        }
        return this.usageMap.get(runId)!;
    }

    private _usageToLimit(field: keyof BudgetUsage): keyof PlanRunBudget {
        const map: Record<keyof BudgetUsage, keyof PlanRunBudget> = {
            modelCallsUsed: 'maxModelCalls',
            selfModelQueriesUsed: 'maxSelfModelQueries',
            analysisPassesUsed: 'maxAnalysisPasses',
            retriesUsed: 'maxRetriesPerStage',
            dashboardUpdatesUsed: 'maxDashboardUpdates',
        };
        return map[field];
    }

    private _computeRemaining(
        usage: BudgetUsage,
        budget: PlanRunBudget,
    ): Partial<Record<keyof BudgetUsage, number>> {
        return {
            modelCallsUsed: Math.max(0, budget.maxModelCalls - usage.modelCallsUsed),
            selfModelQueriesUsed: Math.max(0, budget.maxSelfModelQueries - usage.selfModelQueriesUsed),
            analysisPassesUsed: Math.max(0, budget.maxAnalysisPasses - usage.analysisPassesUsed),
            retriesUsed: Math.max(0, budget.maxRetriesPerStage - usage.retriesUsed),
            dashboardUpdatesUsed: Math.max(0, budget.maxDashboardUpdates - usage.dashboardUpdatesUsed),
        };
    }
}
