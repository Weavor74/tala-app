import { describe, expect, it, vi } from 'vitest';
import { ChatLoopExecutor } from '../electron/services/planning/ChatLoopExecutor';
import { PlanningService } from '../electron/services/planning/PlanningService';
import { PlanningRepository } from '../electron/services/planning/PlanningRepository';
import type { ExecutionPlan, PlanStage } from '../shared/planning/PlanningTypes';

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: vi.fn(),
            subscribe: vi.fn().mockReturnValue(vi.fn()),
        }),
    },
}));

function stage(overrides: Partial<PlanStage>): PlanStage {
    return {
        id: 'stage-default',
        title: 'stage',
        description: 'desc',
        type: 'tool',
        executionMode: 'deterministic',
        successCriteria: ['ok'],
        failurePolicy: 'stop',
        requiredCapabilities: [],
        outputs: {},
        expectedOutputs: [],
        completionPolicy: 'best_effort',
        handoff: { type: 'none' },
        ...overrides,
    };
}

function createPlan(goalId: string): ExecutionPlan {
    const stages: PlanStage[] = [
        stage({
            id: 'stage-core',
            title: 'core execution',
            type: 'tool',
            failurePolicy: 'stop',
            completionPolicy: 'strict',
            expectedOutputs: ['artifact'],
            handoff: {
                type: 'tool',
                steps: [
                    {
                        toolId: 'core_plan_step',
                        input: { task: 'execute-core' },
                        failurePolicy: 'stop',
                        expectedOutputs: ['artifact'],
                    },
                ],
            },
        }),
        stage({
            id: 'stage-adjacent-degraded',
            title: 'adjacent subsystem probe',
            type: 'tool',
            failurePolicy: 'skip',
            completionPolicy: 'best_effort',
            handoff: {
                type: 'tool',
                steps: [
                    {
                        toolId: 'adjacent_subsystem_probe',
                        input: {
                            memoryAuthority: 'degraded',
                            rag: 'unavailable',
                            mcpProvider: 'unavailable',
                            inference: 'degraded_non_authority',
                        },
                        failurePolicy: 'skip',
                    },
                ],
            },
        }),
        stage({
            id: 'stage-finalize',
            title: 'finalize',
            type: 'finalize',
            handoff: { type: 'none' },
        }),
    ];

    return {
        id: 'plan-exec-isolation',
        goalId,
        version: 1,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        plannerType: 'native',
        summary: 'isolation test plan',
        stages,
        dependencies: {
            'stage-core': [],
            'stage-adjacent-degraded': ['stage-core'],
            'stage-finalize': ['stage-adjacent-degraded'],
        },
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
        successCriteriaContract: [
            {
                id: 'plan.artifact.generated',
                type: 'artifact_generated',
                label: 'artifact generated',
                required: true,
                validationMethod: 'artifact_persisted',
            },
            {
                id: 'plan.tool.validated',
                type: 'tool_result_validated',
                label: 'tool output validated',
                required: true,
                validationMethod: 'tool_output_validation',
            },
        ],
        reasonCodes: ['execution_isolation_test'],
    };
}

describe('ExecutionIsolation', () => {
    it('keeps plan-first deterministic execution under adjacent subsystem degradation', async () => {
        const repo = new PlanningRepository();
        PlanningService._resetForTesting(repo);
        const planning = PlanningService.getInstance();
        const goal = planning.registerGoal({
            title: 'Do not execute chat fallback',
            description: 'execution isolation test',
            source: 'user',
            category: 'tooling',
        });

        const executeChat = vi.fn().mockResolvedValue({
            message: 'chat fallback should not be used',
            outputChannel: 'chat',
        });

        const callOrder: string[] = [];
        const toolAuthority = {
            executeTool: vi.fn().mockImplementation(async (toolId: string) => {
                callOrder.push(toolId);
                if (toolId === 'core_plan_step') {
                    return {
                        success: true,
                        toolName: toolId,
                        data: { artifact: 'artifact-ready' },
                    };
                }
                if (toolId === 'adjacent_subsystem_probe') {
                    return {
                        success: false,
                        toolName: toolId,
                        error: 'adjacent_unavailable:memory_authority_degraded:rag_unavailable:mcp_unavailable',
                    };
                }
                return {
                    success: false,
                    toolName: toolId,
                    error: `unexpected_tool:${toolId}`,
                };
            }),
        };

        const executor = new ChatLoopExecutor(executeChat, planning, {
            toolAuthority,
        });
        const plan = createPlan(goal.id);

        const rawResult = await executor.executePlan(plan);
        const planResult = rawResult as { status: string; stageResults: Array<{ stageId: string; status: string; reasonCodes: string[] }> };

        expect(executeChat).not.toHaveBeenCalled();
        expect(callOrder).toEqual(['core_plan_step', 'adjacent_subsystem_probe']);

        expect(planResult.status).toBe('partial');
        expect(Array.isArray(planResult.stageResults)).toBe(true);
        expect(planResult.stageResults.map((item) => item.stageId)).toEqual([
            'stage-core',
            'stage-adjacent-degraded',
            'stage-finalize',
        ]);
        expect(planResult.stageResults[0].status).toBe('completed');
        expect(planResult.stageResults[1].status).toBe('degraded');
        expect(planResult.stageResults[1].reasonCodes.some((code) => code.includes('adjacent_unavailable') || code.includes('degraded'))).toBe(true);
        expect(planResult.stageResults[2].status).toBe('completed');
    });
});
