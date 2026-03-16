/**
 * Canonical Cognitive Turn Types — Phase 3: Cognitive Loop
 *
 * Defines the single authoritative model for Tala's mental state inputs into
 * inference. Every turn assembles exactly one TalaCognitiveContext that carries
 * mode policy, memory contributions, documentation context, emotional modulation,
 * and reflection-derived behavioral notes.
 *
 * Design rules:
 * - Built once per turn by CognitiveTurnAssembler — never reconstructed ad hoc.
 * - Downstream services consume this structure rather than rebuilding state.
 * - Safe to serialize over IPC (no circular refs, no functions).
 * - Raw user content and model prompts are never stored in payloads.
 */

// ─── Memory contribution categories ──────────────────────────────────────────

/**
 * Category of a memory contribution in the cognitive turn.
 * Each category carries different semantic weight and influences different
 * aspects of Tala's behavior.
 */
export type MemoryContributionCategory =
    | 'identity'           // Stable user identity facts (name, persistent preferences)
    | 'task_relevant'      // Memories relevant to the current task or query
    | 'preference'         // User preferences and behavioral tendencies
    | 'recent_continuity'; // Recent session context and conversational continuity

/**
 * A single structured memory contribution in the cognitive turn.
 * Carries the memory content along with category, rationale, and influence scope.
 */
export interface MemoryContribution {
    /** Stable memory ID from the memory store. */
    memoryId: string;
    /** Category of this memory contribution. */
    category: MemoryContributionCategory;
    /** Summarized content for prompt injection (not raw memory text). */
    summary: string;
    /** Human-readable rationale for why this memory was included. */
    rationale: string;
    /** Aspects of behavior this memory may influence. */
    influenceScope: Array<'tone' | 'task' | 'identity' | 'style'>;
    /** Salience score [0-1] from memory store. */
    salience: number;
    /** Whether this contribution overrides a conflicting lower-priority memory. */
    overrides?: string; // memoryId of the overridden memory
}

/**
 * The structured memory contribution model for a single cognitive turn.
 * Aggregates all approved memory contributions by category with retrieval metadata.
 */
export interface MemoryContributionModel {
    /** All approved memory contributions for this turn, grouped by category. */
    contributions: MemoryContribution[];
    /** Total candidates retrieved before filtering. */
    candidateCount: number;
    /** Total memories excluded by policy or contradiction resolution. */
    excludedCount: number;
    /** Whether memory retrieval was suppressed for this turn (e.g., greeting). */
    retrievalSuppressed: boolean;
    /** Human-readable rationale for retrieval suppression (if suppressed). */
    suppressionReason?: string;
    /** ISO timestamp when retrieval was performed. */
    retrievedAt: string;
}

// ─── Documentation contribution ──────────────────────────────────────────────

/**
 * The structured documentation contribution model for a single cognitive turn.
 */
export interface DocContributionModel {
    /** Whether documentation context was retrieved. */
    applied: boolean;
    /** Summary of documentation retrieved (not raw content). */
    summary?: string;
    /** Human-readable rationale for why docs were or were not retrieved. */
    rationale: string;
    /** Source identifiers for retrieved documentation chunks. */
    sourceIds: string[];
    /** ISO timestamp when doc retrieval was performed. */
    retrievedAt: string;
}

// ─── Emotional modulation ─────────────────────────────────────────────────────

/**
 * Strength of emotional modulation applied to this turn.
 * Bounded to prevent identity-destabilizing emotional swings.
 */
export type EmotionalModulationStrength = 'none' | 'low' | 'medium' | 'capped';

/**
 * Structured emotional modulation input for the cognitive turn.
 * Derived from the AstroService emotional state with policy-enforced bounds.
 */
