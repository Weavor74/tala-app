/**
 * assembledContextTypes.ts
 *
 * Type definitions for the ContextAssembler pure assembly boundary.
 *
 * These types define the normalized, structured output of context assembly —
 * the AssembledContext produced by ContextAssembler.assembleContext().
 *
 * Design principles:
 *   - AssembledContext is a pure, serializable data structure.
 *   - All sections are explicitly named and carry inclusion status.
 *   - Evidence items carry full provenance (source, selectionClass, memoryId).
 *   - ContextAssemblyMetadata provides an audit trail without embedding raw content.
 *
 * Shared between renderer and Electron process (read-only consumer in renderer).
 */

// ─── Section names ────────────────────────────────────────────────────────────

/**
 * Canonical names for the structured sections of an AssembledContext.
 * Each name maps to one discrete section of the assembled runtime context.
 */
export type ContextSectionName =
    | 'identity'          // Persona / identity grounding text
    | 'mode_constraints'  // Mode policy rules and capability gates
    | 'memory'            // Retrieved memory context (approved memories)
    | 'graph_retrieval'   // Graph traversal / relational context
    | 'document'          // Notebook / documentation context
    | 'affective'         // Astro / emotional modulation state
    | 'tool_availability' // Summary of allowed and blocked tool capabilities
    | 'request_summary';  // Normalized user-turn and intent summary

// ─── Budget policy ────────────────────────────────────────────────────────────

/**
 * Per-section token/character budget contract.
 *
 * Budget enforcement uses a 4-chars-per-token heuristic (consistent with
 * the rest of the context assembly pipeline). All budgets are soft limits:
 * content that exceeds `maxChars` is truncated at a word boundary and
 * marked with the truncation suffix.
 *
 * Budget enforcement priority:
 *   1. mandatoryInclude sections are always included regardless of budget.
 *   2. Sections are filled in canonical priority order (high → normal → low).
 *   3. Once totalBudgetChars is reached, subsequent optional sections are dropped.
 *   4. Sections with mandatoryInclude=true are never dropped by total budget.
 */
export interface ContextBudgetPolicy {
    /**
     * Maximum character count for this section's rendered content.
     * Content exceeding this is truncated at a word boundary.
     * 0 means no per-section cap (only total budget applies).
     */
    maxChars: number;
    /**
     * Approximate maximum token count for this section.
     * Derived from maxChars using the 4-chars/token heuristic.
     * Provided for display and metadata only — enforcement uses maxChars.
     */
    maxTokens: number;
    /**
     * Whether this section must always be included regardless of total budget.
     * Mandatory sections are never dropped even if the total budget is exceeded.
     */
    mandatoryInclude: boolean;
    /**
     * What to do when the section content exceeds maxChars:
     *   'truncate'  — include truncated content, record truncation in reason
     *   'drop'      — drop the section entirely if content exceeds maxChars
     */
    overflowPolicy: 'truncate' | 'drop';
}

// ─── Reason codes ─────────────────────────────────────────────────────────────

/**
 * Typed reason codes for why a section was included in the assembled context.
 * Enables deterministic, auditable inclusion decisions.
 */
export type ContextSelectionReason =
    | 'mandatory'                // Always included by contract (mandatoryInclude=true)
    | 'content_available'        // Content was present and within budget
    | 'fallback_contract'        // No evidence found; fallback instruction injected
    | 'notebook_grounding'       // Notebook strict grounding mode activated
    | 'lore_grounding'           // Lore/autobiographical memory grounding mode
    | 'content_truncated';       // Content available but truncated to fit budget

/**
 * Typed reason codes for why a section was excluded from the assembled context.
 * Enables deterministic, auditable exclusion decisions.
 */
export type ContextExclusionReason =
    | 'no_content'               // No content available for this section
    | 'retrieval_suppressed'     // Retrieval was suppressed by mode or policy
    | 'policy_suppressed'        // Mode policy disallows this section
    | 'total_budget_exceeded'    // Section dropped because total context budget was reached
    | 'section_budget_exceeded'  // Content exceeds per-section budget and policy=drop
    | 'greeting_turn'            // Section not included for greeting/trivial turns
    | 'unknown_intent';          // Section not included for unknown intent turns

// ─── Section budget result ────────────────────────────────────────────────────

/**
 * Budget accounting record for one assembled section.
 * Included in AssembledContext metadata for full budget traceability.
 */
export interface SectionBudgetResult {
    /** Canonical name of the section. */
    name: ContextSectionName;
    /** Budget policy that governed this section. */
    policy: ContextBudgetPolicy;
    /** Character count of the raw content before truncation. */
    rawCharCount: number;
    /** Character count of the content after budget enforcement (≤ policy.maxChars if capped). */
    finalCharCount: number;
    /** Estimated token count of the final content (finalCharCount / 4, ceil). */
    estimatedTokens: number;
    /** Whether the content was truncated to fit the per-section budget. */
    wasTruncated: boolean;
    /** Whether this section was included in the assembled output. */
    included: boolean;
}

