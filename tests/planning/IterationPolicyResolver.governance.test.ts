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

describe('IterationPolicyResolver governance integration', () => {
    beforeEach(() => {
        IterationPolicyTuningRepository._resetForTesting();
    });

    it('applies active promoted override deterministically', () => {
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
        expect(result.profile.policySource).toBe('promoted_override');
    });

    it('pending recommendation does not affect resolved runtime policy', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([{
            recommendationId: 'itune-pending',
            createdAt: '2026-04-18T00:00:00.000Z',
            taskClass: 'retrieval_summarize',
            currentMaxIterations: 2,
            recommendedMaxIterations: 1,
            currentReplanAllowance: 'bounded',
            recommendedReplanAllowance: 'none',
            confidence: 'high',
            evidenceSufficiency: 'sufficient',
            reasonCodes: ['tuning.recommend_lower_iterations'],
            sampleCount: 12,
            secondPassUplift: -0.1,
            thirdPassUplift: -0.05,
            thirdPassWasteRate: 0.7,
            replanImprovementRate: 0.05,
            replanWorsenedRate: 0.2,
            status: 'pending',
        }], { nowIso: '2026-04-18T00:00:00.000Z' });
        const resolver = new IterationPolicyResolver(repo);
        const result = resolver.resolve({
            goal: 'retrieve and summarize notes',
            turnMode: 'goal_execution',
            plan: makePlan(),
        });
        expect(result.profile.maxIterations).toBe(2);
        expect(result.profile.policySource).toBe('baseline');
    });

    it('retired override does not affect runtime resolution', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.applyManualOverride({
            taskClass: 'retrieval_summarize',
            maxIterations: 1,
            replanAllowance: 'none',
            reasonCodes: ['tuning.policy_source_override'],
            promotedAt: '2026-04-01T00:00:00.000Z',
        });
        const active = repo.getState().activeOverrides[0];
        repo.retireOverride(active.overrideId, 'operator_disabled', '2026-04-10T00:00:00.000Z');
        const resolver = new IterationPolicyResolver(repo);
        const result = resolver.resolve({
            goal: 'retrieve and summarize notes',
            turnMode: 'goal_execution',
            plan: makePlan(),
        });
        expect(result.profile.maxIterations).toBe(2);
        expect(result.profile.policySource).toBe('baseline');
    });

    it('disabled override does not affect runtime resolution', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.applyManualOverride({
            taskClass: 'retrieval_summarize',
            maxIterations: 1,
            replanAllowance: 'none',
            reasonCodes: ['tuning.policy_source_override'],
            promotedAt: '2026-04-01T00:00:00.000Z',
        });
        const active = repo.getState().activeOverrides[0];
        repo.disableOverride(active.overrideId, '2026-04-10T00:00:00.000Z');
        const resolver = new IterationPolicyResolver(repo);
        const result = resolver.resolve({
            goal: 'retrieve and summarize notes',
            turnMode: 'goal_execution',
            plan: makePlan(),
        });
        expect(result.profile.maxIterations).toBe(2);
        expect(result.profile.policySource).toBe('baseline');
    });

    it('safety caps still override promoted policy', () => {
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
    });
});
