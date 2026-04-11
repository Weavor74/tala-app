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

describe('Lore contamination guard', () => {
    it('delayed ping bad prior interaction answer is excluded from autobiographical lore grounding', async () => {
        const contaminated = makeMemory(
            'mem0-interaction-1',
            'User: What about the delayed ping?\nTala: The term "delayed ping" is not tied to a specific personal event.',
            {
                source: 'mem0',
                source_type: 'interaction_transcript',
                memory_type: 'interaction_log',
                role: 'assistant',
                confidence: 0.9,
                salience: 0.9,
            }
        );
        const memoryService = { search: vi.fn().mockResolvedValue([contaminated]) };
        const ragService = {
            searchStructured: vi.fn().mockResolvedValue([
                {
                    text: 'Delayed Ping was a formative station event at age 17 where Tala repaired trust via a full handoff log.',
                    score: 0.91,
                    docId: 'ltmf-delayed-ping.md',
                    metadata: { source_type: 'ltmf', memory_type: 'autobiographical', canon: true, age: 17, title: 'Delayed Ping' },
                },
            ]),
        };

        const router = new TalaContextRouter(memoryService as any, ragService as any);
        const ctx = await router.process('contam-1', 'Do you have a story about the delayed ping?', 'rp');

        const texts = (ctx.resolvedMemories || []).map(m => m.text.toLowerCase());
        expect(texts.some(t => t.includes('user: what about the delayed ping'))).toBe(false);
        expect(texts.some(t => t.includes('delayed ping was a formative station event'))).toBe(true);
    });

    it('autobiographical lore query prefers LTMF canon over interaction logs', async () => {
        const memoryService = {
            search: vi.fn().mockResolvedValue([
                makeMemory('chat-1', 'User: Tell me about delayed ping\nTala: I do not remember.', {
                    source: 'conversation',
                    source_type: 'chat_log',
                    memory_type: 'assistant_reply',
                    role: 'assistant',
                    confidence: 0.95,
                    salience: 0.95,
                }),
            ]),
        };
        const ragService = {
            searchStructured: vi.fn().mockResolvedValue([
                {
                    text: 'At age 17, Delayed Ping became Tala\'s lesson in disciplined handoff communication.',
                    score: 0.89,
                    docId: 'ltmf-a17-delayed-ping.md',
                    metadata: { source_type: 'ltmf', memory_type: 'autobiographical', canon: true, age: 17, title: 'Delayed Ping' },
                },
            ]),
        };

        const router = new TalaContextRouter(memoryService as any, ragService as any);
        const ctx = await router.process('contam-2', 'Tell me something that happened to you when you were 17', 'rp');
        const resolved = ctx.resolvedMemories || [];

        expect(resolved.length).toBeGreaterThan(0);
        expect(resolved.every(m => (m.metadata?.source === 'rag' || m.metadata?.source === 'diary' || m.metadata?.source === 'lore' || m.metadata?.source === 'graph' || m.metadata?.source === 'core_bio'))).toBe(true);
        expect(resolved.some(m => (m.metadata?.docId || '').toString().includes('ltmf'))).toBe(true);
        expect(resolved.some(m => ['conversation', 'mem0', 'explicit'].includes((m.metadata?.source || '').toString()))).toBe(false);
    });

    it('ordinary hybrid chat continuity remains unchanged for non-lore turns', async () => {
        const memoryService = {
            search: vi.fn().mockResolvedValue([
                makeMemory('session-note-1', 'We agreed to use pnpm and keep tests green before merge.', {
                    source: 'mem0',
                    source_type: 'interaction_transcript',
                    memory_type: 'session',
                    role: 'core',
                    confidence: 0.8,
                    salience: 0.8,
                }),
            ]),
        };
        const router = new TalaContextRouter(memoryService as any);
        const ctx = await router.process('contam-3', 'Can we continue the refactor plan from earlier?', 'hybrid');

        expect(ctx.intent.class).not.toBe('lore');
        expect((ctx.resolvedMemories || []).length).toBeGreaterThan(0);
        expect((ctx.resolvedMemories || [])[0].text).toContain('pnpm');
    });
});

