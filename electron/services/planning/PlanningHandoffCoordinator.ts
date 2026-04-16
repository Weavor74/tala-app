/**
 * PlanningHandoffCoordinator.ts — Thin execution bridge for PlanningService handoffs
 *
 * Consumes the typed ExecutionHandoff produced by PlanningService and dispatches
 * it to the appropriate downstream execution authority.
 *
 * Design invariants
 * ─────────────────
 * 1. Not a planner — this class does not produce plans, analyse goals, or modify
 *    planning state beyond calling markExecutionCompleted / markExecutionFailed.
 * 2. One path — only the `tool` handoff type is implemented.  Workflow and agent
 *    paths are acknowledged but delegated to their respective authorities via
 *    their own integration seams.
 * 3. Governed execution — tool dispatch goes through ToolExecutionCoordinator,
 *    never directly to ToolService.  All policy enforcement and telemetry remain
 *    in that coordinator.
 * 4. Traceability — the plan's executionBoundaryId is propagated as the
 *    executionId in ToolInvocationContext so tool telemetry is correlated to
 *    the planning lifecycle.
 * 5. Honest failure — if any required step fails with failurePolicy:'stop',
 *    markExecutionFailed() is called and the error is propagated to the caller.
 * 6. No silent side effects — every dispatch attempt is observable via
 *    planning.handoff_dispatched and planning.handoff_dispatch_failed events.
 */

import { TelemetryBus } from '../telemetry/TelemetryBus';
import { PlanningService } from './PlanningService';
import type { ExecutionPlan, PlannedToolInvocation } from '../../../shared/planning/PlanningTypes';
import type { ToolInvocationContext } from '../tools/ToolExecutionCoordinator';

/**
 * Minimal interface for the tool execution authority.
 * Defined here to allow injection in tests without importing the full coordinator.
 */
export interface IToolExecutor {
    executeTool(
        name: string,
        args: Record<string, unknown>,
        allowedNames?: ReadonlySet<string>,
        ctx?: ToolInvocationContext,
    ): Promise<{ success: boolean; data?: unknown; error?: string; durationMs?: number }>;
}

/** Result of a single dispatched step. */
export interface StepDispatchResult {
    stepIndex: number;
    toolId: string;
    success: boolean;
    data?: unknown;
    error?: string;
    durationMs?: number;
}

/** Result of a full plan dispatch. */
export interface PlanDispatchResult {
    planId: string;
    executionBoundaryId: string;
    success: boolean;
    /** Results for each step that was attempted. */
    steps: StepDispatchResult[];
    /** Populated on failure. */
    error?: string;
}

/**
 * PlanningHandoffCoordinator
 *
 * Wires the planning subsystem to the tool execution coordinator for `tool`
 * type handoffs.  This is the single real execution path from a planning
 * decision to governed tool invocations.
 *
 * Usage:
 *   const dispatcher = new PlanningHandoffCoordinator(toolExecutor);
 *   const result = await dispatcher.dispatch(planId);
 */
export class PlanningHandoffCoordinator {
    private readonly _planning: PlanningService;
    private readonly _bus: TelemetryBus;

    constructor(private readonly _toolExecutor: IToolExecutor) {
        this._planning = PlanningService.getInstance();
        this._bus = TelemetryBus.getInstance();
    }

    /**
     * Dispatches the handoff for the plan identified by planId.
     *
     * Pre-conditions:
     *   - Plan must exist and have status 'ready' or 'approved'.
     *   - Plan's handoff.type must be 'tool'.
     *
     * On success: marks the plan as completed via PlanningService.
     * On failure: marks the plan as failed via PlanningService.
     *
     * @throws Error if the plan is not found, is not in a dispatchable state,
     *   or has an unsupported handoff type.
     */
    async dispatch(planId: string): Promise<PlanDispatchResult> {
        const plan = this._planning.getPlan(planId);
        if (!plan) {
            throw new Error(`PlanningHandoffCoordinator: plan not found: ${planId}`);
        }

        if (plan.handoff.type !== 'tool') {
            throw new Error(
                `PlanningHandoffCoordinator: only 'tool' handoff type is supported` +
                ` (plan ${planId} has type '${plan.handoff.type}')`,
            );
        }

        // Transition plan to executing state (generates executionBoundaryId)
        const executingPlan = this._planning.markExecutionStarted(planId);
        const executionBoundaryId = executingPlan.executionBoundaryId ?? `exec-fallback-${planId}`;

        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.handoff_dispatched',
            payload: {
                planId,
                goalId: plan.goalId,
                executionBoundaryId,
                handoffType: 'tool',
                stepCount: plan.handoff.steps.length,
            },
        });

        const stepResults: StepDispatchResult[] = [];
        const { steps, sharedInputs } = plan.handoff;

        try {
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                const result = await this._executeStep(
                    step,
                    i,
                    sharedInputs,
                    executionBoundaryId,
                    plan,
                );
                stepResults.push(result);

                if (!result.success && step.failurePolicy === 'stop') {
                    const dispatchResult: PlanDispatchResult = {
                        planId,
                        executionBoundaryId,
                        success: false,
                        steps: stepResults,
                        error: result.error ?? `Step ${i} (${step.toolId}) failed`,
                    };
                    this._planning.markExecutionFailed(
                        planId,
                        dispatchResult.error!,
                    );
                    this._emitDispatchFailed(plan, executionBoundaryId, dispatchResult.error!);
                    return dispatchResult;
                }
                // For 'skip' or 'escalate' policies, continue regardless of outcome
            }

            // All steps completed (or non-stop failures were tolerated)
            this._planning.markExecutionCompleted(planId);
            return {
                planId,
                executionBoundaryId,
                success: true,
                steps: stepResults,
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const dispatchResult: PlanDispatchResult = {
                planId,
                executionBoundaryId,
                success: false,
                steps: stepResults,
                error: message,
            };
            this._planning.markExecutionFailed(planId, message);
            this._emitDispatchFailed(plan, executionBoundaryId, message);
            return dispatchResult;
        }
    }

    /** Executes a single planned tool invocation step. */
    private async _executeStep(
        step: PlannedToolInvocation,
        stepIndex: number,
        sharedInputs: Record<string, unknown>,
        executionBoundaryId: string,
        plan: ExecutionPlan,
    ): Promise<StepDispatchResult> {
        const mergedInput: Record<string, unknown> = { ...sharedInputs, ...step.input };
        const ctx: ToolInvocationContext = {
            executionId: executionBoundaryId,
            executionType: 'planning_handoff',
            executionOrigin: 'planning',
        };

        try {
            const result = await this._toolExecutor.executeTool(
                step.toolId,
                mergedInput,
                undefined,
                ctx,
            );
            return {
                stepIndex,
                toolId: step.toolId,
                success: result.success,
                data: result.data,
                error: result.error,
                durationMs: result.durationMs,
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this._bus.emit({
                executionId: plan.goalId,
                subsystem: 'planning',
                event: 'planning.handoff_step_failed',
                payload: {
                    planId: plan.id,
                    goalId: plan.goalId,
                    executionBoundaryId,
                    stepIndex,
                    toolId: step.toolId,
                    error: message,
                },
            });
            return {
                stepIndex,
                toolId: step.toolId,
                success: false,
                error: message,
            };
        }
    }

    private _emitDispatchFailed(
        plan: ExecutionPlan,
        executionBoundaryId: string,
        error: string,
    ): void {
        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.handoff_dispatch_failed',
            payload: {
                planId: plan.id,
                goalId: plan.goalId,
                executionBoundaryId,
                handoffType: 'tool',
                error,
            },
        });
    }
}
