/**
 * Intent Classification and RP Mode Memory Policy Tests
 *
 * Validates:
 * 1. IntentClassifier: affectionate / autobiographical / social prompts are NOT misclassified as technical.
 * 2. IntentClassifier: operational / technical prompts still classify correctly.
 * 3. RP mode memory policy: reads allowed, writes blocked, tools blocked.
 * 4. RouterFilter: safe relevant memories are approved in RP mode.
 * 5. RouterFilter: unsafe/contested memories remain blocked in all modes.
 * 6. Assistant/hybrid behavior is unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IntentClassifier } from '../../services/router/IntentClassifier';
import { TalaContextRouter } from '../../services/router/TalaContextRouter';
import { MemoryFilter } from '../../services/router/MemoryFilter';
import { MemoryItem } from '../../services/MemoryService';
import { MockMemoryService } from './MockServices';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMemory(overrides: Partial<MemoryItem> & { id: string; text: string }): MemoryItem {
    const now = Date.now();
    const salience = overrides.salience ?? overrides.metadata?.salience ?? 0.7;
    const confidence = overrides.confidence ?? overrides.metadata?.confidence ?? 0.8;
    return {
        id: overrides.id,
        text: overrides.text,
        status: overrides.status ?? 'active',
        associations: overrides.associations ?? [],
        timestamp: overrides.timestamp ?? now,
        salience,
        confidence,
        created_at: overrides.created_at ?? now,
        last_accessed_at: overrides.last_accessed_at ?? null,
        last_reinforced_at: overrides.last_reinforced_at ?? null,
        access_count: overrides.access_count ?? 0,
        metadata: {
            role: overrides.metadata?.role ?? 'core',
            source: overrides.metadata?.source ?? 'mem0',
            confidence,
            salience,
            ...(overrides.metadata ?? {}),
        },
    };
}

// ---------------------------------------------------------------------------
// Part 1 — Intent Classification
// ---------------------------------------------------------------------------

describe('IntentClassifier — social / affectionate prompts', () => {
    it('"Hey baby how are you?" → greeting or social, NOT technical', () => {
        const result = IntentClassifier.classify('Hey baby how are you?');
        expect(['greeting', 'social']).toContain(result.class);
        expect(result.class).not.toBe('technical');
        expect(result.class).not.toBe('mixed');
    });

    it('"How are you doing today?" → greeting or social, NOT technical', () => {
        const result = IntentClassifier.classify('How are you doing today?');
        expect(['greeting', 'social']).toContain(result.class);
        expect(result.class).not.toBe('technical');
    });

    it('"I\'m happy you\'re here" → social (affectionate, no technical signal)', () => {
        const result = IntentClassifier.classify("I'm happy you're here");
        expect(['social', 'greeting']).toContain(result.class);
        expect(result.class).not.toBe('technical');
    });
});

describe('IntentClassifier — autobiographical / personal-memory prompts', () => {
    it('"Tell me about your favorite childhood memory" → lore/social, NOT technical', () => {
        const result = IntentClassifier.classify('Tell me about your favorite childhood memory');
        expect(['lore', 'social']).toContain(result.class);
        expect(result.class).not.toBe('technical');
    });

    it('"Tell me about your favorite childhood memory" → not technical (full sentence with punctuation)', () => {
        const result = IntentClassifier.classify("I'm happy you're here, tell me about your favorite childhood memory?");
        expect(result.class).not.toBe('technical');
    });

    it('"Do you remember when..." → lore/social, NOT technical', () => {
        const result = IntentClassifier.classify('Do you remember when we first met?');
        expect(['lore', 'social']).toContain(result.class);
        expect(result.class).not.toBe('technical');
    });

    it('"Do you remember when we were kids?" → NOT technical', () => {
        const result = IntentClassifier.classify('Do you remember when we were kids?');
        expect(result.class).not.toBe('technical');
    });
});

describe('IntentClassifier — operational / technical prompts still classify correctly', () => {
    it('"Open a browser to google.com" → browser', () => {
        const result = IntentClassifier.classify('Open a browser to google.com');
        expect(result.class).toBe('browser');
    });

    it('"Change the settings page" → technical', () => {
        const result = IntentClassifier.classify('Change the settings page');
        expect(result.class).toBe('technical');
    });

    it('"Search the repo for ArtifactRouter" → technical', () => {
        const result = IntentClassifier.classify('Search the repo for ArtifactRouter');
        expect(result.class).toBe('technical');
    });

    it('"Debug the memory retrieval pipeline" → technical', () => {
        const result = IntentClassifier.classify('Debug the memory retrieval pipeline');
        expect(result.class).toBe('technical');
    });

    it('"Install the dependencies and run the build" → technical', () => {
        const result = IntentClassifier.classify('Install the dependencies and run the build');
        expect(result.class).toBe('technical');
    });

    it('"Fix the error in the API function" → technical', () => {
        const result = IntentClassifier.classify('Fix the error in the API function');
        expect(result.class).toBe('technical');
    });
});

describe('IntentClassifier — mixed greeting + technical task', () => {
    it('"Hey, can you debug this error?" → mixed or technical, NOT greeting', () => {
        const result = IntentClassifier.classify('Hey, can you debug this error?');
        // Contains a genuine technical ask — should not stay as pure greeting
        expect(['mixed', 'technical']).toContain(result.class);
    });
});

// ---------------------------------------------------------------------------
// Part 2 — RP Mode Memory Policy (TalaContextRouter)
// ---------------------------------------------------------------------------

describe('RP mode — capability policy', () => {
    let router: TalaContextRouter;
    let memory: MockMemoryService;

    beforeEach(() => {
        memory = new MockMemoryService();
        router = new TalaContextRouter(memory as any);
    });

    it('blocks tools in RP mode', async () => {
        const ctx = await router.process('rp-cap-1', 'you are my knight, speak to me', 'rp');
        expect(ctx.blockedCapabilities).toContain('tools');
    });

    it('allows memory_retrieval in RP mode', async () => {
        const ctx = await router.process('rp-cap-2', 'you are my knight, speak to me', 'rp');
        expect(ctx.allowedCapabilities).toContain('memory_retrieval');
    });

    it('blocks memory writes in RP mode', async () => {
        const ctx = await router.process('rp-write-1', 'tell me a story', 'rp');
        expect(ctx.memoryWriteDecision).not.toBeNull();
        expect(ctx.memoryWriteDecision?.category).toBe('do_not_write');
        expect(ctx.memoryWriteDecision?.reason).toContain('RP mode');
    });

    it('does not block all capabilities — memory_retrieval is explicitly allowed', async () => {
        const ctx = await router.process('rp-cap-3', 'tell me about your past', 'rp');
        // Should NOT contain 'all' in blocked (that was the old overly-strict policy)
        expect(ctx.blockedCapabilities).not.toContain('all');
    });
});

// ---------------------------------------------------------------------------
// Part 3 — RP Mode: Relevant Safe Memories Are Approved
// ---------------------------------------------------------------------------

describe('RP mode — RouterFilter allows safe core memories', () => {
    let router: TalaContextRouter;
    let memory: MockMemoryService;

    beforeEach(() => {
        memory = new MockMemoryService();
        router = new TalaContextRouter(memory as any);
    });

    it('approves core mem0 memory in RP mode for autobiographical query', async () => {
        // Inject a core memory with mem0 source — should pass RP filter
        const coreMemory = makeMemory({
            id: 'mem-001',
            text: 'Tala loves the ocean and often dreams of the stars.',
            metadata: { role: 'core', source: 'mem0', confidence: 0.85, salience: 0.8 },
        });
        memory.mockResults = [coreMemory];

        const ctx = await router.process('rp-mem-1', 'Tell me about your favorite childhood memory', 'rp');
        expect(ctx.retrieval.approvedCount).toBeGreaterThan(0);
    });

    it('approves explicit user fact in RP mode', async () => {
        const explicitMemory = makeMemory({
            id: 'mem-002',
            text: "User's favorite color is deep blue.",
            metadata: { role: 'core', source: 'explicit', confidence: 0.95, salience: 0.9 },
        });
        memory.mockResults = [explicitMemory];

        const ctx = await router.process('rp-explicit-1', 'Do you remember what my favorite color is?', 'rp');
        expect(ctx.retrieval.approvedCount).toBeGreaterThan(0);
    });

    it('approves rp-tagged memory in RP mode', async () => {
        const rpMemory = makeMemory({
            id: 'mem-003',
            text: 'The kingdom of Arandor is ruled by the Eternal Queen.',
            metadata: { role: 'rp', source: 'diary', confidence: 0.9, salience: 0.85 },
        });
        memory.mockResults = [rpMemory];

        const ctx = await router.process('rp-rp-1', 'Tell me about the kingdom', 'rp');
        expect(ctx.retrieval.approvedCount).toBeGreaterThan(0);
    });
});

describe('RP mode — RouterFilter still blocks unsafe memories', () => {
    it('blocks contested memories in RP mode', () => {
        const contested = makeMemory({
            id: 'mem-bad-1',
            text: 'Contested claim about the user.',
            status: 'contested',
            metadata: { role: 'core', source: 'mem0', confidence: 0.5, salience: 0.5 },
        });
        const intent = IntentClassifier.classify('tell me about your past');
        const filtered = MemoryFilter.filter([contested], 'rp', intent);
        expect(filtered).toHaveLength(0);
    });

    it('blocks archived memories in RP mode', () => {
        const archived = makeMemory({
            id: 'mem-bad-2',
            text: 'Archived old memory.',
            status: 'archived',
            metadata: { role: 'core', source: 'mem0', confidence: 0.8, salience: 0.7 },
        });
        const intent = IntentClassifier.classify('do you remember when');
        const filtered = MemoryFilter.filter([archived], 'rp', intent);
        expect(filtered).toHaveLength(0);
    });

    it('blocks memories from non-RP sources (e.g. rag) in RP mode', () => {
        const ragMemory = makeMemory({
            id: 'mem-bad-3',
            text: 'Technical documentation snippet from RAG.',
            metadata: { role: 'core', source: 'rag', confidence: 0.8, salience: 0.7 },
        });
        const intent = IntentClassifier.classify('tell me about yourself');
        const filtered = MemoryFilter.filter([ragMemory], 'rp', intent);
        expect(filtered).toHaveLength(0);
    });

    it('blocks assistant-role memories in RP mode', () => {
        const assistantMemory = makeMemory({
            id: 'mem-bad-4',
            text: 'Task tracking state for a coding project.',
            metadata: { role: 'assistant', source: 'mem0', confidence: 0.8, salience: 0.7 },
        });
        const intent = IntentClassifier.classify('tell me about yourself');
        const filtered = MemoryFilter.filter([assistantMemory], 'rp', intent);
        expect(filtered).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Part 4 — Assistant / Hybrid Behavior Unchanged
// ---------------------------------------------------------------------------

describe('Assistant mode — behavior unchanged', () => {
    let router: TalaContextRouter;
    let memory: MockMemoryService;

    beforeEach(() => {
        memory = new MockMemoryService();
        router = new TalaContextRouter(memory as any);
    });

    it('allows all capabilities in assistant mode for substantive queries', async () => {
        const ctx = await router.process('assist-1', 'debug the memory retrieval pipeline', 'assistant');
        expect(ctx.allowedCapabilities).toContain('all');
        expect(ctx.blockedCapabilities).not.toContain('all');
    });

    it('allows long-term memory writes in assistant mode for technical queries', async () => {
        const ctx = await router.process('assist-2', 'debug the router pipeline', 'assistant');
        expect(ctx.memoryWriteDecision).not.toBeNull();
        expect(['long_term', 'short_term']).toContain(ctx.memoryWriteDecision?.category);
        expect(ctx.memoryWriteDecision?.category).not.toBe('do_not_write');
    });

    it('blocks rp-tagged memories from entering assistant mode', () => {
        const rpMemory = makeMemory({
            id: 'rp-leak-1',
            text: 'Roleplay scene content.',
            metadata: { role: 'rp', source: 'diary', confidence: 0.9, salience: 0.8 },
        });
        const intent = IntentClassifier.classify('how does the router work?');
        const filtered = MemoryFilter.filter([rpMemory], 'assistant', intent);
        expect(filtered).toHaveLength(0);
    });
});

describe('Hybrid mode — behavior unchanged', () => {
    let router: TalaContextRouter;
    let memory: MockMemoryService;

    beforeEach(() => {
        memory = new MockMemoryService();
        router = new TalaContextRouter(memory as any);
    });

    it('uses short-term memory writes in hybrid mode', async () => {
        const ctx = await router.process('hybrid-1', 'help me plan a project', 'hybrid');
        expect(ctx.memoryWriteDecision).not.toBeNull();
        expect(ctx.memoryWriteDecision?.category).toBe('short_term');
    });
});
