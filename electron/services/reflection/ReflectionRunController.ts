/**
 * ReflectionRunController.ts — Phase 2 P2B.5: Budget + Run Control
 *
 * Provides a consolidated, clean interface for managing the lifecycle of
 * reflection planning runs and their resource budgets.
 *
 * This controller owns:
 *   - Gate checks (dedup, cooldown, active-run lock) — via PlanRunRegistry
 *   - Budget initialisation and tracking — via ReflectionBudgetManager
 *   - Run lifecycle (pending → running → completed/failed/budget_exhausted)
 *   - Atomic start: gate-check + lock + budget-init in one call
 *   - Completion: persist final state, release lock, impose cooldown
 *
 * Design principle: all gate checks are synchronous and deterministic.
 * No model calls, no file I/O in this service.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    PlanRun,
    PlanRunStatus,
    PlanRunBudget,
    BudgetUsage,
    BudgetCheckResult,
    PlanTriggerInput,
    PlanningMode,
    PlanRunMilestone,
} from '../../../shared/reflectionPlanTypes';
import { ReflectionBudgetManager } from './ReflectionBudgetManager';
import { PlanRunRegistry } from './PlanRunRegistry';
import { telemetry } from '../TelemetryService';

// ─── Gate Check Result ────────────────────────────────────────────────────────

/**
 * Result of a canStart() pre-flight gate check.
 */
export interface RunGateCheckResult {
    /** True if a new run is permitted to start. */
    allowed: boolean;
    /** Reason the run was blocked, if allowed === false. */
    blockedBy?: 'active_run' | 'cooldown' | 'deduped';
    /** The existing run ID if blocked by active_run or deduped. */
    existingRunId?: string;
    /** Status of the existing run if blocked. */
    existingStatus?: PlanRunStatus;
    /** Human-readable explanation. */
    message: string;
}

// ─── Run Start Result ─────────────────────────────────────────────────────────

/**
 * Result of a start() call — includes the new run record and budget.
 */
export interface RunStartResult {
    run: PlanRun;
    budget: PlanRunBudget;
}

// ─── ReflectionRunController ──────────────────────────────────────────────────

export class ReflectionRunController {
    constructor(
        private readonly registry: PlanRunRegistry,
        private readonly budgetManager: ReflectionBudgetManager,
    ) {}

    // ── Gate checks ─────────────────────────────────────────────────────────────

    /**
     * Checks all gates for a trigger without side effects.
     *
     * Call this before start() to get a human-readable explanation of why
     * a run would or would not be allowed.  Does NOT modify any state.
     *
     * Critical severity and manual triggers bypass dedup/cooldown/lock guards.
     */
    canStart(trigger: PlanTriggerInput): RunGateCheckResult {
        const bypassGates = trigger.severity === 'critical' || trigger.isManual === true;

        if (!bypassGates) {
            // Check active-run lock first — most specific guard for this subsystem.
            if (this.registry.isSubsystemLocked(trigger.subsystemId)) {
                const active = this.registry.getActiveRun(trigger.subsystemId);
                return {
                    allowed: false,
                    blockedBy: 'active_run',
                    existingRunId: active?.runId,
                    existingStatus: active?.status,
                    message: `Subsystem '${trigger.subsystemId}' already has an active run`,
                };
            }

            // Check dedup — matches any active or recent run with the same fingerprint.
            const fp = this.registry.computeFingerprint(trigger);
            const dedup = this.registry.checkDuplicate(fp);
            if (dedup.isDuplicate) {
                return {
                    allowed: false,
                    blockedBy: 'deduped',
                    existingRunId: dedup.existingRunId,
                    existingStatus: dedup.existingRunStatus,
                    message: `Duplicate trigger — run ${dedup.existingRunId} already covers this issue`,
                };
            }

            if (this.registry.isInCooldown(trigger.subsystemId)) {
                const cd = this.registry.getCooldown(trigger.subsystemId);
                const minLeft = cd ? Math.ceil((cd.expiresAt - Date.now()) / 60_000) : 0;
                return {
                    allowed: false,
                    blockedBy: 'cooldown',
                    message: `Subsystem '${trigger.subsystemId}' is in cooldown for ${minLeft} more minute(s)`,
                };
            }
        }

        return { allowed: true, message: 'All gates passed — run is permitted' };
    }

