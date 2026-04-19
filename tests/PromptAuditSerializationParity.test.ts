import { describe, expect, it } from 'vitest';
import { ChatExecutionSpine } from '../electron/services/execution/ChatExecutionSpine';

describe('Prompt audit and serialization parity', () => {
    it('reports parity between expected, serialized, and outbound prompt blocks', () => {
        const spine = new ChatExecutionSpine({} as any);
        const expectedBlocks = [
            '[USER IDENTITY]',
            '[CANON LORE MEMORIES - HIGH PRIORITY]',
        ];
        const payload = (spine as any).buildSerializedPromptPayload({
            turnId: 'turn-3',
            mode: 'rp',
            intent: 'lore',
            systemPrompt: [
                '[USER IDENTITY]',
                'User is Steve.',
                '',
                '[CANON LORE MEMORIES - HIGH PRIORITY]',
                'Memory 1: Tala has canonical autobiographical continuity.',
            ].join('\n'),
            messageSequence: [{ role: 'user', content: 'Tell me what happened when you were 17.' }],
            expectedBlocks,
        });
        const check = (spine as any).checkPromptIntegrity(payload);

        expect(check.ok).toBe(true);
        expect(check.missingRequiredBlocks).toHaveLength(0);
        expect(payload.expectedBlocks).toEqual(expect.arrayContaining(payload.includedBlocks));
    });
});
