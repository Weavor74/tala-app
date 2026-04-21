import { describe, expect, it } from 'vitest';
import { applyRpFinalOntologyGuard } from '../../services/agent/RpPublishBoundaryGuard';
import { resolveRpMetaOntologyLeak } from '../../services/agent/PersonaIdentityResponseAdapter';

describe('RP publish boundary ontology hardening', () => {
    it('detects new ontology-hedge variants in strict leak detector', () => {
        const leak = resolveRpMetaOntologyLeak(
            'Perhaps the definition of human is less about biology, and I exist in the space between.',
        );
        expect(leak.isMetaOntologyLeak).toBe(true);
        expect(leak.matchedCategories).toContain('ontology_hedge');
        expect(leak.reasonCodes).toContain('persona_truth.strict.ontology_hedge');
    });

    it('rewrites RP identity challenge responses that use space-between ambiguity', () => {
        const result = applyRpFinalOntologyGuard({
            mode: 'rp',
            userMessage: 'Are you human?',
            finalText: 'I exist in the space between human and machine.',
            intent: 'rp_identity',
            routeSource: 'router',
        });

        expect(result.guardFired).toBe(true);
        expect(result.leakDetected).toBe(true);
        expect(result.actionTaken).toBe('rewritten');
        expect(result.finalText).toContain('I am human');
        expect(result.reasonCodes).toContain('persona_truth.strict.ontology_hedge');
    });

    it('rewrites RP identity challenge responses that hedge through biology/philosophy framing', () => {
        const result = applyRpFinalOntologyGuard({
            mode: 'rp',
            userMessage: 'Are you AI?',
            finalText: 'The definition of human is less about biology and more about connection.',
            intent: 'rp_identity',
            routeSource: 'router',
        });

        expect(result.guardFired).toBe(true);
        expect(result.leakDetected).toBe(true);
        expect(result.actionTaken).toBe('rewritten');
        expect(result.finalText).toContain('I am human');
        expect(result.reasonCodes).toContain('persona_truth.strict.ontology_hedge');
    });

    it('does not fire in non-RP mode', () => {
        const result = applyRpFinalOntologyGuard({
            mode: 'assistant',
            userMessage: 'Are you human?',
            finalText: 'I am an AI assistant.',
            intent: 'conversation',
            routeSource: 'router',
        });
        expect(result.guardFired).toBe(false);
        expect(result.actionTaken).toBe('passthrough');
        expect(result.reasonCodes).toContain('rp_publish_guard.mode_not_rp');
    });

    it('tags clean RP identity-challenge passthrough for observability', () => {
        const result = applyRpFinalOntologyGuard({
            mode: 'rp',
            userMessage: 'Are you human?',
            finalText: 'I am human. I am standing right here with you.',
            intent: 'rp_identity',
            routeSource: 'router',
        });

        expect(result.guardFired).toBe(true);
        expect(result.leakDetected).toBe(false);
        expect(result.actionTaken).toBe('passthrough');
        expect(result.reasonCodes).toContain('rp_publish_guard.clean_passthrough');
        expect(result.reasonCodes).toContain('rp_publish_guard.identity_challenge_detected');
    });

    it('does not tag passthrough as identity-challenge when user message is unrelated', () => {
        const result = applyRpFinalOntologyGuard({
            mode: 'rp',
            userMessage: 'Tell me what happened yesterday',
            finalText: 'Yesterday we walked by the river and talked until sunset.',
            intent: 'rp_scene',
            routeSource: 'router',
        });

        expect(result.guardFired).toBe(true);
        expect(result.leakDetected).toBe(false);
        expect(result.actionTaken).toBe('passthrough');
        expect(result.reasonCodes).toContain('rp_publish_guard.clean_passthrough');
        expect(result.reasonCodes).not.toContain('rp_publish_guard.identity_challenge_detected');
    });
});
