/**
 * MemoryHealthStatus.ts — Memory Integrity Policy shared contracts
 *
 * Typed, serialisable, deterministic model of the memory subsystem's runtime
 * health.  Produced by MemoryIntegrityPolicy and consumed by:
 *   - MemoryService.getHealthStatus()
 *   - AgentService memory write/retrieval gating
 *   - MemoryRepairTriggerService (Phase 4+ repair loops)
 *   - Reflection dashboard / diagnostics UI
 *
 * This file lives in shared/ and compiles to both the Electron main process
 * and the renderer.  It must remain pure TypeScript — no Node.js APIs.
 */

// ---------------------------------------------------------------------------
// MemorySubsystemState — top-level health classification
// ---------------------------------------------------------------------------

/**
 * Ordered severity scale for the overall memory subsystem state.
 *
 * healthy   — all configured capabilities available and functioning.
 * reduced   — canonical authority intact; one or more auxiliary capabilities
 *             (extraction, embeddings, graph) are unavailable.  Tala can
 *             operate with an explicit capability subset.
 * degraded  — canonical authority intact but memory behaviour is substantially
 *             impaired (e.g. mem0 runtime down, canonical-only mode forced).
 *             Cognition must be explicitly constrained; repair is triggered.
 * critical  — canonical authority (Postgres) is unavailable.  Memory
 *             writes / reads are unreliable.  Memory-dependent behaviour
 *             must be hard-blocked.
 * disabled  — memory subsystem intentionally disabled by policy or strict-mode
 *             startup refusal.
 */
export type MemorySubsystemState =
    | 'healthy'
    | 'reduced'
    | 'degraded'
    | 'critical'
    | 'disabled';

// ---------------------------------------------------------------------------
// MemoryCapabilityState — per-capability availability flags
// ---------------------------------------------------------------------------

/**
 * Fine-grained availability of each memory capability.
 * All fields are booleans so consumers can gate individual operations without
 * inspecting the top-level state string.
 */
export type MemoryCapabilityState = {
    /** Canonical Postgres memory store is reachable and accepting writes. */
    canonical: boolean;
    /** LLM-based fact extraction pipeline is available (requires extraction provider). */
    extraction: boolean;
    /** Embedding pipeline is available (semantic retrieval / indexing). */
    embeddings: boolean;
    /** mem0 MCP runtime is connected and responding. */
    mem0Runtime: boolean;
    /** Graph projection pipeline is available. */
    graphProjection: boolean;
    /** RAG interaction logging is available. */
    ragLogging: boolean;
};

// ---------------------------------------------------------------------------
// MemoryFailureReason — machine-readable classification of each failure
// ---------------------------------------------------------------------------

export type MemoryFailureReason =
    | 'none'
    | 'canonical_unavailable'
    | 'canonical_init_failed'
    | 'mem0_unavailable'
    | 'mem0_mode_canonical_only'
    | 'extraction_provider_unavailable'
    | 'embedding_provider_unavailable'
    | 'graph_projection_unavailable'
    | 'rag_logging_unavailable'
    | 'runtime_mismatch'
    | 'unknown';

// ---------------------------------------------------------------------------
// MemoryIntegrityMode — policy strictness level (configuration surface)
// ---------------------------------------------------------------------------

/**
 * Controls how strictly the MemoryIntegrityPolicy enforces capability
 * requirements at runtime.
 *
 * lenient  — canonical authority healthy is enough to continue; reduced /
 *            degraded states allowed; repair suggested but not blocking.
 * balanced — canonical authority required; degraded allowed with warnings
 *            and reduced capabilities; critical triggers repair / escalation.
 *            **Default.**
 * strict   — requires full memory (or at least the configured minimum
 *            capability set); if requirements are not met, memory-dependent
 *            behaviour is hard-disabled.  Suitable for Phase 4+ autonomy.
 */
export type MemoryIntegrityMode = 'lenient' | 'balanced' | 'strict';

// ---------------------------------------------------------------------------
// MemoryHealthStatus — aggregate result produced by MemoryIntegrityPolicy
// ---------------------------------------------------------------------------

/**
 * Complete runtime health snapshot for the memory subsystem.
 *
 * Serialisable (no class instances, no functions) and deterministic for the
 * same input.  Becomes the single source of truth for memory runtime health
 * consumed by AgentService gating, diagnostics UI, and repair loops.
 */
export type MemoryHealthStatus = {
    /** Top-level health classification. */
    state: MemorySubsystemState;
    /** Per-capability availability flags. */
    capabilities: MemoryCapabilityState;
    /** Ordered list of failure reasons (may be empty when state is healthy). */
    reasons: MemoryFailureReason[];
    /** Resolved runtime mode at evaluation time. */
    mode: 'canonical_only' | 'canonical_plus_embeddings' | 'full_memory' | 'unknown';
    /**
     * True when policy requires all memory-dependent operations to be skipped
     * (state = critical or disabled, or strict mode with unsatisfied requirements).
     */
    hardDisabled: boolean;
    /** True when a repair loop should be triggered after this evaluation. */
    shouldTriggerRepair: boolean;
    /** True when the status should be escalated to high-priority logging / alerts. */
    shouldEscalate: boolean;
    /** Human-readable one-line summary of the current health state. */
    summary: string;
    /** ISO-8601 timestamp of when this status was evaluated. */
    evaluatedAt: string;
};

// ---------------------------------------------------------------------------
// MemoryRepairTrigger — structured signal for Phase 4+ repair loops
// ---------------------------------------------------------------------------

/**
 * Structured signal emitted by MemoryRepairTriggerService when the memory
 * subsystem enters a state that warrants a self-repair attempt.
 *
 * Serialisable and machine-actionable: repair loops, diagnostic panels, and
 * audit logs can all consume this shape directly.
 */
export type MemoryRepairTrigger = {
    severity: 'info' | 'warning' | 'error' | 'critical';
    reason: MemoryFailureReason;
    state: MemorySubsystemState;
    emittedAt: string;
    details?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// MemoryHealthTransition — state-change event emitted by MemoryService
// ---------------------------------------------------------------------------

/**
 * Emitted via TelemetryBus ('memory.health_transition') only when the
 * memory subsystem's top-level state or resolved mode changes between
 * successive evaluations.  Consumed by reflection dashboard, repair loops,
 * and audit trails.
 */
export type MemoryHealthTransition = {
    fromState: MemorySubsystemState;
    toState: MemorySubsystemState;
    fromMode: MemoryHealthStatus['mode'];
    toMode: MemoryHealthStatus['mode'];
    reasons: MemoryFailureReason[];
    at: string;
};
