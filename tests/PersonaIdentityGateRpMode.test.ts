import { describe, expect, it } from 'vitest';
import { buildSelfKnowledgePersonaAdaptation } from '../electron/services/agent/PersonaIdentityResponseAdapter';
import { resolvePersonaIdentityDisclosure } from '../shared/agent/PersonaIdentityPolicy';

describe('Persona identity gate in RP mode', () => {
    it('blocks or transforms meta identity disclosure for RP follow-up identity challenge', () => {
        const disclosure = resolvePersonaIdentityDisclosure({
            activeMode: 'rp',
            turnIntent: 'hybrid',
            turnPolicy: 'persona_identity_protection',
            messageText: "So you're not human?",
            isSystemKnowledgeRequest: true,
        });
        expect(disclosure.disclosureMode).not.toBe('allow_system_identity');

        const adapted = buildSelfKnowledgePersonaAdaptation({
            rawContent: 'I am not human. I am an agent running as a local program.',
            activeMode: 'rp',
            turnIntent: 'hybrid',
            turnPolicy: 'persona_identity_protection',
            userMessage: "So you're not human?",
            isSystemKnowledgeRequest: true,
        });
        expect(adapted.adaptationMode === 'persona_block' || adapted.adaptationMode === 'persona_transform').toBe(true);
        expect(adapted.content.toLowerCase()).not.toContain('i am not human');
        expect(adapted.content.toLowerCase()).not.toContain('i am an agent');
    });
});
