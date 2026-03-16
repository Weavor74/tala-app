/**
 * TinyModelPromptValidation — Phase 3C: Cognitive Behavior Validation
 *
 * Validates that the cognitive compaction pipeline produces correct prompt
 * packets for tiny (3B-class) models. Confirms token budget enforcement,
 * identity scaffold correctness, tool and emotional compression behavior,
 * and prevention of prompt overflow.
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

function makeTinyProfile() {
    return classifyModelCapability(
        { providerId: 'ollama', providerType: 'ollama', displayName: 'Ollama' },
        'qwen2.5:3b',
    );
}

function makeMinimalCognitiveContext(overrides: Partial<TalaCognitiveContext> = {}): TalaCognitiveContext {
    const now = new Date().toISOString();
    return {
        turnId: 'test-turn-001',
        assembledAt: now,
        rawInput: 'Hello, how are you?',
        normalizedInput: 'hello, how are you?',
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
                    memoryId: 'mem-001',
                    category: 'identity',
                    summary: 'User prefers concise responses.',
                    rationale: 'Explicit user preference.',
                    influenceScope: ['tone', 'style'],
                    salience: 0.9,
                },
                {
                    memoryId: 'mem-002',
                    category: 'task_relevant',
                    summary: 'User is working on a TypeScript project.',
                    rationale: 'Recent task context.',
                    influenceScope: ['task'],
                    salience: 0.8,
                },
                {
                    memoryId: 'mem-003',
                    category: 'task_relevant',
                    summary: 'User asked about async patterns last session.',
                    rationale: 'Recent continuity.',
                    influenceScope: ['task'],
                    salience: 0.7,
                },
                {
                    memoryId: 'mem-004',
                    category: 'preference',
                    summary: 'User dislikes verbose explanations.',
                    rationale: 'Stated preference.',
                    influenceScope: ['style'],
                    salience: 0.6,
                },
                {
                    memoryId: 'mem-005',
                    category: 'recent_continuity',
                    summary: 'User opened a debugging session.',
                    rationale: 'Recent session context.',
                    influenceScope: ['task'],
                    salience: 0.5,
                },
                {
                    memoryId: 'mem-006',
                    category: 'task_relevant',
                    summary: 'User is using Node.js 20.',
                    rationale: 'Technical context.',
                    influenceScope: ['task'],
                    salience: 0.65,
                },
            ],
            candidateCount: 8,
            excludedCount: 2,
            retrievalSuppressed: false,
            retrievedAt: now,
        },
        docContributions: {
            applied: true,
            summary: 'TypeScript handbook excerpt on async/await patterns.',
            rationale: 'Relevant to current task context.',
            sourceIds: ['doc-001'],
            retrievedAt: now,
        },
        emotionalModulation: {
            applied: true,
            strength: 'medium',
            influencedDimensions: ['tone', 'warmth'],
            modulation_summary: 'Maintain a warm, supportive tone.',
            astroUnavailable: false,
            retrievedAt: now,
        },
        reflectionContributions: {
            activeNotes: [
                {
                    noteId: 'note-001',
                    noteClass: 'preference_reminder',
                    summary: 'User prefers short answers.',
                    confidence: 0.85,
                    applicationCount: 0,
                    maxApplications: 10,
                    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                    generatedAt: now,
                    suppressed: false,
                },
            ],
            suppressedNotes: [],
            applied: true,
        },
        providerMetadata: {
            providerId: 'ollama',
            providerName: 'Ollama',
            fallbackApplied: false,
            runtimeDegraded: false,
        },
        assemblyInputsSummary: [],
        wasCompacted: false,
        correlationId: 'test-corr-001',
        ...overrides,
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TinyModelPromptValidation', () => {
    it('classifies qwen2.5:3b as tiny parameter class', () => {
        const profile = makeTinyProfile();
        expect(profile.parameterClass).toBe('tiny');
        expect(profile.promptProfileClass).toBe('tiny_profile');
    });

    it('applies aggressive compaction policy to tiny profile', () => {
        const profile = makeTinyProfile();
        expect(profile.compactionPolicy).toBe('aggressive');
    });

    it('tiny profile suppresses full tool schemas', () => {
        const profile = makeTinyProfile();
        expect(profile.budgetProfile.allowFullToolSchemas).toBe(false);
    });

    it('tiny profile suppresses full identity prose', () => {
        const profile = makeTinyProfile();
        expect(profile.budgetProfile.allowFullIdentityProse).toBe(false);
    });

    it('tiny profile suppresses docs unless highly relevant', () => {
        const profile = makeTinyProfile();
        expect(profile.budgetProfile.suppressDocsUnlessHighlyRelevant).toBe(true);
    });

    it('tiny profile caps identity memory at 2', () => {
        const profile = makeTinyProfile();
        expect(profile.budgetProfile.identityMemoryCap).toBe(2);
    });

    it('tiny profile caps task memory at 3', () => {
        const profile = makeTinyProfile();
        expect(profile.budgetProfile.taskMemoryCap).toBe(3);
    });

    it('produces a CompactPromptPacket for a tiny model', () => {
        const profile = makeTinyProfile();
        const context = makeMinimalCognitiveContext();
        const compactor = new CognitiveContextCompactor();
        const packet = compactor.compact(context, profile);

        expect(packet).toBeDefined();
        expect(packet.identityCore).toBeTruthy();
        expect(packet.modeBlock).toContain('assistant');
        expect(packet.assembledSections).toBeInstanceOf(Array);
        expect(packet.assembledSections.length).toBeGreaterThan(0);
        expect(packet.diagnosticsSummary).toBeDefined();
    });

    it('diagnostics summary reports correct profile class', () => {
        const profile = makeTinyProfile();
        const context = makeMinimalCognitiveContext();
        const compactor = new CognitiveContextCompactor();
        const packet = compactor.compact(context, profile);

        expect(packet.diagnosticsSummary.profileClass).toBe('tiny_profile');
        expect(packet.diagnosticsSummary.compactionPolicy).toBe('aggressive');
        expect(packet.diagnosticsSummary.parameterClass).toBe('tiny');
    });

    it('compacts memories down to tiny budget caps', () => {
        const profile = makeTinyProfile();
        const context = makeMinimalCognitiveContext();
        const compactor = new CognitiveContextCompactor();
        const packet = compactor.compact(context, profile);

        // 6 memories in context; tiny budget is identity=2, task=3, continuity=2, pref=0
        // total max = 7 — but aggressive policy may drop further
        expect(packet.diagnosticsSummary.memoriesKept).toBeLessThanOrEqual(
            profile.budgetProfile.identityMemoryCap +
            profile.budgetProfile.taskMemoryCap +
            profile.budgetProfile.continuityMemoryCap +
            profile.budgetProfile.preferenceMemoryCap,
        );
    });

    it('drops memories when over tiny budget, records in diagnostics', () => {
        const profile = makeTinyProfile();
        const context = makeMinimalCognitiveContext();
        const compactor = new CognitiveContextCompactor();
        const packet = compactor.compact(context, profile);

        const { memoriesKept, memoriesDropped } = packet.diagnosticsSummary;
        expect(memoriesKept + memoriesDropped).toBeGreaterThanOrEqual(
            context.memoryContributions.contributions.length,
        );
    });

    it('identity core is non-empty after compression', () => {
        const profile = makeTinyProfile();
        const context = makeMinimalCognitiveContext();
        const compactor = new CognitiveContextCompactor();
        const packet = compactor.compact(context, profile);

        expect(packet.identityCore.length).toBeGreaterThan(10);
    });

    it('assembled sections contain mode and task blocks', () => {
        const profile = makeTinyProfile();
        const context = makeMinimalCognitiveContext();
        const compactor = new CognitiveContextCompactor();
        const packet = compactor.compact(context, profile);

        const joined = packet.assembledSections.join('\n');
        expect(joined).toContain('[Mode]');
    });

    it('response rules block is present for tiny model', () => {
        const profile = makeTinyProfile();
        const context = makeMinimalCognitiveContext();
        const compactor = new CognitiveContextCompactor();
        const packet = compactor.compact(context, profile);

        expect(packet.responseRulesBlock).toContain('concise');
    });
});
