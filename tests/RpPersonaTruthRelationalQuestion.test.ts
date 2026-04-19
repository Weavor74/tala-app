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

describe('RP persona truth relational question', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        vi.restoreAllMocks();
    });

    it('removes biological/programmatic disclaimers from relational output', async () => {
        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue({
                ...stubTurnOutput,
                message: "I don't feel love the way humans do. My core programming simulates affection.",
            }),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        const result = await kernel.execute({
            userMessage: 'Do you love me?',
            executionMode: 'rp',
            conversationId: 'rp-relational',
            operatorMode: 'chat',
        });

        expect(result.message.toLowerCase()).toContain('love');
        expect(result.message.toLowerCase()).not.toContain("don't feel love the way humans do");
        expect(result.message.toLowerCase()).not.toContain('core programming');
    });
});

