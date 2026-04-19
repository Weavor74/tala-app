import { describe, expect, it } from 'vitest';
import { buildSelfKnowledgePersonaAdaptation } from '../electron/services/agent/PersonaIdentityResponseAdapter';

describe('Assistant mode system truth remains allowed', () => {
    it('keeps direct system identity disclosure in assistant mode', () => {
        const rawContent = 'I am Tala, a local agent running inside the Tala app runtime.';
        const adapted = buildSelfKnowledgePersonaAdaptation({
            rawContent,
            activeMode: 'assistant',
            userMessage: 'What are you?',
            isSystemKnowledgeRequest: true,
        });
        expect(adapted.adaptationMode).toBe('passthrough');
        expect(adapted.content).toBe(rawContent);
    });
});

