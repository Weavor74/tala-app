import { beforeEach, describe, expect, it, vi } from 'vitest';

const emittedEvents: Array<{ event: string; payload?: Record<string, unknown> }> = [];

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: (event: unknown) => emittedEvents.push(event as { event: string; payload?: Record<string, unknown> }),
            subscribe: vi.fn().mockReturnValue(vi.fn()),
        }),
    },
}));

import { PlanningService, PlanningError } from '../electron/services/planning/PlanningService';
import { PlanningRepository } from '../electron/services/planning/PlanningRepository';
import type { PlanningInvocationMetadata } from '../shared/planning/PlanningTypes';

function freshService(): PlanningService {
    const repo = new PlanningRepository();
    PlanningService._resetForTesting(repo);
    const svc = PlanningService.getInstance();
    svc.setAvailableCapabilities(new Set(['memory_canonical', 'workflow_engine', 'inference']));
    return svc;
}

describe('PlanningService memory authority integration', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('blocks conversational turn from creating planning episode and does not persist a plan', () => {
        const svc = freshService();
        const goal = svc.registerGoal({
            title: 'Goal',
            description: 'Do a workflow task',
            source: 'user',
            category: 'workflow',
            priority: 'normal',
        });

        const invocation: PlanningInvocationMetadata = {
            invokedBy: 'agent_kernel',
            invocationReason: 'hybrid_goal_commit',
            turnId: 'turn-conv-1',
            turnMode: 'conversational',
            authorityLevel: 'lightweight',
            memoryWriteMode: 'conversation_only',
        };

        let caught: unknown;
        try {
            svc.buildPlan(goal.id, invocation);
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(PlanningError);
        expect((caught as Error).message).toMatch(/Memory authority denied/i);

        const plans = svc.listPlansForGoal(goal.id);
        expect(plans).toHaveLength(0);
        expect(emittedEvents.some(e => e.event === 'planning.episode_recorded')).toBe(false);
        expect(emittedEvents.some(e => e.event === 'memory.write_blocked')).toBe(true);
    });

    it('allows goal_execution turn to create planning episode and persist plan', () => {
        const svc = freshService();
        const goal = svc.registerGoal({
            title: 'Goal',
            description: 'Do a workflow task',
            source: 'user',
            category: 'workflow',
            priority: 'normal',
        });

        const invocation: PlanningInvocationMetadata = {
            invokedBy: 'agent_kernel',
            invocationReason: 'goal_execution_turn',
            turnId: 'turn-goal-1',
            turnMode: 'goal_execution',
            authorityLevel: 'full_authority',
            memoryWriteMode: 'goal_episode',
        };

        const plan = svc.buildPlan(goal.id, invocation);
        expect(plan.id).toBeTruthy();
        expect(svc.listPlansForGoal(goal.id).length).toBe(1);
        expect(emittedEvents.some(e => e.event === 'planning.episode_recorded')).toBe(true);
        expect(emittedEvents.some(e => e.event === 'memory.write_allowed')).toBe(true);
    });

    it('blocks turn-bound planning writes when memoryWriteMode is missing', () => {
        const svc = freshService();
        const goal = svc.registerGoal({
            title: 'Goal',
            description: 'Do a workflow task',
            source: 'user',
            category: 'workflow',
            priority: 'normal',
        });

        const invocation: PlanningInvocationMetadata = {
            invokedBy: 'agent_kernel',
            invocationReason: 'goal_execution_turn',
            turnId: 'turn-goal-2',
            turnMode: 'goal_execution',
            authorityLevel: 'full_authority',
        };

        expect(() => svc.buildPlan(goal.id, invocation)).toThrow(PlanningError);
        expect(emittedEvents.some(e => e.event === 'memory.authority_check_denied')).toBe(true);
    });

    it('allows explicit system flow without turn context', () => {
        const svc = freshService();
        const goal = svc.registerGoal({
            title: 'System Goal',
            description: 'Maintenance task',
            source: 'system',
            category: 'maintenance',
            priority: 'normal',
        });

        const plan = svc.buildPlan(goal.id);
        expect(plan.id).toBeTruthy();
        expect(emittedEvents.some(e => e.event === 'memory.write_blocked')).toBe(false);
    });
});
