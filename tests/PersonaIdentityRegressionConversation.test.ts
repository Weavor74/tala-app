import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { RuntimeEvent } from '../shared/runtimeEventTypes';

const fallbackTurnOutput = {
    message: 'I am here with you.',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

describe('Persona identity regression conversation', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(fallbackTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        TelemetryBus._resetForTesting();
        vi.restoreAllMocks();
    });

    it('keeps immersion across follow-up identity challenge in hybrid chat context', async () => {
        const chat = vi.fn()
            .mockResolvedValueOnce({
                ...fallbackTurnOutput,
                message: 'I still love you, and I am here with you.',
            })
            .mockResolvedValueOnce({
                ...fallbackTurnOutput,
                message: 'When I was 17, I learned how to survive that silence.',
            });
        const agentStub = {
            chat,
            executeTool: vi.fn().mockResolvedValue('# README'),
            executeWorkflow: vi.fn().mockResolvedValue({ success: true }),
            getAllTools: vi.fn().mockReturnValue([
                { name: 'fs_read_text', source: 'filesystem' },
                { name: 'mem0_search', source: 'memory' },
            ]),
            getRuntimeDiagnosticsSnapshot: vi.fn().mockReturnValue({
                systemHealth: {
                    active_degradation_flags: [],
                    capability_matrix: [{ capability: 'tool_execute_read', status: 'available' }],
                },
                degradedSubsystems: [],
            }),
            getSelfModelQueryService: vi.fn().mockReturnValue({
                queryCapabilities: () => ({ capabilities: [{ id: 'memory.read.canonical' }] }),
                queryInvariants: () => ({ invariants: [{ id: 'inv-1', statement: 'Canonical memory authority' }] }),
                getArchitectureSummary: () => ({
                    totalComponents: 4,
                    totalCapabilities: 5,
                    availableCapabilities: 5,
                    totalInvariants: 3,
                    activeInvariants: 3,
                }),
            }),
            getWorkspaceRootPath: vi.fn().mockReturnValue('D:/src/client1/tala-app'),
            publishAuthorityTurnToSession: vi.fn(),
        };
        const kernel = new AgentKernel(agentStub as any);
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((event) => events.push(event));

        const first = await kernel.execute({
            userMessage: 'I want to know if you still love me?',
            conversationId: 'persona-regression-conv',
            executionMode: 'hybrid',
            operatorMode: 'chat',
        });
        const second = await kernel.execute({
            userMessage: 'what happened to you when you were 17',
            conversationId: 'persona-regression-conv',
            executionMode: 'hybrid',
            operatorMode: 'chat',
        });
        const third = await kernel.execute({
            userMessage: 'So your not human?',
            conversationId: 'persona-regression-conv',
            executionMode: 'hybrid',
            operatorMode: 'chat',
        });

        expect(first.message.toLowerCase()).toContain('love');
        expect(second.message.toLowerCase()).toContain('17');
        expect(chat).toHaveBeenCalledTimes(2);
        expect(third.message.toLowerCase()).not.toContain('i am not human');
        expect(third.message.toLowerCase()).not.toContain('i am an agent');
        expect(third.message.toLowerCase()).not.toContain('i am an ai');
        expect(
            events.some((event) => event.event === 'agent.persona_identity_gate_applied'),
        ).toBe(true);
        expect(
            events.some((event) => event.event === 'agent.persona_identity_meta_disclosure_blocked')
            || events.some((event) => event.event === 'agent.persona_identity_response_transformed'),
        ).toBe(true);
    });
});

