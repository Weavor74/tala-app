import { beforeEach, describe, it, expect } from 'vitest';
import { IterationPolicyResolver } from '../../electron/services/planning/IterationPolicyResolver';
import { IterationPolicyTuningRepository } from '../../electron/services/planning/IterationPolicyTuningRepository';
import type { ExecutionPlan } from '../../shared/planning/PlanningTypes';

function makePlan(overrides?: Partial<ExecutionPlan>): ExecutionPlan {
    const now = new Date(0).toISOString();
    return {
        id: 'plan-1',
        goalId: 'goal-1',
        version: 1,
        createdAt: now,
        updatedAt: now,
        plannerType: 'native',
        summary: 'test plan',
        stages: [],
        dependencies: {},
        estimatedRisk: 'low',
        requiresApproval: false,
        approvalState: 'not_required',
        status: 'ready',
        handoff: { type: 'tool', contractVersion: 1, steps: [], sharedInputs: {} },
        reasonCodes: [],
        ...overrides,
    };
}

describe('IterationPolicyResolver', () => {
    beforeEach(() => {
        IterationPolicyTuningRepository._resetForTesting();
    });

    const resolver = new IterationPolicyResolver();

    it('resolves conversational explanation to single-pass', () => {
        const result = resolver.resolve({
            goal: 'explain this architecture',
            turnMode: 'conversational',
            plan: makePlan(),
        });
        expect(result.profile.taskClass).toBe('conversational_explanation');
        expect(result.profile.maxIterations).toBe(1);
        expect(result.profile.replanAllowance).toBe('none');
    });

    it('resolves retrieval + verify to multi-pass budget', () => {
        const result = resolver.resolve({
            goal: 'retrieve notes and verify the summary',
            turnMode: 'goal_execution',
            plan: makePlan({
                stages: [
                    {
                        id: 's1',
                        title: 'retrieve',
                        description: 'retrieve',
                        type: 'retrieve',
                        executionMode: 'deterministic',
                        successCriteria: [],
                        failurePolicy: 'stop',
                        requiredCapabilities: [],
                        outputs: {},
                    },
                    {
                        id: 's2',
                        title: 'verify',
                        description: 'verify',
                        type: 'verify',
                        executionMode: 'deterministic',
                        successCriteria: [],
                        failurePolicy: 'stop',
                        requiredCapabilities: [],
                        outputs: {},
                    },
                ],
            }),
        });
        expect(result.profile.taskClass).toBe('retrieval_summarize_verify');
        expect(result.profile.maxIterations).toBe(3);
    });

    it('keeps operator-sensitive work capped to one iteration without approval', () => {
        const result = resolver.resolve({
            goal: 'delete canonical memory entry',
            turnMode: 'goal_execution',
            sideEffectSensitive: true,
            approvalGranted: false,
            plan: makePlan({ estimatedRisk: 'high', requiresApproval: true }),
        });
        expect(result.profile.taskClass).toBe('operator_sensitive');
        expect(result.profile.maxIterations).toBe(1);
        expect(result.profile.loopPermission).toBe('blocked_by_approval');
    });

    it('maps recovery mode to bounded recovery budget', () => {
        const result = resolver.resolve({
            goal: 'repair failed workflow run',
            turnMode: 'goal_execution',
            recoveryMode: true,
            plan: makePlan(),
        });
        expect(result.profile.taskClass).toBe('recovery_repair');
        expect(result.profile.maxIterations).toBeGreaterThan(1);
        expect(result.profile.replanAllowance).toBe('bounded');
    });

    it('applies caller cap without violating policy determinism', () => {
        const result = resolver.resolve({
            goal: 'retrieve and summarize results',
            turnMode: 'goal_execution',
            callerMaxIterations: 1,
            plan: makePlan(),
        });
        expect(result.profile.maxIterations).toBe(1);
        expect(result.profile.reasonCodes).toContain('iteration_policy.caller_cap_applied');
    });
});
