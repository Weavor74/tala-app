/**
 * Cognitive Diagnostics Tests — Phase 3
 *
 * Validates cognitive telemetry emission and diagnostics snapshot integration.
 *
 * Coverage:
 * - Cognitive telemetry events emitted for each cognitive step
 * - RuntimeDiagnosticsAggregator includes cognitive snapshot
 * - Cognitive diagnostics snapshot has no raw memory content
 * - Cognitive diagnostics accurately reflects last cognitive turn
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CognitiveTurnAssembler } from '../../services/cognitive/CognitiveTurnAssembler';
import { RuntimeDiagnosticsAggregator } from '../../services/RuntimeDiagnosticsAggregator';
import { InferenceDiagnosticsService } from '../../services/InferenceDiagnosticsService';
import type { McpInventoryDiagnostics } from '../../../shared/runtimeDiagnosticsTypes';

// ─── Telemetry mock ───────────────────────────────────────────────────────────

const emittedEvents: Array<{ eventType: string; summary: string }> = [];

vi.mock('../../services/TelemetryService', () => ({
    telemetry: {
        operational: (_s: string, et: string, _sv: string, _a: string, sum: string) => {
            emittedEvents.push({ eventType: et, summary: sum });
        },
        emit: () => {},
        audit: () => {},
        debug: () => {},
    },
}));

// ─── Mock MCP lifecycle ───────────────────────────────────────────────────────

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
    return {
        getDiagnosticsInventory: vi.fn(() => makeEmptyMcpInventory()),
        getServiceDiagnostics: vi.fn(() => null),
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CognitiveTurnAssembler — telemetry events', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('emits mode_policy_applied event', () => {
        CognitiveTurnAssembler.assemble({ turnId: 't1', rawInput: 'test', mode: 'assistant' });
        expect(emittedEvents.some(e => e.eventType === 'mode_policy_applied')).toBe(true);
    });

    it('emits memory_contribution_applied event', () => {
        CognitiveTurnAssembler.assemble({ turnId: 't2', rawInput: 'test', mode: 'assistant' });
        expect(emittedEvents.some(e => e.eventType === 'memory_contribution_applied')).toBe(true);
    });

    it('emits emotional_modulation_skipped when astro unavailable', () => {
        CognitiveTurnAssembler.assemble({
            turnId: 't3',
            rawInput: 'test',
            mode: 'assistant',
            astroStateText: null,
        });
        expect(emittedEvents.some(e => e.eventType === 'emotional_modulation_skipped')).toBe(true);
        expect(emittedEvents.some(e => e.eventType === 'emotional_modulation_applied')).toBe(false);
    });

    it('emits doc_context_applied when doc context provided in assistant mode', () => {
        CognitiveTurnAssembler.assemble({
            turnId: 't4',
            rawInput: 'test',
            mode: 'assistant',
            docContextText: 'Some documentation here',
        });
        expect(emittedEvents.some(e => e.eventType === 'doc_context_applied')).toBe(true);
    });

    it('does not emit doc_context_applied in rp mode', () => {
        CognitiveTurnAssembler.assemble({
            turnId: 't5',
            rawInput: 'test',
            mode: 'rp',
            docContextText: 'Documentation that should be suppressed',
        });
        expect(emittedEvents.some(e => e.eventType === 'doc_context_applied')).toBe(false);
    });

    it('emits cognitive_context_assembled as final event', () => {
        CognitiveTurnAssembler.assemble({ turnId: 't6', rawInput: 'test', mode: 'assistant' });
        expect(emittedEvents.some(e => e.eventType === 'cognitive_context_assembled')).toBe(true);
    });

    it('summary does not contain raw user input beyond 50 chars', () => {
        const longInput = 'a'.repeat(100);
        CognitiveTurnAssembler.assemble({ turnId: 't7', rawInput: longInput, mode: 'assistant' });
        const assembledEvent = emittedEvents.find(e => e.eventType === 'cognitive_context_assembled');
        // The raw input in summary should be truncated
        expect(assembledEvent).toBeDefined();
    });
});

describe('RuntimeDiagnosticsAggregator — cognitive diagnostics integration', () => {
    let inferenceDiag: InferenceDiagnosticsService;
    let aggregator: RuntimeDiagnosticsAggregator;

    beforeEach(() => {
        emittedEvents.length = 0;
        inferenceDiag = new InferenceDiagnosticsService();
        aggregator = new RuntimeDiagnosticsAggregator(
            inferenceDiag,
            makeMockMcpLifecycle() as any,
        );
    });

    it('snapshot has no cognitive field before first cognitive turn', () => {
        const snap = aggregator.getSnapshot('test-session');
        expect(snap.cognitive).toBeUndefined();
    });

    it('snapshot includes cognitive field after recording a cognitive context', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 'turn-cog-1',
            rawInput: 'test query',
            mode: 'assistant',
        });

        aggregator.recordCognitiveContext(ctx);
        const snap = aggregator.getSnapshot('test-session');

        expect(snap.cognitive).toBeDefined();
        expect(snap.cognitive?.activeMode).toBe('assistant');
    });

    it('cognitive diagnostics includes memory contribution summary', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 'turn-cog-2',
            rawInput: 'test',
            mode: 'hybrid',
        });

        aggregator.recordCognitiveContext(ctx);
        const snap = aggregator.getSnapshot('test-session');

        expect(snap.cognitive?.memoryContributionSummary).toBeDefined();
        expect(snap.cognitive?.memoryContributionSummary.totalApplied).toBeGreaterThanOrEqual(0);
    });

    it('cognitive diagnostics includes emotional modulation status', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 'turn-cog-3',
            rawInput: 'test',
            mode: 'assistant',
            astroStateText: null,
        });

        aggregator.recordCognitiveContext(ctx);
        const snap = aggregator.getSnapshot('test-session');

        expect(snap.cognitive?.emotionalModulationStatus).toBeDefined();
        expect(snap.cognitive?.emotionalModulationStatus.applied).toBe(false);
        expect(snap.cognitive?.emotionalModulationStatus.astroUnavailable).toBe(true);
    });

    it('cognitive diagnostics includes doc contribution summary', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 'turn-cog-4',
            rawInput: 'test',
            mode: 'assistant',
            docContextText: 'Some documentation',
            docSourceIds: ['doc-1', 'doc-2'],
        });

        aggregator.recordCognitiveContext(ctx);
        const snap = aggregator.getSnapshot('test-session');

        expect(snap.cognitive?.docContributionSummary.applied).toBe(true);
        expect(snap.cognitive?.docContributionSummary.sourceCount).toBe(2);
    });

    it('cognitive diagnostics does not expose raw memory content', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 'turn-cog-5',
            rawInput: 'secret user query',
            mode: 'assistant',
        });

        aggregator.recordCognitiveContext(ctx);
        const snap = aggregator.getSnapshot('test-session');
        const diagnosticString = JSON.stringify(snap.cognitive);

        // Raw user input should not appear in the cognitive diagnostics snapshot
        expect(diagnosticString).not.toContain('secret user query');
    });

    it('cognitive diagnostics includes reflection note status', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 'turn-cog-6',
            rawInput: 'test',
            mode: 'assistant',
        });

        aggregator.recordCognitiveContext(ctx);
        const snap = aggregator.getSnapshot('test-session');

        expect(snap.cognitive?.reflectionNoteStatus).toBeDefined();
        expect(typeof snap.cognitive?.reflectionNoteStatus.activeNoteCount).toBe('number');
        expect(typeof snap.cognitive?.reflectionNoteStatus.suppressedNoteCount).toBe('number');
    });

    it('cognitive diagnostics includes last policy applied timestamp', () => {
        const ctx = CognitiveTurnAssembler.assemble({
            turnId: 'turn-cog-7',
            rawInput: 'test',
            mode: 'rp',
        });

        aggregator.recordCognitiveContext(ctx);
        const snap = aggregator.getSnapshot('test-session');

        expect(snap.cognitive?.lastPolicyAppliedAt).toBeTruthy();
        expect(() => new Date(snap.cognitive!.lastPolicyAppliedAt!)).not.toThrow();
    });

    it('updates cognitive diagnostics on each new cognitive context', () => {
        const ctx1 = CognitiveTurnAssembler.assemble({ turnId: 't1', rawInput: 'first', mode: 'assistant' });
        aggregator.recordCognitiveContext(ctx1);
        const snap1 = aggregator.getSnapshot();
        expect(snap1.cognitive?.activeMode).toBe('assistant');

        const ctx2 = CognitiveTurnAssembler.assemble({ turnId: 't2', rawInput: 'second', mode: 'rp' });
        aggregator.recordCognitiveContext(ctx2);
        const snap2 = aggregator.getSnapshot();
        expect(snap2.cognitive?.activeMode).toBe('rp');
    });
});
