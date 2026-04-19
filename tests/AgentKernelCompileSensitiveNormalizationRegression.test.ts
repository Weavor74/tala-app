import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
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
        executeTool: vi.fn().mockResolvedValue('# Tala README'),
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
    return { kernel: new AgentKernel(agentStub as any), agentStub };
}

describe('AgentKernel compile-sensitive outputChannel regression coverage', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        TelemetryBus._resetForTesting();
        vi.restoreAllMocks();
    });

    it('executes self-knowledge and self-inspection paths without outputChannel union break', async () => {
        const { kernel, agentStub } = makeKernel();
        const events: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((event) => events.push(event));

        const selfKnowledgeResult = await kernel.execute({
            userMessage: 'What can you do right now?',
            operatorMode: 'chat',
            executionMode: 'assistant',
        });
        const selfInspectionResult = await kernel.execute({
            userMessage: 'You should read your local README.md',
            operatorMode: 'chat',
            executionMode: 'assistant',
        });

        expect(selfKnowledgeResult.outputChannel).toBeDefined();
        expect(selfInspectionResult.outputChannel).toBeDefined();
        expect(agentStub.chat).not.toHaveBeenCalled();
        const responseChannels = events
            .filter((event) => event.payload?.finalizationState === 'pending')
            .map((event) => event.payload?.channel);
        expect(responseChannels.every((channel) => typeof channel === 'string')).toBe(true);
    });
});

