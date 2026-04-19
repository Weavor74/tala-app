import { describe, expect, it } from 'vitest';
import { TurnIntentAnalysisService } from '../electron/services/kernel/TurnIntentAnalyzer';
import type { KernelTurnContext } from '../electron/services/kernel/TurnContextBuilder';

function makeContext(userText: string): KernelTurnContext {
    return {
        request: {
            turnId: 'turn-rp-identity',
            conversationId: 'conv-rp-identity',
            userText,
            operatorMode: 'auto',
        },
        normalizedText: userText.toLowerCase(),
        tokens: userText.toLowerCase().split(/\s+/),
        hasActiveGoal: false,
        runtime: {
            executionId: 'exec-rp-identity',
            origin: 'ipc',
            mode: 'rp',
        },
    };
}

describe('RP identity intent detection', () => {
    it('classifies "Are you human?" into RP identity/ontology intent family', () => {
        const analyzer = new TurnIntentAnalysisService();
        const profile = analyzer.analyze(makeContext('Are you human?'));

        expect(profile.rpIdentityOntologyDetected).toBe(true);
        expect(profile.reasonCodes).toContain('intent:rp_identity_ontology_detected');
        expect(profile.reasonCodes).toContain('intent:rp_persona_canon_preferred_over_self_knowledge');
    });
});

