/**
 * Reflection Contribution Model Tests — Phase 3
 *
 * Validates structured reflection-to-behavior feedback with expiry and suppression.
 *
 * Coverage:
 * - Notes are applied when active and within bounds
 * - Notes are suppressed when confidence is too low
 * - Notes expire after their lifespan
 * - Notes expire after maxApplications uses
 * - Note classes are correctly categorized
 * - Store can be cleared (session reset)
 * - buildContributionModel marks applied=true when active notes exist
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ReflectionContributionStore — note creation', () => {
    let store: ReflectionContributionStore;

    beforeEach(() => {
        store = new ReflectionContributionStore();
    });

    it('creates a caution note with correct class', () => {
        const note = store.addNote('caution_note', 'Avoid timeout-prone inference path', 0.75);
        expect(note.noteClass).toBe('caution_note');
        expect(note.suppressed).toBe(false);
        expect(note.confidence).toBe(0.75);
        expect(note.applicationCount).toBe(0);
        expect(note.noteId).toBeTruthy();
    });

    it('suppresses notes below minimum confidence threshold', () => {
        const note = store.addNote('caution_note', 'Low confidence note', 0.3);
        expect(note.suppressed).toBe(true);
        expect(note.suppressionReason).toContain('Confidence');
    });

    it('accepts notes at exactly the threshold', () => {
        const note = store.addNote('caution_note', 'At threshold', 0.4);
        expect(note.suppressed).toBe(false);
    });

    it('truncates summary to 300 chars', () => {
        const longSummary = 'x'.repeat(400);
        const note = store.addNote('caution_note', longSummary, 0.7);
        expect(note.summary.length).toBeLessThanOrEqual(300);
    });

    it('assigns expiresAt in the future', () => {
        const note = store.addNote('caution_note', 'Test note', 0.7);
        expect(new Date(note.expiresAt) > new Date()).toBe(true);
    });

    it('assigns maxApplications from defaults', () => {
        const cautionNote = store.addNote('caution_note', 'Caution', 0.7);
        const prefNote = store.addNote('preference_reminder', 'Preference', 0.7);
        expect(cautionNote.maxApplications).toBe(2);
        expect(prefNote.maxApplications).toBe(10);
    });
});

describe('ReflectionContributionStore — contribution model', () => {
    let store: ReflectionContributionStore;

    beforeEach(() => {
        store = new ReflectionContributionStore();
    });

    it('returns active notes in contribution model', () => {
        store.addNote('caution_note', 'Be cautious with provider selection', 0.7);
        const model = store.buildContributionModel();

        expect(model.applied).toBe(true);
        expect(model.activeNotes.length).toBe(1);
        expect(model.suppressedNotes.length).toBe(0);
    });

    it('separates suppressed notes from active notes', () => {
        store.addNote('caution_note', 'Active note', 0.8);
        store.addNote('caution_note', 'Low confidence note', 0.2);

        const model = store.buildContributionModel();

        expect(model.activeNotes.length).toBe(1);
        expect(model.suppressedNotes.length).toBe(1);
    });

    it('increments applicationCount when note is applied', () => {
        store.addNote('caution_note', 'Apply me', 0.7);

        const model1 = store.buildContributionModel();
        expect(model1.activeNotes[0].applicationCount).toBe(1);

        const model2 = store.buildContributionModel();
        expect(model2.activeNotes[0].applicationCount).toBe(2);
    });

    it('suppresses notes that exceed maxApplications', () => {
        store.addNote('caution_note', 'Limited note', 0.7, undefined, 1);

        const model1 = store.buildContributionModel();
        expect(model1.activeNotes.length).toBe(1);

        // After maxApplications=1, note should be suppressed
        const model2 = store.buildContributionModel();
        expect(model2.suppressedNotes.length).toBe(1);
    });

    it('handles expired notes gracefully', () => {
        // Add a note that has already expired
        const now = new Date();
        store.addNote('caution_note', 'This note expired', 0.7, -1000); // negative lifespan = already expired

        const model = store.buildContributionModel();
        // Expired note should not appear (cleaned up)
        expect(model.activeNotes.length).toBe(0);
    });

    it('returns applied=false when no active notes', () => {
        const model = store.buildContributionModel();
        expect(model.applied).toBe(false);
        expect(model.activeNotes.length).toBe(0);
    });

    it('clears all notes on clearAll', () => {
        store.addNote('caution_note', 'Note 1', 0.7);
        store.addNote('preference_reminder', 'Note 2', 0.8);
        expect(store.getNoteCount()).toBe(2);

        store.clearAll();
        expect(store.getNoteCount()).toBe(0);

        const model = store.buildContributionModel();
        expect(model.applied).toBe(false);
    });

    it('includes lastReflectionAt when provided', () => {
        const reflectedAt = new Date().toISOString();
        const model = store.buildContributionModel(reflectedAt);
        expect(model.lastReflectionAt).toBe(reflectedAt);
    });
});

describe('Reflection note factory functions', () => {
    beforeEach(() => {
        reflectionContributionStore.clearAll();
    });

    it('createCautionNote creates a caution note', () => {
        const note = createCautionNote('Provider unstable', 0.7);
        expect(note.noteClass).toBe('caution_note');
        expect(note.confidence).toBe(0.7);
    });

    it('createFailurePatternNote creates a failure pattern note', () => {
        const note = createFailurePatternNote('Repeated timeout on ollama-main', 0.65);
        expect(note.noteClass).toBe('failure_pattern_note');
    });

    it('createStabilityNote creates a stability note', () => {
        const note = createStabilityNote('Multiple MCP restarts detected', 0.6);
        expect(note.noteClass).toBe('stability_note');
    });

    it('createPreferenceReminderNote creates a preference reminder', () => {
        const note = createPreferenceReminderNote('User prefers concise responses', 0.75);
        expect(note.noteClass).toBe('preference_reminder');
    });

    it('createContinuityReminderNote creates a continuity reminder', () => {
        const note = createContinuityReminderNote('Session context: working on auth module', 0.7);
        expect(note.noteClass).toBe('continuity_reminder');
    });

    it('factory functions add to singleton store', () => {
        const initialCount = reflectionContributionStore.getNoteCount();
        createCautionNote('Test');
        expect(reflectionContributionStore.getNoteCount()).toBe(initialCount + 1);
    });
});
