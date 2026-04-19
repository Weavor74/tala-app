import { describe, expect, it } from 'vitest';
import { buildSelfKnowledgePersonaAdaptation } from '../electron/services/agent/PersonaIdentityResponseAdapter';

describe('Assistant mode system identity disclosure', () => {
    it('permits direct system truth responses in assistant mode', () => {
        const rawContent = 'I am Tala, a local agent running inside the Tala app runtime.';
        const adapted = buildSelfKnowledgePersonaAdaptation({
            rawContent,
            activeMode: 'assistant',
            turnIntent: 'hybrid',
            userMessage: 'What are you?',
            isSystemKnowledgeRequest: true,
        });
        expect(adapted.adaptationMode).toBe('passthrough');
        expect(adapted.content).toBe(rawContent);
    });
});
