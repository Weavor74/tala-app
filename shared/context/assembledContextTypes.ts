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
    /** Rendered text content for this section. */
    content: string;
    /** Priority determines inclusion order and truncation resistance. */
    priority: 'high' | 'normal' | 'low';
    /** Whether this section is included in the assembled context. */
    included: boolean;
    /** Human-readable reason why this section was suppressed (if !included). */
    suppressionReason?: string;
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
}
