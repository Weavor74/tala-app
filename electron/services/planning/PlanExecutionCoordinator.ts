import { TelemetryBus } from '../telemetry/TelemetryBus';
import type {
    ExecutionPlan,
    PlanExecutionResult,
    PlanFailurePolicy,
    PlanStage,
    PlanStageExecutionResult,
    PlanStageExecutionStatus,
    PlanStageHandoff,
    PlannedToolInvocation,
    StageFailurePolicy,
} from '../../../shared/planning/PlanningTypes';
import type { TurnAuthorityEnvelope } from '../../../shared/turnArbitrationTypes';
import type { ToolInvocationContext, ToolInvocationResult } from '../tools/ToolExecutionCoordinator';

export interface PlanToolExecutionAuthority {
    executeTool(
        name: string,
        args: Record<string, unknown>,
        allowedNames?: ReadonlySet<string>,
        ctx?: ToolInvocationContext,
    ): Promise<ToolInvocationResult>;
}

export interface PlanWorkflowExecutionAuthority {
    executeWorkflow(
        workflowId: string,
        input: Record<string, unknown>,
        context?: { executionId?: string; authorityEnvelope?: TurnAuthorityEnvelope },
    ): Promise<{ success: boolean; data?: unknown; error?: string; durationMs?: number }>;
}

export interface PlanAgentExecutionAuthority {
    executeAgent(
        agentId: string,
        input: Record<string, unknown>,
        context?: { executionId?: string; authorityEnvelope?: TurnAuthorityEnvelope },
    ): Promise<{ success: boolean; data?: unknown; error?: string; durationMs?: number }>;
}

export interface PlanExecutionContext {
    executionId: string;
    authorityEnvelope?: TurnAuthorityEnvelope;
    onEvent?: (type: string, data: unknown) => void;
}

type PlanExecutionTelemetryEvent =
    | 'planning.plan_execution_started'
    | 'planning.plan_stage_started'
    | 'planning.plan_stage_completed'
    | 'planning.plan_stage_failed'
    | 'planning.plan_execution_completed'
    | 'planning.plan_execution_failed';

type StageExecutionDispatch = {
    status: PlanStageExecutionStatus;
    outputs?: Record<string, unknown>;
    reasonCodes: string[];
    failureReason?: string;
    attempts: number;
};

export class PlanExecutionCoordinator {
    private readonly _bus = TelemetryBus.getInstance();

    constructor(
        private readonly _toolAuthority?: PlanToolExecutionAuthority,
        private readonly _workflowAuthority?: PlanWorkflowExecutionAuthority,
        private readonly _agentAuthority?: PlanAgentExecutionAuthority,
    ) {}

    async executePlan(
        plan: ExecutionPlan,
        context: PlanExecutionContext,
    ): Promise<PlanExecutionResult> {
        this._assertPlanExecutable(plan);
        const startedAtMs = Date.now();
        this._emit('planning.plan_execution_started', {
            planId: plan.id,
            executionBoundaryId: plan.executionBoundaryId,
            stageCount: plan.stages.length,
        }, context);

        const stageResults: PlanStageExecutionResult[] = [];
        for (const stage of plan.stages) {
            const stageResult = await this.executeStage(stage, plan, context, stageResults);
            stageResults.push(stageResult);
            if (!this.shouldContinueAfterStage(stageResult, stage.failurePolicy, plan.failurePolicy)) {
                break;
            }
        }

        const result = this.buildFinalResult(plan, stageResults);
        const durationMs = Date.now() - startedAtMs;
        if (result.status === 'failed') {
            this._emit('planning.plan_execution_failed', {
                planId: plan.id,
                executionBoundaryId: plan.executionBoundaryId,
                status: result.status,
                reasonCodes: result.reasonCodes,
                durationMs,
            }, context);
        } else {
            this._emit('planning.plan_execution_completed', {
                planId: plan.id,
                executionBoundaryId: plan.executionBoundaryId,
                status: result.status,
                reasonCodes: result.reasonCodes,
                durationMs,
            }, context);
        }
        return result;
    }

