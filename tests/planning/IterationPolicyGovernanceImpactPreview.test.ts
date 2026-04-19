import { beforeEach, describe, expect, it } from 'vitest';
import { IterationPolicyGovernanceAssistanceService } from '../../electron/services/planning/IterationPolicyGovernanceAssistanceService';
import { IterationPolicyGovernanceQueryService } from '../../electron/services/planning/IterationPolicyGovernanceQueryService';
import { IterationPolicyTuningRepository } from '../../electron/services/planning/IterationPolicyTuningRepository';
import type { IterationTuningRecommendation } from '../../shared/planning/IterationEffectivenessTypes';

function makeRecommendation(overrides?: Partial<IterationTuningRecommendation>): IterationTuningRecommendation {
    return {
        recommendationId: 'itune-preview-1',
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

describe('IterationPolicyGovernanceAssistanceService impact preview', () => {
    beforeEach(() => {
        IterationPolicyTuningRepository._resetForTesting();
    });

    it('promotion preview is advisory-only and does not mutate repository state', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([makeRecommendation()], { nowIso: '2026-04-05T00:00:00.000Z' });
        const before = repo.getState();
        const assistance = new IterationPolicyGovernanceAssistanceService(
            repo,
            new IterationPolicyGovernanceQueryService(repo),
        );
        const preview = assistance.previewGovernanceAction(
            'promote_recommendation',
            'itune-preview-1',
            '2026-04-06T00:00:00.000Z',
        );
        const after = repo.getState();

        expect(preview.advisoryOnly).toBe(true);
        expect(preview.targetArtifactType).toBe('recommendation');
        expect(preview.simulationResults.length).toBeGreaterThanOrEqual(1);
        expect(after).toEqual(before);
    });

    it('retirement preview reports fallback-to-baseline impact', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.applyManualOverride({
            taskClass: 'retrieval_summarize',
            maxIterations: 3,
            replanAllowance: 'bounded',
            reasonCodes: ['tuning.override_promoted_manual'],
            promotedAt: '2026-04-01T00:00:00.000Z',
        });
        const overrideId = repo.getState().activeOverrides[0].overrideId;
        const assistance = new IterationPolicyGovernanceAssistanceService(
            repo,
            new IterationPolicyGovernanceQueryService(repo),
        );
        const preview = assistance.previewGovernanceAction(
            'retire_override',
            overrideId,
            '2026-04-06T00:00:00.000Z',
        );

        expect(preview.targetArtifactType).toBe('override');
        expect(preview.baselineFallbackCount).toBeGreaterThanOrEqual(0);
        expect(preview.simulationResults[0].projectedPolicySource).toBe('baseline');
    });
});
