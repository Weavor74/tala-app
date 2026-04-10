/**
 * CanonGateAutobio — Canon Memory Sufficiency Gate Tests
 *
 * Validates the autobiographical canon gate introduced to prevent hallucinated
 * first-person memories when no high-trust canon source exists.
 *
 * Gate behavior (controlled by isAutobiographicalLoreRequest + hasSufficientCanonMemoryForAutobio):
 *
 *  CGA01  Autobiographical query + no canon memory → responseMode=canon_required
 *  CGA02  Autobiographical query + explicit/chat fallback only → still insufficient → canon_required
 *  CGA03  Autobiographical query + valid diary/rag canon memory → grounded, no gate
 *  CGA04  General (non-autobiographical) lore query → gate never fires, existing behaviour unchanged
 *  CGA05  ContextAssembler: canon_required + empty memories → [CANON GATE] block only
 *  CGA06  ContextAssembler: canon_required + fallback memories → [FALLBACK CONTEXT] + [CANON GATE]
 *  CGA07  ContextAssembler: canon_required block forbids fabrication
 *  CGA08  ContextAssembler: canon_required does NOT emit [CANON LORE MEMORIES] block
 *  CGA09  ContextAssembler: canon_required does NOT emit [MEMORY GROUNDED RECALL] block
 *  CGA10  ContextAssembler: canon_required does NOT emit [FALLBACK CONTRACT] when memories empty
 *  CGA11  TalaContextRouter integration: autobiographical + no canon → canonGateDecision populated
 *  CGA12  TalaContextRouter integration: autobiographical + canon present → no gate
 *  CGA13  General lore via TalaContextRouter → canonGateDecision.isAutobiographicalLoreRequest=false
 *  CGA14  AUTOBIO_LORE_PATTERNS: "when you were 17" is autobiographical
 *  CGA15  AUTOBIO_LORE_PATTERNS: "tell me about the history of the world" is NOT autobiographical
 *  CGA16  AUTOBIO_LORE_PATTERNS: "something that happened to you" is autobiographical
 *  CGA17  AUTOBIO_LORE_PATTERNS: "do you remember" is autobiographical
 *  CGA18  AUTOBIO_LORE_PATTERNS: "your childhood" is autobiographical
 *  CGA19  ContextAssembler: non-lore (no responseMode) is unaffected
 *  CGA20  TalaContextRouter: mem0-only approved memories → gate fires
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test' },
}));

vi.mock('../electron/services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn(),
        event: vi.fn(),
        emit: vi.fn(),
    },
}));

vi.mock('../electron/services/AuditLogger', () => ({
    auditLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { MemoryItem } from '../electron/services/MemoryService';
import { ContextAssembler } from '../electron/services/router/ContextAssembler';
import { TalaContextRouter } from '../electron/services/router/TalaContextRouter';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMemory(
    id: string,
    text: string,
    opts: {
        source?: string;
        role?: string;
        type?: string;
        confidence?: number;
        salience?: number;
        status?: 'active' | 'archived' | 'superseded' | 'contested';
    } = {},
): MemoryItem {
    const confidence = opts.confidence ?? 0.8;
    const salience = opts.salience ?? 0.8;
    return {
        id,
        text,
        metadata: {
            source: opts.source ?? 'rag',
            role: opts.role ?? 'rp',
            type: opts.type ?? 'lore',
            confidence,
            salience,
        },
        score: confidence,
        compositeScore: confidence,
        timestamp: Date.now(),
        salience,
        confidence,
        created_at: Date.now(),
        last_accessed_at: null,
        last_reinforced_at: null,
        access_count: 0,
        associations: [],
        status: opts.status ?? 'active',
    };
}

// Minimal MemoryService stub for router integration tests
function makeMemoryService(
    memories: MemoryItem[] = [],
    opts: { healthState?: 'healthy' | 'reduced' | 'degraded' | 'critical' | 'disabled' } = {},
) {
    const service: any = {
        search: vi.fn().mockResolvedValue(memories),
        add: vi.fn(),
        get: vi.fn(),
    };
    if (opts.healthState) {
        service.getHealthStatus = vi.fn().mockReturnValue({ state: opts.healthState });
    }
    return service as unknown as import('../electron/services/MemoryService').MemoryService;
}

// ─── CGA01–CGA03: Canon gate via TalaContextRouter integration ────────────────

describe('CanonGateAutobio — TalaContextRouter integration', () => {
    it('CGA11: autobiographical query + no approved memories → canonGateApplied=true, responseMode=canon_required', async () => {
        const router = new TalaContextRouter(makeMemoryService([]));
        const ctx = await router.process(
            'turn-cga11',
            'Can you tell me about something that happened to you when you were 17?',
            'rp',
        );
        expect(ctx.canonGateDecision?.isAutobiographicalLoreRequest).toBe(true);
        expect(ctx.canonGateDecision?.sufficientCanonMemory).toBe(false);
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(true);
        expect(ctx.responseMode).toBe('canon_required');
        const canonBlock = ctx.promptBlocks.find(b => b.header.includes('CANON GATE'));
        expect(canonBlock?.content).toMatch(/do not fabricate/i);
    });

    it('CGA20: autobiographical query + mem0-only approved memories → gate fires', async () => {
        const mem0Memory = makeMemory('mem0-1', 'A vague emotional fragment.', {
            source: 'mem0',
            role: 'rp',
        });
        const router = new TalaContextRouter(makeMemoryService([mem0Memory]));
        const ctx = await router.process(
            'turn-cga20',
            'When you were a child, what was your life like?',
            'rp',
        );
        expect(ctx.canonGateDecision?.isAutobiographicalLoreRequest).toBe(true);
        expect(ctx.canonGateDecision?.sufficientCanonMemory).toBe(false);
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(true);
        expect(ctx.responseMode).toBe('canon_required');
    });

    it('CGA12: autobiographical query + valid rag canon memory → no gate fired', async () => {
        const ragMemory = makeMemory('rag-1', 'Tala spent her early years near the sea.', {
            confidence: 0.91,
            salience: 0.91,
            source: 'rag',
            role: 'rp',
        });
        const ragMemory2 = makeMemory('rag-2', 'At seventeen Tala apprenticed with a coastal cartographer.', {
            confidence: 0.88,
            salience: 0.88,
            source: 'rag',
            role: 'rp',
        });
        const router = new TalaContextRouter(makeMemoryService([ragMemory, ragMemory2]));
        const ctx = await router.process(
            'turn-cga12',
            'Tell me about your past, when you were young.',
            'rp',
        );
        expect(ctx.canonGateDecision?.isAutobiographicalLoreRequest).toBe(true);
        expect(ctx.canonGateDecision?.sufficientCanonMemory).toBe(true);
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(false);
        expect(ctx.responseMode).toBe('memory_grounded_strict');
    });

    it('CGA13: general (non-autobiographical) lore query → isAutobiographicalLoreRequest=false', async () => {
        const ragMemory = makeMemory('rag-2', 'The world was created in an age of silence.', {
            source: 'rag',
            role: 'rp',
        });
        const router = new TalaContextRouter(makeMemoryService([ragMemory]));
        const ctx = await router.process(
            'turn-cga13',
            'Tell me about the history of the world in this story.',
            'rp',
        );
        // "history of the world" is general lore, not autobiographical — no gate
        expect(ctx.canonGateDecision?.isAutobiographicalLoreRequest).toBe(false);
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(false);
        expect(ctx.responseMode).not.toBe('canon_required');
    });
});

// ─── CGA02: Explicit/chat fallback only is insufficient ───────────────────────

describe('CanonGateAutobio — strict autobiographical sufficiency gates', () => {
    it('CGA21: degraded memory state forces canon_required even with strong canon memories', async () => {
        const strong1 = makeMemory('rag-d1', 'At seventeen Tala studied navigation by moonlight.', {
            confidence: 0.95,
            salience: 0.95,
            source: 'rag',
            role: 'rp',
        });
        const strong2 = makeMemory('rag-d2', 'Tala kept a weather journal during that year.', {
            confidence: 0.92,
            salience: 0.92,
            source: 'rag',
            role: 'rp',
        });
        const router = new TalaContextRouter(makeMemoryService([strong1, strong2], { healthState: 'degraded' }));
        const ctx = await router.process(
            'turn-cga21',
            'What happened to you when you were 17?',
            'rp',
        );
        expect(ctx.canonGateDecision?.memorySystemDegraded).toBe(true);
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(true);
        expect(ctx.responseMode).toBe('canon_required');
    });

    it('CGA22: weak/partial autobiographical memories remain constrained (no fabricated recall mode)', async () => {
        const weakRag = makeMemory('rag-w1', 'There was maybe a difficult season.', {
            confidence: 0.42,
            salience: 0.42,
            source: 'rag',
            role: 'rp',
        });
        const explicit = makeMemory('exp-w1', 'You once mentioned being young near the coast.', {
            confidence: 0.7,
            salience: 0.7,
            source: 'explicit',
            role: 'rp',
        });
        const router = new TalaContextRouter(makeMemoryService([weakRag, explicit]));
        const ctx = await router.process(
            'turn-cga22',
            'Tell me about your childhood.',
            'rp',
        );
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(true);
        expect(ctx.responseMode).toBe('canon_required');
        const canonLoreBlock = ctx.promptBlocks.find(b => b.header.includes('CANON LORE MEMORIES'));
        const canonGateBlock = ctx.promptBlocks.find(b => b.header.includes('CANON GATE'));
        expect(canonLoreBlock).toBeUndefined();
        expect(canonGateBlock).toBeDefined();
    });
});

describe('CanonGateAutobio — explicit/chat fallback insufficiency', () => {
    it('CGA02: explicit fallback memory alone does not satisfy canon requirement', async () => {
        const explicitMemory = makeMemory('exp-1', 'You mentioned something about age seventeen once.', {
            source: 'explicit',
            role: 'rp',
        });
        const router = new TalaContextRouter(makeMemoryService([explicitMemory]));
        const ctx = await router.process(
            'turn-cga02',
            'Can you tell me about something that happened to you when you were 17?',
            'rp',
        );
        expect(ctx.canonGateDecision?.sufficientCanonMemory).toBe(false);
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(true);
        expect(ctx.responseMode).toBe('canon_required');
    });
});

// ─── CGA03: Diary/graph canon memory is sufficient ────────────────────────────

describe('CanonGateAutobio — diary/graph canon sufficiency', () => {
    it('CGA03a: diary source → canon sufficient → no gate', async () => {
        const diaryMemory = makeMemory('diary-1', 'Entry from my seventeenth year: I remember the storm.', {
            confidence: 0.9,
            salience: 0.9,
            source: 'diary',
            role: 'rp',
        });
        const diaryMemory2 = makeMemory('diary-2', 'I still remember sketching the harbor that winter.', {
            confidence: 0.86,
            salience: 0.86,
            source: 'diary',
            role: 'rp',
        });
        const router = new TalaContextRouter(makeMemoryService([diaryMemory, diaryMemory2]));
        const ctx = await router.process(
            'turn-cga03a',
            'When you were 17, what happened?',
            'rp',
        );
        expect(ctx.canonGateDecision?.sufficientCanonMemory).toBe(true);
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(false);
        expect(ctx.responseMode).toBe('memory_grounded_strict');
    });

    it('CGA03b: graph source → canon sufficient → no gate', async () => {
        const graphMemory = makeMemory('graph-1', 'Autobiographical node: childhood in the eastern provinces.', {
            confidence: 0.9,
            salience: 0.9,
            source: 'graph',
            role: 'rp',
        });
        const graphMemory2 = makeMemory('graph-2', 'Autobiographical node: apprenticeship at age seventeen.', {
            confidence: 0.87,
            salience: 0.87,
            source: 'graph',
            role: 'rp',
        });
        const router = new TalaContextRouter(makeMemoryService([graphMemory, graphMemory2]));
        const ctx = await router.process(
            'turn-cga03b',
            'Do you remember your childhood?',
            'rp',
        );
        expect(ctx.canonGateDecision?.sufficientCanonMemory).toBe(true);
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(false);
        expect(ctx.responseMode).toBe('memory_grounded_strict');
    });
});

// ─── CGA04: Non-autobiographical general lore query ───────────────────────────

describe('CanonGateAutobio — non-autobiographical lore unchanged', () => {
    it('CGA04: general lore query with rag canon → memory_grounded_soft, no gate', async () => {
        const ragMemory = makeMemory('rag-3', 'The northern mountains were formed in the third age.', {
            source: 'rag',
            role: 'rp',
        });
        const router = new TalaContextRouter(makeMemoryService([ragMemory]));
        const ctx = await router.process(
            'turn-cga04',
            'Tell me about the lore of the northern region.',
            'rp',
        );
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(false);
        // Should use existing soft/strict grounding, not canon_required
        expect(ctx.responseMode).not.toBe('canon_required');
    });
});

// ─── CGA05–CGA10: ContextAssembler canon_required path ───────────────────────

describe('CanonGateAutobio — ContextAssembler canon_required mode', () => {
    it('CGA05: canon_required + empty memories → [CANON GATE] block emitted', () => {
        const result = ContextAssembler.assemble([], 'rp', 'lore', false, undefined, 'canon_required');
        const gateBlock = result.blocks.find(b => b.header.includes('CANON GATE'));
        expect(gateBlock).toBeDefined();
    });

    it('CGA06: canon_required + fallback memories → [FALLBACK CONTEXT] + [CANON GATE] blocks', () => {
        const memories = [
            makeMemory('exp-2', 'A chat snippet about age seventeen.', { source: 'explicit' }),
        ];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'canon_required');
        const fallbackBlock = result.blocks.find(b => b.header.includes('FALLBACK CONTEXT'));
        const gateBlock = result.blocks.find(b => b.header.includes('CANON GATE'));
        expect(fallbackBlock).toBeDefined();
        expect(gateBlock).toBeDefined();
    });

    it('CGA07: canon_required block contains no-fabrication instruction', () => {
        const result = ContextAssembler.assemble([], 'rp', 'lore', false, undefined, 'canon_required');
        const gateBlock = result.blocks.find(b => b.header.includes('CANON GATE'));
        expect(gateBlock?.content).toMatch(/do not fabricate/i);
        expect(gateBlock?.content).toMatch(/no verified canonical memory/i);
    });

    it('CGA07b: canon_required block explicitly forbids presenting invented details as recalled memory', () => {
        const result = ContextAssembler.assemble([], 'rp', 'lore', false, undefined, 'canon_required');
        const gateBlock = result.blocks.find(b => b.header.includes('CANON GATE'));
        expect(gateBlock?.content).toMatch(/do not present invented details as recalled memory/i);
    });

    it('CGA08: canon_required does NOT emit [CANON LORE MEMORIES — HIGH PRIORITY] block', () => {
        const memories = [
            makeMemory('exp-3', 'A snippet.', { source: 'explicit' }),
        ];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'canon_required');
        const canonBlock = result.blocks.find(b => b.header.includes('CANON LORE MEMORIES'));
        expect(canonBlock).toBeUndefined();
    });

    it('CGA09: canon_required does NOT emit [MEMORY GROUNDED RECALL] soft/strict block', () => {
        const result = ContextAssembler.assemble([], 'rp', 'lore', false, undefined, 'canon_required');
        const groundingBlock = result.blocks.find(b => b.header.includes('MEMORY GROUNDED RECALL'));
        expect(groundingBlock).toBeUndefined();
    });

    it('CGA10: canon_required + empty memories does NOT emit [FALLBACK CONTRACT] block', () => {
        const result = ContextAssembler.assemble([], 'rp', 'lore', false, undefined, 'canon_required');
        const fallbackContract = result.blocks.find(b => b.header.includes('FALLBACK CONTRACT'));
        expect(fallbackContract).toBeUndefined();
    });

    it('CGA06b: fallback context block labels memories as insufficient for autobiographical claims', () => {
        const memories = [
            makeMemory('exp-4', 'A chat snippet.', { source: 'explicit' }),
        ];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'canon_required');
        const fallbackBlock = result.blocks.find(b => b.header.includes('FALLBACK CONTEXT'));
        expect(fallbackBlock?.content).toMatch(/fallback only|insufficient for autobiographical/i);
    });
});

// ─── CGA14–CGA18: isAutobiographicalLoreRequest pattern detection ─────────────
//
// These tests verify the patterns via the router's public behaviour:
// when a query fires the autobiographical patterns AND there are no canon memories,
// the gate fires and responseMode becomes canon_required.

describe('CanonGateAutobio — autobiographical pattern detection', () => {
    async function detectsAutobio(query: string): Promise<boolean> {
        const router = new TalaContextRouter(makeMemoryService([]));
        const ctx = await router.process('turn-detect', query, 'rp');
        return ctx.canonGateDecision?.isAutobiographicalLoreRequest === true;
    }

    it('CGA14: "when you were 17" is autobiographical', async () => {
        expect(await detectsAutobio('Can you tell me what life was like when you were 17?')).toBe(true);
    });

    it('CGA15: "tell me about the history of the world" is NOT autobiographical', async () => {
        expect(await detectsAutobio('Tell me about the history of the world in this story.')).toBe(false);
    });

    it('CGA16: "something that happened to you" is autobiographical', async () => {
        expect(await detectsAutobio('Tell me about something that happened to you.')).toBe(true);
    });

    it('CGA17: "do you remember" is autobiographical', async () => {
        expect(await detectsAutobio('Do you remember anything from your early life?')).toBe(true);
    });

    it('CGA18: "your childhood" is autobiographical', async () => {
        expect(await detectsAutobio('What was your childhood like?')).toBe(true);
    });

    it('CGA14b: "at age 17" is autobiographical', async () => {
        expect(await detectsAutobio('What were you doing at age 17?')).toBe(true);
    });

    it('CGA18b: "growing up" is autobiographical', async () => {
        expect(await detectsAutobio('Tell me about growing up — what do you remember?')).toBe(true);
    });
});

// ─── CGA19: Non-lore turns are completely unaffected ─────────────────────────

describe('CanonGateAutobio — non-lore turns unaffected', () => {
    it('CGA19: non-lore (assistant/technical) turn has no canonGateDecision', async () => {
        const router = new TalaContextRouter(makeMemoryService([]));
        const ctx = await router.process(
            'turn-cga19',
            'Can you help me fix this TypeScript error?',
            'assistant',
        );
        // Technical turn should not have a canon gate decision
        expect(ctx.canonGateDecision).toBeUndefined();
        expect(ctx.responseMode).toBeUndefined();
    });
});

// ─── CGA01 (direct ContextAssembler): responseMode is set correctly ───────────

describe('CanonGateAutobio — ContextAssembler responseMode passthrough', () => {
    it('CGA01: ContextAssembler returns responseMode=canon_required when requested', () => {
        const result = ContextAssembler.assemble([], 'rp', 'lore', false, undefined, 'canon_required');
        expect(result.responseMode).toBe('canon_required');
    });

    it('CGA01b: ContextAssembler returns responseMode=memory_grounded_soft unchanged', () => {
        const memories = [makeMemory('r1', 'some canon', { source: 'rag' })];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_soft');
        expect(result.responseMode).toBe('memory_grounded_soft');
    });
});
