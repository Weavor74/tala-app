import { beforeEach, describe, expect, it, vi } from 'vitest';
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

function makePlan(goalId: string, stages: PlanStage[]): ExecutionPlan {
    return {
        id: 'plan-1',
        goalId,
        version: 1,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        plannerType: 'native',
        summary: 'summary',
        stages,
        dependencies: Object.fromEntries(stages.map((stage) => [stage.id, []])),
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
    };
}

function createPlanningWithGoal(title: string): { planning: PlanningService; goalId: string } {
    const repo = new PlanningRepository();
    PlanningService._resetForTesting(repo);
    const planning = PlanningService.getInstance();
    const goal = planning.registerGoal({
        title,
        description: 'desc',
        source: 'user',
        category: 'tooling',
    });
    return { planning, goalId: goal.id };
}

beforeEach(() => {
    PlanningService._resetForTesting(new PlanningRepository());
});

describe('ChatLoopExecutor plan-first integration', () => {
    it('routes to PlanExecutionCoordinator when executable plan exists', async () => {
        const executeChat = vi.fn().mockResolvedValue({
            message: 'chat fallback',
            outputChannel: 'chat',
        });
        const toolAuthority = {
            executeTool: vi.fn().mockResolvedValue({
                success: true,
                toolName: 'tool_a',
                data: { answer: 42 },
            }),
        };

        const { planning, goalId } = createPlanningWithGoal('GOAL TITLE SHOULD NOT EXECUTE');
        const executor = new ChatLoopExecutor(executeChat, planning, {
            toolAuthority,
        });

        const plan = makePlan(goalId, [
            makeStage({
                id: 'tool-stage',
                type: 'tool',
                handoff: {
                    type: 'tool',
                    steps: [{ toolId: 'tool_a', input: {}, failurePolicy: 'stop' }],
                },
            }),
        ]);

        const result = await executor.executePlan(plan);
        const lastTurn = executor.getLastExecutionResult();
        const lastPlanResult = executor.getLastPlanExecutionResult();

        expect(executeChat).not.toHaveBeenCalled();
        expect(toolAuthority.executeTool).toHaveBeenCalledOnce();
        expect((result as { status: string }).status).toBe('completed');
        expect(lastPlanResult?.status).toBe('completed');
        expect(lastTurn?.message).toContain('execution completed');
    });

    it('uses chat fallback only when plan is non-executable', async () => {
        const executeChat = vi.fn().mockResolvedValue({
            message: 'fallback response',
            outputChannel: 'chat',
        });
        const { planning, goalId } = createPlanningWithGoal('original title');
        const executor = new ChatLoopExecutor(executeChat, planning);

        const plan = makePlan(goalId, [
            makeStage({
                id: 'no-handoff-stage',
                handoff: { type: 'none' },
            }),
        ]);

        const result = await executor.executePlan(plan);

        expect(executeChat).toHaveBeenCalledWith(
            'original title',
            undefined,
            undefined,
            undefined,
        );
        expect((result as { message: string }).message).toBe('fallback response');
        expect(executor.getLastPlanExecutionResult()).toBeNull();
    });
});
