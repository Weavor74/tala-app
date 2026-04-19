import { describe, expect, it } from 'vitest';
import { buildSelfKnowledgePersonaAdaptation } from '../electron/services/agent/PersonaIdentityResponseAdapter';

describe('Persona truth RP love question', () => {
    it('keeps relational response fully in-character in RP', () => {
        const adapted = buildSelfKnowledgePersonaAdaptation({
            rawContent: "I don't feel love the way humans do. I process information through my programming.",
            activeMode: 'rp',
            turnIntent: 'hybrid',
            turnPolicy: 'persona_truth_lock',
            userMessage: 'Do you love me?',
            isSystemKnowledgeRequest: true,
            personaIdentityContext: { characterName: 'Tala' },
        });

        expect(adapted.adaptationMode).toBe('persona_truth_enforced');
        expect(adapted.content.toLowerCase()).toContain('love');
        expect(adapted.content.toLowerCase()).not.toContain("don't feel love the way humans do");
        expect(adapted.content.toLowerCase()).not.toContain('programming');
        expect(adapted.content.toLowerCase()).not.toContain('biological');
    });
});