    private _assertPlanExecutable(plan: ExecutionPlan): void {
        if (!plan?.id || !Array.isArray(plan.stages) || plan.stages.length === 0) {
            throw new Error('PLAN_NOT_EXECUTION_READY:missing_structure');
        }
        if (plan.handoff.type === 'none' || plan.status === 'blocked') {
            throw new Error(`PLAN_NOT_EXECUTION_READY:handoff_${plan.handoff.type}`);
        }
        for (const stage of plan.stages) {
            const handoff = this._resolveStageHandoff(stage, plan);
            if (!handoff || handoff.type === 'none') continue;
            if (handoff.type === 'tool' && !this._toolAuthority) {
                throw new Error('PLAN_NOT_EXECUTION_READY:tool_authority_unavailable');
            }
            if (handoff.type === 'workflow' && !this._workflowAuthority) {
                throw new Error('PLAN_NOT_EXECUTION_READY:workflow_authority_unavailable');
            }
            if (handoff.type === 'agent' && !this._agentAuthority) {
                throw new Error('PLAN_NOT_EXECUTION_READY:agent_authority_unavailable');
            }
        }
    }

    private async executeStage(
        stage: PlanStage,
        plan: ExecutionPlan,
        context: PlanExecutionContext,
        priorResults: PlanStageExecutionResult[],
    ): Promise<PlanStageExecutionResult> {
        const startedAt = new Date().toISOString();
        const dependencies = stage.dependsOn ?? plan.dependencies[stage.id] ?? [];
        const unsatisfiedDependency = dependencies.find((dep) => {
            const depResult = priorResults.find((item) => item.stageId === dep);
            return !depResult || depResult.status === 'failed' || depResult.status === 'blocked';
        });
        if (unsatisfiedDependency) {
            return {
                stageId: stage.id,
                handoffType: 'none',
                status: 'blocked',
                startedAt,
                completedAt: new Date().toISOString(),
                reasonCodes: ['stage_blocked_dependency_unsatisfied', `depends_on:${unsatisfiedDependency}`],
                attempts: 0,
                expectedOutputsSatisfied: false,
                failureReason: `dependency_not_satisfied:${unsatisfiedDependency}`,
            };
        }

        const handoff = this._resolveStageHandoff(stage, plan) ?? { type: 'none' as const };
        this._emit('planning.plan_stage_started', {
            planId: plan.id,
            executionBoundaryId: plan.executionBoundaryId,
            stageId: stage.id,
            handoffType: handoff.type,
            title: stage.title,
        }, context);

        let dispatch: StageExecutionDispatch;
        if (handoff.type === 'tool') {
            dispatch = await this.dispatchToolStage(stage, handoff, context);
        } else if (handoff.type === 'workflow') {
            dispatch = await this.dispatchWorkflowStage(stage, handoff, context);
        } else if (handoff.type === 'agent') {
            dispatch = await this.dispatchAgentStage(stage, handoff, context);
        } else {
            dispatch = {
                status: 'completed',
                outputs: {},
                reasonCodes: ['stage_no_external_handoff'],
                attempts: 0,
            };
        }

        const expected = this._evaluateExpectedOutputs(stage, dispatch.outputs);
        const status = this._resolveStatusWithExpectedOutputs(stage, dispatch.status, expected.satisfied);
        const result: PlanStageExecutionResult = {
            stageId: stage.id,
            handoffType: handoff.type,
            status,
            startedAt,
            completedAt: new Date().toISOString(),
            outputs: dispatch.outputs,
            expectedOutputsSatisfied: expected.satisfied,
            failureReason: dispatch.failureReason,
            reasonCodes: [...dispatch.reasonCodes, ...expected.reasonCodes],
            attempts: dispatch.attempts,
        };

        const eventName = status === 'failed' || status === 'blocked'
            ? 'planning.plan_stage_failed'
            : 'planning.plan_stage_completed';
        this._emit(eventName, {
            planId: plan.id,
            executionBoundaryId: plan.executionBoundaryId,
            stageId: stage.id,
            handoffType: handoff.type,
            status,
            reasonCodes: result.reasonCodes,
            attempts: result.attempts,
        }, context);

        return result;
    }

