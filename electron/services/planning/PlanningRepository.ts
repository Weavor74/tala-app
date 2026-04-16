/**
 * PlanningRepository.ts — In-memory storage seam for the Planning subsystem
 *
 * Provides a clean, typed repository abstraction for PlanGoal and ExecutionPlan
 * records.  The current implementation is in-memory; the seam is designed so it
 * can be replaced with a canonical PostgreSQL-backed repository when persistence
 * is required.
 *
 * Design invariants
 * ─────────────────
 * 1. Canonical authority — this repository is the authority for planning state
 *    within the current process lifetime.  Callers must not maintain their own
 *    duplicate maps.
 * 2. No side effects — methods only read/write the internal store; no telemetry,
 *    no I/O, no external calls.
 * 3. Deterministic — given the same sequence of mutations, the resulting state
 *    is deterministic and predictable.
 * 4. Seam-ready — every method has a 1:1 equivalent that a DB-backed repository
 *    would implement.  No ad hoc access patterns escape this class.
 * 5. Not a cache — this repository IS the source of truth for goals and plans
 *    within the planning subsystem.  Nothing in this subsystem bypasses it.
 */

import type { PlanGoal, ExecutionPlan } from '../../../shared/planning/PlanningTypes';

// ---------------------------------------------------------------------------
// PlanningRepository
// ---------------------------------------------------------------------------

export class PlanningRepository {
    private readonly _goals = new Map<string, PlanGoal>();
    private readonly _plans = new Map<string, ExecutionPlan>();

    // ── Goals ────────────────────────────────────────────────────────────────

    /** Stores a new goal.  Overwrites if a goal with the same id already exists. */
    saveGoal(goal: PlanGoal): void {
        this._goals.set(goal.id, { ...goal });
    }

    /** Returns the goal with the given id, or undefined. */
    getGoal(id: string): PlanGoal | undefined {
        const g = this._goals.get(id);
        return g ? { ...g } : undefined;
    }

    /** Returns all stored goals as a shallow-copied array. */
    listGoals(): PlanGoal[] {
        return Array.from(this._goals.values()).map(g => ({ ...g }));
    }

    /** Returns true if a goal with the given id exists. */
    hasGoal(id: string): boolean {
        return this._goals.has(id);
    }

    // ── Plans ────────────────────────────────────────────────────────────────

    /** Stores a new plan.  Overwrites if a plan with the same id already exists. */
    savePlan(plan: ExecutionPlan): void {
        this._plans.set(plan.id, { ...plan });
    }

    /** Returns the plan with the given id, or undefined. */
    getPlan(id: string): ExecutionPlan | undefined {
        const p = this._plans.get(id);
        return p ? { ...p } : undefined;
    }

    /** Returns all plans for the given goal id, ordered by version ascending. */
    listPlansForGoal(goalId: string): ExecutionPlan[] {
        return Array.from(this._plans.values())
            .filter(p => p.goalId === goalId)
            .sort((a, b) => a.version - b.version)
            .map(p => ({ ...p }));
    }

    /** Returns true if a plan with the given id exists. */
    hasPlan(id: string): boolean {
        return this._plans.has(id);
    }

    // ── Diagnostics ──────────────────────────────────────────────────────────

    /** Returns the total number of stored goals. */
    get goalCount(): number {
        return this._goals.size;
    }

    /** Returns the total number of stored plans. */
    get planCount(): number {
        return this._plans.size;
    }

    /**
     * Clears all stored goals and plans.
     * Intended for use in tests only.
     */
    _resetForTesting(): void {
        this._goals.clear();
        this._plans.clear();
    }
}
