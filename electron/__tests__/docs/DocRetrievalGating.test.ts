/**
 * Documentation Retrieval Gating Tests — Phase 2 Objective 7
 *
 * Validates:
 * - Gating policy: retrieval is suppressed for non-relevant queries
 * - Gating policy: retrieval proceeds for architecture/design/docs queries
 * - Structured citation model with source attribution
 * - suppressReason is set when gated
 * - gatingRuleMatched is populated on allowed queries
 * - Telemetry events emitted correctly (retrieved vs suppressed)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock telemetry before importing the service under test
const emittedEvents: Array<{ eventType: string; status?: string }> = [];

vi.mock('../../services/TelemetryService', () => ({
    telemetry: {
        emit: vi.fn(),
        operational: vi.fn((_sub: string, eventType: string, _sev: string, _actor: string, _summary: string, status: string) => {
            emittedEvents.push({ eventType, status });
            return {};
        }),
        audit: vi.fn((_sub: string, eventType: string, _actor: string, _summary: string, status: string) => {
            emittedEvents.push({ eventType, status });
            return {};
        }),
        debug: vi.fn((_sub: string, eventType: string) => {
            emittedEvents.push({ eventType, status: 'debug' });
            return {};
        }),
    },
}));

import { DocumentationIntelligenceService, DocRetrievalResult } from '../../services/DocumentationIntelligenceService';

// ─── Helpers: build a DocumentationIntelligenceService with injected retriever ─

/**
 * Build a service instance with a controlled mock retriever.
 * We directly inject the retriever to avoid filesystem operations.
 */
function makeServiceWithRetriever(
    searchResults: Array<{
        chunk: { filePath: string; heading: string; content: string };
        metadata: object;
        score: number;
    }>
): DocumentationIntelligenceService {
    const svc = new DocumentationIntelligenceService('/tmp/nonexistent');

    // Inject a fake retriever
    (svc as unknown as { retriever: { search: ReturnType<typeof vi.fn> } }).retriever = {
        search: vi.fn(() => [...searchResults]),
    };

    return svc;
}

function seedResults(count: number): ReturnType<typeof Array>[number][] {
    const results = [];
    for (let i = 0; i < count; i++) {
        results.push({
            chunk: {
                filePath: `docs/subsystems/service-${i}.md`,
                heading: `Section ${i}`,
                content: `Content for section ${i}`,
            },
            metadata: { authority: 1.0, priority: 'high' },
            score: 0.9 - i * 0.1,
        });
    }
    return results;
}

// ─── Gating policy tests ──────────────────────────────────────────────────────

describe('DocumentationIntelligenceService — gating policy', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('allows retrieval for architecture-related queries', () => {
        const svc = makeServiceWithRetriever([]);
        const { allowed, ruleLabel } = svc.evaluateGating('how does the architecture work?');

        expect(allowed).toBe(true);
        expect(ruleLabel).toMatch(/keyword:/);
    });

    it('allows retrieval for documentation queries', () => {
        const svc = makeServiceWithRetriever([]);
        const { allowed } = svc.evaluateGating('show me the docs for the memory service');
        expect(allowed).toBe(true);
    });

    it('allows retrieval for interface/spec queries', () => {
        const svc = makeServiceWithRetriever([]);
        expect(svc.evaluateGating('what is the interface for MCP?').allowed).toBe(true);
        expect(svc.evaluateGating('explain the inference engine').allowed).toBe(true);
        expect(svc.evaluateGating('what security policy applies?').allowed).toBe(true);
    });

    it('suppresses retrieval for casual/greeting queries', () => {
        const svc = makeServiceWithRetriever([]);
        expect(svc.evaluateGating('hello there').allowed).toBe(false);
        expect(svc.evaluateGating('what time is it?').allowed).toBe(false);
        expect(svc.evaluateGating('tell me a joke').allowed).toBe(false);
    });

    it('suppresses retrieval for short simple queries', () => {
        const svc = makeServiceWithRetriever([]);
        expect(svc.evaluateGating('hi').allowed).toBe(false);
        expect(svc.evaluateGating('ok').allowed).toBe(false);
    });
});

