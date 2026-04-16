/**
 * PlanningService.ts — Goal → Plan → Execution handoff lifecycle authority
 *
 * PlanningService is the single authority for:
 *   - goal intake and registration
 *   - deterministic goal analysis (via GoalAnalyzer)
 *   - structured plan construction (via PlanBuilder)
 *   - approval-state handling for plans requiring sign-off
 *   - replan generation with full traceability
 *   - planning state transitions
 *   - execution handoff metadata / signalling
 *
 * PlanningService is NOT the authority for:
 *   - running workflows, invoking tools, or executing LLM calls
 *   - performing operator actions
 *   - mutating canonical memory outside its own planning records
 *   - bypassing PolicyGate, ToolExecutionCoordinator, AgentKernel,
 *     OperatorActionService, or any other existing execution authority
 *
 * Design invariants
 * ─────────────────
 * 1. No execution — PlanningService prepares the handoff; it does not
 *    perform the actual work described in a plan.
 * 2. Traceability — replanning always generates a new versioned plan;
 *    prior plans are preserved in 'superseded' state with bidirectional links.
 * 3. Honest state — blocked analysis produces a blocked plan; no fake readiness.
 * 4. Approval gating — plans requiring approval must reach 'approved' state
 *    before a planning.execution_handoff event is emitted.
 * 5. Telemetry — lifecycle events are emitted for all significant transitions.
 * 6. Observable — getGoal / getPlan / listPlansForGoal expose planning state
 *    without requiring callers to maintain their own copies.
 *
 * Architecture position
 * ─────────────────────
 *   User / Autonomy / Reflection / Operator
 *     → PlanningService.registerGoal(input)
 *       → GoalAnalyzer.analyze(goal, capabilities)
 *         → PlanBuilder.build({ goal, analysis })
 *           → PlanningRepository (goal + plan storage)
 *             → TelemetryBus (lifecycle events)
 *               → Downstream execution authority (WorkflowExecutionService /
 *                 ToolExecutionCoordinator / AgentKernel / OperatorActionService)
 *
 * Usage
 * ─────
 * const svc = PlanningService.getInstance();
 * const goal = await svc.registerGoal({ title: '...', ... });
 * const analysis = await svc.analyzeGoal(goal.id);
 * const plan = await svc.buildPlan(goal.id);
 * if (plan.requiresApproval) await svc.approvePlan(plan.id, 'operator:user-123');
 * await svc.markExecutionStarted(plan.id);
 * await svc.markExecutionCompleted(plan.id);
 */

import { v4 as uuidv4 } from 'uuid';
import { TelemetryBus } from '../telemetry/TelemetryBus';
import { GoalAnalyzer } from './GoalAnalyzer';
import { PlanBuilder } from './PlanBuilder';
import { PlanningRepository } from './PlanningRepository';
import type {
    PlanGoal,
    PlanGoalSource,
    PlanGoalCategory,
    PlanGoalPriority,
    ExecutionPlan,
    GoalAnalysis,
    ReplanRequest,
} from '../../../shared/planning/PlanningTypes';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** Input for registering a new goal. */
export interface RegisterGoalInput {
    title: string;
    description: string;
    source: PlanGoalSource;
    category: PlanGoalCategory;
    priority?: PlanGoalPriority;
    constraints?: string[];
    successCriteria?: string[];
    metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PlanningService errors
// ---------------------------------------------------------------------------

export class PlanningError extends Error {
    constructor(
        message: string,
        public readonly code: string,
    ) {
        super(message);
        this.name = 'PlanningError';
    }
}

// ---------------------------------------------------------------------------
// PlanningService
// ---------------------------------------------------------------------------

export class PlanningService {
    private static _instance: PlanningService | null = null;

    private readonly _repo: PlanningRepository;
    private readonly _bus: TelemetryBus;

    /**
     * Available capabilities injected by the caller.
     * PlanningService itself does not query the runtime for capabilities;
     * callers (e.g. AgentService/main.ts) inject the current capability set
     * via setAvailableCapabilities() before the first analyzeGoal call.
     */
    private _availableCapabilities: ReadonlySet<string> = new Set();

    private constructor(repo?: PlanningRepository) {
        this._repo = repo ?? new PlanningRepository();
        this._bus = TelemetryBus.getInstance();
    }

    /** Returns the process-wide singleton PlanningService instance. */
    static getInstance(): PlanningService {
        if (!PlanningService._instance) {
            PlanningService._instance = new PlanningService();
        }
        return PlanningService._instance;
    }

