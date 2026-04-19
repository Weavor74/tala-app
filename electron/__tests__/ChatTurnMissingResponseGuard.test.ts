import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../services/kernel/AgentKernel';
import { SystemModeManager } from '../services/SystemModeManager';
import { TelemetryBus } from '../services/telemetry/TelemetryBus';

describe('ChatTurnMissingResponseGuard', () => {
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

    it('converts missing self-knowledge response artifacts into explicit turn failure', async () => {
        const agent = {
            chat: vi.fn(async () => ({ message: 'unused', outputChannel: 'chat' })),
            executeTool: vi.fn(async () => ({ success: true })),
            executeWorkflow: vi.fn(async () => ({ success: true })),
            getAllTools: vi.fn(() => []),
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
                turnId: 'turn-self-knowledge-empty',
                mode: 'conversational',
                source: 'test',
                confidence: 1,
                reasonCodes: ['test:missing_response'],
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
        vi.spyOn((kernel as any)._selfKnowledgeExecution, 'executeSelfKnowledgeTurn').mockResolvedValue({
            executed: true,
            sourceTruths: [],
            summary: '',
            snapshot: {
                identity: {},
                capabilities: {
                    filesystemRead: false,
                    filesystemWrite: false,
                    toolUsage: false,
                    memoryRead: false,
                    memoryWrite: false,
                    selfInspection: false,
                    reflectionAccess: false,
                    architectureAccess: false,
                    invariantsAccess: false,
                },
                currentTurn: { writesAllowed: false, toolsAllowed: false },
                runtime: { selfModelAvailable: false, toolRegistryAvailable: false },
                tools: [],
            },
        });

        const result = await kernel.execute({
            userMessage: 'What can you do?',
            origin: 'ipc',
            executionMode: 'assistant',
            capabilitiesOverride: { allowWritesThisTurn: true },
        });

        expect(result.turnResult.kind).toBe('turn_failure');
        if (result.turnResult.kind === 'turn_failure') {
            expect(result.turnResult.errorCode).toBe('chat_turn_missing_response_artifact');
        }
        const events = TelemetryBus.getInstance().getRecentEvents().map((e) => e.event);
        expect(events).toContain('agent.turn_response_missing');
    });
});

