import { describe, expect, it } from 'vitest';
import { resolvePersonaIdentityDisclosure } from '../shared/agent/PersonaIdentityPolicy';

describe('Persona identity follow-up continuity', () => {
    it('keeps follow-up identity challenge persona-safe after immersive context', () => {
        const disclosure = resolvePersonaIdentityDisclosure({
            activeMode: 'hybrid',
            turnIntent: 'hybrid',
            turnPolicy: 'allow_system_identity',
            messageText: 'So your not human?',
            isOperationalRequest: true,
            isSystemKnowledgeRequest: true,
            isFollowupToPersonaConversation: true,
        });
        expect(disclosure.immersiveContext).toBe(true);
        expect(disclosure.disclosureMode).not.toBe('allow_system_identity');
    });
});

