import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { RuntimeEvent } from '../electron/services/telemetry/TelemetryBus';

const stubTurnOutput = {
    message: 'chat output',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

function makeKernel(overrides?: {
    allowWrites?: boolean;
}) {
    const diagnosticsSnapshot = {
        systemHealth: {
            active_degradation_flags: [],
            capability_matrix: [{ capability: 'tool_execute_read', status: 'available' }],
        },
        degradedSubsystems: [],
    };
    const agentStub = {
        chat: vi.fn().mockResolvedValue(stubTurnOutput),
        executeTool: vi.fn().mockResolvedValue('# README'),
        executeWorkflow: vi.fn().mockResolvedValue({ success: true }),
        getAllTools: vi.fn().mockReturnValue([
            { name: 'fs_read_text', source: 'filesystem' },
            { name: 'mem0_search', source: 'memory' },
        ]),
        getRuntimeDiagnosticsSnapshot: vi.fn().mockReturnValue(diagnosticsSnapshot),
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
    };
    const kernel = new AgentKernel(agentStub as any);
    return {
        kernel,
        agentStub,
        request: {
            capabilitiesOverride: {
                allowWritesThisTurn: overrides?.allowWrites === true,
            },
        },
    };
}

describe('AgentKernel self-knowledge authority routing', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        TelemetryBus._resetForTesting();
        vi.restoreAllMocks();
    });

    it('routes self-knowledge requests through authority service before generic chat fallback', async () => {
        const { kernel, agentStub, request } = makeKernel();
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((event) => events.push(event));

        const result = await kernel.execute({
            userMessage: 'What do you know about your systems?',
            operatorMode: 'chat',
            executionMode: 'rp',
            ...request,
        });

        expect(agentStub.chat).not.toHaveBeenCalled();
        expect(result.message.toLowerCase()).not.toContain('just a language model');
        expect(result.message).toContain('Authority sources:');
        expect(events.some((event) => event.event === 'agent.self_knowledge_detected')).toBe(true);
        expect(events.some((event) => event.event === 'agent.self_knowledge_routed')).toBe(true);
        expect(events.some((event) => event.event === 'agent.self_knowledge_response_grounded')).toBe(true);
    });

    it('does not allow RP mode fallback to suppress self-knowledge route', async () => {
        const { kernel, agentStub, request } = makeKernel();

        const result = await kernel.execute({
            userMessage: 'What can you do?',
            operatorMode: 'chat',
            executionMode: 'rp',
            ...request,
        });

        expect(agentStub.chat).not.toHaveBeenCalled();
        expect(result.message).toContain('Current turn:');
    });

    it('reflects current-turn permissions for "right now" questions', async () => {
        const { kernel: blockedKernel, request: blockedRequest } = makeKernel({ allowWrites: false });
        const blockedResult = await blockedKernel.execute({
            userMessage: 'What can you do right now?',
            operatorMode: 'chat',
            executionMode: 'assistant',
            ...blockedRequest,
        });
        expect(blockedResult.message).toContain('writesAllowed=false');

        const { kernel: allowedKernel, request: allowedRequest } = makeKernel({ allowWrites: true });
        const allowedResult = await allowedKernel.execute({
            userMessage: 'What can you do right now?',
            operatorMode: 'chat',
            executionMode: 'assistant',
            ...allowedRequest,
        });
        expect(allowedResult.message).toContain('writesAllowed=true');
    });

    it('distinguishes in-principle capability from current-turn permission', async () => {
        const { kernel, request } = makeKernel({ allowWrites: false });
        const result = await kernel.execute({
            userMessage: 'Can you modify your own files?',
            operatorMode: 'chat',
            executionMode: 'assistant',
            ...request,
        });
        expect(result.message).toContain('writeInPrinciple=');
        expect(result.message).toContain('writeThisTurn=false');
    });
});

