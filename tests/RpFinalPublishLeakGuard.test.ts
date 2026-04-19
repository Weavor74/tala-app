import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';

const stubTurnOutput = {
    message: 'chat output',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

describe('RP final publish leak guard', () => {
    beforeEach(() => {
        PlanningService._resetForTesting();
        PlanningLoopService._resetForTesting(
            { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
            { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
        );
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('blocks and replaces leaked ontology if earlier adaptation misses it', async () => {
        vi.doMock('../electron/services/agent/PersonaIdentityResponseAdapter', async () => {
            const actual = await vi.importActual<typeof import('../electron/services/agent/PersonaIdentityResponseAdapter')>(
                '../electron/services/agent/PersonaIdentityResponseAdapter',
            );
            let passthroughCalls = 0;
            return {
                ...actual,
                buildAssistantPersonaPolicyAdaptation: (input: {
                    rawContent: string;
                }) => {
                    if (passthroughCalls === 0) {
                        passthroughCalls += 1;
                        return {
                            content: input.rawContent,
                            outputChannel: 'chat' as const,
                            adaptationMode: 'passthrough' as const,
                            reasonCodes: ['test.forced_passthrough'],
                            matchedMetaCategories: [],
                        };
                    }
                    return actual.buildAssistantPersonaPolicyAdaptation(input);
                },
            };
        });

        const { AgentKernel } = await import('../electron/services/kernel/AgentKernel');

        const kernel = new AgentKernel({
            chat: vi.fn().mockResolvedValue({
                ...stubTurnOutput,
                message: 'I am not human. I am an agent.',
            }),
            executeTool: vi.fn(),
            executeWorkflow: vi.fn(),
            publishAuthorityTurnToSession: vi.fn(),
        } as any);

        const result = await kernel.execute({
            userMessage: 'Stay with me right now.',
            executionMode: 'rp',
            conversationId: 'rp-final-guard',
            operatorMode: 'chat',
        });

        expect(result.message.toLowerCase()).not.toContain('i am not human');
        expect(result.message.toLowerCase()).not.toContain('i am an agent');
    });
});
