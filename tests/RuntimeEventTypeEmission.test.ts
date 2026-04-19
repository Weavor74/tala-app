import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEventType } from '../shared/runtimeEventTypes';
import { AGENT_RESPONSE_RUNTIME_EVENTS, AgentKernel } from '../electron/services/kernel/AgentKernel';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { RuntimeEvent } from '../shared/runtimeEventTypes';

const stubTurnOutput = {
    message: 'chat output',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

function assertRuntimeEventType<T extends RuntimeEventType>(eventType: T): T {
    return eventType;
}

function makeKernel() {
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
        getAllTools: vi.fn().mockReturnValue([{ name: 'fs_read_text', source: 'filesystem' }]),
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
        publishAuthorityTurnToSession: vi.fn(),
    };
    return new AgentKernel(agentStub as any);
}

describe('Runtime response event emission is RuntimeEventType-safe', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        TelemetryBus._resetForTesting();
        vi.restoreAllMocks();
    });

    it('uses response runtime event members from RuntimeEventType source of truth', async () => {
        const mappedEvents = Object.values(AGENT_RESPONSE_RUNTIME_EVENTS).map(assertRuntimeEventType);
        expect(mappedEvents.length).toBe(6);

        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((event) => events.push(event));
        const kernel = makeKernel();

        await kernel.execute({
            userMessage: 'What can you do right now?',
            operatorMode: 'chat',
            executionMode: 'assistant',
        });

        const pendingTurnResponseEvents = events
            .filter((event) => event.payload?.finalizationState === 'pending')
            .map((event) => event.event);

        expect(pendingTurnResponseEvents.length).toBeGreaterThan(0);
        expect(pendingTurnResponseEvents.every((event) => mappedEvents.includes(event))).toBe(true);
        expect(pendingTurnResponseEvents).toContain(AGENT_RESPONSE_RUNTIME_EVENTS.selfKnowledgeResponseCreated);
        expect(pendingTurnResponseEvents).toContain(AGENT_RESPONSE_RUNTIME_EVENTS.turnResponseCreated);
    });
});
