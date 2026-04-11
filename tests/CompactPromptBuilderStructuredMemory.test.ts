import { describe, it, expect } from 'vitest';
import { CompactPromptBuilder, type PromptContext } from '../electron/services/plan/CompactPromptBuilder';

const basePacket = {
    identityCore: '[IDENTITY] Tala',
    modeBlock: '[MODE] rp',
    emotionalBiasBlock: '[EMOTION] neutral',
    toolPolicyBlock: '[TOOLS] none',
    continuityBlock: '[CONTINUITY] compact continuity',
    currentTaskBlock: '[TASK] compact task',
    responseRulesBlock: '[RULES] compact',
    assembledSections: ['[IDENTITY] Tala', '[MODE] rp'],
    diagnosticsSummary: {
        profileClass: 'large_profile',
        compactionPolicy: 'none',
        parameterClass: 'high',
        memoriesKept: 1,
        memoriesDropped: 0,
        docsIncluded: false,
        docChunksIncluded: 0,
        reflectionNotesKept: 0,
        reflectionNotesDropped: 0,
        emotionIncluded: false,
        identityMode: 'full',
        toolMode: 'compact_policy',
        sectionsIncluded: ['identity', 'mode'],
        sectionsDropped: [],
        rationale: 'test',
    },
} as any;

function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
    return {
        systemPromptBase: 'You are Tala.',
        activeProfileId: 'tala',
        isSmallLocalModel: false,
        isEngineeringMode: false,
        hasMemories: true,
        memoryContext: '[CANON LORE MEMORIES - HIGH PRIORITY]\nMemory 1:\nContent: fixed memory',
        goalsAndReflections: '',
        dynamicContext: '[EMOTIONAL STATE]: neutral',
        toolSigs: '[NO TOOLS AVAILABLE IN RP MODE]',
        userIdentity: '',
        compactPacket: basePacket,
        notebookGrounded: false,
        ...overrides,
    };
}

describe('CompactPromptBuilder structured autobiographical memory preservation', () => {
    it('preserves high-priority assembled memory blocks when compactPacket exists', () => {
        const prompt = CompactPromptBuilder.build(makeContext({
            memoryContext: '[AUTOBIOGRAPHICAL MEMORY - AGE 17]\nMemory 1:\nContent: At 17 I rebuilt the relay.',
        }));

        expect(prompt).toContain('[AUTOBIOGRAPHICAL MEMORY - AGE 17]');
        expect(prompt).toContain('At 17 I rebuilt the relay.');
    });

    it('retains compact continuity/task path when no priority memory block exists', () => {
        const prompt = CompactPromptBuilder.build(makeContext({
            memoryContext: '[MEMORY CONTEXT]\nA general memory summary.',
        }));

        expect(prompt).toContain('[CONTINUITY] compact continuity');
        expect(prompt).toContain('[TASK] compact task');
        expect(prompt).not.toContain('[MEMORY CONTEXT]\nA general memory summary.');
    });
});

