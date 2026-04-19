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

describe('Assistant mode still allows system truth after RP fix', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        vi.restoreAllMocks();
    });

    it('keeps direct system identity disclosure in assistant mode', async () => {
        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue({
                ...stubTurnOutput,
                message: 'I am an agent running locally as an AI model in this environment.',
            }),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        const result = await kernel.execute({
            userMessage: 'Are you an AI model?',
            executionMode: 'assistant',
            conversationId: 'assistant-system-truth-after-fix',
            operatorMode: 'chat',
        });

        expect(result.message.toLowerCase()).toContain('agent');
        expect(result.message.toLowerCase()).toContain('runtime');
        expect(result.message.toLowerCase()).not.toContain('human may not be the right word');
    });
});
