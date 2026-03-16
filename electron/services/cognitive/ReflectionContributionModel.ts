/**
 * Reflection Contribution Model — Phase 3: Cognitive Loop (Objective E)
 *
 * Implements structured reflection-to-behavior feedback for Tala's cognitive loop.
 * Reflection may influence future turns in safe, bounded, non-authoritative ways.
 *
 * Reflection output classes:
 * - caution_note: suggest caution on a specific pattern
 * - preference_reminder: remind about a user preference or friction pattern
 * - failure_pattern_note: avoid repeating a recent failure pattern
 * - stability_note: favor simpler path under instability
 * - continuity_reminder: maintain behavioral consistency from recent turns
 *
 * Expiry and suppression rules:
 * - Notes expire after their expiresAt timestamp
 * - Notes expire after maxApplications uses
 * - Notes below minimum confidence threshold are suppressed
 * - Notes must not silently rewrite stable personality
 * - Notes must not directly overwrite memory without policy
 */

import type {
    ReflectionBehavioralNote,
    ReflectionContributionModel,
    ReflectionNoteClass,
} from '../../../shared/cognitiveTurnTypes';
import { v4 as uuidv4 } from 'uuid';

// ─── Default note lifespans ───────────────────────────────────────────────────

/**
 * Default note lifespan in milliseconds by note class.
 * Notes of different classes have different urgency and relevance windows.
 */
const DEFAULT_LIFESPAN_MS: Record<ReflectionNoteClass, number> = {
    caution_note: 30 * 60 * 1000,          // 30 minutes — urgent, short-lived
    failure_pattern_note: 60 * 60 * 1000,  // 1 hour — pattern awareness
    stability_note: 20 * 60 * 1000,        // 20 minutes — situational
    preference_reminder: 4 * 60 * 60 * 1000, // 4 hours — preferences persist longer
    continuity_reminder: 15 * 60 * 1000,   // 15 minutes — session-local
};

/**
 * Default max applications by note class.
 * Low-urgency notes are allowed more applications before expiry.
 */
const DEFAULT_MAX_APPLICATIONS: Record<ReflectionNoteClass, number> = {
    caution_note: 2,
    failure_pattern_note: 3,
    stability_note: 2,
    preference_reminder: 10,
    continuity_reminder: 5,
};

/** Minimum confidence threshold for a note to be applied. */
const MIN_CONFIDENCE_FOR_APPLICATION = 0.4;

// ─── ReflectionContributionStore ─────────────────────────────────────────────

/**
 * In-memory store for reflection behavioral notes.
 * Notes are added by the reflection pipeline and consumed by the cognitive loop.
 * Expired or used-up notes are cleaned up on each access.
 */
export class ReflectionContributionStore {
    private notes: ReflectionBehavioralNote[] = [];

    /**
     * Adds a behavioral note to the store.
     * Automatically assigns lifespan and max applications if not provided.
     *
     * @param noteClass - Classification of the behavioral note.
     * @param summary - Human-readable summary (not raw reflection output).
     * @param confidence - Confidence in this note [0-1].
     * @param customLifespanMs - Optional override for note lifespan.
     * @param customMaxApplications - Optional override for max applications.
     */
    public addNote(
        noteClass: ReflectionNoteClass,
        summary: string,
        confidence: number,
        customLifespanMs?: number,
        customMaxApplications?: number,
    ): ReflectionBehavioralNote {
        const now = new Date();
        const lifespanMs = customLifespanMs ?? DEFAULT_LIFESPAN_MS[noteClass];
        const maxApplications = customMaxApplications ?? DEFAULT_MAX_APPLICATIONS[noteClass];

        const note: ReflectionBehavioralNote = {
            noteId: uuidv4(),
            noteClass,
            summary: summary.slice(0, 300), // Safety: cap summary length
            confidence,
            generatedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + lifespanMs).toISOString(),
            applicationCount: 0,
            maxApplications,
            suppressed: confidence < MIN_CONFIDENCE_FOR_APPLICATION,
            suppressionReason:
                confidence < MIN_CONFIDENCE_FOR_APPLICATION
                    ? `Confidence ${confidence.toFixed(2)} below threshold ${MIN_CONFIDENCE_FOR_APPLICATION}`
                    : undefined,
        };

