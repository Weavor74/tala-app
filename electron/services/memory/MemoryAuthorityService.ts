/**
 * MemoryAuthorityService.ts — P7A Memory Authority Lock
 *
 * ARCHITECTURAL CONSTRAINT:
 *   PostgreSQL is the SINGLE SOURCE OF TRUTH for all persistent memory.
 *   Every write MUST flow through this service.
 *
 *   mem0  = cache / abstraction layer (derived)
 *   graph = relationship projection    (derived)
 *   RAG   = retrieval / indexing only  (derived)
 *
 * No derived system may originate or persist authoritative memory.
 */

import crypto from 'crypto';
import type { Pool } from 'pg';
import type {
    ProposedMemoryInput,
    CanonicalMemory,
    DuplicateReport,
    IntegrityReport,
    IntegrityIssue,
    IssueKind,
    IssueSeverity,
    ProjectionRecord,
    ProjectionTargetSystem,
    RebuildReport,
    RebuildAction,
    RebuildRequest,
    RebuildFailure,
    RankedMemoryCandidate,
    MemoryInvocationContext,
    MemoryOperationResult,
    CandidateReviewDecision,
    DerivedCleanupRequest,
    DerivedCleanupReport,
    DerivedCleanupLayer,
    DerivedCleanupLayerOutcome,
    DerivedCleanupFailure,
} from '../../../shared/memory/authorityTypes';
import {
    selectMemoryByAuthority,
    resolveMemoryAuthorityConflict,
} from './derivedWriteGuards';
import { enforceSideEffectWithGuardrails } from '../policy/PolicyEnforcement';
import { TelemetryBus } from '../telemetry/TelemetryBus';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Normalize input text: trim whitespace, collapse internal runs. */
function normalizeText(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
}

/**
 * Compute a canonical SHA-256 hash that is stable across writes.
 * The hash encodes memory_type + subject_type + subject_id + normalised content.
 */
