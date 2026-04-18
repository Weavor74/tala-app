/**
 * ChatLoopExecutor.ts — ILoopExecutor implementation for chat-based execution
 *
 * Wraps the AgentService chat pipeline as a PlanningLoopService ILoopExecutor.
 * This makes AgentService.chat() an authorised executor beneath the planning
 * loop, not a bypass of it.
 *
 * Architecture position
 * ─────────────────────
 *   PlanningLoopService.startLoop()
 *     → PlanningService.buildPlan()
 *       → ChatLoopExecutor.executePlan(plan)
 *           → looks up goal message via PlanningService.getGoal(plan.goalId)
 *           → calls executeChat(goal.title)  [wraps AgentService.chat()]
 *           → returns AgentTurnOutput as raw result
 *
 * Design invariants
 * ─────────────────
 * 1. This class is an implementation_detail beneath authorised loop control.
 *    It is NOT a bypass of PlanningLoopService.
 * 2. The executeChat callback must be pure from the loop's perspective —
 *    it handles its own internal tool/inference orchestration.
 * 3. If goal lookup fails, execution throws PlanningLoopError to drive the
 *    loop into a deterministic failure state.
 * 4. Streaming callbacks (onToken, onEvent) are optional and forwarded when
 *    the executor is constructed with them.
 * 5. The last execution result is stored and retrievable via
 *    getLastExecutionResult() so AgentKernel can extract the AgentTurnOutput
 *    after the loop completes.
 */

import type { ExecutionPlan, PlanExecutionResult } from '../../../shared/planning/PlanningTypes';
import type { AgentTurnOutput } from '../../types/artifacts';
import type { ILoopExecutor } from './PlanningLoopService';
import { PlanningLoopError } from './PlanningLoopService';
import { PlanningService } from './PlanningService';
import {
    PlanExecutionCoordinator,
    type PlanAgentExecutionAuthority,
    type PlanExecutionContext,
    type PlanToolExecutionAuthority,
    type PlanWorkflowExecutionAuthority,
} from './PlanExecutionCoordinator';
import type { TurnAuthorityEnvelope } from '../../../shared/turnArbitrationTypes';

// ─── ChatExecuteCallback ──────────────────────────────────────────────────────

/**
 * Callback type for the underlying chat execution function.
 * Wraps AgentService.chat() or any compatible chat execution entry point.
 */
export type ChatExecuteCallback = (
    message: string,
    onToken?: (token: string) => void,
    onEvent?: (type: string, data: unknown) => void,
    images?: string[],
) => Promise<AgentTurnOutput>;

export interface ChatLoopExecutorOptions {
    toolAuthority?: PlanToolExecutionAuthority;
    workflowAuthority?: PlanWorkflowExecutionAuthority;
    agentAuthority?: PlanAgentExecutionAuthority;
    authorityEnvelope?: TurnAuthorityEnvelope;
}

// ─── ChatLoopExecutor ─────────────────────────────────────────────────────────

/**
 * ILoopExecutor that delegates execution to the AgentService chat pipeline.
 *
 * Receives a fully-built ExecutionPlan from PlanningLoopService, retrieves the
 * original goal message from PlanningService, and invokes the chat execution
 * callback.  Returns an AgentTurnOutput that the paired ChatLoopObserver
 * will evaluate.
 *
 * The last execution result is stored internally and retrievable via
 * getLastExecutionResult() after each executePlan() call completes.
 */
export class ChatLoopExecutor implements ILoopExecutor {
    private readonly _executeChat: ChatExecuteCallback;
    private readonly _planning: PlanningService;
    private _onToken?: (token: string) => void;
    private _onEvent?: (type: string, data: unknown) => void;
    private _images?: string[];
    /** Last execution result — set after each successful executePlan() call. */
    private _lastResult: AgentTurnOutput | null = null;
    /** Last structured plan execution result. */
    private _lastPlanExecutionResult: PlanExecutionResult | null = null;
    /** Last execution error — set when executePlan() throws. */
    private _lastError: Error | null = null;
    private readonly _planExecution: PlanExecutionCoordinator;
    private readonly _hasToolAuthority: boolean;
    private readonly _hasWorkflowAuthority: boolean;
    private readonly _hasAgentAuthority: boolean;
    private _authorityEnvelope?: TurnAuthorityEnvelope;

    /**
     * @param executeChat - The chat execution callback (wraps AgentService.chat).
     * @param planning    - PlanningService instance for goal lookup.
     *                      Defaults to PlanningService.getInstance().
     */
    constructor(
        executeChat: ChatExecuteCallback,
        planning?: PlanningService,
        options?: ChatLoopExecutorOptions,
    ) {
        this._executeChat = executeChat;
        this._planning = planning ?? PlanningService.getInstance();
        this._planExecution = new PlanExecutionCoordinator(
            options?.toolAuthority,
            options?.workflowAuthority,
            options?.agentAuthority,
        );
        this._hasToolAuthority = Boolean(options?.toolAuthority);
        this._hasWorkflowAuthority = Boolean(options?.workflowAuthority);
        this._hasAgentAuthority = Boolean(options?.agentAuthority);
        this._authorityEnvelope = options?.authorityEnvelope;
    }

