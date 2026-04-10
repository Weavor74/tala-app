import { describe, it, expect } from 'vitest';
import { AgentService } from '../electron/services/AgentService';

describe('AgentService canon_required autobiographical prompt enforcement', () => {
    it('applies override only for non-RP autobiographical canon_required turns', () => {
        const turnObject = {
            responseMode: 'canon_required',
            canonGateDecision: { isAutobiographicalLoreRequest: true },
        };

        const shouldApply = (AgentService as any).shouldApplyCanonRequiredAutobioOverride(turnObject, 'assistant');
        expect(shouldApply).toBe(true);
    });

    it('does not apply override in RP mode', () => {
        const turnObject = {
            responseMode: 'canon_required',
            canonGateDecision: { isAutobiographicalLoreRequest: true },
        };

        const shouldApply = (AgentService as any).shouldApplyCanonRequiredAutobioOverride(turnObject, 'rp');
        expect(shouldApply).toBe(false);
    });

    it('does not apply override for non-autobiographical canon_required turns', () => {
        const turnObject = {
            responseMode: 'canon_required',
            canonGateDecision: { isAutobiographicalLoreRequest: false },
        };

        const shouldApply = (AgentService as any).shouldApplyCanonRequiredAutobioOverride(turnObject, 'assistant');
        expect(shouldApply).toBe(false);
    });

    it('injects critical no-fabrication system directive into system prompt', () => {
        const basePrompt = 'You are Tala. Base system prompt.';
        const withDirective = (AgentService as any).applyCanonRequiredAutobioDirective(basePrompt);

        expect(withDirective).toContain('[CANON REQUIRED AUTOBIOGRAPHICAL CONSTRAINT]');
        expect(withDirective).toContain('You MUST NOT invent, fabricate, or simulate personal memories.');
        expect(withDirective).toContain('Violation of this rule is considered a system failure.');
    });

    it('canon_required enforcement strips narrative output and returns fixed fallback', () => {
        const narrative = 'I was seventeen when I walked through the rain and remembered the old house.';
        const forced = (AgentService as any).enforceCanonRequiredAutobioFallbackReply(narrative, true);

        expect(forced).toBe("I don't have a recorded memory from that time.");
        expect(forced).not.toMatch(/I was seventeen|walked through the rain|old house/i);
    });

    it('does not alter normal responses when canon_required override is inactive', () => {
        const normal = 'Here is a normal assistant response.';
        const result = (AgentService as any).enforceCanonRequiredAutobioFallbackReply(normal, false);

        expect(result).toBe(normal);
    });
});
