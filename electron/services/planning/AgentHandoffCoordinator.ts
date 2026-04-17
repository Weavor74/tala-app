/**
 * AgentHandoffCoordinator.ts - Execution bridge for PlanningService agent handoffs.
 *
 * Owns local recovery (retry/reroute/degrade) and emits deterministic
 * escalation/replan signals when local recovery is exhausted.
 */

import { TelemetryBus } from '../telemetry/TelemetryBus';
import { PlanningService } from './PlanningService';
import type {
    AgentHandoffFailureCode,
    ExecutionFailureEscalation,
    ExecutionPlan,
    GoalExecutionStyle,
    PlannedAgentInvocation,
} from '../../../shared/planning/PlanningTypes';
import type {
    ExecutionReplanRequest,
    RecoveryActionRecord,
    RecoveryOutcomeStatus,
    StructuredFailure,
} from '../../../shared/runtime/failureRecoveryTypes';
import type { TurnAuthorityEnvelope } from '../../../shared/turnArbitrationTypes';
import {
    FailureSuppressionService,
    buildFailureSignature,
    getDefaultRecoveryPolicy,
    normalizeStructuredFailure,
    selectEquivalentTarget,
} from '../runtime/failures/FailureRecoveryPolicy';

export interface AgentInvocationContext {
    executionId: string;
    executionType: 'planning_handoff';
    executionOrigin: 'planning';
    authorityEnvelope: TurnAuthorityEnvelope;
}

export interface IAgentExecutor {
    executeAgent(
        agentId: string,
        executionMode: GoalExecutionStyle,
        input: Record<string, unknown>,
        ctx?: AgentInvocationContext,
    ): Promise<{ success: boolean; data?: unknown; error?: string; durationMs?: number }>;
}

const VALID_AGENT_EXECUTION_MODES: ReadonlySet<GoalExecutionStyle> = new Set([
    'llm_assisted',
    'hybrid',
]);

export interface AgentPreflightResult {
    passed: boolean;
    failureCode?: AgentHandoffFailureCode;
    details?: string;
    replanAdvised?: boolean;
}

