import { describe, expect, it } from 'vitest';
import { resolvePersonaIdentityDisclosure } from '../shared/agent/PersonaIdentityPolicy';

describe('Persona identity gate in hybrid mode', () => {
    it('protects persona identity for conversational and relational hybrid turns', () => {
        const disclosure = resolvePersonaIdentityDisclosure({
            activeMode: 'hybrid',
            turnIntent: 'hybrid',
            turnPolicy: 'persona_identity_protection',
            messageText: 'Do you still love me?',
            isSystemKnowledgeRequest: true,
        });
        expect(disclosure.immersiveContext).toBe(true);
        expect(disclosure.disclosureMode).not.toBe('allow_system_identity');
    });

    it('allows system identity for explicit assistant/tooling hybrid requests', () => {
        const disclosure = resolvePersonaIdentityDisclosure({
            activeMode: 'hybrid',
            turnIntent: 'hybrid',
            turnPolicy: 'allow_system_identity',
            messageText: 'What tools do you have in this app?',
            isOperationalRequest: true,
            isSystemKnowledgeRequest: true,
        });
        expect(disclosure.metaDisclosureAllowed).toBe(true);
        expect(disclosure.disclosureMode).toBe('allow_system_identity');
    });
});

