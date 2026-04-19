import { beforeEach, describe, expect, it } from 'vitest';
import { IterationPolicyGovernanceActionService } from '../../electron/services/planning/IterationPolicyGovernanceActionService';
import { IterationPolicyTuningRepository } from '../../electron/services/planning/IterationPolicyTuningRepository';
import type { IterationTuningRecommendation } from '../../shared/planning/IterationEffectivenessTypes';

function makeRecommendation(overrides?: Partial<IterationTuningRecommendation>): IterationTuningRecommendation {
    return {
        recommendationId: 'itune-action-1',
        createdAt: '2026-04-10T00:00:00.000Z',
        taskClass: 'retrieval_summarize',
        currentMaxIterations: 1,
        recommendedMaxIterations: 2,
        currentReplanAllowance: 'none',
        recommendedReplanAllowance: 'bounded',
        confidence: 'high',
        evidenceSufficiency: 'sufficient',
        reasonCodes: ['tuning.recommend_raise_iterations'],
        sampleCount: 25,
        secondPassUplift: 0.31,
        thirdPassUplift: 0.01,
        thirdPassWasteRate: 0.3,
        replanImprovementRate: 0.26,
        replanWorsenedRate: 0.03,
        status: 'pending',
        ...overrides,
    };
}

describe('IterationPolicyGovernanceActionService', () => {
    beforeEach(() => {
        IterationPolicyTuningRepository._resetForTesting();
    });

    it('promotes eligible recommendation and writes governance history', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([makeRecommendation()], { nowIso: '2026-04-12T00:00:00.000Z' });
        const service = new IterationPolicyGovernanceActionService(repo);

        const result = service.executeAction({
            actionType: 'promote_recommendation',
            targetArtifactId: 'itune-action-1',
            targetArtifactType: 'recommendation',
            origin: 'operator',
            actorId: 'operator-1',
            nowIso: '2026-04-12T01:00:00.000Z',
            note: 'promote',
        });

        expect(result.status).toBe('completed');
        expect(result.createdOverrideId).toBeDefined();
        expect(repo.getState().activeOverrides).toHaveLength(1);
        expect(repo.listGovernanceHistory(5)).toHaveLength(1);
    });

    it('blocks promotion for ineligible recommendation with stable reason code', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([
            makeRecommendation({
                recommendationId: 'itune-blocked',
                confidence: 'low',
                evidenceSufficiency: 'insufficient_samples',
            }),
        ]);
        const service = new IterationPolicyGovernanceActionService(repo);
        const result = service.executeAction({
            actionType: 'promote_recommendation',
            targetArtifactId: 'itune-blocked',
            targetArtifactType: 'recommendation',
            origin: 'maintenance',
            actorId: 'ops',
        });

        expect(result.status).toBe('blocked');
        expect(result.blockedReasonCodes).toContain('governance_action.blocked_not_eligible');
        expect(repo.getState().activeOverrides).toHaveLength(0);
    });

    it('disables and re-enables override through legal lifecycle transitions', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.applyManualOverride({
            taskClass: 'retrieval_summarize',
            maxIterations: 2,
            replanAllowance: 'bounded',
            reasonCodes: ['tuning.override_promoted_manual'],
            promotedAt: '2026-04-10T00:00:00.000Z',
        });
        const overrideId = repo.getState().activeOverrides[0].overrideId;
        const service = new IterationPolicyGovernanceActionService(repo);

        const disabled = service.executeAction({
            actionType: 'disable_override',
            targetArtifactId: overrideId,
            targetArtifactType: 'override',
            origin: 'operator',
            actorId: 'operator-1',
            nowIso: '2026-04-12T00:00:00.000Z',
        });
        expect(disabled.status).toBe('completed');
        expect(disabled.resultingOverrideState).toBe('disabled_by_operator');

        const reenabled = service.executeAction({
            actionType: 'reenable_override',
            targetArtifactId: overrideId,
            targetArtifactType: 'override',
            origin: 'operator',
            actorId: 'operator-1',
            nowIso: '2026-04-12T01:00:00.000Z',
        });
        expect(reenabled.status).toBe('completed');
        expect(['active', 'active_stale']).toContain(reenabled.resultingOverrideState);
    });

    it('supersedes active override by promoting newer recommendation', () => {
        const repo = IterationPolicyTuningRepository.getInstance();
        repo.setRecommendations([makeRecommendation({ recommendationId: 'itune-old', recommendedMaxIterations: 2 })], {
            nowIso: '2026-04-12T00:00:00.000Z',
        });
        repo.promoteRecommendationWithGovernance('itune-old', 'manual_operator_review', 'operator', '2026-04-12T01:00:00.000Z');
        repo.setRecommendations([makeRecommendation({ recommendationId: 'itune-new', recommendedMaxIterations: 3 })], {
            nowIso: '2026-04-13T00:00:00.000Z',
        });

        const service = new IterationPolicyGovernanceActionService(repo);
        const result = service.executeAction({
            actionType: 'supersede_override',
            targetArtifactId: 'itune-new',
            targetArtifactType: 'recommendation',
            origin: 'maintenance',
            actorId: 'ops',
            nowIso: '2026-04-13T01:00:00.000Z',
        });

        expect(result.status).toBe('completed');
        expect(repo.getState().supersededOverrides.length).toBeGreaterThanOrEqual(1);
    });
});
