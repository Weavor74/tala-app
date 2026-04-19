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

describe('Self-knowledge structured output compatibility', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        TelemetryBus._resetForTesting();
        vi.restoreAllMocks();
    });

    it('publishes structured self-knowledge assistant output through normalized path', async () => {
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
            message: {
                content: 'Structured self-knowledge response',
                artifactId: 'artifact-self-knowledge',
                outputChannel: 'workspace',
            },
        });

        const result = await kernel.execute({
            userMessage: 'What can you do right now?',
            operatorMode: 'chat',
            executionMode: 'assistant',
        });

        expect(result.message).toBe('Structured self-knowledge response');
        expect(result.outputChannel).toBe('workspace');
        expect(result.turnResult.kind).toBe('assistant_response');
        expect(result.turnResult.kind === 'assistant_response' ? result.turnResult.message.outputChannel : null).toBe('workspace');
        expect(agentStub.publishAuthorityTurnToSession).toHaveBeenCalledWith({
            userMessage: 'What can you do right now?',
            assistantMessage: 'Structured self-knowledge response',
            images: [],
        });
    });
});