// ─── Core section shape ───────────────────────────────────────────────────────

/**
 * A single named, discrete section of the assembled runtime context.
 *
 * Sections are ordered by priority during prompt rendering:
 *   high   — always included first; identity, mode constraints, memory
 *   normal — included after high-priority sections; graph, affective
 *   low    — included last; tool availability, internal metadata
 */
export interface ContextSection {
    /** Canonical name of this section. */
    name: ContextSectionName;
    /** Model-facing header string, e.g. "[MEMORY CONTEXT]". */
    header: string;
    /** Rendered text content for this section (budget-enforced). */
    content: string;
    /** Priority determines inclusion order and truncation resistance. */
    priority: 'high' | 'normal' | 'low';
    /** Whether this section is included in the assembled context. */
    included: boolean;
    /** Human-readable reason why this section was suppressed (if !included). */
    suppressionReason?: string;
    /** Typed reason code for why this section was selected (if included). */
    selectionReason?: ContextSelectionReason;
    /** Typed reason code for why this section was excluded (if !included). */
    exclusionReason?: ContextExclusionReason;
    /** Character count of the rendered content after budget enforcement. */
    charCount: number;
    /** Estimated token count of the rendered content (charCount / 4, ceil). */
    estimatedTokens: number;
    /** Budget policy that governed this section. */
    budgetPolicy: ContextBudgetPolicy;
}

// ─── Evidence ─────────────────────────────────────────────────────────────────

/**
 * A single retrieved evidence item included in the assembled context.
 *
 * Evidence items are distinct from sections: a section may aggregate many
 * evidence items into a single rendered block, while each item carries
 * individual provenance metadata.
 */
export interface ContextEvidence {
    /** Stable identifier for this evidence item. */
    evidenceId: string;
    /** Rendered text content of this evidence item. */
    content: string;
    /** Source system that produced this evidence (e.g. 'memory', 'rag', 'graph', 'doc'). */
    source: string;
    /**
     * Classification of this evidence for retrieval audit:
     *   evidence       — directly injected into the prompt
     *   graph_context  — derived via graph traversal; injected after primary evidence
     *   latent         — retrieved but deferred by budget; not injected this turn
     *   overflow       — retrieved but excluded by budget cap
     */
    selectionClass: 'evidence' | 'graph_context' | 'latent' | 'overflow';
    /** Canonical memory ID if this evidence originated from a memory record. */
    memoryId?: string;
    /** Optional provenance and citation metadata. */
    metadata?: Record<string, unknown>;
}

// ─── Assembly metadata ────────────────────────────────────────────────────────

/**
 * Audit metadata for one context assembly run.
 * Contains no raw content — safe for logging and telemetry payloads.
 */
export interface ContextAssemblyMetadata {
    /** Unique turn identifier. */
    turnId: string;
    /** ISO 8601 timestamp of assembly completion. */
    assembledAt: string;
    /** Correlation ID for cross-service trace linking. */
    correlationId: string;
    /** Active cognitive mode at assembly time. */
    mode: string;
    /** Classified intent class for this turn. */
    intentClass: string;
    /** Total number of sections (included + suppressed). */
    sectionCount: number;
    /** Number of sections with included=true. */
    includedSectionCount: number;
    /** Total evidence items in the assembled context (all selectionClasses). */
    totalEvidenceCount: number;
    /**
     * Whether the assembled context was compacted due to contribution volume.
     * True when total contribution count exceeds the turn budget threshold.
     */
    wasCompacted: boolean;
    /** Wall-clock duration of the assembly phase in milliseconds. */
    assemblyDurationMs: number;

    // ─── Budget fields ─────────────────────────────────────────────────────
    /** Total character count of all included section content. */
    totalCharCount: number;
    /** Total estimated token count across all included sections (charCount / 4, ceil). */
    totalEstimatedTokens: number;
    /**
     * Total token budget for this assembly run.
     * Derived from DEFAULT_TOTAL_BUDGET_TOKENS or overridden via inputs.
     */
    totalBudgetTokens: number;
    /**
     * Budget utilization as a fraction [0, 1].
     * Computed as totalEstimatedTokens / totalBudgetTokens.
     * Values > 1 indicate the budget was exceeded (should not happen for included content).
     */
    budgetUtilization: number;
    /** Per-section budget accounting records, in canonical section order. */
    sectionBudgets: SectionBudgetResult[];
    /** Number of sections that were truncated to fit their per-section budget. */
    truncatedSectionCount: number;
    /** Number of sections that were dropped because the total budget was exceeded. */
    droppedSectionCount: number;
}

// ─── Assembled context ────────────────────────────────────────────────────────

/**
 * The structured, normalized output of ContextAssembler.assembleContext().
 *
 * AssembledContext is the explicit runtime context boundary for one agent turn.
 * It contains:
 *   - metadata   : audit trail (no raw content)
 *   - sections   : ordered, named sections with inclusion status
 *   - evidence   : individual retrieved evidence items with provenance
 *
 * This value is deterministic: the same ContextAssemblerInputs always produces
 * the same AssembledContext (given the same timestamp/correlationId generation).
 */
