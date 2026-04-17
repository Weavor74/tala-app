/**
 * WorkflowHandoffCoordinator.ts — Execution bridge for PlanningService workflow handoffs
 *
 * Consumes the typed workflow ExecutionHandoff produced by PlanningService and dispatches
 * each PlannedWorkflowInvocation to the appropriate downstream workflow execution authority.
 *
 * Design invariants
 * ─────────────────
 * 1. Not a planner — this class does not produce plans, analyse goals, or modify
 *    planning state beyond calling markExecutionCompleted / markExecutionFailed.
 * 2. Preflight first — before any dispatch, preflight validation runs synchronously.
 *    Preflight failure marks the plan failed with a machine-readable reason code and
 *    signals that replanning may be appropriate (replanAdvised: true).
 * 3. Typed contract — only the 'workflow' handoff type is accepted.  Any other type
 *    throws immediately so the caller knows to use the correct coordinator.
 * 4. Policy enforcement — each invocation's failurePolicy is honoured:
 *    stop → abort remaining invocations and mark plan failed
 *    retry → coordinator defers retry logic to the executor; returns result as-is
 *    skip  → continue to next invocation regardless of outcome
 *    escalate → mark result as requiring operator gate (replanAdvised: true)
 * 5. Execution-boundary propagation — the plan's executionBoundaryId is passed as
 *    executionId in WorkflowInvocationContext so workflow telemetry is correlated to
 *    the planning lifecycle.
 * 6. Telemetry lifecycle parity — emits the same lifecycle event pattern as
 *    PlanningHandoffCoordinator (dispatched, invocation_failed, dispatch_failed)
 *    plus preflight-specific events (workflow_handoff_preflight_failed).
 * 7. Stable failure reason codes — all failures carry a WorkflowHandoffFailureCode from
 *    the shared type contract, making them machine-actionable without string parsing.
 * 8. Honest failure — if any required invocation fails with failurePolicy:'stop',
 *    markExecutionFailed() is called and the error is propagated to the caller.
 * 9. No silent side effects — every dispatch attempt is observable via telemetry.
 */

import { TelemetryBus } from '../telemetry/TelemetryBus';
import { PlanningService } from './PlanningService';
import type {
    ExecutionPlan,
    PlannedWorkflowInvocation,
    WorkflowHandoffFailureCode,
} from '../../../shared/planning/PlanningTypes';

// ─── Executor interface ────────────────────────────────────────────────────────

/**
 * Invocation context passed to the workflow executor on each dispatch.
 * Correlates workflow telemetry to the planning lifecycle.
 */
export interface WorkflowInvocationContext {
    /** Matches the plan's executionBoundaryId for cross-subsystem correlation. */
    executionId: string;
    /** Always 'planning_handoff' — identifies this as a plan-initiated dispatch. */
    executionType: 'planning_handoff';
    /** Always 'planning' — execution originated from the planning subsystem. */
    executionOrigin: 'planning';
}

/**
 * Minimal interface for the workflow execution authority.
 * Defined here to allow injection in tests without importing the full service.
 */
export interface IWorkflowExecutor {
    executeWorkflow(
        workflowId: string,
        input: Record<string, unknown>,
        ctx?: WorkflowInvocationContext,
    ): Promise<{ success: boolean; data?: unknown; error?: string; durationMs?: number }>;
}

// ─── Preflight ────────────────────────────────────────────────────────────────

/**
 * Result of a preflight validation for a single invocation.
 */
export interface WorkflowPreflightResult {
    passed: boolean;
    /** Machine-readable failure code; present only when passed=false. */
    failureCode?: WorkflowHandoffFailureCode;
    /** Human-readable description of the failure; present only when passed=false. */
    details?: string;
    /**
     * Whether replanning is advised following this preflight failure.
     * True for capability mismatches (capability may become available after replan).
     * False for hard invariant violations (e.g. empty workflowId).
     */
    replanAdvised?: boolean;
}