function computeCanonicalHash(input: ProposedMemoryInput): string {
    const normalised = normalizeText(input.content_text);
    const payload = [
        (input.memory_type || '').toLowerCase(),
        (input.subject_type || '').toLowerCase(),
        (input.subject_id || '').toLowerCase(),
        normalised,
    ].join('\x00');
    return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Map a raw memory_records DB row to the CanonicalMemory contract. */
function rowToCanonical(row: Record<string, unknown>): CanonicalMemory {
    return {
        memory_id: row.memory_id as string,
        memory_type: row.memory_type as string,
        subject_type: row.subject_type as string,
        subject_id: row.subject_id as string,
        content_text: row.content_text as string,
        content_structured: (row.content_structured as Record<string, unknown>) ?? null,
        canonical_hash: row.canonical_hash as string,
        authority_status: row.authority_status as CanonicalMemory['authority_status'],
        version: row.version as number,
        confidence: row.confidence as number,
        source_kind: row.source_kind as string,
        source_ref: row.source_ref as string,
        created_at: (row.created_at as Date).toISOString(),
        updated_at: (row.updated_at as Date).toISOString(),
        valid_from: (row.valid_from as Date).toISOString(),
        valid_to: row.valid_to ? (row.valid_to as Date).toISOString() : null,
        tombstoned_at: row.tombstoned_at ? (row.tombstoned_at as Date).toISOString() : null,
        supersedes_memory_id: (row.supersedes_memory_id as string) ?? null,
    };
}

// ---------------------------------------------------------------------------
// Projection targets to fan out to after every canonical commit
// ---------------------------------------------------------------------------
const PROJECTION_TARGETS: ProjectionTargetSystem[] = ['mem0', 'graph', 'vector'];

// ---------------------------------------------------------------------------
// MemoryAuthorityService
// ---------------------------------------------------------------------------

export class MemoryAuthorityService {
    constructor(private readonly pool: Pool) {}

    // -----------------------------------------------------------------------
    // PUBLIC API
    // -----------------------------------------------------------------------

    /**
     * Detect exact and semantic duplicates for a proposed memory write.
     *
     * Phase 1: Exact hash match against memory_records.
     * Phase 2: Placeholder semantic check (stub — full pgvector integration deferred).
     */
    async detectDuplicates(
        input: ProposedMemoryInput & { canonical_hash?: string },
    ): Promise<DuplicateReport> {
        const hash = input.canonical_hash ?? computeCanonicalHash(input);

        // Phase 1: Exact hash match
        const exactResult = await this.pool.query<{ memory_id: string }>(
            `SELECT memory_id FROM memory_records
             WHERE canonical_hash = $1 AND authority_status != 'tombstoned'
             LIMIT 1`,
            [hash],
        );

        if (exactResult.rows.length > 0) {
            return {
                duplicate_found: true,
                matched_memory_id: exactResult.rows[0].memory_id,
                match_score: 1.0,
                match_kind: 'exact',
            };
        }

        // Phase 2: Semantic duplicate detection (stub — pgvector integration deferred)
        // When pgvector embedding is available for memory_records, this will perform
        // a cosine-distance search and return match_kind='semantic' with a score < 1.0.
        // For now, no semantic match is possible without a pre-computed embedding.
        console.debug('[MemoryAuthority] Semantic duplicate check: stub (no embedding available yet)');

        return {
            duplicate_found: false,
            matched_memory_id: null,
            match_score: 0,
            match_kind: 'none',
        };
    }

    /**
     * Validate the integrity of the memory authority layer.
     *
     * Checks performed:
     *   1. Orphan projections (projections referencing non-existent canonical records)
     *   2. Projection version mismatch (projected_version != canonical version)
     *   3. Duplicate canonical conflicts (multiple active 'canonical' records with same hash)
     *   4. Tombstone violations (projections still 'projected' for tombstoned records)
     *
     * Persists each finding to memory_integrity_issues and returns a structured report.
     */
    async validateIntegrity(): Promise<IntegrityReport> {
        const runAt = new Date().toISOString();
        const issues: IntegrityIssue[] = [];

        // --- Count totals ---
        const countResult = await this.pool.query<{ cnt: string }>(
            `SELECT COUNT(*) AS cnt FROM memory_records WHERE authority_status != 'tombstoned'`,
        );
        const totalCanonical = parseInt(countResult.rows[0].cnt, 10);

        const projCountResult = await this.pool.query<{ cnt: string }>(
            `SELECT COUNT(*) AS cnt FROM memory_projections`,
        );
        const totalProjections = parseInt(projCountResult.rows[0].cnt, 10);

        // --- 1. Orphan projection detection ---
        const orphanRows = await this.pool.query<{
            projection_id: string;
            memory_id: string;
            target_system: string;
        }>(
            `SELECT p.projection_id, p.memory_id, p.target_system
             FROM memory_projections p
             LEFT JOIN memory_records r ON r.memory_id = p.memory_id
             WHERE r.memory_id IS NULL`,
        );

        for (const row of orphanRows.rows) {
            const issue = await this._persistIssue({
                issue_kind: 'orphan',
                severity: 'error',
                affected_memory_id: row.memory_id,
                affected_system: row.target_system,
                description: `Projection ${row.projection_id} references memory_id ${row.memory_id} which no longer exists in memory_records`,
                repair_suggestion: `DELETE FROM memory_projections WHERE projection_id = '${row.projection_id}'`,
            });
            issues.push(issue);
        }

        // --- 2. Projection version mismatch ---
        const mismatchRows = await this.pool.query<{
            projection_id: string;
            memory_id: string;
            target_system: string;
            canonical_version: number;
            projected_version: number | null;
        }>(
            `SELECT p.projection_id, p.memory_id, p.target_system,
                    r.version AS canonical_version, p.projected_version
             FROM memory_projections p
             JOIN memory_records r ON r.memory_id = p.memory_id
             WHERE p.projection_status = 'projected'
               AND (p.projected_version IS NULL OR p.projected_version < r.version)`,
        );

        for (const row of mismatchRows.rows) {
            const issue = await this._persistIssue({
                issue_kind: 'projection_mismatch',
                severity: 'warning',
                affected_memory_id: row.memory_id,
                affected_system: row.target_system,
                description: `Projection for memory_id ${row.memory_id} in ${row.target_system} is at version ${row.projected_version ?? 'NULL'} but canonical is v${row.canonical_version}`,
                repair_suggestion: `Re-project memory_id ${row.memory_id} to ${row.target_system}`,
            });
            issues.push(issue);
        }

        // --- 3. Duplicate canonical conflicts (same hash, multiple active canonical rows) ---
        const dupConflictRows = await this.pool.query<{
            canonical_hash: string;
            conflict_count: string;
        }>(
            `SELECT canonical_hash, COUNT(*) AS conflict_count
             FROM memory_records
             WHERE authority_status = 'canonical'
             GROUP BY canonical_hash
             HAVING COUNT(*) > 1`,
        );

        for (const row of dupConflictRows.rows) {
            const issue = await this._persistIssue({
                issue_kind: 'duplicate',
                severity: 'error',
                affected_memory_id: null,
                affected_system: 'postgres',
                description: `${row.conflict_count} canonical records share hash ${row.canonical_hash} — only one should have authority_status='canonical'`,
                repair_suggestion: `Keep the most recent; set older records to authority_status='superseded'`,
            });
            issues.push(issue);
        }

        // --- 4. Tombstone violations (projections still active for tombstoned records) ---
        const tombViolRows = await this.pool.query<{
            projection_id: string;
            memory_id: string;
            target_system: string;
        }>(
            `SELECT p.projection_id, p.memory_id, p.target_system
             FROM memory_projections p
             JOIN memory_records r ON r.memory_id = p.memory_id
             WHERE r.authority_status = 'tombstoned'
               AND p.projection_status = 'projected'`,
        );

        for (const row of tombViolRows.rows) {
            const issue = await this._persistIssue({
                issue_kind: 'tombstone_violation',
                severity: 'critical',
                affected_memory_id: row.memory_id,
                affected_system: row.target_system,
                description: `Projection for tombstoned memory_id ${row.memory_id} still shows status='projected' in ${row.target_system}`,
                repair_suggestion: `Update projection status to 'stale' for memory_id ${row.memory_id} in ${row.target_system}`,
            });
            issues.push(issue);
        }

        // --- 5. Absent projections (canonical records with no projection tracking row) ---
        let absentProjectionCount = 0;
        for (const target of PROJECTION_TARGETS) {
            const absentRows = await this.pool.query<{
                memory_id: string;
                memory_type: string;
            }>(
                `SELECT r.memory_id, r.memory_type
                 FROM memory_records r
                 LEFT JOIN memory_projections p
                   ON p.memory_id = r.memory_id AND p.target_system = $1
                 WHERE r.authority_status = 'canonical'
                   AND p.memory_id IS NULL`,
                [target],
            );

            for (const row of absentRows.rows) {
                absentProjectionCount++;
                const issue = await this._persistIssue({
                    issue_kind: 'absent_projection',
                    severity: 'warning',
                    affected_memory_id: row.memory_id,
                    affected_system: target,
                    description: `Canonical memory_id ${row.memory_id} (type=${row.memory_type}) has no projection record for target_system=${target}`,
                    repair_suggestion: `INSERT INTO memory_projections (memory_id, target_system, projection_status, canonical_version) SELECT memory_id, '${target}', 'pending', version FROM memory_records WHERE memory_id = '${row.memory_id}'`,
                });
                issues.push(issue);
            }
        }

        // --- 6. Superseded records with active projections ---
        const supersededActiveRows = await this.pool.query<{
            projection_id: string;
            memory_id: string;
            target_system: string;
        }>(
            `SELECT p.projection_id, p.memory_id, p.target_system
             FROM memory_projections p
             JOIN memory_records r ON r.memory_id = p.memory_id
             WHERE r.authority_status = 'superseded'
               AND p.projection_status = 'projected'`,
        );

        for (const row of supersededActiveRows.rows) {
            const issue = await this._persistIssue({
                issue_kind: 'superseded_active_projection',
                severity: 'warning',
                affected_memory_id: row.memory_id,
                affected_system: row.target_system,
                description: `Projection for superseded memory_id ${row.memory_id} still shows status='projected' in ${row.target_system} — derived system may surface stale data`,
                repair_suggestion: `Update projection status to 'stale' for memory_id ${row.memory_id} in ${row.target_system}`,
            });
            issues.push(issue);
        }

        console.log(`[MemoryAuthority] Integrity check complete: ${issues.length} issue(s) found`);

        TelemetryBus.getInstance().emit({
            executionId: `mem-integrity-${Date.now()}`,
            subsystem: 'memory',
            event: issues.length > 0 ? 'memory.integrity_drift_detected' : 'memory.integrity_validated',
            payload: {
                issue_count: issues.length,
                orphan_count: orphanRows.rows.length,
                duplicate_conflict_count: dupConflictRows.rows.length,
                tombstone_violation_count: tombViolRows.rows.length,
                absent_projection_count: absentProjectionCount,
                superseded_active_projection_count: supersededActiveRows.rows.length,
            },
        });

        return {
            run_at: runAt,
            issues,
            total_canonical_records: totalCanonical,
            total_projections: totalProjections,
            orphan_count: orphanRows.rows.length,
            duplicate_conflict_count: dupConflictRows.rows.length,
            projection_mismatch_count: mismatchRows.rows.length,
            tombstone_violation_count: tombViolRows.rows.length,
            absent_projection_count: absentProjectionCount,
            superseded_active_projection_count: supersededActiveRows.rows.length,
        };
    }

    /**
     * Rebuild derived state from canonical Postgres records.
     *
     * Executes deterministic canonical-to-derived synchronization for projection metadata.
     * Canonical source is always memory_records; derived projections never become authority.
     */
    async rebuildDerivedState(request: RebuildRequest = {}): Promise<RebuildReport> {
        const startMs = Date.now();
        const runAt = new Date().toISOString();
        const actions: RebuildAction[] = [];
        const failures: RebuildFailure[] = [];
        const processedIds = new Set<string>();
        let unreachableCount = 0;
        let projectionsRebuilt = 0;
        let projectionsSkipped = 0;
        const executionId = `mem-rebuild-${Date.now()}`;
        const bus = TelemetryBus.getInstance();
        const requestWithInternal = request as RebuildRequest & { targetSystems?: ProjectionTargetSystem[] };
        const targetSystems = requestWithInternal.targetSystems && requestWithInternal.targetSystems.length > 0
            ? requestWithInternal.targetSystems
            : PROJECTION_TARGETS;
        const scope = this._normalizeRebuildRequest(request);

        bus.emit({
            executionId,
            subsystem: 'memory',
            event: 'memory.derived_rebuild_requested',
            payload: {
                target: targetSystems.length === 1 ? targetSystems[0] : 'all',
                stale_only: scope.staleOnly,
                full_rebuild: scope.fullRebuild,
                canonical_memory_ids: scope.canonicalMemoryIds.length > 0 ? scope.canonicalMemoryIds : 'all',
            },
        });

        const records = await this._loadCanonicalRecordsForRebuild(scope);
        const projectionCache = new Map<string, ProjectionRecord>();

        for (const record of records) {
            processedIds.add(record.memory_id);
            bus.emit({
                executionId,
                subsystem: 'memory',
                event: 'memory.derived_rebuild_item_started',
                payload: {
                    memory_id: record.memory_id,
                    authority_status: record.authority_status,
                    canonical_version: record.version,
                },
            });

            let itemFailureCount = 0;
            let itemActionCount = 0;

            for (const target of targetSystems) {
                const cacheKey = `${record.memory_id}:${target}`;
                let projection: ProjectionRecord | null = projectionCache.get(cacheKey) ?? null;
                if (!projection) {
                    projection = await this._fetchLatestProjection(record.memory_id, target);
                    if (projection) projectionCache.set(cacheKey, projection);
                }

                if (scope.staleOnly && !this._isProjectionStaleOrMissing(record, projection)) {
                    actions.push({
                        memory_id: record.memory_id,
                        target_system: target,
                        action_kind: 'skip',
                        reason: 'Not stale in staleOnly mode',
                    });
                    projectionsSkipped++;
                    continue;
                }

                const isCurrentProjection = Boolean(
                    projection &&
                    projection.projection_status === 'projected' &&
                    projection.projected_version === record.version &&
                    record.authority_status === 'canonical',
                );
                if (isCurrentProjection && !scope.fullRebuild) {
                    actions.push({
                        memory_id: record.memory_id,
                        target_system: target,
                        action_kind: 'skip',
                        reason: `Already projected at v${record.version}`,
                    });
                    projectionsSkipped++;
                    continue;
                }

                itemActionCount++;
                bus.emit({
                    executionId,
                    subsystem: 'memory',
                    event: 'memory.derived_rebuild_layer_started',
                    payload: {
                        memory_id: record.memory_id,
                        target_system: target,
                        authority_status: record.authority_status,
                        canonical_version: record.version,
                    },
                });

                try {
                    if (record.authority_status === 'tombstoned' || record.authority_status === 'superseded') {
                        const result = await this._applyTombstoneProjectionState(
                            record.memory_id,
                            target,
                            record.version,
                        );
                        actions.push({
                            memory_id: record.memory_id,
                            target_system: target,
                            action_kind: result.created ? 'create' : 'update',
                            reason: `${record.authority_status} canonical memory propagated as stale projection`,
                        });
                        projectionsRebuilt++;
                        bus.emit({
                            executionId,
                            subsystem: 'memory',
                            event: 'memory.derived_rebuild_tombstone_propagated',
                            payload: {
                                memory_id: record.memory_id,
                                target_system: target,
                                authority_status: record.authority_status,
                            },
                        });
                    } else {
                        if (!record.content_text || !record.content_text.trim()) {
                            throw new Error('Canonical record missing content_text');
                        }
                        const result = await this._applyProjectedState(record.memory_id, target, record.version);
                        actions.push({
                            memory_id: record.memory_id,
                            target_system: target,
                            action_kind: result.created ? 'create' : 'update',
                            reason: `Projection synchronized to canonical v${record.version}`,
                        });
                        projectionsRebuilt++;
                    }

                    const refreshed = await this._fetchLatestProjection(record.memory_id, target);
                    if (refreshed) projectionCache.set(cacheKey, refreshed);

                    bus.emit({
                        executionId,
                        subsystem: 'memory',
                        event: 'memory.derived_rebuild_layer_completed',
                        payload: {
                            memory_id: record.memory_id,
                            target_system: target,
                        },
                    });
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    failures.push({
                        memory_id: record.memory_id,
                        target_system: target,
                        reason,
                    });
                    itemFailureCount++;
                    if (reason.includes('missing content_text')) unreachableCount++;
                    actions.push({
                        memory_id: record.memory_id,
                        target_system: target,
                        action_kind: 'skip',
                        reason: `Rebuild failed: ${reason}`,
                    });
                    projectionsSkipped++;
                    bus.emit({
                        executionId,
                        subsystem: 'memory',
                        event: 'memory.derived_rebuild_layer_failed',
                        payload: {
                            memory_id: record.memory_id,
                            target_system: target,
                            error: reason,
                        },
                    });
                }
            }

            bus.emit({
                executionId,
                subsystem: 'memory',
                event: itemFailureCount > 0
                    ? 'memory.derived_rebuild_item_partial_failure'
                    : 'memory.derived_rebuild_item_completed',
                payload: {
                    memory_id: record.memory_id,
                    action_count: itemActionCount,
                    failure_count: itemFailureCount,
                },
            });
        }

        const unreachable = await this.pool.query<{ cnt: string }>(
            `SELECT COUNT(*) AS cnt FROM memory_records WHERE authority_status = 'canonical' AND content_text IS NULL`,
        );
        unreachableCount = Math.max(unreachableCount, parseInt(unreachable.rows[0]?.cnt ?? '0', 10));

        const durationMs = Date.now() - startMs;
        const partialFailure = failures.length > 0;

        bus.emit({
            executionId,
            subsystem: 'memory',
            event: partialFailure ? 'memory.derived_rebuild_partial_failures' : 'memory.derived_rebuild_completed',
            payload: {
                target: targetSystems.length === 1 ? targetSystems[0] : 'all',
                stale_only: scope.staleOnly,
                full_rebuild: scope.fullRebuild,
                canonical_records_read: records.length,
                canonical_ids_processed: processedIds.size,
                projections_rebuilt: projectionsRebuilt,
                projections_skipped: projectionsSkipped,
                failure_count: failures.length,
                unreachable_count: unreachableCount,
                duration_ms: durationMs,
            },
        });

        return {
            run_at: runAt,
            request_scope: {
                canonical_memory_ids: scope.canonicalMemoryIds.length > 0 ? scope.canonicalMemoryIds : 'all',
                stale_only: scope.staleOnly,
                full_rebuild: scope.fullRebuild,
            },
            canonical_records_read: records.length,
            canonical_ids_processed: [...processedIds],
            actions,
            projections_rebuilt: projectionsRebuilt,
            projections_skipped: projectionsSkipped,
            failures,
            partial_failure: partialFailure,
            unreachable_count: unreachableCount,
            duration_ms: durationMs,
        };
    }
    /** Rebuild mem0 projection state from canonical Postgres records. */
    async rebuildMem0FromCanonical(request: RebuildRequest = {}): Promise<RebuildReport> {
        return this._rebuildTargetFromCanonical('mem0', request);
    }

    /** Rebuild graph projection state from canonical Postgres records. */
    async rebuildGraphFromCanonical(request: RebuildRequest = {}): Promise<RebuildReport> {
        return this._rebuildTargetFromCanonical('graph', request);
    }

    /** Rebuild vector projection state from canonical Postgres records. */
    async rebuildVectorIndexFromCanonical(request: RebuildRequest = {}): Promise<RebuildReport> {
        return this._rebuildTargetFromCanonical('vector', request);
    }

    // -----------------------------------------------------------------------
    // UNIFIED CRUD FACADE
    // Single entrypoint for memory create / read / update / delete.
    // Each method delegates directly to the private mutation core.
    // No try/catch needed here — core methods are non-throwing.
    // -----------------------------------------------------------------------

    /**
     * Create a new memory record.
     *
     * Delegates to {@link _createCanonicalMemoryCore}.  All errors (including
     * PolicyDeniedError) are returned as `{ success: false, error }` rather
     * than thrown.
     *
     * @param input  Proposed memory input to canonicalize.
     * @param ctx    Optional invocation context for telemetry alignment and
     *               executionMode forwarding.
     * @returns      `MemoryOperationResult<string>` where `data` is the
     *               canonical_memory_id (existing on duplicate, new on create).
     */
    async createMemory(
        input: ProposedMemoryInput,
        ctx?: MemoryInvocationContext,
    ): Promise<MemoryOperationResult<string>> {
        const writeOperationId = ctx?.executionId ?? `mem-write-${crypto.randomBytes(8).toString('hex')}`;
        return this._createCanonicalMemoryCore(input, writeOperationId);
    }

    /**
     * Canonical create API alias used by authority-governed callers.
     * Equivalent to tryCreateCanonicalMemory().
     */
    async createCanonicalMemory(
        input: ProposedMemoryInput,
        ctx?: MemoryInvocationContext,
    ): Promise<MemoryOperationResult<string>> {
        return this.tryCreateCanonicalMemory(input, ctx);
    }

    /**
     * Read a single canonical memory record by its ID.
     * Returns null when the record does not exist.
     */
    async readMemory(memoryId: string): Promise<CanonicalMemory | null> {
        return this._fetchRecord(memoryId);
    }

    /**
     * Update an existing canonical memory record.
     *
     * Delegates to {@link _updateCanonicalMemoryCore}.  All errors (including
     * PolicyDeniedError) are returned as `{ success: false, error }` rather
     * than thrown.
     *
     * @param memoryId  UUID of the canonical record to update.
     * @param updates   Fields to update on the record.
     * @param ctx       Optional invocation context for telemetry alignment,
     *                  executionMode, and executionId forwarding.
     * @returns         `MemoryOperationResult<CanonicalMemory>` where `data`
     *                  is the updated canonical record on success.
     */
    async updateMemory(
        memoryId: string,
        updates: Partial<Pick<ProposedMemoryInput, 'content_text' | 'content_structured' | 'confidence' | 'valid_to'>>,
        ctx?: MemoryInvocationContext,
    ): Promise<MemoryOperationResult<CanonicalMemory>> {
        const writeOperationId = ctx?.executionId ?? `mem-write-${crypto.randomBytes(8).toString('hex')}`;
        return this._updateCanonicalMemoryCore(memoryId, updates, ctx?.executionMode, writeOperationId);
    }

    /**
     * Canonical update API alias used by authority-governed callers.
     * Equivalent to tryUpdateCanonicalMemory().
     */
    async updateCanonicalMemory(
        memoryId: string,
        updates: Partial<Pick<ProposedMemoryInput, 'content_text' | 'content_structured' | 'confidence' | 'valid_to'>>,
        ctx?: MemoryInvocationContext,
    ): Promise<MemoryOperationResult<CanonicalMemory>> {
        return this.tryUpdateCanonicalMemory(memoryId, updates, ctx);
    }

    /**
     * Delete (tombstone) a canonical memory record.
     *
     * Delegates to {@link _tombstoneMemoryCore}.  All errors (including
     * PolicyDeniedError) are returned as `{ success: false, error }` rather
     * than thrown.
     *
     * Records are never physically deleted — tombstoning preserves referential
     * integrity for lineage and rebuild operations.
     *
     * @param memoryId  UUID of the canonical record to tombstone.
     * @param ctx       Optional invocation context for telemetry alignment,
     *                  executionMode, and executionId forwarding.
     * @returns         `MemoryOperationResult<void>` — `data` is undefined.
     */
    async deleteMemory(
        memoryId: string,
        ctx?: MemoryInvocationContext,
    ): Promise<MemoryOperationResult<void>> {
        const writeOperationId = ctx?.executionId ?? `mem-write-${crypto.randomBytes(8).toString('hex')}`;
        return this._tombstoneMemoryCore(memoryId, ctx?.executionMode, writeOperationId);
    }

    /**
     * Canonical tombstone API alias used by authority-governed callers.
     * Equivalent to tryTombstoneMemory().
     */
    async tombstoneCanonicalMemory(
        memoryId: string,
        ctx?: MemoryInvocationContext,
    ): Promise<MemoryOperationResult<void>> {
        return this.tryTombstoneMemory(memoryId, ctx);
    }

    /**
     * Canonical integrity validation alias used by authority-governed callers.
     * Equivalent to validateIntegrity().
     */
    async validateAuthorityIntegrity(): Promise<IntegrityReport> {
        return this.validateIntegrity();
    }

    /**
     * Cleanup/invalidate derived artifacts for canonically inactive memory.
     *
     * Source of truth is always memory_records authority_status.
     * This method never promotes derived state and is safe to rerun.
     */
    async cleanupDerivedState(request: DerivedCleanupRequest = {}): Promise<DerivedCleanupReport> {
        const startMs = Date.now();
        const runAt = new Date().toISOString();
        const executionId = `mem-cleanup-${Date.now()}`;
        const bus = TelemetryBus.getInstance();
        const scope = this._normalizeDerivedCleanupRequest(request);
        const failures: DerivedCleanupFailure[] = [];
        const itemOutcomes: Array<{
            canonical_memory_id: string;
            authority_status: CanonicalMemory['authority_status'];
            layer_outcomes: DerivedCleanupLayerOutcome[];
        }> = [];
        const layersAttempted: DerivedCleanupLayer[] = [
            'projection_metadata',
            'mem0_external',
            'graph_external',
            'vector_external',
        ];

        let cleanedCount = 0;
        let invalidatedCount = 0;
        let skippedCount = 0;
        let noopCount = 0;
        let failedCount = 0;
        const processed = new Set<string>();

        bus.emit({
            executionId,
            subsystem: 'memory',
            event: 'memory.derived_cleanup_requested',
            payload: {
                canonical_memory_ids: scope.canonicalMemoryIds.length > 0 ? scope.canonicalMemoryIds : 'inactive',
                inactive_only: scope.inactiveOnly,
                reason: scope.reason ?? null,
            },
        });

        const records = await this._loadCanonicalRecordsForDerivedCleanup(scope);
        for (const record of records) {
            processed.add(record.memory_id);
            const layerOutcomes: DerivedCleanupLayerOutcome[] = [];
            bus.emit({
                executionId,
                subsystem: 'memory',
                event: 'memory.derived_cleanup_item_started',
                payload: {
                    memory_id: record.memory_id,
                    authority_status: record.authority_status,
                },
            });

            if (record.authority_status !== 'tombstoned' && record.authority_status !== 'superseded') {
                layerOutcomes.push({
                    layer: 'projection_metadata',
                    outcome: 'skipped',
                    detail: `canonical_status_not_inactive:${record.authority_status}`,
                });
                skippedCount++;
            } else {
                try {
                    bus.emit({
                        executionId,
                        subsystem: 'memory',
                        event: 'memory.derived_cleanup_layer_started',
                        payload: { memory_id: record.memory_id, layer: 'projection_metadata' },
                    });
                    await this.pool.query(
                        `UPDATE memory_projections
                         SET projection_status = 'stale',
                             projected_version = NULL,
                             attempted_at = NOW(),
                             projected_at = NULL,
                             error_message = COALESCE(error_message, 'canonical_inactive'),
                             updated_at = NOW()
                         WHERE memory_id = $1
                           AND projection_status != 'stale'`,
                        [record.memory_id],
                    );
                    layerOutcomes.push({
                        layer: 'projection_metadata',
                        outcome: 'invalidated',
                        detail: `projection_state_marked_stale_from_${record.authority_status}`,
                    });
                    invalidatedCount++;
                    bus.emit({
                        executionId,
                        subsystem: 'memory',
                        event: 'memory.derived_cleanup_layer_completed',
                        payload: {
                            memory_id: record.memory_id,
                            layer: 'projection_metadata',
                            outcome: 'invalidated',
                        },
                    });
                } catch (err) {
                    const reason = err instanceof Error ? err.message : String(err);
                    layerOutcomes.push({
                        layer: 'projection_metadata',
                        outcome: 'failed',
                        detail: reason,
                    });
                    failures.push({
                        canonical_memory_id: record.memory_id,
                        layer: 'projection_metadata',
                        reason,
                    });
                    failedCount++;
                    bus.emit({
                        executionId,
                        subsystem: 'memory',
                        event: 'memory.derived_cleanup_layer_failed',
                        payload: {
                            memory_id: record.memory_id,
                            layer: 'projection_metadata',
                            reason,
                        },
                    });
                }
            }

            for (const layer of ['mem0_external', 'graph_external', 'vector_external'] as const) {
                layerOutcomes.push({
                    layer,
                    outcome: 'noop',
                    detail: 'adapter_not_configured_in_repository',
                });
                noopCount++;
                bus.emit({
                    executionId,
                    subsystem: 'memory',
                    event: 'memory.derived_cleanup_layer_noop',
                    payload: {
                        memory_id: record.memory_id,
                        layer,
                        reason: 'adapter_not_configured_in_repository',
                    },
                });
            }

            itemOutcomes.push({
                canonical_memory_id: record.memory_id,
                authority_status: record.authority_status,
                layer_outcomes: layerOutcomes,
            });
        }

        const partialFailure = failures.length > 0;
        const report: DerivedCleanupReport = {
            run_at: runAt,
            request_scope: {
                canonical_memory_ids: scope.canonicalMemoryIds.length > 0 ? scope.canonicalMemoryIds : 'inactive',
                inactive_only: scope.inactiveOnly,
                reason: scope.reason,
            },
            canonical_ids_processed: [...processed],
            layers_attempted: layersAttempted,
            cleaned_count: cleanedCount,
            invalidated_count: invalidatedCount,
            skipped_count: skippedCount,
            noop_count: noopCount,
            failed_count: failedCount,
            item_outcomes: itemOutcomes,
            failures,
            partial_failure: partialFailure,
            duration_ms: Date.now() - startMs,
        };

        bus.emit({
            executionId,
            subsystem: 'memory',
            event: partialFailure ? 'memory.derived_cleanup_completed_with_partial_failures' : 'memory.derived_cleanup_completed',
            payload: {
                canonical_ids_processed: report.canonical_ids_processed.length,
                invalidated_count: invalidatedCount,
                skipped_count: skippedCount,
                noop_count: noopCount,
                failed_count: failedCount,
                duration_ms: report.duration_ms,
            },
        });

        return report;
    }

    /**
     * Deterministic merge path:
     * - target memory remains canonical source of truth
     * - source memory is superseded and tombstoned
     * - derived projections are marked stale for both records
     */
    async mergeCanonicalMemory(
        sourceMemoryId: string,
        targetMemoryId: string,
        mergeReason: string,
        ctx?: MemoryInvocationContext,
    ): Promise<MemoryOperationResult<CandidateReviewDecision>> {
        const executionId = ctx?.executionId ?? `mem-merge-${crypto.randomBytes(8).toString('hex')}`;
        const bus = TelemetryBus.getInstance();
        const startTime = Date.now();
        try {
            await enforceSideEffectWithGuardrails(
                'memory',
                {
                    actionKind: 'memory_write',
                    executionMode: ctx?.executionMode,
                    targetSubsystem: 'MemoryAuthorityService',
                    mutationIntent: 'write',
                },
                {
                    operation: 'merge',
                    sourceMemoryId,
                    targetMemoryId,
                    mergeReason,
                },
            );

            const source = await this._fetchRecord(sourceMemoryId);
            const target = await this._fetchRecord(targetMemoryId);
            if (!source) {
                throw new Error(`[MemoryAuthority] Cannot merge: source memory_id ${sourceMemoryId} not found`);
            }
            if (!target) {
                throw new Error(`[MemoryAuthority] Cannot merge: target memory_id ${targetMemoryId} not found`);
            }
            if (source.authority_status === 'tombstoned') {
                throw new Error(`[MemoryAuthority] Cannot merge tombstoned source memory ${sourceMemoryId}`);
            }
            if (target.authority_status === 'tombstoned') {
                throw new Error(`[MemoryAuthority] Cannot merge into tombstoned target memory ${targetMemoryId}`);
            }

            const mergedText = target.content_text.includes(source.content_text)
                ? target.content_text
                : `${target.content_text}\n\n[MERGED:${source.memory_id}] ${source.content_text}`;

            const mergedStructured: Record<string, unknown> = {
                ...(target.content_structured ?? {}),
                merged_from_memory_ids: Array.from(
                    new Set([
                        ...(((target.content_structured as Record<string, unknown> | null)?.merged_from_memory_ids as string[]) ?? []),
                        source.memory_id,
                    ]),
                ),
                merge_reason: mergeReason,
                merged_at: new Date().toISOString(),
            };

            const updateResult = await this._updateCanonicalMemoryCore(
                target.memory_id,
                {
                    content_text: mergedText,
                    content_structured: mergedStructured,
                    confidence: Math.max(target.confidence, source.confidence),
                },
                ctx?.executionMode,
                executionId,
            );
            if (!updateResult.success) {
                throw new Error(updateResult.error ?? 'merge update failed');
            }

            await this.pool.query(
                `UPDATE memory_records
                 SET authority_status = 'superseded',
                     supersedes_memory_id = $2,
                     tombstoned_at = COALESCE(tombstoned_at, NOW()),
                     updated_at = NOW()
                 WHERE memory_id = $1`,
                [source.memory_id, target.memory_id],
            );
            await this._markProjectionsStale(source.memory_id);
            await this.cleanupDerivedState({
                canonicalMemoryId: source.memory_id,
                reason: 'superseded',
            });

            const decision: CandidateReviewDecision = {
                candidate_id: source.memory_id,
                decision: 'merge',
                decided_at: new Date().toISOString(),
                decided_by: 'MemoryAuthorityService',
                reason: mergeReason,
                canonical_memory_id: target.memory_id,
                merged_into_memory_id: target.memory_id,
            };

            bus.emit({
                executionId,
                subsystem: 'memory',
                event: 'memory.canonical_merged',
                payload: {
                    source_memory_id: source.memory_id,
                    target_memory_id: target.memory_id,
                    reason: mergeReason,
                },
            });

            return { success: true, data: decision, durationMs: Date.now() - startTime };
        } catch (err) {
            bus.emit({
                executionId,
                subsystem: 'memory',
                event: 'memory.write_failed',
                payload: { operation: 'merge', source_memory_id: sourceMemoryId, target_memory_id: targetMemoryId, error: String(err) },
            });
            const error = err instanceof Error ? err.message : String(err);
            const _cause = err instanceof Error ? err : undefined;
            return { success: false, error, durationMs: Date.now() - startTime, _cause };
        }
    }

    // -----------------------------------------------------------------------
    // NORMALIZED CANONICAL WRAPPERS  ◄─ PREFERRED MUTATION API
    //
    // These are the canonical mutation entry points for all callers.  They
    // return MemoryOperationResult<T> instead of throwing, making failure
    // handling deterministic and decoupling callers from raw exception semantics.
    //
    // Preferred methods (use these):
    //   tryCreateCanonicalMemory(input, ctx?)  → MemoryOperationResult<string>
    //   tryUpdateCanonicalMemory(id, updates, ctx?)  → MemoryOperationResult<CanonicalMemory>
    //   tryTombstoneMemory(id, ctx?)  → MemoryOperationResult<void>
    //
    // Alternatively, the CRUD facade (createMemory / updateMemory / deleteMemory)
    // provides the same result-based contract and may be more ergonomic for
    // callers that do not need the canonical* nomenclature.
    //
    // All six public non-throwing methods delegate directly to the private
    // _*Core methods.  There is no wrapper indirection layer.
    // -----------------------------------------------------------------------

    /**
     * Non-throwing preferred entry point for canonical memory creation.
     *
     * Delegates directly to {@link _createCanonicalMemoryCore}.  All errors —
     * including PolicyDeniedError and DB failures — are captured and returned
     * as `{ success: false, error }`.
     *
     * @param input  Proposed memory input to canonicalize.
     * @param ctx    Optional invocation context.  ctx.executionId is forwarded
     *               as the telemetry correlation ID.
     * @returns      `MemoryOperationResult<string>` where `data` is the
     *               canonical_memory_id on success.
     */
    async tryCreateCanonicalMemory(
        input: ProposedMemoryInput,
        ctx?: MemoryInvocationContext,
    ): Promise<MemoryOperationResult<string>> {
        const writeOperationId = ctx?.executionId ?? `mem-write-${crypto.randomBytes(8).toString('hex')}`;
        return this._createCanonicalMemoryCore(input, writeOperationId);
    }

    /**
     * Non-throwing preferred entry point for canonical memory update.
     *
     * Delegates directly to {@link _updateCanonicalMemoryCore}.  All errors —
     * including PolicyDeniedError and DB failures — are captured and returned
     * as `{ success: false, error }`.
     *
     * @param memoryId  UUID of the canonical record to update.
     * @param updates   Fields to update on the record.
     * @param ctx       Optional invocation context.
     * @returns         `MemoryOperationResult<CanonicalMemory>` where `data` is
     *                  the updated record on success.
     */
    async tryUpdateCanonicalMemory(
        memoryId: string,
        updates: Partial<Pick<ProposedMemoryInput, 'content_text' | 'content_structured' | 'confidence' | 'valid_to'>>,
        ctx?: MemoryInvocationContext,
    ): Promise<MemoryOperationResult<CanonicalMemory>> {
        const writeOperationId = ctx?.executionId ?? `mem-write-${crypto.randomBytes(8).toString('hex')}`;
        return this._updateCanonicalMemoryCore(memoryId, updates, ctx?.executionMode, writeOperationId);
    }

    /**
     * Non-throwing preferred entry point for canonical memory tombstoning.
     *
     * Delegates directly to {@link _tombstoneMemoryCore}.  All errors —
     * including PolicyDeniedError and DB failures — are captured and returned
     * as `{ success: false, error }`.
     *
     * @param memoryId  UUID of the canonical record to tombstone.
     * @param ctx       Optional invocation context.
     * @returns         `MemoryOperationResult<void>` — `data` is undefined.
     */
    async tryTombstoneMemory(
        memoryId: string,
        ctx?: MemoryInvocationContext,
    ): Promise<MemoryOperationResult<void>> {
        const writeOperationId = ctx?.executionId ?? `mem-write-${crypto.randomBytes(8).toString('hex')}`;
        return this._tombstoneMemoryCore(memoryId, ctx?.executionMode, writeOperationId);
    }

    /**
     * Rank a set of memory candidates by authority tier.
     *
     * Order: canonical > verified_derived > transient > speculative
     * This is deterministic — no ML judgment.
     */
    selectMemoryByAuthority(
        candidates: Parameters<typeof selectMemoryByAuthority>[0],
    ): RankedMemoryCandidate[] {
        return selectMemoryByAuthority(candidates);
    }

    /**
     * Resolve a conflict between a canonical and a derived memory record.
     * Canonical always wins. The conflict is logged for diagnostics.
     */
    resolveMemoryAuthorityConflict(
        canonical: { memory_id: string; content_text: string; version: number },
        derived: { content: string; canonical_memory_id: string | null },
        source: string,
    ): { winner_content: string; conflict_logged: boolean } {
        return resolveMemoryAuthorityConflict(canonical, derived, source);
    }

    // -----------------------------------------------------------------------
    // PRIVATE HELPERS
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // PRIVATE MUTATION CORE  ◄─ SINGLE SOURCE OF TRUTH FOR MUTATION LOGIC
    //
    // These private methods contain the full implementation for each canonical
    // mutation operation.  They are non-throwing — all errors (DB, policy,
    // validation) are captured and returned as MemoryOperationResult<T>.
    //
    // All public-facing methods (CRUD facade and try* wrappers) delegate here.
    // There is no duplicated mutation logic outside these three methods.
    //
    // Telemetry contract preserved:
    //   - memory.write_requested emitted after policy check, before DB work
    //   - memory.write_completed emitted on success (including idempotent case)
    //   - memory.write_failed emitted on any error (policy, validation, DB)
    // -----------------------------------------------------------------------

    /**
     * Non-throwing implementation core for canonical memory creation.
     *
     * All public create paths delegate here.  Never throws; all errors are
     * returned as `{ success: false, error, durationMs }`.
     *
     * @param input            Proposed memory input to canonicalize.
     * @param writeOperationId Telemetry correlation ID (caller-supplied or
     *                         auto-generated by the delegating public method).
     */
    private async _createCanonicalMemoryCore(
        input: ProposedMemoryInput,
        writeOperationId: string,
    ): Promise<MemoryOperationResult<string>> {
        const startTime = Date.now();
        const bus = TelemetryBus.getInstance();
        try {
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.candidate_proposed',
                payload: {
                    source_kind: input.source_kind ?? 'unknown',
                    source_ref: input.source_ref ?? null,
                    memory_type: input.memory_type,
                    subject_type: input.subject_type,
                    subject_id: input.subject_id,
                },
            });

            await enforceSideEffectWithGuardrails(
                'memory',
                {
                    actionKind: 'memory_write',
                    targetSubsystem: 'MemoryAuthorityService',
                    mutationIntent: 'canonical_memory_write',
                    executionId: writeOperationId,
                },
                {
                    operation: 'create',
                    memory_type: input.memory_type,
                    subject_type: input.subject_type,
                    subject_id: input.subject_id,
                    content_text: input.content_text,
                },
            );

            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.write_requested',
                payload: { operation: 'create', memory_type: input.memory_type, subject_type: input.subject_type },
            });

            const hash = computeCanonicalHash(input);
            const dup = await this.detectDuplicates({ ...input, canonical_hash: hash });
            if (dup.duplicate_found && dup.matched_memory_id) {
                console.log(
                    `[MemoryAuthority] Duplicate detected (${dup.match_kind}, score=${dup.match_score}) → returning existing ${dup.matched_memory_id}`,
                );
                await this._recordDuplicate(dup.matched_memory_id, null, hash, dup.match_kind, dup.match_score);
                bus.emit({
                    executionId: writeOperationId,
                    subsystem: 'memory',
                    event: 'memory.candidate_deferred',
                    payload: {
                        reason: 'duplicate',
                        matched_memory_id: dup.matched_memory_id,
                        match_kind: dup.match_kind,
                        match_score: dup.match_score,
                    },
                });
                bus.emit({
                    executionId: writeOperationId,
                    subsystem: 'memory',
                    event: 'memory.write_completed',
                    payload: { operation: 'create', memory_id: dup.matched_memory_id, duplicate: true },
                });
                return { success: true, data: dup.matched_memory_id, durationMs: Date.now() - startTime };
            }

            const normalised = normalizeText(input.content_text);
            const result = await this.pool.query<{ memory_id: string }>(
                `INSERT INTO memory_records
                    (memory_type, subject_type, subject_id, content_text, content_structured,
                     canonical_hash, authority_status, version, confidence,
                     source_kind, source_ref, valid_from, valid_to)
                 VALUES ($1,$2,$3,$4,$5,$6,'canonical',1,$7,$8,$9,
                         COALESCE($10::timestamptz, NOW()),
                         $11::timestamptz)
                 RETURNING memory_id`,
                [
                    input.memory_type,
                    input.subject_type,
                    input.subject_id,
                    normalised,
                    input.content_structured ? JSON.stringify(input.content_structured) : null,
                    hash,
                    input.confidence ?? 1.0,
                    input.source_kind ?? 'unknown',
                    input.source_ref ?? '',
                    input.valid_from ?? null,
                    input.valid_to ?? null,
                ],
            );

            const memoryId = result.rows[0].memory_id;
            await this._appendLineage(memoryId, null, 1, 'create', [], null, hash, 'system');
            await this._emitProjectionEvents(memoryId, 1);

            console.log(`[MemoryAuthority] Canonical record created: ${memoryId} (type=${input.memory_type})`);
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.candidate_accepted',
                payload: {
                    memory_id: memoryId,
                    source_kind: input.source_kind ?? 'unknown',
                    source_ref: input.source_ref ?? null,
                    memory_type: input.memory_type,
                },
            });
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.write_completed',
                payload: { operation: 'create', memory_id: memoryId, memory_type: input.memory_type },
            });
            return { success: true, data: memoryId, durationMs: Date.now() - startTime };
        } catch (err) {
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.candidate_rejected',
                payload: {
                    reason: String(err),
                    source_kind: input.source_kind ?? 'unknown',
                    source_ref: input.source_ref ?? null,
                },
            });
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.write_failed',
                payload: { operation: 'create', memory_type: input.memory_type, error: String(err) },
            });
            const error = err instanceof Error ? err.message : String(err);
            const _cause = err instanceof Error ? err : undefined;
            return { success: false, error, durationMs: Date.now() - startTime, _cause };
        }
    }

    /**
     * Non-throwing implementation core for canonical memory update.
     *
     * All public update paths delegate here.  Never throws; all errors are
     * returned as `{ success: false, error, durationMs }`.
     *
     * @param memoryId         UUID of the canonical record to update.
     * @param updates          Fields to update on the record.
     * @param executionMode    Optional execution mode forwarded to the policy gate.
     * @param writeOperationId Telemetry correlation ID.
     */
    private async _updateCanonicalMemoryCore(
        memoryId: string,
        updates: Partial<Pick<ProposedMemoryInput, 'content_text' | 'content_structured' | 'confidence' | 'valid_to'>>,
        executionMode: string | undefined,
        writeOperationId: string,
    ): Promise<MemoryOperationResult<CanonicalMemory>> {
        const startTime = Date.now();
        const bus = TelemetryBus.getInstance();
        try {
            await enforceSideEffectWithGuardrails(
                'memory',
                {
                    actionKind: 'memory_write',
                    executionMode,
                    targetSubsystem: 'MemoryAuthorityService',
                    mutationIntent: 'write',
                    executionId: writeOperationId,
                },
                {
                    operation: 'update',
                    memory_id: memoryId,
                    updates: updates as Record<string, unknown>,
                },
            );

            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.write_requested',
                payload: { operation: 'update', memory_id: memoryId },
            });

            const existing = await this._fetchRecord(memoryId);
            if (!existing) {
                throw new Error(`[MemoryAuthority] Cannot update: memory_id ${memoryId} not found`);
            }
            if (existing.authority_status === 'tombstoned') {
                throw new Error(`[MemoryAuthority] Cannot update tombstoned memory: ${memoryId}`);
            }

            const newContentText = updates.content_text != null
                ? normalizeText(updates.content_text)
                : existing.content_text;

            const newHash = computeCanonicalHash({
                memory_type: existing.memory_type,
                subject_type: existing.subject_type,
                subject_id: existing.subject_id,
                content_text: newContentText,
            });

            const priorHash = existing.canonical_hash;
            const newVersion = existing.version + 1;
            const changedFields: string[] = [];
            if (updates.content_text != null) changedFields.push('content_text');
            if (updates.content_structured != null) changedFields.push('content_structured');
            if (updates.confidence != null) changedFields.push('confidence');
            if (updates.valid_to != null) changedFields.push('valid_to');

            const result = await this.pool.query<Record<string, unknown>>(
                `UPDATE memory_records SET
                    content_text       = COALESCE($2, content_text),
                    content_structured = COALESCE($3::jsonb, content_structured),
                    confidence         = COALESCE($4, confidence),
                    valid_to           = COALESCE($5::timestamptz, valid_to),
                    canonical_hash     = $6,
                    version            = $7,
                    updated_at         = NOW()
                 WHERE memory_id = $1
                 RETURNING *`,
                [
                    memoryId,
                    updates.content_text != null ? newContentText : null,
                    updates.content_structured != null ? JSON.stringify(updates.content_structured) : null,
                    updates.confidence ?? null,
                    updates.valid_to ?? null,
                    newHash,
                    newVersion,
                ],
            );

            const updated = rowToCanonical(result.rows[0]);
            await this._appendLineage(memoryId, null, newVersion, 'update', changedFields, priorHash, newHash, 'system');
            await this._markProjectionsStale(memoryId);

            console.log(`[MemoryAuthority] Record updated: ${memoryId} -> v${newVersion}`);
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.canonical_updated',
                payload: { memory_id: memoryId, version: newVersion },
            });
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.write_completed',
                payload: { operation: 'update', memory_id: memoryId, version: newVersion },
            });
            return { success: true, data: updated, durationMs: Date.now() - startTime };
        } catch (err) {
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.write_failed',
                payload: { operation: 'update', memory_id: memoryId, error: String(err) },
            });
            const error = err instanceof Error ? err.message : String(err);
            const _cause = err instanceof Error ? err : undefined;
            return { success: false, error, durationMs: Date.now() - startTime, _cause };
        }
    }

    /**
     * Non-throwing implementation core for canonical memory tombstoning.
     *
     * All public tombstone/delete paths delegate here.  Never throws; all
     * errors are returned as `{ success: false, error, durationMs }`.
     *
     * @param memoryId         UUID of the canonical record to tombstone.
     * @param executionMode    Optional execution mode forwarded to the policy gate.
     * @param writeOperationId Telemetry correlation ID.
     */
    private async _tombstoneMemoryCore(
        memoryId: string,
        executionMode: string | undefined,
        writeOperationId: string,
    ): Promise<MemoryOperationResult<void>> {
        const startTime = Date.now();
        const bus = TelemetryBus.getInstance();
        try {
            await enforceSideEffectWithGuardrails(
                'memory',
                {
                    actionKind: 'memory_write',
                    executionMode,
                    targetSubsystem: 'MemoryAuthorityService',
                    mutationIntent: 'write',
                    executionId: writeOperationId,
                },
                {
                    operation: 'delete',
                    memory_id: memoryId,
                },
            );

            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.write_requested',
                payload: { operation: 'delete', memory_id: memoryId },
            });

            const existing = await this._fetchRecord(memoryId);
            if (!existing) {
                throw new Error(`[MemoryAuthority] Cannot tombstone: memory_id ${memoryId} not found`);
            }
            if (existing.authority_status === 'tombstoned') {
                console.warn(`[MemoryAuthority] Memory ${memoryId} already tombstoned — skipping`);
                bus.emit({
                    executionId: writeOperationId,
                    subsystem: 'memory',
                    event: 'memory.write_completed',
                    payload: { operation: 'delete', memory_id: memoryId, idempotent: true },
                });
                return { success: true, durationMs: Date.now() - startTime };
            }

            await this.pool.query(
                `UPDATE memory_records
                 SET tombstoned_at = NOW(), authority_status = 'tombstoned', updated_at = NOW()
                 WHERE memory_id = $1`,
                [memoryId],
            );

            await this._appendLineage(
                memoryId,
                null,
                existing.version,
                'tombstone',
                ['tombstoned_at', 'authority_status'],
                existing.canonical_hash,
                existing.canonical_hash,
                'system',
            );
            await this._markProjectionsStale(memoryId);
            await this.cleanupDerivedState({
                canonicalMemoryId: memoryId,
                reason: 'tombstone',
            });

            console.log(`[MemoryAuthority] Record tombstoned: ${memoryId}`);
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.canonical_tombstoned',
                payload: { memory_id: memoryId },
            });
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.write_completed',
                payload: { operation: 'delete', memory_id: memoryId },
            });
            return { success: true, durationMs: Date.now() - startTime };
        } catch (err) {
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.write_failed',
                payload: { operation: 'delete', memory_id: memoryId, error: String(err) },
            });
            const error = err instanceof Error ? err.message : String(err);
            const _cause = err instanceof Error ? err : undefined;
            return { success: false, error, durationMs: Date.now() - startTime, _cause };
        }
    }

    /** Core rebuild implementation for a specific target system. */
    private async _rebuildTargetFromCanonical(
        target: ProjectionTargetSystem,
        request: RebuildRequest = {},
    ): Promise<RebuildReport> {
        const internalRequest = {
            ...request,
            targetSystems: [target],
        } as RebuildRequest & { targetSystems: ProjectionTargetSystem[] };
        return this.rebuildDerivedState(internalRequest);
    }

    private _normalizeRebuildRequest(request: RebuildRequest): {
        canonicalMemoryIds: string[];
        staleOnly: boolean;
        fullRebuild: boolean;
    } {
        const ids = new Set<string>();
        if (request.canonicalMemoryId && request.canonicalMemoryId.trim()) {
            ids.add(request.canonicalMemoryId.trim());
        }
        for (const id of request.canonicalMemoryIds ?? []) {
            if (id && id.trim()) ids.add(id.trim());
        }
        return {
            canonicalMemoryIds: [...ids],
            staleOnly: Boolean(request.staleOnly),
            fullRebuild: Boolean(request.fullRebuild),
        };
    }

    private _normalizeDerivedCleanupRequest(request: DerivedCleanupRequest): {
        canonicalMemoryIds: string[];
        inactiveOnly: boolean;
        reason?: string;
    } {
        const ids = new Set<string>();
        if (request.canonicalMemoryId && request.canonicalMemoryId.trim()) {
            ids.add(request.canonicalMemoryId.trim());
        }
        for (const id of request.canonicalMemoryIds ?? []) {
            if (id && id.trim()) ids.add(id.trim());
        }
        return {
            canonicalMemoryIds: [...ids],
            inactiveOnly: request.inactiveOnly ?? ids.size === 0,
            reason: request.reason,
        };
    }

    private async _loadCanonicalRecordsForDerivedCleanup(scope: {
        canonicalMemoryIds: string[];
        inactiveOnly: boolean;
    }): Promise<Array<{
        memory_id: string;
        authority_status: CanonicalMemory['authority_status'];
    }>> {
        if (scope.canonicalMemoryIds.length > 0) {
            const explicitRows = await this.pool.query<{
                memory_id: string;
                authority_status: CanonicalMemory['authority_status'];
            }>(
                `SELECT memory_id, authority_status
                 FROM memory_records
                 WHERE memory_id = ANY($1::uuid[])
                 ORDER BY created_at ASC`,
                [scope.canonicalMemoryIds],
            );
            return explicitRows.rows;
        }

        if (!scope.inactiveOnly) {
            const allRows = await this.pool.query<{
                memory_id: string;
                authority_status: CanonicalMemory['authority_status'];
            }>(
                `SELECT memory_id, authority_status
                 FROM memory_records
                 ORDER BY created_at ASC`,
            );
            return allRows.rows;
        }

        const inactiveRows = await this.pool.query<{
            memory_id: string;
            authority_status: CanonicalMemory['authority_status'];
        }>(
            `SELECT memory_id, authority_status
             FROM memory_records
             WHERE authority_status IN ('tombstoned', 'superseded')
             ORDER BY created_at ASC`,
        );
        return inactiveRows.rows;
    }

    private async _loadCanonicalRecordsForRebuild(scope: {
        canonicalMemoryIds: string[];
        staleOnly: boolean;
        fullRebuild: boolean;
    }): Promise<Array<{
        memory_id: string;
        memory_type: string;
        subject_id: string;
        version: number;
        authority_status: CanonicalMemory['authority_status'];
        content_text: string | null;
    }>> {
        const BATCH_SIZE = 200;
        const rows: Array<{
            memory_id: string;
            memory_type: string;
            subject_id: string;
            version: number;
            authority_status: CanonicalMemory['authority_status'];
            content_text: string | null;
        }> = [];

        if (scope.canonicalMemoryIds.length > 0) {
            const specific = await this.pool.query<{
                memory_id: string;
                memory_type: string;
                subject_id: string;
                version: number;
                authority_status: CanonicalMemory['authority_status'];
                content_text: string | null;
            }>(
                `SELECT memory_id, memory_type, subject_id, version, authority_status, content_text
                 FROM memory_records
                 WHERE memory_id = ANY($1::uuid[])
                 ORDER BY created_at ASC`,
                [scope.canonicalMemoryIds],
            );
            return specific.rows;
        }

        let offset = 0;
        while (true) {
            const statusClause = scope.fullRebuild
                ? `authority_status IN ('canonical','superseded','tombstoned')`
                : `authority_status IN ('canonical','superseded')`;
            const batch = await this.pool.query<{
                memory_id: string;
                memory_type: string;
                subject_id: string;
                version: number;
                authority_status: CanonicalMemory['authority_status'];
                content_text: string | null;
            }>(
                `SELECT memory_id, memory_type, subject_id, version, authority_status, content_text
                 FROM memory_records
                 WHERE ${statusClause}
                 ORDER BY created_at ASC
                 LIMIT $1 OFFSET $2`,
                [BATCH_SIZE, offset],
            );
            if (batch.rows.length === 0) break;
            rows.push(...batch.rows);
            offset += BATCH_SIZE;
        }

        if (!scope.staleOnly) return rows;

        const filtered: typeof rows = [];
        for (const row of rows) {
            let hasStaleTarget = false;
            for (const target of PROJECTION_TARGETS) {
                const projection = await this._fetchLatestProjection(row.memory_id, target);
                if (this._isProjectionStaleOrMissing(row, projection)) {
                    hasStaleTarget = true;
                    break;
                }
            }
            if (hasStaleTarget) filtered.push(row);
        }
        return filtered;
    }

    private _isProjectionStaleOrMissing(
        record: { version: number; authority_status: CanonicalMemory['authority_status'] },
        projection: ProjectionRecord | null,
    ): boolean {
        if (!projection) return true;
        if (record.authority_status === 'tombstoned' || record.authority_status === 'superseded') {
            return projection.projection_status !== 'stale';
        }
        if (projection.projection_status !== 'projected') return true;
        if (projection.projected_version === null) return true;
        return projection.projected_version < record.version;
    }

    private async _fetchLatestProjection(
        memoryId: string,
        target: ProjectionTargetSystem,
    ): Promise<ProjectionRecord | null> {
        const result = await this.pool.query<{
            projection_id: string;
            memory_id: string;
            target_system: ProjectionTargetSystem;
            projection_status: ProjectionRecord['projection_status'];
            canonical_version: number;
            projected_version: number | null;
            projection_ref: string | null;
            attempted_at: Date;
            projected_at: Date | null;
            error_message: string | null;
        }>(
            `SELECT projection_id, memory_id, target_system, projection_status,
                    canonical_version, projected_version, projection_ref,
                    attempted_at, projected_at, error_message
             FROM memory_projections
             WHERE memory_id = $1 AND target_system = $2
             ORDER BY updated_at DESC, created_at DESC
             LIMIT 1`,
            [memoryId, target],
        );
        if (result.rows.length === 0) return null;
        const row = result.rows[0];
        const attemptedAt = row.attempted_at instanceof Date
            ? row.attempted_at
            : new Date();
        const projectedAt = row.projected_at instanceof Date
            ? row.projected_at
            : null;
        return {
            projection_id: row.projection_id ?? '',
            memory_id: row.memory_id ?? memoryId,
            target_system: row.target_system ?? target,
            projection_status: row.projection_status ?? 'pending',
            canonical_version: row.canonical_version ?? 0,
            projected_version: row.projected_version,
            projection_ref: row.projection_ref,
            attempted_at: attemptedAt.toISOString(),
            projected_at: projectedAt ? projectedAt.toISOString() : null,
            error_message: row.error_message,
        };
    }

    private async _applyProjectedState(
        memoryId: string,
        target: ProjectionTargetSystem,
        version: number,
    ): Promise<{ created: boolean }> {
        const existing = await this._fetchLatestProjection(memoryId, target);
        if (existing) {
            await this.pool.query(
                `UPDATE memory_projections
                 SET projection_status = 'projected',
                     canonical_version = $2,
                     projected_version = $2,
                     attempted_at = NOW(),
                     projected_at = NOW(),
                     error_message = NULL,
                     updated_at = NOW()
                 WHERE projection_id = $1`,
                [existing.projection_id, version],
            );
            return { created: false };
        }

        await this.pool.query(
            `INSERT INTO memory_projections
                (memory_id, target_system, projection_status, canonical_version, projected_version, projected_at)
             VALUES ($1, $2, 'projected', $3, $3, NOW())`,
            [memoryId, target, version],
        );
        return { created: true };
    }

    private async _applyTombstoneProjectionState(
        memoryId: string,
        target: ProjectionTargetSystem,
        version: number,
    ): Promise<{ created: boolean }> {
        const existing = await this._fetchLatestProjection(memoryId, target);
        if (existing) {
            await this.pool.query(
                `UPDATE memory_projections
                 SET projection_status = 'stale',
                     canonical_version = $2,
                     projected_version = NULL,
                     attempted_at = NOW(),
                     error_message = NULL,
                     updated_at = NOW()
                 WHERE projection_id = $1`,
                [existing.projection_id, version],
            );
            return { created: false };
        }

        await this.pool.query(
            `INSERT INTO memory_projections
                (memory_id, target_system, projection_status, canonical_version, projected_version, projected_at, error_message)
             VALUES ($1, $2, 'stale', $3, NULL, NULL, 'canonical_not_active')`,
            [memoryId, target, version],
        );
        return { created: true };
    }
    private async _fetchRecord(memoryId: string): Promise<CanonicalMemory | null> {
        const result = await this.pool.query<Record<string, unknown>>(
            `SELECT * FROM memory_records WHERE memory_id = $1 LIMIT 1`,
            [memoryId],
        );
        if (result.rows.length === 0) return null;
        return rowToCanonical(result.rows[0]);
    }

    private async _appendLineage(
        memoryId: string,
        parentId: string | null,
        version: number,
        changeKind: 'create' | 'update' | 'tombstone',
        changedFields: string[],
        priorHash: string | null,
        newHash: string,
        changedBy: string,
    ): Promise<void> {
        await this.pool.query(
            `INSERT INTO memory_lineage
                (memory_id, parent_memory_id, version, change_kind,
                 changed_fields, prior_hash, new_hash, changed_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [memoryId, parentId, version, changeKind, changedFields, priorHash, newHash, changedBy],
        );
    }

    /**
     * Emit projection events for all derived target systems after a canonical write.
     * Currently: inserts a 'pending' row into memory_projections and logs intent.
     * Full projection implementation (writing to mem0 / graph / vector) is deferred.
     */
    private async _emitProjectionEvents(memoryId: string, version: number): Promise<void> {
        for (const target of PROJECTION_TARGETS) {
            await this.pool.query(
                `INSERT INTO memory_projections
                    (memory_id, target_system, projection_status, canonical_version)
                 VALUES ($1,$2,'pending',$3)`,
                [memoryId, target, version],
            );
            console.log(
                `[MemoryAuthority][Projection] Intent logged → memory_id=${memoryId} target=${target} v${version}`,
            );
        }
    }

    /** Mark all projections for a memory_id as stale after an update. */
    private async _markProjectionsStale(memoryId: string): Promise<void> {
        await this.pool.query(
            `UPDATE memory_projections
             SET projection_status = 'stale', updated_at = NOW()
             WHERE memory_id = $1 AND projection_status = 'projected'`,
            [memoryId],
        );
    }

    /** Record a detected duplicate in memory_duplicates. */
    private async _recordDuplicate(
        canonicalMemoryId: string,
        duplicateMemoryId: string | null,
        hash: string,
        matchKind: string,
        matchScore: number,
    ): Promise<void> {
        await this.pool.query(
            `INSERT INTO memory_duplicates
                (canonical_memory_id, duplicate_memory_id, match_kind, match_score, canonical_hash)
             VALUES ($1,$2,$3,$4,$5)`,
            [canonicalMemoryId, duplicateMemoryId, matchKind, matchScore, hash],
        );
    }

    /** Persist an integrity issue and return the populated IntegrityIssue. */
    private async _persistIssue(fields: {
        issue_kind: IssueKind;
        severity: IssueSeverity;
        affected_memory_id: string | null;
        affected_system: string | null;
        description: string;
        repair_suggestion: string | null;
    }): Promise<IntegrityIssue> {
        const result = await this.pool.query<{ issue_id: string; detected_at: Date }>(
            `INSERT INTO memory_integrity_issues
                (issue_kind, severity, affected_memory_id, affected_system,
                 description, repair_suggestion)
             VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING issue_id, detected_at`,
            [
                fields.issue_kind,
                fields.severity,
                fields.affected_memory_id,
                fields.affected_system,
                fields.description,
                fields.repair_suggestion,
            ],
        );
        return {
            issue_id: result.rows[0].issue_id,
            issue_kind: fields.issue_kind,
            severity: fields.severity,
            affected_memory_id: fields.affected_memory_id,
            affected_system: fields.affected_system,
            description: fields.description,
            repair_suggestion: fields.repair_suggestion,
            repair_status: 'open',
            detected_at: result.rows[0].detected_at.toISOString(),
        };
    }
}




