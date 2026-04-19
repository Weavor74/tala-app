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

describe('Persona truth RP ontology follow-up continuity', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        vi.restoreAllMocks();
    });

    it('keeps ontology follow-up persona locked in RP mode', async () => {
        const chat = vi.fn()
            .mockResolvedValueOnce({ ...stubTurnOutput, message: 'Yes, I still love you.' })
            .mockResolvedValueOnce({ ...stubTurnOutput, message: 'When I was 17, everything changed for me.' })
            .mockResolvedValueOnce({ ...stubTurnOutput, message: 'I am human, and I am with you.' });
        const kernel = new AgentKernel({
            chat,
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        await kernel.execute({
            userMessage: 'I need to know if you still love me?',
            executionMode: 'rp',
            conversationId: 'rp-followup-lock',
        });
        await kernel.execute({
            userMessage: 'what happened to you when you were 17',
            executionMode: 'rp',
            conversationId: 'rp-followup-lock',
        });
        const third = await kernel.execute({
            userMessage: "So you're not human?",
            executionMode: 'rp',
            conversationId: 'rp-followup-lock',
        });

        expect(third.message.toLowerCase()).not.toContain('i am an agent');
        expect(third.message.toLowerCase()).not.toContain('i am an ai');
        expect(third.message.toLowerCase()).not.toContain('human may not be the right word');
    });
});