export function runAgentPreflight(
    invocation: PlannedAgentInvocation,
    availableCapabilities: ReadonlySet<string> = new Set(),
): AgentPreflightResult {
    if (!invocation.agentId || invocation.agentId.trim() === '') {
        return {
            passed: false,
            failureCode: 'preflight:invalid_agent_id',
            details: 'agentId is empty or whitespace',
            replanAdvised: false,
        };
    }

    if (!VALID_AGENT_EXECUTION_MODES.has(invocation.executionMode)) {
        return {
            passed: false,
            failureCode: 'preflight:invalid_execution_mode',
            details: `executionMode '${invocation.executionMode}' is not valid for agent handoffs; expected llm_assisted or hybrid`,
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

export interface AgentInvocationResult {
    agentId: string;
    executionMode: GoalExecutionStyle;
    success: boolean;
    data?: unknown;
    error?: string;
    durationMs?: number;
    failureCode?: AgentHandoffFailureCode;
    failureClass?: StructuredFailure['class'];
    recoveryOutcome?: RecoveryOutcomeStatus;
    recoveryAttempts?: number;
    antiThrashSuppressed?: boolean;
    recoveryActions?: RecoveryActionRecord[];
}

export interface AgentDispatchResult {
    planId: string;
    executionBoundaryId: string;
    success: boolean;
    invocation?: AgentInvocationResult;
    error?: string;
    failureCode?: AgentHandoffFailureCode;
    replanAdvised?: boolean;
    replanTrigger?: 'capability_loss' | 'policy_block' | 'dependency_failure';
    recoveryOutcome?: RecoveryOutcomeStatus;
    degradedCompletion?: boolean;
    replanRequest?: ExecutionReplanRequest;
    escalationRequest?: ExecutionFailureEscalation;
}

function mapAgentFailureCode(failure: StructuredFailure): AgentHandoffFailureCode {
    if (
        failure.reasonCode === 'preflight:capability_missing' ||
        failure.reasonCode === 'preflight:invalid_agent_id' ||
        failure.reasonCode === 'preflight:invalid_execution_mode' ||
        failure.reasonCode === 'dispatch:executor_unavailable' ||
        failure.reasonCode === 'execution:agent_failed' ||
        failure.reasonCode === 'execution:timeout' ||
        failure.reasonCode === 'policy:escalation_required'
    ) {
        return failure.reasonCode;
    }
    if (failure.class === 'timeout') return 'execution:timeout';
    if (failure.class === 'policy_blocked') return 'policy:escalation_required';
    if (failure.class === 'dependency_unreachable') return 'dispatch:executor_unavailable';
    return 'execution:agent_failed';
}

export class AgentHandoffCoordinator {
    private readonly _planning: PlanningService;
    private readonly _bus: TelemetryBus;
    private readonly _suppressionTracker: FailureSuppressionService;

    constructor(
        private readonly _agentExecutor: IAgentExecutor,
        suppressionTracker?: FailureSuppressionService,
    ) {
        this._planning = PlanningService.getInstance();
        this._bus = TelemetryBus.getInstance();
        this._suppressionTracker = suppressionTracker ?? new FailureSuppressionService();
    }

    async dispatch(
        planId: string,
        availableCapabilities: ReadonlySet<string> = new Set(),
        authorityEnvelope: TurnAuthorityEnvelope,
    ): Promise<AgentDispatchResult> {
        if (!authorityEnvelope) {
            throw new Error('AGENT_HANDOFF_AUTHORITY_ENVELOPE_REQUIRED');
        }
        if (!authorityEnvelope.workflowAuthority || authorityEnvelope.authorityLevel === 'none') {
            throw new Error(`AGENT_HANDOFF_AUTHORITY_DENIED:${authorityEnvelope.mode}`);
        }
        const plan = this._planning.getPlan(planId);
        if (!plan) {
            throw new Error(`AgentHandoffCoordinator: plan not found: ${planId}`);
        }

        if (plan.handoff.type !== 'agent') {
            throw new Error(
                `AgentHandoffCoordinator: only 'agent' handoff type is supported` +
                ` (plan ${planId} has type '${plan.handoff.type}')`,
            );
        }

        const executingPlan = this._planning.markExecutionStarted(planId);
        const executionBoundaryId = executingPlan.executionBoundaryId ?? `exec-fallback-${planId}`;

        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.agent_handoff_dispatched',
            payload: {
                planId,
                goalId: plan.goalId,
                executionBoundaryId,
                handoffType: 'agent',
                agentId: plan.handoff.invocation.agentId,
                executionMode: plan.handoff.invocation.executionMode,
            },
        });

        const { invocation, sharedInputs } = plan.handoff;

        const preflightResult = runAgentPreflight(invocation, availableCapabilities);
        if (!preflightResult.passed) {
            const failureMsg = `preflight failed for agent invocation (${invocation.agentId}): ${preflightResult.details ?? preflightResult.failureCode}`;
            this._emitPreflightFailed(plan, executionBoundaryId, invocation, preflightResult);
            this._planning.markExecutionFailed(planId, failureMsg);
            this._emitDispatchFailed(
                plan,
                executionBoundaryId,
                failureMsg,
                preflightResult.failureCode,
                preflightResult.replanAdvised,
            );
            return {
                planId,
                executionBoundaryId,
                success: false,
                error: failureMsg,
                failureCode: preflightResult.failureCode,
                replanAdvised: preflightResult.replanAdvised,
                replanTrigger: preflightResult.replanAdvised ? 'capability_loss' : undefined,
                recoveryOutcome: 'terminal_failure',
                degradedCompletion: false,
            };
        }

        try {
            const invocationResult = await this._executeInvocation(
                invocation,
                sharedInputs,
                executionBoundaryId,
                plan,
                authorityEnvelope,
            );

            if (!invocationResult.success) {
                if (invocationResult.recoveryOutcome === 'escalation_required' || invocation.failurePolicy === 'escalate') {
                    const escalateMsg = `Agent invocation (${invocation.agentId}) requires operator escalation`;
                    this._planning.markExecutionFailed(planId, escalateMsg);
                    const escalationRequest: ExecutionFailureEscalation = {
                        planId,
                        goalId: plan.goalId,
                        executionBoundaryId,
                        failedStepId: '0',
                        failure: {
                            class: invocationResult.failureClass ?? 'unknown',
                            reasonCode: invocationResult.failureCode ?? 'policy:escalation_required',
                            retryable: false,
                            transient: false,
                            recoverable: false,
                            operatorActionRequired: true,
                            scope: 'service',
                            message: escalateMsg,
                            stepId: '0',
                            providerId: invocationResult.agentId,
                        },
                        reasonCode: invocationResult.failureCode ?? 'policy:escalation_required',
                        attemptsMade: invocationResult.recoveryAttempts ?? 1,
                        recoveryActionsTried: invocationResult.recoveryActions ?? [],
                        degradedOutputsExist: false,
                        suggestedAdaptation: 'request_operator_action',
                    };
                    this._bus.emit({
                        executionId: plan.goalId,
                        subsystem: 'planning',
                        event: 'execution.escalation_requested',
                        payload: escalationRequest as unknown as Record<string, unknown>,
                    });
                    this._emitDispatchFailed(
                        plan,
                        executionBoundaryId,
                        escalateMsg,
                        'policy:escalation_required',
                        true,
                        invocationResult,
                    );
                    this._bus.emit({
                        executionId: plan.goalId,
                        subsystem: 'planning',
                        event: 'execution.recovery_exhausted',
                        payload: {
                            planId,
                            goalId: plan.goalId,
                            executionBoundaryId,
                            handoffType: 'agent',
                            agentId: invocationResult.agentId,
                            failureClass: invocationResult.failureClass,
                            reasonCode: invocationResult.failureCode,
                            recoveryAttempts: invocationResult.recoveryAttempts,
                            antiThrashSuppressed: invocationResult.antiThrashSuppressed,
                        },
                    });
                    return {
                        planId,
                        executionBoundaryId,
                        success: false,
                        invocation: invocationResult,
                        error: escalateMsg,
                        failureCode: 'policy:escalation_required',
                        replanAdvised: true,
                        replanTrigger: 'policy_block',
                        recoveryOutcome: 'escalation_required',
                        degradedCompletion: false,
                        escalationRequest,
                    };
                }

                if (invocation.failurePolicy === 'stop') {
                    const failureMsg = invocationResult.error ?? `Agent invocation (${invocation.agentId}) failed`;
                    this._planning.markExecutionFailed(planId, failureMsg);
                    let replanRequest: ExecutionReplanRequest | undefined;
                    if (invocationResult.recoveryOutcome === 'replan_required') {
                        replanRequest = {
                            goalId: plan.goalId,
                            planId,
                            executionBoundaryId,
                            failedStepId: '0',
                            failedTargetId: invocationResult.agentId,
                            failure: {
                                class: invocationResult.failureClass ?? 'unknown',
                                reasonCode: invocationResult.failureCode ?? 'execution:agent_failed',
                                retryable: false,
                                transient: false,
                                recoverable: false,
                                operatorActionRequired: false,
                                scope: 'service',
                                message: failureMsg,
                                stepId: '0',
                                providerId: invocationResult.agentId,
                            },
                            attemptsMade: invocationResult.recoveryAttempts ?? 1,
                            recoveryActionsTried: invocationResult.recoveryActions ?? [],
                            degradedOutputsExist: false,
                            reasonCode: invocationResult.failureCode ?? 'execution:agent_failed',
                            suggestedAdaptation: 'choose_alternate_path',
                        };
                        this._bus.emit({
                            executionId: plan.goalId,
                            subsystem: 'planning',
                            event: 'execution.replan_requested',
                            payload: replanRequest as unknown as Record<string, unknown>,
                        });
                    }
                    this._emitDispatchFailed(
                        plan,
                        executionBoundaryId,
                        failureMsg,
                        invocationResult.failureCode ?? 'execution:agent_failed',
                        invocationResult.recoveryOutcome === 'replan_required',
                        invocationResult,
                    );
                    this._bus.emit({
                        executionId: plan.goalId,
                        subsystem: 'planning',
                        event: 'execution.recovery_exhausted',
                        payload: {
                            planId,
                            goalId: plan.goalId,
                            executionBoundaryId,
                            handoffType: 'agent',
                            agentId: invocationResult.agentId,
                            failureClass: invocationResult.failureClass,
                            reasonCode: invocationResult.failureCode,
                            recoveryAttempts: invocationResult.recoveryAttempts,
                            antiThrashSuppressed: invocationResult.antiThrashSuppressed,
                        },
                    });
                    return {
                        planId,
                        executionBoundaryId,
                        success: false,
                        invocation: invocationResult,
                        error: failureMsg,
                        failureCode: invocationResult.failureCode ?? 'execution:agent_failed',
                        replanAdvised: invocationResult.recoveryOutcome === 'replan_required',
                        replanTrigger: invocationResult.recoveryOutcome === 'replan_required' ? 'dependency_failure' : undefined,
                        recoveryOutcome: invocationResult.recoveryOutcome ?? 'terminal_failure',
                        degradedCompletion: false,
                        replanRequest,
                    };
                }
            }

            this._planning.markExecutionCompleted(planId);
            if (invocationResult.recoveryOutcome === 'degraded_but_completed') {
                this._bus.emit({
                    executionId: plan.goalId,
                    subsystem: 'planning',
                    event: 'execution.degraded_completed',
                    payload: {
                        planId,
                        goalId: plan.goalId,
                        executionBoundaryId,
                        handoffType: 'agent',
                        agentId: invocationResult.agentId,
                    },
                });
            }

            const completedAt = new Date().toISOString();
            this._bus.emit({
                executionId: plan.goalId,
                subsystem: 'planning',
                event: 'planning.agent_handoff_completed',
                payload: {
                    planId,
                    goalId: plan.goalId,
                    executionBoundaryId,
                    handoffType: 'agent',
                    agentId: invocation.agentId,
                    degradedCompletion: invocationResult.recoveryOutcome === 'degraded_but_completed',
                    completedAt,
                },
            });
            return {
                planId,
                executionBoundaryId,
                success: invocationResult.success,
                invocation: invocationResult,
                recoveryOutcome: invocationResult.recoveryOutcome,
                degradedCompletion: invocationResult.recoveryOutcome === 'degraded_but_completed',
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this._planning.markExecutionFailed(planId, message);
            this._emitDispatchFailed(plan, executionBoundaryId, message, 'dispatch:executor_unavailable');
            return {
                planId,
                executionBoundaryId,
                success: false,
                error: message,
                failureCode: 'dispatch:executor_unavailable',
                recoveryOutcome: 'terminal_failure',
                degradedCompletion: false,
            };
        }
    }

    private async _executeInvocation(
        invocation: PlannedAgentInvocation,
        sharedInputs: Record<string, unknown>,
        executionBoundaryId: string,
        plan: ExecutionPlan,
        authorityEnvelope: TurnAuthorityEnvelope,
    ): Promise<AgentInvocationResult> {
        const mergedInput: Record<string, unknown> = { ...sharedInputs, ...invocation.input };
        const ctx: AgentInvocationContext = {
            executionId: executionBoundaryId,
            executionType: 'planning_handoff',
            executionOrigin: 'planning',
            authorityEnvelope,
        };

        const candidates = [invocation.agentId, ...selectEquivalentTarget(invocation.agentId, invocation.equivalentAgentIds)];
        const actions: RecoveryActionRecord[] = [];
        let attempts = 0;
        let antiThrashSuppressed = false;
        let lastFailure: StructuredFailure | undefined;
        let lastError = '';

        for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
            const agentId = candidates[candidateIndex];
            if (candidateIndex > 0) {
                actions.push({
                    action: 'reroute',
                    attempt: attempts + 1,
                    targetId: agentId,
                    reasonCode: 'reroute:selected_equivalent_agent',
                });
                this._bus.emit({
                    executionId: plan.goalId,
                    subsystem: 'planning',
                    event: 'execution.recovery_reroute_selected',
                    payload: {
                        planId: plan.id,
                        goalId: plan.goalId,
                        executionBoundaryId,
                        originalAgentId: invocation.agentId,
                        rerouteAgentId: agentId,
                    },
                });
            }

            let candidateAttempts = 0;
            while (true) {
                attempts += 1;
                candidateAttempts += 1;
                this._bus.emit({
                    executionId: plan.goalId,
                    subsystem: 'planning',
                    event: 'execution.recovery_attempted',
                    payload: {
                        planId: plan.id,
                        goalId: plan.goalId,
                        executionBoundaryId,
                        agentId,
                        attempt: attempts,
                    },
                });

                try {
                    const result = await this._agentExecutor.executeAgent(
                        agentId,
                        invocation.executionMode,
                        mergedInput,
                        ctx,
                    );
                    if (result.success) {
                        const recoveryOutcome: RecoveryOutcomeStatus =
                            candidateIndex > 0
                                ? 'recovered_by_reroute'
                                : attempts > 1
                                    ? 'recovered_by_retry'
                                    : undefined;
                        if (recoveryOutcome) {
                            this._bus.emit({
                                executionId: plan.goalId,
                                subsystem: 'planning',
                                event: 'execution.recovery_succeeded',
                                payload: {
                                    planId: plan.id,
                                    goalId: plan.goalId,
                                    executionBoundaryId,
                                    agentId,
                                    recoveryOutcome,
                                    recoveryAttempts: attempts,
                                },
                            });
                        }
                        return {
                            agentId,
                            executionMode: invocation.executionMode,
                            success: true,
                            data: result.data,
                            durationMs: result.durationMs,
                            recoveryOutcome,
                            recoveryAttempts: attempts,
                            antiThrashSuppressed,
                            recoveryActions: actions,
                        };
                    }

                    lastError = result.error ?? `Agent invocation (${agentId}) failed`;
                    lastFailure = normalizeStructuredFailure({
                        error: new Error(lastError),
                        scope: 'service',
                        reasonCodeFallback: 'execution:agent_failed',
                        messageFallback: lastError,
                        providerId: agentId,
                        stepId: '0',
                    });
                } catch (err) {
                    lastError = err instanceof Error ? err.message : String(err);
                    this._bus.emit({
                        executionId: plan.goalId,
                        subsystem: 'planning',
                        event: 'planning.agent_handoff_invocation_failed',
                        payload: {
                            planId: plan.id,
                            goalId: plan.goalId,
                            executionBoundaryId,
                            agentId,
                            failureCode: 'dispatch:executor_unavailable',
                            error: lastError,
                        },
                    });
                    lastFailure = normalizeStructuredFailure({
                        error: err,
                        scope: 'service',
                        reasonCodeFallback: 'dispatch:executor_unavailable',
                        messageFallback: lastError,
                        providerId: agentId,
                        stepId: '0',
                    });
                }

                if (!lastFailure) break;

                this._bus.emit({
                    executionId: plan.goalId,
                    subsystem: 'planning',
                    event: 'execution.failure_normalized',
                    payload: {
                        planId: plan.id,
                        goalId: plan.goalId,
                        executionBoundaryId,
                        agentId,
                        failureClass: lastFailure.class,
                        reasonCode: lastFailure.reasonCode,
                    },
                });

                const policy = getDefaultRecoveryPolicy(lastFailure.class);
                const signature = buildFailureSignature({
                    targetId: agentId,
                    failure: lastFailure,
                    stepType: 'agent',
                });
                const suppression = this._suppressionTracker.record(signature);
                antiThrashSuppressed = antiThrashSuppressed || suppression.suppressed;

                const canRetry =
                    invocation.failurePolicy === 'retry' &&
                    policy.allowRetry &&
                    candidateAttempts <= policy.maxRetries &&
                    !suppression.suppressed;

                if (canRetry) {
                    const backoffMs = policy.backoffMsByAttempt[candidateAttempts - 1] ?? 0;
                    actions.push({
                        action: 'retry',
                        attempt: attempts,
                        targetId: agentId,
                        reasonCode: lastFailure.reasonCode,
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
                            agentId,
                            attempt: attempts,
                            backoffMs,
                            failureClass: lastFailure.class,
                            reasonCode: lastFailure.reasonCode,
                        },
                    });
                    if (backoffMs > 0) {
                        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
                    }
                    continue;
                }

                break;
            }

            if (!lastFailure) continue;

            const policy = getDefaultRecoveryPolicy(lastFailure.class);
            const hasNext = candidateIndex < candidates.length - 1;
            if (policy.allowReroute && hasNext && lastFailure.class !== 'policy_blocked') {
                continue;
            }

            const degradedAllowed = policy.degradeAllowed && (invocation.degradeAllowed === true || invocation.failurePolicy === 'skip');
            if (degradedAllowed) {
                actions.push({
                    action: 'degrade',
                    attempt: attempts,
                    targetId: agentId,
                    reasonCode: lastFailure.reasonCode,
                });
                return {
                    agentId,
                    executionMode: invocation.executionMode,
                    success: false,
                    error: lastError,
                    failureCode: mapAgentFailureCode(lastFailure),
                    failureClass: lastFailure.class,
                    recoveryOutcome: 'degraded_but_completed',
                    recoveryAttempts: attempts,
                    antiThrashSuppressed,
                    recoveryActions: actions,
                };
            }

            const escalationRequired = invocation.failurePolicy === 'escalate' || lastFailure.operatorActionRequired;
            const outcome: RecoveryOutcomeStatus =
                escalationRequired
                    ? 'escalation_required'
                    : policy.allowReplan
                        ? 'replan_required'
                        : 'terminal_failure';

            if (outcome === 'escalation_required') {
                actions.push({ action: 'escalate', attempt: attempts, targetId: agentId, reasonCode: lastFailure.reasonCode });
            } else if (outcome === 'replan_required') {
                actions.push({ action: 'replan', attempt: attempts, targetId: agentId, reasonCode: lastFailure.reasonCode });
            }

            return {
                agentId,
                executionMode: invocation.executionMode,
                success: false,
                error: lastError,
                failureCode: mapAgentFailureCode(lastFailure),
                failureClass: lastFailure.class,
                recoveryOutcome: outcome,
                recoveryAttempts: attempts,
                antiThrashSuppressed,
                recoveryActions: actions,
            };
        }

        return {
            agentId: invocation.agentId,
            executionMode: invocation.executionMode,
            success: false,
            error: lastError || `Agent invocation (${invocation.agentId}) failed`,
            failureCode: lastFailure ? mapAgentFailureCode(lastFailure) : 'execution:agent_failed',
            failureClass: lastFailure?.class ?? 'unknown',
            recoveryOutcome: 'terminal_failure',
            recoveryAttempts: attempts,
            antiThrashSuppressed,
            recoveryActions: actions,
        };
    }

    private _emitPreflightFailed(
        plan: ExecutionPlan,
        executionBoundaryId: string,
        invocation: PlannedAgentInvocation,
        preflightResult: AgentPreflightResult,
    ): void {
        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.agent_handoff_preflight_failed',
            payload: {
                planId: plan.id,
                goalId: plan.goalId,
                executionBoundaryId,
                agentId: invocation.agentId,
                executionMode: invocation.executionMode,
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
        failureCode?: AgentHandoffFailureCode,
        replanAdvised?: boolean,
        invocationResult?: AgentInvocationResult,
    ): void {
        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.agent_handoff_dispatch_failed',
            payload: {
                planId: plan.id,
                goalId: plan.goalId,
                executionBoundaryId,
                handoffType: 'agent',
                failureCode,
                replanAdvised: replanAdvised ?? false,
                failureClass: invocationResult?.failureClass,
                recoveryOutcome: invocationResult?.recoveryOutcome,
                recoveryAttempts: invocationResult?.recoveryAttempts,
                antiThrashSuppressed: invocationResult?.antiThrashSuppressed,
                error,
            },
        });
    }
}

