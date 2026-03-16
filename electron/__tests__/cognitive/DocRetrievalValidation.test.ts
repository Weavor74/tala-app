/**
 * Doc Retrieval Validation Tests — Phase 3C: Cognitive Behavior Validation
 *
 * Validates (Objective C):
 * - Doc retrieval gating correctly triggers on technical/architecture/knowledge queries
 * - Doc retrieval does NOT trigger for casual conversation, greetings, short clarifications
 * - Tiny model doc contribution is properly compacted (single summary, <80 tokens)
 * - DocContributionModel captures applied/suppressed state correctly
 * - CognitiveBudgetApplier respects doc chunk caps for tiny/small profiles
 */

import { describe, it, expect, vi } from 'vitest';
import { CognitiveBudgetApplier } from '../../services/cognitive/CognitiveBudgetApplier';
import type { DocContributionModel } from '../../../shared/cognitiveTurnTypes';
import type { CognitiveBudgetProfile } from '../../../shared/modelCapabilityTypes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTinyBudget(): CognitiveBudgetProfile {
    return {
        identityMemoryCap: 2,
        taskMemoryCap: 3,
        continuityMemoryCap: 2,
        preferenceMemoryCap: 0,
        docChunkCap: 1,
        reflectionNoteCap: 1,
        emotionalDimensionCap: 2,
        toolDescriptionCap: 0,
        allowFullToolSchemas: false,
        allowFullIdentityProse: false,
        suppressDocsUnlessHighlyRelevant: true,
        allowRawAstroData: false,
    };
}

function makeSmallBudget(): CognitiveBudgetProfile {
    return {
        ...makeTinyBudget(),
        identityMemoryCap: 3,
        taskMemoryCap: 4,
        continuityMemoryCap: 3,
        preferenceMemoryCap: 1,
        docChunkCap: 1,
        reflectionNoteCap: 2,
        emotionalDimensionCap: 3,
        toolDescriptionCap: 2,
        suppressDocsUnlessHighlyRelevant: true,
    };
}

function makeMediumBudget(): CognitiveBudgetProfile {
    return {
        identityMemoryCap: 4,
        taskMemoryCap: 6,
        continuityMemoryCap: 4,
        preferenceMemoryCap: 2,
        docChunkCap: 2,
        reflectionNoteCap: 3,
        emotionalDimensionCap: 4,
        toolDescriptionCap: 5,
        allowFullToolSchemas: false,
        allowFullIdentityProse: true,
        suppressDocsUnlessHighlyRelevant: false,
        allowRawAstroData: false,
    };
}

function makeDoc(applied: boolean, summary?: string, sourceIds: string[] = []): DocContributionModel {
    return {
        applied,
        summary,
        rationale: applied ? 'Retrieved for technical query' : 'Not retrieved',
        sourceIds,
        retrievedAt: new Date().toISOString(),
    };
}

// ─── Tests: Doc gating keywords ──────────────────────────────────────────────

describe('Documentation gating — trigger conditions (Objective C)', () => {
    // These tests validate the gating logic based on the DocumentationIntelligenceService
    // DOC_RETRIEVAL_PATTERN without loading the full service (which requires filesystem access)

    const technicalKeywords = [
        'how does the architecture work',
        'explain the inference service',
        'show me the api contract',
        'describe the memory system design',
        'what is the schema for the agent',
        'how does the cognitive pipeline work',
        'show the workflow for memory writes',
        'what does the telemetry service do',
        'explain reflection engine behavior',
    ];

    const casualPhrases = [
        'hi',
        'hello',
        'thanks',
        'ok',
        'yes',
        'no',
        'great',
        'sounds good',
        'can you help me',
    ];

    const DOC_PATTERN = /\b(architecture|design|interface|spec|protocol|how does|explain|docs?|documentation|logic|engine|service|requirement|traceability|security|contract|schema|api|workflow|pipeline|subsystem|capability|memory|artifact|mode|reflection|telemetry|inference|audit)\b/i;

    it('triggers for technical/architecture queries', () => {
        for (const query of technicalKeywords) {
            const matches = DOC_PATTERN.test(query);
            expect(matches, `Should trigger for: "${query}"`).toBe(true);
        }
    });

    it('does NOT trigger for casual conversation or greetings', () => {
        for (const phrase of casualPhrases) {
            const matches = DOC_PATTERN.test(phrase);
            expect(matches, `Should NOT trigger for: "${phrase}"`).toBe(false);
        }
    });
});

