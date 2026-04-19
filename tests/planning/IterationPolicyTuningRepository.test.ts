import { beforeEach, describe, expect, it } from 'vitest';
import { IterationPolicyTuningRepository } from '../../electron/services/planning/IterationPolicyTuningRepository';
import type { IterationTuningRecommendation } from '../../shared/planning/IterationEffectivenessTypes';

function makeRecommendation(overrides?: Partial<IterationTuningRecommendation>): IterationTuningRecommendation {
    return {
        recommendationId: 'itune-1',
        createdAt: '2026-04-18T00:00:00.000Z',
        taskClass: 'retrieval_summarize',
        currentMaxIterations: 1,
        recommendedMaxIterations: 2,
        currentReplanAllowance: 'none',
        recommendedReplanAllowance: 'bounded',
        confidence: 'high',
        evidenceSufficiency: 'sufficient',
        reasonCodes: ['tuning.recommend_raise_iterations'],
        sampleCount: 22,
        secondPassUplift: 0.3,
        thirdPassUplift: 0.02,
        thirdPassWasteRate: 0.55,
        replanImprovementRate: 0.28,
        replanWorsenedRate: 0.03,
        status: 'pending',
        ...overrides,
    };
}

describe('IterationPolicyTuningRepository', () => {
    beforeEach(() => {
        IterationPolicyTuningRepository._resetForTesting();
    });

    it('stores and reads pending recommendations deterministically', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([makeRecommendation()]);
        const state = repo.getState();
        expect(state.pendingRecommendations).toHaveLength(1);
        expect(state.pendingRecommendations[0].taskClass).toBe('retrieval_summarize');
    });

    it('promotes recommendation into auditable applied override record', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([makeRecommendation()]);
        const promoted = repo.promoteRecommendation('itune-1', 'maintenance_review', 'ops-bot');
        const state = repo.getState();

        expect(promoted).toBeDefined();
        expect(state.pendingRecommendations).toHaveLength(0);
        expect(state.promotedRecommendations).toHaveLength(1);
        expect(state.appliedOverrides.retrieval_summarize?.maxIterations).toBe(2);
    });

    it('rejected recommendations do not affect runtime policy overrides', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([makeRecommendation()]);
        repo.rejectRecommendation('itune-1', 'operator chose conservative posture', 'operator-1');
        const state = repo.getState();

        expect(state.pendingRecommendations).toHaveLength(0);
        expect(state.rejectedRecommendations).toHaveLength(1);
        expect(state.appliedOverrides.retrieval_summarize).toBeUndefined();
    });

    it('manual override origin is preserved distinctly from promoted analytics recommendations', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.applyManualOverride({
            taskClass: 'retrieval_summarize',
            maxIterations: 2,
            replanAllowance: 'bounded',
            reasonCodes: ['tuning.override_promoted_manual'],
            promotedBy: 'operator-1',
        });
        const state = repo.getState();
        expect(state.appliedOverrides.retrieval_summarize?.origin).toBe('manual');
    });
});
