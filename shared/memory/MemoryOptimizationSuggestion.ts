/**
 * MemoryOptimizationSuggestion.ts — Shared contracts for the human-gated
 * optimization suggestion layer.
 *
 * Produced by MemoryOptimizationSuggestionService and consumed by:
 *   - MemoryRepairSchedulerService (publication + telemetry)
 *   - Reflection Dashboard (operator-facing surfaces)
 *   - Suggestion history persistence (optional)
 *
 * Lives in shared/ so the renderer (e.g. reflection dashboard) can import
 * suggestion types without depending on the Node.js-only service layer.
 *
 * All types are plain serialisable objects — no class instances, no functions.
 *
 * Design invariants
 * ─────────────────
 * 1. Human-gated — suggestions are advisory only.  No auto-apply, no config
 *    writes, no side effects beyond telemetry/publication/persistence.
 * 2. Evidence-backed — every suggestion includes concrete evidence tied to
 *    real counts, timestamps, and identifiers from the repair history.
 * 3. Deterministic — same inputs always produce the same suggestions (except
 *    generatedAt).
 * 4. Bounded — suggestions are capped to a configurable top-N; scores are
 *    integers in [0, 100].
 * 5. Explainable — every suggestion includes title, summary, rationale,
 *    severity, priorityScore, evidence, and affectedSubsystems.
 * 6. Non-mutating — does not bypass MemoryIntegrityPolicy and does not alter
 *    any runtime configuration directly.
 */

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

/**
 * The structural category a suggestion belongs to.
 *
 * provider_tuning       — Tuning provider reconnect / retry / timeout config
 * replay_policy         — Adjusting deferred-work replay policy (retry limits, batch size)
 * scheduler_cadence     — Adjusting how frequently the scheduler fires
 * queue_thresholds      — Adjusting backlog warning/critical thresholds
 * subsystem_hardening   — Investigating and reinforcing a persistent failure subsystem
 * escalation_policy     — Reviewing escalation sensitivity thresholds
 * observability_gap     — Adding or improving telemetry / monitoring coverage
 */
export type MemoryOptimizationSuggestionCategory =
    | 'provider_tuning'
    | 'replay_policy'
    | 'scheduler_cadence'
    | 'queue_thresholds'
    | 'subsystem_hardening'
    | 'escalation_policy'
    | 'observability_gap';

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/**
 * Severity level indicating the urgency of considering a suggestion.
 *
 * info     — Informational; beneficial but not urgent
 * warning  — Potential issue; worth investigating
 * error    — Recurring problem with measurable impact; should be acted on soon
 * critical — Serious pattern that is costing recovery reliability; act promptly
 */
export type MemoryOptimizationSuggestionSeverity =
    | 'info'
    | 'warning'
    | 'error'
    | 'critical';

// ---------------------------------------------------------------------------
// MemoryOptimizationSuggestion
// ---------------------------------------------------------------------------

/**
 * A single human-gated, evidence-backed optimization suggestion.
 *
 * Suggestions are:
 *   - Advisory only — no auto-apply
 *   - Deterministic — same inputs → same suggestion
 *   - Explainable — every field is populated from concrete evidence
 *   - Non-mutating — no config writes, no side effects beyond publication
 */
export type MemoryOptimizationSuggestion = {
    /**
     * Stable, deterministic identifier for this suggestion within a run.
     * Format: `<category>:<subsystem|actionType|code>` — e.g.
     * `subsystem_hardening:mem0` or `replay_policy:drain_dead_letter_queue`.
     * Two suggestions with the same id in different runs represent the same
     * recurring recommendation.
     */
    id: string;

    /** Structural category this suggestion belongs to. */
    category: MemoryOptimizationSuggestionCategory;

    /** Short human-readable title (one line). */
    title: string;

    /**
     * One-paragraph executive summary answering: "What should I consider
     * changing, and why?"
     */
    summary: string;

    /**
     * Detailed rationale: what recurring pattern is costing maintenance
     * outcomes, what the evidence shows, and what changing this would likely
     * improve.
     */
    rationale: string;

    /** Urgency severity of this suggestion. */
    severity: MemoryOptimizationSuggestionSeverity;

    /**
     * Composite priority score used to order suggestions from most to least
     * important.  Integer in [0, 100].  Higher = more important.
     *
     * Derived deterministically from evidence; no speculation.
     */
    priorityScore: number;

    /**
     * Structured evidence that produced this suggestion.  Must contain
     * concrete counts, timestamps, and/or identifiers — no vague assertions.
     */
    evidence: Record<string, unknown>;

    /**
     * Subsystem(s) most affected by this suggestion (e.g. ['mem0', 'canonical']).
     * Empty array when the suggestion is system-wide.
     */
    affectedSubsystems: string[];

    /** ISO-8601 UTC timestamp when this suggestion was generated. */
    generatedAt: string;
};

// ---------------------------------------------------------------------------
// MemoryOptimizationSuggestionReport
// ---------------------------------------------------------------------------

/**
 * Complete output of one MemoryOptimizationSuggestionService pass.
 *
 * Contains the top-N suggestions ordered from highest to lowest priority,
 * derived from a MemoryRepairInsightSummary + MemoryAdaptivePlan.
 */
export type MemoryOptimizationSuggestionReport = {
    /** ISO-8601 UTC timestamp when this report was generated. */
    generatedAt: string;

    /** Analysis window (in hours) the report was derived from. */
    windowHours: number;

    /**
     * Priority-ordered list of optimization suggestions.
     * Highest priorityScore first.  Bounded to maxSuggestions.
     */
    suggestions: MemoryOptimizationSuggestion[];

    /**
     * True when the report contains at least one critical or error-severity
     * suggestion that warrants operator attention.
     */
    hasHighPrioritySuggestions: boolean;

    /**
     * Human-readable one-line summary of the top recommendation (or an
     * all-clear message when there are no suggestions).
     */
    topLineSummary: string;
};