    private async dispatchToolStage(
        stage: PlanStage,
        handoff: Extract<PlanStageHandoff, { type: 'tool' }>,
        context: PlanExecutionContext,
    ): Promise<StageExecutionDispatch> {
        if (!this._toolAuthority) {
            return {
                status: 'failed',
                reasonCodes: ['tool_authority_unavailable'],
                failureReason: 'tool_authority_unavailable',
                attempts: 0,
            };
        }

        const outputs: Record<string, unknown> = {};
        let attempts = 0;
        for (let i = 0; i < handoff.steps.length; i++) {
            const step = handoff.steps[i];
            const mergedInput = { ...(handoff.sharedInputs ?? {}), ...step.input };
            const result = await this.executeToolStep(step, mergedInput, context, stage);
            attempts += result.attempts;
            Object.assign(outputs, result.outputs ?? {});

            if (result.status === 'failed') {
                return {
                    status: step.failurePolicy === 'skip' ? 'degraded' : 'failed',
                    outputs,
                    reasonCodes: [`tool_step_failed:${step.toolId}`, ...result.reasonCodes],
                    failureReason: result.failureReason,
                    attempts,
                };
            }

            if (result.status === 'degraded') {
                return {
                    status: 'degraded',
                    outputs,
                    reasonCodes: [`tool_step_degraded:${step.toolId}`, ...result.reasonCodes],
                    failureReason: result.failureReason,
                    attempts,
                };
            }
        }

        return {
            status: 'completed',
            outputs,
            reasonCodes: ['tool_stage_completed'],
            attempts,
        };
    }

    private async executeToolStep(
        step: PlannedToolInvocation,
        input: Record<string, unknown>,
        context: PlanExecutionContext,
        stage: PlanStage,
    ): Promise<StageExecutionDispatch> {
        const outputs: Record<string, unknown> = {};
        const maxAttempts = this._resolveRetryAttempts(step.failurePolicy, stage.failurePolicy, stage.retryPolicy?.maxAttempts);
        let attempts = 0;
        let lastError = '';

        while (attempts < maxAttempts) {
            attempts += 1;
            try {
                const result = await this._toolAuthority!.executeTool(
                    step.toolId,
                    input,
                    undefined,
                    {
                        executionId: context.executionId,
                        executionType: 'planning_handoff',
                        executionOrigin: 'planning',
                        authorityEnvelope: context.authorityEnvelope,
                    },
                );
                if (result.success) {
                    outputs[`step_${attempts}_${step.toolId}`] = result.data;
                    if (result.data && typeof result.data === 'object') {
                        Object.assign(outputs, result.data as Record<string, unknown>);
                    }
                    return {
                        status: 'completed',
                        outputs,
                        reasonCodes: attempts > 1 ? ['tool_step_retried_then_succeeded'] : ['tool_step_succeeded'],
                        attempts,
                    };
                }
                lastError = result.error ?? `tool_step_failed:${step.toolId}`;
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
            }

            if (step.failurePolicy !== 'retry') {
                break;
            }
        }

        if (step.failurePolicy === 'skip') {
            return {
                status: 'degraded',
                outputs,
                reasonCodes: ['tool_step_skipped_after_failure'],
                failureReason: lastError,
                attempts,
            };
        }

        return {
            status: 'failed',
            outputs,
            reasonCodes: ['tool_step_terminal_failure'],
            failureReason: lastError,
            attempts,
        };
    }