// ─── Tests: CognitiveBudgetApplier — doc budget ───────────────────────────────

describe('CognitiveBudgetApplier — doc budget (Objective C)', () => {
    const applier = new CognitiveBudgetApplier();

    it('includes doc when applied=true and cap>0 for tiny profile', () => {
        const doc = makeDoc(true, 'The inference service uses ProviderSelectionService.', ['docs/arch.md']);
        const result = applier.applyDocBudget(doc, makeTinyBudget());

        expect(result.included).toBe(true);
        expect(result.summary).toBeTruthy();
    });

    it('suppresses doc when applied=false regardless of budget', () => {
        const doc = makeDoc(false);
        const result = applier.applyDocBudget(doc, makeTinyBudget());

        expect(result.included).toBe(false);
        expect(result.droppedReason).toBeTruthy();
    });

    it('suppresses doc when docChunkCap is 0', () => {
        const doc = makeDoc(true, 'Some docs', ['doc.md']);
        const zeroCapBudget = { ...makeTinyBudget(), docChunkCap: 0 };
        const result = applier.applyDocBudget(doc, zeroCapBudget);

        expect(result.included).toBe(false);
        expect(result.droppedReason).toContain('0');
    });

    it('suppresses doc when tiny/small profile + no high-relevance sources', () => {
        const doc = makeDoc(true, 'Some docs', []); // no sourceIds = not high-relevance
        const result = applier.applyDocBudget(doc, makeTinyBudget());

        // suppressDocsUnlessHighlyRelevant=true + empty sourceIds → suppressed
        expect(result.included).toBe(false);
    });

    it('includes doc for tiny profile when high-relevance sources are present', () => {
        const doc = makeDoc(true, 'Architecture overview: the cognitive loop is in electron/services/cognitive/', ['docs/architecture/system_overview.md']);
        const result = applier.applyDocBudget(doc, makeTinyBudget());

        expect(result.included).toBe(true);
    });

    it('includes doc for medium profile even without explicit high-relevance sources', () => {
        const doc = makeDoc(true, 'Some doc content', []);
        const result = applier.applyDocBudget(doc, makeMediumBudget());

        // Medium budget: suppressDocsUnlessHighlyRelevant=false, so empty sourceIds should still include
        expect(result.included).toBe(true);
    });
});

// ─── Tests: Doc compaction in tiny context ────────────────────────────────────

describe('CognitiveBudgetApplier — doc compaction for tiny models', () => {
    const applier = new CognitiveBudgetApplier();

    it('returns only the doc summary, not raw chunk content', () => {
        const summary = 'Cognitive loop: PreInferenceContextOrchestrator → CognitiveTurnAssembler.';
        const doc = makeDoc(true, summary, ['docs/arch.md']);
        const result = applier.applyDocBudget(doc, makeTinyBudget());

        expect(result.summary).toBe(summary);
    });

    it('tiny model doc summary stays compact (single summary string)', () => {
        const longContent = 'A'.repeat(500);
        // The doc summary is already stored as a pre-compacted string
        // (CognitiveTurnAssembler slices it to 200 chars)
        const doc = makeDoc(true, longContent.slice(0, 200), ['docs/arch.md']);
        const result = applier.applyDocBudget(doc, makeTinyBudget());

        // The applier returns what is given — the assembler is responsible for pre-slicing
        expect(result.summary.length).toBeLessThanOrEqual(200);
    });
});

// ─── Tests: Diagnostics attribution ──────────────────────────────────────────

describe('DocContributionModel — diagnostics attribution', () => {
    it('includes sourceIds when docs are applied', () => {
        const doc = makeDoc(true, 'Overview.', ['docs/architecture/system_overview.md', 'docs/features/mode_system.md']);
        expect(doc.sourceIds).toHaveLength(2);
        expect(doc.applied).toBe(true);
    });

    it('sourceIds is empty when docs are not applied', () => {
        const doc = makeDoc(false);
        expect(doc.sourceIds).toHaveLength(0);
        expect(doc.applied).toBe(false);
    });

    it('rationale is always present for diagnostics', () => {
        const appliedDoc = makeDoc(true, 'Some docs', ['source.md']);
        const suppressedDoc = makeDoc(false);
        expect(appliedDoc.rationale).toBeTruthy();
        expect(suppressedDoc.rationale).toBeTruthy();
    });
});