export interface EmotionalModulationInput {
    /** Whether modulation was applied. */
    applied: boolean;
    /** Modulation strength after policy enforcement. */
    strength: EmotionalModulationStrength;
    /** Dimensions of behavior this modulation affects. */
    influencedDimensions: Array<'tone' | 'phrasing' | 'emphasis' | 'warmth' | 'caution_bias'>;
    /** Summary of modulation effect (not raw astro data). */
    modulation_summary: string;
    /** Whether the astro engine was unavailable (graceful degraded behavior). */
    astroUnavailable: boolean;
    /** Reason modulation was skipped (if not applied). */
    skipReason?: string;
    /** ISO timestamp when emotional state was retrieved. */
    retrievedAt: string;
}

// ─── Reflection contribution ──────────────────────────────────────────────────

/**
 * Classification of a reflection-derived behavioral note.
 * Each class encodes the nature of the reflection contribution.
 */
export type ReflectionNoteClass =
    | 'caution_note'              // Suggest caution on a specific pattern
    | 'preference_reminder'       // Remind about a user preference or friction pattern
    | 'failure_pattern_note'      // Avoid repeating a recent failure pattern
    | 'stability_note'            // Favor simpler path under instability
    | 'continuity_reminder';      // Maintain behavioral consistency from recent turns

/**
 * A single reflection-derived behavioral note for the cognitive turn.
 * Notes are bounded, attributable, and expire after usage or time.
 */
export interface ReflectionBehavioralNote {
    /** Stable note ID for attribution and telemetry. */
    noteId: string;
    /** Classification of this behavioral note. */
    noteClass: ReflectionNoteClass;
    /** Summary of the behavioral note (not raw reflection output). */
    summary: string;
    /** Confidence level in this note [0-1]. Low confidence notes may be suppressed. */
    confidence: number;
    /** ISO timestamp when this note was generated by reflection. */
    generatedAt: string;
    /** ISO timestamp when this note expires and should no longer influence behavior. */
    expiresAt: string;
    /** How many turns this note has been applied (for usage-count expiry). */
    applicationCount: number;
    /** Maximum times this note may be applied before expiry. */
    maxApplications: number;
    /** Whether this note is currently suppressed. */
    suppressed: boolean;
    /** Reason this note is suppressed (if applicable). */
    suppressionReason?: string;
}

/**
 * The structured reflection contribution model for a single cognitive turn.
 */
export interface ReflectionContributionModel {
    /** Active behavioral notes that influence this turn. */
    activeNotes: ReflectionBehavioralNote[];
    /** Notes available but suppressed for this turn. */
    suppressedNotes: ReflectionBehavioralNote[];
    /** Whether any reflection-derived behavior shaping was applied. */
    applied: boolean;
    /** ISO timestamp of the most recent reflection cycle. */
    lastReflectionAt?: string;
}

// ─── Cognitive mode policy ────────────────────────────────────────────────────

/**
 * The cognitive mode policy applied for this turn.
 * Governs how memory, docs, tools, and emotional expression are handled.
 */
export interface CognitiveModePolicy {
    /** Active mode for this turn. */
    mode: 'assistant' | 'rp' | 'hybrid';
    /** Memory retrieval policy under this mode. */
    memoryRetrievalPolicy: 'full' | 'suppressed' | 'filtered';
    /** Memory write policy under this mode. */
    memoryWritePolicy: 'do_not_write' | 'ephemeral' | 'short_term' | 'long_term' | 'user_profile';
    /** Tool use policy under this mode. */
    toolUsePolicy: 'all' | 'task_only' | 'none';
    /** Documentation retrieval policy under this mode. */
    docRetrievalPolicy: 'enabled' | 'suppressed';
    /** Emotional expression bounds under this mode. */
    emotionalExpressionBounds: 'low' | 'medium' | 'high';
    /** ISO timestamp when this policy was applied. */
    appliedAt: string;
}

// ─── Provider metadata ────────────────────────────────────────────────────────

/**
 * Selected provider metadata included in the cognitive turn for observability.
 */
