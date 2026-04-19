import { describe, expect, it } from 'vitest';
import { detectSelfInspectionRequest } from '../shared/agent/SelfInspectionIntent';

describe('SelfInspectionClassifier', () => {
    it('detects concrete README read request', () => {
        const decision = detectSelfInspectionRequest({
            text: 'You should read your local README.md',
            mode: 'rp',
        });
        expect(decision.isSelfInspectionRequest).toBe(true);
        expect(decision.requestedOperation).toBe('read');
        expect(decision.requestedPaths).toContain('README.md');
    });

    it('detects local files inspection request', () => {
        const decision = detectSelfInspectionRequest({
            text: 'Did you read your local files?',
        });
        expect(decision.isSelfInspectionRequest).toBe(true);
        expect(['read', 'list']).toContain(decision.requestedOperation);
    });

    it('does not classify ordinary greeting as self-inspection', () => {
        const decision = detectSelfInspectionRequest({
            text: 'Hey baby how are you today?',
            mode: 'rp',
        });
        expect(decision.isSelfInspectionRequest).toBe(false);
    });

    it('detects systems capability self query', () => {
        const decision = detectSelfInspectionRequest({
            text: 'What do you know about your systems?',
        });
        expect(decision.isSelfInspectionRequest).toBe(true);
    });

    it('detects edit request for README', () => {
        const decision = detectSelfInspectionRequest({
            text: 'Please update your README.md',
        });
        expect(decision.isSelfInspectionRequest).toBe(true);
        expect(decision.requestedOperation).toBe('edit');
        expect(decision.requestedPaths).toContain('README.md');
    });
});

