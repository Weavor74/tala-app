import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanExecutionCoordinator } from '../electron/services/planning/PlanExecutionCoordinator';
import type { ExecutionPlan, PlanStage } from '../shared/planning/PlanningTypes';

const emitted: Array<{ event: string; payload?: Record<string, unknown> }> = [];

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: (e: unknown) => emitted.push(e as { event: string; payload?: Record<string, unknown> }),
            subscribe: vi.fn().mockReturnValue(vi.fn()),
        }),
    },
}));

function makeBasePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
    return {
        id: 'plan-1',
        goalId: 'goal-1',
        version: 1,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        plannerType: 'native',
        summary: 'test plan',
        stages: [],
        dependencies: {},
        estimatedRisk: 'low',
        requiresApproval: false,
        approvalState: 'not_required',
        status: 'ready',
        handoff: {
            type: 'tool',
            contractVersion: 1,
            steps: [],
            sharedInputs: {},
        },
        successCriteriaContract: [{
            id: 'plan.tool.validated',
            type: 'tool_result_validated',
            label: 'tool results validated',
            required: true,
            validationMethod: 'tool_output_validation',
        }],
        reasonCodes: ['test'],
        ...overrides,
    };
}

function makeStage(overrides: Partial<PlanStage> = {}): PlanStage {
    return {
        id: 'stage-1',
        title: 'stage',
        description: 'desc',
        type: 'tool',
        executionMode: 'deterministic',
        successCriteria: ['ok'],
        failurePolicy: 'stop',
        requiredCapabilities: [],
        outputs: {},
        expectedOutputs: [],
        completionPolicy: 'strict',
        handoff: { type: 'none' },
        ...overrides,
    };
}

beforeEach(() => {
    emitted.length = 0;
});

