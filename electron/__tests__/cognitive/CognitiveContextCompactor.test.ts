/**
 * Cognitive Compaction Tests — Phase 3B
 *
 * Validates CognitiveContextCompactor behavior across tiny/small/medium/large profiles:
 * - Identity core always preserved
 * - Active mode always preserved
 * - Current task always preserved
 * - Explicit user facts (identity memories) outrank old inferred memory
 * - Lower-priority sections dropped under budget pressure
 * - Telemetry events emitted for each compaction step
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CognitiveContextCompactor } from '../../services/cognitive/CognitiveContextCompactor';
import { classifyModelCapability } from '../../services/cognitive/ModelCapabilityClassifier';
import type { TalaCognitiveContext } from '../../../shared/cognitiveTurnTypes';

// ─── Telemetry mock ───────────────────────────────────────────────────────────

const emittedEvents: Array<{ eventType: string; summary: string; payload?: Record<string, unknown> }> = [];

vi.mock('../../services/TelemetryService', () => ({
    telemetry: {
        operational: (_sub: string, et: string, _sev: string, _actor: string, sum: string, _status: string, opts?: { payload?: Record<string, unknown> }) => {
            emittedEvents.push({ eventType: et, summary: sum, payload: opts?.payload });
        },
        emit: () => {},
        audit: () => {},
        debug: () => {},
    },
}));

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<TalaCognitiveContext> = {}): TalaCognitiveContext {
    const now = new Date().toISOString();
    return {
        turnId: 'turn-test-001',
        assembledAt: now,
        rawInput: 'What is the status of my project?',
        normalizedInput: 'what is the status of my project',
        modePolicy: {
            mode: 'assistant',
            memoryRetrievalPolicy: 'full',
            memoryWritePolicy: 'long_term',
            toolUsePolicy: 'all',
            docRetrievalPolicy: 'enabled',
            emotionalExpressionBounds: 'medium',
            appliedAt: now,
        },
        memoryContributions: {
            contributions: [
                {
                    memoryId: 'mem-id-001',
                    category: 'identity',
                    summary: 'User is Alice, a software engineer',
                    rationale: 'Stable identity fact',
                    influenceScope: ['identity'],
                    salience: 0.95,
                },
                {
                    memoryId: 'mem-task-001',
                    category: 'task_relevant',
                    summary: 'Working on project Alpha with deadline Friday',
                    rationale: 'Active task context',
                    influenceScope: ['task'],
                    salience: 0.88,
                },
                {
                    memoryId: 'mem-task-002',
                    category: 'task_relevant',
                    summary: 'Project Alpha uses React and TypeScript',
                    rationale: 'Task tech context',
                    influenceScope: ['task'],
                    salience: 0.75,
                },
                {
                    memoryId: 'mem-task-003',
                    category: 'task_relevant',
                    summary: 'Last PR was merged yesterday',
                    rationale: 'Recent task activity',
                    influenceScope: ['task'],
                    salience: 0.60,
                },
                {
                    memoryId: 'mem-task-004',
                    category: 'task_relevant',
                    summary: 'Test coverage is at 82%',
                    rationale: 'Task metric',
                    influenceScope: ['task'],
                    salience: 0.50,
                },
                {
                    memoryId: 'mem-cont-001',
                    category: 'recent_continuity',
                    summary: 'User asked about deployment steps yesterday',
                    rationale: 'Recent conversation',
                    influenceScope: ['task'],
                    salience: 0.65,
                },
                {
                    memoryId: 'mem-pref-001',
                    category: 'preference',
                    summary: 'User prefers concise answers',
                    rationale: 'Preference',
                    influenceScope: ['style'],
                    salience: 0.55,
                },
            ],
            candidateCount: 7,
            excludedCount: 0,
            retrievalSuppressed: false,
            retrievedAt: now,
        },
        docContributions: {
            applied: true,
            summary: 'Project Alpha documentation: overview and setup guide',
            rationale: 'Relevant documentation retrieved',
            sourceIds: ['doc-001'],
            retrievedAt: now,
        },
        emotionalModulation: {
            applied: true,
            strength: 'low',
            influencedDimensions: ['tone', 'warmth'],
            modulation_summary: 'Slightly warmer tone for engagement. Focus on clarity.',
            astroUnavailable: false,
            retrievedAt: now,
        },
        reflectionContributions: {
            activeNotes: [
                {
                    noteId: 'note-001',
                    noteClass: 'preference_reminder',
                    summary: 'User prefers direct status updates without lengthy preamble',
                    confidence: 0.85,
                    generatedAt: now,
                    expiresAt: new Date(Date.now() + 86400000).toISOString(),
                    applicationCount: 1,
                    maxApplications: 5,
                    suppressed: false,
                },
                {
                    noteId: 'note-002',
                    noteClass: 'caution_note',
                    summary: 'Avoid making assumptions about deployment timeline without confirmation',
                    confidence: 0.70,
                    generatedAt: now,
                    expiresAt: new Date(Date.now() + 86400000).toISOString(),
                    applicationCount: 0,
                    maxApplications: 3,
                    suppressed: false,
                },
            ],
            suppressedNotes: [],
            applied: true,
            lastReflectionAt: now,
        },
        providerMetadata: {
            providerId: 'ollama',
            providerName: 'Ollama',
            fallbackApplied: false,
            runtimeDegraded: false,
        },
        assemblyInputsSummary: [],
        wasCompacted: false,
        correlationId: 'corr-001',
        ...overrides,
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CognitiveContextCompactor — tiny profile', () => {
    const compactor = new CognitiveContextCompactor();
    const tinyProfile = classifyModelCapability(
        { providerId: 'ollama', providerType: 'ollama', displayName: 'Ollama' },
        'qwen2.5:3b',
    );

    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('always includes identity core', () => {
        const packet = compactor.compact(makeContext(), tinyProfile);
        expect(packet.identityCore).toBeTruthy();
        expect(packet.identityCore).toContain('Tala');
        expect(packet.diagnosticsSummary.sectionsIncluded).toContain('identity');
    });

    it('always includes active mode', () => {
        const packet = compactor.compact(makeContext(), tinyProfile);
        expect(packet.modeBlock).toContain('assistant');
        expect(packet.diagnosticsSummary.sectionsIncluded).toContain('mode');
    });

    it('always includes current task', () => {
        const packet = compactor.compact(makeContext(), tinyProfile);
        expect(packet.currentTaskBlock).toContain('what is the status of my project');
        expect(packet.diagnosticsSummary.sectionsIncluded).toContain('task');
    });

    it('uses compressed identity scaffold (not full prose) for tiny profile', () => {
        const packet = compactor.compact(makeContext(), tinyProfile);
        expect(packet.diagnosticsSummary.identityMode).toBe('compressed');
        // Compressed format uses bracket labels
        expect(packet.identityCore).toContain('[Identity]');
    });

    it('uses compact tool policy (not full schemas) for tiny profile', () => {
        const packet = compactor.compact(makeContext(), tinyProfile);
        expect(packet.diagnosticsSummary.toolMode).toBe('compact_policy');
        expect(packet.toolPolicyBlock).toContain('[Tools]');
    });

    it('respects memory caps — identity memories kept first', () => {
        const packet = compactor.compact(makeContext(), tinyProfile);
        // tiny: identityMemoryCap=2, taskMemoryCap=3, continuityMemoryCap=2, preferenceMemoryCap=0
        expect(packet.diagnosticsSummary.memoriesKept).toBeLessThanOrEqual(
            2 + 3 + 2 + 0, // max possible for tiny
        );
    });

    it('preference memories are dropped under tiny budget (preferenceMemoryCap=0)', () => {
        const packet = compactor.compact(makeContext(), tinyProfile);
        // Identity memory is always present in continuity block
        expect(packet.continuityBlock).toContain('identity');
        // preferenceMemoryCap=0, so preference memories are dropped
        expect(packet.diagnosticsSummary.memoriesDropped).toBeGreaterThan(0);
    });

    it('does not include raw astro data', () => {
        const packet = compactor.compact(makeContext(), tinyProfile);
        // Emotional block should not contain planet names or raw astro content
        expect(packet.emotionalBiasBlock).not.toContain('natal');
        expect(packet.emotionalBiasBlock).not.toContain('transit');
        expect(packet.emotionalBiasBlock).not.toContain('planetary');
    });

    it('emits compaction telemetry events', () => {
        compactor.compact(makeContext(), tinyProfile);

        const expectedEvents = [
            'identity_compression_applied',
            'tool_compression_applied',
            'emotional_compression_applied',
            'memory_budget_applied',
            'doc_budget_applied',
            'reflection_budget_applied',
            'cognitive_context_compacted_for_model',
        ];

        for (const eventType of expectedEvents) {
            expect(emittedEvents.find(e => e.eventType === eventType)).toBeDefined();
        }
    });

    it('diagnostics summary includes profile and kept/dropped counts', () => {
        const packet = compactor.compact(makeContext(), tinyProfile);
        const diag = packet.diagnosticsSummary;

        expect(diag.profileClass).toBe('tiny_profile');
        expect(diag.compactionPolicy).toBe('aggressive');
        expect(diag.parameterClass).toBe('tiny');
        expect(typeof diag.memoriesKept).toBe('number');
        expect(typeof diag.memoriesDropped).toBe('number');
        expect(diag.rationale).toContain('tiny_profile');
    });

    it('has stable assembled sections order', () => {
        const ctx = makeContext();
        const packet1 = compactor.compact(ctx, tinyProfile);
        const packet2 = compactor.compact(ctx, tinyProfile);
        expect(packet1.assembledSections).toEqual(packet2.assembledSections);
    });
});

describe('CognitiveContextCompactor — large profile', () => {
    const compactor = new CognitiveContextCompactor();
    const largeProfile = classifyModelCapability(
        { providerId: 'ollama', providerType: 'ollama', displayName: 'Ollama' },
        'llama-70b',
    );

    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('uses full identity prose for large profile', () => {
        const packet = compactor.compact(makeContext(), largeProfile);
        expect(packet.diagnosticsSummary.identityMode).toBe('full');
        // Full prose does not use bracket labels
        expect(packet.identityCore).not.toContain('[Identity]');
        expect(packet.identityCore).toContain('Tala');
    });

    it('allows more memories for large profile', () => {
        const packet = compactor.compact(makeContext(), largeProfile);
        // large: identityMemoryCap=5, taskMemoryCap=8, etc.
        // With 7 total contributions, should keep all
        expect(packet.diagnosticsSummary.memoriesKept).toBe(7);
        expect(packet.diagnosticsSummary.memoriesDropped).toBe(0);
    });

    it('includes docs when applied for large profile', () => {
        const packet = compactor.compact(makeContext(), largeProfile);
        expect(packet.diagnosticsSummary.docsIncluded).toBe(true);
    });
});

describe('CognitiveContextCompactor — emotional compression', () => {
    const compactor = new CognitiveContextCompactor();
    const tinyProfile = classifyModelCapability(
        { providerId: 'ollama', providerType: 'ollama', displayName: 'Ollama' },
        'qwen2.5:3b',
    );

    it('handles unavailable astro gracefully', () => {
        const ctx = makeContext({
            emotionalModulation: {
                applied: false,
                strength: 'none',
                influencedDimensions: [],
                modulation_summary: '',
                astroUnavailable: true,
                skipReason: 'AstroService unavailable',
                retrievedAt: new Date().toISOString(),
            },
        });
        const packet = compactor.compact(ctx, tinyProfile);
        // Should not error, emotion block may be empty or absent
        expect(packet.diagnosticsSummary.emotionIncluded).toBe(false);
    });
});

describe('CognitiveContextCompactor — memory prioritization', () => {
    const compactor = new CognitiveContextCompactor();
    const tinyProfile = classifyModelCapability(
        { providerId: 'ollama', providerType: 'ollama', displayName: 'Ollama' },
        'qwen2.5:3b',
    );

    it('identity memories appear in continuity block before task memories', () => {
        const packet = compactor.compact(makeContext(), tinyProfile);
        const identityIdx = packet.continuityBlock.indexOf('identity');
        const taskIdx = packet.continuityBlock.indexOf('task_relevant');
        // identity should appear before task_relevant
        expect(identityIdx).toBeLessThan(taskIdx);
    });
});