    /**
     * Configures per-turn streaming callbacks.
     *
     * Must be called before each `executePlan()` invocation when streaming
     * is required.  Callbacks are forwarded to the underlying chat pipeline.
     */
    setStreamCallbacks(
        onToken?: (token: string) => void,
        onEvent?: (type: string, data: unknown) => void,
        images?: string[],
        authorityEnvelope?: TurnAuthorityEnvelope,
    ): void {
        this._onToken = onToken;
        this._onEvent = onEvent;
        this._images = images;
        this._authorityEnvelope = authorityEnvelope ?? this._authorityEnvelope;
        this._lastResult = null;
        this._lastPlanExecutionResult = null;
        this._lastError = null;
    }

    /**
     * Returns the AgentTurnOutput from the most recent executePlan() call.
     *
     * Returns null if no execution has been performed or if the last execution
     * threw an error (in which case the loop will have entered a failed state).
     *
     * Used by AgentKernel to extract the turn output after the loop completes.
     */
    getLastExecutionResult(): AgentTurnOutput | null {
        return this._lastResult;
    }

    getLastPlanExecutionResult(): PlanExecutionResult | null {
        return this._lastPlanExecutionResult;
    }

    /**
     * Returns the Error from the most recent executePlan() call, if it threw.
     *
     * Returns null if no execution has been performed or if the last execution
     * succeeded.  Used by AgentKernel to re-throw the original error when the
     * loop fails due to an execution error (preserving existing error propagation).
     */
    getLastError(): Error | null {
        return this._lastError;
    }

    /**
     * Executes the given plan by delegating to the AgentService chat pipeline.
     *
     * Retrieves the goal message from PlanningService using plan.goalId,
     * then invokes the executeChat callback.
     *
     * @throws PlanningLoopError if the goal cannot be found or if execution fails.
     */
    async executePlan(plan: ExecutionPlan): Promise<unknown> {
        const goal = this._planning.getGoal(plan.goalId);
        if (!goal) {
            const err = new PlanningLoopError(
                `ChatLoopExecutor: goal not found for plan ${plan.id} (goalId=${plan.goalId})`,
                'GOAL_NOT_FOUND',
            );
            this._lastError = err;
            throw err;
        }

        try {
            if (this._isPlanExecutable(plan)) {
                const planResult = await this._planExecution.executePlan(plan, {
                    executionId: plan.executionBoundaryId ?? plan.goalId,
                    authorityEnvelope: this._authorityEnvelope,
                    onEvent: this._onEvent,
                } satisfies PlanExecutionContext);
                this._lastPlanExecutionResult = planResult;
                this._lastResult = this._toTurnOutput(planResult);
                this._lastError = null;
                return planResult;
            }

            // Fallback is allowed only when the plan is non-executable or rejected
            // before execution.
            const result = await this._executeChat(
                goal.title,
                this._onToken,
                this._onEvent,
                this._images,
            );

            this._lastResult = result;
            this._lastPlanExecutionResult = null;
            this._lastError = null;
            return result;
        } catch (err) {
            // Preserve the original error so AgentKernel can re-throw it
            // for correct failure telemetry and test assertions.
            this._lastError = err instanceof Error ? err : new Error(String(err));
            this._lastResult = null;
            this._lastPlanExecutionResult = null;
            throw err;
        }
    }

    private _isPlanExecutable(plan: ExecutionPlan): boolean {
        if (plan.status === 'blocked' || plan.handoff.type === 'none') return false;
        if (!Array.isArray(plan.stages) || plan.stages.length === 0) return false;
        const actionableHandoffs = plan.stages
            .map((stage) => stage.handoff?.type)
            .filter((type): type is 'tool' | 'workflow' | 'agent' =>
                type === 'tool' || type === 'workflow' || type === 'agent');
        if (actionableHandoffs.length === 0) return false;
        return actionableHandoffs.every((type) => {
            if (type === 'tool') return this._hasToolAuthority;
            if (type === 'workflow') return this._hasWorkflowAuthority;
            return this._hasAgentAuthority;
        });
    }

    private _toTurnOutput(result: PlanExecutionResult): AgentTurnOutput {
        const base = `Plan ${result.planId} execution ${result.status}. ` +
            `completed=${result.completedStageCount}, failed=${result.failedStageCount}, degraded=${result.degradedStageCount}.`;
        const reason = result.reasonCodes.length > 0
            ? ` reasonCodes=${result.reasonCodes.slice(0, 4).join(',')}`
            : '';
        return {
            message: `${base}${reason}`,
            outputChannel: result.status === 'failed' ? 'fallback' : 'chat',
        };
    }
}
