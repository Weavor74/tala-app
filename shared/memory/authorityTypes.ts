/**
 * authorityTypes.ts — P7A Memory Authority Lock shared contracts
 *
 * Defines the canonical types that flow through MemoryAuthorityService.
 * Postgres is the ONLY canonical memory store; all other systems are derived.
 *
 * These types live in shared/ and compile to both the renderer (browser) and
 * the Electron main process. They must remain pure TypeScript — no Node.js APIs.
 */

// ---------------------------------------------------------------------------
// MemoryInvocationContext — caller-supplied context for memory write operations
// ---------------------------------------------------------------------------

/**
 * Context carried through a single memory write invocation via the CRUD facade.
 *
 * All fields are optional.  Callers may supply only what is available at
 * their call site.  These mirror the fields used by TelemetryBus and
 * PolicyGate so that memory operations can be correlated with their parent
 * execution (e.g. a chat turn or autonomy run).
 */
export interface MemoryInvocationContext {
    /** ID of the parent execution (e.g. turnId) for telemetry correlation. */
    executionId?: string;
    /** Runtime mode in effect (e.g. 'rp', 'hybrid', 'assistant'). */
    executionMode?: string;
    /**
     * Reserved for future use.  Policy enforcement is always active inside
     * MemoryAuthorityService; this field exists for API symmetry with
     * ToolInvocationContext.
     */
    enforcePolicy?: boolean;
}

// ---------------------------------------------------------------------------
// MemoryOperationResult — normalized result returned by the public CRUD facade
// ---------------------------------------------------------------------------

/**
 * Normalized result produced by MemoryAuthorityService CRUD facade methods.
 *
 * Mirrors the shape of ToolInvocationResult so that memory writes are as
 * observable and deterministic as tool invocations.
 *
 * On success:  `{ success: true, data: T, durationMs }`
 * On failure:  `{ success: false, error: string, durationMs }`
 *
 * The facade methods never throw — all errors (including PolicyDeniedError)
 * are captured in the `error` field.  This guarantees consistent, structured
 * results for all callers without per-call try/catch boilerplate.
 */
export interface MemoryOperationResult<T = unknown> {
    /** Whether the operation completed without error. */
    success: boolean;
    /** Return value of the operation. Present when `success` is true. */
    data?: T;
    /** Error message. Present when `success` is false. */
    error?: string;
    /** Wall-clock execution time in milliseconds from facade entry to return. */
    durationMs: number;
    /**
     * Original error instance, preserved so callers and diagnostics can inspect
     * the concrete error type (e.g. `instanceof PolicyDeniedError`).
     * @internal Not part of the public contract — do not read in new callers.
     */
    _cause?: Error;
}

// ---------------------------------------------------------------------------
// Memory lifecycle contracts (authoritative, candidate, and derived states)
// ---------------------------------------------------------------------------

export type MemoryLifecycleState =
    | 'observed_event'
    | 'candidate_proposed'
    | 'candidate_accepted'
    | 'candidate_rejected'
    | 'candidate_deferred'
    | 'canonical_tombstoned'
    | 'derived_projected';

export interface CandidateMemoryRecord {
    candidate_id: string;
    source_event_ref: string;
    source_kind: string;
    memory_type: string;
    subject_type: string;
    subject_id: string;
    content_text: string;
    content_structured?: Record<string, unknown>;
    confidence: number;
    salience: number;
    proposed_at: string;
    state: 'candidate_proposed';
}

export interface CandidateReviewDecision {
    candidate_id: string;
    decision: 'accept' | 'reject' | 'merge' | 'defer';
    decided_at: string;
    decided_by: string;
    reason?: string;
    canonical_memory_id?: string | null;
    merged_into_memory_id?: string | null;
}

export interface AcceptedCanonicalMemoryRecord extends CanonicalMemory {
    state: 'candidate_accepted';
    accepted_at: string;
    accepted_from_candidate_id?: string | null;
}

export interface RejectedOrDeferredCandidateRecord {
    candidate_id: string;
    state: 'candidate_rejected' | 'candidate_deferred';
    decided_at: string;
    reason: string;
}

