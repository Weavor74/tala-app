import { beforeEach, describe, expect, it } from 'vitest';
import { IterationPolicyGovernanceActionService } from '../../electron/services/planning/IterationPolicyGovernanceActionService';
import { IterationPolicyGovernanceQueryService } from '../../electron/services/planning/IterationPolicyGovernanceQueryService';
import { IterationPolicyTuningRepository } from '../../electron/services/planning/IterationPolicyTuningRepository';
import type { IterationTuningRecommendation } from '../../shared/planning/IterationEffectivenessTypes';

function makeRecommendation(overrides?: Partial<IterationTuningRecommendation>): IterationTuningRecommendation {
    return {
        recommendationId: 'itune-query-1',
        createdAt: '2026-04-10T00:00:00.000Z',
        taskClass: 'retrieval_summarize',
        currentMaxIterations: 1,
        recommendedMaxIterations: 2,
        currentReplanAllowance: 'none',
        recommendedReplanAllowance: 'bounded',
        confidence: 'high',
        evidenceSufficiency: 'sufficient',
        reasonCodes: ['tuning.recommend_raise_iterations'],
        sampleCount: 20,
        secondPassUplift: 0.27,
        thirdPassUplift: 0.0,
        thirdPassWasteRate: 0.3,
        replanImprovementRate: 0.2,
        replanWorsenedRate: 0.03,
        status: 'pending',
        ...overrides,
    };
}

describe('IterationPolicyGovernanceQueryService', () => {
    beforeEach(() => {
        IterationPolicyTuningRepository._resetForTesting();
    });

    it('returns pending/eligible/blocked queues deterministically', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([
            makeRecommendation({ recommendationId: 'itune-eligible' }),
            makeRecommendation({
                recommendationId: 'itune-blocked',
                taskClass: 'operator_sensitive',
                confidence: 'low',
                evidenceSufficiency: 'mixed_signals',
            }),
        ], { nowIso: '2026-04-12T00:00:00.000Z' });
        const query = new IterationPolicyGovernanceQueryService(repo);

        expect(query.getPendingRecommendationQueue().length).toBe(2);
        expect(query.getEligibleRecommendationQueue().map((item) => item.artifactId)).toContain('itune-eligible');
        expect(query.getBlockedRecommendationQueue().map((item) => item.artifactId)).toContain('itune-blocked');
    });

    it('returns stale override queue and reconstructable recent history', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.applyManualOverride({
            taskClass: 'retrieval_summarize',
            maxIterations: 2,
            replanAllowance: 'bounded',
            reasonCodes: ['tuning.override_promoted_manual'],
            promotedAt: '2026-04-01T00:00:00.000Z',
        });
        const overrideId = repo.getState().activeOverrides[0].overrideId;
        const actions = new IterationPolicyGovernanceActionService(repo);
        actions.executeAction({
            actionType: 'revalidate_override',
            targetArtifactId: overrideId,
            targetArtifactType: 'override',
            origin: 'maintenance',
            actorId: 'ops',
            nowIso: '2026-05-01T00:00:00.000Z',
        });
        const query = new IterationPolicyGovernanceQueryService(repo);
        expect(query.getStaleOverrideQueue().length).toBeGreaterThanOrEqual(1);
        expect(query.getRecentHistory(10).length).toBeGreaterThanOrEqual(1);
        expect(query.buildReviewSummary().staleOverrideCount).toBeGreaterThanOrEqual(1);
    });
});
