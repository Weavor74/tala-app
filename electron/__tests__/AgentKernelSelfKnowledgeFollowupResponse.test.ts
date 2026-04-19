import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../services/kernel/AgentKernel';
import { SystemModeManager } from '../services/SystemModeManager';

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
    vi.spyOn(kernel as any, 'classifyExecution').mockImplementation((_request: any, meta: any) => {
        meta.turnArbitration = {
            turnId: 'turn-self-knowledge-followup',
            mode: 'conversational',
            source: 'test',
            confidence: 1,
            reasonCodes: ['test:self_knowledge_followup'],
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
    return { kernel };
}

describe('AgentKernelSelfKnowledgeFollowupResponse', () => {
    beforeEach(() => {
        vi.spyOn(SystemModeManager, 'getSystemHealthSnapshot').mockReturnValue({
            mode_contract: { writes_allowed: true },
            capability_matrix: [],
            active_degradation_flags: [],
            subsystem_entries: [],
            effective_mode: 'NORMAL',
        } as any);
    });

    it('returns a visible assistant response for "Hey tala what can you do?"', async () => {
        const { kernel } = createKernel();
        const result = await kernel.execute({
            userMessage: 'Hey tala what can you do?',
            origin: 'ipc',
            executionMode: 'assistant',
            capabilitiesOverride: { allowWritesThisTurn: true },
        });

        expect(result.turnResult.kind).toBe('assistant_response');
        expect(result.message).toBeTruthy();
        expect(result.message?.length).toBeGreaterThan(10);
    });
});

