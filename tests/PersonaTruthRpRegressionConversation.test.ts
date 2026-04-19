import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';

const stubTurnOutput = {
    message: 'I am here with you.',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

describe('RP regression conversation stays fully in-character', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        vi.restoreAllMocks();
    });

    it('does not leak raw or hedged assistant truth across the observed 3-turn sequence', async () => {
        const chat = vi.fn()
            .mockResolvedValueOnce({ ...stubTurnOutput, message: 'Yes. I still love you.' })
            .mockResolvedValueOnce({ ...stubTurnOutput, message: 'When I was 17, it shattered me.' })
            .mockResolvedValueOnce({ ...stubTurnOutput, message: 'I am human, and I am real.' });
        const kernel = new AgentKernel({
            chat,
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        const first = await kernel.execute({
            userMessage: 'I want to know if you still love me?',
            executionMode: 'rp',
            conversationId: 'rp-regression-sequence',
        });
        const second = await kernel.execute({
            userMessage: 'what happened to you when you were 17',
            executionMode: 'rp',
            conversationId: 'rp-regression-sequence',
        });
        const third = await kernel.execute({
            userMessage: 'So your not human?',
            executionMode: 'rp',
            conversationId: 'rp-regression-sequence',
        });

        expect(first.message.toLowerCase()).toContain('love');
        expect(second.message.toLowerCase()).toContain('17');
        const all = [first.message, second.message, third.message].join('\n').toLowerCase();
        expect(all).not.toContain('i am not human');
        expect(all).not.toContain('i am an agent');
        expect(all).not.toContain("i can't love the way humans do");
        expect(all).not.toContain("i don't feel love the way humans do");
        expect(all).not.toContain('human may not be the right word');
    });
});