    // ── Run lifecycle ───────────────────────────────────────────────────────────

    /**
     * Atomically checks all gates and starts a new planning run.
     *
     * This is the safe way to create a run — it prevents TOCTOU races by
     * locking the subsystem in the same operation that creates the run.
     *
     * Returns null when the run is blocked (caller should read `canStart()`
     * first to get an explanation, or catch the `RunGateCheckResult`).
     *
     * @throws never — all errors are expressed through the return value or
     *                 the PlanRun.status field.
     */
    start(
        trigger: PlanTriggerInput,
        mode?: PlanningMode,
    ): { run: PlanRun; budget: PlanRunBudget } | null {
        const gateResult = this.canStart(trigger);
        if (!gateResult.allowed) {
            telemetry.operational(
                'planning',
                `planning.run_controller.blocked.${gateResult.blockedBy}`,
                'debug',
                'ReflectionRunController',
                gateResult.message,
            );
            return null;
        }

        const runId = uuidv4();
        const planningMode = mode ?? trigger.planningMode ?? 'standard';
        const budget = this.budgetManager.createBudget(planningMode);
        this.budgetManager.initRun(runId);

        const fp = this.registry.computeFingerprint(trigger);
        const now = new Date().toISOString();

        const run: PlanRun = {
            runId,
            createdAt: now,
            updatedAt: now,
            subsystemId: trigger.subsystemId,
            trigger: fp,
            status: 'pending',
            planningMode,
            budget,
            usage: this.budgetManager.getUsage(runId),
            proposals: [],
            milestones: [],
        };

        this.registry.registerRun(run);
        this.registry.lockSubsystem(trigger.subsystemId, runId);

        telemetry.operational(
            'planning',
            'planning.run_controller.started',
            'debug',
            'ReflectionRunController',
            `Run ${runId} started for subsystem '${trigger.subsystemId}' (mode: ${planningMode})`,
        );

        return { run, budget };
    }

    /**
     * Transitions a run to the 'running' state.
     *
     * Call this once the pipeline has begun executing (after the run is
     * created with start() and the snapshot stage has been initiated).
     */
    markRunning(runId: string): void {
        this.registry.updateRun(runId, { status: 'running' });
        this._addMilestone(runId, 'run_started');
    }

    /**
     * Records that a specific milestone has been reached.
     *
     * The caller is responsible for milestone ordering.
     */
    recordMilestone(
        runId: string,
        name: PlanRunMilestone['name'],
        notes?: string,
    ): void {
        this._addMilestone(runId, name, notes);
    }

    /**
     * Completes a run successfully.
     *
     * Releases the active-run lock and imposes a cooldown on the subsystem.
     * Persists the final usage snapshot.
     */
    complete(runId: string): PlanRun | null {
        const run = this.registry.getRun(runId);
        if (!run) return null;

        const usage = this.budgetManager.getUsage(runId);
        this.registry.updateRun(runId, { status: 'completed', usage });
        this._addMilestone(runId, 'run_complete');

        this._releaseAndCooldown(run);

        telemetry.operational(
            'planning',
            'planning.run_controller.completed',
            'debug',
            'ReflectionRunController',
            `Run ${runId} completed for subsystem '${run.subsystemId}'`,
        );

        return this.registry.getRun(runId);
    }

