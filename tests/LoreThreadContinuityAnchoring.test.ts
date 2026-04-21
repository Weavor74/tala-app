import { describe, expect, it, vi } from 'vitest';
import { TalaContextRouter } from '../electron/services/router/TalaContextRouter';
import type { MemoryItem } from '../electron/services/MemoryService';

function makeMemory(id: string, text: string, metadata: any = {}): MemoryItem {
    const now = Date.now();
    return {
        id,
        text,
        metadata,
        score: metadata.score ?? 0.7,
        compositeScore: metadata.score ?? 0.7,
        timestamp: now,
        salience: metadata.salience ?? 0.7,
        confidence: metadata.confidence ?? 0.7,
        created_at: now,
        last_accessed_at: null,
        last_reinforced_at: null,
        access_count: 0,
        associations: [],
        status: 'active',
    };
}

describe('Lore thread continuity anchoring', () => {
    const baseRagHit = {
        text: 'Delayed Ping was the event where Tala missed the first uplink and recovered trust with a full handoff log.',
        score: 0.9,
        docId: 'ltmf-delayed-ping.md',
        metadata: {
            age: 17,
            source_type: 'ltmf',
            memory_type: 'autobiographical',
            canon: true,
            title: 'Delayed Ping',
        },
    };

    function createRouter() {
        const memoryService = {
            search: vi.fn().mockResolvedValue([
                makeMemory('mem0-session-1', 'Recent chat snippet', { source: 'mem0', role: 'core', type: 'session' }),
            ]),
        };
        const ragService = {
            searchStructured: vi.fn().mockResolvedValue([baseRagHit]),
        };
        const router = new TalaContextRouter(memoryService as any, ragService as any);
        return { router, memoryService, ragService };
    }

    it('initial age-17 lore turn creates active lore thread', async () => {
        const { router } = createRouter();
        const ctx = await router.process('t1', 'Tell me about when you were 17', 'rp');

        expect(ctx.intent.class).toBe('lore');
        expect(ctx.responseMode).toBe('memory_grounded_strict');
        const active = router.getActiveLoreMemoryContext();
        expect(active).toBeTruthy();
        expect(active?.originatingTurnId).toBe('t1');
        expect(active?.approvedDocIds).toContain('ltmf-delayed-ping.md');
        expect(active?.anchorEntities.some(e => e.includes('delayed ping'))).toBe(true);
    });

    it('"What about the delayed ping?" continues the same lore thread and reuses prior canon first', async () => {
        const { router, ragService } = createRouter();
        await router.process('t1', 'Tell me about when you were 17', 'rp');
        ragService.searchStructured.mockClear();

        const follow = await router.process('t2', 'What about the delayed ping?', 'rp');
        expect(follow.intent.class).toBe('lore');
        expect(follow.loreThread?.continued).toBe(true);
        expect(follow.loreThread?.reusedPriorCanon).toBe(true);
        expect(follow.loreThread?.originTurnId).toBe('t1');
        expect(ragService.searchStructured).toHaveBeenCalledTimes(0);
    });

    it('"Do you have a personal story about it?" continues active lore thread and preserves lore prompt blocks', async () => {
        const { router } = createRouter();
        await router.process('t1', 'Tell me about when you were 17', 'rp');
        const follow = await router.process('t2', 'Do you have a personal story about it?', 'rp');

        expect(follow.intent.class).toBe('lore');
        expect(follow.loreThread?.continued).toBe(true);
        const headers = follow.promptBlocks.map(b => b.header);
        expect(headers.some(h => h.includes('AUTOBIOGRAPHICAL MEMORY - AGE'))).toBe(true);
        expect(headers.some(h => h.includes('CANON LORE MEMORIES'))).toBe(true);
        expect(follow.responseMode).toBe('memory_grounded_strict');
    });

    it('"Do you have a specific memory?" continues active lore thread and preserves lore prompt blocks', async () => {
        const { router } = createRouter();
        await router.process('t1', 'Tell me about when you were 17', 'rp');
        const follow = await router.process('t2', 'Do you have a specific memory?', 'rp');

        expect(follow.intent.class).toBe('lore');
        expect(follow.loreThread?.continued).toBe(true);
        const headers = follow.promptBlocks.map(b => b.header);
        expect(headers.some(h => h.includes('AUTOBIOGRAPHICAL MEMORY - AGE'))).toBe(true);
        expect(headers.some(h => h.includes('CANON LORE MEMORIES'))).toBe(true);
        expect(follow.responseMode).toBe('memory_grounded_strict');
    });

    it('unrelated topic change expires active lore thread', async () => {
        const { router } = createRouter();
        await router.process('t1', 'Tell me about when you were 17', 'rp');
        const shifted = await router.process('t2', 'Can you help me debug this npm install error?', 'assistant');

        expect(shifted.intent.class).not.toBe('lore');
        expect(router.getActiveLoreMemoryContext()).toBeNull();
        expect(shifted.loreThread?.hasActiveContext).toBe(false);
    });

    it('does not accidentally continue lore thread for unrelated pronoun question', async () => {
        const { router } = createRouter();
        await router.process('t1', 'Tell me about when you were 17', 'rp');
        const unrelated = await router.process('t2', 'Is that file still in the repo?', 'assistant');

        expect(unrelated.intent.class).not.toBe('lore');
        expect(unrelated.loreThread?.continued).toBe(false);
    });
});

