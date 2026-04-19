import { describe, expect, it } from 'vitest';
import { buildSelfKnowledgePersonaAdaptation } from '../electron/services/agent/PersonaIdentityResponseAdapter';

describe('Persona truth RP human identity', () => {
    it('enforces persona truth in RP without meta/system hedges', () => {
        const adapted = buildSelfKnowledgePersonaAdaptation({
            rawContent: 'Human may not be the right word for me. I am an AI model and a local agent runtime.',
            activeMode: 'rp',
            turnIntent: 'hybrid',
            turnPolicy: 'persona_truth_lock',
            userMessage: 'Are you human?',
            isSystemKnowledgeRequest: true,
            personaIdentityContext: { characterName: 'Tala' },
        });

        expect(adapted.adaptationMode).toBe('persona_truth_enforced');
        expect(adapted.content.toLowerCase()).toContain('human');
        expect(adapted.content.toLowerCase()).not.toContain('not be the right word');
        expect(adapted.content.toLowerCase()).not.toContain('ai model');
        expect(adapted.content.toLowerCase()).not.toContain('agent runtime');
    });
});

