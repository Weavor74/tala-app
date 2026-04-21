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
 * 7. Autobiographical lore intent: affectionate openers do not suppress lore retrieval.
 * 8. Greeting suppression: pure greetings suppress retrieval; lore prompts do not.
 * 9. Source priority: LTMF/lore sources outrank recent chat for autobiographical queries.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IntentClassifier } from '../../services/router/IntentClassifier';
import { TalaContextRouter } from '../../services/router/TalaContextRouter';
import { ModePolicyEngine } from '../../services/router/ModePolicyEngine';
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

describe('IntentClassifier — expressive greeting opener refinement', () => {
    it('"hey sexy" → social, NOT plain greeting', () => {
        const result = IntentClassifier.classify('hey sexy');
        expect(result.class).toBe('social');
        expect(result.class).not.toBe('greeting');
    });

    it('"hey trouble" → social, NOT plain greeting', () => {
        const result = IntentClassifier.classify('hey trouble');
        expect(result.class).toBe('social');
        expect(result.class).not.toBe('greeting');
    });

    it('"hey babe" → social, NOT plain greeting', () => {
        const result = IntentClassifier.classify('hey babe');
        expect(result.class).toBe('social');
        expect(result.class).not.toBe('greeting');
    });

    it('"hello handsome" → social, NOT plain greeting', () => {
        const result = IntentClassifier.classify('hello handsome');
        expect(result.class).toBe('social');
        expect(result.class).not.toBe('greeting');
    });

    it('"miss me?" → social opener, NOT plain greeting', () => {
        const result = IntentClassifier.classify('miss me?');
        expect(result.class).toBe('social');
        expect(result.class).not.toBe('greeting');
    });

    it('"well hello there, trouble" → social, NOT plain greeting', () => {
        const result = IntentClassifier.classify('well hello there, trouble');
        expect(result.class).toBe('social');
        expect(result.class).not.toBe('greeting');
    });

    it('"hi" → greeting', () => {
        const result = IntentClassifier.classify('hi');
        expect(result.class).toBe('greeting');
    });

    it('"hello" → greeting', () => {
        const result = IntentClassifier.classify('hello');
        expect(result.class).toBe('greeting');
    });

    it('"good morning" → greeting', () => {
        const result = IntentClassifier.classify('good morning');
        expect(result.class).toBe('greeting');
    });

    it('"I feel weird today" → not accidentally reclassified as greeting/social', () => {
        const result = IntentClassifier.classify('I feel weird today');
        expect(result.class).not.toBe('greeting');
        expect(result.class).not.toBe('social');
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

    it('blocks core mem0 memory for autobiographical query (canon contamination guard)', async () => {
        // Inject a core memory with mem0 source - must be excluded from autobiographical canon grounding
        const coreMemory = makeMemory({
            id: 'mem-001',
            text: 'Tala loves the ocean and often dreams of the stars.',
            metadata: { role: 'core', source: 'mem0', confidence: 0.85, salience: 0.8 },
        });
        memory.mockResults = [coreMemory];

        const ctx = await router.process('rp-mem-1', 'Tell me about when you were 17', 'rp');
        expect(ctx.retrieval.approvedCount).toBe(0);
        expect(ctx.responseMode).toBe('canon_required');
    });

    it('keeps explicit user fact retrieval for non-autobiographical continuity', async () => {
        const explicitMemory = makeMemory({
            id: 'mem-002',
            text: "User's favorite color is deep blue.",
            metadata: { role: 'core', source: 'explicit', confidence: 0.95, salience: 0.9 },
        });
        memory.mockResults = [explicitMemory];

        const ctx = await router.process('rp-explicit-1', 'What is my favorite color?', 'rp');
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

    it('allows rag-source memories in RP mode (LTMF/canon lore is retrieved via RAG)', () => {
        // RAG is now in RP allowedSources because LTMF canon lore is ingested via RagService.
        // This memory has role=core (allowed in RP) and source=rag (now allowed in RP).
        const ragMemory = makeMemory({
            id: 'mem-rag-rp',
            text: 'At seventeen, Tala played violin in school concerts.',
            metadata: { role: 'rp', source: 'rag', confidence: 0.8, salience: 0.7, type: 'lore' },
        });
        const intent = IntentClassifier.classify('tell me about yourself');
        const filtered = MemoryFilter.filter([ragMemory], 'rp', intent);
        expect(filtered).toHaveLength(1);
    });

    it('blocks system/tool_result-source memories in RP mode (non-lore sources still excluded)', () => {
        const sysMemory = makeMemory({
            id: 'mem-bad-3',
            text: 'System tool result from task execution.',
            metadata: { role: 'core', source: 'system', confidence: 0.8, salience: 0.7 },
        });
        const intent = IntentClassifier.classify('tell me about yourself');
        const filtered = MemoryFilter.filter([sysMemory], 'rp', intent);
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

// ---------------------------------------------------------------------------
// Part 7 — Autobiographical Lore Intent Detection (NEW)
// ---------------------------------------------------------------------------

describe('IntentClassifier — autobiographical lore prompts with affectionate openers', () => {
    it('"Hey baby can you tell me about when you were 17?" → lore, NOT greeting', () => {
        const result = IntentClassifier.classify('Hey baby can you tell me about when you were 17?');
        expect(result.class).toBe('lore');
        expect(result.class).not.toBe('greeting');
        expect(result.class).not.toBe('social');
    });

    it('"Love, tell me about your childhood" → lore, NOT greeting or social', () => {
        const result = IntentClassifier.classify('Love, tell me about your childhood');
        expect(result.class).toBe('lore');
        expect(result.class).not.toBe('greeting');
    });

    it('"Babe, what were you like at 17?" → lore (autobiographical age reference)', () => {
        const result = IntentClassifier.classify('Babe, what were you like at 17?');
        expect(result.class).toBe('lore');
        expect(result.class).not.toBe('greeting');
        expect(result.class).not.toBe('technical');
    });

    it('"Do you remember when you were young?" → lore', () => {
        const result = IntentClassifier.classify('Do you remember when you were young?');
        expect(result.class).toBe('lore');
        expect(result.class).not.toBe('greeting');
    });

    it('"What happened when you were 17?" → lore (age marker)', () => {
        const result = IntentClassifier.classify('What happened when you were 17?');
        expect(result.class).toBe('lore');
        expect(result.class).not.toBe('technical');
    });

    it('"Tell me about your past" → lore', () => {
        const result = IntentClassifier.classify('Tell me about your past');
        expect(result.class).toBe('lore');
    });

    it('"Do you remember when you were 17?" → lore', () => {
        const result = IntentClassifier.classify('Do you remember when you were 17?');
        expect(result.class).toBe('lore');
    });

    it('"So you dont have a memory?" → lore (memory follow-up, apostrophe omitted as typed)', () => {
        const result = IntentClassifier.classify("So you dont have a memory?");
        expect(result.class).toBe('lore');
        expect(result.class).not.toBe('greeting');
    });
});

describe('IntentClassifier — pure greetings remain greeting', () => {
    it('"Good morning" → greeting', () => {
        const result = IntentClassifier.classify('Good morning');
        expect(result.class).toBe('greeting');
    });

    it('"Good morning baby" → greeting (no lore content)', () => {
        const result = IntentClassifier.classify('Good morning baby');
        expect(['greeting', 'social']).toContain(result.class);
    });

    it('"Hey, how are you?" → greeting or social', () => {
        const result = IntentClassifier.classify('Hey, how are you?');
        expect(['greeting', 'social']).toContain(result.class);
    });
});

// ---------------------------------------------------------------------------
// Part 7 — Greeting Suppression Tests (NEW)
// ---------------------------------------------------------------------------

describe('TalaContextRouter — greeting suppression policy', () => {
    let router: TalaContextRouter;
    let memory: MockMemoryService;

    beforeEach(() => {
        memory = new MockMemoryService();
        router = new TalaContextRouter(memory as any);
    });

    it('pure greeting suppresses retrieval in non-RP mode', async () => {
        const ctx = await router.process('greet-sup-1', 'Good morning', 'assistant');
        expect(ctx.retrieval.suppressed).toBe(true);
        expect(ctx.turnPolicy.policyId).toBe('greeting');
    });

    it('autobiographical prompt does NOT suppress retrieval in RP mode', async () => {
        const ctx = await router.process('lore-nosup-1', 'Hey baby can you tell me about when you were 17?', 'rp');
        expect(ctx.retrieval.suppressed).toBe(false);
    });

    it('affectionate opener with lore content does NOT suppress retrieval', async () => {
        const ctx = await router.process('lore-nosup-2', 'Love, tell me about your childhood', 'rp');
        expect(ctx.retrieval.suppressed).toBe(false);
    });

    it('RP autobiographical prompts have approved memories capacity > 0 when memories available', async () => {
        const loreMemory = makeMemory({
            id: 'ltmf-001',
            text: 'Tala grew up near the sea and remembers the salt air from when she was 17.',
            metadata: { role: 'rp', source: 'diary', confidence: 0.9, salience: 0.85 },
        });
        memory.mockResults = [loreMemory];
        const ctx = await router.process('lore-approved-1', 'Tell me about when you were 17', 'rp');
        expect(ctx.retrieval.suppressed).toBe(false);
        expect(ctx.retrieval.approvedCount).toBeGreaterThan(0);
    });
});

describe('TalaContextRouter — RP turn-policy precedence over greeting policy', () => {
    let router: TalaContextRouter;
    let memory: MockMemoryService;

    beforeEach(() => {
        memory = new MockMemoryService();
        router = new TalaContextRouter(memory as any);
    });

    it('mode=rp + plain greeting resolves to immersive_roleplay, not greeting', async () => {
        const ctx = await router.process('rp-greet-policy-1', 'hello', 'rp');
        expect(ctx.resolvedMode).toBe('rp');
        expect(ctx.turnPolicy.policyId).toBe('immersive_roleplay');
        expect(ctx.turnPolicy.personalityLevel).toBe('full');
        expect(ctx.turnBehavior.immersiveStyle).toBe(true);
        expect(ctx.turnBehavior.personalityLevel).toBe('full');
    });

    it('mode=rp + social opener retains RP behavior authority', async () => {
        const ctx = await router.process('rp-greet-policy-2', 'hey sexy', 'rp');
        expect(ctx.resolvedMode).toBe('rp');
        expect(ctx.turnPolicy.policyId).toBe('immersive_roleplay');
        expect(ctx.turnBehavior.immersiveStyle).toBe(true);
        expect(ctx.turnBehavior.toneProfile).toBe('immersive');
    });

    it('mode=assistant + plain greeting stays on generic greeting policy', async () => {
        const ctx = await router.process('assist-greet-policy-1', 'hello', 'assistant');
        expect(ctx.turnPolicy.policyId).toBe('greeting');
        expect(ctx.turnPolicy.personalityLevel).toBe('minimal');
        expect(ctx.turnBehavior.immersiveStyle).toBe(false);
    });

    it('mode=hybrid + plain greeting remains unchanged on generic greeting policy', async () => {
        const ctx = await router.process('hybrid-greet-policy-1', 'good morning', 'hybrid');
        expect(ctx.turnPolicy.policyId).toBe('greeting');
        expect(ctx.turnPolicy.personalityLevel).toBe('minimal');
        expect(ctx.turnBehavior.immersiveStyle).toBe(false);
    });

    it('ModePolicyEngine keeps non-greeting technical policy family unchanged', () => {
        const policyId = ModePolicyEngine.resolveTurnPolicyId('assistant', 'technical', false);
        expect(policyId).toBe('technical_execution');
    });
});

// ---------------------------------------------------------------------------
// Part 7 — Source Priority / Retrieval Ranking Tests (NEW)
// ---------------------------------------------------------------------------

describe('MemoryFilter.resolveContradictions — lore source priority', () => {
    it('for lore intent, diary source outranks explicit/chat source', () => {
        const loreIntent = IntentClassifier.classify('Tell me about when you were 17');
        expect(loreIntent.class).toBe('lore');

        const diaryMemory = makeMemory({
            id: 'diary-001',
            text: 'Tala remembers standing on the cliffs at 17, looking out to sea.',
            metadata: { role: 'rp', source: 'diary', confidence: 0.8, salience: 0.75 },
        });
        const chatMemory = makeMemory({
            id: 'chat-001',
            text: '[2026-03-07T15:12] User: "good..."',
            metadata: { role: 'core', source: 'explicit', confidence: 0.9, salience: 0.9 },
        });

        const resolved = MemoryFilter.resolveContradictions([chatMemory, diaryMemory], loreIntent);
        // Both should survive (no contradiction), but if there were a conflict, diary wins.
        // Verify both are present and diary appears first (higher score for lore intent).
        const diaryIdx = resolved.findIndex(m => m.id === 'diary-001');
        const chatIdx = resolved.findIndex(m => m.id === 'chat-001');
        expect(diaryIdx).toBeGreaterThanOrEqual(0);
        expect(chatIdx).toBeGreaterThanOrEqual(0);
        // diary should rank before chat for lore queries
        expect(diaryIdx).toBeLessThan(chatIdx);
    });

    it('for lore intent, rag (LTMF) source outranks explicit/chat source', () => {
        const loreIntent = IntentClassifier.classify('Do you remember your childhood?');
        expect(loreIntent.class).toBe('lore');

        const ltmfMemory = makeMemory({
            id: 'ltmf-a00-001',
            text: 'Tala spent her childhood summers near Arandor, in the shadow of the old tower.',
            metadata: { role: 'rp', source: 'rag', confidence: 0.75, salience: 0.7 },
        });
        const chatMemory = makeMemory({
            id: 'chat-002',
            text: '[2026-03-07T15:10] User: "hi"',
            metadata: { role: 'core', source: 'explicit', confidence: 0.95, salience: 0.95 },
        });

        const resolved = MemoryFilter.resolveContradictions([chatMemory, ltmfMemory], loreIntent);
        const ltmfIdx = resolved.findIndex(m => m.id === 'ltmf-a00-001');
        const chatIdx = resolved.findIndex(m => m.id === 'chat-002');
        expect(ltmfIdx).toBeGreaterThanOrEqual(0);
        expect(chatIdx).toBeGreaterThanOrEqual(0);
        // LTMF/rag outranks recent chat for lore queries
        expect(ltmfIdx).toBeLessThan(chatIdx);
    });

    it('for non-lore intent, explicit still outranks rag (default behavior unchanged)', () => {
        const techIntent = IntentClassifier.classify('Debug the memory retrieval pipeline');
        expect(techIntent.class).toBe('technical');

        const ragMemory = makeMemory({
            id: 'rag-001',
            text: 'MemoryService implements composite scoring with WEIGHT_SEMANTIC=0.35.',
            metadata: { role: 'core', source: 'rag', confidence: 0.9, salience: 0.9 },
        });
        const explicitMemory = makeMemory({
            id: 'explicit-001',
            text: 'User prefers dark mode in all tools.',
            metadata: { role: 'core', source: 'explicit', confidence: 0.8, salience: 0.8 },
        });

        const resolved = MemoryFilter.resolveContradictions([ragMemory, explicitMemory], techIntent);
        const explicitIdx = resolved.findIndex(m => m.id === 'explicit-001');
        const ragIdx = resolved.findIndex(m => m.id === 'rag-001');
        // explicit still wins for non-lore queries
        expect(explicitIdx).toBeLessThan(ragIdx);
    });
});

// ---------------------------------------------------------------------------
// Part 7 — RP Mode: Autobiographical Reads Allowed (NEW)
// ---------------------------------------------------------------------------

describe('RP mode — autobiographical reads remain allowed', () => {
    it('RP mode still blocks tools (scenario D: browser intent)', async () => {
        const router = new TalaContextRouter(new MockMemoryService() as any);
        const ctx = await router.process('rp-tool-block', 'Open a browser to google.com', 'rp');
        expect(ctx.blockedCapabilities).toContain('tools');
    });

    it('RP mode still blocks memory writes for lore prompts', async () => {
        const router = new TalaContextRouter(new MockMemoryService() as any);
        const ctx = await router.process('rp-write-lore', 'Tell me about when you were 17', 'rp');
        expect(ctx.memoryWriteDecision?.category).toBe('do_not_write');
    });

    it('RP mode allows lore retrieval reads (memory_retrieval in allowedCapabilities)', async () => {
        const router = new TalaContextRouter(new MockMemoryService() as any);
        const ctx = await router.process('rp-lore-read', 'Hey baby can you tell me about when you were 17?', 'rp');
        expect(ctx.allowedCapabilities).toContain('memory_retrieval');
        expect(ctx.blockedCapabilities).not.toContain('memory_retrieval');
    });
});


