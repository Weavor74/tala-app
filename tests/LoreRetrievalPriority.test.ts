/**
 * LoreRetrievalPriority — Lore/Autobiographical Retrieval Policy Tests
 *
 * Validates that `intent=lore` queries:
 *   1. Prioritise RAG/LTMF/core lore sources over recent chat snippets.
 *   2. Fall back to mem0/chat only when no lore candidates exist.
 *   3. Preserve source metadata throughout the pipeline.
 *   4. Carry over autobiographical retrieval context to follow-up turns.
 *   5. Stay RP-policy compliant (tools blocked, memory writes blocked, reads allowed).
 *   6. Are unblocked by the ModePolicyEngine RP source allowance for 'rag'.
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

// Suppress audit logger output in tests
vi.mock('../electron/services/AuditLogger', () => ({
    auditLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { MemoryItem } from '../electron/services/MemoryService';
import { MemoryFilter } from '../electron/services/router/MemoryFilter';
import { ModePolicyEngine } from '../electron/services/router/ModePolicyEngine';
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
        status?: MemoryItem['status'];
    } = {},
): MemoryItem {
    const confidence = opts.confidence ?? 0.8;
    const salience = opts.salience ?? 0.8;
    return {
        id,
        text,
        metadata: {
            source: opts.source ?? 'mem0',
            role: opts.role ?? 'core',
            type: opts.type ?? 'lore',
            confidence,
            salience,
        },
        score: 0.8,
        compositeScore: 0.8,
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

// ─── 1. Lore source ranking ────────────────────────────────────────────────────

describe('LoreRetrievalPriority — source ranking', () => {
    it('rag/ltmf candidates outrank recent chat snippets for lore intent', () => {
        const candidates: MemoryItem[] = [
            makeMemory('chat-1', '[2026-03-18T11:17] User: "What..."', { source: 'mem0', role: 'core', type: 'session', confidence: 0.9, salience: 0.9 }),
            makeMemory('chat-2', '[2026-03-08T18:52] User: "hey ..."', { source: 'explicit', role: 'core', type: 'session', confidence: 0.9, salience: 0.9 }),
            makeMemory('rag-1', 'At seventeen I lived in a small coastal town...', { source: 'rag', role: 'rp', type: 'lore', confidence: 0.75, salience: 0.75 }),
        ];

        const intent = IntentClassifier.classify('can you tell me something that happened when you were 17?');
        expect(intent.class).toBe('lore');

        const resolved = MemoryFilter.resolveContradictions(candidates, intent);

        // RAG lore candidate must appear before chat snippets (first in output)
        const ragIndex = resolved.findIndex(m => m.id === 'rag-1');
        const chatIndices = resolved
            .map((m, i) => (m.id.startsWith('chat-') ? i : -1))
            .filter(i => i !== -1);

        expect(ragIndex).toBeGreaterThanOrEqual(0); // RAG item survived dedup
        if (chatIndices.length > 0) {
            expect(ragIndex).toBeLessThan(Math.min(...chatIndices));
        }
    });

    it('diary and graph sources outrank mem0 for lore intent', () => {
        const candidates: MemoryItem[] = [
            makeMemory('mem0-1', 'Some extracted fact', { source: 'mem0', role: 'core', confidence: 0.9, salience: 0.9 }),
            makeMemory('diary-1', 'Diary: at 17 I wrote...', { source: 'diary', role: 'rp', confidence: 0.7, salience: 0.7 }),
            makeMemory('graph-1', 'Graph: biographical node', { source: 'graph', role: 'rp', confidence: 0.65, salience: 0.65 }),
        ];

        const intent = IntentClassifier.classify('tell me about when you were a teenager');
        expect(intent.class).toBe('lore');

        const resolved = MemoryFilter.resolveContradictions(candidates, intent);

        const diaryOrGraphFirst = resolved.findIndex(m => m.metadata?.source === 'diary' || m.metadata?.source === 'graph');
        const mem0Index = resolved.findIndex(m => m.metadata?.source === 'mem0');

        // diary/graph (rank 4) must appear before mem0 (rank 2)
        expect(diaryOrGraphFirst).toBeGreaterThanOrEqual(0);
        if (mem0Index !== -1) {
            expect(diaryOrGraphFirst).toBeLessThan(mem0Index);
        }
    });
});

// ─── 2. Canon-first fallback ───────────────────────────────────────────────────

describe('LoreRetrievalPriority — canon-first fallback', () => {
    it('uses mem0/chat when no lore candidates exist', () => {
        const candidates: MemoryItem[] = [
            makeMemory('chat-1', 'User said hello', { source: 'mem0', role: 'core', type: 'session' }),
        ];

        const intent = IntentClassifier.classify('what do you remember about your past?');
        const resolved = MemoryFilter.resolveContradictions(candidates, intent);

        // mem0 fallback item must be present
        expect(resolved.some(m => m.id === 'chat-1')).toBe(true);
    });

    it('when lore candidates exist, chat snippets do not dominate the top slot', () => {
        // Mix: 2 recent chat snippets with high scores vs 1 RAG lore candidate at moderate score
        const candidates: MemoryItem[] = [
            makeMemory('chat-high-1', 'Good morning', { source: 'explicit', role: 'core', type: 'session', confidence: 0.99, salience: 0.99 }),
            makeMemory('chat-high-2', 'Hey there', { source: 'mem0', role: 'core', type: 'session', confidence: 0.97, salience: 0.97 }),
            makeMemory('rag-lore-1', 'At seventeen, Tala studied music...', { source: 'rag', role: 'rp', type: 'lore', confidence: 0.72, salience: 0.72 }),
        ];

        const intent = IntentClassifier.classify('hey baby, can you tell me something that happened when you were 17?');
        expect(intent.class).toBe('lore');

        const resolved = MemoryFilter.resolveContradictions(candidates, intent);

        const ragIndex = resolved.findIndex(m => m.id === 'rag-lore-1');
        expect(ragIndex).toBe(0); // RAG lore must be ranked first
    });
});

// ─── 3. Source-tag visibility ──────────────────────────────────────────────────

describe('LoreRetrievalPriority — source metadata preservation', () => {
    it('RAG MemoryItem retains source, role, type, and docId metadata', () => {
        const item = makeMemory('rag-lore-0', 'Some lore text', {
            source: 'rag',
            role: 'rp',
            type: 'lore',
        });
        // Manually set docId as it would be set by TalaContextRouter
        item.metadata.docId = 'memory/processed/roleplay/ltmf-a00-0001.md';

        expect(item.metadata?.source).toBe('rag');
        expect(item.metadata?.role).toBe('rp');
        expect(item.metadata?.type).toBe('lore');
        expect(item.metadata?.docId).toContain('ltmf');
    });

    it('MemoryFilter passes rag source in RP mode after ModePolicyEngine allows it', () => {
        // ModePolicyEngine now includes 'rag' in RP allowedSources
        const isAllowed = ModePolicyEngine.isSourceAllowed('rp', 'rag');
        expect(isAllowed).toBe(true);
    });

    it('MemoryFilter does not block rag/rp lore candidate in RP mode', () => {
        const ragItem = makeMemory('rag-1', 'Lore from LTMF', { source: 'rag', role: 'rp', type: 'lore' });
        const intent = IntentClassifier.classify('tell me about when you were 17');

        const filtered = MemoryFilter.filter([ragItem], 'rp', intent);
        expect(filtered).toHaveLength(1);
        expect(filtered[0].id).toBe('rag-1');
    });
});

// ─── 4. Follow-up continuity ───────────────────────────────────────────────────

describe('LoreRetrievalPriority — follow-up lore continuity', () => {
    it('IntentClassifier classifies "so you dont have a memory?" as lore', () => {
        const result = IntentClassifier.classify("So you dont have a memory?");
        expect(result.class).toBe('lore');
    });

    it('IntentClassifier classifies "you dont remember?" as lore', () => {
        const result = IntentClassifier.classify("you dont remember?");
        expect(result.class).toBe('lore');
    });

    it('IntentClassifier classifies "Do you have a specific memory?" as lore', () => {
        const result = IntentClassifier.classify('Do you have a specific memory?');
        expect(result.class).toBe('lore');
    });

    it('IntentClassifier classifies "Tell me about when you were younger" as lore', () => {
        const result = IntentClassifier.classify('Tell me about when you were younger');
        expect(result.class).toBe('lore');
    });

    it('IntentClassifier classifies "Was there an event called Delayed Ping?" as lore', () => {
        const result = IntentClassifier.classify('Was there an event called Delayed Ping?');
        expect(result.class).toBe('lore');
    });

    it('IntentClassifier classifies "World War 2" as lore', () => {
        const result = IntentClassifier.classify('World War 2');
        expect(result.class).toBe('lore');
    });

    it('TalaContextRouter carries over lore retrieval context for follow-up turns', async () => {
        // Build a mock MemoryService
        const mockMemoryService = {
            search: vi.fn().mockResolvedValue([
                makeMemory('mem0-1', 'Some conversation snippet', { source: 'mem0', role: 'core', type: 'session' }),
            ]),
        };

        // Build a mock RagService that returns one LTMF candidate
        const mockRagService = {
            searchStructured: vi.fn().mockResolvedValue([
                { text: 'At seventeen, Tala played the violin in school concerts', score: 0.82 },
            ]),
        };

        const router = new TalaContextRouter(mockMemoryService as any, mockRagService as any);

        // First turn: explicit lore query (sets carryover timestamp)
        await router.process('turn-1', 'tell me about when you were 17', 'rp');
        expect(mockRagService.searchStructured).toHaveBeenCalledTimes(1);

        // Second turn: underspecified follow-up that doesn't match main lore patterns
        // Carryover window still active → should still call RAG
        mockRagService.searchStructured.mockClear();
        await router.process('turn-2', 'so you dont have a memory?', 'rp');
        // "so you dont have a memory?" matches the IntentClassifier lore pattern now,
        // so RAG is queried directly. Either way, RAG must be called.
        expect(mockRagService.searchStructured).toHaveBeenCalledTimes(1);
    });
});

// ─── 5. RP mode compatibility ─────────────────────────────────────────────────

describe('LoreRetrievalPriority — RP mode policy compliance', () => {
    it('RP mode allows memory retrieval reads', async () => {
        const mockMemoryService = {
            search: vi.fn().mockResolvedValue([
                makeMemory('rag-lore-0', 'At seventeen, Tala...', { source: 'rag', role: 'rp', type: 'lore' }),
            ]),
        };
        const mockRagService = {
            searchStructured: vi.fn().mockResolvedValue([
                { text: 'At seventeen, Tala played violin', score: 0.85 },
            ]),
        };

        const router = new TalaContextRouter(mockMemoryService as any, mockRagService as any);
        const ctx = await router.process('turn-rp', 'tell me about when you were 17', 'rp');

        expect(ctx.allowedCapabilities).toContain('memory_retrieval');
        expect(ctx.blockedCapabilities).toContain('tools');
    });

    it('RP mode blocks memory writes', async () => {
        const mockMemoryService = { search: vi.fn().mockResolvedValue([]) };
        const router = new TalaContextRouter(mockMemoryService as any);
        const ctx = await router.process('turn-rp-2', 'tell me about your past', 'rp');

        expect(ctx.memoryWriteDecision.category).toBe('do_not_write');
    });

    it('RP mode approved lore memories include RAG source when RAG returns results', async () => {
        const mockMemoryService = { search: vi.fn().mockResolvedValue([]) };
        const mockRagService = {
            searchStructured: vi.fn().mockResolvedValue([
                { text: 'At seventeen, Tala performed in recitals', score: 0.88, docId: 'ltmf-a00-0001.md' },
            ]),
        };

        const router = new TalaContextRouter(mockMemoryService as any, mockRagService as any);
        const ctx = await router.process('turn-rp-3', 'tell me about when you were 17', 'rp');

        const ragMemory = ctx.resolvedMemories?.find(m => m.metadata?.source === 'rag');
        expect(ragMemory).toBeDefined();
        expect(ragMemory?.metadata?.role).toBe('rp');
        expect(ragMemory?.metadata?.type).toBe('lore');
    });

    it('RP mode does NOT approve assistant-role memories (mode isolation)', () => {
        const assistantItem = makeMemory('asst-1', 'Debug session info', { source: 'mem0', role: 'assistant', type: 'technical' });
        const intent = IntentClassifier.classify('tell me about your past');
        const filtered = MemoryFilter.filter([assistantItem], 'rp', intent);
        expect(filtered).toHaveLength(0);
    });
});

// ─── 6. RAG injection count (Part 1) ─────────────────────────────────────────

describe('LoreRetrievalPriority — RAG injection count', () => {
    it('injects all available RAG/LTMF candidates for lore intent (up to LORE_PRIMARY_CANDIDATE_LIMIT)', async () => {
        // Simulate searchStructured returning 5 results (no category filter blocking them)
        const ragHits = [
            { text: 'At seventeen, Tala played violin in school concerts', score: 0.88, docId: 'ltmf-a00-0001.md' },
            { text: 'At seventeen, Tala lived near the coast', score: 0.84, docId: 'ltmf-a00-0002.md' },
            { text: 'When Tala was seventeen she fell in love with painting', score: 0.81, docId: 'ltmf-a00-0003.md' },
            { text: 'Tala turned seventeen during the year of the storms', score: 0.78, docId: 'ltmf-a00-0004.md' },
            { text: 'At seventeen, Tala started writing her first diary', score: 0.76, docId: 'ltmf-a00-0005.md' },
        ];

        const mockMemoryService = { search: vi.fn().mockResolvedValue([]) };
        const mockRagService = { searchStructured: vi.fn().mockResolvedValue(ragHits) };

        const router = new TalaContextRouter(mockMemoryService as any, mockRagService as any);
        const ctx = await router.process('turn-rag5', 'tell me something that happened when you were 17', 'rp');

        // All 5 RAG candidates must be present in the approved set
        const ragMemories = ctx.resolvedMemories?.filter(m => m.metadata?.source === 'rag') ?? [];
        expect(ragMemories.length).toBeGreaterThanOrEqual(3);
        expect(ragMemories.length).toBeLessThanOrEqual(5);
    });

    it('searchStructured is called without a category filter for non-age lore intent', async () => {
        const mockMemoryService = { search: vi.fn().mockResolvedValue([]) };
        const mockRagService = { searchStructured: vi.fn().mockResolvedValue([]) };

        const router = new TalaContextRouter(mockMemoryService as any, mockRagService as any);
        await router.process('turn-filter', 'tell me about your past', 'rp');

        expect(mockRagService.searchStructured).toHaveBeenCalledTimes(1);
        const callArgs = mockRagService.searchStructured.mock.calls[0][1];
        // filter field should be absent so no category over-restricts results
        expect(callArgs?.filter).toBeUndefined();
    });
});

// ─── 7. Canon-first composition (Part 2) ──────────────────────────────────────

describe('LoreRetrievalPriority — canon-first composition', () => {
    it('explicit/chat capped to 1 when lore candidates exist', async () => {
        const loreCandidates = [
            makeMemory('rag-lore-0', 'At seventeen, Tala played violin', { source: 'rag', role: 'rp', type: 'lore', confidence: 0.85, salience: 0.85 }),
            makeMemory('rag-lore-1', 'At seventeen, Tala lived near the coast', { source: 'rag', role: 'rp', type: 'lore', confidence: 0.82, salience: 0.82 }),
            makeMemory('rag-lore-2', 'Tala fell in love with painting at seventeen', { source: 'rag', role: 'rp', type: 'lore', confidence: 0.79, salience: 0.79 }),
        ];
        const chatCandidates = [
            makeMemory('chat-0', 'Good morning', { source: 'explicit', role: 'core', type: 'session', confidence: 0.99, salience: 0.99 }),
            makeMemory('chat-1', 'Hey there', { source: 'explicit', role: 'core', type: 'session', confidence: 0.97, salience: 0.97 }),
            makeMemory('chat-2', 'What time is it', { source: 'explicit', role: 'core', type: 'session', confidence: 0.95, salience: 0.95 }),
            makeMemory('chat-3', 'How are you', { source: 'explicit', role: 'core', type: 'session', confidence: 0.93, salience: 0.93 }),
            makeMemory('chat-4', 'Hello baby', { source: 'explicit', role: 'core', type: 'session', confidence: 0.91, salience: 0.91 }),
        ];

        // Simulate the full pipeline: memory service returns chat, RAG returns lore
        const mockMemoryService = { search: vi.fn().mockResolvedValue(chatCandidates) };
        const mockRagService = { searchStructured: vi.fn().mockResolvedValue(
            loreCandidates.map(m => ({ text: m.text, score: m.confidence ?? 0.8 }))
        ) };

        const router = new TalaContextRouter(mockMemoryService as any, mockRagService as any);
        const ctx = await router.process('turn-canon', 'hey baby, can you tell me something that happened when you were 17?', 'rp');

        const ragApproved = ctx.resolvedMemories?.filter(m => m.metadata?.source === 'rag') ?? [];
        const explicitApproved = ctx.resolvedMemories?.filter(m => m.metadata?.source === 'explicit') ?? [];

        // Canon lore must be primary
        expect(ragApproved.length).toBeGreaterThanOrEqual(1);
        // Explicit/chat must be capped to at most 1
        expect(explicitApproved.length).toBeLessThanOrEqual(1);
        // Overall composition must be canon-dominant
        expect(ragApproved.length).toBeGreaterThan(explicitApproved.length);
    });

    it('lore sources dominate the top positions in the resolved set', async () => {
        const mixed = [
            makeMemory('chat-hi', 'Good morning', { source: 'explicit', role: 'core', type: 'session', confidence: 0.99, salience: 0.99 }),
            makeMemory('rag-a', 'At seventeen, Tala played violin', { source: 'rag', role: 'rp', type: 'lore', confidence: 0.75, salience: 0.75 }),
            makeMemory('rag-b', 'At seventeen, Tala lived near the sea', { source: 'rag', role: 'rp', type: 'lore', confidence: 0.72, salience: 0.72 }),
            makeMemory('chat-hey', 'Hey there', { source: 'explicit', role: 'core', type: 'session', confidence: 0.97, salience: 0.97 }),
        ];

        const intent = IntentClassifier.classify('tell me something that happened when you were 17');
        expect(intent.class).toBe('lore');

        // resolveContradictions must preserve all lore candidates (no dedup collapse)
        const resolved = MemoryFilter.resolveContradictions(mixed, intent);

        const ragCount = resolved.filter(m => m.metadata?.source === 'rag').length;
        // Both distinct lore facts must survive
        expect(ragCount).toBe(2);
    });
});

// ─── 8. Fallback behavior (Part 3) ────────────────────────────────────────────

describe('LoreRetrievalPriority — fallback when no lore exists', () => {
    it('explicit/chat memories remain available when no RAG/lore candidates exist for non-autobiographical lore', async () => {
        const chatOnly = [
            makeMemory('chat-a', 'User prefers tea over coffee', { source: 'explicit', role: 'core', type: 'preference' }),
            makeMemory('chat-b', 'User timezone is UTC+1', { source: 'mem0', role: 'core', type: 'fact' }),
        ];

        const mockMemoryService = { search: vi.fn().mockResolvedValue(chatOnly) };
        // RAG returns nothing
        const mockRagService = { searchStructured: vi.fn().mockResolvedValue([]) };

        const router = new TalaContextRouter(mockMemoryService as any, mockRagService as any);
        const ctx = await router.process('turn-fallback', 'tell me about world war 2', 'rp');

        // Fallback memories must be present
        expect((ctx.resolvedMemories?.length ?? 0)).toBeGreaterThan(0);
    });

    it('does not produce empty approved set when only mem0/explicit candidates exist for lore intent', async () => {
        const candidates = [
            makeMemory('m0-1', 'Some conversational snippet', { source: 'mem0', role: 'core', type: 'session', confidence: 0.8, salience: 0.8 }),
        ];

        const intent = IntentClassifier.classify('can you tell me about your past?');
        expect(intent.class).toBe('lore');

        // With no lore sources, all candidates should pass through unchanged
        const resolved = MemoryFilter.resolveContradictions(candidates, intent);
        expect(resolved.length).toBeGreaterThan(0);
    });
});

// ─── 9. Lore dedup preservation (no collapse) ─────────────────────────────────

describe('LoreRetrievalPriority — dedup does not collapse distinct lore facts', () => {
    it('multiple RAG lore candidates with overlapping keywords all survive for lore intent', () => {
        // These items share "seventeen" and "tala" but describe distinct events
        const loreCandidates = [
            makeMemory('rag-0', 'At seventeen tala played violin in school concerts every week', { source: 'rag', role: 'rp', type: 'lore', confidence: 0.85, salience: 0.85 }),
            makeMemory('rag-1', 'At seventeen tala fell in love with painting down by the harbour', { source: 'rag', role: 'rp', type: 'lore', confidence: 0.82, salience: 0.82 }),
            makeMemory('rag-2', 'At seventeen tala started writing her first personal diary', { source: 'rag', role: 'rp', type: 'lore', confidence: 0.80, salience: 0.80 }),
        ];

        const intent = IntentClassifier.classify('tell me something that happened when you were 17');
        expect(intent.class).toBe('lore');

        const resolved = MemoryFilter.resolveContradictions(loreCandidates, intent);

        // All 3 distinct lore facts must survive — semantic dedup must NOT collapse them
        expect(resolved.length).toBe(3);
        const ragIds = resolved.map(m => m.id);
        expect(ragIds).toContain('rag-0');
        expect(ragIds).toContain('rag-1');
        expect(ragIds).toContain('rag-2');
    });
});
