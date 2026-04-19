import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';

const stubTurnOutput = {
    message: 'chat output',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

describe('Legacy string assistant output compatibility', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        TelemetryBus._resetForTesting();
        vi.restoreAllMocks();
    });

    it('normalizes legacy string assistant output and publishes with chat channel default', async () => {
        const agentStub = {
            chat: vi.fn().mockResolvedValue(stubTurnOutput),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        };
        const kernel = new AgentKernel(agentStub as any);
        vi.spyOn(kernel as any, 'runDelegatedFlow').mockResolvedValue({
            kind: 'assistant_response',
            source: 'self_knowledge',
            message: 'Legacy raw string output',
        } as any);

        const result = await kernel.execute({
            userMessage: 'Who are you right now?',
            operatorMode: 'chat',
            executionMode: 'assistant',
        });

        expect(result.message).toBe('Legacy raw string output');
        expect(result.outputChannel).toBe('chat');
        expect(result.turnResult.kind).toBe('assistant_response');
        if (result.turnResult.kind === 'assistant_response') {
            expect(result.turnResult.message).toEqual({
                content: 'Legacy raw string output',
                outputChannel: 'chat',
            });
        }
        expect(agentStub.publishAuthorityTurnToSession).toHaveBeenCalledWith({
            userMessage: 'Who are you right now?',
            assistantMessage: 'Legacy raw string output',
            images: [],
        });
    });
});