/**
 * Runs deterministic preflight checks on a single PlannedWorkflowInvocation.
 *
 * Checks (in order, first failure wins):
 *   1. workflowId is non-empty
 *   2. All requiredCapabilities are present in the available set
 *
 * Does not check whether the workflow is registered — that is an executor concern.
 *
 * @param invocation - The invocation to validate.
 * @param availableCapabilities - The capabilities currently available in the runtime.
 */
export function runWorkflowPreflight(
    invocation: PlannedWorkflowInvocation,
    availableCapabilities: ReadonlySet<string> = new Set(),
): WorkflowPreflightResult {
    if (!invocation.workflowId || invocation.workflowId.trim() === '') {
        return {
            passed: false,
            failureCode: 'preflight:invalid_workflow_id',
            details: 'workflowId is empty or whitespace',
            replanAdvised: false,
        };
    }

    const required = invocation.requiredCapabilities ?? [];
    const missing = required.filter(c => !availableCapabilities.has(c));
    if (missing.length > 0) {
        return {
            passed: false,
            failureCode: 'preflight:capability_missing',
            details: `missing capabilities: ${missing.join(', ')}`,
            replanAdvised: true,
        };
    }

    return { passed: true };
}

// ─── Result types ─────────────────────────────────────────────────────────────

/** Result of a single dispatched invocation. */
export interface WorkflowInvocationResult {
    invocationIndex: number;
    workflowId: string;
    success: boolean;
    data?: unknown;
    error?: string;
    durationMs?: number;
    /** Stable failure reason code; present only when success=false. */
    failureCode?: WorkflowHandoffFailureCode;
}

/** Result of a full plan workflow dispatch. */
export interface WorkflowDispatchResult {
    planId: string;
    executionBoundaryId: string;
    success: boolean;
    /** Results for each invocation that was attempted. */
    invocations: WorkflowInvocationResult[];
    /** Populated on overall failure. */
    error?: string;
    /** Stable failure reason code for the overall dispatch; present on failure. */
    failureCode?: WorkflowHandoffFailureCode;
    /**
     * True when the failure is caused by a preflight check or a condition where
     * replanning is the recommended recovery path (e.g. missing capability).
     * Callers can use this to trigger PlanningService.replan() with the appropriate
     * trigger (e.g. 'capability_loss').
     */
    replanAdvised?: boolean;
    /**
     * Suggested replan trigger code when replanAdvised is true.
     * Directly usable as the `trigger` field of a ReplanRequest.
     */
    replanTrigger?: 'capability_loss' | 'policy_block' | 'dependency_failure';
}

// ─── Coordinator ──────────────────────────────────────────────────────────────

/**
 * WorkflowHandoffCoordinator
 *
 * Wires the planning subsystem to the workflow execution service for 'workflow'
 * type handoffs.  This is the single real execution path from a planning decision
 * to governed workflow invocations.
 *
 * Usage:
 *   const coordinator = new WorkflowHandoffCoordinator(workflowExecutor);
 *   const result = await coordinator.dispatch(planId, availableCapabilities);
 */
export class WorkflowHandoffCoordinator {
    private readonly _planning: PlanningService;
    private readonly _bus: TelemetryBus;

    constructor(
        private readonly _workflowExecutor: IWorkflowExecutor,
    ) {
        this._planning = PlanningService.getInstance();
        this._bus = TelemetryBus.getInstance();
    }

