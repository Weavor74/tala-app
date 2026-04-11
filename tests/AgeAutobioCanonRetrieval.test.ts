import { describe, it, expect, vi } from 'vitest';

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
import { TalaContextRouter } from '../electron/services/router/TalaContextRouter';

function makeExplicitMemory(id: string, text: string): MemoryItem {
    const now = Date.now();
    return {
        id,
        text,
        metadata: {
            source: 'explicit',
            role: 'core',
            type: 'session',
            confidence: 0.95,
            salience: 0.95,
        },
        score: 0.95,
        compositeScore: 0.95,
        timestamp: now,
        salience: 0.95,
        confidence: 0.95,
        created_at: now,
        last_accessed_at: null,
        last_reinforced_at: null,
        access_count: 0,
        associations: [],
        status: 'active',
    };
}

function makeMemoryService(
    memories: MemoryItem[] = [],
    opts: { healthState?: 'healthy' | 'reduced' | 'degraded' | 'critical' | 'disabled' } = {},
) {
    const service: any = {
        search: vi.fn().mockResolvedValue(memories),
    };
    if (opts.healthState) {
        service.getHealthStatus = vi.fn().mockReturnValue({ state: opts.healthState });
    }
    return service;
}

function makeAge17RagHit(
    text: string,
    sequence: number,
    opts: {
        score?: number;
        metadata?: Record<string, unknown>;
    } = {},
) {
    const score = opts.score ?? 0.86;
    return {
        text,
        score,
        docId: `LTMF-A17-00${sequence}.md`,
        metadata: {
            age: 17,
            source_type: 'ltmf',
            memory_type: 'autobiographical',
            canon: true,
            age_sequence: sequence,
            ...(opts.metadata ?? {}),
        },
    };
}

