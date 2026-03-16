/**
 * ReflectionNoiseControl — Phase 3C: Cognitive Behavior Validation
 *
 * Validates that reflection behavioral notes are managed correctly:
 *   - Notes below confidence threshold are suppressed
 *   - Notes expire after their lifespan
 *   - Notes are exhausted after maxApplications
 *   - Suppressed notes do not appear as active
 *   - Contribution model shows accurate counts
 *   - Notes do not accumulate indefinitely (noise control)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test' },
}));

vi.mock('../electron/services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn(),
        event: vi.fn(),
    },
}));

import { ReflectionContributionStore } from '../electron/services/cognitive/ReflectionContributionModel';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ReflectionNoiseControl', () => {
    let store: ReflectionContributionStore;

    beforeEach(() => {
        store = new ReflectionContributionStore();
    });

    it('starts empty with zero notes', () => {
        expect(store.getNoteCount()).toBe(0);
    });

    it('adds a note and reports correct count', () => {
        store.addNote('preference_reminder', 'User prefers short answers.', 0.9);
        expect(store.getNoteCount()).toBe(1);
    });

    it('low-confidence note is marked suppressed', () => {
        // MIN_CONFIDENCE_FOR_APPLICATION = 0.4
        const note = store.addNote('caution_note', 'Weak caution signal.', 0.2);
        expect(note.suppressed).toBe(true);
    });

    it('high-confidence note is not suppressed', () => {
        const note = store.addNote('preference_reminder', 'User prefers short answers.', 0.9);
        expect(note.suppressed).toBe(false);
    });

    it('note summary is truncated to max 300 characters', () => {
        const longSummary = 'x'.repeat(500);
        const note = store.addNote('caution_note', longSummary, 0.8);
        expect(note.summary.length).toBeLessThanOrEqual(300);
    });

    it('buildContributionModel returns applied=false with no valid notes', () => {
        // Only add a low-confidence note (suppressed)
        store.addNote('caution_note', 'Weak signal.', 0.1);
        const model = store.buildContributionModel();
        expect(model.applied).toBe(false);
        expect(model.activeNotes).toHaveLength(0);
    });

    it('buildContributionModel returns applied=true with valid notes', () => {
        store.addNote('preference_reminder', 'User prefers brief explanations.', 0.85);
        const model = store.buildContributionModel();
        expect(model.applied).toBe(true);
        expect(model.activeNotes.length).toBeGreaterThanOrEqual(1);
    });

    it('expired notes do not appear as active', () => {
        // Add a note with an extremely short lifespan (already expired)
        store.addNote('stability_note', 'Immediate expiry test.', 0.9, -1); // -1ms = already expired
        const model = store.buildContributionModel();
        expect(model.activeNotes).toHaveLength(0);
    });

    it('note is exhausted after maxApplications uses', () => {
        // maxApplications=1 — exhausted after first buildContributionModel call
        store.addNote('caution_note', 'Single-use caution.', 0.9, undefined, 1);

        // First call — note is active
        const model1 = store.buildContributionModel();
        expect(model1.activeNotes.length).toBeGreaterThanOrEqual(1);

        // Second call — note is exhausted
        const model2 = store.buildContributionModel();
        expect(model2.activeNotes).toHaveLength(0);
    });

    it('clearAll removes all notes', () => {
        store.addNote('preference_reminder', 'Note A.', 0.8);
        store.addNote('caution_note', 'Note B.', 0.75);
        store.clearAll();
        expect(store.getNoteCount()).toBe(0);
    });

    it('multiple note classes are tracked independently', () => {
        store.addNote('preference_reminder', 'Preference note.', 0.8);
        store.addNote('caution_note', 'Caution note.', 0.7);
        store.addNote('failure_pattern_note', 'Failure note.', 0.6);

        const model = store.buildContributionModel();
        const classes = model.activeNotes.map(n => n.noteClass);
        expect(classes).toContain('preference_reminder');
        expect(classes).toContain('caution_note');
        expect(classes).toContain('failure_pattern_note');
    });

    it('contribution model includes suppressedNotes for noisy signals', () => {
        store.addNote('caution_note', 'Low confidence signal.', 0.1); // suppressed
        store.addNote('preference_reminder', 'Valid preference.', 0.85); // active

        const model = store.buildContributionModel();
        expect(model.suppressedNotes.length).toBeGreaterThanOrEqual(1);
        expect(model.activeNotes.length).toBeGreaterThanOrEqual(1);
    });

    it('note has a valid UUID noteId', () => {
        const note = store.addNote('continuity_reminder', 'Session context.', 0.75);
        expect(note.noteId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('note has valid ISO timestamps', () => {
        const note = store.addNote('preference_reminder', 'Test note.', 0.8);
        expect(() => new Date(note.generatedAt)).not.toThrow();
        expect(() => new Date(note.expiresAt)).not.toThrow();
        expect(new Date(note.expiresAt) > new Date(note.generatedAt)).toBe(true);
    });
});