    /**
     * Dispatches the workflow handoff for the plan identified by planId.
     *
     * Pre-conditions:
     *   - Plan must exist and have status 'ready' or 'approved'.
     *   - Plan's handoff.type must be 'workflow'.
     *
     * Execution sequence:
     *   1. Validate plan type (throws if wrong)
     *   2. Call markExecutionStarted (generates executionBoundaryId)
     *   3. Emit planning.workflow_handoff_dispatched
     *   4. For each invocation:
     *       a. Run preflight (failureCode + replanAdvised on failure)
     *       b. Dispatch to executor
     *       c. Apply failurePolicy if needed
     *   5. On success: markExecutionCompleted
     *   6. On failure: markExecutionFailed with reason code
     *
     * @param planId - The plan to dispatch.
     * @param availableCapabilities - Set of capability names currently available.
     *   Used for preflight validation of requiredCapabilities on each invocation.
     * @throws Error if the plan is not found or has the wrong handoff type.
     */
    async dispatch(
        planId: string,
        availableCapabilities: ReadonlySet<string> = new Set(),
    ): Promise<WorkflowDispatchResult> {
        const plan = this._planning.getPlan(planId);
        if (!plan) {
            throw new Error(`WorkflowHandoffCoordinator: plan not found: ${planId}`);
        }

        if (plan.handoff.type !== 'workflow') {
            throw new Error(
                `WorkflowHandoffCoordinator: only 'workflow' handoff type is supported` +
                ` (plan ${planId} has type '${plan.handoff.type}')`,
            );
        }

        // Transition plan to executing state (generates executionBoundaryId)
        const executingPlan = this._planning.markExecutionStarted(planId);
        const executionBoundaryId = executingPlan.executionBoundaryId ?? `exec-fallback-${planId}`;

        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.workflow_handoff_dispatched',
            payload: {
                planId,
                goalId: plan.goalId,
                executionBoundaryId,
                handoffType: 'workflow',
                invocationCount: plan.handoff.invocations.length,
            },
        });

        const invocationResults: WorkflowInvocationResult[] = [];
        const { invocations, sharedInputs } = plan.handoff;

        try {
            for (let i = 0; i < invocations.length; i++) {
                const inv = invocations[i];

                // ── Preflight ────────────────────────────────────────────────
                const preflightResult = runWorkflowPreflight(inv, availableCapabilities);
                if (!preflightResult.passed) {
                    const failureMsg = `preflight failed for invocation ${i} (${inv.workflowId}): ${preflightResult.details ?? preflightResult.failureCode}`;
                    this._emitPreflightFailed(plan, executionBoundaryId, i, inv, preflightResult);
                    invocationResults.push({
                        invocationIndex: i,
                        workflowId: inv.workflowId,
                        success: false,
                        error: failureMsg,
                        failureCode: preflightResult.failureCode,
                    });

                    const dispatchResult: WorkflowDispatchResult = {
                        planId,
                        executionBoundaryId,
                        success: false,
                        invocations: invocationResults,
                        error: failureMsg,
                        failureCode: preflightResult.failureCode,
                        replanAdvised: preflightResult.replanAdvised,
                        replanTrigger: preflightResult.replanAdvised ? 'capability_loss' : undefined,
                    };
                    this._planning.markExecutionFailed(planId, failureMsg);
                    this._emitDispatchFailed(plan, executionBoundaryId, failureMsg, preflightResult.failureCode, preflightResult.replanAdvised);
                    return dispatchResult;
                }

                // ── Dispatch ─────────────────────────────────────────────────
                const result = await this._executeInvocation(
                    inv,
                    i,
                    sharedInputs,
                    executionBoundaryId,
                    plan,
                );
                invocationResults.push(result);

                if (!result.success) {
                    if (inv.failurePolicy === 'stop') {
                        const dispatchResult: WorkflowDispatchResult = {
                            planId,
                            executionBoundaryId,
                            success: false,
                            invocations: invocationResults,
                            error: result.error ?? `Invocation ${i} (${inv.workflowId}) failed`,
                            failureCode: result.failureCode ?? 'execution:workflow_failed',
                        };
                        this._planning.markExecutionFailed(planId, dispatchResult.error!);
                        this._emitDispatchFailed(plan, executionBoundaryId, dispatchResult.error!, dispatchResult.failureCode);
                        return dispatchResult;
                    }
                    if (inv.failurePolicy === 'escalate') {
                        const escalateMsg = `Invocation ${i} (${inv.workflowId}) requires operator escalation`;
                        const dispatchResult: WorkflowDispatchResult = {
                            planId,
                            executionBoundaryId,
                            success: false,
                            invocations: invocationResults,
                            error: escalateMsg,
                            failureCode: 'policy:escalation_required',
                            replanAdvised: true,
                            replanTrigger: 'policy_block',
                        };
                        this._planning.markExecutionFailed(planId, escalateMsg);
                        this._emitDispatchFailed(plan, executionBoundaryId, escalateMsg, 'policy:escalation_required', true);
                        return dispatchResult;
                    }
                    // 'skip' or 'retry' — continue regardless of outcome
                }
            }

            // All invocations completed (or non-stop failures were tolerated)
            this._planning.markExecutionCompleted(planId);
            return {
                planId,
                executionBoundaryId,
                success: true,
                invocations: invocationResults,
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const dispatchResult: WorkflowDispatchResult = {
                planId,
                executionBoundaryId,
                success: false,
                invocations: invocationResults,
                error: message,
                failureCode: 'dispatch:executor_unavailable',
            };
            this._planning.markExecutionFailed(planId, message);
            this._emitDispatchFailed(plan, executionBoundaryId, message, 'dispatch:executor_unavailable');
            return dispatchResult;
        }
    }

    /** Executes a single planned workflow invocation. */
    private async _executeInvocation(
        invocation: PlannedWorkflowInvocation,
        invocationIndex: number,
        sharedInputs: Record<string, unknown>,
        executionBoundaryId: string,
        plan: ExecutionPlan,
    ): Promise<WorkflowInvocationResult> {
        const mergedInput: Record<string, unknown> = { ...sharedInputs, ...invocation.input };
        const ctx: WorkflowInvocationContext = {
            executionId: executionBoundaryId,
            executionType: 'planning_handoff',
            executionOrigin: 'planning',
        };

        try {
            const result = await this._workflowExecutor.executeWorkflow(
                invocation.workflowId,
                mergedInput,
                ctx,
            );
            return {
                invocationIndex,
                workflowId: invocation.workflowId,
                success: result.success,
                data: result.data,
                error: result.error,
                durationMs: result.durationMs,
                failureCode: result.success ? undefined : 'execution:workflow_failed',
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this._bus.emit({
                executionId: plan.goalId,
                subsystem: 'planning',
                event: 'planning.workflow_handoff_invocation_failed',
                payload: {
                    planId: plan.id,
                    goalId: plan.goalId,
                    executionBoundaryId,
                    invocationIndex,
                    workflowId: invocation.workflowId,
                    failureCode: 'dispatch:executor_unavailable',
                    error: message,
                },
            });
            return {
                invocationIndex,
                workflowId: invocation.workflowId,
                success: false,
                error: message,
                failureCode: 'dispatch:executor_unavailable',
            };
        }
    }

    private _emitPreflightFailed(
        plan: ExecutionPlan,
        executionBoundaryId: string,
        invocationIndex: number,
        invocation: PlannedWorkflowInvocation,
        preflightResult: WorkflowPreflightResult,
    ): void {
        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.workflow_handoff_preflight_failed',
            payload: {
                planId: plan.id,
                goalId: plan.goalId,
                executionBoundaryId,
                invocationIndex,
                workflowId: invocation.workflowId,
                failureCode: preflightResult.failureCode,
                details: preflightResult.details,
                replanAdvised: preflightResult.replanAdvised ?? false,
            },
        });
    }

    private _emitDispatchFailed(
        plan: ExecutionPlan,
        executionBoundaryId: string,
        error: string,
        failureCode?: WorkflowHandoffFailureCode,
        replanAdvised?: boolean,
    ): void {
        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.workflow_handoff_dispatch_failed',
            payload: {
                planId: plan.id,
                goalId: plan.goalId,
                executionBoundaryId,
                handoffType: 'workflow',
                failureCode,
                replanAdvised: replanAdvised ?? false,
                error,
            },
        });
    }
}
