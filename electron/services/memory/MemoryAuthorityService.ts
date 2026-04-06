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
    RankedMemoryCandidate,
    MemoryInvocationContext,
    MemoryOperationResult,
} from '../../../shared/memory/authorityTypes';
import {
    rankMemoryByAuthority,
    resolveMemoryAuthorityConflict,
} from './derivedWriteGuards';
import { policyGate, PolicyDeniedError } from '../policy/PolicyGate';
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
     * Create a new canonical memory record.
     *
     * Flow:
     *   1. Normalize input
     *   2. Compute canonical_hash
     *   3. Detect exact duplicates (Phase 1)
     *   4. Semantic duplicate placeholder (Phase 2)
     *   5. If no duplicate → INSERT into memory_records (version = 1, status = 'canonical')
     *   6. Record lineage entry
     *   7. Emit projection events (log + insert into memory_projections)
     *
     * @returns The canonical_memory_id (existing if duplicate, new if created)
     */
    async createCanonicalMemory(input: ProposedMemoryInput, callerExecutionId?: string): Promise<string> {
        const hash = computeCanonicalHash(input);

        // --- POLICY GATE: canonical memory write pre-check ---
        // Fires before any database operation.
        // PolicyDeniedError propagates to the caller; no writes occur on block.
        policyGate.assertSideEffect({
            actionKind: 'memory_write',
            targetSubsystem: 'MemoryAuthorityService',
            mutationIntent: 'canonical_memory_write',
        });

        const writeOperationId = callerExecutionId ?? `mem-write-${crypto.randomBytes(8).toString('hex')}`;
        const bus = TelemetryBus.getInstance();
        bus.emit({
            executionId: writeOperationId,
            subsystem: 'memory',
            event: 'memory.write_requested',
            payload: { operation: 'create', memory_type: input.memory_type, subject_type: input.subject_type },
        });

        try {
            // Phase 1+2: duplicate detection
            const dup = await this.detectDuplicates({ ...input, canonical_hash: hash });
            if (dup.duplicate_found && dup.matched_memory_id) {
                console.log(
                    `[MemoryAuthority] Duplicate detected (${dup.match_kind}, score=${dup.match_score}) → returning existing ${dup.matched_memory_id}`,
                );
                // Record that this was seen as a duplicate
                await this._recordDuplicate(dup.matched_memory_id, null, hash, dup.match_kind, dup.match_score);
                bus.emit({
                    executionId: writeOperationId,
                    subsystem: 'memory',
                    event: 'memory.write_completed',
                    payload: { operation: 'create', memory_id: dup.matched_memory_id, duplicate: true },
                });
                return dup.matched_memory_id;
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

            // Record creation lineage
            await this._appendLineage(memoryId, null, 1, 'create', [], null, hash, 'system');

            // Emit projection events (Step 5 — log only; no full projection implemented yet)
            await this._emitProjectionEvents(memoryId, 1);

            console.log(`[MemoryAuthority] Canonical record created: ${memoryId} (type=${input.memory_type})`);
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.write_completed',
                payload: { operation: 'create', memory_id: memoryId, memory_type: input.memory_type },
            });
            return memoryId;
        } catch (err) {
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.write_failed',
                payload: { operation: 'create', memory_type: input.memory_type, error: String(err) },
            });
            throw err;
        }
    }

    /**
     * Update an existing canonical memory record.
     * Increments the version, recomputes the hash, and supersedes the previous
     * version in the lineage table.
     */
    async updateCanonicalMemory(
        memoryId: string,
        updates: Partial<Pick<ProposedMemoryInput, 'content_text' | 'content_structured' | 'confidence' | 'valid_to'>>,
        executionMode?: string,
        callerExecutionId?: string,
    ): Promise<CanonicalMemory> {
        // --- POLICY GATE: canonical memory update pre-check ---
        // Fires before any fetch or database mutation.
        // PolicyDeniedError propagates to the caller; no writes occur on block.
        policyGate.assertSideEffect({
            actionKind: 'memory_write',
            executionMode,
            targetSubsystem: 'MemoryAuthorityService',
            mutationIntent: 'write',
        });

        const writeOperationId = callerExecutionId ?? `mem-write-${crypto.randomBytes(8).toString('hex')}`;
        const bus = TelemetryBus.getInstance();
        bus.emit({
            executionId: writeOperationId,
            subsystem: 'memory',
            event: 'memory.write_requested',
            payload: { operation: 'update', memory_id: memoryId },
        });

        try {
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
            // Mark projections as stale since the canonical record changed
            await this._markProjectionsStale(memoryId);

            console.log(`[MemoryAuthority] Record updated: ${memoryId} → v${newVersion}`);
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.write_completed',
                payload: { operation: 'update', memory_id: memoryId, version: newVersion },
            });
            return updated;
        } catch (err) {
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.write_failed',
                payload: { operation: 'update', memory_id: memoryId, error: String(err) },
            });
            throw err;
        }
    }

    /**
     * Tombstone a canonical memory record.
     * Sets tombstoned_at and authority_status = 'tombstoned'. Does NOT DELETE —
     * the record must remain for referential integrity and rebuild purposes.
     */
    async tombstoneMemory(memoryId: string, executionMode?: string, callerExecutionId?: string): Promise<void> {
        // --- POLICY GATE: tombstone pre-check ---
        // Fires before any fetch or database mutation.
        // PolicyDeniedError propagates to the caller; no writes occur on block.
        policyGate.assertSideEffect({
            actionKind: 'memory_write',
            executionMode,
            targetSubsystem: 'MemoryAuthorityService',
            mutationIntent: 'write',
        });

        const writeOperationId = callerExecutionId ?? `mem-write-${crypto.randomBytes(8).toString('hex')}`;
        const bus = TelemetryBus.getInstance();
        bus.emit({
            executionId: writeOperationId,
            subsystem: 'memory',
            event: 'memory.write_requested',
            payload: { operation: 'delete', memory_id: memoryId },
        });

        try {
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
                return;
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

            console.log(`[MemoryAuthority] Record tombstoned: ${memoryId}`);
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.write_completed',
                payload: { operation: 'delete', memory_id: memoryId },
            });
        } catch (err) {
            bus.emit({
                executionId: writeOperationId,
                subsystem: 'memory',
                event: 'memory.write_failed',
                payload: { operation: 'delete', memory_id: memoryId, error: String(err) },
            });
            throw err;
        }
    }

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
     * Currently: reads all non-tombstoned canonical records, logs rebuild actions,
     * and verifies all records are reachable. Full projection logic (actual mem0 /
     * graph / vector writes) is deferred to a subsequent implementation step.
     */
    async rebuildDerivedState(): Promise<RebuildReport> {
        const runAt = new Date().toISOString();
        const actions: RebuildAction[] = [];
        let unreachableCount = 0;

        // Read all active canonical records in batches to avoid large in-memory loads
        const BATCH_SIZE = 200;
        let offset = 0;
        let totalRead = 0;

        while (true) {
            const batch = await this.pool.query<Record<string, unknown>>(
                `SELECT memory_id, memory_type, subject_id, version, authority_status
                 FROM memory_records
                 WHERE authority_status != 'tombstoned'
                 ORDER BY created_at ASC
                 LIMIT $1 OFFSET $2`,
                [BATCH_SIZE, offset],
            );

            if (batch.rows.length === 0) break;
            totalRead += batch.rows.length;

            for (const row of batch.rows) {
                const memId = row.memory_id as string;
                const version = row.version as number;

                // Check which derived systems already have a current projection for this record
                const existingProj = await this.pool.query<{
                    target_system: string;
                    projection_status: string;
                    projected_version: number | null;
                }>(
                    `SELECT target_system, projection_status, projected_version
                     FROM memory_projections
                     WHERE memory_id = $1`,
                    [memId],
                );

                const projectedSystems = new Set(
                    existingProj.rows
                        .filter(p => p.projection_status === 'projected' && p.projected_version === version)
                        .map(p => p.target_system),
                );

                for (const target of PROJECTION_TARGETS) {
                    if (projectedSystems.has(target)) {
                        actions.push({
                            memory_id: memId,
                            target_system: target,
                            action_kind: 'skip',
                            reason: `Already projected at v${version}`,
                        });
                    } else {
                        actions.push({
                            memory_id: memId,
                            target_system: target,
                            action_kind: 'create',
                            reason: `Missing or stale projection for ${target} — would re-project`,
                        });
                        // Log intent only; actual projection implementation deferred
                        console.log(
                            `[MemoryAuthority][Rebuild] Would project memory_id=${memId} type=${row.memory_type} → ${target} (v${version})`,
                        );
                    }
                }
            }

            offset += BATCH_SIZE;
        }

        // Verify: any canonical record that could not be read at all
        const unreachable = await this.pool.query<{ cnt: string }>(
            `SELECT COUNT(*) AS cnt FROM memory_records WHERE authority_status = 'canonical' AND content_text IS NULL`,
        );
        unreachableCount = parseInt(unreachable.rows[0].cnt, 10);
        if (unreachableCount > 0) {
            console.warn(`[MemoryAuthority][Rebuild] ${unreachableCount} canonical record(s) have NULL content_text`);
        }

        console.log(
            `[MemoryAuthority] Rebuild scan complete: ${totalRead} canonical record(s) checked, ${actions.filter(a => a.action_kind === 'create').length} projection(s) needed`,
        );

        return {
            run_at: runAt,
            canonical_records_read: totalRead,
            actions,
            unreachable_count: unreachableCount,
        };
    }

    /**
     * Rebuild the mem0 derived layer from canonical Postgres records.
     *
     * Reads all non-tombstoned canonical records and produces an action plan
     * for re-projecting into mem0. Full write implementation is deferred; this
     * stub validates that the canonical source is reachable and all records have
     * the data required to regenerate a mem0 projection.
     *
     * Canonical input required: content_text, memory_type, subject_id, canonical_hash
     * Truth preserved: projection is rebuildable; no authoritative truth is stored
     *   exclusively in mem0.
     */
    async rebuildMem0FromCanonical(): Promise<RebuildReport> {
        return this._rebuildTargetFromCanonical('mem0');
    }

    /**
     * Rebuild the graph derived layer from canonical Postgres records.
     *
     * Reads all non-tombstoned canonical records and produces an action plan
     * for re-projecting relationship nodes and edges into the graph store.
     * Full graph write implementation is deferred; this stub confirms canonical
     * lineage is sufficient to regenerate the graph projection.
     *
     * Canonical input required: content_text, content_structured (entity/relationship data)
     * Truth preserved: graph topology is fully rebuildable; no autobiographical truth
     *   lives exclusively in the graph layer.
     */
    async rebuildGraphFromCanonical(): Promise<RebuildReport> {
        return this._rebuildTargetFromCanonical('graph');
    }

    /**
     * Rebuild the vector/RAG index derived layer from canonical Postgres records.
     *
     * Reads all non-tombstoned canonical records and produces an action plan
     * for re-embedding and re-indexing into the vector store. Full embedding
     * implementation is deferred; this stub confirms the canonical content is
     * sufficient to regenerate the vector index from scratch.
     *
     * Canonical input required: content_text (embedding source)
     * Truth preserved: vector index is fully rebuildable; no memory truth is stored
     *   exclusively in the vector layer.
     */
    async rebuildVectorIndexFromCanonical(): Promise<RebuildReport> {
        return this._rebuildTargetFromCanonical('vector');
    }

    // -----------------------------------------------------------------------
    // UNIFIED CRUD FACADE
    // Single entrypoint for memory create / read / update / delete.
    // Each method delegates to the existing canonical implementation above.
    // No behavior is changed — this layer adds discoverability only.
    // -----------------------------------------------------------------------

    /**
     * Create a new memory record.
     *
     * Wraps createCanonicalMemory() in a normalized result envelope.
     * All errors (including PolicyDeniedError) are returned as
     * `{ success: false, error }` rather than thrown.
     *
     * @param input  Proposed memory input to canonicalise.
     * @param ctx    Optional invocation context for telemetry alignment and
     *               executionMode forwarding.
     * @returns      `MemoryOperationResult<string>` where `data` is the
     *               canonical_memory_id (existing on duplicate, new on create).
     */
    async createMemory(
        input: ProposedMemoryInput,
        ctx?: MemoryInvocationContext,
    ): Promise<MemoryOperationResult<string>> {
        const startTime = Date.now();
        try {
            const memoryId = await this.createCanonicalMemory(input, ctx?.executionId);
            return { success: true, data: memoryId, durationMs: Date.now() - startTime };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return { success: false, error, durationMs: Date.now() - startTime };
        }
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
     * Wraps updateCanonicalMemory() in a normalized result envelope.
     * All errors (including PolicyDeniedError) are returned as
     * `{ success: false, error }` rather than thrown.
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
        const startTime = Date.now();
        try {
            const updated = await this.updateCanonicalMemory(
                memoryId,
                updates,
                ctx?.executionMode,
                ctx?.executionId,
            );
            return { success: true, data: updated, durationMs: Date.now() - startTime };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return { success: false, error, durationMs: Date.now() - startTime };
        }
    }

    /**
     * Delete (tombstone) a canonical memory record.
     *
     * Wraps tombstoneMemory() in a normalized result envelope.
     * All errors (including PolicyDeniedError) are returned as
     * `{ success: false, error }` rather than thrown.
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
        const startTime = Date.now();
        try {
            await this.tombstoneMemory(memoryId, ctx?.executionMode, ctx?.executionId);
            return { success: true, durationMs: Date.now() - startTime };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return { success: false, error, durationMs: Date.now() - startTime };
        }
    }

    /**
     * Rank a set of memory candidates by authority tier.
     *
     * Order: canonical > verified_derived > transient > speculative
     * This is deterministic — no ML judgment.
     */
    rankMemoryByAuthority(
        candidates: Parameters<typeof rankMemoryByAuthority>[0],
    ): RankedMemoryCandidate[] {
        return rankMemoryByAuthority(candidates);
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

    /**
     * Core rebuild implementation for a specific target system.
     * Shared by rebuildMem0FromCanonical, rebuildGraphFromCanonical,
     * and rebuildVectorIndexFromCanonical.
     */
    private async _rebuildTargetFromCanonical(target: ProjectionTargetSystem): Promise<RebuildReport> {
        const runAt = new Date().toISOString();
        const actions: RebuildAction[] = [];
        let unreachableCount = 0;

        const BATCH_SIZE = 200;
        let offset = 0;
        let totalRead = 0;

        while (true) {
            const batch = await this.pool.query<Record<string, unknown>>(
                `SELECT memory_id, memory_type, subject_id, version, authority_status, content_text
                 FROM memory_records
                 WHERE authority_status != 'tombstoned'
                 ORDER BY created_at ASC
                 LIMIT $1 OFFSET $2`,
                [BATCH_SIZE, offset],
            );

            if (batch.rows.length === 0) break;
            totalRead += batch.rows.length;

            for (const row of batch.rows) {
                const memId = row.memory_id as string;
                const version = row.version as number;

                if (!row.content_text) {
                    unreachableCount++;
                    actions.push({
                        memory_id: memId,
                        target_system: target,
                        action_kind: 'skip',
                        reason: `NULL content_text — cannot rebuild ${target} projection`,
                    });
                    continue;
                }

                const existingProj = await this.pool.query<{
                    projection_status: string;
                    projected_version: number | null;
                }>(
                    `SELECT projection_status, projected_version
                     FROM memory_projections
                     WHERE memory_id = $1 AND target_system = $2`,
                    [memId, target],
                );

                const current = existingProj.rows[0];
                if (current && current.projection_status === 'projected' && current.projected_version === version) {
                    actions.push({
                        memory_id: memId,
                        target_system: target,
                        action_kind: 'skip',
                        reason: `Already projected at v${version}`,
                    });
                } else {
                    actions.push({
                        memory_id: memId,
                        target_system: target,
                        action_kind: 'create',
                        reason: `Missing or stale ${target} projection — would re-project from canonical content`,
                    });
                    console.log(
                        `[MemoryAuthority][Rebuild:${target}] Would project memory_id=${memId} type=${row.memory_type} → ${target} (v${version})`,
                    );
                }
            }

            offset += BATCH_SIZE;
        }

        const unreachable = await this.pool.query<{ cnt: string }>(
            `SELECT COUNT(*) AS cnt FROM memory_records WHERE authority_status = 'canonical' AND content_text IS NULL`,
        );
        unreachableCount = Math.max(unreachableCount, parseInt(unreachable.rows[0].cnt, 10));
        if (unreachableCount > 0) {
            console.warn(`[MemoryAuthority][Rebuild:${target}] ${unreachableCount} canonical record(s) have NULL content_text`);
        }

        console.log(
            `[MemoryAuthority] Rebuild:${target} scan complete: ${totalRead} canonical record(s) checked, ` +
            `${actions.filter(a => a.action_kind === 'create').length} projection(s) needed`,
        );

        return {
            run_at: runAt,
            canonical_records_read: totalRead,
            actions,
            unreachable_count: unreachableCount,
        };
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
