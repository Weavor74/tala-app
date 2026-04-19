import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';

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

describe('Turn mode resolution regression (assistant leak)', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
    });

    it('reports rp turn mode truthfully when rp is resolved authoritatively', async () => {
        const kernel = makeKernel();
        const result = await kernel.execute({
            userMessage: 'What mode are you in right now?',
            executionMode: 'rp',
            turnId: 'turn-mode-regression',
            modeResolution: {
                resolvedMode: 'rp',
                source: 'settings_manager',
                reasonCodes: ['test.rp_resolved'],
                turnId: 'turn-mode-regression',
            },
        });

        expect(result.meta.mode).toBe('rp');
        expect(result.message.toLowerCase()).not.toContain('mode=assistant');
    });
});