    /**
     * Resets the singleton.  Intended for use in tests only.
     * A custom repository may be supplied for full isolation.
     */
    static _resetForTesting(repo?: PlanningRepository): void {
        PlanningService._instance = repo !== undefined
            ? new PlanningService(repo)
            : null;
    }

    // ── Capability injection ─────────────────────────────────────────────────

    /**
     * Updates the set of available runtime capabilities used during analysis.
     * Must be called before analyzeGoal() for accurate missing-capability detection.
     *
     * @param capabilities - Names of capabilities currently available
     *   (e.g. 'rag', 'workflow_engine', 'inference', 'tool_execution').
     */
    setAvailableCapabilities(capabilities: ReadonlySet<string>): void {
        this._availableCapabilities = capabilities;
    }

    // ── Goal management ──────────────────────────────────────────────────────

    /**
     * Registers a new goal and returns the created PlanGoal.
     *
     * Emits: planning.goal_registered
     */
    registerGoal(input: RegisterGoalInput): PlanGoal {
        const now = new Date().toISOString();
        const goal: PlanGoal = {
            id: `goal-${uuidv4()}`,
            title: input.title,
            description: input.description,
            source: input.source,
            category: input.category,
            priority: input.priority ?? 'normal',
            constraints: input.constraints,
            successCriteria: input.successCriteria,
            status: 'registered',
            registeredAt: now,
            updatedAt: now,
            metadata: input.metadata,
        };

        this._repo.saveGoal(goal);

        this._bus.emit({
            executionId: goal.id,
            subsystem: 'planning',
            event: 'planning.goal_registered',
            payload: {
                goalId: goal.id,
                source: goal.source,
                category: goal.category,
                priority: goal.priority,
            },
        });

        return { ...goal };
    }

    /**
     * Returns the goal with the given id, or undefined.
     */
    getGoal(goalId: string): PlanGoal | undefined {
        return this._repo.getGoal(goalId);
    }

    // ── Analysis ─────────────────────────────────────────────────────────────

    /**
     * Performs deterministic analysis of the given goal and returns a GoalAnalysis.
     *
     * Transitions the goal to 'analyzing' during the call, then back to 'planned'
     * (or 'blocked') after analysis completes.  The GoalAnalysis is returned but
     * not persisted — callers pass it directly to buildPlan().
     *
     * Emits: planning.goal_analyzed  (or planning.plan_blocked when blocked)
     *
     * @throws PlanningError if the goal is not found.
     */
    analyzeGoal(goalId: string): GoalAnalysis {
        const goal = this._repo.getGoal(goalId);
        if (!goal) {
            throw new PlanningError(`Goal not found: ${goalId}`, 'GOAL_NOT_FOUND');
        }

        const start = Date.now();

        // Transition to 'analyzing'
        this._saveGoalStatus(goal, 'analyzing');

        const analysis = GoalAnalyzer.analyze(goal, this._availableCapabilities);

        const durationMs = Date.now() - start;

        this._bus.emit({
            executionId: goalId,
            subsystem: 'planning',
            event: 'planning.goal_analyzed',
            payload: {
                goalId,
                complexity: analysis.complexity,
                executionStyle: analysis.executionStyle,
                requiresApproval: analysis.requiresApproval,
                blocked: analysis.blockingIssues.length > 0,
                missingCapabilities: analysis.missingCapabilities,
                recommendedPlanner: analysis.recommendedPlanner,
                risk: analysis.risk,
                confidence: analysis.confidence,
                reasonCodes: analysis.reasonCodes,
                durationMs,
            },
        });

        if (analysis.blockingIssues.length > 0) {
            this._saveGoalStatus(goal, 'blocked', analysis.blockingIssues.map(i => `block:${i}`));
        }

        return analysis;
    }

    // ── Plan building ────────────────────────────────────────────────────────

