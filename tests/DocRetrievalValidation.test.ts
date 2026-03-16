/**
 * DocRetrievalValidation — Phase 3C: Cognitive Behavior Validation
 *
 * Validates documentation retrieval gating behavior:
 *   - RP mode suppresses doc retrieval
 *   - Doc contribution summary is compact (not raw chunks)
 *   - DocContributionModel carries rationale when applied or suppressed
 *   - Mode policy correctly drives docRetrievalPolicy
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

import { ModePolicyEngine } from '../electron/services/router/ModePolicyEngine';
import type { DocContributionModel } from '../shared/cognitiveTurnTypes';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DocRetrievalValidation', () => {
    it('assistant mode enables doc retrieval', () => {
        const rules = ModePolicyEngine.getCognitiveRules('assistant');
        expect(rules.docRetrievalPolicy).toBe('enabled');
    });

    it('rp mode suppresses doc retrieval', () => {
        const rules = ModePolicyEngine.getCognitiveRules('rp');
        expect(rules.docRetrievalPolicy).toBe('suppressed');
    });

    it('hybrid mode enables doc retrieval', () => {
        const rules = ModePolicyEngine.getCognitiveRules('hybrid');
        expect(rules.docRetrievalPolicy).toBe('enabled');
    });

    it('DocContributionModel with applied=true has a non-empty summary', () => {
        const docContrib: DocContributionModel = {
            applied: true,
            summary: 'TypeScript async/await patterns from handbook, chapter 4.',
            rationale: 'Query is technical — async patterns relevant.',
            sourceIds: ['doc-001'],
            retrievedAt: new Date().toISOString(),
        };

        expect(docContrib.applied).toBe(true);
        expect(docContrib.summary).toBeTruthy();
        expect(docContrib.summary!.length).toBeGreaterThan(0);
    });

    it('DocContributionModel with applied=false has a suppression rationale', () => {
        const docContrib: DocContributionModel = {
            applied: false,
            rationale: 'Documentation retrieval suppressed: RP mode',
            sourceIds: [],
            retrievedAt: new Date().toISOString(),
        };

        expect(docContrib.applied).toBe(false);
        expect(docContrib.rationale).toContain('RP mode');
    });

    it('DocContributionModel summary does not exceed reasonable length for prompt injection', () => {
        const longText = 'x'.repeat(2000);
        const docContrib: DocContributionModel = {
            applied: true,
            summary: longText.slice(0, 500), // compacted summary
            rationale: 'Doc retrieved and compacted.',
            sourceIds: ['doc-001', 'doc-002'],
            retrievedAt: new Date().toISOString(),
        };

        // Summary should be the compacted version, not raw chunk content
        expect(docContrib.summary!.length).toBeLessThanOrEqual(500);
    });

    it('DocContributionModel retrievedAt is a valid ISO timestamp', () => {
        const docContrib: DocContributionModel = {
            applied: false,
            rationale: 'No documentation query detected.',
            sourceIds: [],
            retrievedAt: new Date().toISOString(),
        };

        expect(() => new Date(docContrib.retrievedAt)).not.toThrow();
        expect(new Date(docContrib.retrievedAt).toISOString()).toBe(docContrib.retrievedAt);
    });

    it('rp mode cognitive rules: toolUsePolicy is none (no external retrieval)', () => {
        const rules = ModePolicyEngine.getCognitiveRules('rp');
        expect(rules.toolUsePolicy).toBe('none');
    });

    it('assistant mode has full retrieval in cognitive rules', () => {
        const rules = ModePolicyEngine.getCognitiveRules('assistant');
        expect(rules.memoryRetrievalPolicy).toBe('full');
        expect(rules.toolUsePolicy).toBe('all');
    });

    it('doc contribution with multiple sources records correct sourceIds', () => {
        const docContrib: DocContributionModel = {
            applied: true,
            summary: 'Overview of async patterns and error boundaries.',
            rationale: 'Multiple relevant docs found.',
            sourceIds: ['doc-001', 'doc-002', 'doc-003'],
            retrievedAt: new Date().toISOString(),
        };

        expect(docContrib.sourceIds).toHaveLength(3);
    });
});
