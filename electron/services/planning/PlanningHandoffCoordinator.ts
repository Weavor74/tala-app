/**
 * PlanningHandoffCoordinator.ts - Tool handoff execution bridge for PlanningService.
 *
 * This coordinator owns local step recovery (retry/reroute/degrade) and emits
 * explicit replan/escalation signals when local recovery is exhausted.
 */

import { TelemetryBus } from '../telemetry/TelemetryBus';
import { PlanningService } from './PlanningService';
import type {
    ExecutionFailureEscalation,
    ExecutionPlan,
    PlannedToolInvocation,
} from '../../../shared/planning/PlanningTypes';
import type {
    ExecutionReplanRequest,
    RecoveryActionRecord,
    RecoveryOutcomeStatus,
    StructuredFailure,
} from '../../../shared/runtime/failureRecoveryTypes';
import type { ToolInvocationContext } from '../tools/ToolExecutionCoordinator';
import {
    FailureSuppressionService,
    buildFailureSignature,
    getDefaultRecoveryPolicy,
    normalizeStructuredFailure,
    selectEquivalentTarget,
} from '../runtime/failures/FailureRecoveryPolicy';

/**
 * Minimal interface for the tool execution authority.
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
    attemptedToolId: string;
    success: boolean;
    data?: unknown;
    error?: string;
    durationMs?: number;
    failureCode?: string;
    failureClass?: StructuredFailure['class'];
    recoveryOutcome: RecoveryOutcomeStatus;
    recoveryAttempts: number;
    degradedCompletion: boolean;
    antiThrashSuppressed: boolean;
    recoveryActions: RecoveryActionRecord[];
}

/** Result of a full plan dispatch. */
export interface PlanDispatchResult {
    planId: string;
    executionBoundaryId: string;
    success: boolean;
    steps: StepDispatchResult[];
    error?: string;
    recoveryOutcome: RecoveryOutcomeStatus;
    degradedCompletion: boolean;
    replanRequest?: ExecutionReplanRequest;
    escalationRequest?: ExecutionFailureEscalation;
}

export class PlanningHandoffCoordinator {
    private readonly _planning: PlanningService;
    private readonly _bus: TelemetryBus;
    private readonly _suppressionTracker: FailureSuppressionService;

    constructor(
        private readonly _toolExecutor: IToolExecutor,
        suppressionTracker?: FailureSuppressionService,
    ) {
        this._planning = PlanningService.getInstance();
        this._bus = TelemetryBus.getInstance();
        this._suppressionTracker = suppressionTracker ?? new FailureSuppressionService();
    }

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
        let degradedCompletion = false;

        try {
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                const result = await this._executeStepWithRecovery(
                    step,
                    i,
                    sharedInputs,
                    executionBoundaryId,
                    plan,
                );
                stepResults.push(result);
                degradedCompletion = degradedCompletion || result.degradedCompletion;

                if (!result.success) {
                    if (step.failurePolicy === 'escalate' || result.recoveryOutcome === 'escalation_required') {
                        return await this._failDispatchWithEscalation(plan, executionBoundaryId, result, stepResults, degradedCompletion);
                    }
                    if (step.failurePolicy === 'stop') {
                        return await this._failDispatch(plan, executionBoundaryId, result, stepResults, degradedCompletion);
                    }
                }
            }

            this._planning.markExecutionCompleted(planId);
            if (degradedCompletion) {
                this._bus.emit({
                    executionId: plan.goalId,
                    subsystem: 'planning',
                    event: 'execution.degraded_completed',
                    payload: {
                        planId: plan.id,
                        goalId: plan.goalId,
                        executionBoundaryId,
                        handoffType: 'tool',
                    },
                });
            }

