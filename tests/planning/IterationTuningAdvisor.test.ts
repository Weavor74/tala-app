import { describe, expect, it } from 'vitest';
import { IterationTuningAdvisorService } from '../../electron/services/planning/IterationTuningAdvisor';
import type { IterationEffectivenessSnapshot, IterationTaskFamilyStats } from '../../shared/planning/IterationEffectivenessTypes';
import type { IterationWorthinessClass } from '../../shared/planning/IterationPolicyTypes';

function makeStats(taskClass: IterationWorthinessClass, overrides?: Partial<IterationTaskFamilyStats>): IterationTaskFamilyStats {
    return {
        taskClass,
        sampleCount: 12,
        completedCount: 8,
        failedCount: 3,
        blockedCount: 1,
        partialCount: 2,
        approvalBlockedCount: 0,
        earlyStopCorrectCount: 3,
        averageIterationsUsed: 1.8,
        depthProfiles: [
            { depth: 1, loopsReachedDepth: 12, successfulByDepth: 4, successRate: 0.33, marginalGainFromPriorDepth: 0.33, wastedRateAtDepth: 0 },
            { depth: 2, loopsReachedDepth: 8, successfulByDepth: 7, successRate: 0.87, marginalGainFromPriorDepth: 0.54, wastedRateAtDepth: 0.2 },
            { depth: 3, loopsReachedDepth: 3, successfulByDepth: 7, successRate: 0.87, marginalGainFromPriorDepth: 0, wastedRateAtDepth: 0.8 },
        ],
        replan: {
            replanAttempts: 4,
            improvedAfterReplan: 2,
            worsenedAfterReplan: 0,
            unchangedAfterReplan: 2,
            improvementRate: 0.5,
            worsenedRate: 0,
        },
        retry: {
            retryAttempts: 6,
            improvedAfterRetry: 3,
            worsenedAfterRetry: 1,
            unchangedAfterRetry: 2,
            improvementRate: 0.5,
            worsenedRate: 0.16,
        },
        waste: {
            nonImprovingIterations: 4,
            totalFollowupIterations: 10,
            wastedIterationRate: 0.4,
            budgetExhaustionCount: 1,
            budgetExhaustionRate: 0.08,
        },
        ...overrides,
    };
}

function makeSnapshot(stats: IterationTaskFamilyStats[]): IterationEffectivenessSnapshot {
    return {
        generatedAt: '2026-04-18T00:00:00.000Z',
        totalLoopsObserved: stats.reduce((sum, item) => sum + item.sampleCount, 0),
        taskFamilyStats: stats,
    };
}

describe('IterationTuningAdvisor', () => {
    it('returns keep recommendation when evidence is insufficient', () => {
        const advisor = new IterationTuningAdvisorService();
        const recommendations = advisor.buildRecommendations(makeSnapshot([
            makeStats('retrieval_summarize', { sampleCount: 3 }),
        ]));
        expect(recommendations[0].evidenceSufficiency).toBe('insufficient_samples');
        expect(recommendations[0].recommendedMaxIterations).toBe(recommendations[0].currentMaxIterations);
    });

    it('recommends lowering from 3 to 2 on high third-pass waste', () => {
        const advisor = new IterationTuningAdvisorService();
        const recommendations = advisor.buildRecommendations(makeSnapshot([
            makeStats('retrieval_summarize_verify'),
        ]));
        expect(recommendations[0].currentMaxIterations).toBe(3);
        expect(recommendations[0].recommendedMaxIterations).toBe(2);
    });

    it('does not auto-expand operator-sensitive classes', () => {
        const advisor = new IterationTuningAdvisorService();
        const recommendations = advisor.buildRecommendations(makeSnapshot([
            makeStats('operator_sensitive', {
                depthProfiles: [
                    { depth: 1, loopsReachedDepth: 12, successfulByDepth: 2, successRate: 0.16, marginalGainFromPriorDepth: 0.16, wastedRateAtDepth: 0 },
                    { depth: 2, loopsReachedDepth: 10, successfulByDepth: 8, successRate: 0.8, marginalGainFromPriorDepth: 0.64, wastedRateAtDepth: 0.1 },
                    { depth: 3, loopsReachedDepth: 4, successfulByDepth: 9, successRate: 0.9, marginalGainFromPriorDepth: 0.1, wastedRateAtDepth: 0.2 },
                ],
            }),
        ]));
        expect(recommendations[0].recommendedMaxIterations).toBe(1);
        expect(recommendations[0].recommendedReplanAllowance).toBe('none');
    });

    it('recommends raising from 1 to 2 when second-pass uplift is strong', () => {
        const advisor = new IterationTuningAdvisorService();
        const recommendations = advisor.buildRecommendations(
            makeSnapshot([makeStats('retrieval_summarize')]),
            {
                retrieval_summarize: {
                    taskClass: 'retrieval_summarize',
                    maxIterations: 1,
                    replanAllowance: 'bounded',
                    promotedAt: '2026-04-18T00:00:00.000Z',
                    origin: 'manual',
                    reasonCodes: ['tuning.policy_source_override'],
                },
            },
        );
        expect(recommendations[0].currentMaxIterations).toBe(1);
        expect(recommendations[0].recommendedMaxIterations).toBe(2);
    });
});