    private async dispatchWorkflowStage(
        stage: PlanStage,
        handoff: Extract<PlanStageHandoff, { type: 'workflow' }>,
        context: PlanExecutionContext,
    ): Promise<StageExecutionDispatch> {
        if (!this._workflowAuthority) {
            return {
                status: 'failed',
                reasonCodes: ['workflow_authority_unavailable'],
                failureReason: 'workflow_authority_unavailable',
                attempts: 0,
            };
        }

        const maxAttempts = this._resolveRetryAttempts(handoff.failurePolicy, stage.failurePolicy, stage.retryPolicy?.maxAttempts);
        let attempts = 0;
        let lastError = '';
        while (attempts < maxAttempts) {
            attempts += 1;
            const result = await this._workflowAuthority.executeWorkflow(
                handoff.workflowId,
                handoff.input,
                { executionId: context.executionId, authorityEnvelope: context.authorityEnvelope },
            );
            if (result.success) {
                return {
                    status: 'completed',
                    outputs: this._normalizeDispatchData(result.data),
                    reasonCodes: attempts > 1 ? ['workflow_retried_then_succeeded'] : ['workflow_succeeded'],
                    attempts,
                };
            }
            lastError = result.error ?? `workflow_failed:${handoff.workflowId}`;
            if (handoff.failurePolicy !== 'retry') break;
        }

        if (handoff.failurePolicy === 'skip') {
            return {
                status: 'degraded',
                reasonCodes: ['workflow_skipped_after_failure'],
                failureReason: lastError,
                attempts,
            };
        }

        return {
            status: 'failed',
            reasonCodes: ['workflow_terminal_failure'],
            failureReason: lastError,
            attempts,
        };
    }

    private async dispatchAgentStage(
        stage: PlanStage,
        handoff: Extract<PlanStageHandoff, { type: 'agent' }>,
        context: PlanExecutionContext,
    ): Promise<StageExecutionDispatch> {
        if (!this._agentAuthority) {
            return {
                status: 'failed',
                reasonCodes: ['agent_authority_unavailable'],
                failureReason: 'agent_authority_unavailable',
                attempts: 0,
            };
        }

        const maxAttempts = this._resolveRetryAttempts(handoff.failurePolicy, stage.failurePolicy, stage.retryPolicy?.maxAttempts);
        let attempts = 0;
        let lastError = '';
        const agentId = handoff.agentId ?? 'agent.default';
        while (attempts < maxAttempts) {
            attempts += 1;
            const result = await this._agentAuthority.executeAgent(
                agentId,
                handoff.input,
                { executionId: context.executionId, authorityEnvelope: context.authorityEnvelope },
            );
            if (result.success) {
                return {
                    status: 'completed',
                    outputs: this._normalizeDispatchData(result.data),
                    reasonCodes: attempts > 1 ? ['agent_retried_then_succeeded'] : ['agent_succeeded'],
                    attempts,
                };
            }
            lastError = result.error ?? `agent_failed:${agentId}`;
            if (handoff.failurePolicy !== 'retry') break;
        }

        if (handoff.failurePolicy === 'skip') {
            return {
                status: 'degraded',
                reasonCodes: ['agent_skipped_after_failure'],
                failureReason: lastError,
                attempts,
            };
        }

        return {
            status: 'failed',
            reasonCodes: ['agent_terminal_failure'],
            failureReason: lastError,
            attempts,
        };
    }

    private shouldContinueAfterStage(
        stageResult: PlanStageExecutionResult,
        stageFailurePolicy: StageFailurePolicy,
        planFailurePolicy: PlanFailurePolicy | undefined,
    ): boolean {
        if (stageResult.status === 'completed' || stageResult.status === 'degraded' || stageResult.status === 'skipped') {
            return true;
        }
        if (stageResult.status === 'blocked') return false;
        if (stageFailurePolicy === 'skip') return true;
        if (stageFailurePolicy === 'escalate') return false;
        if (planFailurePolicy === 'degrade' && stageFailurePolicy !== 'stop') return true;
        return false;
    }

