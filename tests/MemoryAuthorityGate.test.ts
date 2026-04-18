import { describe, it, expect } from 'vitest';
import {
    MemoryAuthorityGateService,
    detectMemoryAuthorityViolationError,
} from '../electron/services/memory/MemoryAuthorityGate';
import type { MemoryWriteRequest } from '../shared/memoryAuthorityTypes';
import type { TurnAuthorityEnvelope } from '../shared/turnArbitrationTypes';

const goalAuthorityEnvelope: TurnAuthorityEnvelope = {
    turnId: 'turn-goal-1',
    mode: 'goal_execution',
    authorityLevel: 'full_authority',
    workflowAuthority: true,
    canCreateDurableState: true,
    canReplan: true,
};

function makeRequest(overrides: Partial<MemoryWriteRequest> = {}): MemoryWriteRequest {
    return {
        writeId: 'write-1',
        category: 'conversation_summary',
        source: 'planning_service',
        turnId: 'turn-1',
        payload: {},
        ...overrides,
    };
}

describe('MemoryAuthorityGate', () => {
    const gate = new MemoryAuthorityGateService();

    it('allows conversation_summary in conversation_only', () => {
        const decision = gate.evaluate(
            makeRequest({ category: 'conversation_summary' }),
            {
                turnId: 'turn-1',
                turnMode: 'conversational',
                memoryWriteMode: 'conversation_only',
                authorityEnvelope: {
                    turnId: 'turn-1',
                    mode: 'conversational',
                    authorityLevel: 'lightweight',
                    workflowAuthority: false,
                    canCreateDurableState: false,
                    canReplan: false,
                },
            },
        );
        expect(decision.decision).toBe('allow');
    });

    it('denies planning_episode in conversation_only with invalid_category_for_write_mode', () => {
        const decision = gate.evaluate(
            makeRequest({ category: 'planning_episode' }),
            {
                turnId: 'turn-1',
                goalId: 'goal-1',
                turnMode: 'conversational',
                memoryWriteMode: 'conversation_only',
                authorityEnvelope: {
                    turnId: 'turn-1',
                    mode: 'conversational',
                    authorityLevel: 'lightweight',
                    workflowAuthority: false,
                    canCreateDurableState: false,
                    canReplan: false,
                },
            },
        );
        expect(decision.decision).toBe('deny');
        expect(decision.reasonCodes).toContain('invalid_category_for_write_mode');
    });

    it('allows episodic_memory in episodic mode', () => {
        const decision = gate.evaluate(
            makeRequest({ category: 'episodic_memory' }),
            {
                turnId: 'turn-episodic',
                turnMode: 'hybrid',
                memoryWriteMode: 'episodic',
                authorityEnvelope: {
                    turnId: 'turn-episodic',
                    mode: 'hybrid',
                    authorityLevel: 'lightweight',
                    workflowAuthority: true,
                    canCreateDurableState: false,
                    canReplan: false,
                },
            },
        );
        expect(decision.decision).toBe('allow');
    });

    it('denies execution_episode in episodic mode', () => {
        const decision = gate.evaluate(
            makeRequest({ category: 'execution_episode', goalId: 'goal-1' }),
            {
                turnId: 'turn-episodic',
                goalId: 'goal-1',
                turnMode: 'hybrid',
                memoryWriteMode: 'episodic',
                authorityEnvelope: {
                    turnId: 'turn-episodic',
                    mode: 'hybrid',
                    authorityLevel: 'lightweight',
                    workflowAuthority: true,
                    canCreateDurableState: false,
                    canReplan: false,
                },
            },
        );
        expect(decision.decision).toBe('deny');
        expect(decision.reasonCodes).toContain('invalid_category_for_write_mode');
        expect(decision.reasonCodes).toContain('hybrid_goal_write_not_permitted');
    });

    it('allows planning/execution/recovery in goal_episode with durable authority', () => {
        for (const category of ['planning_episode', 'execution_episode', 'recovery_episode'] as const) {
            const decision = gate.evaluate(
                makeRequest({ category, goalId: 'goal-1' }),
                {
                    turnId: 'turn-goal-1',
                    goalId: 'goal-1',
                    turnMode: 'goal_execution',
                    memoryWriteMode: 'goal_episode',
                    authorityEnvelope: goalAuthorityEnvelope,
                },
            );
            expect(decision.decision).toBe('allow');
        }
    });

    it('denies goal_state without goalId', () => {
        const decision = gate.evaluate(
            makeRequest({ category: 'goal_state' }),
            {
                turnId: 'turn-goal-1',
                turnMode: 'goal_execution',
                memoryWriteMode: 'goal_episode',
                authorityEnvelope: goalAuthorityEnvelope,
            },
        );
        expect(decision.decision).toBe('deny');
        expect(decision.reasonCodes).toContain('goal_linkage_required');
    });

    it('denies durable writes when authority envelope is missing', () => {
        const decision = gate.evaluate(
            makeRequest({ category: 'planning_episode', goalId: 'goal-1' }),
            {
                turnId: 'turn-goal-1',
                goalId: 'goal-1',
                turnMode: 'goal_execution',
                memoryWriteMode: 'goal_episode',
            },
        );
        expect(decision.decision).toBe('deny');
        expect(decision.reasonCodes).toContain('missing_authority_envelope');
    });

    it('denies turn-bound writes when memoryWriteMode is missing', () => {
        const decision = gate.evaluate(
            makeRequest({ category: 'conversation_memory' }),
            {
                turnId: 'turn-1',
                turnMode: 'conversational',
                authorityEnvelope: {
                    turnId: 'turn-1',
                    mode: 'conversational',
                    authorityLevel: 'lightweight',
                    workflowAuthority: false,
                    canCreateDurableState: false,
                    canReplan: false,
                },
            },
        );
        expect(decision.decision).toBe('deny');
        expect(decision.reasonCodes).toContain('missing_memory_write_mode');
    });

    it('denies user-turn masquerading as system source', () => {
        const decision = gate.evaluate(
            makeRequest({ source: 'system', turnId: 'turn-user-1', category: 'goal_state' }),
            {
                turnId: 'turn-user-1',
                systemAuthority: true,
                goalId: 'goal-1',
            },
        );
        expect(decision.decision).toBe('deny');
        expect(decision.reasonCodes).toContain('source_not_allowed');
    });

    it('throws typed memory authority violation on assertAllowed deny path', () => {
        let caught: unknown;
        try {
            gate.assertAllowed(
                makeRequest({ category: 'planning_episode', goalId: 'goal-1' }),
                {
                    turnId: 'turn-1',
                    turnMode: 'conversational',
                    memoryWriteMode: 'conversation_only',
                    authorityEnvelope: {
                        turnId: 'turn-1',
                        mode: 'conversational',
                        authorityLevel: 'lightweight',
                        workflowAuthority: false,
                        canCreateDurableState: false,
                        canReplan: false,
                    },
                },
            );
        } catch (err) {
            caught = err;
        }
        expect(detectMemoryAuthorityViolationError(caught)).toBe(true);
    });
});
