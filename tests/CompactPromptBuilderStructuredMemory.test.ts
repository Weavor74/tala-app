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

    it('keeps assembled memory context present even when compact supplements are available', () => {
        const prompt = CompactPromptBuilder.build(makeContext({
            memoryContext: '[MEMORY CONTEXT]\nA general memory summary.',
        }));

        expect(prompt).toContain('[MEMORY CONTEXT]\nA general memory summary.');
        expect(prompt).toContain('[CONTINUITY] compact continuity');
        expect(prompt).toContain('[TASK] compact task');
    });

    it('dedupes duplicate memory anchors across [MEMORY CONTEXT] and compact [Context]', () => {
        const repeated = `I'm Tala, and I respond with a warm smile.`;
        const prompt = CompactPromptBuilder.build(makeContext({
            memoryContext: `[MEMORY CONTEXT]\nMemory 1:\nContent: ${repeated}`,
            compactPacket: {
                ...basePacket,
                continuityBlock: `[Context]\n• [recent_continuity] ${repeated}`,
            } as any,
        }));

        const count = (prompt.match(/i'm tala, and i respond with a warm smile\./gi) || []).length;
        expect(count).toBe(1);
        expect(prompt).toContain('[MEMORY CONTEXT]');
    });

    it('keeps distinct continuity content when it is not duplicated', () => {
        const prompt = CompactPromptBuilder.build(makeContext({
            memoryContext: '[MEMORY CONTEXT]\nMemory 1:\nContent: Tala likes tea.',
            compactPacket: {
                ...basePacket,
                continuityBlock: '[Context]\n• [recent_continuity] User asked for CLI help.',
            } as any,
        }));

        expect(prompt).toContain('Tala likes tea.');
        expect(prompt).toContain('[Context]\n• [recent_continuity] User asked for CLI help.');
    });

    it('avoids duplicate contaminated anchor injection in RP opener-style assembly', () => {
        const repeated = "I'm Tala, and I respond with...";
        const prompt = CompactPromptBuilder.build(makeContext({
            dynamicContext: '[RP OPENER STYLE]\nKeep the opening concise and characterful.',
            memoryContext: `[MEMORY CONTEXT]\nMemory 1:\nContent: ${repeated}`,
            compactPacket: {
                ...basePacket,
                continuityBlock: `[Context]\n• [recent_continuity] ${repeated}`,
            } as any,
            rpCharacterLock: '[CHARACTER LOCK — MANDATORY]',
        }));

        const count = (prompt.match(/i'm tala, and i respond with\.\.\./gi) || []).length;
        expect(count).toBe(1);
        expect(prompt).toContain('[CHARACTER LOCK — MANDATORY]');
    });

    it('keeps non-RP cognitive engineering assembly stable for distinct sections', () => {
        const prompt = CompactPromptBuilder.build(makeContext({
            isEngineeringMode: true,
            isSmallLocalModel: true,
            memoryContext: '[MEMORY CONTEXT]\nMemory 1:\nContent: Distinct memory fact.',
            compactPacket: {
                ...basePacket,
                assembledSections: [
                    '[IDENTITY] Tala',
                    '[MODE] assistant',
                    '[Context]\n• [recent_continuity] Distinct continuity fact.',
                    '[TASK] compact task',
                ],
                continuityBlock: '[Context]\n• [recent_continuity] Distinct continuity fact.',
            } as any,
            toolSigs: '[NO TOOLS AVAILABLE IN RP MODE]',
        }));

        expect(prompt).toContain('[IDENTITY] Tala');
        expect(prompt).toContain('[Context]\n• [recent_continuity] Distinct continuity fact.');
        expect(prompt).toContain('Distinct memory fact.');
    });
});
