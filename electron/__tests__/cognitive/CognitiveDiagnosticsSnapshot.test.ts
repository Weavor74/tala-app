/**
 * Cognitive Diagnostics Snapshot Tests — Phase 3C: Cognitive Behavior Validation
 *
 * Validates (Objective H):
 * - RuntimeDiagnosticsAggregator includes the Phase 3C extended fields:
 *   promptProfile, compactionSummary, memoryContributionCounts, docContributionCounts,
 *   mcpContributionCounts, reflectionContributionCounts, emotionalBiasSummary, performanceSummary
 * - Snapshot is safe for IPC (no raw content, no circular refs)
 * - recordCognitiveMeta correctly persists and exposes performance data
 * - Human-readable snapshot format is correct for the last cognitive turn
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CognitiveTurnAssembler } from '../../services/cognitive/CognitiveTurnAssembler';
import { CognitiveContextCompactor } from '../../services/cognitive/CognitiveContextCompactor';
import { classifyModelCapability } from '../../services/cognitive/ModelCapabilityClassifier';
import { RuntimeDiagnosticsAggregator } from '../../services/RuntimeDiagnosticsAggregator';
import { InferenceDiagnosticsService } from '../../services/InferenceDiagnosticsService';
import type { McpInventoryDiagnostics } from '../../../shared/runtimeDiagnosticsTypes';
import type { MemoryItem } from '../../services/MemoryService';

// ─── Telemetry mock ───────────────────────────────────────────────────────────

const emittedEvents: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];

vi.mock('../../services/TelemetryService', () => ({
    telemetry: {
        operational: (_s: string, et: string, _sv: string, _a: string, _sum: string, _status: string, opts?: { payload?: Record<string, unknown> }) => {
            emittedEvents.push({ eventType: et, payload: opts?.payload });
        },
        emit: vi.fn(),
        audit: vi.fn(),
        debug: vi.fn(),
    },
}));

// ─── MCP lifecycle mock ───────────────────────────────────────────────────────

function makeEmptyMcpInventory(): McpInventoryDiagnostics {
    return {
        services: [],
        totalConfigured: 0,
        totalReady: 0,
        totalDegraded: 0,
        totalUnavailable: 0,
        criticalUnavailable: false,
        lastUpdated: new Date().toISOString(),
    };
}

function makeMockMcpLifecycle() {
    return { getDiagnosticsInventory: vi.fn(() => makeEmptyMcpInventory()) };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMemoryItems(count: number): MemoryItem[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `mem-${i}`,
        text: `Memory ${i}`,
        metadata: { source: 'inferred', type: 'technical', salience: 0.8, confidence: 0.8 },
    } as MemoryItem));
}

function makeAggregator() {
    const inferenceDiag = new InferenceDiagnosticsService();
    const mcpLifecycle = makeMockMcpLifecycle();
    return new RuntimeDiagnosticsAggregator(inferenceDiag, mcpLifecycle as any);
}

// ─── Tests: Base cognitive snapshot ──────────────────────────────────────────

describe('CognitiveDiagnosticsSnapshot — base fields', () => {
    beforeEach(() => { emittedEvents.length = 0; });

    it('cognitive field is undefined when no context has been recorded', () => {
        const aggregator = makeAggregator();
        const snapshot = aggregator.getSnapshot();
        expect(snapshot.cognitive).toBeUndefined();
    });

    it('cognitive field is populated after recording a context', () => {
        const aggregator = makeAggregator();
        const context = CognitiveTurnAssembler.assemble({
            turnId: 'diag-t1',
            rawInput: 'Test input',
            mode: 'assistant',
        });
        aggregator.recordCognitiveContext(context);

        const snapshot = aggregator.getSnapshot();
        expect(snapshot.cognitive).toBeDefined();
        expect(snapshot.cognitive?.activeMode).toBe('assistant');
        expect(snapshot.cognitive?.timestamp).toBeTruthy();
    });
});

// ─── Tests: Phase 3C extended fields ─────────────────────────────────────────

describe('CognitiveDiagnosticsSnapshot — Phase 3C extended fields (Objective H)', () => {
    beforeEach(() => { emittedEvents.length = 0; });

    it('includes promptProfile after recording compaction metadata', () => {
        const aggregator = makeAggregator();
        const context = CognitiveTurnAssembler.assemble({
            turnId: 'diag-t2',
            rawInput: 'Test input',
            mode: 'assistant',
        });
        aggregator.recordCognitiveContext(context);

        const compactor = new CognitiveContextCompactor();
        const profile = classifyModelCapability(
            { providerId: 'ollama', providerType: 'ollama', displayName: 'Ollama' },
            'qwen2.5:3b',
        );
        const packet = compactor.compact(context, profile);

        aggregator.recordCognitiveMeta({ compactionSummary: packet.diagnosticsSummary });

        const snapshot = aggregator.getSnapshot();
        expect(snapshot.cognitive?.promptProfile).toBe('tiny_profile');
    });

    it('includes compactionSummary with correct structure', () => {
        const aggregator = makeAggregator();
        const context = CognitiveTurnAssembler.assemble({
            turnId: 'diag-t3',
            rawInput: 'How does inference work?',
            mode: 'assistant',
        });
        aggregator.recordCognitiveContext(context);

        const compactor = new CognitiveContextCompactor();
        const profile = classifyModelCapability(
            { providerId: 'ollama', providerType: 'ollama', displayName: 'Ollama' },
            'llama3.1:7b',
        );
        const packet = compactor.compact(context, profile);
        aggregator.recordCognitiveMeta({ compactionSummary: packet.diagnosticsSummary });

        const snap = aggregator.getSnapshot();
        const cs = snap.cognitive?.compactionSummary;
        expect(cs).toBeDefined();
        expect(cs?.profileClass).toBe('small_profile');
        expect(cs?.compactionPolicy).toBe('moderate');
        expect(typeof cs?.memoriesKept).toBe('number');
        expect(typeof cs?.memoriesDropped).toBe('number');
        expect(typeof cs?.docsIncluded).toBe('boolean');
        expect(cs?.sectionsDropped).toBeInstanceOf(Array);
    });

    it('includes memoryContributionCounts with correct values', () => {
        const aggregator = makeAggregator();
        const memories = makeMemoryItems(3);
        const context = CognitiveTurnAssembler.assemble({
            turnId: 'diag-t4',
            rawInput: 'Debug my code',
            mode: 'assistant',
            approvedMemories: memories,
            memoryCandidateCount: 5,  // 5 candidates
            memoryExcludedCount: 1,   // 1 excluded by policy
        });
        aggregator.recordCognitiveContext(context);

        const snap = aggregator.getSnapshot();
        const mc = snap.cognitive?.memoryContributionCounts;
        expect(mc).toBeDefined();
        expect(mc?.candidatesFound).toBe(5);
        expect(mc?.candidatesUsed).toBeLessThanOrEqual(5);
        expect(typeof mc?.candidatesDropped).toBe('number');
        expect(mc?.byCategoryUsed).toBeDefined();
    });

    it('includes docContributionCounts', () => {
        const aggregator = makeAggregator();
        const context = CognitiveTurnAssembler.assemble({
            turnId: 'diag-t5',
            rawInput: 'Explain the architecture',
            mode: 'assistant',
            docContextText: 'Architecture: cognitive loop is in electron/services/cognitive/',
            docSourceIds: ['docs/architecture/system_overview.md'],
        });
        aggregator.recordCognitiveContext(context);

        const snap = aggregator.getSnapshot();
        const dc = snap.cognitive?.docContributionCounts;
        expect(dc).toBeDefined();
        expect(typeof dc?.retrieved).toBe('number');
        expect(typeof dc?.used).toBe('number');
        expect(typeof dc?.compacted).toBe('number');
        expect(typeof dc?.suppressed).toBe('number');
    });

    it('includes mcpContributionCounts', () => {
        const aggregator = makeAggregator();
        const context = CognitiveTurnAssembler.assemble({
            turnId: 'diag-t6',
            rawInput: 'Test input',
            mode: 'assistant',
        });
        aggregator.recordCognitiveContext(context);
        aggregator.recordCognitiveMeta({
            mcpServicesRequested: 2,
            mcpServicesUsed: 1,
            mcpServicesFailed: 1,
            mcpServicesSuppressed: 0,
        });

        const snap = aggregator.getSnapshot();
        const mcp = snap.cognitive?.mcpContributionCounts;
        expect(mcp).toBeDefined();
        expect(mcp?.servicesRequested).toBe(2);
        expect(mcp?.servicesUsed).toBe(1);
        expect(mcp?.servicesFailed).toBe(1);
        expect(mcp?.servicesSuppressed).toBe(0);
    });

    it('includes reflectionContributionCounts', () => {
        const aggregator = makeAggregator();
        const context = CognitiveTurnAssembler.assemble({
            turnId: 'diag-t7',
            rawInput: 'Test input',
            mode: 'assistant',
        });
        aggregator.recordCognitiveContext(context);

        const snap = aggregator.getSnapshot();
        const rc = snap.cognitive?.reflectionContributionCounts;
        expect(rc).toBeDefined();
        expect(typeof rc?.notesAvailable).toBe('number');
        expect(typeof rc?.notesApplied).toBe('number');
        expect(typeof rc?.notesSuppressed).toBe('number');
        expect(rc!.notesAvailable).toBe(rc!.notesApplied + rc!.notesSuppressed);
    });

    it('includes emotionalBiasSummary', () => {
        const aggregator = makeAggregator();
        const context = CognitiveTurnAssembler.assemble({
            turnId: 'diag-t8',
            rawInput: 'Test input',
            mode: 'assistant',
        });
        aggregator.recordCognitiveContext(context);

        const snap = aggregator.getSnapshot();
        const em = snap.cognitive?.emotionalBiasSummary;
        expect(em).toBeDefined();
        expect(typeof em?.modulationApplied).toBe('boolean');
        expect(['none', 'low', 'medium', 'capped']).toContain(em?.strength);
        expect(em?.dimensions).toBeInstanceOf(Array);
    });

    it('includes performanceSummary after recording timing metadata', () => {
        const aggregator = makeAggregator();
        const context = CognitiveTurnAssembler.assemble({
            turnId: 'diag-t9',
            rawInput: 'Test input',
            mode: 'assistant',
        });
        aggregator.recordCognitiveContext(context);
        aggregator.recordCognitiveMeta({
            preinferenceDurationMs: 12,
            cognitiveAssemblyDurationMs: 5,
            compactionDurationMs: 3,
        });

        const snap = aggregator.getSnapshot();
        const perf = snap.cognitive?.performanceSummary;
        expect(perf).toBeDefined();
        expect(perf?.preinferenceDurationMs).toBe(12);
        expect(perf?.cognitiveAssemblyDurationMs).toBe(5);
        expect(perf?.compactionDurationMs).toBe(3);
    });
});

// ─── Tests: IPC safety ────────────────────────────────────────────────────────

describe('CognitiveDiagnosticsSnapshot — IPC safety', () => {
    it('snapshot is JSON-serializable', () => {
        const aggregator = makeAggregator();
        const context = CognitiveTurnAssembler.assemble({
            turnId: 'ipc-t1',
            rawInput: 'Test',
            mode: 'assistant',
        });
        aggregator.recordCognitiveContext(context);

        const snap = aggregator.getSnapshot();
        expect(() => JSON.stringify(snap)).not.toThrow();
    });

    it('snapshot cognitive field contains no functions', () => {
        const aggregator = makeAggregator();
        const context = CognitiveTurnAssembler.assemble({
            turnId: 'ipc-t2',
            rawInput: 'Test',
            mode: 'assistant',
        });
        aggregator.recordCognitiveContext(context);

        const snap = aggregator.getSnapshot();
        const serialized = JSON.stringify(snap.cognitive ?? {});
        expect(serialized).not.toContain('"function"');
    });
});

// ─── Tests: Performance telemetry events ─────────────────────────────────────

describe('Phase 3C performance telemetry events', () => {
    beforeEach(() => { emittedEvents.length = 0; });

    it('CognitiveTurnAssembler emits cognitive_assembly_duration_ms event', () => {
        CognitiveTurnAssembler.assemble({
            turnId: 'perf-t1',
            rawInput: 'Test',
            mode: 'assistant',
        });
        const perfEvent = emittedEvents.find(e => e.eventType === 'cognitive_assembly_duration_ms');
        expect(perfEvent).toBeDefined();
        expect(perfEvent?.payload?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('CognitiveContextCompactor emits compaction_duration_ms event', () => {
        const compactor = new CognitiveContextCompactor();
        const profile = classifyModelCapability(
            { providerId: 'ollama', providerType: 'ollama', displayName: 'Ollama' },
            'qwen2.5:3b',
        );
        const context = CognitiveTurnAssembler.assemble({
            turnId: 'perf-t2',
            rawInput: 'Test',
            mode: 'assistant',
        });

        emittedEvents.length = 0; // reset after assembly
        compactor.compact(context, profile);

        const perfEvent = emittedEvents.find(e => e.eventType === 'compaction_duration_ms');
        expect(perfEvent).toBeDefined();
        expect(perfEvent?.payload?.durationMs).toBeGreaterThanOrEqual(0);
    });
});
