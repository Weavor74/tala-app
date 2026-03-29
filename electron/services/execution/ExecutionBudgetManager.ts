/**
 * ExecutionBudgetManager.ts — Phase 3 P3J
 *
 * Enforces per-run execution budgets.
 *
 * Design mirrors ReflectionBudgetManager (Phase 2 P2B.5):
 * - Each run receives a budget at creation time.
 * - Any limit exhaustion aborts the run.
 * - Dimensions with limit = 0 are disabled and never trigger exhaustion.
 */

import type {
    ExecutionBudget,
    ExecutionBudgetUsage,
} from '../../../shared/executionTypes';
import { telemetry } from '../TelemetryService';

// ─── Default budgets ──────────────────────────────────────────────────────────

const DEFAULT_BUDGET: ExecutionBudget = {
    maxPatchUnits: 10,
    maxFileMutations: 5,
    maxVerificationSteps: 20,
    maxVerificationMs: 120_000,
    maxRollbackSteps: 10,
    maxApplyMs: 30_000,
    maxDashboardUpdates: 8,
};

const EMPTY_USAGE = (): ExecutionBudgetUsage => ({
    patchUnitsUsed: 0,
    fileMutationsUsed: 0,
    verificationStepsUsed: 0,
    verificationMsUsed: 0,
    rollbackStepsUsed: 0,
    applyMsUsed: 0,
    dashboardUpdatesUsed: 0,
});

// ─── Budget check result ──────────────────────────────────────────────────────

export interface ExecBudgetCheckResult {
    allowed: boolean;
    blockedBy?: keyof ExecutionBudgetUsage;
    remaining: Partial<Record<keyof ExecutionBudgetUsage, number>>;
}

// ─── ExecutionBudgetManager ───────────────────────────────────────────────────

export class ExecutionBudgetManager {
    private usageMap: Map<string, ExecutionBudgetUsage> = new Map();

    createBudget(): ExecutionBudget {
        return { ...DEFAULT_BUDGET };
    }

    initRun(executionId: string): void {
        this.usageMap.set(executionId, EMPTY_USAGE());
    }

    /**
     * Attempts to consume `amount` units of the given dimension.
     *
     * Returns ExecBudgetCheckResult — caller MUST check `allowed`.
     * If allowed, the usage counter is incremented atomically.
     */
    consume(
        executionId: string,
        field: keyof ExecutionBudgetUsage,
        budget: ExecutionBudget,
        amount = 1,
    ): ExecBudgetCheckResult {
        const usage = this._ensureUsage(executionId);
        const limitKey = this._usageToLimit(field);
        const limit = budget[limitKey];
        const current = usage[field];

        // Disabled dimension (limit = 0) — always allowed
        if (limit === 0) {
            return { allowed: true, remaining: this._computeRemaining(usage, budget) };
        }

        if (current + amount > limit) {
            telemetry.operational(
                'execution',
                `execution.budget.exceeded.${field}`,
                'warn',
                'ExecutionBudgetManager',
                `Run ${executionId}: budget exceeded for ${field} (limit=${limit}, current=${current})`,
            );
            return {
                allowed: false,
                blockedBy: field,
                remaining: this._computeRemaining(usage, budget),
            };
        }

        (usage as any)[field] = current + amount;

        return {
            allowed: true,
            remaining: this._computeRemaining(usage, budget),
        };
    }

    /**
     * Returns true when at least one non-zero-limit dimension is fully consumed.
     * Matches the ReflectionBudgetManager pattern:
     *   (limit > 0 && usage >= limit)
     */
    isExhausted(executionId: string, budget: ExecutionBudget): boolean {
        const usage = this._ensureUsage(executionId);
        return (
            (budget.maxPatchUnits > 0 && usage.patchUnitsUsed >= budget.maxPatchUnits) ||
            (budget.maxFileMutations > 0 && usage.fileMutationsUsed >= budget.maxFileMutations) ||
            (budget.maxVerificationSteps > 0 && usage.verificationStepsUsed >= budget.maxVerificationSteps) ||
            (budget.maxRollbackSteps > 0 && usage.rollbackStepsUsed >= budget.maxRollbackSteps) ||
            (budget.maxDashboardUpdates > 0 && usage.dashboardUpdatesUsed >= budget.maxDashboardUpdates)
        );
    }

    getUsage(executionId: string): ExecutionBudgetUsage {
        return { ...this._ensureUsage(executionId) };
    }

    clearRun(executionId: string): void {
        this.usageMap.delete(executionId);
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _ensureUsage(executionId: string): ExecutionBudgetUsage {
        if (!this.usageMap.has(executionId)) {
            this.usageMap.set(executionId, EMPTY_USAGE());
        }
        return this.usageMap.get(executionId)!;
    }

    private _usageToLimit(field: keyof ExecutionBudgetUsage): keyof ExecutionBudget {
        const map: Record<keyof ExecutionBudgetUsage, keyof ExecutionBudget> = {
            patchUnitsUsed: 'maxPatchUnits',
            fileMutationsUsed: 'maxFileMutations',
            verificationStepsUsed: 'maxVerificationSteps',
            verificationMsUsed: 'maxVerificationMs',
            rollbackStepsUsed: 'maxRollbackSteps',
            applyMsUsed: 'maxApplyMs',
            dashboardUpdatesUsed: 'maxDashboardUpdates',
        };
        return map[field];
    }

    private _computeRemaining(
        usage: ExecutionBudgetUsage,
        budget: ExecutionBudget,
    ): Partial<Record<keyof ExecutionBudgetUsage, number>> {
        return {
            patchUnitsUsed: Math.max(0, budget.maxPatchUnits - usage.patchUnitsUsed),
            fileMutationsUsed: Math.max(0, budget.maxFileMutations - usage.fileMutationsUsed),
            verificationStepsUsed: Math.max(0, budget.maxVerificationSteps - usage.verificationStepsUsed),
            verificationMsUsed: Math.max(0, budget.maxVerificationMs - usage.verificationMsUsed),
            rollbackStepsUsed: Math.max(0, budget.maxRollbackSteps - usage.rollbackStepsUsed),
            applyMsUsed: Math.max(0, budget.maxApplyMs - usage.applyMsUsed),
            dashboardUpdatesUsed: Math.max(0, budget.maxDashboardUpdates - usage.dashboardUpdatesUsed),
        };
    }
}
