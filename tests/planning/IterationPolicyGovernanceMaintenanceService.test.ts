import { beforeEach, describe, expect, it } from 'vitest';
import { IterationPolicyGovernanceActionService } from '../../electron/services/planning/IterationPolicyGovernanceActionService';
import { IterationPolicyGovernanceMaintenanceService } from '../../electron/services/planning/IterationPolicyGovernanceMaintenanceService';
import { IterationPolicyGovernanceQueryService } from '../../electron/services/planning/IterationPolicyGovernanceQueryService';
import { IterationPolicyTuningRepository } from '../../electron/services/planning/IterationPolicyTuningRepository';
import type { IterationTuningRecommendation } from '../../shared/planning/IterationEffectivenessTypes';

function makeRecommendation(overrides?: Partial<IterationTuningRecommendation>): IterationTuningRecommendation {
    return {
        recommendationId: 'itune-maint-1',
        createdAt: '2026-04-01T00:00:00.000Z',
        taskClass: 'retrieval_summarize',
        currentMaxIterations: 1,
        recommendedMaxIterations: 2,
        currentReplanAllowance: 'none',
        recommendedReplanAllowance: 'bounded',
        confidence: 'high',
        evidenceSufficiency: 'sufficient',
        reasonCodes: ['tuning.recommend_raise_iterations'],
        sampleCount: 32,
        secondPassUplift: 0.35,
        thirdPassUplift: 0.02,
        thirdPassWasteRate: 0.25,
        replanImprovementRate: 0.28,
        replanWorsenedRate: 0.02,
        status: 'pending',
        ...overrides,
    };
}

describe('IterationPolicyGovernanceMaintenanceService', () => {
    beforeEach(() => {
        IterationPolicyTuningRepository._resetForTesting();
    });

    it('expires stale pending recommendations and records sweep report', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([makeRecommendation({
            recommendationId: 'itune-expire',
            createdAt: '2026-03-01T00:00:00.000Z',
        })], { nowIso: '2026-03-01T00:00:00.000Z' });

        const service = new IterationPolicyGovernanceMaintenanceService(
            new IterationPolicyGovernanceActionService(repo),
            new IterationPolicyGovernanceQueryService(repo),
            repo,
        );
        const sweep = service.runSweep('expire_stale_recommendations', '2026-04-25T00:00:00.000Z', 'ops');

        expect(sweep.status).toBe('completed');
        expect(sweep.expiredRecommendationCount).toBeGreaterThanOrEqual(1);
        expect(repo.getState().expiredRecommendations.length).toBeGreaterThanOrEqual(1);
        expect(repo.getLastMaintenanceReport()).toBeDefined();
    });

    it('revalidates and retires stale/incompatible overrides through explicit sweep', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.applyManualOverride({
            taskClass: 'retrieval_summarize',
            maxIterations: 2,
            replanAllowance: 'bounded',
            reasonCodes: ['tuning.override_promoted_manual'],
            promotedAt: '2026-03-01T00:00:00.000Z',
        });
        const service = new IterationPolicyGovernanceMaintenanceService(
            new IterationPolicyGovernanceActionService(repo),
            new IterationPolicyGovernanceQueryService(repo),
            repo,
        );

        const revalidation = service.runSweep('revalidate_active_overrides', '2026-04-30T00:00:00.000Z', 'ops');
        expect(revalidation.status).toBe('completed');

        const retirement = service.runSweep('retire_invalid_or_stale_overrides', '2026-04-30T01:00:00.000Z', 'ops');
        expect(retirement.status).toBe('completed');
        expect(repo.getState().retiredOverrides.length).toBeGreaterThanOrEqual(1);
    });
});
