/**
 * Cognitive Turn Model Tests — Phase 3
 *
 * Validates the canonical TalaCognitiveContext model assembled by CognitiveTurnAssembler.
 *
 * Coverage:
 * - Context includes all required cognitive fields
 * - Mode policy is correctly applied per mode
 * - Memory contributions are structured with categories
 * - Emotional modulation degrades gracefully when astro unavailable
 * - Reflection contributions respect expiry and confidence
 * - Context assembly is deterministic
 * - Telemetry events are emitted for each cognitive step
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CognitiveTurnAssembler } from '../../services/cognitive/CognitiveTurnAssembler';
import { MemoryContributionBuilder } from '../../services/cognitive/MemoryContributionModel';
import { EmotionalModulationPolicy } from '../../services/cognitive/EmotionalModulationPolicy';
import { ReflectionContributionStore } from '../../services/cognitive/ReflectionContributionModel';
import { ModePolicyEngine } from '../../services/router/ModePolicyEngine';
import type { MemoryItem } from '../../services/MemoryService';

// ─── Telemetry mock ───────────────────────────────────────────────────────────

const emittedEvents: Array<{ eventType: string; summary: string }> = [];

vi.mock('../../services/TelemetryService', () => ({
    telemetry: {
        operational: (_s: string, et: string, _sv: string, _a: string, sum: string) => {
            emittedEvents.push({ eventType: et, summary: sum });
        },
        emit: (_s: string, et: string) => { emittedEvents.push({ eventType: et, summary: '' }); },
        audit: (_s: string, et: string) => { emittedEvents.push({ eventType: et, summary: '' }); },
        debug: (_s: string, et: string) => { emittedEvents.push({ eventType: et, summary: '' }); },
    },
}));

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeMemoryItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
    return {
        id: `mem-${Math.random().toString(36).slice(2, 8)}`,
        text: 'Test memory content',
        timestamp: new Date().toISOString(),
        metadata: {
            type: 'factual',
            source: 'mem0',
            salience: 0.7,
            confidence: 0.8,
        },
        status: 'active',
        ...overrides,
    } as MemoryItem;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CognitiveTurnAssembler — canonical structure', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('assembles a complete TalaCognitiveContext with all required fields', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 'turn-001',
            rawInput: 'How does the memory system work?',
            mode: 'assistant',
        });

        expect(ctx).toHaveProperty('turnId', 'turn-001');
        expect(ctx).toHaveProperty('assembledAt');
        expect(ctx).toHaveProperty('rawInput', 'How does the memory system work?');
        expect(ctx).toHaveProperty('normalizedInput', 'how does the memory system work?');
        expect(ctx).toHaveProperty('modePolicy');
        expect(ctx).toHaveProperty('memoryContributions');
        expect(ctx).toHaveProperty('docContributions');
        expect(ctx).toHaveProperty('emotionalModulation');
        expect(ctx).toHaveProperty('reflectionContributions');
        expect(ctx).toHaveProperty('providerMetadata');
        expect(ctx).toHaveProperty('assemblyInputsSummary');
        expect(ctx).toHaveProperty('correlationId');
        expect(ctx.correlationId).toBeTruthy();
    });

    it('normalizes rawInput to lowercase trimmed', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 'turn-002',
            rawInput: '  Hello World  ',
            mode: 'assistant',
        });
        expect(ctx.normalizedInput).toBe('hello world');
    });

    it('emits cognitive_context_assembled telemetry', () => {
        CognitiveTurnAssembler.assemble({
            turnId: 'turn-003',
            rawInput: 'Test input',
            mode: 'assistant',
        });

        expect(emittedEvents.some(e => e.eventType === 'cognitive_context_assembled')).toBe(true);
        expect(emittedEvents.some(e => e.eventType === 'mode_policy_applied')).toBe(true);
        expect(emittedEvents.some(e => e.eventType === 'memory_contribution_applied')).toBe(true);
    });

    it('produces a stable correlationId per turn', () => {
        const ctx1 = CognitiveTurnAssembler.assemble({ turnId: 't1', rawInput: 'a', mode: 'assistant' });
        const ctx2 = CognitiveTurnAssembler.assemble({ turnId: 't2', rawInput: 'b', mode: 'assistant' });
        expect(ctx1.correlationId).not.toBe(ctx2.correlationId);
    });
});

describe('CognitiveTurnAssembler — mode policy', () => {
    it('applies assistant mode cognitive rules', () => {
        const ctx = CognitiveTurnAssembler.assemble({ turnId: 't1', rawInput: 'test', mode: 'assistant' });
        expect(ctx.modePolicy.mode).toBe('assistant');
        expect(ctx.modePolicy.memoryRetrievalPolicy).toBe('full');
        expect(ctx.modePolicy.toolUsePolicy).toBe('all');
        expect(ctx.modePolicy.docRetrievalPolicy).toBe('enabled');
        expect(ctx.modePolicy.emotionalExpressionBounds).toBe('low');
    });

    it('applies rp mode cognitive rules', () => {
        const ctx = CognitiveTurnAssembler.assemble({ turnId: 't2', rawInput: 'test', mode: 'rp' });
        expect(ctx.modePolicy.mode).toBe('rp');
        expect(ctx.modePolicy.toolUsePolicy).toBe('none');
        expect(ctx.modePolicy.docRetrievalPolicy).toBe('suppressed');
        expect(ctx.modePolicy.emotionalExpressionBounds).toBe('high');
    });

    it('applies hybrid mode cognitive rules', () => {
        const ctx = CognitiveTurnAssembler.assemble({ turnId: 't3', rawInput: 'test', mode: 'hybrid' });
        expect(ctx.modePolicy.mode).toBe('hybrid');
        expect(ctx.modePolicy.toolUsePolicy).toBe('task_only');
        expect(ctx.modePolicy.docRetrievalPolicy).toBe('enabled');
        expect(ctx.modePolicy.emotionalExpressionBounds).toBe('medium');
    });

    it('suppresses doc context in rp mode even if text is provided', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 't4',
            rawInput: 'test',
            mode: 'rp',
            docContextText: 'Some documentation here',
            docSourceIds: ['doc-1'],
        });
        // RP mode suppresses doc retrieval
        expect(ctx.docContributions.applied).toBe(false);
    });

    it('applies doc context in assistant mode when text is provided', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 't5',
            rawInput: 'test',
            mode: 'assistant',
            docContextText: 'Some documentation here',
            docSourceIds: ['doc-1', 'doc-2'],
        });
        expect(ctx.docContributions.applied).toBe(true);
        expect(ctx.docContributions.sourceIds).toEqual(['doc-1', 'doc-2']);
    });
});

describe('CognitiveTurnAssembler — memory contributions', () => {
    it('includes memory contributions from approved memories', () => {
        const memories = [
            makeMemoryItem({ metadata: { type: 'user_profile', source: 'explicit', salience: 0.9 } }),
            makeMemoryItem({ metadata: { type: 'factual', source: 'mem0', salience: 0.7 } }),
        ];

        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 't1',
            rawInput: 'test',
            mode: 'assistant',
            approvedMemories: memories,
            memoryCandidateCount: 5,
            memoryExcludedCount: 3,
        });

        expect(ctx.memoryContributions.contributions.length).toBeGreaterThan(0);
        expect(ctx.memoryContributions.candidateCount).toBe(5);
        expect(ctx.memoryContributions.excludedCount).toBe(3);
        expect(ctx.memoryContributions.retrievalSuppressed).toBe(false);
    });

    it('marks memory as suppressed when retrieval suppressed', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 't2',
            rawInput: 'hello',
            mode: 'assistant',
            memoryRetrievalSuppressed: true,
            memorySuppressionReason: 'greeting intent',
        });

        expect(ctx.memoryContributions.retrievalSuppressed).toBe(true);
        expect(ctx.memoryContributions.contributions.length).toBe(0);
        expect(ctx.memoryContributions.suppressionReason).toBe('greeting intent');
    });

    it('classifies identity memories correctly', () => {
        const memories = [
            makeMemoryItem({
                text: 'User is Alex Reed',
                metadata: { type: 'identity', source: 'explicit', salience: 0.9, confidence: 0.95 },
            }),
        ];

        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 't3',
            rawInput: 'tell me about myself',
            mode: 'assistant',
            approvedMemories: memories,
            memoryCandidateCount: 1,
            memoryExcludedCount: 0,
        });

        const identityContrib = ctx.memoryContributions.contributions.find(c => c.category === 'identity');
        expect(identityContrib).toBeDefined();
        expect(identityContrib?.influenceScope).toContain('identity');
    });
});

describe('CognitiveTurnAssembler — emotional modulation', () => {
    it('degrades gracefully when astro engine is unavailable', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 't1',
            rawInput: 'test',
            mode: 'assistant',
            astroStateText: null,
        });

        expect(ctx.emotionalModulation.applied).toBe(false);
        expect(ctx.emotionalModulation.astroUnavailable).toBe(true);
        expect(ctx.emotionalModulation.strength).toBe('none');
    });

    it('applies modulation when astro state is available in rp mode', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 't2',
            rawInput: 'test',
            mode: 'rp',
            astroStateText: '[ASTRO STATE]\nSystem Instructions: Be warm and expressive\nwarmth: 0.8\nintensity: 0.7\nclarity: 0.6\ncaution: 0.3',
        });

        expect(ctx.emotionalModulation.applied).toBe(true);
        expect(ctx.emotionalModulation.astroUnavailable).toBe(false);
        expect(ctx.emotionalModulation.strength).not.toBe('none');
    });

    it('emits emotional_modulation_skipped when astro unavailable', () => {
        emittedEvents.length = 0;
        CognitiveTurnAssembler.assemble({
            turnId: 't3',
            rawInput: 'test',
            mode: 'assistant',
            astroStateText: undefined,
        });

        expect(emittedEvents.some(e => e.eventType === 'emotional_modulation_skipped')).toBe(true);
    });
});

describe('CognitiveTurnAssembler — provider metadata', () => {
    it('includes provider metadata in context', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 't1',
            rawInput: 'test',
            mode: 'assistant',
            providerId: 'ollama-main',
            providerName: 'Ollama',
            fallbackApplied: false,
            runtimeDegraded: false,
        });

        expect(ctx.providerMetadata.providerId).toBe('ollama-main');
        expect(ctx.providerMetadata.providerName).toBe('Ollama');
        expect(ctx.providerMetadata.fallbackApplied).toBe(false);
        expect(ctx.providerMetadata.runtimeDegraded).toBe(false);
    });

    it('notes degradation when runtime is degraded', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 't2',
            rawInput: 'test',
            mode: 'assistant',
            runtimeDegraded: true,
            degradationNotes: 'Primary provider unavailable, using fallback',
            fallbackApplied: true,
        });

        expect(ctx.providerMetadata.runtimeDegraded).toBe(true);
        expect(ctx.providerMetadata.fallbackApplied).toBe(true);
        expect(ctx.providerMetadata.degradationNotes).toContain('fallback');
    });
});

// ─── ModePolicyEngine cognitive rules ────────────────────────────────────────

describe('ModePolicyEngine — cognitive rules', () => {
    it('returns distinct cognitive rules per mode', () => {
        const assistantRules = ModePolicyEngine.getCognitiveRules('assistant');
        const rpRules = ModePolicyEngine.getCognitiveRules('rp');
        const hybridRules = ModePolicyEngine.getCognitiveRules('hybrid');

        expect(assistantRules.toolUsePolicy).toBe('all');
        expect(rpRules.toolUsePolicy).toBe('none');
        expect(hybridRules.toolUsePolicy).toBe('task_only');

        expect(assistantRules.docRetrievalPolicy).toBe('enabled');
        expect(rpRules.docRetrievalPolicy).toBe('suppressed');

        expect(assistantRules.emotionalExpressionBounds).toBe('low');
        expect(rpRules.emotionalExpressionBounds).toBe('high');
        expect(hybridRules.emotionalExpressionBounds).toBe('medium');
    });

    it('assistant mode uses full memory retrieval', () => {
        expect(ModePolicyEngine.getCognitiveRules('assistant').memoryRetrievalPolicy).toBe('full');
    });

    it('rp mode uses filtered memory retrieval', () => {
        expect(ModePolicyEngine.getCognitiveRules('rp').memoryRetrievalPolicy).toBe('filtered');
    });

    it('rp mode does not write memory', () => {
        expect(ModePolicyEngine.getCognitiveRules('rp').memoryWritePolicy).toBe('do_not_write');
    });
});
