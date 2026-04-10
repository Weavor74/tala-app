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

    it('streamed narrative output is replaced at finalize stage', () => {
        const finalResponse = 'I remember the summer air and the old neighborhood streets.';
        const transientMessages = [{ role: 'assistant', content: finalResponse }];

        const out = (AgentService as any).applyCanonRequiredAutobioFinalizeOverride(
            finalResponse,
            transientMessages,
            true,
        );

        expect(out.enforced).toBe(true);
        expect(out.replacedAtStage).toBe('finalize');
        expect(out.originalContentLength).toBe(finalResponse.length);
        expect(out.finalResponse).toBe("I don't have a recorded memory from that time.");
        expect(out.transientMessages[0].content).toBe("I don't have a recorded memory from that time.");
    });

    it('plain finalize path narrative is replaced', () => {
        const finalResponse = 'When I was younger, I would walk by the river every evening.';
        const transientMessages = [{ role: 'assistant', content: finalResponse }];

        const out = (AgentService as any).applyCanonRequiredAutobioFinalizeOverride(
            finalResponse,
            transientMessages,
            true,
        );

        expect(out.finalResponse).toBe("I don't have a recorded memory from that time.");
    });

    it('retry path narrative is replaced at finalize stage', () => {
        const finalResponse = 'I can still picture that event clearly from my youth.';
        const transientMessages = [
            { role: 'assistant', content: 'tool envelope retry output' },
            { role: 'assistant', content: finalResponse },
        ];

        const out = (AgentService as any).applyCanonRequiredAutobioFinalizeOverride(
            finalResponse,
            transientMessages,
            true,
        );

        expect(out.finalResponse).toBe("I don't have a recorded memory from that time.");
        expect(out.transientMessages.every((m: any) => m.content === "I don't have a recorded memory from that time.")).toBe(true);
    });

    it('RP mode is not replaced at finalize stage', () => {
        const finalResponse = 'In character narrative remains allowed in RP mode.';
        const transientMessages = [{ role: 'assistant', content: finalResponse }];

        const out = (AgentService as any).applyCanonRequiredAutobioFinalizeOverride(
            finalResponse,
            transientMessages,
            false,
        );

        expect(out.enforced).toBe(false);
        expect(out.finalResponse).toBe(finalResponse);
        expect(out.transientMessages[0].content).toBe(finalResponse);
    });
});
