/**
 * LoreMem0SearchSuppression.test.ts
 *
 * Validates the mem0_search suppression rule added to AgentService tool
 * selection for lore/autobiographical turns.
 *
 * Problem
 * ───────
 * During lore/autobiographical queries RAG/LTMF already returns valid memory.
 * If the model still calls mem0_search and mem0 is degraded or timing out, the
 * response generation is disrupted and Tala falls back to generic output instead
 * of using the high-quality retrieved autobiographical memories.
 *
 * Fix
 * ───
 * In AgentService.ts, after all mode/intent-based tool filtering runs, an
 * additional suppression pass removes mem0_search when either:
 *   Rule 1: intent=lore AND retrieval.approvedCount > 0
 *   Rule 2: responseMode is 'memory_grounded_soft' or 'memory_grounded_strict'
 *
 * These tests mirror the exact conditional branches from the suppression block
 * without requiring the full Electron / brain / settings stack.
 *
 * Covered assertions
 * ──────────────────
 *  Rule 1a: intent=lore with approved memories → mem0_search removed
 *  Rule 1b: intent=lore with zero approved memories → mem0_search kept
 *  Rule 2a: responseMode=memory_grounded_soft → mem0_search removed (any intent)
 *  Rule 2b: responseMode=memory_grounded_strict → mem0_search removed (any intent)
 *  Rule 3:  non-lore, no memory-grounded mode → mem0_search NOT affected
 *  Rule 4:  other tools are never removed by the suppression pass
 *  Rule 5:  already-empty toolsToSend survives suppression without error
 *  Rule 6:  lore intent without approved memories does NOT suppress mem0_search
 *  Rule 7:  memory_grounded_mode takes precedence regardless of intent
 */

import { describe, it, expect } from 'vitest';
import { IntentClassifier } from '../electron/services/router/IntentClassifier';

// ─── Mirror of the suppression logic in AgentService.ts ──────────────────────

type ResponseMode = 'memory_grounded_soft' | 'memory_grounded_strict' | 'none' | undefined;

interface TurnObjectLike {
    intent: { class: string };
    retrieval: { approvedCount: number };
    responseMode?: ResponseMode;
}

interface ToolDef {
    function: { name: string };
}

/**
 * Mirrors the exact suppression block added to AgentService.ts:
 *
 *   const isMemoryGrounded =
 *       turnObject.responseMode === 'memory_grounded_soft' ||
 *       turnObject.responseMode === 'memory_grounded_strict';
 *   const isLoreWithMemory =
 *       turnObject.intent.class === 'lore' && turnObject.retrieval.approvedCount > 0;
 *   if ((isLoreWithMemory || isMemoryGrounded) && toolsToSend.length > 0) {
 *       toolsToSend = toolsToSend.filter((t: any) => t.function.name !== 'mem0_search');
 *   }
 */
