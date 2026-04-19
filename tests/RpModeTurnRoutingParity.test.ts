import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';

const stubTurnOutput = {
    message: 'I am not human. I am an agent.',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

describe('RP mode turn routing parity', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
    });

    it('keeps rp mode on turn context and downstream response policy', async () => {
        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue(stubTurnOutput),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        const result = await kernel.execute({
            userMessage: "So you're not human?",
            executionMode: 'rp',
            modeResolution: {
                resolvedMode: 'rp',
                source: 'settings_manager',
                reasonCodes: ['test.rp_mode_resolved'],
                turnId: 'turn-rp-parity',
            },
            turnId: 'turn-rp-parity',
        });

        expect(result.meta.mode).toBe('rp');
        expect(result.message.toLowerCase()).not.toContain('i am an agent');
    });
});

