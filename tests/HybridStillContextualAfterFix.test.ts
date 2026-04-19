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

describe('Hybrid mode remains contextual after RP enforcement fix', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        vi.restoreAllMocks();
    });

    it('allows explicit operational/system truth requests in hybrid mode', async () => {
        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue({
                ...stubTurnOutput,
                message: 'I am an agent running in this app, and these are my available tools.',
            }),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        const result = await kernel.execute({
            userMessage: 'What tools do you have in this app?',
            executionMode: 'hybrid',
            conversationId: 'hybrid-contextual-after-fix',
            operatorMode: 'chat',
        });

        expect(result.message.toLowerCase()).toContain('tools');
        expect(result.message.toLowerCase()).toContain('authority sources');
        expect(result.message.toLowerCase()).not.toContain('human may not be the right word');
    });
});