export interface TombstonedCanonicalMemoryRecord {
    memory_id: string;
    canonical_hash: string;
    state: 'canonical_tombstoned';
    tombstoned_at: string;
}

export interface DerivedArtifactProjectionState {
    projection_id: string;
    memory_id: string;
    target_system: ProjectionTargetSystem;
    projection_status: ProjectionStatus;
    canonical_version: number;
    projected_version: number | null;
    state: 'derived_projected';
}

// ---------------------------------------------------------------------------
// Proposed input — what callers submit for canonicalisation
// ---------------------------------------------------------------------------

export interface ProposedMemoryInput {
    /** High-level category: 'observation' | 'episode' | 'interaction' | 'entity' | etc. */
    memory_type: string;
    /** Kind of entity this memory is about: 'user' | 'agent' | 'document' | etc. */
    subject_type: string;
    /** Stable identifier of the subject within subject_type namespace */
    subject_id: string;
    /** Human-readable content to persist */
    content_text: string;
    /** Optional structured payload (arbitrary JSON) */
    content_structured?: Record<string, unknown>;
    /** Confidence value 0–1 (defaults to 1.0) */
    confidence?: number;
    /** System that originated this write: 'conversation' | 'ingestion' | 'agent' | etc. */
    source_kind?: string;
    /** Opaque reference into the source system (e.g. turn ID, file path) */
    source_ref?: string;
    /** ISO-8601 timestamp for valid_from; defaults to NOW() */
    valid_from?: string;
    /** ISO-8601 timestamp for valid_to expiry; omit for open-ended */
    valid_to?: string;
}

// ---------------------------------------------------------------------------
// CanonicalMemory — a fully committed memory_records row
// ---------------------------------------------------------------------------

export interface CanonicalMemory {
    memory_id: string;          // UUID
    memory_type: string;
    subject_type: string;
    subject_id: string;
    content_text: string;
    content_structured: Record<string, unknown> | null;
    canonical_hash: string;
    authority_status: 'canonical' | 'superseded' | 'tombstoned';
    version: number;
    confidence: number;
    source_kind: string;
    source_ref: string;
    created_at: string;         // ISO-8601
    updated_at: string;         // ISO-8601
    valid_from: string;         // ISO-8601
    valid_to: string | null;    // ISO-8601 or null (open-ended)
    tombstoned_at: string | null;
    supersedes_memory_id: string | null;
}

// ---------------------------------------------------------------------------
// DuplicateReport — result of duplicate-detection phase
// ---------------------------------------------------------------------------

export interface DuplicateReport {
    duplicate_found: boolean;
    /** UUID of the existing canonical record (set when duplicate_found is true) */
    matched_memory_id: string | null;
    /** 1.0 = exact hash match; <1.0 = semantic similarity score */
    match_score: number;
    /** 'exact' | 'semantic' | 'none' */
    match_kind: 'exact' | 'semantic' | 'none';
}

// ---------------------------------------------------------------------------
// ProjectionRecord — one row in memory_projections
// ---------------------------------------------------------------------------

export type ProjectionTargetSystem = 'mem0' | 'graph' | 'vector';
export type ProjectionStatus = 'pending' | 'projected' | 'failed' | 'stale';

export interface ProjectionRecord {
    projection_id: string;      // UUID
    memory_id: string;          // UUID FK → memory_records
    target_system: ProjectionTargetSystem;
    projection_status: ProjectionStatus;
    canonical_version: number;
    projected_version: number | null;
    projection_ref: string | null;
    attempted_at: string;       // ISO-8601
    projected_at: string | null;
    error_message: string | null;
    /** Classification of where this projection lives (aligns with DerivedWriteAnchor.derivation_type) */
    derivation_type?: string;
    /** Source system that triggered the projection (e.g. 'turn:xyz', 'ingestion') */
    projection_source?: string;
}

// ---------------------------------------------------------------------------
// DerivedWriteAnchor — metadata required on every durable derived write
// ---------------------------------------------------------------------------

