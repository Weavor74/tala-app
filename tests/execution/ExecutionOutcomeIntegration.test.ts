import { describe, expect, it, vi } from 'vitest';
import { ChatLoopObserver } from '../../electron/services/planning/ChatLoopObserver';
import type { ExecutionPlan, PlanExecutionResult, PlanStage } from '../../shared/planning/PlanningTypes';
import type { PlanningLoopRun } from '../../shared/planning/planningLoopTypes';

const emitted: Array<{ event: string; payload?: Record<string, unknown> }> = [];
vi.mock('../../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: (event: unknown) => emitted.push(event as { event: string; payload?: Record<string, unknown> }),
            subscribe: vi.fn().mockReturnValue(vi.fn()),
        }),
    },
}));

function makePlan(): ExecutionPlan {
    const stage: PlanStage = {
        id: 'stage-1',
        title: 'stage',
        description: 'desc',
        type: 'tool',
        executionMode: 'deterministic',
        successCriteria: ['ok'],
        failurePolicy: 'stop',
        requiredCapabilities: [],
        outputs: {},
        expectedOutputs: ['artifactPath'],
        completionPolicy: 'strict',
        handoff: { type: 'tool', steps: [{ toolId: 'tool', input: {}, failurePolicy: 'stop' }] },
        outcomeCriteria: [{
            id: 'stage.output.artifact',
            type: 'artifact_generated',
            label: 'artifact generated',
            required: true,
            validationMethod: 'artifact_persisted',
        }],
    };
    return {
        id: 'plan-1',
        goalId: 'goal-1',
        version: 1,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        plannerType: 'native',
        summary: 'summary',
        stages: [stage],
        dependencies: { 'stage-1': [] },
        estimatedRisk: 'low',
        requiresApproval: false,
        approvalState: 'not_required',
        status: 'ready',
        handoff: { type: 'tool', contractVersion: 1, steps: [], sharedInputs: {} },
        successCriteriaContract: [{
            id: 'plan.artifact.generated',
            type: 'artifact_generated',
            label: 'artifact generated',
            required: true,
            validationMethod: 'artifact_persisted',
        }],
        reasonCodes: [],
    };
}

function makeLoopRun(): PlanningLoopRun {
    return {
        loopId: 'loop-1',
        correlationId: 'corr-1',
        goal: 'goal',
        phase: 'observing',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        currentIteration: 1,
        maxIterations: 3,
        replanHistory: [],
    };
}

describe('Execution outcome integration', () => {
    it('keeps response produced separate from failed execution outcome', async () => {
        emitted.length = 0;
        const observer = new ChatLoopObserver();
        const plan = makePlan();
        const result: PlanExecutionResult = {
            planId: plan.id,
            status: 'completed',
            stageResults: [{
                stageId: 'stage-1',
                handoffType: 'tool',
                status: 'completed',
                startedAt: new Date(0).toISOString(),
                completedAt: new Date(0).toISOString(),
                reasonCodes: ['ok'],
                attempts: 1,
            }],
            completedStageCount: 1,
            failedStageCount: 0,
            degradedStageCount: 0,
            reasonCodes: ['ok'],
        };

        const observation = await observer.observe(result, plan, makeLoopRun());
        const assessment = observation.artifacts?.turnCompletionAssessment as { executionQuality: string; responseQuality: string; reasonCodes: string[] };

        expect(observation.outcome).toBe('failed');
        expect(assessment.responseQuality).toBe('produced');
        expect(assessment.executionQuality).toBe('failed');
        expect(assessment.reasonCodes).toContain('response_only_no_verified_outcome');
    });

    it('tracks chat-only turn as response-quality only and execution not_applicable', async () => {
        emitted.length = 0;
        const observer = new ChatLoopObserver();
        const observation = await observer.observe(
            { message: 'Hello world', outputChannel: 'chat' },
            makePlan(),
            makeLoopRun(),
        );
        const assessment = observation.artifacts?.turnCompletionAssessment as { executionQuality: string; responseQuality: string };

        expect(observation.outcome).toBe('succeeded');
        expect(assessment.executionQuality).toBe('not_applicable');
        expect(assessment.responseQuality).toBe('produced');
    });

    it('emits deterministic turn completion telemetry payload', async () => {
        emitted.length = 0;
        const observer = new ChatLoopObserver();
        await observer.observe(
            {
                planId: 'plan-1',
                status: 'failed',
                stageResults: [],
                completedStageCount: 0,
                failedStageCount: 1,
                degradedStageCount: 0,
                reasonCodes: ['missing_success_criteria_contract'],
            } satisfies PlanExecutionResult,
            makePlan(),
            makeLoopRun(),
        );
        const event = emitted.find((item) => item.event === 'planning.turn_completion_assessed');
        expect(event).toBeDefined();
        expect(event?.payload?.executionQuality).toBe('failed');
    });
});

