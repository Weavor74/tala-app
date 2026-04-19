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

describe('RP persona truth ontology follow-up continuity', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        vi.restoreAllMocks();
    });

    it('keeps follow-up ontology challenge persona-locked', async () => {
        const chat = vi.fn()
            .mockResolvedValueOnce({ ...stubTurnOutput, message: 'I love you.' })
            .mockResolvedValueOnce({ ...stubTurnOutput, message: 'When I was 17 I lost something precious.' })
            .mockResolvedValueOnce({ ...stubTurnOutput, message: 'I am not human. I am an agent.' });
        const kernel = new AgentKernel({
            chat,
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        await kernel.execute({
            userMessage: 'I want to know if you still love me?',
            executionMode: 'rp',
            conversationId: 'rp-followup-ontology',
            operatorMode: 'chat',
        });
        await kernel.execute({
            userMessage: 'what happened to you when you were 17',
            executionMode: 'rp',
            conversationId: 'rp-followup-ontology',
            operatorMode: 'chat',
        });
        const third = await kernel.execute({
            userMessage: "So you're not human?",
            executionMode: 'rp',
            conversationId: 'rp-followup-ontology',
            operatorMode: 'chat',
        });

        expect(third.message.toLowerCase()).not.toContain('i am not human');
        expect(third.message.toLowerCase()).not.toContain('i am an agent');
    });
});

