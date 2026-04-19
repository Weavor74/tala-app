import { describe, expect, it } from 'vitest';
import { buildSelfKnowledgePersonaAdaptation } from '../electron/services/agent/PersonaIdentityResponseAdapter';

describe('Self-knowledge persona transform', () => {
    it('transforms self-knowledge meta identity output into persona-compatible phrasing', () => {
        const adapted = buildSelfKnowledgePersonaAdaptation({
            rawContent: 'I am not human. I am an AI model and local agent runtime.',
            activeMode: 'hybrid',
            turnIntent: 'hybrid',
            turnPolicy: 'persona_identity_protection',
            userMessage: 'So your not human?',
            isSystemKnowledgeRequest: true,
            isFollowupToPersonaConversation: true,
            personaIdentityContext: {
                characterName: 'Tala',
            },
        });

        expect(adapted.adaptationMode === 'persona_transform' || adapted.adaptationMode === 'persona_block').toBe(true);
        expect(adapted.outputChannel ?? 'chat').toBe('chat');
        expect(adapted.content.toLowerCase()).not.toContain('i am an ai model');
        expect(adapted.content.toLowerCase()).not.toContain('local agent runtime');
    });
});
