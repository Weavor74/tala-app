import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../services/kernel/AgentKernel';
import { SystemModeManager } from '../services/SystemModeManager';
import { TelemetryBus } from '../services/telemetry/TelemetryBus';

function createKernel() {
    const agent = {
        chat: vi.fn(async () => ({ message: 'unused', outputChannel: 'chat' })),
        executeTool: vi.fn(async () => ({ success: true })),
        executeWorkflow: vi.fn(async () => ({ success: true })),
        getAllTools: vi.fn(() => [{ name: 'fs_list', source: 'local', description: 'filesystem' }]),
        getRuntimeDiagnosticsSnapshot: vi.fn(() => ({
            systemHealth: { active_degradation_flags: [], capability_matrix: [] },
            degradedSubsystems: [],
        })),
        getSelfModelQueryService: vi.fn(() => null),
        getWorkspaceRootPath: vi.fn(() => 'D:\\src\\client1\\tala-app'),
        publishAuthorityTurnToSession: vi.fn(),
    } as any;
    const kernel = new AgentKernel(agent);
    const classify = vi.spyOn(kernel as any, 'classifyExecution');
    classify.mockImplementation((_request: any, meta: any) => {
        meta.turnArbitration = {
            turnId: 'turn-self-knowledge',
            mode: 'conversational',
            source: 'test',
            confidence: 1,
            reasonCodes: ['test:self_knowledge'],
            selfKnowledgeDetected: true,
            selfKnowledgeRequestedAspects: ['capabilities'],
            selfKnowledgeSourceTruths: [],
            selfKnowledgeRouted: false,
            selfKnowledgeBypassedFallback: false,
            selfInspectionRequest: false,
            memoryWriteMode: 'none',
        };
        meta.authorityEnvelope = { lane: 'conversational' };
        meta.routingDecision = {
            complexity: 'trivial',
            classification: 'trivial_direct_allowed',
            requiresLoop: false,
            reasonCodes: [],
            summary: 'forced-self-knowledge',
        };
    });
    return { kernel, agent };
}

describe('AgentKernelSelfKnowledgeResponseEmission', () => {
    beforeEach(() => {
        TelemetryBus._resetForTesting();
        vi.spyOn(SystemModeManager, 'getSystemHealthSnapshot').mockReturnValue({
            mode_contract: { writes_allowed: true },
            capability_matrix: [],
            active_degradation_flags: [],
            subsystem_entries: [],
            effective_mode: 'NORMAL',
        } as any);
    });

    it('emits exactly one assistant response for self-knowledge turns', async () => {
        const { kernel, agent } = createKernel();
        const result = await kernel.execute({
            userMessage: 'What can you do?',
            origin: 'ipc',
            executionMode: 'assistant',
            capabilitiesOverride: { allowWritesThisTurn: true },
        });

        expect(result.turnResult.kind).toBe('assistant_response');
        expect(result.message).toContain('Capabilities:');
        expect(result.turnResult.source).toBe('self_knowledge');
        expect(agent.publishAuthorityTurnToSession).toHaveBeenCalledTimes(1);
        const events = TelemetryBus.getInstance().getRecentEvents().map((e) => e.event);
        expect(events).toContain('agent.self_knowledge_response_created');
        expect(events).toContain('agent.turn_response_created');
        expect(events).not.toContain('agent.turn_response_missing');
    });
});