describe('PlanExecutionCoordinator', () => {
    it('executes tool stages from planned invocation contract', async () => {
        const tool = {
            executeTool: vi.fn().mockResolvedValue({
                success: true,
                toolName: 'fs_read_text',
                data: { content: 'ok' },
            }),
        };
        const plan = makeBasePlan({
            stages: [
                makeStage({
                    id: 'tool-stage',
                    type: 'tool',
                    handoff: {
                        type: 'tool',
                        steps: [{
                            toolId: 'fs_read_text',
                            input: { path: '/tmp/x.txt' },
                            failurePolicy: 'stop',
                            expectedOutputs: ['content'],
                        }],
                        sharedInputs: {},
                    },
                    expectedOutputs: ['content'],
                }),
            ],
        });
        const runner = new PlanExecutionCoordinator(tool, undefined, undefined);
        const result = await runner.executePlan(plan, { executionId: 'exec-1' });

        expect(tool.executeTool).toHaveBeenCalledWith(
            'fs_read_text',
            { path: '/tmp/x.txt' },
            undefined,
            expect.objectContaining({ executionType: 'planning_handoff' }),
        );
        expect(result.status).toBe('completed');
        expect(result.stageResults[0].outputs?.content).toBe('ok');
    });

    it('dispatches workflow stages to workflow authority', async () => {
        const workflow = {
            executeWorkflow: vi.fn().mockResolvedValue({
                success: true,
                data: { workflowRunId: 'wf-123' },
            }),
        };
        const plan = makeBasePlan({
            handoff: {
                type: 'workflow',
                contractVersion: 1,
                invocations: [{
                    workflowId: 'repo_audit',
                    input: { repo: 'x' },
                    failurePolicy: 'stop',
                }],
                sharedInputs: {},
            },
            stages: [
                makeStage({
                    id: 'wf-stage',
                    type: 'workflow',
                    handoff: {
                        type: 'workflow',
                        workflowId: 'repo_audit',
                        input: { repo: 'x' },
                        failurePolicy: 'stop',
                    },
                    expectedOutputs: ['workflowRunId'],
                }),
            ],
        });
        const runner = new PlanExecutionCoordinator(undefined, workflow, undefined);
        const result = await runner.executePlan(plan, { executionId: 'exec-2' });

        expect(workflow.executeWorkflow).toHaveBeenCalledWith(
            'repo_audit',
            { repo: 'x' },
            expect.objectContaining({ executionId: 'exec-2' }),
        );
        expect(result.status).toBe('completed');
        expect(result.stageResults[0].outputs?.workflowRunId).toBe('wf-123');
    });

    it('honors retry, stop, and degrade behavior deterministically', async () => {
        const tool = {
            executeTool: vi.fn()
                .mockResolvedValueOnce({ success: false, toolName: 't1', error: 'fail-1' })
                .mockResolvedValueOnce({ success: true, toolName: 't1', data: { a: 1 } })
                .mockResolvedValueOnce({ success: false, toolName: 't2', error: 'fail-2' }),
        };
        const stages = [
            makeStage({
                id: 'retry-stage',
                type: 'tool',
                failurePolicy: 'retry',
                retryPolicy: { maxAttempts: 2, delayMs: 0 },
                handoff: {
                    type: 'tool',
                    steps: [{ toolId: 't1', input: {}, failurePolicy: 'retry' }],
                },
            }),
            makeStage({
                id: 'degrade-stage',
                type: 'tool',
                failurePolicy: 'skip',
                handoff: {
                    type: 'tool',
                    steps: [{ toolId: 't2', input: {}, failurePolicy: 'skip' }],
                },
            }),
        ];
        const plan = makeBasePlan({ stages, failurePolicy: 'degrade' });
        const runner = new PlanExecutionCoordinator(tool, undefined, undefined);
        const result = await runner.executePlan(plan, { executionId: 'exec-3' });

        expect(tool.executeTool).toHaveBeenCalledTimes(3);
        expect(result.stageResults[0].attempts).toBe(2);
        expect(result.stageResults[0].status).toBe('completed');
        expect(result.stageResults[1].status).toBe('degraded');
        expect(result.status).toBe('partial');
    });

    it('marks expected outputs unsatisfied when keys are missing', async () => {
        const tool = {
            executeTool: vi.fn().mockResolvedValue({
                success: true,
                toolName: 'toolA',
                data: { present: true },
            }),
        };
        const plan = makeBasePlan({
            stages: [
                makeStage({
                    id: 'expect-stage',
                    type: 'tool',
                    expectedOutputs: ['missingKey'],
                    completionPolicy: 'strict',
                    handoff: {
                        type: 'tool',
                        steps: [{ toolId: 'toolA', input: {}, failurePolicy: 'stop' }],
                    },
                }),
            ],
        });
        const runner = new PlanExecutionCoordinator(tool, undefined, undefined);
        const result = await runner.executePlan(plan, { executionId: 'exec-4' });

        expect(result.stageResults[0].expectedOutputsSatisfied).toBe(false);
        expect(result.stageResults[0].status).toBe('failed');
        expect(result.status).toBe('failed');
    });

    it('stops plan execution when a stop-policy stage fails', async () => {
        const tool = {
            executeTool: vi.fn()
                .mockResolvedValueOnce({ success: false, toolName: 'first', error: 'boom' })
                .mockResolvedValueOnce({ success: true, toolName: 'second', data: { ok: true } }),
        };
        const plan = makeBasePlan({
            stages: [
                makeStage({
                    id: 'stage-stop',
                    type: 'tool',
                    failurePolicy: 'stop',
                    handoff: {
                        type: 'tool',
                        steps: [{ toolId: 'first', input: {}, failurePolicy: 'stop' }],
                    },
                }),
                makeStage({
                    id: 'stage-never',
                    type: 'tool',
                    handoff: {
                        type: 'tool',
                        steps: [{ toolId: 'second', input: {}, failurePolicy: 'stop' }],
                    },
                }),
            ],
        });
        const runner = new PlanExecutionCoordinator(tool, undefined, undefined);
        const result = await runner.executePlan(plan, { executionId: 'exec-6' });

        expect(tool.executeTool).toHaveBeenCalledTimes(1);
        expect(result.stageResults).toHaveLength(1);
        expect(result.status).toBe('failed');
    });

    it('emits plan and stage telemetry lifecycle in order', async () => {
        const tool = {
            executeTool: vi.fn().mockResolvedValue({
                success: true,
                toolName: 't',
                data: { ok: true },
            }),
        };
        const plan = makeBasePlan({
            stages: [
                makeStage({
                    id: 'stage-a',
                    type: 'tool',
                    handoff: { type: 'tool', steps: [{ toolId: 't', input: {}, failurePolicy: 'stop' }] },
                }),
            ],
        });
        const runner = new PlanExecutionCoordinator(tool, undefined, undefined);
        await runner.executePlan(plan, { executionId: 'exec-5' });
        const names = emitted.map((e) => e.event);

        expect(names).toEqual([
            'planning.plan_execution_started',
            'planning.plan_stage_started',
            'planning.plan_stage_completed',
            'planning.plan_execution_completed',
        ]);
    });
});