export interface DerivedWriteAnchor {
    /** UUID of the authoritative memory_records row this projection is derived from. */
    canonical_memory_id: string | null | undefined;
    /** Classification of the derived system: 'mem0' | 'graph' | 'vector' | 'local' */
    derivation_type?: ProjectionTargetSystem | 'local' | string;
    /** Opaque reference into the canonical source (e.g. "turn:xyz", "ingestion:abc") */
    projection_source?: string;
    /**
     * Canonical version at projection time. Used to detect staleness.
     * Set by MemoryAuthorityService after createCanonicalMemory().
     */
    canonical_version?: number;
}

// ---------------------------------------------------------------------------
// MemoryAuthorityRanking — priority-ordered result from selectMemoryByAuthority()
// ---------------------------------------------------------------------------

export type MemoryAuthorityTier =
    | 'canonical'          // Postgres memory_records, status='canonical'
    | 'verified_derived'   // Projection in sync with canonical version
    | 'transient'          // Session-only or unanchored temporary data
    | 'speculative';       // No canonical anchor; origin unknown

export interface RankedMemoryCandidate {
    content: string;
    tier: MemoryAuthorityTier;
    canonical_memory_id: string | null;
    /** Relative priority: lower number = higher authority (1 = highest) */
    priority: number;
    source_description: string;
}

// ---------------------------------------------------------------------------
// IntegrityIssue — a single finding from validateIntegrity()
// ---------------------------------------------------------------------------

export type IssueKind =
    | 'orphan'
    | 'duplicate'
    | 'divergence'
    | 'projection_mismatch'
    | 'tombstone_violation'
    | 'absent_projection'
    | 'superseded_active_projection'
    | 'illegal_authority';

export type IssueSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface IntegrityIssue {
    issue_id: string;           // UUID (assigned after persistence; may be empty string pre-persist)
    issue_kind: IssueKind;
    severity: IssueSeverity;
    affected_memory_id: string | null;
    affected_system: string | null;
    description: string;
    repair_suggestion: string | null;
    repair_status: 'open' | 'repaired' | 'ignored';
    detected_at: string;        // ISO-8601
}

// ---------------------------------------------------------------------------
// IntegrityReport — aggregate result of validateIntegrity()
// ---------------------------------------------------------------------------

export interface IntegrityReport {
    run_at: string;             // ISO-8601
    issues: IntegrityIssue[];
    total_canonical_records: number;
    total_projections: number;
    orphan_count: number;
    duplicate_conflict_count: number;
    projection_mismatch_count: number;
    tombstone_violation_count: number;
    absent_projection_count: number;
    superseded_active_projection_count: number;
}

// ---------------------------------------------------------------------------
// RebuildReport — result of rebuildDerivedState()
// ---------------------------------------------------------------------------

export interface RebuildRequest {
    /** Rebuild only one canonical memory ID. */
    canonicalMemoryId?: string;
    /** Rebuild an explicit list of canonical memory IDs. */
    canonicalMemoryIds?: string[];
    /** Rebuild only items that are stale/missing/out-of-sync in derived projections. */
    staleOnly?: boolean;
    /** Rebuild all canonical records, including tombstoned ones for propagation. */
    fullRebuild?: boolean;
}

export interface RebuildFailure {
    memory_id: string;
    target_system: ProjectionTargetSystem;
    reason: string;
}

export interface RebuildScopeSummary {
    canonical_memory_ids: string[] | 'all';
    stale_only: boolean;
    full_rebuild: boolean;
}

export interface RebuildReport {
    run_at: string;             // ISO-8601
    request_scope: RebuildScopeSummary;
    canonical_records_read: number;
    canonical_ids_processed: string[];
    /** Actions taken (or skipped) during derived rebuild execution */
    actions: RebuildAction[];
    projections_rebuilt: number;
    projections_skipped: number;
    failures: RebuildFailure[];
    partial_failure: boolean;
    /** Any records that could not be reached / had errors */
    unreachable_count: number;
    duration_ms: number;
}

export interface RebuildAction {
    memory_id: string;
    target_system: ProjectionTargetSystem;
    action_kind: 'create' | 'update' | 'skip';
    reason: string;
}
