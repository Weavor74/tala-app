import { describe, expect, it } from 'vitest';
import { PlanBuilder } from '../../electron/services/planning/PlanBuilder';
import type { GoalAnalysis, PlanGoal } from '../../shared/planning/PlanningTypes';

function makeGoal(overrides: Partial<PlanGoal> = {}): PlanGoal {
    return {
        id: 'goal-criteria',
        correlationId: 'corr-criteria',
        title: 'Search and save results in notebook summary',
        description: 'search and save output to notebook and create summary',
        source: 'user',
        category: 'tooling',
        priority: 'normal',
        successCriteria: ['results saved'],
        status: 'registered',
        registeredAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        replanCount: 0,
        ...overrides,
    };
}

function makeAnalysis(overrides: Partial<GoalAnalysis> = {}): GoalAnalysis {
    return {
        goalId: 'goal-criteria',
        analyzedAt: new Date(0).toISOString(),
        complexity: 'moderate',
        executionStyle: 'tool_orchestrated',
        requiresApproval: false,
        requiredCapabilities: ['tool_execution'],
        missingCapabilities: [],
        blockingIssues: [],
        recommendedPlanner: 'native',
        confidence: 0.92,
        risk: 'low',
        reasonCodes: ['criteria_generation_test'],
        ...overrides,
    };
}

describe('Success criteria generation', () => {
    it('generates explicit plan-level criteria for goal-driven plans', () => {
        const plan = PlanBuilder.build({
            goal: makeGoal(),
            analysis: makeAnalysis(),
        });

        expect(plan.successCriteriaContract?.length).toBeGreaterThan(0);
        const types = new Set(plan.successCriteriaContract?.map((item) => item.type));
        expect(types.has('search_results_persisted')).toBe(true);
        expect(types.has('notebook_updated')).toBe(true);
        expect(types.has('summary_created')).toBe(true);
    });

    it('attaches machine-testable stage criteria where expected outputs exist', () => {
        const plan = PlanBuilder.build({
            goal: makeGoal(),
            analysis: makeAnalysis({ executionStyle: 'workflow', recommendedPlanner: 'workflow-registry' }),
        });

        const stagesWithCriteria = plan.stages.filter((stage) => (stage.outcomeCriteria?.length ?? 0) > 0);
        expect(stagesWithCriteria.length).toBeGreaterThan(0);
        const hasPresenceValidation = stagesWithCriteria.some((stage) =>
            (stage.outcomeCriteria ?? []).some((criterion) => criterion.validationMethod === 'presence_of_output_key'));
        expect(hasPresenceValidation).toBe(true);
    });
});