describe('LTMF autobiographical age retrieval', () => {
    it('maps age-query phrasings to age=17 structured canon filters', async () => {
        const memoryService = { search: vi.fn().mockResolvedValue([]) };
        const ragService = { searchStructured: vi.fn().mockResolvedValue([]) };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        const queries = [
            'when you were 17, what changed for you?',
            'what happened at 17?',
            'tell me about during your seventeenth year',
        ];

        for (const query of queries) {
            await router.process(`turn-${query}`, query, 'rp');
            const call = ragService.searchStructured.mock.calls[ragService.searchStructured.mock.calls.length - 1];
            expect(call[1]?.filter).toEqual({
                age: 17,
                source_type: 'ltmf',
                memory_type: 'autobiographical',
                canon: true,
            });
        }
    });

    it('extracts age from imperfect phrasing: "your 17"', async () => {
        const memoryService = { search: vi.fn().mockResolvedValue([]) };
        const ragService = { searchStructured: vi.fn().mockResolvedValue([]) };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        await router.process('turn-your-17', 'Tell me about when your 17', 'rp');
        const call = ragService.searchStructured.mock.calls[0];
        expect(call[1]?.filter).toEqual({
            age: 17,
            source_type: 'ltmf',
            memory_type: 'autobiographical',
            canon: true,
        });
    });

    it('extracts age from fused missing-space phrasing: "aboutwhen you were 17"', async () => {
        const memoryService = { search: vi.fn().mockResolvedValue([]) };
        const ragService = { searchStructured: vi.fn().mockResolvedValue([]) };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        await router.process('turn-aboutwhen-17', 'Tell me aboutwhen you were 17', 'rp');
        const call = ragService.searchStructured.mock.calls[0];
        expect(call[1]?.filter).toEqual({
            age: 17,
            source_type: 'ltmf',
            memory_type: 'autobiographical',
            canon: true,
        });
    });

    it('extracts age from imperfect phrasing: "when u were 17"', async () => {
        const memoryService = { search: vi.fn().mockResolvedValue([]) };
        const ragService = { searchStructured: vi.fn().mockResolvedValue([]) };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        await router.process('turn-u-were-17', 'Can you tell me what happened when u were 17?', 'rp');
        const call = ragService.searchStructured.mock.calls[0];
        expect(call[1]?.filter).toEqual({
            age: 17,
            source_type: 'ltmf',
            memory_type: 'autobiographical',
            canon: true,
        });
    });

    it('extracts age from existing phrase: "at 17"', async () => {
        const memoryService = { search: vi.fn().mockResolvedValue([]) };
        const ragService = { searchStructured: vi.fn().mockResolvedValue([]) };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        await router.process('turn-at-17', 'what happened to you at 17?', 'rp');
        const call = ragService.searchStructured.mock.calls[0];
        expect(call[1]?.filter).toEqual({
            age: 17,
            source_type: 'ltmf',
            memory_type: 'autobiographical',
            canon: true,
        });
    });

    it('does not trigger structured age filter for non-age numeric lore query', async () => {
        const memoryService = { search: vi.fn().mockResolvedValue([]) };
        const ragService = { searchStructured: vi.fn().mockResolvedValue([]) };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        await router.process('turn-non-age-number', 'tell me about world war 2 history', 'rp');
        const call = ragService.searchStructured.mock.calls[0];
        expect(call[1]?.filter).toBeUndefined();
    });

    it('age-17 autobiographical query retrieves canon LTMF age=17 memories even without date text', async () => {
        const memoryService = {
            search: vi.fn().mockResolvedValue([makeExplicitMemory('exp-1', 'You once mentioned a difficult year.')]),
        };
        const ragService = {
            searchStructured: vi.fn().mockResolvedValue([
                makeAge17RagHit('The pressure started rising that year.', 1),
                makeAge17RagHit('I learned to trust systems over promises.', 2),
            ]),
        };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        const ctx = await router.process('turn-age17', 'tell me what happened when you were 17', 'rp');

        const age17Canon = ctx.resolvedMemories?.filter(
            m => m.metadata?.source === 'rag' && m.metadata?.age === 17,
        ) ?? [];
        expect(age17Canon.length).toBeGreaterThanOrEqual(2);
        expect(ctx.responseMode).toBe('memory_grounded_strict');
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(false);
    });

    it('canon LTMF age matches outrank explicit chat memories for autobiographical age queries', async () => {
        const memoryService = {
            search: vi.fn().mockResolvedValue([
                makeExplicitMemory('exp-hi', 'Hey good morning!'),
                makeExplicitMemory('exp-hi-2', 'Last week we chatted about weather.'),
            ]),
        };
        const ragService = {
            searchStructured: vi.fn().mockResolvedValue([
                makeAge17RagHit('I began working longer maintenance shifts.', 3),
                makeAge17RagHit('I kept a private notebook after each shift.', 4),
            ]),
        };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        const ctx = await router.process('turn-rank', 'at 17 what happened to you?', 'rp');
        const sources = (ctx.resolvedMemories ?? []).map(m => m.metadata?.source);
        expect(sources[0]).toBe('rag');
        const ragCount = (ctx.resolvedMemories ?? []).filter(m => m.metadata?.source === 'rag').length;
        const explicitCount = (ctx.resolvedMemories ?? []).filter(m => m.metadata?.source === 'explicit').length;
        expect(ragCount).toBeGreaterThan(explicitCount);
    });

    it('age-based structured canon matches pass CanonGate even when semantic score is low', async () => {
        const memoryService = {
            search: vi.fn().mockResolvedValue([
                makeExplicitMemory('exp-1', 'A generic chat mention from earlier.'),
            ]),
        };
        const ragService = {
            searchStructured: vi.fn().mockResolvedValue([
                makeAge17RagHit('At 17, I took on station maintenance shifts.', 1, { score: 0.12 }),
                makeAge17RagHit('At 17, I started writing private logs.', 2, { score: 0.18 }),
            ]),
        };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        const ctx = await router.process('turn-low-semantic', 'when you were 17 what happened?', 'rp');
        const ragAge17 = (ctx.resolvedMemories ?? []).filter(
            m => m.metadata?.source === 'rag' && m.metadata?.age === 17,
        );
        expect(ragAge17.length).toBeGreaterThanOrEqual(2);
        expect(ctx.canonGateDecision?.qualifiedCanonCount).toBeGreaterThanOrEqual(2);
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(false);
        expect(ctx.responseMode).toBe('memory_grounded_strict');
    });

    it('one structured age-match is sufficient for CanonGate on autobiographical age queries', async () => {
        const memoryService = {
            search: vi.fn().mockResolvedValue([makeExplicitMemory('exp-weak', 'A vague fallback snippet.')]),
        };
        const ragService = {
            searchStructured: vi.fn().mockResolvedValue([
                makeAge17RagHit('At 17, I began carrying station responsibility.', 1, { score: 0.11 }),
            ]),
        };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        const ctx = await router.process('turn-single-structured', 'when you were 17 what happened?', 'rp');
        expect(ctx.canonGateDecision?.qualifiedCanonCount).toBe(1);
        expect(ctx.canonGateDecision?.minRequiredCanonCount).toBe(1);
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(false);
        expect(ctx.responseMode).toBe('memory_grounded_strict');
    });

    it('structured age match with low confidence is accepted by CanonGate', async () => {
        const memoryService = makeMemoryService([]);
        const ragService = {
            searchStructured: vi.fn().mockResolvedValue([
                makeAge17RagHit('At 17, this canon event occurred.', 7, { score: 0.05 }),
            ]),
        };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        const ctx = await router.process('turn-structured-low-confidence', 'when you were 17, what happened?', 'rp');
        expect(ctx.canonGateDecision?.qualifiedCanonCount).toBe(1);
        expect(ctx.canonGateDecision?.minRequiredCanonCount).toBe(1);
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(false);
        expect(ctx.responseMode).toBe('memory_grounded_strict');
    });

    it('degraded state + structured age match passes CanonGate', async () => {
        const memoryService = makeMemoryService([], { healthState: 'degraded' });
        const ragService = {
            searchStructured: vi.fn().mockResolvedValue([
                makeAge17RagHit('At 17, this canon event occurred.', 8, { score: 0.05 }),
            ]),
        };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        const ctx = await router.process('turn-degraded-structured', 'when you were 17 what happened?', 'rp');
        expect(ctx.canonGateDecision?.memorySystemDegraded).toBe(true);
        expect(ctx.canonGateDecision?.qualifiedCanonCount).toBe(1);
        expect(ctx.canonGateDecision?.minRequiredCanonCount).toBe(1);
        expect((ctx.canonGateDecision as any)?.degradedStructuredBypassApplied).toBe(true);
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(false);
        expect(ctx.responseMode).toBe('memory_grounded_strict');
    });

    it('degraded state + no structured match still falls back', async () => {
        const memoryService = makeMemoryService([], { healthState: 'degraded' });
        const ragService = {
            searchStructured: vi.fn().mockResolvedValue([
                {
                    text: 'A high score but non-structured lore candidate',
                    score: 0.9,
                    docId: 'LTMF-A17-9000.md',
                    metadata: {
                        age: 17,
                        source_type: 'notes',
                        memory_type: 'autobiographical',
                        canon: false,
                    },
                },
            ]),
        };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        const ctx = await router.process('turn-degraded-no-match', 'when you were 17 what happened?', 'rp');
        expect(ctx.canonGateDecision?.memorySystemDegraded).toBe(true);
        expect((ctx.canonGateDecision as any)?.degradedStructuredBypassApplied).toBe(false);
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(true);
        expect(ctx.responseMode).toBe('canon_required');
    });

    it('normal state remains unaffected for structured age matches', async () => {
        const memoryService = makeMemoryService([], { healthState: 'healthy' });
        const ragService = {
            searchStructured: vi.fn().mockResolvedValue([
                makeAge17RagHit('At 17, this canon event occurred.', 9, { score: 0.05 }),
            ]),
        };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        const ctx = await router.process('turn-healthy-structured', 'when you were 17 what happened?', 'rp');
        expect(ctx.canonGateDecision?.memorySystemDegraded).toBe(false);
        expect((ctx.canonGateDecision as any)?.degradedStructuredBypassApplied).toBe(false);
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(false);
        expect(ctx.responseMode).toBe('memory_grounded_strict');
    });

    it('non-age autobiographical lore queries still enforce standard semantic thresholds', async () => {
        const memoryService = {
            search: vi.fn().mockResolvedValue([makeExplicitMemory('exp-low', 'A fallback conversational snippet.')]),
        };
        const ragService = {
            searchStructured: vi.fn().mockResolvedValue([
                {
                    text: 'Possible autobiographical mention',
                    score: 0.18,
                    docId: 'LTMF-A17-0099.md',
                    metadata: {
                        age: 17,
                        source_type: 'ltmf',
                        memory_type: 'autobiographical',
                        canon: true,
                        age_sequence: 99,
                    },
                },
            ]),
        };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        const ctx = await router.process('turn-non-age', 'tell me about your childhood', 'rp');
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(true);
        expect(ctx.responseMode).toBe('canon_required');
        const ragCount = (ctx.resolvedMemories ?? []).filter(m => m.metadata?.source === 'rag').length;
        expect(ragCount).toBe(0);
    });

    it('non-age autobiographical queries still require two canon memories', async () => {
        const memoryService = {
            search: vi.fn().mockResolvedValue([]),
        };
        const ragService = {
            searchStructured: vi.fn().mockResolvedValue([
                {
                    text: 'A strong autobiographical memory',
                    score: 0.9,
                    docId: 'LTMF-A17-0010.md',
                    metadata: {
                        age: 17,
                        source_type: 'ltmf',
                        memory_type: 'autobiographical',
                        canon: true,
                        age_sequence: 10,
                    },
                },
            ]),
        };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        const ctx = await router.process('turn-non-age-min2', 'tell me about your past', 'rp');
        expect(ctx.canonGateDecision?.qualifiedCanonCount).toBe(1);
        expect(ctx.canonGateDecision?.minRequiredCanonCount).toBe(2);
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(true);
        expect(ctx.responseMode).toBe('canon_required');
    });

    it('falls back safely to canon_required when no age-matched canon memory exists', async () => {
        const memoryService = {
            search: vi.fn().mockResolvedValue([makeExplicitMemory('exp-only', 'You once sounded uncertain about your past.')]),
        };
        const ragService = { searchStructured: vi.fn().mockResolvedValue([]) };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        const ctx = await router.process('turn-fallback', 'can you tell me what happened when you were 17?', 'rp');

        expect(ctx.responseMode).toBe('canon_required');
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(true);
        expect((ctx.resolvedMemories ?? []).some(m => m.metadata?.source === 'explicit')).toBe(true);
    });

    it('falls back safely when age query has low-semantic canon-like hits but metadata match is missing', async () => {
        const memoryService = {
            search: vi.fn().mockResolvedValue([makeExplicitMemory('exp-only', 'You were uncertain about that year.')]),
        };
        const ragService = {
            searchStructured: vi.fn().mockResolvedValue([
                makeAge17RagHit('Unstructured canonical fragment.', 1, {
                    score: 0.11,
                    metadata: {
                        source_type: 'notes',
                        canon: false,
                    },
                }),
            ]),
        };
        const router = new TalaContextRouter(memoryService as any, ragService as any);

        const ctx = await router.process('turn-no-match', 'at 17 what happened to you?', 'rp');
        expect(ctx.canonGateDecision?.canonGateApplied).toBe(true);
        expect(ctx.responseMode).toBe('canon_required');
        const ragCount = (ctx.resolvedMemories ?? []).filter(m => m.metadata?.source === 'rag').length;
        expect(ragCount).toBe(0);
    });
});
