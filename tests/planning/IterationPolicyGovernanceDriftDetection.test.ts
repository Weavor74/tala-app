import { beforeEach, describe, expect, it } from 'vitest';
import { IterationPolicyGovernanceAssistanceService } from '../../electron/services/planning/IterationPolicyGovernanceAssistanceService';
import { IterationPolicyGovernanceQueryService } from '../../electron/services/planning/IterationPolicyGovernanceQueryService';
import { IterationPolicyTuningRepository } from '../../electron/services/planning/IterationPolicyTuningRepository';
import type { IterationTuningRecommendation } from '../../shared/planning/IterationEffectivenessTypes';

function makeRecommendation(overrides?: Partial<IterationTuningRecommendation>): IterationTuningRecommendation {
    return {
        recommendationId: 'itune-drift-1',
        createdAt: '2026-04-01T00:00:00.000Z',
        taskClass: 'retrieval_summarize',
        currentMaxIterations: 2,
        recommendedMaxIterations: 1,
        currentReplanAllowance: 'bounded',
        recommendedReplanAllowance: 'none',
        confidence: 'high',
        evidenceSufficiency: 'sufficient',
        reasonCodes: ['tuning.recommend_lower_iterations'],
        sampleCount: 40,
        secondPassUplift: -0.1,
        thirdPassUplift: -0.1,
        thirdPassWasteRate: 0.8,
        replanImprovementRate: 0.01,
        replanWorsenedRate: 0.2,
        status: 'pending',
        ...overrides,
    };
}

describe('IterationPolicyGovernanceAssistanceService drift/contradiction detection', () => {
    beforeEach(() => {
        IterationPolicyTuningRepository._resetForTesting();
    });

    it('emits drift signals for stale/incompatible overrides', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.applyManualOverride({
            taskClass: 'retrieval_summarize',
            maxIterations: 2,
            replanAllowance: 'bounded',
            reasonCodes: ['tuning.override_promoted_manual'],
            doctrineVersion: 'iteration-doctrine-v999',
            promotedAt: '2026-03-01T00:00:00.000Z',
        });
        repo.revalidateActiveOverrides('2026-04-25T00:00:00.000Z');
        const assistance = new IterationPolicyGovernanceAssistanceService(
            repo,
            new IterationPolicyGovernanceQueryService(repo),
        );
        const drift = assistance.detectDriftSignals('2026-04-25T00:00:00.000Z');
        expect(drift.length).toBeGreaterThanOrEqual(1);
        expect(drift.some((item) => item.reasonCodes.some((code) => code.includes('doctrine_incompatible')))).toBe(true);
    });

    it('emits contradiction signals for overlapping/contradictory recommendations', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.applyManualOverride({
            taskClass: 'retrieval_summarize',
            maxIterations: 3,
            replanAllowance: 'bounded',
            reasonCodes: ['tuning.override_promoted_manual'],
            promotedAt: '2026-04-05T00:00:00.000Z',
        });
        repo.setRecommendations([
            makeRecommendation({ recommendationId: 'a', recommendedMaxIterations: 1, recommendedReplanAllowance: 'none' }),
        ], { nowIso: '2026-04-10T00:00:00.000Z' });
        const assistance = new IterationPolicyGovernanceAssistanceService(
            repo,
            new IterationPolicyGovernanceQueryService(repo),
        );
        const contradictions = assistance.detectContradictionSignals('2026-04-10T00:00:00.000Z');
        expect(contradictions.length).toBeGreaterThanOrEqual(1);
        expect(contradictions[0].relatedArtifactIds.length).toBeGreaterThanOrEqual(2);
    });
});
