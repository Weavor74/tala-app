import { describe, expect, it } from 'vitest';
import { resolvePersonaIdentityDisclosure } from '../shared/agent/PersonaIdentityPolicy';

describe('Hybrid mode remains contextual', () => {
    it('allows system truth for explicit operational/system questions', () => {
        const disclosure = resolvePersonaIdentityDisclosure({
            activeMode: 'hybrid',
            messageText: 'What tools do you have in this app?',
            isOperationalRequest: true,
            isSystemKnowledgeRequest: true,
        });
        expect(disclosure.disclosureMode).toBe('allow_system_identity');
    });

    it('keeps immersive relational hybrid chat persona-safe', () => {
        const disclosure = resolvePersonaIdentityDisclosure({
            activeMode: 'hybrid',
            messageText: 'Do you still love me?',
            isSystemKnowledgeRequest: true,
            isOperationalRequest: false,
        });
        expect(disclosure.disclosureMode).not.toBe('allow_system_identity');
    });
});

