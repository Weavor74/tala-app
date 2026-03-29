/**
 * AutonomyBudgetManager.ts — Phase 4 P4H
 *
 * Enforces per-period and per-subsystem autonomous run budgets.
 *
 * Design mirrors ReflectionBudgetManager (Phase 2 P2B.5) and
 * ExecutionBudgetManager (Phase 3 P3J):
 * - Dimensions with limit = 0 are disabled and never trigger exhaustion.
 * - Uses (limit > 0 && usage >= limit) pattern consistently.
 * - In-memory only; no persistence needed — budget resets on process restart.
 */

import type { AutonomyBudget } from '../../../shared/autonomyTypes';
import { telemetry } from '../TelemetryService';

// ─── Run slot ─────────────────────────────────────────────────────────────────

interface RunSlot {
    runId: string;
    subsystemId: string;
    startedAt: number; // epoch ms
}

// ─── AutonomyBudgetManager ────────────────────────────────────────────────────

export class AutonomyBudgetManager {
    /** All run slots within the current period. */
    private slots: RunSlot[] = [];
    /** Currently active (incomplete) run IDs per subsystem. */
    private activeBySubsystem: Map<string, Set<string>> = new Map();
    /** All currently active run IDs (global). */
    private activeGlobal: Set<string> = new Set();

    // ── Budget checks ───────────────────────────────────────────────────────────

    /**
     * Returns true if the per-period run budget is exhausted.
     * Follows (limit > 0 && usage >= limit) pattern.
     */
    isExhausted(budget: AutonomyBudget): boolean {
        const used = this.getUsedThisPeriod(budget);
        return budget.maxRunsPerPeriod > 0 && used >= budget.maxRunsPerPeriod;
    }

    /**
     * Returns true if a new global concurrent run can be started.
     */
    canStartGlobal(budget: AutonomyBudget): boolean {
        if (this.isExhausted(budget)) return false;
        return budget.maxConcurrentRuns === 0 ||
            this.activeGlobal.size < budget.maxConcurrentRuns;
    }

    /**
     * Returns true if a new run can be started for the given subsystem.
     */
    canStartForSubsystem(subsystemId: string, budget: AutonomyBudget): boolean {
        if (!this.canStartGlobal(budget)) return false;
        const active = this.activeBySubsystem.get(subsystemId);
        const count = active ? active.size : 0;
        return budget.maxConcurrentRunsPerSubsystem === 0 ||
            count < budget.maxConcurrentRunsPerSubsystem;
    }

    /**
     * Records the start of an autonomous run.
     * Must be called before the run begins.
     */
    recordRunStart(runId: string, subsystemId: string): void {
        this.slots.push({ runId, subsystemId, startedAt: Date.now() });
        this.activeGlobal.add(runId);

        if (!this.activeBySubsystem.has(subsystemId)) {
            this.activeBySubsystem.set(subsystemId, new Set());
        }
        this.activeBySubsystem.get(subsystemId)!.add(runId);

        telemetry.operational(
            'autonomy',
            'operational',
            'debug',
            'AutonomyBudgetManager',
            `Run ${runId} started for subsystem '${subsystemId}'. Active global: ${this.activeGlobal.size}`,
        );
    }

    /**
     * Records the completion (success or failure) of an autonomous run.
     * Must be called in a finally block to guarantee the slot is released.
     */
    recordRunEnd(runId: string): void {
        this.activeGlobal.delete(runId);
        for (const [, set] of this.activeBySubsystem) {
            set.delete(runId);
        }
        telemetry.operational(
            'autonomy',
            'operational',
            'debug',
            'AutonomyBudgetManager',
            `Run ${runId} completed. Active global: ${this.activeGlobal.size}`,
        );
    }

    /**
     * Returns the number of runs started within the current rolling period.
     */
    getUsedThisPeriod(budget: AutonomyBudget): number {
        const cutoff = Date.now() - budget.periodMs;
        // Prune stale slots (outside window) lazily
        this.slots = this.slots.filter(s => s.startedAt > cutoff);
        return this.slots.length;
    }

    /**
     * Returns active run count for a specific subsystem.
     */
    getActiveCountForSubsystem(subsystemId: string): number {
        return this.activeBySubsystem.get(subsystemId)?.size ?? 0;
    }

    /**
     * Returns global active run count.
     */
    getActiveGlobalCount(): number {
        return this.activeGlobal.size;
    }
}
