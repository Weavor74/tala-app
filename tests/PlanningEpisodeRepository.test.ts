import { describe, it, expect } from 'vitest';
import { PlanningEpisodeRepository } from '../electron/services/planning/PlanningEpisodeRepository';

function makeEpisode(idx: number, outcome: 'succeeded' | 'failed', strategyFamily: 'deterministic_workflow' | 'direct_tool') {
    return {
        goalClass: 'tooling',
        requestCategory: 'tooling',
        userIntentClass: 'user',
        executionLane: 'planning_loop' as const,
        strategyFamily,
        verificationDepth: 'standard' as const,
        retryPosture: 'light' as const,
        fallbackPosture: 'reroute' as const,
        toolIds: ['tool.a'],
        workflowIds: ['workflow.a'],
        runtimeConditions: {
            inferenceAvailable: true,
            postgresAvailable: true,
            semanticRetrievalAvailable: true,
            networkAvailable: true,
            degradedSubsystems: [],
        },
        similarityFeatures: {
            goalClass: 'tooling',
            requestCategory: 'tooling',
            userIntentClass: 'user',
            requiresCodeChange: true,
            requiresVerification: true,
            toolingDomain: ['code'],
            riskLevel: 'medium' as const,
        },
        outcome,
        failureClass: outcome === 'failed' ? 'timeout' : undefined,
        recoveryAction: outcome === 'failed' ? 'retry' : 'reroute',
        notes: [`ep-${idx}`],
    };
}

describe('PlanningEpisodeRepository', () => {
    it('returns similar episodes deterministically by feature overlap', () => {
        const repo = new PlanningEpisodeRepository(null);
        repo.createEpisode(makeEpisode(1, 'succeeded', 'deterministic_workflow'));
        repo.createEpisode(makeEpisode(2, 'failed', 'direct_tool'));

        const similar = repo.querySimilarEpisodes({
            goalClass: 'tooling',
            requestCategory: 'tooling',
            userIntentClass: 'user',
            requiresCodeChange: true,
            requiresVerification: true,
            toolingDomain: ['code'],
            riskLevel: 'medium',
        });
        expect(similar.length).toBeGreaterThan(0);
        expect(similar[0].goalClass).toBe('tooling');
    });

    it('summarizes strategy patterns with preferred and avoid bias flags', () => {
        const repo = new PlanningEpisodeRepository(null);
        repo.createEpisode(makeEpisode(1, 'succeeded', 'deterministic_workflow'));
        repo.createEpisode(makeEpisode(2, 'succeeded', 'deterministic_workflow'));
        repo.createEpisode(makeEpisode(3, 'failed', 'direct_tool'));
        repo.createEpisode(makeEpisode(4, 'failed', 'direct_tool'));

        const episodes = repo.querySimilarEpisodes({
            goalClass: 'tooling',
            requestCategory: 'tooling',
        }, { minSimilarity: 0 });
        const biases = repo.summarizeStrategyPatterns(episodes);
        const preferred = biases.find(b => b.strategyFamily === 'deterministic_workflow');
        const avoid = biases.find(b => b.strategyFamily === 'direct_tool');
        expect(preferred?.preferred).toBe(true);
        expect(avoid?.avoid).toBe(true);
    });

    it('summarizes tool patterns and repeated failure classes', () => {
        const repo = new PlanningEpisodeRepository(null);
        repo.createEpisode(makeEpisode(1, 'failed', 'direct_tool'));
        repo.createEpisode(makeEpisode(2, 'failed', 'direct_tool'));
        repo.createEpisode(makeEpisode(3, 'succeeded', 'deterministic_workflow'));

        const episodes = repo.querySimilarEpisodes({
            goalClass: 'tooling',
            requestCategory: 'tooling',
        }, { minSimilarity: 0 });
        const toolBiases = repo.summarizeToolPatterns(episodes);
        const failurePatterns = repo.summarizeFailurePatterns(episodes);
        expect(toolBiases.some(b => b.toolId === 'tool.a')).toBe(true);
        expect(failurePatterns).toContain('timeout');
    });
});