        this.notes.push(note);
        return note;
    }

    /**
     * Builds the ReflectionContributionModel for the current cognitive turn.
     * Applies expiry, confidence suppression, and usage-count checks.
     * Increments applicationCount for notes that are applied.
     */
    public buildContributionModel(lastReflectionAt?: string): ReflectionContributionModel {
        const now = new Date();

        // Clean up expired notes first
        this.notes = this.notes.filter(n => new Date(n.expiresAt) > now);

        const activeNotes: ReflectionBehavioralNote[] = [];
        const suppressedNotes: ReflectionBehavioralNote[] = [];

        for (const note of this.notes) {
            const expired = new Date(note.expiresAt) <= now;
            const exhausted = note.applicationCount >= note.maxApplications;
            const lowConfidence = note.confidence < MIN_CONFIDENCE_FOR_APPLICATION;

            if (expired || exhausted || lowConfidence || note.suppressed) {
                const suppressionReason =
                    note.suppressionReason ||
                    (expired ? 'expired' : exhausted ? 'usage_limit_reached' : 'low_confidence');
                suppressedNotes.push({ ...note, suppressed: true, suppressionReason });
            } else {
                // Increment usage count before returning as active
                note.applicationCount += 1;
                activeNotes.push({ ...note });
            }
        }

        return {
            activeNotes,
            suppressedNotes,
            applied: activeNotes.length > 0,
            lastReflectionAt,
        };
    }

    /**
     * Clears all notes — used for testing or session reset.
     */
    public clearAll(): void {
        this.notes = [];
    }

    /**
     * Returns the total number of notes currently in the store (including expired).
     */
    public getNoteCount(): number {
        return this.notes.length;
    }
}

// ─── Singleton store instance ──────────────────────────────────────────────────

/**
 * Module-level singleton store for reflection behavioral notes.
 * The CognitiveTurnAssembler consumes this store each turn.
 * The ReflectionEngine should call store.addNote() when generating behavioral notes.
 */
export const reflectionContributionStore = new ReflectionContributionStore();

// ─── Factory helpers ──────────────────────────────────────────────────────────

/**
 * Creates a caution note from a reflection signal.
 * Use for patterns that should trigger behavioral caution in the next turn(s).
 */
export function createCautionNote(
    summary: string,
    confidence: number = 0.7,
): ReflectionBehavioralNote {
    return reflectionContributionStore.addNote('caution_note', summary, confidence);
}

/**
 * Creates a failure pattern note.
 * Use when reflection identifies a repeated failure pattern to avoid.
 */
export function createFailurePatternNote(
    summary: string,
    confidence: number = 0.65,
): ReflectionBehavioralNote {
    return reflectionContributionStore.addNote('failure_pattern_note', summary, confidence);
}

/**
 * Creates a stability note.
 * Use when runtime instability warrants a simpler/more conservative approach.
 */
export function createStabilityNote(
    summary: string,
    confidence: number = 0.6,
): ReflectionBehavioralNote {
    return reflectionContributionStore.addNote('stability_note', summary, confidence);
}

/**
 * Creates a preference reminder note.
 * Use when reflection identifies a user preference or repeated friction pattern.
 */
export function createPreferenceReminderNote(
    summary: string,
    confidence: number = 0.75,
): ReflectionBehavioralNote {
    return reflectionContributionStore.addNote('preference_reminder', summary, confidence);
}

/**
 * Creates a continuity reminder note.
 * Use to maintain behavioral consistency across recent turns.
 */
export function createContinuityReminderNote(
    summary: string,
    confidence: number = 0.7,
): ReflectionBehavioralNote {
    return reflectionContributionStore.addNote('continuity_reminder', summary, confidence);
}