    /**
     * Builds a structured execution plan for the given goal.
     *
     * Runs analyzeGoal() internally, then calls PlanBuilder.build().
     * The resulting plan is persisted in the repository and the goal status
     * is updated to 'planned'.
     *
     * Emits: planning.plan_created  (or planning.plan_blocked)
     *
     * @throws PlanningError if the goal is not found.
     */
    buildPlan(goalId: string): ExecutionPlan {
        const goal = this._repo.getGoal(goalId);
        if (!goal) {
            throw new PlanningError(`Goal not found: ${goalId}`, 'GOAL_NOT_FOUND');
        }

        const analysis = this.analyzeGoal(goalId);
        const start = Date.now();

        const plan = PlanBuilder.build({ goal, analysis });
        this._repo.savePlan(plan);

        const durationMs = Date.now() - start;

        const isBlocked = plan.status === 'blocked';
        const eventType = isBlocked ? 'planning.plan_blocked' : 'planning.plan_created';

        // Update goal status
        const newGoalStatus = isBlocked ? 'blocked' : 'planned';
        const freshGoal = this._repo.getGoal(goalId)!;
        this._saveGoalStatus(freshGoal, newGoalStatus, plan.reasonCodes);

        this._bus.emit({
            executionId: goalId,
            subsystem: 'planning',
            event: eventType,
            payload: {
                goalId,
                planId: plan.id,
                plannerType: plan.plannerType,
                version: plan.version,
                stageCount: plan.stages.length,
                requiresApproval: plan.requiresApproval,
                approvalState: plan.approvalState,
                status: plan.status,
                estimatedRisk: plan.estimatedRisk,
                handoffTarget: plan.handoffTarget,
                reasonCodes: plan.reasonCodes,
                durationMs,
            },
        });

        return { ...plan };
    }

    // ── Approval ─────────────────────────────────────────────────────────────

    /**
     * Approves a plan that is in 'pending' approval state.
     *
     * Transitions: approvalState pending → approved, status draft → approved.
     * Transitions the goal to 'approved'.
     *
     * Emits: planning.plan_approved
     *
     * @throws PlanningError if the plan is not found, does not require approval,
     *   or is not in a state where approval is valid.
     */
    approvePlan(planId: string, actor: string): ExecutionPlan {
        const plan = this._repo.getPlan(planId);
        if (!plan) {
            throw new PlanningError(`Plan not found: ${planId}`, 'PLAN_NOT_FOUND');
        }
        if (!plan.requiresApproval) {
            throw new PlanningError(
                `Plan ${planId} does not require approval`,
                'APPROVAL_NOT_REQUIRED',
            );
        }
        if (plan.approvalState !== 'pending') {
            throw new PlanningError(
                `Plan ${planId} is not in pending approval state (current: ${plan.approvalState})`,
                'INVALID_APPROVAL_STATE',
            );
        }

        const now = new Date().toISOString();
        const updated: ExecutionPlan = {
            ...plan,
            approvalState: 'approved',
            approvalDecidedAt: now,
            approvalActor: actor,
            status: 'approved',
            updatedAt: now,
            reasonCodes: [...plan.reasonCodes, `approved_by:${actor}`],
        };

        this._repo.savePlan(updated);

        // Transition goal to 'approved'
        const goal = this._repo.getGoal(plan.goalId);
        if (goal) {
            this._saveGoalStatus(goal, 'approved');
        }

        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.plan_approved',
            payload: {
                goalId: plan.goalId,
                planId,
                actor,
                approvedAt: now,
            },
        });