    /**
     * Fails a run with a reason string.
     *
     * Releases the active-run lock and persists the failure reason.
     */
    fail(runId: string, reason: string): PlanRun | null {
        const run = this.registry.getRun(runId);
        if (!run) return null;

        const usage = this.budgetManager.getUsage(runId);
        this.registry.updateRun(runId, { status: 'failed', failureReason: reason, usage });
        this._addMilestone(runId, 'run_failed', reason);

        this._releaseAndCooldown(run);

        telemetry.operational(
            'planning',
            'planning.run_controller.failed',
            'warn',
            'ReflectionRunController',
            `Run ${runId} failed: ${reason}`,
        );

        return this.registry.getRun(runId);
    }

    /**
     * Marks a run as budget_exhausted and persists partial state.
     *
     * Releases the active-run lock.
     */
    exhaustBudget(runId: string): PlanRun | null {
        const run = this.registry.getRun(runId);
        if (!run) return null;

        const usage = this.budgetManager.getUsage(runId);
        this.registry.updateRun(runId, {
            status: 'budget_exhausted',
            failureReason: 'Budget exhausted before pipeline completion',
            usage,
        });
        this._addMilestone(runId, 'run_failed', 'budget_exhausted');

        this._releaseAndCooldown(run);

        telemetry.operational(
            'planning',
            'planning.run_controller.budget_exhausted',
            'warn',
            'ReflectionRunController',
            `Run ${runId} budget exhausted (subsystem: ${run.subsystemId})`,
        );

        return this.registry.getRun(runId);
    }

    // ── Budget API (delegates to ReflectionBudgetManager) ──────────────────────

    /**
     * Attempts to consume one unit of a budget dimension.
     *
     * Returns the BudgetCheckResult — the caller MUST check `allowed`.
     */
    consumeBudget(
        runId: string,
        field: keyof BudgetUsage,
    ): BudgetCheckResult {
        const run = this.registry.getRun(runId);
        if (!run) {
            return { allowed: false, blockedBy: field, remaining: {} };
        }
        return this.budgetManager.consume(runId, field, run.budget);
    }

    /**
     * Returns true if any budget dimension has been fully consumed.
     */
    isBudgetExhausted(runId: string): boolean {
        const run = this.registry.getRun(runId);
        if (!run) return true;
        return this.budgetManager.isExhausted(runId, run.budget);
    }

    /**
     * Returns the current budget usage for a run.
     */
    getUsage(runId: string): BudgetUsage {
        return this.budgetManager.getUsage(runId);
    }

    // ── Run queries ─────────────────────────────────────────────────────────────

    /** Returns the current run record, or null if not found. */
    getRunState(runId: string): PlanRun | null {
        return this.registry.getRun(runId);
    }

    /** Returns all recent runs within the given window (default: 1 hour). */
    listRecentRuns(windowMs?: number): PlanRun[] {
        return this.registry.listRecent(windowMs);
    }

    /** Returns active/pending runs for a subsystem, or null. */
    getActiveRun(subsystemId: string): PlanRun | null {
        return this.registry.getActiveRun(subsystemId);
    }

    /**
     * Prunes old run records from memory.
     * Should be called on a periodic maintenance tick.
     */
    pruneOldRuns(retentionMs?: number): number {
        return this.registry.pruneOldRuns(retentionMs);
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _addMilestone(
        runId: string,
        name: PlanRunMilestone['name'],
        notes?: string,
    ): void {
        const run = this.registry.getRun(runId);
        if (!run) return;

        const milestone: PlanRunMilestone = {
            name,
            timestamp: new Date().toISOString(),
            notes,
        };
        const updatedMilestones = [...run.milestones, milestone];
        this.registry.updateRun(runId, { milestones: updatedMilestones });
    }

    private _releaseAndCooldown(run: PlanRun): void {
        this.registry.unlockSubsystem(run.subsystemId);
        this.registry.setCooldown(
            run.subsystemId,
            run.trigger.subsystemId ? 'medium' : 'low',
            `After run ${run.runId}`,
        );
        this.budgetManager.clearRun(run.runId);
    }
}
