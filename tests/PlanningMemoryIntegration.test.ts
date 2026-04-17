import { describe, it, expect, vi, beforeEach } from 'vitest';

const emittedEvents: Array<{ event: string; payload?: Record<string, unknown> }> = [];

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: (e: unknown) =>
                emittedEvents.push(e as { event: string; payload?: Record<string, unknown> }),
            subscribe: vi.fn().mockReturnValue(vi.fn()),
        }),
    },
}));

import { PlanningService } from '../electron/services/planning/PlanningService';
import { PlanningRepository } from '../electron/services/planning/PlanningRepository';

function freshService(): PlanningService {
    const repo = new PlanningRepository();
    PlanningService._resetForTesting(repo);
    const svc = PlanningService.getInstance();
    svc.setAvailableCapabilities(new Set(['memory_canonical', 'workflow_engine', 'inference', 'rag']));
    svc.setRuntimeState({
        inferenceAvailable: true,
        postgresAvailable: true,
        semanticRetrievalAvailable: true,
        networkAvailable: true,
        degradedSubsystems: [],
    });
    return svc;
}

describe('Planning memory integration', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('injects strategy selection metadata into built plans', () => {
        const svc = freshService();
        const goal = svc.registerGoal({
            title: 'Repair flaky workflow',
            description: 'Fix issue and verify outputs',
            source: 'user',
            category: 'tooling',
            priority: 'normal',
        });
        const plan = svc.buildPlan(goal.id);
        expect(plan.strategySelection).toBeDefined();
        expect(plan.strategyFamily).toBeTruthy();
        expect(plan.selectedLane).toBeTruthy();
        expect(plan.planningMemoryReasonCodes).toBeDefined();
        expect(typeof plan.planningMemoryConfidence).toBe('number');
    });

    it('emits memory-context and strategy-selected telemetry', () => {
        const svc = freshService();
        const goal = svc.registerGoal({
            title: 'Plan with memory',
            description: 'Use prior history',
            source: 'user',
            category: 'workflow',
            priority: 'normal',
        });
        svc.buildPlan(goal.id);
        expect(emittedEvents.some(e => e.event === 'planning.memory_context_built')).toBe(true);
        expect(emittedEvents.some(e => e.event === 'planning.strategy_selected')).toBe(true);
        expect(emittedEvents.some(e => e.event === 'planning.episode_recorded')).toBe(true);
    });

    it('completes planning episode on execution failure', () => {
        const svc = freshService();
        const goal = svc.registerGoal({
            title: 'Failure path',
            description: 'Trigger timeout',
            source: 'user',
            category: 'workflow',
            priority: 'normal',
        });
        const plan = svc.buildPlan(goal.id);
        svc.markExecutionStarted(plan.id);
        svc.markExecutionFailed(plan.id, 'timeout while dispatching');
        const completedEvents = emittedEvents.filter(e => e.event === 'planning.episode_completed');
        expect(completedEvents.length).toBe(1);
        expect(completedEvents[0].payload?.failureClass).toBe('timeout');
    });
});

