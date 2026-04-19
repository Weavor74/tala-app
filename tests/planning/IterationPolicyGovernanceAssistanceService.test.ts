import { beforeEach, describe, expect, it } from 'vitest';
import { IterationPolicyGovernanceAssistanceService } from '../../electron/services/planning/IterationPolicyGovernanceAssistanceService';
import { IterationPolicyGovernanceQueryService } from '../../electron/services/planning/IterationPolicyGovernanceQueryService';
import { IterationPolicyTuningRepository } from '../../electron/services/planning/IterationPolicyTuningRepository';
import type { IterationTuningRecommendation } from '../../shared/planning/IterationEffectivenessTypes';

function makeRecommendation(overrides?: Partial<IterationTuningRecommendation>): IterationTuningRecommendation {
    return {
        recommendationId: 'itune-assist-1',
        createdAt: '2026-04-01T00:00:00.000Z',
        taskClass: 'retrieval_summarize',
        currentMaxIterations: 1,
        recommendedMaxIterations: 2,
        currentReplanAllowance: 'none',
        recommendedReplanAllowance: 'bounded',
        confidence: 'high',
        evidenceSufficiency: 'sufficient',
        reasonCodes: ['tuning.recommend_raise_iterations'],
        sampleCount: 25,
        secondPassUplift: 0.3,
        thirdPassUplift: 0.01,
        thirdPassWasteRate: 0.3,
        replanImprovementRate: 0.25,
        replanWorsenedRate: 0.03,
        status: 'pending',
        ...overrides,
    };
}

describe('IterationPolicyGovernanceAssistanceService prioritization', () => {
    beforeEach(() => {
        IterationPolicyTuningRepository._resetForTesting();
    });

    it('ranks doctrine-incompatible override above weak pending recommendation', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([makeRecommendation({
            recommendationId: 'weak-pending',
            confidence: 'low',
            evidenceSufficiency: 'mixed_signals',
        })], { nowIso: '2026-04-01T00:00:00.000Z' });
        repo.applyManualOverride({
            taskClass: 'retrieval_summarize',
            maxIterations: 2,
            replanAllowance: 'bounded',
            reasonCodes: ['tuning.override_promoted_manual'],
            doctrineVersion: 'iteration-doctrine-v999',
            promotedAt: '2026-04-01T00:00:00.000Z',
        });
        repo.revalidateActiveOverrides('2026-04-20T00:00:00.000Z');

        const assistance = new IterationPolicyGovernanceAssistanceService(
            repo,
            new IterationPolicyGovernanceQueryService(repo),
        );
        const overrides = assistance.listPrioritizedOverrideAttention('2026-04-20T00:00:00.000Z');
        const recommendations = assistance.listPrioritizedRecommendations('2026-04-20T00:00:00.000Z');

        expect(overrides[0].priority.priorityClass).toMatch(/critical|high/);
        expect(recommendations[0].priority.priorityClass).toMatch(/medium|low/);
    });

    it('provides blocked recommendation explanations with reason-grounded factors', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([makeRecommendation({
            recommendationId: 'blocked',
            taskClass: 'operator_sensitive',
            confidence: 'low',
            evidenceSufficiency: 'insufficient_samples',
        })], { nowIso: '2026-04-10T00:00:00.000Z' });
        const assistance = new IterationPolicyGovernanceAssistanceService(
            repo,
            new IterationPolicyGovernanceQueryService(repo),
        );
        const explanations = assistance.getBlockedRecommendationExplanations('2026-04-11T00:00:00.000Z');
        expect(explanations).toHaveLength(1);
        expect(explanations[0].summary.toLowerCase()).toContain('blocked');
        expect(explanations[0].factors.some((item) => item.includes('evidence_sufficiency'))).toBe(true);
    });
});
