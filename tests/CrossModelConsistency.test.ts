/**
 * CrossModelConsistency — Phase 3C: Cognitive Behavior Validation
 *
 * Validates that model capability classification and compaction produce
 * consistent identity, tool policy, mode policy, and tone behavior across
 * model sizes (3B, 7B, 13B+). Confirms expected differences are intentional.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test' },
}));

vi.mock('../electron/services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn(),
        event: vi.fn(),
    },
}));

import { classifyModelCapability } from '../electron/services/cognitive/ModelCapabilityClassifier';
import { CognitiveContextCompactor } from '../electron/services/cognitive/CognitiveContextCompactor';
import type { TalaCognitiveContext } from '../shared/cognitiveTurnTypes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PROVIDER = { providerId: 'ollama', providerType: 'ollama', displayName: 'Ollama' };

function makeCognitiveContext(): TalaCognitiveContext {
    const now = new Date().toISOString();
    return {
        turnId: 'cross-model-test',
        assembledAt: now,
        rawInput: 'Explain async/await in TypeScript.',
        normalizedInput: 'explain async/await in typescript.',
        modePolicy: {
            mode: 'assistant',
            memoryRetrievalPolicy: 'full',
            memoryWritePolicy: 'short_term',
            toolUsePolicy: 'all',
            docRetrievalPolicy: 'enabled',
            emotionalExpressionBounds: 'low',
            appliedAt: now,
        },
        memoryContributions: {
            contributions: [
                {
                    memoryId: 'mem-a',
                    category: 'identity',
                    summary: 'User is a senior TypeScript developer.',
                    rationale: 'Identity context.',
                    influenceScope: ['identity', 'tone'],
                    salience: 0.9,
                },
                {
                    memoryId: 'mem-b',
                    category: 'task_relevant',
                    summary: 'User is building a Node.js API.',
                    rationale: 'Task context.',
                    influenceScope: ['task'],
                    salience: 0.8,
                },
            ],
            candidateCount: 4,
            excludedCount: 2,
            retrievalSuppressed: false,
            retrievedAt: now,
        },
        docContributions: {
            applied: true,
            summary: 'TypeScript async/await handbook excerpt.',
            rationale: 'Relevant to current query.',
            sourceIds: ['doc-001'],
            retrievedAt: now,
        },
        emotionalModulation: {
            applied: true,
            strength: 'medium',
            influencedDimensions: ['tone'],
            modulation_summary: 'Maintain supportive tone.',
            astroUnavailable: false,
            retrievedAt: now,
        },
        reflectionContributions: {
            activeNotes: [],
            suppressedNotes: [],
            applied: false,
        },
        providerMetadata: {
            providerId: 'ollama',
            providerName: 'Ollama',
            fallbackApplied: false,
            runtimeDegraded: false,
        },
        assemblyInputsSummary: [],
        wasCompacted: false,
        correlationId: 'test-corr-cross-001',
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CrossModelConsistency', () => {
    // ── Classification ────────────────────────────────────────────────────────

    it('3B model classifies as tiny', () => {
        const p = classifyModelCapability(PROVIDER, 'qwen2.5:3b');
        expect(p.parameterClass).toBe('tiny');
        expect(p.promptProfileClass).toBe('tiny_profile');
    });

    it('7B model classifies as small', () => {
        const p = classifyModelCapability(PROVIDER, 'llama3.1:7b');
        expect(p.parameterClass).toBe('small');
        expect(p.promptProfileClass).toBe('small_profile');
    });

    it('13B model classifies as medium', () => {
        const p = classifyModelCapability(PROVIDER, 'llama2:13b');
        expect(p.parameterClass).toBe('medium');
        expect(p.promptProfileClass).toBe('medium_profile');
    });

    it('70B model classifies as large', () => {
        const p = classifyModelCapability(PROVIDER, 'llama3.1:70b');
        expect(p.parameterClass).toBe('large');
        expect(p.promptProfileClass).toBe('large_profile');
    });

    // ── Compaction policy differences ─────────────────────────────────────────

    it('tiny profile uses aggressive compaction', () => {
        const p = classifyModelCapability(PROVIDER, 'qwen2.5:3b');
        expect(p.compactionPolicy).toBe('aggressive');
    });

    it('small profile uses moderate compaction', () => {
        const p = classifyModelCapability(PROVIDER, 'llama3.1:7b');
        expect(p.compactionPolicy).toBe('moderate');
    });

    it('medium profile uses standard compaction', () => {
        const p = classifyModelCapability(PROVIDER, 'llama2:13b');
        expect(p.compactionPolicy).toBe('standard');
    });

    it('large profile uses full compaction', () => {
        const p = classifyModelCapability(PROVIDER, 'llama3.1:70b');
        expect(p.compactionPolicy).toBe('full');
    });

    // ── Consistent identity across model sizes ────────────────────────────────

    it('all model sizes produce non-empty identity core', () => {
        const models = ['qwen2.5:3b', 'llama3.1:7b', 'llama2:13b', 'llama3.1:70b'];
        const compactor = new CognitiveContextCompactor();
        const context = makeCognitiveContext();

        for (const modelName of models) {
            const profile = classifyModelCapability(PROVIDER, modelName);
            const packet = compactor.compact(context, profile);
            expect(packet.identityCore.length).toBeGreaterThan(10);
        }
    });

    it('all model sizes produce mode block with assistant', () => {
        const models = ['qwen2.5:3b', 'llama3.1:7b', 'llama2:13b', 'llama3.1:70b'];
        const compactor = new CognitiveContextCompactor();
        const context = makeCognitiveContext();

        for (const modelName of models) {
            const profile = classifyModelCapability(PROVIDER, modelName);
            const packet = compactor.compact(context, profile);
            expect(packet.modeBlock).toContain('assistant');
        }
    });

    // ── Budget increases with model size ──────────────────────────────────────

    it('large model allows more memories than tiny model', () => {
        const tiny = classifyModelCapability(PROVIDER, 'qwen2.5:3b');
        const large = classifyModelCapability(PROVIDER, 'llama3.1:70b');

        const tinyTotal = tiny.budgetProfile.identityMemoryCap +
            tiny.budgetProfile.taskMemoryCap +
            tiny.budgetProfile.continuityMemoryCap +
            tiny.budgetProfile.preferenceMemoryCap;

        const largeTotal = large.budgetProfile.identityMemoryCap +
            large.budgetProfile.taskMemoryCap +
            large.budgetProfile.continuityMemoryCap +
            large.budgetProfile.preferenceMemoryCap;

        expect(largeTotal).toBeGreaterThan(tinyTotal);
    });

    it('large model allows full tool schemas; tiny does not', () => {
        const tiny = classifyModelCapability(PROVIDER, 'qwen2.5:3b');
        const large = classifyModelCapability(PROVIDER, 'llama3.1:70b');

        expect(tiny.budgetProfile.allowFullToolSchemas).toBe(false);
        expect(large.budgetProfile.allowFullToolSchemas).toBe(true);
    });

    it('large model allows full identity prose; tiny does not', () => {
        const tiny = classifyModelCapability(PROVIDER, 'qwen2.5:3b');
        const large = classifyModelCapability(PROVIDER, 'llama3.1:70b');

        expect(tiny.budgetProfile.allowFullIdentityProse).toBe(false);
        expect(large.budgetProfile.allowFullIdentityProse).toBe(true);
    });

    // ── Consistent diagnostics ────────────────────────────────────────────────

    it('diagnostics summary is present for all model sizes', () => {
        const models = ['qwen2.5:3b', 'llama3.1:7b', 'llama2:13b', 'llama3.1:70b'];
        const compactor = new CognitiveContextCompactor();
        const context = makeCognitiveContext();

        for (const modelName of models) {
            const profile = classifyModelCapability(PROVIDER, modelName);
            const packet = compactor.compact(context, profile);
            expect(packet.diagnosticsSummary).toBeDefined();
            expect(packet.diagnosticsSummary.parameterClass).toBeTruthy();
        }
    });
});
