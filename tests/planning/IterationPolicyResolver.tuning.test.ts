import { beforeEach, describe, expect, it } from 'vitest';
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

describe('IterationPolicyResolver tuning integration', () => {
    beforeEach(() => {
        IterationPolicyTuningRepository._resetForTesting();
    });

    it('applies approved tuning overrides deterministically', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.applyManualOverride({
            taskClass: 'retrieval_summarize',
            maxIterations: 1,
            replanAllowance: 'none',
            reasonCodes: ['tuning.policy_source_override'],
        });

        const resolver = new IterationPolicyResolver(repo);
        const result = resolver.resolve({
            goal: 'retrieve and summarize notes',
            turnMode: 'goal_execution',
            plan: makePlan(),
        });

        expect(result.profile.maxIterations).toBe(1);
        expect(result.profile.replanAllowance).toBe('none');
        expect(result.profile.policySource).toBe('tuned_override');
    });

    it('preserves safety caps above tuning overrides', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.applyManualOverride({
            taskClass: 'operator_sensitive',
            maxIterations: 3,
            replanAllowance: 'bounded',
            reasonCodes: ['tuning.policy_source_override'],
        });

        const resolver = new IterationPolicyResolver(repo);
        const result = resolver.resolve({
            goal: 'delete durable memory record',
            turnMode: 'goal_execution',
            sideEffectSensitive: true,
            plan: makePlan({ estimatedRisk: 'high', requiresApproval: true }),
        });

        expect(result.profile.maxIterations).toBe(1);
        expect(result.profile.replanAllowance).toBe('none');
        expect(result.profile.reasonCodes).toContain('iteration_policy.tuned_override_ignored_by_safety_cap');
    });

    it('keeps recovery budget precedence over tuning overrides', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.applyManualOverride({
            taskClass: 'recovery_repair',
            maxIterations: 1,
            replanAllowance: 'none',
            reasonCodes: ['tuning.policy_source_override'],
        });
        const resolver = new IterationPolicyResolver(repo);
        const result = resolver.resolve({
            goal: 'repair workflow run',
            turnMode: 'goal_execution',
            recoveryMode: true,
            plan: makePlan(),
        });

        expect(result.profile.taskClass).toBe('recovery_repair');
        expect(result.profile.maxIterations).toBe(3);
        expect(result.profile.reasonCodes).toContain('iteration_policy.tuned_override_ignored_recovery_precedence');
    });

    it('falls back to doctrine baseline when tuning override is absent', () => {
        const resolver = new IterationPolicyResolver(IterationPolicyTuningRepository.getInstance());
        const result = resolver.resolve({
            goal: 'retrieve and summarize notes',
            turnMode: 'goal_execution',
            plan: makePlan(),
        });

        expect(result.profile.policySource).toBe('baseline');
        expect(result.profile.maxIterations).toBe(2);
    });
});