function applyLoreMem0Suppression(
    turnObject: TurnObjectLike,
    toolsToSend: ToolDef[],
): ToolDef[] {
    const isMemoryGrounded =
        turnObject.responseMode === 'memory_grounded_soft' ||
        turnObject.responseMode === 'memory_grounded_strict';
    const isLoreWithMemory =
        turnObject.intent.class === 'lore' && turnObject.retrieval.approvedCount > 0;
    if ((isLoreWithMemory || isMemoryGrounded) && toolsToSend.length > 0) {
        return toolsToSend.filter((t) => t.function.name !== 'mem0_search');
    }
    return toolsToSend;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTool(name: string): ToolDef {
    return { function: { name } };
}

const COMMON_TOOLS: ToolDef[] = [
    makeTool('mem0_search'),
    makeTool('retrieve_context'),
    makeTool('query_graph'),
    makeTool('fs_read_text'),
    makeTool('get_emotion_state'),
];

// ─── Rule 1a: lore intent with approved memories removes mem0_search ──────────

describe('Rule 1a — lore intent + approved memories: mem0_search suppressed', () => {
    const turn: TurnObjectLike = {
        intent: { class: 'lore' },
        retrieval: { approvedCount: 3 },
        responseMode: 'memory_grounded_soft',
    };

    it('removes mem0_search from the tool list', () => {
        const result = applyLoreMem0Suppression(turn, [...COMMON_TOOLS]);
        const names = result.map((t) => t.function.name);
        expect(names).not.toContain('mem0_search');
    });

    it('retains all other tools', () => {
        const result = applyLoreMem0Suppression(turn, [...COMMON_TOOLS]);
        const names = result.map((t) => t.function.name);
        expect(names).toContain('retrieve_context');
        expect(names).toContain('query_graph');
        expect(names).toContain('fs_read_text');
        expect(names).toContain('get_emotion_state');
    });

    it('reduces tool count by exactly 1', () => {
        const result = applyLoreMem0Suppression(turn, [...COMMON_TOOLS]);
        expect(result.length).toBe(COMMON_TOOLS.length - 1);
    });
});

// ─── Rule 1b: lore intent with zero approved memories keeps mem0_search ───────

describe('Rule 1b — lore intent + zero approved memories: mem0_search kept', () => {
    const turn: TurnObjectLike = {
        intent: { class: 'lore' },
        retrieval: { approvedCount: 0 },
        responseMode: undefined,
    };

    it('does not remove mem0_search when no approved memories exist', () => {
        const result = applyLoreMem0Suppression(turn, [...COMMON_TOOLS]);
        const names = result.map((t) => t.function.name);
        expect(names).toContain('mem0_search');
    });

    it('returns the original tool list unchanged', () => {
        const result = applyLoreMem0Suppression(turn, [...COMMON_TOOLS]);
        expect(result.length).toBe(COMMON_TOOLS.length);
    });
});

// ─── Rule 2a: memory_grounded_soft removes mem0_search regardless of intent ───

describe('Rule 2a — memory_grounded_soft: mem0_search suppressed for any intent', () => {
    const intents = ['lore', 'conversation', 'coding', 'technical', 'task'];

    intents.forEach((intentClass) => {
        it(`suppresses mem0_search when intent=${intentClass} and responseMode=memory_grounded_soft`, () => {
            const turn: TurnObjectLike = {
                intent: { class: intentClass },
                retrieval: { approvedCount: 2 },
                responseMode: 'memory_grounded_soft',
            };
            const result = applyLoreMem0Suppression(turn, [...COMMON_TOOLS]);
            const names = result.map((t) => t.function.name);
            expect(names).not.toContain('mem0_search');
        });
    });
});

// ─── Rule 2b: memory_grounded_strict removes mem0_search regardless of intent ─

describe('Rule 2b — memory_grounded_strict: mem0_search suppressed for any intent', () => {
    it('suppresses mem0_search when responseMode=memory_grounded_strict', () => {
        const turn: TurnObjectLike = {
            intent: { class: 'lore' },
            retrieval: { approvedCount: 1 },
            responseMode: 'memory_grounded_strict',
        };
        const result = applyLoreMem0Suppression(turn, [...COMMON_TOOLS]);
        const names = result.map((t) => t.function.name);
        expect(names).not.toContain('mem0_search');
    });

    it('retains all tools except mem0_search under strict grounding', () => {
        const turn: TurnObjectLike = {
            intent: { class: 'lore' },
            retrieval: { approvedCount: 5 },
            responseMode: 'memory_grounded_strict',
        };
        const result = applyLoreMem0Suppression(turn, [...COMMON_TOOLS]);
        expect(result.length).toBe(COMMON_TOOLS.length - 1);
        expect(result.map((t) => t.function.name)).not.toContain('mem0_search');
    });
});

// ─── Rule 3: non-lore, no grounded mode keeps mem0_search ─────────────────────

describe('Rule 3 — non-lore / no memory-grounded mode: mem0_search NOT suppressed', () => {
    const nonLoreIntents = ['conversation', 'coding', 'technical', 'task', 'diagnostics'];

    nonLoreIntents.forEach((intentClass) => {
        it(`does not suppress mem0_search for intent=${intentClass} without grounded mode`, () => {
            const turn: TurnObjectLike = {
                intent: { class: intentClass },
                retrieval: { approvedCount: 5 },
                responseMode: undefined,
            };
            const result = applyLoreMem0Suppression(turn, [...COMMON_TOOLS]);
            expect(result.map((t) => t.function.name)).toContain('mem0_search');
        });
    });
});

// ─── Rule 4: other tools are never collateral ─────────────────────────────────

describe('Rule 4 — suppression only removes mem0_search, not other tools', () => {
    it('keeps retrieve_context, query_graph, fs_read_text, get_emotion_state on a lore grounded turn', () => {
        const turn: TurnObjectLike = {
            intent: { class: 'lore' },
            retrieval: { approvedCount: 4 },
            responseMode: 'memory_grounded_soft',
        };
        const result = applyLoreMem0Suppression(turn, [...COMMON_TOOLS]);
        const names = result.map((t) => t.function.name);
        expect(names).toContain('retrieve_context');
        expect(names).toContain('query_graph');
        expect(names).toContain('fs_read_text');
        expect(names).toContain('get_emotion_state');
        expect(names).not.toContain('mem0_search');
    });

    it('does not remove mem0_add even on a lore grounded turn (mem0_add is write, not search)', () => {
        const toolsWithAdd = [...COMMON_TOOLS, makeTool('mem0_add')];
        const turn: TurnObjectLike = {
            intent: { class: 'lore' },
            retrieval: { approvedCount: 2 },
            responseMode: 'memory_grounded_soft',
        };
        const result = applyLoreMem0Suppression(turn, toolsWithAdd);
        const names = result.map((t) => t.function.name);
        expect(names).toContain('mem0_add');
        expect(names).not.toContain('mem0_search');
    });
});

// ─── Rule 5: already-empty toolsToSend survives without error ─────────────────

describe('Rule 5 — empty toolsToSend is handled safely', () => {
    it('returns empty array without error when toolsToSend is empty and lore grounded', () => {
        const turn: TurnObjectLike = {
            intent: { class: 'lore' },
            retrieval: { approvedCount: 3 },
            responseMode: 'memory_grounded_soft',
        };
        const result = applyLoreMem0Suppression(turn, []);
        expect(result).toEqual([]);
    });

    it('returns empty array without error when toolsToSend is empty and non-lore', () => {
        const turn: TurnObjectLike = {
            intent: { class: 'coding' },
            retrieval: { approvedCount: 0 },
            responseMode: undefined,
        };
        const result = applyLoreMem0Suppression(turn, []);
        expect(result).toEqual([]);
    });
});

// ─── Rule 6: lore without memories does NOT suppress ──────────────────────────

describe('Rule 6 — lore intent with zero approved memories does not suppress', () => {
    it('keeps mem0_search when intent=lore but approvedCount=0 and no responseMode', () => {
        const turn: TurnObjectLike = {
            intent: { class: 'lore' },
            retrieval: { approvedCount: 0 },
            responseMode: undefined,
        };
        const result = applyLoreMem0Suppression(turn, [...COMMON_TOOLS]);
        expect(result.map((t) => t.function.name)).toContain('mem0_search');
        expect(result.length).toBe(COMMON_TOOLS.length);
    });
});

// ─── Rule 7: memory_grounded_mode overrides even with empty retrieval ─────────

describe('Rule 7 — memory_grounded_mode takes precedence regardless of approvedCount', () => {
    it('suppresses mem0_search even when approvedCount=0 if responseMode=memory_grounded_soft', () => {
        const turn: TurnObjectLike = {
            intent: { class: 'lore' },
            retrieval: { approvedCount: 0 },
            responseMode: 'memory_grounded_soft',
        };
        const result = applyLoreMem0Suppression(turn, [...COMMON_TOOLS]);
        expect(result.map((t) => t.function.name)).not.toContain('mem0_search');
    });

    it('suppresses mem0_search even when approvedCount=0 if responseMode=memory_grounded_strict', () => {
        const turn: TurnObjectLike = {
            intent: { class: 'lore' },
            retrieval: { approvedCount: 0 },
            responseMode: 'memory_grounded_strict',
        };
        const result = applyLoreMem0Suppression(turn, [...COMMON_TOOLS]);
        expect(result.map((t) => t.function.name)).not.toContain('mem0_search');
    });
});

// ─── Autobiographical query classification sanity ─────────────────────────────

describe('Autobiographical queries classify as lore intent', () => {
    const autobiographicalQueries = [
        'what happened when you were 17?',
        'tell me about your childhood',
        'what were you like growing up?',
        'do you remember when you were young?',
        'what is your backstory?',
        'tell me about your past',
    ];

    autobiographicalQueries.forEach((query) => {
        it(`"${query}" should resolve suppression path (lore intent expected)`, () => {
            const intent = IntentClassifier.classify(query);
            // If the intent is lore, the suppression rule can fire when memories exist.
            // This test confirms the classification precondition is met.
            expect(intent.class).toBe('lore');
        });
    });
});
