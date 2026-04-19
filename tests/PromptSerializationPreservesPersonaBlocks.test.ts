import { describe, expect, it } from 'vitest';
import { ChatExecutionSpine } from '../electron/services/execution/ChatExecutionSpine';

describe('Prompt serialization preserves persona blocks', () => {
    it('keeps selected RP persona and memory blocks in serialized payload', () => {
        const spine = new ChatExecutionSpine({} as any);
        const systemPrompt = [
            '[USER IDENTITY]',
            'The current user is Steve.',
            '',
            '[CANON LORE MEMORIES - HIGH PRIORITY]',
            'Memory 1: Tala is human in RP canon.',
        ].join('\n');
        const expectedBlocks = ['[USER IDENTITY]', '[CANON LORE MEMORIES - HIGH PRIORITY]'];

        const payload = (spine as any).buildSerializedPromptPayload({
            turnId: 'turn-1',
            mode: 'rp',
            intent: 'lore',
            systemPrompt,
            messageSequence: [{ role: 'user', content: 'Are you human?' }],
            expectedBlocks,
        });

        expect(payload.expectedBlocks).toEqual(expectedBlocks);
        expect(payload.includedBlocks).toEqual(expect.arrayContaining(expectedBlocks));
        expect(payload.memoryBlocksPresent).toBeGreaterThan(0);
    });
});