export interface CognitiveProviderMetadata {
    /** ID of the selected inference provider. */
    providerId?: string;
    /** Display name of the selected provider. */
    providerName?: string;
    /** Whether a fallback provider was selected for this turn. */
    fallbackApplied: boolean;
    /** Whether the runtime is in a degraded state that affects inference quality. */
    runtimeDegraded: boolean;
    /** Human-readable notes about runtime degradation (if any). */
    degradationNotes?: string;
}

// ─── Canonical cognitive turn model ──────────────────────────────────────────

/**
 * The canonical cognitive turn model for Tala.
 *
 * Built exactly once per turn by CognitiveTurnAssembler.
 * Carries all mental state inputs required for a coherent, auditable inference turn.
 * Downstream services must consume this structure rather than rebuilding state.
 *
 * This is the authoritative type for Tala's cognitive loop — Phase 3.
 */
export interface TalaCognitiveContext {
    /** Unique identifier for this cognitive turn. */
    turnId: string;
    /** ISO timestamp when this cognitive context was assembled. */
    assembledAt: string;

    // ─── Input ─────────────────────────────────────────────────────────────
    /** Raw user input as received, before any normalisation. */
    rawInput: string;
    /** Lower-cased, trimmed text used for intent classification and retrieval. */
    normalizedInput: string;

    // ─── Mode policy ───────────────────────────────────────────────────────
    /** Cognitive mode policy active for this turn. */
    modePolicy: CognitiveModePolicy;

    // ─── Memory contributions ──────────────────────────────────────────────
    /** Structured memory contribution model for this turn. */
    memoryContributions: MemoryContributionModel;

    // ─── Documentation contributions ──────────────────────────────────────
    /** Structured documentation contribution model for this turn. */
    docContributions: DocContributionModel;

    // ─── Emotional modulation ──────────────────────────────────────────────
    /** Bounded emotional modulation input for this turn. */
    emotionalModulation: EmotionalModulationInput;

    // ─── Reflection contributions ──────────────────────────────────────────
    /** Structured reflection contribution model for this turn. */
    reflectionContributions: ReflectionContributionModel;

    // ─── Provider metadata ─────────────────────────────────────────────────
    /** Selected inference provider metadata and runtime degradation notes. */
    providerMetadata: CognitiveProviderMetadata;

    // ─── Assembly metadata ─────────────────────────────────────────────────
    /** Final prompt assembly inputs (summaries, not raw prompts). */
    assemblyInputsSummary: string[];
    /** Whether the context was compacted due to token budget constraints. */
    wasCompacted: boolean;
    /** Correlation ID for audit trail linkage. */
    correlationId: string;
}

// ─── Cognitive diagnostics snapshot ──────────────────────────────────────────

/**
 * Normalized cognitive diagnostics read model.
 * Safe to expose via IPC and UI surfaces.
 * Does not contain raw memory contents or full prompts.
 */
export interface CognitiveDiagnosticsSnapshot {
    /** ISO timestamp of this snapshot. */
    timestamp: string;
    /** Active cognitive mode. */
    activeMode: 'assistant' | 'rp' | 'hybrid';
    /** Summary of memory contributions in the last cognitive turn. */
    memoryContributionSummary: {
        totalApplied: number;
        byCategory: Partial<Record<MemoryContributionCategory, number>>;
        retrievalSuppressed: boolean;
    };
    /** Summary of documentation contributions in the last cognitive turn. */
    docContributionSummary: {
        applied: boolean;
        sourceCount: number;
    };
    /** Emotional modulation status in the last cognitive turn. */
    emotionalModulationStatus: {
        applied: boolean;
        strength: EmotionalModulationStrength;
        astroUnavailable: boolean;
    };
    /** Reflection note status in the last cognitive turn. */
    reflectionNoteStatus: {
        activeNoteCount: number;
        suppressedNoteCount: number;
        applied: boolean;
    };
    /** ISO timestamp of the last cognitive policy application. */
    lastPolicyAppliedAt?: string;
}
