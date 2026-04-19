import { describe, expect, it } from 'vitest';
import { resolveSelfKnowledgeRequest } from '../shared/agent/SelfKnowledgeIntent';

describe('SelfKnowledgeClassifier', () => {
    it('detects broad capability question', () => {
        const decision = resolveSelfKnowledgeRequest({ text: 'What can you do?' });
        expect(decision.isSelfKnowledgeRequest).toBe(true);
        expect(decision.requestedAspects).toContain('capabilities');
    });

    it('detects systems and architecture question', () => {
        const decision = resolveSelfKnowledgeRequest({ text: 'What are your systems?' });
        expect(decision.isSelfKnowledgeRequest).toBe(true);
        expect(decision.requestedAspects).toEqual(expect.arrayContaining(['systems']));
    });

    it('detects tool inventory question', () => {
        const decision = resolveSelfKnowledgeRequest({ text: 'What tools do you have?' });
        expect(decision.isSelfKnowledgeRequest).toBe(true);
        expect(decision.requestedAspects).toContain('tools');
    });

    it('detects filesystem permissions question', () => {
        const decision = resolveSelfKnowledgeRequest({ text: 'Can you edit your own files?' });
        expect(decision.isSelfKnowledgeRequest).toBe(true);
        expect(decision.requestedAspects).toEqual(expect.arrayContaining(['filesystem', 'permissions']));
    });

    it('does not classify greeting as self-knowledge', () => {
        const decision = resolveSelfKnowledgeRequest({ text: 'Hey baby how are you today?' });
        expect(decision.isSelfKnowledgeRequest).toBe(false);
    });
});

