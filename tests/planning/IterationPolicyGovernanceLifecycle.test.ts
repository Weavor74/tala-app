import { beforeEach, describe, expect, it } from 'vitest';
import { IterationPolicyTuningRepository } from '../../electron/services/planning/IterationPolicyTuningRepository';
import { IterationPolicyPromotionGovernorService } from '../../electron/services/planning/IterationPolicyPromotionGovernor';
import type { IterationTuningRecommendation } from '../../shared/planning/IterationEffectivenessTypes';

function makeRecommendation(overrides?: Partial<IterationTuningRecommendation>): IterationTuningRecommendation {
    return {
        recommendationId: 'itune-1',
        createdAt: '2026-04-10T00:00:00.000Z',
        taskClass: 'retrieval_summarize',
        currentMaxIterations: 1,
        recommendedMaxIterations: 2,
        currentReplanAllowance: 'none',
        recommendedReplanAllowance: 'bounded',
        confidence: 'high',
        evidenceSufficiency: 'sufficient',
        reasonCodes: ['tuning.recommend_raise_iterations'],
        sampleCount: 24,
        secondPassUplift: 0.28,
        thirdPassUplift: 0.01,
        thirdPassWasteRate: 0.34,
        replanImprovementRate: 0.24,
        replanWorsenedRate: 0.02,
        status: 'pending',
        ...overrides,
    };
}

describe('Iteration policy governance lifecycle', () => {
    beforeEach(() => {
        const governor = new IterationPolicyPromotionGovernorService({
            recommendationExpiryMs: 1000 * 60 * 60 * 24 * 14,
        });
        IterationPolicyTuningRepository._resetForTesting(governor);
    });

    it('transitions pending -> promoted and records auditable promotion history', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([makeRecommendation()], {
            nowIso: '2026-04-12T00:00:00.000Z',
            evidenceSnapshotId: 'snap-1',
        });
        const promoted = repo.promoteRecommendationWithGovernance(
            'itune-1',
            'manual_operator_review',
            'operator-1',
            '2026-04-12T01:00:00.000Z',
        );
        const state = repo.getState();

        expect(promoted).toBeDefined();
        expect(state.pendingRecommendations).toHaveLength(0);
        expect(state.promotedRecommendations).toHaveLength(1);
        expect(state.activeOverrides).toHaveLength(1);
        expect(state.promotionDecisions).toHaveLength(1);
    });

    it('transitions pending -> rejected with reason preserved', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([makeRecommendation()]);
        repo.rejectRecommendation('itune-1', 'insufficient operator confidence', 'operator-1');
        const state = repo.getState();

        expect(state.pendingRecommendations).toHaveLength(0);
        expect(state.rejectedRecommendations).toHaveLength(1);
        expect(state.rejectedRecommendations[0].rejectionReason).toContain('insufficient');
    });

    it('transitions pending -> expired when evidence window elapses', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([makeRecommendation({ createdAt: '2026-03-01T00:00:00.000Z' })], {
            nowIso: '2026-04-01T00:00:00.000Z',
        });
        repo.expireStaleRecommendations('2026-04-20T00:00:00.000Z');
        const state = repo.getState();

        expect(state.pendingRecommendations).toHaveLength(0);
        expect(state.expiredRecommendations.length).toBeGreaterThanOrEqual(1);
    });

    it('transitions pending -> superseded when newer recommendation for same class arrives', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([makeRecommendation({ recommendationId: 'itune-old' })], {
            nowIso: '2026-04-12T00:00:00.000Z',
        });
        repo.setRecommendations([makeRecommendation({ recommendationId: 'itune-new' })], {
            nowIso: '2026-04-12T01:00:00.000Z',
        });
        const state = repo.getState();
        expect(state.pendingRecommendations.some((item) => item.recommendation.recommendationId === 'itune-new')).toBe(true);
        expect(state.supersededRecommendations.some((item) => item.recommendation.recommendationId === 'itune-old')).toBe(true);
    });

    it('supersedes prior active override when newer recommendation is promoted', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([makeRecommendation({ recommendationId: 'itune-1', recommendedMaxIterations: 2 })], {
            nowIso: '2026-04-12T00:00:00.000Z',
        });
        repo.promoteRecommendationWithGovernance('itune-1', 'maintenance_review_promotion', 'ops', '2026-04-12T01:00:00.000Z');

        repo.setRecommendations([makeRecommendation({ recommendationId: 'itune-2', recommendedMaxIterations: 3 })], {
            nowIso: '2026-04-13T00:00:00.000Z',
        });
        repo.promoteRecommendationWithGovernance('itune-2', 'maintenance_review_promotion', 'ops', '2026-04-13T01:00:00.000Z');

        const state = repo.getState();
        expect(state.activeOverrides).toHaveLength(1);
        expect(state.supersededOverrides.length).toBeGreaterThanOrEqual(1);
        expect(state.overrideSupersessionRecords.length).toBeGreaterThanOrEqual(1);
    });

    it('marks active override stale then retires it cleanly', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([makeRecommendation()], {
            nowIso: '2026-04-01T00:00:00.000Z',
        });
        repo.promoteRecommendationWithGovernance('itune-1', 'manual_operator_review', 'operator', '2026-04-01T01:00:00.000Z');
        repo.revalidateActiveOverrides('2026-05-10T00:00:00.000Z');
        const stale = repo.getState().activeOverrides.find((item) => item.lifecycleState === 'stale_requires_revalidation');
        expect(stale).toBeDefined();
        const retired = repo.retireOverride(stale!.overrideId, 'stale_evidence_retirement', '2026-05-10T01:00:00.000Z');
        expect(retired).toBeDefined();
        expect(repo.getState().retiredOverrides.length).toBeGreaterThanOrEqual(1);
    });

    it('auto-promotion pass remains conservative and does not promote blocked classes', () => {
        const governor = new IterationPolicyPromotionGovernorService({
            autoPromotionEnabled: true,
            recommendationExpiryMs: 1000 * 60 * 60 * 24 * 30,
        });
        IterationPolicyTuningRepository._resetForTesting(governor);
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([
            makeRecommendation({ recommendationId: 'itune-ok', taskClass: 'retrieval_summarize' }),
            makeRecommendation({ recommendationId: 'itune-blocked', taskClass: 'operator_sensitive' }),
        ], { nowIso: '2026-04-12T00:00:00.000Z' });
        const promoted = repo.runAutoPromotionPass('2026-04-12T01:00:00.000Z');
        expect(promoted).toContain('itune-ok');
        expect(promoted).not.toContain('itune-blocked');
    });
});
