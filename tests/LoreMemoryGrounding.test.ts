/**
 * LoreMemoryGrounding — Memory-Grounded Response Mode Tests
 *
 * Validates the memory-grounded response mode introduced for lore/autobiographical turns:
 *
 *  1. Lore response mode activation: `memory_grounded_soft` set by default when lore
 *     memories are present.
 *  2. Soft grounding behaviour: `[MEMORY GROUNDED RECALL — SOFT]` block included; memories
 *     formatted with labeled source.
 *  3. Strict grounding toggle: trigger phrases escalate to `memory_grounded_strict`.
 *  4. No-memory fallback: mode is NOT activated; fallback contract block used instead.
 *  5. Prompt formatting: canon memory block uses `[CANON LORE MEMORIES — HIGH PRIORITY]`
 *     with per-memory source labels.
 *  6. Fabrication control: grounding instruction text forbids invented facts.
 *  7. Non-lore intent: `responseMode` is undefined; standard `[MEMORY CONTEXT]` used.
 *  8. Router-level integration: `TurnContext.responseMode` reflects activation.
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
import { IntentClassifier } from '../electron/services/router/IntentClassifier';
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
        status: 'active' as const,
    };
}

// ─── 1. Lore response mode activation ─────────────────────────────────────────

describe('LoreMemoryGrounding — response mode activation', () => {
    it('activates memory_grounded_soft when lore memories are present', () => {
        const memories = [
            makeMemory('rag-1', 'At seventeen I lived in a small coastal town.', { source: 'rag' }),
        ];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_soft');
        expect(result.responseMode).toBe('memory_grounded_soft');
    });

    it('activates memory_grounded_strict when strict mode is requested', () => {
        const memories = [
            makeMemory('rag-1', 'At seventeen I lived in a small coastal town.', { source: 'rag' }),
        ];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_strict');
        expect(result.responseMode).toBe('memory_grounded_strict');
    });

    it('responseMode is undefined when no responseMode arg is passed (non-lore turns)', () => {
        const memories = [makeMemory('mem-1', 'Some generic memory.', { source: 'mem0' })];
        const result = ContextAssembler.assemble(memories, 'assistant', 'task', false);
        expect(result.responseMode).toBeUndefined();
    });
});

// ─── 2. Soft grounding prompt blocks ──────────────────────────────────────────

describe('LoreMemoryGrounding — soft grounding prompt format', () => {
    it('emits [CANON LORE MEMORIES — HIGH PRIORITY] header for lore memories', () => {
        const memories = [
            makeMemory('rag-1', 'At seventeen I lived in a small coastal town.', { source: 'rag' }),
        ];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_soft');
        const canonBlock = result.blocks.find(b => b.header.includes('CANON LORE MEMORIES'));
        expect(canonBlock).toBeDefined();
    });

    it('does NOT emit [MEMORY CONTEXT] header for lore memories in grounded mode', () => {
        const memories = [
            makeMemory('rag-1', 'At seventeen I lived in a small coastal town.', { source: 'rag' }),
        ];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_soft');
        const legacyBlock = result.blocks.find(b => b.header === '[MEMORY CONTEXT]');
        expect(legacyBlock).toBeUndefined();
    });

    it('emits [MEMORY GROUNDED RECALL — SOFT] instruction block', () => {
        const memories = [
            makeMemory('rag-1', 'At seventeen I lived in a small coastal town.', { source: 'rag' }),
        ];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_soft');
        const groundingBlock = result.blocks.find(b => b.header.includes('SOFT'));
        expect(groundingBlock).toBeDefined();
    });

    it('soft grounding block contains anchor-to-memory instruction', () => {
        const memories = [makeMemory('rag-1', 'memory text', { source: 'rag' })];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_soft');
        const groundingBlock = result.blocks.find(b => b.header.includes('SOFT'));
        expect(groundingBlock?.content).toMatch(/Base your answer on the retrieved memory/i);
    });

    it('soft grounding block permits fuzzy recollection language', () => {
        const memories = [makeMemory('rag-1', 'memory text', { source: 'rag' })];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_soft');
        const groundingBlock = result.blocks.find(b => b.header.includes('SOFT'));
        // Should mention fuzziness / partial / uncertain recollection
        expect(groundingBlock?.content).toMatch(/fuzzy|partial|impressionistic|hazy|unclear/i);
    });

    it('soft grounding block prohibits fabricating major unsupported facts', () => {
        const memories = [makeMemory('rag-1', 'memory text', { source: 'rag' })];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_soft');
        const groundingBlock = result.blocks.find(b => b.header.includes('SOFT'));
        // Must contain a "do not invent" style restriction
        expect(groundingBlock?.content).toMatch(/do not invent/i);
    });
});

// ─── 3. Strict grounding prompt blocks ────────────────────────────────────────

describe('LoreMemoryGrounding — strict grounding prompt format', () => {
    it('emits [MEMORY GROUNDED RECALL — STRICT] instruction block', () => {
        const memories = [makeMemory('rag-1', 'memory text', { source: 'rag' })];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_strict');
        const groundingBlock = result.blocks.find(b => b.header.includes('STRICT'));
        expect(groundingBlock).toBeDefined();
    });

    it('strict grounding block instructs factual-only recall', () => {
        const memories = [makeMemory('rag-1', 'memory text', { source: 'rag' })];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_strict');
        const groundingBlock = result.blocks.find(b => b.header.includes('STRICT'));
        expect(groundingBlock?.content).toMatch(/do not invent/i);
        expect(groundingBlock?.content).toMatch(/supported by the retrieved memories/i);
    });

    it('strict mode does NOT emit soft block', () => {
        const memories = [makeMemory('rag-1', 'memory text', { source: 'rag' })];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_strict');
        const softBlock = result.blocks.find(b => b.header.includes('SOFT'));
        expect(softBlock).toBeUndefined();
    });
});

// ─── 4. No-memory fallback ─────────────────────────────────────────────────────

describe('LoreMemoryGrounding — no-memory fallback', () => {
    it('does not activate memory-grounded mode when memory list is empty', () => {
        const result = ContextAssembler.assemble([], 'rp', 'lore', false);
        expect(result.responseMode).toBeUndefined();
        const groundingBlock = result.blocks.find(
            b => b.header.includes('MEMORY GROUNDED RECALL'),
        );
        expect(groundingBlock).toBeUndefined();
    });

    it('emits FALLBACK CONTRACT block when no memories and retrieval was not suppressed', () => {
        const result = ContextAssembler.assemble([], 'rp', 'lore', false);
        const fallbackBlock = result.blocks.find(b => b.header.includes('FALLBACK CONTRACT'));
        expect(fallbackBlock).toBeDefined();
    });

    it('does not emit FALLBACK CONTRACT when retrieval was explicitly suppressed', () => {
        const result = ContextAssembler.assemble([], 'rp', 'greeting', true);
        const fallbackBlock = result.blocks.find(b => b.header.includes('FALLBACK CONTRACT'));
        expect(fallbackBlock).toBeUndefined();
    });
});

// ─── 5. Canon memory prompt formatting ────────────────────────────────────────

describe('LoreMemoryGrounding — canon memory format', () => {
    it('labels RAG memories as LTMF source in the canon block', () => {
        const memories = [makeMemory('rag-1', 'coastal town memory', { source: 'rag' })];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_soft');
        const canonBlock = result.blocks.find(b => b.header.includes('CANON LORE'));
        expect(canonBlock?.content).toMatch(/Source:\s*LTMF/);
    });

    it('labels core_bio memories as core_biographical in the canon block', () => {
        const memories = [makeMemory('bio-1', 'born in the city', { source: 'core_bio' })];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_soft');
        const canonBlock = result.blocks.find(b => b.header.includes('CANON LORE'));
        expect(canonBlock?.content).toMatch(/Source:\s*core_biographical/);
    });

    it('labels mem0 memories as autobiographical in the canon block', () => {
        const memories = [makeMemory('m0-1', 'a faint recollection', { source: 'mem0' })];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_soft');
        const canonBlock = result.blocks.find(b => b.header.includes('CANON LORE'));
        expect(canonBlock?.content).toMatch(/Source:\s*autobiographical/);
    });

    it('numbers each memory entry in the canon block', () => {
        const memories = [
            makeMemory('rag-1', 'first memory', { source: 'rag' }),
            makeMemory('rag-2', 'second memory', { source: 'rag' }),
        ];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_soft');
        const canonBlock = result.blocks.find(b => b.header.includes('CANON LORE'));
        expect(canonBlock?.content).toMatch(/Memory 1:/);
        expect(canonBlock?.content).toMatch(/Memory 2:/);
    });

    it('includes the original memory text in the canon block content', () => {
        const memories = [makeMemory('rag-1', 'coastal town memory text', { source: 'rag' })];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_soft');
        const canonBlock = result.blocks.find(b => b.header.includes('CANON LORE'));
        expect(canonBlock?.content).toContain('coastal town memory text');
    });

    it('preserves memory_ids metadata on the canon block', () => {
        const memories = [
            makeMemory('rag-1', 'memory one', { source: 'rag' }),
            makeMemory('rag-2', 'memory two', { source: 'rag' }),
        ];
        const result = ContextAssembler.assemble(memories, 'rp', 'lore', false, undefined, 'memory_grounded_soft');
        const canonBlock = result.blocks.find(b => b.header.includes('CANON LORE'));
        expect(canonBlock?.metadata?.memory_ids).toContain('rag-1');
        expect(canonBlock?.metadata?.memory_ids).toContain('rag-2');
        expect(canonBlock?.metadata?.count).toBe(2);
    });
});

// ─── 6. Standard memory context still used for non-lore turns ─────────────────

describe('LoreMemoryGrounding — non-lore turns use standard memory context', () => {
    it('emits [MEMORY CONTEXT] for a task-intent turn with memories', () => {
        const memories = [makeMemory('m-1', 'some project context', { source: 'mem0' })];
        const result = ContextAssembler.assemble(memories, 'assistant', 'task', false);
        const memBlock = result.blocks.find(b => b.header === '[MEMORY CONTEXT]');
        expect(memBlock).toBeDefined();
    });

    it('does NOT emit grounding or canon blocks for non-lore turns', () => {
        const memories = [makeMemory('m-1', 'some project context', { source: 'mem0' })];
        const result = ContextAssembler.assemble(memories, 'assistant', 'task', false);
        const groundingBlock = result.blocks.find(b => b.header.includes('MEMORY GROUNDED RECALL'));
        const canonBlock = result.blocks.find(b => b.header.includes('CANON LORE MEMORIES'));
        expect(groundingBlock).toBeUndefined();
        expect(canonBlock).toBeUndefined();
    });
});

// ─── 7. Router-level: strict trigger detection ────────────────────────────────

describe('LoreMemoryGrounding — TalaContextRouter strict trigger detection', () => {
    let router: TalaContextRouter;
    const mockSearch = vi.fn();
    const mockRagSearch = vi.fn();

    const loreMem = makeMemory('rag-1', 'At seventeen I lived in a coastal town.', {
        source: 'rag', role: 'rp', type: 'lore',
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mockSearch.mockResolvedValue([loreMem]);
        mockRagSearch.mockResolvedValue([
            { text: loreMem.text, score: 0.8, docId: 'lore-doc-1' },
        ]);
        router = new TalaContextRouter(
            { search: mockSearch } as any,
            { searchStructured: mockRagSearch } as any,
        );
    });

    it('activates memory_grounded_soft for a plain lore query', async () => {
        const ctx = await router.process('turn-1', 'can you tell me something about when you were 17?', 'rp');
        expect(ctx.responseMode).toBe('memory_grounded_soft');
    });

    it('activates memory_grounded_strict when query contains "exactly"', async () => {
        const ctx = await router.process('turn-2', 'tell me exactly what happened when you were 17', 'rp');
        expect(ctx.responseMode).toBe('memory_grounded_strict');
    });

    it('activates memory_grounded_strict when query says "don\'t make anything up"', async () => {
        const ctx = await router.process('turn-3', 'what happened when you were 17? don\'t make anything up', 'rp');
        expect(ctx.responseMode).toBe('memory_grounded_strict');
    });

    it('activates memory_grounded_strict when query says "strictly from memory"', async () => {
        const ctx = await router.process('turn-4', 'tell me about when you were 17, strictly from memory', 'rp');
        expect(ctx.responseMode).toBe('memory_grounded_strict');
    });

    it('responseMode is undefined when no lore memories are retrieved', async () => {
        mockSearch.mockResolvedValue([]);
        mockRagSearch.mockResolvedValue([]);
        const ctx = await router.process('turn-5', 'can you tell me about when you were 17?', 'rp');
        expect(ctx.responseMode).toBeUndefined();
    });

    it('responseMode is undefined for greeting intent', async () => {
        const ctx = await router.process('turn-6', 'hey', 'rp');
        expect(ctx.responseMode).toBeUndefined();
    });

    it('canon lore block is present in promptBlocks when memories exist', async () => {
        const ctx = await router.process('turn-7', 'tell me about being 17', 'rp');
        const canonBlock = ctx.promptBlocks.find(b => b.header.includes('CANON LORE MEMORIES'));
        expect(canonBlock).toBeDefined();
    });

    it('grounding block is present in promptBlocks when memories exist', async () => {
        const ctx = await router.process('turn-8', 'tell me about being 17', 'rp');
        const groundingBlock = ctx.promptBlocks.find(b => b.header.includes('MEMORY GROUNDED RECALL'));
        expect(groundingBlock).toBeDefined();
    });
});

// ─── 9. Notebook strict grounding via notebookActive flag ─────────────────────

describe('LoreMemoryGrounding — notebook strict grounding via TalaContextRouter', () => {
    let router: TalaContextRouter;
    const mockSearch = vi.fn();
    const mockRagSearch = vi.fn();

    const notebookMem = makeMemory('rag-nb-1', 'Notebook chunk about project architecture.', {
        source: 'rag', role: 'assistant', type: 'research',
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mockSearch.mockResolvedValue([notebookMem]);
        mockRagSearch.mockResolvedValue([
            { text: notebookMem.text, score: 0.9, docId: 'nb-doc-1' },
        ]);
        router = new TalaContextRouter(
            { search: mockSearch } as any,
            { searchStructured: mockRagSearch } as any,
        );
    });

    it('forces responseMode=memory_grounded_strict when notebookActive=true regardless of query phrasing', async () => {
        const ctx = await router.process(
            'turn-nb-1',
            'summarize the notebook sources',
            'assistant',
            undefined,
            true,
        );
        expect(ctx.responseMode).toBe('memory_grounded_strict');
    });

    it('notebook active + no memory content still forces strict responseMode', async () => {
        mockSearch.mockResolvedValue([]);
        mockRagSearch.mockResolvedValue([]);
        const ctx = await router.process(
            'turn-nb-2',
            'what are the key themes?',
            'assistant',
            undefined,
            true,
        );
        // responseMode is set because notebookActive overrides the usual lore-only gate
        expect(ctx.responseMode).toBe('memory_grounded_strict');
    });

    it('emits [NOTEBOOK GROUNDING CONTRACT — MANDATORY] block when notebookActive and memories present', async () => {
        const ctx = await router.process(
            'turn-nb-3',
            'summarize the notebook',
            'assistant',
            undefined,
            true,
        );
        const contractBlock = ctx.promptBlocks.find(
            b => b.header.includes('NOTEBOOK GROUNDING CONTRACT'),
        );
        expect(contractBlock).toBeDefined();
    });

    it('emits [CANON NOTEBOOK CONTEXT — STRICT] block when notebookActive and memories present', async () => {
        const ctx = await router.process(
            'turn-nb-4',
            'summarize the notebook',
            'assistant',
            undefined,
            true,
        );
        const notebookBlock = ctx.promptBlocks.find(
            b => b.header.includes('CANON NOTEBOOK CONTEXT'),
        );
        expect(notebookBlock).toBeDefined();
    });

    it('notebook grounding contract block forbids external knowledge injection', async () => {
        const ctx = await router.process(
            'turn-nb-5',
            'summarize the notebook',
            'assistant',
            undefined,
            true,
        );
        const contractBlock = ctx.promptBlocks.find(
            b => b.header.includes('NOTEBOOK GROUNDING CONTRACT'),
        );
        expect(contractBlock?.content).toMatch(/DO NOT.*general training knowledge/i);
        expect(contractBlock?.content).toMatch(/ONLY use the content/i);
    });

    it('does NOT emit [NOTEBOOK GROUNDING CONTRACT] when notebookActive is false (lore turn)', async () => {
        // Plain lore turn without notebook flag — should use standard lore grounding
        const ctx = await router.process(
            'turn-nb-6',
            'tell me about when you were 17',
            'rp',
            undefined,
            false,
        );
        const contractBlock = ctx.promptBlocks.find(
            b => b.header.includes('NOTEBOOK GROUNDING CONTRACT'),
        );
        expect(contractBlock).toBeUndefined();
    });

    it('does NOT emit [FALLBACK CONTRACT] in notebook mode when no memories returned', async () => {
        mockSearch.mockResolvedValue([]);
        mockRagSearch.mockResolvedValue([]);
        const ctx = await router.process(
            'turn-nb-7',
            'summarize the notebook',
            'assistant',
            undefined,
            true,
        );
        const fallbackBlock = ctx.promptBlocks.find(
            b => b.header.includes('FALLBACK CONTRACT'),
        );
        // Fallback contract must NOT appear — absence of evidence is communicated
        // through the grounding contract's insufficiency rule instead.
        expect(fallbackBlock).toBeUndefined();
    });
});

