import { describe, expect, it } from 'vitest';
import { IterationPolicyPromotionGovernorService } from '../../electron/services/planning/IterationPolicyPromotionGovernor';
import type { IterationTuningRecommendation } from '../../shared/planning/IterationEffectivenessTypes';

function makeRecommendation(overrides?: Partial<IterationTuningRecommendation>): IterationTuningRecommendation {
    return {
        recommendationId: 'itune-1',
        createdAt: '2026-04-01T00:00:00.000Z',
        taskClass: 'retrieval_summarize',
        currentMaxIterations: 1,
        recommendedMaxIterations: 2,
        currentReplanAllowance: 'none',
        recommendedReplanAllowance: 'bounded',
        confidence: 'high',
        evidenceSufficiency: 'sufficient',
        reasonCodes: ['tuning.recommend_raise_iterations'],
        sampleCount: 20,
        secondPassUplift: 0.3,
        thirdPassUplift: 0.02,
        thirdPassWasteRate: 0.4,
        replanImprovementRate: 0.22,
        replanWorsenedRate: 0.01,
        status: 'pending',
        ...overrides,
    };
}

describe('IterationPolicyPromotionGovernorService', () => {
    it('marks high-confidence low-risk recommendation as eligible', () => {
        const governor = new IterationPolicyPromotionGovernorService({
            recommendationExpiryMs: 1000 * 60 * 60 * 24 * 60,
        });
        const eligibility = governor.evaluateEligibility(
            makeRecommendation(),
            '2026-04-18T00:00:00.000Z',
        );
        expect(eligibility.status).toBe('eligible');
    });

    it('blocks operator-sensitive recommendation from auto-promotion eligibility', () => {
        const governor = new IterationPolicyPromotionGovernorService({ autoPromotionEnabled: true });
        const eligibility = governor.evaluateEligibility(
            makeRecommendation({ taskClass: 'operator_sensitive' }),
            '2026-04-18T00:00:00.000Z',
        );
        expect(eligibility.status).not.toBe('eligible');
        expect(eligibility.autoPromotionEligible).toBe(false);
    });

    it('blocks stale evidence from promotion', () => {
        const governor = new IterationPolicyPromotionGovernorService({
            recommendationExpiryMs: 1000 * 60 * 60 * 24,
        });
        const eligibility = governor.evaluateEligibility(
            makeRecommendation({ createdAt: '2026-04-01T00:00:00.000Z' }),
            '2026-04-18T00:00:00.000Z',
        );
        expect(eligibility.status).toBe('blocked_stale_evidence');
    });

    it('builds promotion decision with explicit governance record fields', () => {
        const governor = new IterationPolicyPromotionGovernorService({
            recommendationExpiryMs: 1000 * 60 * 60 * 24 * 60,
        });
        const decision = governor.buildPromotionDecision({
            recommendation: makeRecommendation(),
            origin: 'manual_operator_review',
            evidenceSnapshotId: 'snap-1',
            decidedBy: 'operator-1',
            nowIso: '2026-04-18T00:00:00.000Z',
        });
        expect(decision.approved).toBe(true);
        expect(decision.evidenceSnapshotId).toBe('snap-1');
        expect(decision.resultingOverride?.maxIterations).toBe(2);
    });

    it('blocks promotion on doctrine-version mismatch', () => {
        const governor = new IterationPolicyPromotionGovernorService();
        const eligibility = governor.evaluateEligibility(
            makeRecommendation(),
            '2026-04-18T00:00:00.000Z',
            'iteration-doctrine-v999',
        );
        expect(eligibility.status).toBe('blocked_doctrine_version_mismatch');
    });
});