        return { ...updated };
    }

    /**
     * Denies a plan that is in 'pending' approval state.
     *
     * Transitions: approvalState pending → denied, status draft → blocked.
     * Transitions the goal to 'blocked'.
     *
     * Emits: planning.plan_denied
     *
     * @throws PlanningError if the plan is not found or is not pending approval.
     */
    denyPlan(planId: string, actor: string, reason: string): ExecutionPlan {
        const plan = this._repo.getPlan(planId);
        if (!plan) {
            throw new PlanningError(`Plan not found: ${planId}`, 'PLAN_NOT_FOUND');
        }
        if (plan.approvalState !== 'pending') {
            throw new PlanningError(
                `Plan ${planId} is not in pending approval state (current: ${plan.approvalState})`,
                'INVALID_APPROVAL_STATE',
            );
        }

        const now = new Date().toISOString();
        const updated: ExecutionPlan = {
            ...plan,
            approvalState: 'denied',
            approvalDecidedAt: now,
            approvalActor: actor,
            denialReason: reason,
            status: 'blocked',
            updatedAt: now,
            reasonCodes: [...plan.reasonCodes, `denied_by:${actor}`, `reason:${reason}`],
        };

        this._repo.savePlan(updated);

        // Transition goal to 'blocked'
        const goal = this._repo.getGoal(plan.goalId);
        if (goal) {
            this._saveGoalStatus(goal, 'blocked', [`operator_denied:${reason}`]);
        }

        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.plan_denied',
            payload: {
                goalId: plan.goalId,
                planId,
                actor,
                reason,
                deniedAt: now,
            },
        });

        return { ...updated };
    }

    // ── Plan access ──────────────────────────────────────────────────────────

    /**
     * Returns the plan with the given id, or undefined.
     */
    getPlan(planId: string): ExecutionPlan | undefined {
        return this._repo.getPlan(planId);
    }

    /**
     * Returns all plans for the given goal, ordered by version ascending.
     */
    listPlansForGoal(goalId: string): ExecutionPlan[] {
        return this._repo.listPlansForGoal(goalId);
    }

    // ── Execution lifecycle ──────────────────────────────────────────────────

    /**
     * Marks that execution has been handed off to the downstream authority.
     *
     * Valid from: status 'ready' or 'approved'.
     * Emits: planning.execution_handoff
     *
     * @throws PlanningError if the plan is not found or not in a valid pre-execution state.
     */
    markExecutionStarted(planId: string): ExecutionPlan {
        const plan = this._repo.getPlan(planId);
        if (!plan) {
            throw new PlanningError(`Plan not found: ${planId}`, 'PLAN_NOT_FOUND');
        }

        const validStatuses: ExecutionPlan['status'][] = ['ready', 'approved'];
        if (!validStatuses.includes(plan.status)) {
            throw new PlanningError(
                `Plan ${planId} cannot start execution from status '${plan.status}' (must be ready or approved)`,
                'INVALID_EXECUTION_STATE',
            );
        }

        // Approval-required plans must be approved before execution
        if (plan.requiresApproval && plan.approvalState !== 'approved') {
            throw new PlanningError(
                `Plan ${planId} requires approval before execution (current approval state: ${plan.approvalState})`,
                'APPROVAL_REQUIRED',
            );
        }

        const now = new Date().toISOString();
        const updated: ExecutionPlan = {
            ...plan,
            status: 'executing',
            updatedAt: now,
        };

        this._repo.savePlan(updated);

        // Transition goal to 'executing'
        const goal = this._repo.getGoal(plan.goalId);
        if (goal) {
            this._saveGoalStatus(goal, 'executing');
        }

        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.execution_handoff',
            payload: {
                goalId: plan.goalId,
                planId,
                handoffTarget: plan.handoffTarget,
                plannerType: plan.plannerType,
                version: plan.version,
                startedAt: now,
            },
        });

        return { ...updated };
    }

    /**
     * Marks execution as completed successfully.
     *
     * Valid from: status 'executing'.
     * Emits: planning.plan_completed
     *
     * @throws PlanningError if the plan is not found or not in 'executing' state.
     */
    markExecutionCompleted(planId: string): ExecutionPlan {
        const plan = this._repo.getPlan(planId);
        if (!plan) {
            throw new PlanningError(`Plan not found: ${planId}`, 'PLAN_NOT_FOUND');
        }
        if (plan.status !== 'executing') {
            throw new PlanningError(
                `Plan ${planId} is not in executing state (current: ${plan.status})`,
                'INVALID_EXECUTION_STATE',
            );
        }

        const now = new Date().toISOString();
        const updated: ExecutionPlan = {
            ...plan,
            status: 'completed',
            updatedAt: now,
        };

        this._repo.savePlan(updated);

        const goal = this._repo.getGoal(plan.goalId);
        if (goal) {
            this._saveGoalStatus(goal, 'completed');
        }

        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.plan_completed',
            payload: {
                goalId: plan.goalId,
                planId,
                version: plan.version,
                completedAt: now,
            },
        });

        return { ...updated };
    }

    /**
     * Marks execution as failed.
     *
     * Valid from: status 'executing'.
     * Emits: planning.plan_failed
     *
     * @throws PlanningError if the plan is not found or not in 'executing' state.
     */
    markExecutionFailed(planId: string, reason: string): ExecutionPlan {
        const plan = this._repo.getPlan(planId);
        if (!plan) {
            throw new PlanningError(`Plan not found: ${planId}`, 'PLAN_NOT_FOUND');
        }
        if (plan.status !== 'executing') {
            throw new PlanningError(
                `Plan ${planId} is not in executing state (current: ${plan.status})`,
                'INVALID_EXECUTION_STATE',
            );
        }

        const now = new Date().toISOString();
        const updated: ExecutionPlan = {
            ...plan,
            status: 'failed',
            updatedAt: now,
            reasonCodes: [...plan.reasonCodes, `failure:${reason}`],
        };

        this._repo.savePlan(updated);

        const goal = this._repo.getGoal(plan.goalId);
        if (goal) {
            this._saveGoalStatus(goal, 'failed', [`execution_failed:${reason}`]);
        }

        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.plan_failed',
            payload: {
                goalId: plan.goalId,
                planId,
                reason,
                version: plan.version,
                failedAt: now,
            },
        });

        return { ...updated };
    }

    // ── Replanning ───────────────────────────────────────────────────────────

    /**
     * Generates a new versioned plan superseding the prior plan.
     *
     * The prior plan is marked 'superseded' with a forward link to the new plan.
     * The new plan carries replannedFromPlanId linking back to the prior plan.
     * No silent overwrite of history — the prior plan record is always preserved.
     *
     * Emits: planning.replan_requested, planning.plan_superseded, planning.plan_created
     *         (or planning.plan_blocked if the new analysis is also blocked)
     *
     * @throws PlanningError if the goal or prior plan are not found.
     */
    replan(request: ReplanRequest): ExecutionPlan {
        const goal = this._repo.getGoal(request.goalId);
        if (!goal) {
            throw new PlanningError(`Goal not found: ${request.goalId}`, 'GOAL_NOT_FOUND');
        }

        const priorPlan = this._repo.getPlan(request.priorPlanId);
        if (!priorPlan) {
            throw new PlanningError(`Prior plan not found: ${request.priorPlanId}`, 'PLAN_NOT_FOUND');
        }

        const now = new Date().toISOString();

        this._bus.emit({
            executionId: request.goalId,
            subsystem: 'planning',
            event: 'planning.replan_requested',
            payload: {
                goalId: request.goalId,
                priorPlanId: request.priorPlanId,
                trigger: request.trigger,
                triggerDetails: request.triggerDetails,
                requestedAt: now,
            },
        });

        // Reset goal status to 'registered' for fresh analysis
        this._saveGoalStatus(goal, 'registered', [`replan_trigger:${request.trigger}`]);

        // Analyse with current capabilities
        const analysis = GoalAnalyzer.analyze(
            this._repo.getGoal(request.goalId)!,
            this._availableCapabilities,
        );

        // Build new plan superseding the prior one
        const newPlan = PlanBuilder.build({
            goal: this._repo.getGoal(request.goalId)!,
            analysis,
            priorPlan,
        });
        this._repo.savePlan(newPlan);

        // Mark prior plan as superseded (preserve record, add forward link)
        const supersededPrior: ExecutionPlan = {
            ...priorPlan,
            status: 'superseded',
            supersededByPlanId: newPlan.id,
            updatedAt: now,
        };
        this._repo.savePlan(supersededPrior);

        this._bus.emit({
            executionId: request.goalId,
            subsystem: 'planning',
            event: 'planning.plan_superseded',
            payload: {
                goalId: request.goalId,
                supersededPlanId: priorPlan.id,
                newPlanId: newPlan.id,
                trigger: request.trigger,
                supersededAt: now,
            },
        });

        // Emit plan created / blocked event
        const isBlocked = newPlan.status === 'blocked';
        this._bus.emit({
            executionId: request.goalId,
            subsystem: 'planning',
            event: isBlocked ? 'planning.plan_blocked' : 'planning.plan_created',
            payload: {
                goalId: request.goalId,
                planId: newPlan.id,
                version: newPlan.version,
                plannerType: newPlan.plannerType,
                stageCount: newPlan.stages.length,
                requiresApproval: newPlan.requiresApproval,
                approvalState: newPlan.approvalState,
                status: newPlan.status,
                replannedFromPlanId: priorPlan.id,
                reasonCodes: newPlan.reasonCodes,
            },
        });

        // Update goal to 'planned' or 'blocked'
        const freshGoal2 = this._repo.getGoal(request.goalId)!;
        this._saveGoalStatus(freshGoal2, isBlocked ? 'blocked' : 'planned', newPlan.reasonCodes);

        return { ...newPlan };
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /** Mutates goal status + updatedAt in the repository. */
    private _saveGoalStatus(
        goal: PlanGoal,
        status: PlanGoal['status'],
        reasonCodes?: string[],
    ): void {
        const updated: PlanGoal = {
            ...goal,
            status,
            updatedAt: new Date().toISOString(),
            ...(reasonCodes !== undefined && { reasonCodes }),
        };
        this._repo.saveGoal(updated);
    }
}
