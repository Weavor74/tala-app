/**
 * Pre-Inference Context Orchestrator Tests — Phase 3A
 *
 * Validates the canonical pre-inference orchestration service that gathers
 * all live context before CognitiveTurnAssembler builds TalaCognitiveContext.
 *
 * Coverage:
 * 1. Pre-inference orchestration
 *    - Selects appropriate sources by intent/mode
 *    - Suppresses unnecessary retrieval (e.g. MCP for greeting)
 *    - Handles MCP degradation gracefully
 * 2. Memory retrieval feeds the result
 * 3. Astro/emotional state wiring (mode-gated, graceful fallback)
 * 4. Reflection note availability reported
 * 5. Telemetry events emitted for each orchestration step
 * 6. CognitiveTurnAssembler integration
 *    - Real turn builds TalaCognitiveContext from orchestration result
 * 7. Live compaction path
 *    - Selected model drives prompt profile
 *    - CompactPromptPacket produced from CognitiveTurnAssembler output
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PreInferenceContextOrchestrator } from '../../services/cognitive/PreInferenceContextOrchestrator';
import { CognitiveTurnAssembler } from '../../services/cognitive/CognitiveTurnAssembler';
import { promptProfileSelector } from '../../services/cognitive/PromptProfileSelector';
import { cognitiveContextCompactor } from '../../services/cognitive/CognitiveContextCompactor';
import type { PreInferenceOrchestrationResult } from '../../services/cognitive/PreInferenceContextOrchestrator';
import type { TurnContext } from '../../services/router/ContextAssembler';
import type { MemoryItem } from '../../services/MemoryService';

// ─── Telemetry mock ───────────────────────────────────────────────────────────

const emittedEvents: Array<{ eventType: string; status: string }> = [];

vi.mock('../../services/TelemetryService', () => ({
    telemetry: {
        operational: (_s: string, et: string, _sv: string, _a: string, _sum: string, status: string) => {
            emittedEvents.push({ eventType: et, status });
        },
        emit: (_s: string, et: string) => emittedEvents.push({ eventType: et, status: '' }),
        audit: (_s: string, et: string) => emittedEvents.push({ eventType: et, status: '' }),
        debug: (_s: string, et: string) => emittedEvents.push({ eventType: et, status: '' }),
    },
}));

// ─── Helper factories ─────────────────────────────────────────────────────────

function makeTurnContext(overrides: Partial<TurnContext> = {}): TurnContext {
    return {
        turnId: 'test-turn',
        resolvedMode: 'assistant',
        rawInput: 'How does memory work?',
        normalizedInput: 'how does memory work?',
        intent: { class: 'technical', confidence: 0.9, isGreeting: false },
        retrieval: { suppressed: false, approvedCount: 2, excludedCount: 1 },
        promptBlocks: [
            { header: '[MEMORY CONTEXT]', content: 'Memory fact 1\nMemory fact 2' },
        ],
        fallbackUsed: false,
        allowedCapabilities: ['all'] as any[],
        blockedCapabilities: [] as any[],
        persistedMode: 'assistant',
        selectedTools: [],
        artifactDecision: null,
        memoryWriteDecision: { category: 'long_term', reason: 'assistant mode', executed: false },
        auditMetadata: { turnStartedAt: Date.now(), turnCompletedAt: null, mcpServicesUsed: [], correlationId: 'corr-1' },
        errorState: null,
        resolvedMemories: [
            { id: 'mem-1', text: 'Test memory 1', timestamp: new Date().toISOString(), metadata: { type: 'factual', source: 'mem0', salience: 0.8, confidence: 0.9 }, status: 'active' } as MemoryItem,
        ],
        ...overrides,
    };
}

function makeGreetingTurnContext(): TurnContext {
    return makeTurnContext({
        intent: { class: 'greeting', confidence: 1.0, isGreeting: true },
        retrieval: { suppressed: true, approvedCount: 0, excludedCount: 0 },
        promptBlocks: [],
        resolvedMemories: [],
    });
}

function makeMockTalaRouter(turnCtx: TurnContext) {
    return {
        process: vi.fn().mockResolvedValue(turnCtx),
    } as any;
}

function makeMockAstroService(state = '[EMOTIONAL STATE]: Calm, focused energy.') {
    return {
        getReadyStatus: vi.fn().mockReturnValue(true),
        getEmotionalState: vi.fn().mockResolvedValue(state),
    };
}

function makeFailingAstroService() {
    return {
        getReadyStatus: vi.fn().mockReturnValue(true),
        getEmotionalState: vi.fn().mockRejectedValue(new Error('Astro offline')),
    };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('PreInferenceContextOrchestrator', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    // ── 1. Basic orchestration ─────────────────────────────────────────────

    it('returns a complete PreInferenceOrchestrationResult for a normal turn', async () => {
        const turnCtx = makeTurnContext();
        const orchestrator = new PreInferenceContextOrchestrator(
            makeMockTalaRouter(turnCtx),
            makeMockAstroService(),
            null,
        );

        const result = await orchestrator.orchestrate('turn-001', 'How does memory work?', 'assistant');

        expect(result.turnContext).toBeDefined();
        expect(result.intentClass).toBe('technical');
        expect(result.isGreeting).toBe(false);
        expect(result.memoryRetrievalSuppressed).toBe(false);
        expect(result.approvedMemories).toHaveLength(1);
        expect(result.memoryCandidateCount).toBe(3); // 2 approved + 1 excluded
        expect(result.memoryExcludedCount).toBe(1);
        expect(result.orchestrationDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('includes a memoryContextText from turnContext promptBlocks', async () => {
        const turnCtx = makeTurnContext();
        const orchestrator = new PreInferenceContextOrchestrator(
            makeMockTalaRouter(turnCtx),
            makeMockAstroService(),
            null,
        );

        const result = await orchestrator.orchestrate('turn-002', 'test', 'assistant');

        expect(result.memoryContextText).toContain('[MEMORY CONTEXT]');
        expect(result.memoryContextText).toContain('Memory fact 1');
    });

    // ── 2. Memory retrieval suppression ────────────────────────────────────

    it('suppresses memory retrieval for greeting turns', async () => {
        const greetingCtx = makeGreetingTurnContext();
        const orchestrator = new PreInferenceContextOrchestrator(
            makeMockTalaRouter(greetingCtx),
            makeMockAstroService(),
            null,
        );

        const result = await orchestrator.orchestrate('turn-003', 'Hello!', 'assistant');

        expect(result.isGreeting).toBe(true);
        expect(result.memoryRetrievalSuppressed).toBe(true);
        expect(result.approvedMemories).toHaveLength(0);
        expect(result.memorySuppressionReason).toBe('greeting_intent_suppression');
    });

    // ── 3. Astro / emotional state ──────────────────────────────────────────

    it('retrieves emotional state in assistant mode', async () => {
        const turnCtx = makeTurnContext();
        const astro = makeMockAstroService('[EMOTIONAL STATE]: Focused and direct.');
        const orchestrator = new PreInferenceContextOrchestrator(
            makeMockTalaRouter(turnCtx),
            astro,
            null,
        );

        const result = await orchestrator.orchestrate('turn-004', 'help me', 'assistant');

        expect(result.astroStateText).toBe('[EMOTIONAL STATE]: Focused and direct.');
        expect(astro.getEmotionalState).toHaveBeenCalled();
    });

    it('suppresses emotional state in RP mode', async () => {
        const turnCtx = makeTurnContext({ resolvedMode: 'rp' });
        const astro = makeMockAstroService();
        const orchestrator = new PreInferenceContextOrchestrator(
            makeMockTalaRouter(turnCtx),
            astro,
            null,
        );

        const result = await orchestrator.orchestrate('turn-005', 'Let us play', 'rp');

        expect(result.astroStateText).toBeNull();
        expect(astro.getEmotionalState).not.toHaveBeenCalled();
    });

    it('falls back gracefully when astro service is unavailable', async () => {
        const turnCtx = makeTurnContext();
        const failingAstro = makeFailingAstroService();
        const orchestrator = new PreInferenceContextOrchestrator(
            makeMockTalaRouter(turnCtx),
            failingAstro,
            null,
        );

        const result = await orchestrator.orchestrate('turn-006', 'help me', 'assistant');

        // Graceful fallback: astroStateText is null but turn does not collapse
        expect(result.astroStateText).toBeNull();
        expect(result.turnContext).toBeDefined();
        expect(result.intentClass).toBe('technical');
    });

    it('handles null astro service gracefully', async () => {
        const turnCtx = makeTurnContext();
        const orchestrator = new PreInferenceContextOrchestrator(
            makeMockTalaRouter(turnCtx),
            null, // no astro service
            null,
        );

        const result = await orchestrator.orchestrate('turn-007', 'help me', 'assistant');

        expect(result.astroStateText).toBeNull();
        expect(result.sourcesSuppressed).toContain('astro');
    });

    // ── 4. MCP pre-inference gating ────────────────────────────────────────

    it('suppresses MCP pre-inference for greeting turns', async () => {
        const greetingCtx = makeGreetingTurnContext();
        const mockMcp = { callTool: vi.fn() };
        const orchestrator = new PreInferenceContextOrchestrator(
            makeMockTalaRouter(greetingCtx),
            null,
            null,
            mockMcp,
        );

        const result = await orchestrator.orchestrate('turn-008', 'Hello!', 'assistant');

        expect(mockMcp.callTool).not.toHaveBeenCalled();
        expect(result.sourcesSuppressed).toContain('mcp_preinference');
    });

    it('suppresses MCP pre-inference for RP mode', async () => {
        const rpCtx = makeTurnContext({ resolvedMode: 'rp' });
        const mockMcp = { callTool: vi.fn() };
        const orchestrator = new PreInferenceContextOrchestrator(
            makeMockTalaRouter(rpCtx),
            null,
            null,
            mockMcp,
        );

        const result = await orchestrator.orchestrate('turn-009', 'We go on an adventure', 'rp');

        expect(mockMcp.callTool).not.toHaveBeenCalled();
        expect(result.sourcesSuppressed).toContain('mcp_preinference');
    });

    it('does not collapse the turn when MCP fails', async () => {
        const turnCtx = makeTurnContext({
            intent: { class: 'coding', confidence: 0.9, isGreeting: false },
        });
        const failingMcp = {
            callTool: vi.fn().mockRejectedValue(new Error('MCP offline')),
        };
        const orchestrator = new PreInferenceContextOrchestrator(
            makeMockTalaRouter(turnCtx),
            null,
            null,
            failingMcp,
        );

        // Turn should NOT throw even when MCP fails
        const result = await orchestrator.orchestrate('turn-010', 'write a function', 'assistant');

        expect(result).toBeDefined();
        expect(result.turnContext).toBeDefined();
        expect(result.mcpContextSummary).toBeUndefined();
    });

    // ── 5. Sources tracking ────────────────────────────────────────────────

    it('tracks sourcesQueried and sourcesSuppressed correctly', async () => {
        const turnCtx = makeTurnContext();
        const orchestrator = new PreInferenceContextOrchestrator(
            makeMockTalaRouter(turnCtx),
            makeMockAstroService(),
            null,
        );

        const result = await orchestrator.orchestrate('turn-011', 'technical query', 'assistant');

        expect(result.sourcesQueried).toContain('tala_router');
        expect(result.sourcesQueried).toContain('astro');
        expect(result.sourcesQueried).toContain('reflection_store');
    });

    // ── 6. Telemetry events ────────────────────────────────────────────────

    it('emits preinference_orchestration_started and completed events', async () => {
        const turnCtx = makeTurnContext();
        const orchestrator = new PreInferenceContextOrchestrator(
            makeMockTalaRouter(turnCtx),
            null,
            null,
        );

        await orchestrator.orchestrate('turn-012', 'test', 'assistant');

        const eventTypes = emittedEvents.map(e => e.eventType);
        expect(eventTypes).toContain('preinference_orchestration_started');
        expect(eventTypes).toContain('preinference_orchestration_completed');
    });

    it('emits memory_preinference_applied for successful retrieval', async () => {
        const turnCtx = makeTurnContext();
        const orchestrator = new PreInferenceContextOrchestrator(
            makeMockTalaRouter(turnCtx),
            null,
            null,
        );

        await orchestrator.orchestrate('turn-013', 'test', 'assistant');

        const memEvent = emittedEvents.find(e => e.eventType === 'memory_preinference_applied');
        expect(memEvent).toBeDefined();
        expect(memEvent?.status).toBe('success');
    });

    it('emits memory_preinference_applied suppressed for greeting', async () => {
        const greetingCtx = makeGreetingTurnContext();
        const orchestrator = new PreInferenceContextOrchestrator(
            makeMockTalaRouter(greetingCtx),
            null,
            null,
        );

        await orchestrator.orchestrate('turn-014', 'Hello', 'assistant');

        const memEvent = emittedEvents.find(e => e.eventType === 'memory_preinference_applied');
        expect(memEvent).toBeDefined();
        expect(memEvent?.status).toBe('suppressed');
    });

    it('emits emotional_state_applied when astro is available', async () => {
        const turnCtx = makeTurnContext();
        const orchestrator = new PreInferenceContextOrchestrator(
            makeMockTalaRouter(turnCtx),
            makeMockAstroService(),
            null,
        );

        await orchestrator.orchestrate('turn-015', 'test', 'assistant');

        const astroEvent = emittedEvents.find(e => e.eventType === 'emotional_state_applied');
        expect(astroEvent).toBeDefined();
    });

    it('emits emotional_state_skipped when astro fails', async () => {
        const turnCtx = makeTurnContext();
        const orchestrator = new PreInferenceContextOrchestrator(
            makeMockTalaRouter(turnCtx),
            makeFailingAstroService(),
            null,
        );

        await orchestrator.orchestrate('turn-016', 'test', 'assistant');

        const skipEvent = emittedEvents.find(e => e.eventType === 'emotional_state_skipped');
        expect(skipEvent).toBeDefined();
    });
});

// ─── CognitiveTurnAssembler integration ───────────────────────────────────────

describe('CognitiveTurnAssembler — integration with orchestration result', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('assembles TalaCognitiveContext from orchestration result fields', () => {
        const orchResult: Partial<PreInferenceOrchestrationResult> = {
            approvedMemories: [
                {
                    id: 'mem-2',
                    text: 'User prefers concise answers',
                    timestamp: new Date().toISOString(),
                    metadata: { type: 'preference', source: 'mem0', salience: 0.7, confidence: 0.85 },
                    status: 'active',
                } as MemoryItem,
            ],
            memoryCandidateCount: 5,
            memoryExcludedCount: 4,
            memoryRetrievalSuppressed: false,
            intentClass: 'technical',
            isGreeting: false,
            astroStateText: '[EMOTIONAL STATE]: Calm focus.',
            docContextText: null,
            docSourceIds: [],
        };

        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 'int-turn-001',
            rawInput: 'Explain the cognitive architecture',
            mode: 'assistant',
            approvedMemories: orchResult.approvedMemories!,
            memoryCandidateCount: orchResult.memoryCandidateCount,
            memoryExcludedCount: orchResult.memoryExcludedCount,
            memoryRetrievalSuppressed: orchResult.memoryRetrievalSuppressed,
            intentClass: orchResult.intentClass,
            isGreeting: orchResult.isGreeting,
            astroStateText: orchResult.astroStateText,
            docContextText: orchResult.docContextText,
            docSourceIds: orchResult.docSourceIds,
        });

        expect(ctx.turnId).toBe('int-turn-001');
        expect(ctx.modePolicy.mode).toBe('assistant');
        expect(ctx.memoryContributions.candidateCount).toBe(5);
        expect(ctx.memoryContributions.excludedCount).toBe(4);
        expect(ctx.providerMetadata.fallbackApplied).toBe(false);
    });

    it('builds correct TalaCognitiveContext for greeting turns (no memory)', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 'int-turn-002',
            rawInput: 'Hello!',
            mode: 'assistant',
            approvedMemories: [],
            memoryCandidateCount: 0,
            memoryExcludedCount: 0,
            memoryRetrievalSuppressed: true,
            memorySuppressionReason: 'greeting_intent_suppression',
            intentClass: 'greeting',
            isGreeting: true,
            astroStateText: null,
        });

        expect(ctx.memoryContributions.retrievalSuppressed).toBe(true);
        expect(ctx.memoryContributions.suppressionReason).toBe('greeting_intent_suppression');
        expect(ctx.memoryContributions.contributions).toHaveLength(0);
    });
});

// ─── Live compaction path ─────────────────────────────────────────────────────

describe('Live compaction — PromptProfileSelector + CognitiveContextCompactor', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('produces a CompactPromptPacket for tiny model', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 'compact-turn-001',
            rawInput: 'Write a function',
            mode: 'assistant',
        });

        const profile = promptProfileSelector.select(
            { providerId: 'ollama-local', providerType: 'ollama', displayName: 'Local Ollama' },
            'qwen2.5:3b',
            'compact-turn-001',
            'assistant',
        );
        const packet = cognitiveContextCompactor.compact(ctx, profile);

        expect(profile.promptProfileClass).toBe('tiny_profile');
        expect(profile.compactionPolicy).toBe('aggressive');
        expect(packet).toHaveProperty('identityCore');
        expect(packet).toHaveProperty('assembledSections');
        expect(packet).toHaveProperty('diagnosticsSummary');
        expect(packet.assembledSections.length).toBeGreaterThan(0);
    });

    it('produces a CompactPromptPacket for medium model with richer content', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 'compact-turn-002',
            rawInput: 'Explain the system architecture',
            mode: 'assistant',
        });

        const profile = promptProfileSelector.select(
            { providerId: 'ollama-local', providerType: 'ollama', displayName: 'Local Ollama' },
            'llama3.1:13b',
            'compact-turn-002',
            'assistant',
        );
        const packet = cognitiveContextCompactor.compact(ctx, profile);

        expect(profile.promptProfileClass).toBe('medium_profile');
        expect(packet.diagnosticsSummary.profileClass).toBe('medium_profile');
    });

    it('emits prompt_profile_selected telemetry on profile selection', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 'compact-turn-003',
            rawInput: 'test',
            mode: 'assistant',
        });

        promptProfileSelector.select(
            { providerId: 'ollama-local', providerType: 'ollama', displayName: 'Local Ollama' },
            'qwen2.5:7b',
            'compact-turn-003',
        );
        cognitiveContextCompactor.compact(ctx, promptProfileSelector.select(
            { providerId: 'ollama-local', providerType: 'ollama', displayName: 'Local Ollama' },
            'qwen2.5:7b',
            'compact-turn-003',
        ));

        const profileEvent = emittedEvents.find(e => e.eventType === 'prompt_profile_selected');
        expect(profileEvent).toBeDefined();
    });

    it('tiny/small packets have compaction applied (not full)', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 'compact-turn-004',
            rawInput: 'test',
            mode: 'assistant',
        });

        const profile = promptProfileSelector.select(
            { providerId: 'ollama-local', providerType: 'ollama', displayName: 'Local Ollama' },
            'qwen2.5:3b',
        );
        const packet = cognitiveContextCompactor.compact(ctx, profile);

        expect(profile.compactionPolicy).not.toBe('full');
        expect(packet.diagnosticsSummary.identityMode).toBe('compressed');
    });
});
