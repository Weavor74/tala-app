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
// MemoryAuthorityRanking — priority-ordered result from rankMemoryByAuthority()
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

export interface RebuildReport {
    run_at: string;             // ISO-8601
    canonical_records_read: number;
    /** Actions that would be taken (or were taken) to rebuild derived systems */
    actions: RebuildAction[];
    /** Any records that could not be reached / had errors */
    unreachable_count: number;
}

export interface RebuildAction {
    memory_id: string;
    target_system: ProjectionTargetSystem;
    action_kind: 'create' | 'update' | 'skip';
    reason: string;
}