    private buildFinalResult(
        plan: ExecutionPlan,
        stageResults: PlanStageExecutionResult[],
    ): PlanExecutionResult {
        const completedStageCount = stageResults.filter((result) => result.status === 'completed').length;
        const failedStageCount = stageResults.filter((result) => result.status === 'failed' || result.status === 'blocked').length;
        const degradedStageCount = stageResults.filter((result) => result.status === 'degraded').length;
        const anyBlocked = stageResults.some((result) => result.status === 'blocked');
        const anyFailed = stageResults.some((result) => result.status === 'failed');
        const anyDegraded = stageResults.some((result) => result.status === 'degraded');
        const allCompleted = stageResults.length > 0
            && stageResults.every((result) => result.status === 'completed');

        const status: PlanExecutionResult['status'] = anyFailed || anyBlocked
            ? 'failed'
            : anyDegraded
                ? 'degraded'
                : allCompleted && stageResults.length === plan.stages.length
                    ? 'completed'
                    : 'partial';

        const finalOutputs: Record<string, unknown> = {};
        for (const stage of stageResults) {
            if (stage.outputs) {
                finalOutputs[stage.stageId] = stage.outputs;
            }
        }

        return {
            planId: plan.id,
            executionBoundaryId: plan.executionBoundaryId,
            status,
            stageResults,
            completedStageCount,
            failedStageCount,
            degradedStageCount,
            finalOutputs: Object.keys(finalOutputs).length > 0 ? finalOutputs : undefined,
            reasonCodes: stageResults.flatMap((stage) => stage.reasonCodes),
        };
    }

    private _resolveStageHandoff(stage: PlanStage, plan: ExecutionPlan): PlanStageHandoff | undefined {
        if (stage.handoff) return stage.handoff;
        if (stage.type === 'tool' && plan.handoff.type === 'tool') {
            return { type: 'tool', steps: plan.handoff.steps, sharedInputs: plan.handoff.sharedInputs };
        }
        if (stage.type === 'workflow' && plan.handoff.type === 'workflow' && plan.handoff.invocations[0]) {
            const invocation = plan.handoff.invocations[0];
            return {
                type: 'workflow',
                workflowId: invocation.workflowId,
                input: { ...plan.handoff.sharedInputs, ...invocation.input },
                failurePolicy: invocation.failurePolicy,
            };
        }
        if (stage.type === 'llm' && plan.handoff.type === 'agent') {
            return {
                type: 'agent',
                agentId: plan.handoff.invocation.agentId,
                input: { ...plan.handoff.sharedInputs, ...plan.handoff.invocation.input },
                failurePolicy: plan.handoff.invocation.failurePolicy,
            };
        }
        return { type: 'none' };
    }

    private _resolveRetryAttempts(
        handoffPolicy: StageFailurePolicy,
        stagePolicy: StageFailurePolicy,
        configuredMaxAttempts?: number,
    ): number {
        if (handoffPolicy !== 'retry' && stagePolicy !== 'retry') {
            return 1;
        }
        return Math.max(1, configuredMaxAttempts ?? 2);
    }

    private _evaluateExpectedOutputs(
        stage: PlanStage,
        outputs?: Record<string, unknown>,
    ): { satisfied: boolean; reasonCodes: string[] } {
        const expected = stage.expectedOutputs ?? [];
        if (expected.length === 0) {
            return { satisfied: true, reasonCodes: [] };
        }
        const available = outputs ? new Set(Object.keys(outputs)) : new Set<string>();
        const missing = expected.filter((key) => !available.has(key));
        if (missing.length === 0) {
            return { satisfied: true, reasonCodes: ['expected_outputs_satisfied'] };
        }
        return {
            satisfied: false,
            reasonCodes: ['expected_outputs_missing', ...missing.map((key) => `missing_output:${key}`)],
        };
    }

    private _resolveStatusWithExpectedOutputs(
        stage: PlanStage,
        status: PlanStageExecutionStatus,
        expectedOutputsSatisfied: boolean,
    ): PlanStageExecutionStatus {
        if (status === 'failed' || status === 'blocked' || expectedOutputsSatisfied) {
            return status;
        }
        if (stage.completionPolicy === 'best_effort' || stage.failurePolicy === 'skip') {
            return status === 'completed' ? 'degraded' : status;
        }
        return 'failed';
    }

    private _normalizeDispatchData(data: unknown): Record<string, unknown> {
        if (data && typeof data === 'object') {
            return data as Record<string, unknown>;
        }
        return { value: data };
    }

    private _emit(event: PlanExecutionTelemetryEvent, payload: Record<string, unknown>, context: PlanExecutionContext): void {
        this._bus.emit({
            executionId: context.executionId,
            subsystem: 'planning',
            event,
            payload,
        });
        context.onEvent?.(event, payload);
    }
}
