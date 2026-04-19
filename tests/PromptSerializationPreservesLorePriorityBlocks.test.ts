import { describe, expect, it } from 'vitest';
import { ChatExecutionSpine } from '../electron/services/execution/ChatExecutionSpine';

describe('Prompt serialization preserves lore priority blocks', () => {
    it('retains strict lore grounding blocks in final serialized prompt payload', () => {
        const spine = new ChatExecutionSpine({} as any);
        const systemPrompt = [
            '[MEMORY GROUNDED RECALL - STRICT MODE]',
            'Use only retrieved autobiographical memory.',
            '',
            '[CANON LORE MEMORIES - HIGH PRIORITY]',
            'Memory 1: Tala rebuilt trust with a full handoff log.',
        ].join('\n');
        const expectedBlocks = [
            '[MEMORY GROUNDED RECALL - STRICT MODE]',
            '[CANON LORE MEMORIES - HIGH PRIORITY]',
        ];

        const payload = (spine as any).buildSerializedPromptPayload({
            turnId: 'turn-2',
            mode: 'rp',
            intent: 'rp_identity',
            systemPrompt,
            messageSequence: [{ role: 'user', content: 'Are you human?' }],
            expectedBlocks,
        });

        expect(payload.promptPriorityBlocksPresent).toEqual(expect.arrayContaining(expectedBlocks));
        expect(payload.includedBlocks).toEqual(expect.arrayContaining(expectedBlocks));
    });
});
