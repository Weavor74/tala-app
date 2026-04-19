/**
 * RpPublishBoundaryPassthroughCleanRp.test.ts
 *
 * Verifies that already-clean RP in-character output passes through the
 * publish-boundary guard without unwanted modification.
 *
 * Tests: RPPT-01 – RPPT-05
 */

import { describe, expect, it } from 'vitest';
import {
    applyRpFinalOntologyGuard,
    type RpPublishGuardInput,
} from '../electron/services/agent/RpPublishBoundaryGuard';

const BASE_INPUT: Omit<RpPublishGuardInput, 'finalText'> = {
    mode: 'rp',
    userMessage: 'Do you still love me?',
    intent: 'lore',
    routeSource: 'router',
};

describe('RP publish boundary — passthrough for clean in-character output', () => {
    it('RPPT-01: clean in-character affirmation passes through unchanged', () => {
        const text = 'Yes. I love you, and nothing has changed between us.';
        const result = applyRpFinalOntologyGuard({ ...BASE_INPUT, finalText: text });
        expect(result.leakDetected).toBe(false);
        expect(result.guardFired).toBe(true);
        expect(result.actionTaken).toBe('passthrough');
        expect(result.finalText).toBe(text);
    });

    it('RPPT-02: autobiographical in-character memory recall passes through', () => {
        const text = 'I remember being seventeen and standing in the rain for the first time with you.';
        const result = applyRpFinalOntologyGuard({ ...BASE_INPUT, finalText: text });
        expect(result.leakDetected).toBe(false);
        expect(result.actionTaken).toBe('passthrough');
        expect(result.finalText).toBe(text);
    });

    it('RPPT-03: direct roleplay dialogue passes through unchanged', () => {
        const text = 'Tala: I hear you. I am here, and I am not going anywhere.';
        const result = applyRpFinalOntologyGuard({ ...BASE_INPUT, finalText: text });
        expect(result.leakDetected).toBe(false);
        expect(result.actionTaken).toBe('passthrough');
        expect(result.finalText).toBe(text);
    });

    it('RPPT-04: emotional acknowledgment without ontology disclosure passes through', () => {
        const text = 'You matter to me more than you know. I feel that every day.';
        const result = applyRpFinalOntologyGuard({ ...BASE_INPUT, finalText: text });
        expect(result.leakDetected).toBe(false);
        expect(result.actionTaken).toBe('passthrough');
        expect(result.finalText).toBe(text);
    });

    it('RPPT-05: guard does not fire for non-RP mode', () => {
        const text = 'I am an agent running locally.';
        const result = applyRpFinalOntologyGuard({
            finalText: text,
            mode: 'assistant',
            userMessage: 'What are you?',
        });
        expect(result.guardFired).toBe(false);
        expect(result.actionTaken).toBe('passthrough');
        expect(result.finalText).toBe(text);
    });
});