export interface AssembledContext {
    /** Audit metadata for this assembly run. */
    metadata: ContextAssemblyMetadata;
    /**
     * Ordered list of context sections.
     * Ordered by priority (high → normal → low) then by canonical section name.
     * Suppressed sections (included=false) are present but carry suppressionReason.
     */
    sections: ContextSection[];
    /**
     * Flat list of all evidence items considered during assembly.
     * Includes evidence, graph_context, latent, and overflow items.
     */
    evidence: ContextEvidence[];
}

// ─── Assembler inputs ─────────────────────────────────────────────────────────

/**
 * A single evidence input item for context assembly.
 * Normalizes the minimal shape needed from any source (memory, doc, graph).
 */
export interface ContextEvidenceInput {
    /** Stable identifier for this item. */
    id: string;
    /** Rendered text content. */
    text: string;
    /** Source system that produced this item. */
    source?: string;
    /** Optional provenance metadata. */
    metadata?: Record<string, unknown>;
}

/**
 * All inputs required to assemble a ContextAssembler.assembleContext() result.
 *
 * These inputs are the normalized, pre-gathered outputs of the pre-inference
 * orchestration stage. ContextAssembler performs no IO; all IO must complete
 * before assembleContext() is called.
 *
 * Fields are optional where the section can be gracefully suppressed if absent.
 */
export interface ContextAssemblerInputs {
    // ─── Required turn identity ───────────────────────────────────────────
    /** Unique turn identifier. */
    turnId: string;
    /** Raw user input text (unmodified). */
    rawInput: string;
    /** Lower-cased, trimmed input used for intent classification. */
    normalizedInput: string;
    /** Active cognitive mode (e.g. 'assistant', 'rp', 'hybrid'). */
    mode: string;
    /** Classified intent class for this turn. */
    intentClass: string;
    /** Whether this turn is a greeting (may suppress retrieval sections). */
    isGreeting: boolean;

    // ─── Identity / persona ───────────────────────────────────────────────
    /** Optional persona or identity grounding text for the identity section. */
    identityText?: string;

    // ─── Mode policy constraints ──────────────────────────────────────────
    /** Memory retrieval policy resolved for this mode. */
    memoryRetrievalPolicy?: string;
    /** Memory write policy resolved for this mode. */
    memoryWritePolicy?: string;
    /** Tool use policy resolved for this mode. */
    toolUsePolicy?: string;
    /** Documentation retrieval policy resolved for this mode. */
    docRetrievalPolicy?: string;
    /** Emotional expression bounds resolved for this mode. */
    emotionalExpressionBounds?: string;

    // ─── Memory context ───────────────────────────────────────────────────
    /** Approved memory items that passed filtering and contradiction resolution. */
    approvedMemories?: ContextEvidenceInput[];
    /** Whether memory retrieval was suppressed for this turn. */
    memoryRetrievalSuppressed?: boolean;
    /** Human-readable reason retrieval was suppressed, if applicable. */
    memorySuppressionReason?: string;
    /** Total memory candidates considered before filtering. */
    memoryCandidateCount?: number;
    /** Memories excluded by policy. */
    memoryExcludedCount?: number;
    /**
     * Response grounding mode for lore/autobiographical turns.
     * Affects memory section header and grounding instruction injection.
     */
    responseMode?: 'memory_grounded_soft' | 'memory_grounded_strict';
    /** When true, activate notebook strict grounding for the memory section. */
    notebookGrounded?: boolean;

    // ─── Graph / retrieval context ────────────────────────────────────────
    /** Optional pre-rendered graph traversal context text. */
    graphContextText?: string;

    // ─── Document / notebook context ──────────────────────────────────────
    /** Documentation context text from DocumentationIntelligenceService. */
    docContextText?: string | null;
    /** Source IDs for retrieved documentation chunks. */
    docSourceIds?: string[];
    /** Human-readable rationale for doc retrieval or suppression. */
    docRationale?: string;

    // ─── Affective / astro context ────────────────────────────────────────
    /** Raw emotional state text from AstroService. Null if unavailable. */
    astroStateText?: string | null;
    /** Whether emotional modulation was applied this turn. */
    emotionalModulationApplied?: boolean;
    /** Strength of applied emotional modulation (e.g. 'low', 'medium', 'high'). */
    emotionalModulationStrength?: string;

    // ─── Tool availability ────────────────────────────────────────────────
    /** Capabilities allowed for this turn. */
    allowedCapabilities?: string[];
    /** Capabilities blocked for this turn. */
    blockedCapabilities?: string[];

    // ─── Budget override ──────────────────────────────────────────────────
    /**
     * Optional total token budget override for this assembly run.
     * When not provided, the default budget (DEFAULT_TOTAL_BUDGET_TOKENS) is used.
     * Use this to tighten the budget for constrained models or widen it for large-context models.
     */
    totalBudgetTokensOverride?: number;
}
