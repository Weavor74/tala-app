import { describe, it, expect } from 'vitest';
import { StrategySelector } from '../electron/services/planning/StrategySelector';
import type {
    GoalAnalysis,
    PlanGoal,
} from '../shared/planning/PlanningTypes';
import type { PlanningBiasProfile } from '../shared/planning/PlanningMemoryTypes';

function makeGoal(overrides: Partial<PlanGoal> = {}): PlanGoal {
    const now = new Date().toISOString();
    return {
        id: 'goal-1',
        correlationId: 'corr-1',
        title: 'Fix retrieval timeout',
        description: 'Repair retrieval workflow and verify outputs',
        source: 'user',
        category: 'tooling',
        priority: 'normal',
        status: 'registered',
        registeredAt: now,
        updatedAt: now,
        replanCount: 0,
        ...overrides,
    };
}

function makeAnalysis(overrides: Partial<GoalAnalysis> = {}): GoalAnalysis {
    const now = new Date().toISOString();
    return {
        goalId: 'goal-1',
        analyzedAt: now,
        complexity: 'moderate',
        executionStyle: 'tool_orchestrated',
        requiresApproval: false,
        requiredCapabilities: [],
        missingCapabilities: [],
        blockingIssues: [],
        recommendedPlanner: 'native',
        confidence: 0.8,
        risk: 'medium',
        reasonCodes: ['baseline'],
        ...overrides,
    };
}

function makeBias(overrides: Partial<PlanningBiasProfile> = {}): PlanningBiasProfile {
    return {
        generatedAt: new Date().toISOString(),
        userPreferences: {
            prefersVerificationBeforeMutation: true,
            prefersDeterministicPathsForTechnicalWork: true,
        },
        similarEpisodes: [],
        strategyBiases: [],
        toolBiases: [],
        knownFailurePatterns: [],
        knownRecoveryPatterns: [],
        runtimeBiases: [],
        recommendedVerificationDepth: 'elevated',
        recommendedRetryPosture: 'light',
        recommendedFallbackPosture: 'reroute',
        confidence: 0.7,
        reasonCodes: [],
        ...overrides,
    };
}

describe('StrategySelector', () => {
    it('prefers historically successful strategy when available', () => {
        const selection = StrategySelector.select({
            goal: makeGoal(),
            analysis: makeAnalysis(),
            biasProfile: makeBias({
                strategyBiases: [
                    {
                        strategyFamily: 'deterministic_workflow',
                        preferred: true,
                        avoid: false,
                        reasonCodes: ['memory:similar_task_preferred_strategy'],
                        supportingEpisodeCount: 5,
                        successRate: 0.8,
                    },
                ],
            }),
            runtime: {
                inferenceAvailable: true,
                postgresAvailable: true,
                semanticRetrievalAvailable: true,
                networkAvailable: true,
            },
        });
        expect(selection.strategyFamily).toBe('deterministic_workflow');
        expect(selection.reasonCodes).toContain('memory:similar_task_preferred_strategy');
    });

    it('runtime retrieval degradation overrides retrieval_first strategy', () => {
        const selection = StrategySelector.select({
            goal: makeGoal({ category: 'research' }),
            analysis: makeAnalysis({ executionStyle: 'deterministic' }),
            biasProfile: makeBias({
                strategyBiases: [
                    {
                        strategyFamily: 'retrieval_first',
                        preferred: true,
                        avoid: false,
                        reasonCodes: ['memory:similar_task_preferred_strategy'],
                        supportingEpisodeCount: 3,
                        successRate: 0.75,
                    },
                ],
            }),
            runtime: {
                inferenceAvailable: true,
                postgresAvailable: true,
                semanticRetrievalAvailable: false,
                networkAvailable: true,
            },
        });
        expect(selection.strategyFamily).toBe('deterministic_workflow');
        expect(selection.reasonCodes).toContain('runtime:semantic_retrieval_degraded');
    });

    it('uses safe defaults when no history exists', () => {
        const selection = StrategySelector.select({
            goal: makeGoal({ category: 'maintenance' }),
            analysis: makeAnalysis({
                executionStyle: 'deterministic',
                complexity: 'simple',
                risk: 'low',
            }),
            biasProfile: makeBias({
                strategyBiases: [],
                confidence: 0.35,
                recommendedVerificationDepth: 'standard',
                recommendedRetryPosture: 'standard',
                recommendedFallbackPosture: 'operator_visible',
            }),
            runtime: {
                inferenceAvailable: true,
                postgresAvailable: true,
                semanticRetrievalAvailable: true,
                networkAvailable: true,
            },
        });
        expect(selection.strategyFamily).toBe('deterministic_workflow');
        expect(selection.verificationDepth).toBe('standard');
        expect(selection.retryPosture).toBe('standard');
    });
});

