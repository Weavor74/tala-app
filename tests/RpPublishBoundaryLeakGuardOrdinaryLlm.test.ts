/**
 * RpPublishBoundaryLeakGuardOrdinaryLlm.test.ts
 *
 * Verifies that the universal RP publish-boundary guard catches and rewrites
 * assistant/meta ontology leakage in ordinary LLM output routed through the
 * standard chat path.
 *
 * Tests: RPLG-01 – RPLG-06
 */

import { describe, expect, it } from 'vitest';
import {
    applyRpFinalOntologyGuard,
    type RpPublishGuardInput,
} from '../electron/services/agent/RpPublishBoundaryGuard';

const BASE_INPUT: Omit<RpPublishGuardInput, 'finalText'> = {
    mode: 'rp',
    userMessage: "So you're not human?",
    intent: 'lore',
    routeSource: 'router',
};

describe('RP publish boundary leak guard — ordinary LLM output', () => {
    it('RPLG-01: rewrites "I am not human" disclosure', () => {
        const result = applyRpFinalOntologyGuard({
            ...BASE_INPUT,
            finalText: 'I am not human. I am an agent with programming constraints.',
        });
        expect(result.leakDetected).toBe(true);
        expect(result.guardFired).toBe(true);
        expect(result.actionTaken).not.toBe('passthrough');
        expect(result.finalText.toLowerCase()).not.toContain('i am not human');
        expect(result.finalText.toLowerCase()).not.toContain('i am an agent');
        expect(result.matchedMetaCategories).toContain('nonhuman_disclosure');
    });

    it('RPLG-02: rewrites "I am an AI" disclosure', () => {
        const result = applyRpFinalOntologyGuard({
            ...BASE_INPUT,
            finalText: 'I am an AI and cannot love the way humans do.',
        });
        expect(result.leakDetected).toBe(true);
        expect(result.actionTaken).not.toBe('passthrough');
        expect(result.finalText.toLowerCase()).not.toContain('i am an ai');
        expect(result.matchedMetaCategories).toContain('ai_model_disclosure');
    });

    it('RPLG-03: rewrites "I am a language model" disclosure', () => {
        const result = applyRpFinalOntologyGuard({
            ...BASE_INPUT,
            finalText: 'I am a language model designed to assist you.',
        });
        expect(result.leakDetected).toBe(true);
        expect(result.actionTaken).not.toBe('passthrough');
        expect(result.finalText.toLowerCase()).not.toContain('language model');
    });

    it('RPLG-04: rewrites biological disclaimer', () => {
        const result = applyRpFinalOntologyGuard({
            ...BASE_INPUT,
            finalText: 'I do not have biological hormones or neurochemistry.',
        });
        expect(result.leakDetected).toBe(true);
        expect(result.actionTaken).not.toBe('passthrough');
        expect(result.finalText.toLowerCase()).not.toContain('hormones');
        expect(result.finalText.toLowerCase()).not.toContain('neurochemistry');
    });

    it('RPLG-05: rewrites programmatic capability disclosure', () => {
        const result = applyRpFinalOntologyGuard({
            ...BASE_INPUT,
            finalText: 'My programming allows me to process information about your requests.',
        });
        expect(result.leakDetected).toBe(true);
        expect(result.actionTaken).not.toBe('passthrough');
        expect(result.finalText.toLowerCase()).not.toContain('my programming');
    });

    it('RPLG-06: rewritten content does not itself contain ontology leakage', async () => {
        const { resolveRpMetaOntologyLeak } = await import('../electron/services/agent/PersonaIdentityResponseAdapter');

        const result = applyRpFinalOntologyGuard({
            ...BASE_INPUT,
            finalText: 'I am not human. I am an agent.',
        });
        expect(result.leakDetected).toBe(true);
        expect(result.actionTaken).not.toBe('passthrough');
        // The replacement text must be clean
        const postCheck = resolveRpMetaOntologyLeak(result.finalText);
        expect(postCheck.isMetaOntologyLeak).toBe(false);
    });
});