// ─── queryWithGating tests ────────────────────────────────────────────────────

describe('DocumentationIntelligenceService — queryWithGating', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('returns retrieved=false for non-relevant query', () => {
        const svc = makeServiceWithRetriever([]);
        const result = svc.queryWithGating('hello world', 'turn-1', 'assistant');

        expect(result.retrieved).toBe(false);
        expect(result.suppressReason).toBe('gating_policy');
        expect(result.citations).toHaveLength(0);
        expect(result.promptContext).toBe('');
    });

    it('returns retrieved=true and citations for relevant query', () => {
        const svc = makeServiceWithRetriever(seedResults(2));
        const result = svc.queryWithGating(
            'explain the architecture of the memory service',
            'turn-1',
            'assistant'
        );

        expect(result.retrieved).toBe(true);
        expect(result.citations).toHaveLength(2);
        expect(result.citations[0].sourcePath).toBeDefined();
        expect(result.citations[0].heading).toBeDefined();
        expect(result.citations[0].score).toBeGreaterThan(0);
        expect(result.citations[0].content).toBeDefined();
    });

    it('returns retrieved=false with no_results when retriever returns empty', () => {
        const svc = makeServiceWithRetriever([]);
        const result = svc.queryWithGating(
            'explain the architecture',
            'turn-1',
            'assistant'
        );

        expect(result.retrieved).toBe(false);
        expect(result.suppressReason).toBe('no_results');
    });

    it('preserves source attribution in citations', () => {
        const svc = makeServiceWithRetriever(seedResults(3));
        const result = svc.queryWithGating('describe the interface contract', 'turn-1', 'assistant');

        expect(result.citations[0].sourcePath).toContain('docs/subsystems/service-0.md');
        expect(result.citations[0].heading).toBe('Section 0');
    });

    it('returns gatingRuleMatched when retrieval succeeds', () => {
        const svc = makeServiceWithRetriever(seedResults(1));
        const result = svc.queryWithGating('explain the architecture', 'turn-1', 'assistant');
        expect(result.gatingRuleMatched).toMatch(/keyword:/);
    });

    it('builds a prompt context block from citations', () => {
        const svc = makeServiceWithRetriever(seedResults(2));
        const result = svc.queryWithGating('explain the architecture', 'turn-1', 'assistant');

        expect(result.promptContext).toContain('[PROJECT DOCUMENTATION CONTEXT]');
        expect(result.promptContext).toContain('[DOCUMENTATION:');
    });

    it('includes durationMs in result', () => {
        const svc = makeServiceWithRetriever(seedResults(1));
        const result = svc.queryWithGating('explain the architecture', 'turn-1', 'assistant');
        expect(typeof result.durationMs).toBe('number');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('emits doc_retrieval_completed telemetry on success', () => {
        const svc = makeServiceWithRetriever(seedResults(2));
        svc.queryWithGating('explain the architecture', 'turn-1', 'assistant');

        const completedEvents = emittedEvents.filter(e => e.eventType === 'doc_retrieval_completed');
        expect(completedEvents.length).toBeGreaterThan(0);
        expect(completedEvents[0].status).toBe('success');
    });

    it('emits doc_retrieval_suppressed telemetry on gating', () => {
        const svc = makeServiceWithRetriever([]);
        svc.queryWithGating('hello world', 'turn-1', 'assistant');

        const suppressedEvents = emittedEvents.filter(e => e.eventType === 'doc_retrieval_suppressed');
        expect(suppressedEvents.length).toBeGreaterThan(0);
    });
});

// ─── Legacy getRelevantContext compatibility ──────────────────────────────────

describe('DocumentationIntelligenceService — getRelevantContext (legacy)', () => {
    it('still returns prompt context string for backward compatibility', () => {
        const svc = makeServiceWithRetriever(seedResults(2));
        const context = svc.getRelevantContext('architecture docs');

        expect(typeof context).toBe('string');
        expect(context).toContain('[PROJECT DOCUMENTATION CONTEXT]');
    });

    it('returns empty string when no results', () => {
        const svc = makeServiceWithRetriever([]);
        const context = svc.getRelevantContext('architecture docs');
        expect(context).toBe('');
    });
});