            return {
                planId,
                executionBoundaryId,
                success: true,
                steps: stepResults,
                recoveryOutcome: degradedCompletion ? 'degraded_but_completed' : 'recovered_by_retry',
                degradedCompletion,
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this._planning.markExecutionFailed(planId, message);
            this._emitDispatchFailed(plan, executionBoundaryId, message);
            return {
                planId,
                executionBoundaryId,
                success: false,
                steps: stepResults,
                error: message,
                recoveryOutcome: 'terminal_failure',
                degradedCompletion,
            };
        }
    }

    private async _executeStepWithRecovery(
        step: PlannedToolInvocation,
        stepIndex: number,
        sharedInputs: Record<string, unknown>,
        executionBoundaryId: string,
        plan: ExecutionPlan,
    ): Promise<StepDispatchResult> {
        const mergedInput: Record<string, unknown> = { ...sharedInputs, ...step.input };
        const candidateTools = [step.toolId, ...selectEquivalentTarget(step.toolId, step.equivalentToolIds)];

        const actions: RecoveryActionRecord[] = [];
        let attempts = 0;
        let lastFailure: StructuredFailure | undefined;
        let lastError = '';
        let antiThrashSuppressed = false;

        for (let candidateIndex = 0; candidateIndex < candidateTools.length; candidateIndex++) {
            const candidateToolId = candidateTools[candidateIndex];
            if (candidateIndex > 0) {
                actions.push({
                    action: 'reroute',
                    attempt: attempts + 1,
                    targetId: candidateToolId,
                    reasonCode: 'reroute:selected_equivalent_tool',
                });
                this._bus.emit({
                    executionId: plan.goalId,
                    subsystem: 'planning',
                    event: 'execution.recovery_reroute_selected',
                    payload: {
                        planId: plan.id,
                        goalId: plan.goalId,
                        executionBoundaryId,
                        stepIndex,
                        originalToolId: step.toolId,
                        rerouteToolId: candidateToolId,
                    },
                });
            }

            let targetAttempts = 0;
            while (true) {
                attempts += 1;
                targetAttempts += 1;
                this._bus.emit({
                    executionId: plan.goalId,
                    subsystem: 'planning',
                    event: 'execution.recovery_attempted',
                    payload: {
                        planId: plan.id,
                        goalId: plan.goalId,
                        executionBoundaryId,
                        stepIndex,
                        toolId: candidateToolId,
                        attempt: attempts,
                    },
                });

                const single = await this._executeToolOnce(
                    candidateToolId,
                    mergedInput,
                    executionBoundaryId,
                );
                if (single.success) {
                    const recoveryOutcome: RecoveryOutcomeStatus =
                        candidateIndex > 0 ? 'recovered_by_reroute'
                        : attempts > 1 ? 'recovered_by_retry'
                        : 'recovered_by_retry';
                    if (attempts > 1 || candidateIndex > 0) {
                        this._bus.emit({
                            executionId: plan.goalId,
                            subsystem: 'planning',
                            event: 'execution.recovery_succeeded',
                            payload: {
                                planId: plan.id,
                                goalId: plan.goalId,
                                executionBoundaryId,
                                stepIndex,
                                toolId: candidateToolId,
                                recoveryOutcome,
                                recoveryAttempts: attempts,
                            },
                        });
                    }

                    return {
                        stepIndex,
                        toolId: step.toolId,
                        attemptedToolId: candidateToolId,
                        success: true,
                        data: single.data,
                        durationMs: single.durationMs,
                        recoveryOutcome,
                        recoveryAttempts: attempts,
                        degradedCompletion: false,
                        antiThrashSuppressed,
                        recoveryActions: actions,
                    };
                }

                lastError = single.error ?? `step ${stepIndex} (${candidateToolId}) failed`;
                const failure = normalizeStructuredFailure({
                    error: single.errorObject ?? new Error(lastError),
                    scope: 'tool',
                    reasonCodeFallback: 'execution:tool_failed',
                    messageFallback: lastError,
                    toolId: candidateToolId,
                    stepId: String(stepIndex),
                    metadata: {
                        planId: plan.id,
                        goalId: plan.goalId,
                    },
                });
                lastFailure = failure;

                this._bus.emit({
                    executionId: plan.goalId,
                    subsystem: 'planning',
                    event: 'execution.failure_normalized',
                    payload: {
                        planId: plan.id,
                        goalId: plan.goalId,
                        executionBoundaryId,
                        stepIndex,
                        toolId: candidateToolId,
                        failureClass: failure.class,
                        reasonCode: failure.reasonCode,
                        message: failure.message,
                    },
                });

                const policy = getDefaultRecoveryPolicy(failure.class);
                const signature = buildFailureSignature({
                    targetId: candidateToolId,
                    failure,
                    stepType: 'tool',
                });
                const suppression = this._suppressionTracker.record(signature);
                antiThrashSuppressed = antiThrashSuppressed || suppression.suppressed;

                const canRetry =
                    step.failurePolicy === 'retry' &&
                    policy.allowRetry &&
                    targetAttempts <= policy.maxRetries &&
                    !suppression.suppressed;

                if (canRetry) {
                    const backoffMs = policy.backoffMsByAttempt[targetAttempts - 1] ?? 0;
                    actions.push({
                        action: 'retry',
                        attempt: attempts,
                        targetId: candidateToolId,
                        reasonCode: failure.reasonCode,
                        detail: `backoff_ms:${backoffMs}`,
                    });
                    this._bus.emit({
                        executionId: plan.goalId,
                        subsystem: 'planning',
                        event: 'execution.recovery_retry_scheduled',
                        payload: {
                            planId: plan.id,
                            goalId: plan.goalId,
                            executionBoundaryId,
                            stepIndex,
                            toolId: candidateToolId,
                            attempt: attempts,
                            backoffMs,
                            failureClass: failure.class,
                            reasonCode: failure.reasonCode,
                        },
                    });
                    if (backoffMs > 0) {
                        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
                    }
                    continue;
                }

                if (suppression.suppressed) {
                    actions.push({
                        action: 'none',
                        attempt: attempts,
                        targetId: candidateToolId,
                        reasonCode: 'recovery:suppressed_repeated_failure',
                        detail: `suppressed_until:${suppression.suppressedUntilMs ?? 0}`,
                    });
                }

                break;
            }

            if (!lastFailure) {
                continue;
            }
            const policy = getDefaultRecoveryPolicy(lastFailure.class);
            const hasNextCandidate = candidateIndex < candidateTools.length - 1;
            const canReroute = policy.allowReroute && hasNextCandidate && lastFailure.class !== 'policy_blocked';
            if (canReroute) {
                continue;
            }

            const degradedAllowed = policy.degradeAllowed && (step.degradeAllowed === true || step.failurePolicy === 'skip');
            if (degradedAllowed) {
                actions.push({
                    action: 'degrade',
                    attempt: attempts,
                    targetId: candidateToolId,
                    reasonCode: lastFailure.reasonCode,
                });
                return {
                    stepIndex,
                    toolId: step.toolId,
                    attemptedToolId: candidateToolId,
                    success: false,
                    error: lastError,
                    failureCode: lastFailure.reasonCode,
                    failureClass: lastFailure.class,
                    recoveryOutcome: 'degraded_but_completed',
                    recoveryAttempts: attempts,
                    degradedCompletion: true,
                    antiThrashSuppressed,
                    recoveryActions: actions,
                };
            }

            const escalationRequired = step.failurePolicy === 'escalate' || lastFailure.operatorActionRequired;
            const outcome: RecoveryOutcomeStatus =
                escalationRequired
                    ? 'escalation_required'
                    : policy.allowReplan
                        ? 'replan_required'
                        : 'terminal_failure';

            if (outcome === 'escalation_required') {
                actions.push({
                    action: 'escalate',
                    attempt: attempts,
                    targetId: candidateToolId,
                    reasonCode: lastFailure.reasonCode,
                });
            } else if (outcome === 'replan_required') {
                actions.push({
                    action: 'replan',
                    attempt: attempts,
                    targetId: candidateToolId,
                    reasonCode: lastFailure.reasonCode,
                });
            }

            return {
                stepIndex,
                toolId: step.toolId,
                attemptedToolId: candidateToolId,
                success: false,
                error: lastError,
                failureCode: lastFailure.reasonCode,
                failureClass: lastFailure.class,
                recoveryOutcome: outcome,
                recoveryAttempts: attempts,
                degradedCompletion: false,
                antiThrashSuppressed,
                recoveryActions: actions,
            };
        }

        return {
            stepIndex,
            toolId: step.toolId,
            attemptedToolId: step.toolId,
            success: false,
            error: lastError || `Step ${stepIndex} (${step.toolId}) failed`,
            failureCode: lastFailure?.reasonCode ?? 'execution:tool_failed',
            failureClass: lastFailure?.class ?? 'unknown',
            recoveryOutcome: 'terminal_failure',
            recoveryAttempts: attempts,
            degradedCompletion: false,
            antiThrashSuppressed,
            recoveryActions: actions,
        };
    }

    private async _executeToolOnce(
        toolId: string,
        input: Record<string, unknown>,
        executionBoundaryId: string,
    ): Promise<{
        success: boolean;
        data?: unknown;
        durationMs?: number;
        error?: string;
        errorObject?: unknown;
    }> {
        const ctx: ToolInvocationContext = {
            executionId: executionBoundaryId,
            executionType: 'planning_handoff',
            executionOrigin: 'planning',
        };
        try {
            const result = await this._toolExecutor.executeTool(toolId, input, undefined, ctx);
            if (result.success) {
                return {
                    success: true,
                    data: result.data,
                    durationMs: result.durationMs,
                };
            }
            const err = result.error ?? `Tool step returned success=false for ${toolId}`;
            return {
                success: false,
                error: err,
                errorObject: new Error(err),
                durationMs: result.durationMs,
            };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
                errorObject: err,
            };
        }
    }

    private async _failDispatch(
        plan: ExecutionPlan,
        executionBoundaryId: string,
        failingStep: StepDispatchResult,
        stepResults: StepDispatchResult[],
        degradedCompletion: boolean,
    ): Promise<PlanDispatchResult> {
        const error = failingStep.error ?? `Step ${failingStep.stepIndex} (${failingStep.toolId}) failed`;
        this._planning.markExecutionFailed(plan.id, error);
        this._emitDispatchFailed(plan, executionBoundaryId, error, failingStep);

        let replanRequest: ExecutionReplanRequest | undefined;
        if (failingStep.recoveryOutcome === 'replan_required') {
            replanRequest = {
                goalId: plan.goalId,
                planId: plan.id,
                executionBoundaryId,
                failedStepId: String(failingStep.stepIndex),
                failedTargetId: failingStep.attemptedToolId,
                failure: {
                    class: failingStep.failureClass ?? 'unknown',
                    reasonCode: failingStep.failureCode ?? 'execution:tool_failed',
                    retryable: false,
                    transient: false,
                    recoverable: false,
                    operatorActionRequired: false,
                    scope: 'tool',
                    message: error,
                    toolId: failingStep.attemptedToolId,
                    stepId: String(failingStep.stepIndex),
                },
                attemptsMade: failingStep.recoveryAttempts,
                recoveryActionsTried: failingStep.recoveryActions,
                degradedOutputsExist: degradedCompletion,
                reasonCode: failingStep.failureCode ?? 'execution:tool_failed',
                suggestedAdaptation: 'choose_alternate_path',
            };
            this._bus.emit({
                executionId: plan.goalId,
                subsystem: 'planning',
                event: 'execution.replan_requested',
                payload: replanRequest as unknown as Record<string, unknown>,
            });
        }

        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'execution.recovery_exhausted',
            payload: {
                planId: plan.id,
                goalId: plan.goalId,
                executionBoundaryId,
                handoffType: 'tool',
                stepIndex: failingStep.stepIndex,
                toolId: failingStep.attemptedToolId,
                failureClass: failingStep.failureClass,
                reasonCode: failingStep.failureCode,
                recoveryAttempts: failingStep.recoveryAttempts,
                antiThrashSuppressed: failingStep.antiThrashSuppressed,
            },
        });

        return {
            planId: plan.id,
            executionBoundaryId,
            success: false,
            steps: stepResults,
            error,
            recoveryOutcome: failingStep.recoveryOutcome,
            degradedCompletion,
            replanRequest,
        };
    }

    private async _failDispatchWithEscalation(
        plan: ExecutionPlan,
        executionBoundaryId: string,
        failingStep: StepDispatchResult,
        stepResults: StepDispatchResult[],
        degradedCompletion: boolean,
    ): Promise<PlanDispatchResult> {
        const error = failingStep.error ?? `Step ${failingStep.stepIndex} (${failingStep.toolId}) requires escalation`;
        this._planning.markExecutionFailed(plan.id, error);
        this._emitDispatchFailed(plan, executionBoundaryId, error, failingStep);

        const escalationRequest: ExecutionFailureEscalation = {
            planId: plan.id,
            goalId: plan.goalId,
            executionBoundaryId,
            failedStepId: String(failingStep.stepIndex),
            failure: {
                class: failingStep.failureClass ?? 'unknown',
                reasonCode: failingStep.failureCode ?? 'policy:escalation_required',
                retryable: false,
                transient: false,
                recoverable: false,
                operatorActionRequired: true,
                scope: 'tool',
                message: error,
                toolId: failingStep.attemptedToolId,
                stepId: String(failingStep.stepIndex),
            },
            reasonCode: failingStep.failureCode ?? 'policy:escalation_required',
            attemptsMade: failingStep.recoveryAttempts,
            recoveryActionsTried: failingStep.recoveryActions,
            degradedOutputsExist: degradedCompletion,
            suggestedAdaptation: 'request_operator_action',
        };
        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'execution.escalation_requested',
            payload: escalationRequest as unknown as Record<string, unknown>,
        });
        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'execution.recovery_exhausted',
            payload: {
                planId: plan.id,
                goalId: plan.goalId,
                executionBoundaryId,
                handoffType: 'tool',
                stepIndex: failingStep.stepIndex,
                toolId: failingStep.attemptedToolId,
                failureClass: failingStep.failureClass,
                reasonCode: failingStep.failureCode,
                recoveryAttempts: failingStep.recoveryAttempts,
                antiThrashSuppressed: failingStep.antiThrashSuppressed,
            },
        });

        return {
            planId: plan.id,
            executionBoundaryId,
            success: false,
            steps: stepResults,
            error,
            recoveryOutcome: 'escalation_required',
            degradedCompletion,
            escalationRequest,
        };
    }

    private _emitDispatchFailed(
        plan: ExecutionPlan,
        executionBoundaryId: string,
        error: string,
        failingStep?: StepDispatchResult,
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
                failureCode: failingStep?.failureCode,
                failureClass: failingStep?.failureClass,
                recoveryOutcome: failingStep?.recoveryOutcome,
                recoveryAttempts: failingStep?.recoveryAttempts,
                antiThrashSuppressed: failingStep?.antiThrashSuppressed,
                replanAdvised: failingStep?.recoveryOutcome === 'replan_required',
            },
        });
    }
}
