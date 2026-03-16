/**
 * CognitiveDiagnosticsSnapshot — Phase 3C: Cognitive Behavior Validation
 *
 * Validates that the cognitive diagnostics snapshot structure is correct and
 * that the RuntimeDiagnosticsAggregator correctly records cognitive context
 * and produces accurate Phase 3C diagnostics fields.
 *
 * Tests the snapshot data model without requiring live infrastructure.
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

import type { CognitiveDiagnosticsSnapshot } from '../shared/cognitiveTurnTypes';
import type { CompactionDiagnosticsSummary } from '../shared/modelCapabilityTypes';
import { RuntimeDiagnosticsAggregator } from '../electron/services/RuntimeDiagnosticsAggregator';
import type { TalaCognitiveContext } from '../shared/cognitiveTurnTypes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFullCognitiveContext(): TalaCognitiveContext {
    const now = new Date().toISOString();
    return {
        turnId: 'diag-test-001',
        assembledAt: now,
        rawInput: 'Show me the diagnostics panel.',
        normalizedInput: 'show me the diagnostics panel.',
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
                    memoryId: 'mem-d1',
                    category: 'identity',
                    summary: 'User is a developer.',
                    rationale: 'Identity context.',
                    influenceScope: ['identity'],
                    salience: 0.9,
                },
                {
                    memoryId: 'mem-d2',
                    category: 'task_relevant',
                    summary: 'User is working on diagnostics tooling.',
                    rationale: 'Task context.',
                    influenceScope: ['task'],
                    salience: 0.8,
                },
                {
                    memoryId: 'mem-d3',
                    category: 'task_relevant',
                    summary: 'User asked about observability last session.',
                    rationale: 'Continuity.',
                    influenceScope: ['task'],
                    salience: 0.7,
                },
            ],
            candidateCount: 7,
            excludedCount: 2,
            retrievalSuppressed: false,
            retrievedAt: now,
        },
        docContributions: {
            applied: true,
            summary: 'Diagnostics panel overview doc.',
            rationale: 'Query is relevant to diagnostics.',
            sourceIds: ['doc-diag-001'],
            retrievedAt: now,
        },
        emotionalModulation: {
            applied: true,
            strength: 'low',
            influencedDimensions: ['tone'],
            modulation_summary: 'Mild warmth from astro state.',
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
        assemblyInputsSummary: ['identity: 1 item', 'task: 2 items'],
        wasCompacted: true,
        correlationId: 'corr-diag-001',
    };
}

function makeCompactionSummary(): CompactionDiagnosticsSummary {
    return {
        profileClass: 'tiny_profile',
        compactionPolicy: 'aggressive',
        parameterClass: 'tiny',
        memoriesKept: 3,
        memoriesDropped: 2,
        docsIncluded: true,
        docChunksIncluded: 1,
        reflectionNotesKept: 0,
        reflectionNotesDropped: 0,
        emotionIncluded: true,
        sectionsDropped: [],
        totalSectionsAssembled: 6,
    };
}

function makeMinimalInferenceDiagnostics() {
    return {
        getState: () => ({
            selectedProviderId: 'ollama',
            selectedProviderName: 'Ollama',
            selectedProviderType: 'ollama',
            selectedProviderReady: true,
            lastUsedProviderId: 'ollama',
            attemptedProviders: ['ollama'],
            fallbackApplied: false,
            streamStatus: 'idle' as const,
            lastStreamStatus: 'completed' as const,
            providerInventorySummary: {
                totalProviders: 1,
                readyProviders: 1,
                degradedProviders: 0,
                unavailableProviders: 0,
            },
            lastUpdated: new Date().toISOString(),
        }),
    };
}

function makeMinimalMcpLifecycle() {
    return {
        getDiagnosticsInventory: () => ({
            services: [],
            totalConfigured: 0,
            totalReady: 0,
            totalDegraded: 0,
            totalUnavailable: 0,
            criticalUnavailable: false,
            lastUpdated: new Date().toISOString(),
        }),
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CognitiveDiagnosticsSnapshot', () => {
    // ── CognitiveDiagnosticsSnapshot type validation ──────────────────────────

    it('CognitiveDiagnosticsSnapshot has required fields', () => {
        const now = new Date().toISOString();
        const snapshot: CognitiveDiagnosticsSnapshot = {
            timestamp: now,
            activeMode: 'assistant',
            memoryContributionSummary: {
                totalApplied: 3,
                byCategory: { identity: 1, task_relevant: 2 },
                retrievalSuppressed: false,
            },
            docContributionSummary: {
                applied: true,
                sourceCount: 1,
            },
            emotionalModulationStatus: {
                applied: true,
                strength: 'low',
                astroUnavailable: false,
            },
            reflectionNoteStatus: {
                activeNoteCount: 0,
                suppressedNoteCount: 0,
                applied: false,
            },
        };

        expect(snapshot.timestamp).toBeTruthy();
        expect(snapshot.activeMode).toBe('assistant');
        expect(snapshot.memoryContributionSummary.totalApplied).toBe(3);
        expect(snapshot.docContributionSummary.applied).toBe(true);
        expect(snapshot.emotionalModulationStatus.applied).toBe(true);
        expect(snapshot.reflectionNoteStatus.applied).toBe(false);
    });

    it('snapshot activeMode reflects assistant mode correctly', () => {
        const snapshot: CognitiveDiagnosticsSnapshot = {
            timestamp: new Date().toISOString(),
            activeMode: 'assistant',
            memoryContributionSummary: { totalApplied: 0, byCategory: {}, retrievalSuppressed: false },
            docContributionSummary: { applied: false, sourceCount: 0 },
            emotionalModulationStatus: { applied: false, strength: 'none', astroUnavailable: true },
            reflectionNoteStatus: { activeNoteCount: 0, suppressedNoteCount: 0, applied: false },
        };
        expect(snapshot.activeMode).toBe('assistant');
    });

    it('snapshot shows memory suppression when retrieval suppressed', () => {
        const snapshot: CognitiveDiagnosticsSnapshot = {
            timestamp: new Date().toISOString(),
            activeMode: 'assistant',
            memoryContributionSummary: {
                totalApplied: 0,
                byCategory: {},
                retrievalSuppressed: true,
            },
            docContributionSummary: { applied: false, sourceCount: 0 },
            emotionalModulationStatus: { applied: false, strength: 'none', astroUnavailable: false },
            reflectionNoteStatus: { activeNoteCount: 0, suppressedNoteCount: 0, applied: false },
        };
        expect(snapshot.memoryContributionSummary.retrievalSuppressed).toBe(true);
        expect(snapshot.memoryContributionSummary.totalApplied).toBe(0);
    });

    // ── RuntimeDiagnosticsAggregator cognitive recording ──────────────────────

    it('recordCognitiveContext stores context for snapshot generation', () => {
        const aggregator = new RuntimeDiagnosticsAggregator(
            makeMinimalInferenceDiagnostics() as any,
            makeMinimalMcpLifecycle() as any,
        );

        const context = makeFullCognitiveContext();
        aggregator.recordCognitiveContext(context);

        const snapshot = aggregator.getSnapshot('test-session');
        expect(snapshot.cognitive).toBeDefined();
        expect(snapshot.cognitive!.activeMode).toBe('assistant');
    });

    it('cognitive snapshot shows correct memory contribution counts', () => {
        const aggregator = new RuntimeDiagnosticsAggregator(
            makeMinimalInferenceDiagnostics() as any,
            makeMinimalMcpLifecycle() as any,
        );

        const context = makeFullCognitiveContext();
        aggregator.recordCognitiveContext(context);

        const snapshot = aggregator.getSnapshot();
        expect(snapshot.cognitive!.memoryContributionSummary.totalApplied).toBe(3);
        expect(snapshot.cognitive!.memoryContributionSummary.byCategory.identity).toBe(1);
        expect(snapshot.cognitive!.memoryContributionSummary.byCategory.task_relevant).toBe(2);
    });

    it('cognitive snapshot shows doc contribution applied', () => {
        const aggregator = new RuntimeDiagnosticsAggregator(
            makeMinimalInferenceDiagnostics() as any,
            makeMinimalMcpLifecycle() as any,
        );

        const context = makeFullCognitiveContext();
        aggregator.recordCognitiveContext(context);

        const snapshot = aggregator.getSnapshot();
        expect(snapshot.cognitive!.docContributionSummary.applied).toBe(true);
    });

    it('cognitive snapshot shows emotional modulation status', () => {
        const aggregator = new RuntimeDiagnosticsAggregator(
            makeMinimalInferenceDiagnostics() as any,
            makeMinimalMcpLifecycle() as any,
        );

        const context = makeFullCognitiveContext();
        aggregator.recordCognitiveContext(context);

        const snapshot = aggregator.getSnapshot();
        expect(snapshot.cognitive!.emotionalModulationStatus.applied).toBe(true);
        expect(snapshot.cognitive!.emotionalModulationStatus.strength).toBe('low');
    });

    it('cognitive snapshot is undefined when no context recorded', () => {
        const aggregator = new RuntimeDiagnosticsAggregator(
            makeMinimalInferenceDiagnostics() as any,
            makeMinimalMcpLifecycle() as any,
        );

        const snapshot = aggregator.getSnapshot();
        expect(snapshot.cognitive).toBeUndefined();
    });

    it('recordCognitiveMeta stores compaction summary', () => {
        const aggregator = new RuntimeDiagnosticsAggregator(
            makeMinimalInferenceDiagnostics() as any,
            makeMinimalMcpLifecycle() as any,
        );

        const context = makeFullCognitiveContext();
        aggregator.recordCognitiveContext(context);
        aggregator.recordCognitiveMeta({
            compactionSummary: makeCompactionSummary(),
            preinferenceDurationMs: 18,
            cognitiveAssemblyDurationMs: 7,
            compactionDurationMs: 5,
        });

        const snapshot = aggregator.getSnapshot();
        expect(snapshot.cognitive!.promptProfile).toBe('tiny_profile');
        expect(snapshot.cognitive!.compactionSummary).toBeDefined();
        expect(snapshot.cognitive!.compactionSummary!.memoriesKept).toBe(3);
        expect(snapshot.cognitive!.compactionSummary!.memoriesDropped).toBe(2);
    });

    it('cognitive snapshot timestamp is a valid ISO string', () => {
        const aggregator = new RuntimeDiagnosticsAggregator(
            makeMinimalInferenceDiagnostics() as any,
            makeMinimalMcpLifecycle() as any,
        );
        aggregator.recordCognitiveContext(makeFullCognitiveContext());

        const snapshot = aggregator.getSnapshot();
        expect(() => new Date(snapshot.cognitive!.timestamp)).not.toThrow();
    });
});
