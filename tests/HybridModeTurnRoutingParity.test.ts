import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';

const stubTurnOutput = {
    message: 'I am an agent running in this app.',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

describe('Hybrid mode turn routing parity', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
    });

    it('keeps hybrid mode stable throughout turn execution', async () => {
        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue(stubTurnOutput),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        const result = await kernel.execute({
            userMessage: 'What tools do you have in this app?',
            executionMode: 'hybrid',
            modeResolution: {
                resolvedMode: 'hybrid',
                source: 'settings_manager',
                reasonCodes: ['test.hybrid_mode_resolved'],
                turnId: 'turn-hybrid-parity',
            },
            turnId: 'turn-hybrid-parity',
        });

        expect(result.meta.mode).toBe('hybrid');
        expect(result.message.toLowerCase()).toContain('tools');
    });
});
