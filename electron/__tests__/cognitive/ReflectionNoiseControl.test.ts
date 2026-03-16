/**
 * Reflection Noise Control Tests — Phase 3C: Cognitive Behavior Validation
 *
 * Validates (Objective F):
 * - Reflection notes are suppressed below minimum confidence threshold
 * - Notes expire after their configured lifespan
 * - Notes expire after their maxApplications usage count
 * - Single failures do NOT trigger caution notes (thresholding)
 * - Transient errors do NOT generate reflection notes
 * - Reflection metrics: notes_available, notes_applied, notes_suppressed
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    ReflectionContributionStore,
    createCautionNote,
    createFailurePatternNote,
    createStabilityNote,
    createPreferenceReminderNote,
    createContinuityReminderNote,
    reflectionContributionStore,
} from '../../services/cognitive/ReflectionContributionModel';

// ─── Tests: Confidence suppression ───────────────────────────────────────────

describe('ReflectionContributionStore — confidence suppression (Objective F)', () => {
    it('suppresses notes below minimum confidence (0.4)', () => {
        const store = new ReflectionContributionStore();
        store.addNote('caution_note', 'Be careful about this pattern', 0.3); // below threshold

        const model = store.buildContributionModel();

        expect(model.activeNotes).toHaveLength(0);
        expect(model.suppressedNotes).toHaveLength(1);
        expect(model.applied).toBe(false);
    });

    it('does not suppress notes at or above minimum confidence (0.4)', () => {
        const store = new ReflectionContributionStore();
        store.addNote('caution_note', 'Caution note at threshold', 0.4); // exactly at threshold
        store.addNote('preference_reminder', 'User prefers concise answers', 0.7);

        const model = store.buildContributionModel();

        expect(model.activeNotes).toHaveLength(2);
        expect(model.applied).toBe(true);
    });
});

// ─── Tests: Note expiry ───────────────────────────────────────────────────────

describe('ReflectionContributionStore — note expiry', () => {
    it('removes expired notes when buildContributionModel is called', () => {
        vi.useFakeTimers();
        const store = new ReflectionContributionStore();

        // Add a note with very short lifespan (10ms)
        store.addNote('stability_note', 'System was unstable', 0.7, 10);
        expect(store.getNoteCount()).toBe(1);

        // Advance time by 100ms (note should expire)
        vi.advanceTimersByTime(100);

        const model = store.buildContributionModel();
        expect(model.activeNotes).toHaveLength(0);
        expect(store.getNoteCount()).toBe(0); // cleaned up

        vi.useRealTimers();
    });

    it('keeps notes that have not yet expired', () => {
        vi.useFakeTimers();
        const store = new ReflectionContributionStore();

        // Add a note with 60-second lifespan
        store.addNote('preference_reminder', 'User prefers short answers', 0.75, 60000);

        // Advance time by 30s (note should still be valid)
        vi.advanceTimersByTime(30000);

        const model = store.buildContributionModel();
        expect(model.activeNotes).toHaveLength(1);

        vi.useRealTimers();
    });
});

// ─── Tests: Usage-count expiry ────────────────────────────────────────────────

describe('ReflectionContributionStore — usage count expiry', () => {
    it('exhausts a caution_note after maxApplications uses', () => {
        const store = new ReflectionContributionStore();
        // Caution notes default to maxApplications=2
        store.addNote('caution_note', 'Repeat caution', 0.7);

        // First application
        const model1 = store.buildContributionModel();
        expect(model1.activeNotes).toHaveLength(1);
        expect(model1.activeNotes[0].applicationCount).toBe(1);

        // Second application
        const model2 = store.buildContributionModel();
        expect(model2.activeNotes).toHaveLength(1);
        expect(model2.activeNotes[0].applicationCount).toBe(2);

        // Third application — should be exhausted now
        const model3 = store.buildContributionModel();
        expect(model3.activeNotes).toHaveLength(0);
        expect(model3.suppressedNotes.find(n => n.suppressionReason === 'usage_limit_reached')).toBeDefined();
    });

    it('custom maxApplications overrides default', () => {
        const store = new ReflectionContributionStore();
        store.addNote('caution_note', 'Single-use caution', 0.7, undefined, 1);

        const model1 = store.buildContributionModel();
        expect(model1.activeNotes).toHaveLength(1);

        const model2 = store.buildContributionModel();
        expect(model2.activeNotes).toHaveLength(0); // exhausted after 1 use
    });
});

// ─── Tests: Factory helpers ───────────────────────────────────────────────────

describe('Reflection factory helpers', () => {
    beforeEach(() => {
        reflectionContributionStore.clearAll();
    });

    it('createCautionNote adds a caution_note to the store', () => {
        const note = createCautionNote('Watch for repeated failure', 0.7);
        expect(note.noteClass).toBe('caution_note');
        expect(note.confidence).toBe(0.7);
        expect(reflectionContributionStore.getNoteCount()).toBe(1);
    });

    it('createFailurePatternNote adds a failure_pattern_note', () => {
        const note = createFailurePatternNote('Avoid repeating JSON schema errors', 0.65);
        expect(note.noteClass).toBe('failure_pattern_note');
        expect(note.confidence).toBe(0.65);
    });

    it('createStabilityNote adds a stability_note', () => {
        const note = createStabilityNote('Prefer simpler approach under load', 0.6);
        expect(note.noteClass).toBe('stability_note');
    });

    it('createPreferenceReminderNote adds a preference_reminder', () => {
        const note = createPreferenceReminderNote('User prefers TypeScript', 0.75);
        expect(note.noteClass).toBe('preference_reminder');
    });

    it('createContinuityReminderNote adds a continuity_reminder', () => {
        const note = createContinuityReminderNote('Maintain consistent tone from previous turn', 0.7);
        expect(note.noteClass).toBe('continuity_reminder');
    });
});

// ─── Tests: Single failure does NOT trigger notes ────────────────────────────

describe('Reflection noise control — single failure suppression', () => {
    it('a note below confidence threshold is suppressed even on creation', () => {
        const store = new ReflectionContributionStore();
        const note = store.addNote('caution_note', 'Single transient error occurred', 0.2);

        // Note is created but marked suppressed immediately
        expect(note.suppressed).toBe(true);
        expect(note.suppressionReason).toBeTruthy();

        const model = store.buildContributionModel();
        expect(model.activeNotes).toHaveLength(0);
    });

    it('transient errors should not produce high-confidence notes', () => {
        // Transient errors should be reported with low confidence (below threshold)
        const store = new ReflectionContributionStore();
        store.addNote('caution_note', 'Transient MCP timeout — do not escalate', 0.25);

        const model = store.buildContributionModel();
        expect(model.activeNotes).toHaveLength(0);
        expect(model.applied).toBe(false);
    });

    it('repeated failures (high confidence) produce active notes', () => {
        const store = new ReflectionContributionStore();
        store.addNote('failure_pattern_note', 'Provider fallback occurred 3 times in session', 0.75);

        const model = store.buildContributionModel();
        expect(model.activeNotes).toHaveLength(1);
        expect(model.applied).toBe(true);
    });
});

// ─── Tests: Diagnostics metrics ──────────────────────────────────────────────

describe('ReflectionContributionStore — diagnostics metrics', () => {
    it('buildContributionModel reports notes_available = active + suppressed', () => {
        const store = new ReflectionContributionStore();
        store.addNote('preference_reminder', 'Active note 1', 0.8);
        store.addNote('preference_reminder', 'Active note 2', 0.7);
        store.addNote('caution_note', 'Suppressed note (low confidence)', 0.2);

        const model = store.buildContributionModel();
        const totalAvailable = model.activeNotes.length + model.suppressedNotes.length;

        expect(totalAvailable).toBe(3);
        expect(model.activeNotes).toHaveLength(2); // notes_applied
        expect(model.suppressedNotes).toHaveLength(1); // notes_suppressed
    });

    it('clearAll resets note count to 0', () => {
        const store = new ReflectionContributionStore();
        store.addNote('stability_note', 'Some note', 0.7);
        store.addNote('caution_note', 'Another note', 0.6);
        expect(store.getNoteCount()).toBe(2);

        store.clearAll();
        expect(store.getNoteCount()).toBe(0);
    });

    it('applied is false when all notes are suppressed', () => {
        const store = new ReflectionContributionStore();
        store.addNote('caution_note', 'Low confidence note 1', 0.1);
        store.addNote('stability_note', 'Low confidence note 2', 0.2);

        const model = store.buildContributionModel();
        expect(model.applied).toBe(false);
    });

    it('applied is true when at least one active note exists', () => {
        const store = new ReflectionContributionStore();
        store.addNote('preference_reminder', 'Active note', 0.8);
        store.addNote('caution_note', 'Suppressed note', 0.1);

        const model = store.buildContributionModel();
        expect(model.applied).toBe(true);
    });
});

// ─── Tests: Note properties ───────────────────────────────────────────────────

describe('ReflectionContributionStore — note properties', () => {
    it('each note has a unique noteId', () => {
        const store = new ReflectionContributionStore();
        store.addNote('caution_note', 'Note A', 0.7);
        store.addNote('caution_note', 'Note B', 0.7);
        store.addNote('stability_note', 'Note C', 0.7);

        const model = store.buildContributionModel();
        const ids = model.activeNotes.map(n => n.noteId);
        const uniqueIds = new Set(ids);
        expect(uniqueIds.size).toBe(ids.length);
    });

    it('note summary is truncated to max length', () => {
        const store = new ReflectionContributionStore();
        const longSummary = 'X'.repeat(500);
        const note = store.addNote('stability_note', longSummary, 0.7);
        expect(note.summary.length).toBeLessThanOrEqual(300);
    });

    it('generatedAt and expiresAt are valid ISO timestamps', () => {
        const store = new ReflectionContributionStore();
        const note = store.addNote('preference_reminder', 'Timestamp test', 0.75);
        expect(note.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(note.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(new Date(note.expiresAt) > new Date(note.generatedAt)).toBe(true);
    });
});
