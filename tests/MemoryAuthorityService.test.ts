/**
 * MemoryAuthorityService.test.ts — P7A Memory Authority Lock
 *
 * Validates:
 *   1. write routes through authority service (tryCreateCanonicalMemory inserts a record)
 *   2. duplicate detection prevents double insert (exact hash match returns existing ID)
 *   3. duplicate detection returns report fields correctly
 *   4. orphan detection works (validateIntegrity finds orphaned projections)
 *   5. projection records are created after canonical write
 *   6. rebuild does not lose data (rebuildDerivedState reads all canonical records)
 *   7. canonical precedence: tombstoned records cannot be updated
 *   8. tryTombstoneMemory sets correct status and lineage
 *   9. tryUpdateCanonicalMemory increments version and marks projections stale
 *  10. duplicate conflict detection (multiple canonical records with same hash)
 *  11. projection mismatch detection (stale projected_version)
 *  12. tombstone violation detection (projected status for tombstoned record)
 *
 * Uses a mock pg Pool — no real database connection required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryAuthorityService } from '../electron/services/memory/MemoryAuthorityService';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { RuntimeEvent } from '../shared/runtimeEventTypes';

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test' },
}));

// ---------------------------------------------------------------------------
// Mock pool builder
// ---------------------------------------------------------------------------

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

function makePool(queryFn: QueryFn) {
    return { query: vi.fn().mockImplementation(queryFn) };
}

/** Single-result pool: always returns the provided rows for every query. */
function poolWithRows(rows: Record<string, unknown>[]) {
    return makePool(() => Promise.resolve({ rows }));
}

/** Sequenced pool: returns responses in the order provided, cycling the last one. */
function poolSequenced(responses: Array<{ rows: Record<string, unknown>[] }>) {
    let call = 0;
    return {
        query: vi.fn().mockImplementation(() => {
            const resp = responses[Math.min(call, responses.length - 1)];
            call++;
            return Promise.resolve(resp);
        }),
    };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MEMORY_ID = '00000000-0000-0000-0000-000000000001';
const PROJ_ID   = '00000000-0000-0000-0000-000000000002';
const LINEAGE_ID = '00000000-0000-0000-0000-000000000003';
const ISSUE_ID  = '00000000-0000-0000-0000-000000000004';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function makeMemoryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        memory_id: MEMORY_ID,
        memory_type: 'interaction',
        subject_type: 'conversation',
        subject_id: 'turn-1',
        content_text: 'User: "hello" | Tala: "hi"',
        content_structured: null,
        canonical_hash: 'abc123',
        authority_status: 'canonical',
        version: 1,
        confidence: 1.0,
        source_kind: 'conversation',
        source_ref: 'turn:turn-1',
        created_at: NOW,
        updated_at: NOW,
        valid_from: NOW,
        valid_to: null,
        tombstoned_at: null,
        supersedes_memory_id: null,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryAuthorityService', () => {

    // -----------------------------------------------------------------------
    // 1. write routes through authority service
    // -----------------------------------------------------------------------
    describe('write routes — tryCreateCanonicalMemory', () => {
        it('inserts a new record when no duplicate exists and returns the memory_id', async () => {
            const pool = poolSequenced([
                // detectDuplicates → exact hash check → no match
                { rows: [] },
                // INSERT into memory_records
                { rows: [{ memory_id: MEMORY_ID }] },
                // _appendLineage
                { rows: [] },
                // _emitProjectionEvents × 3 (mem0, graph, vector)
                { rows: [] },
                { rows: [] },
                { rows: [] },
            ]);

            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryCreateCanonicalMemory({
                memory_type: 'interaction',
                subject_type: 'conversation',
                subject_id: 'turn-1',
                content_text: 'User: "hello" | Tala: "hi"',
                source_kind: 'conversation',
                source_ref: 'turn:turn-1',
            });

            expect(result.success).toBe(true);
            expect(result.data).toBe(MEMORY_ID);
            // INSERT should have been called (the 2nd query call)
            expect(pool.query).toHaveBeenCalledTimes(6); // detect(1) + insert(1) + lineage(1) + 3 projections
        });

        it('creates 3 projection records (mem0, graph, vector) after canonical write', async () => {
            const projectionInserts: string[] = [];
            const pool = {
                query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
                    if (sql.includes('INSERT INTO memory_projections')) {
                        projectionInserts.push(params?.[1] as string);
                    }
                    if (sql.includes('INSERT INTO memory_records')) {
                        return Promise.resolve({ rows: [{ memory_id: MEMORY_ID }] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            await svc.tryCreateCanonicalMemory({
                memory_type: 'interaction',
                subject_type: 'conversation',
                subject_id: 'turn-2',
                content_text: 'some content',
            });

            expect(projectionInserts).toEqual(expect.arrayContaining(['mem0', 'graph', 'vector']));
            expect(projectionInserts.length).toBe(3);
        });
    });

    // -----------------------------------------------------------------------
    // 2. duplicate detection prevents double insert
    // -----------------------------------------------------------------------
    describe('detectDuplicates', () => {
        it('returns duplicate_found=true when exact hash match exists', async () => {
            const pool = poolWithRows([{ memory_id: MEMORY_ID }]);
            const svc = new MemoryAuthorityService(pool as never);

            const report = await svc.detectDuplicates({
                memory_type: 'interaction',
                subject_type: 'conversation',
                subject_id: 'turn-1',
                content_text: 'User: "hello" | Tala: "hi"',
            });

            expect(report.duplicate_found).toBe(true);
            expect(report.matched_memory_id).toBe(MEMORY_ID);
            expect(report.match_score).toBe(1.0);
            expect(report.match_kind).toBe('exact');
        });

        it('returns duplicate_found=false when no exact hash match exists', async () => {
            const pool = poolWithRows([]);
            const svc = new MemoryAuthorityService(pool as never);

            const report = await svc.detectDuplicates({
                memory_type: 'interaction',
                subject_type: 'conversation',
                subject_id: 'turn-99',
                content_text: 'unique content that has no match',
            });

            expect(report.duplicate_found).toBe(false);
            expect(report.matched_memory_id).toBeNull();
            expect(report.match_kind).toBe('none');
        });

        it('tryCreateCanonicalMemory returns existing ID without inserting when duplicate detected', async () => {
            let insertCalled = false;
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('INSERT INTO memory_records')) {
                        insertCalled = true;
                        return Promise.resolve({ rows: [{ memory_id: 'new-id' }] });
                    }
                    if (sql.includes('SELECT memory_id FROM memory_records')) {
                        // exact hash match
                        return Promise.resolve({ rows: [{ memory_id: MEMORY_ID }] });
                    }
                    // _recordDuplicate insert
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryCreateCanonicalMemory({
                memory_type: 'interaction',
                subject_type: 'conversation',
                subject_id: 'turn-1',
                content_text: 'User: "hello" | Tala: "hi"',
            });

            expect(result.success).toBe(true);
            expect(result.data).toBe(MEMORY_ID);
            expect(insertCalled).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // 4. orphan detection works
    // -----------------------------------------------------------------------
    describe('validateIntegrity — orphan detection', () => {
        it('reports an orphan when a projection has no corresponding memory_records row', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('COUNT(*) AS cnt FROM memory_records')) {
                        return Promise.resolve({ rows: [{ cnt: '5' }] });
                    }
                    if (sql.includes('COUNT(*) AS cnt FROM memory_projections')) {
                        return Promise.resolve({ rows: [{ cnt: '10' }] });
                    }
                    // Orphan projection query
                    if (sql.includes('LEFT JOIN memory_records') && sql.includes('WHERE r.memory_id IS NULL')) {
                        return Promise.resolve({
                            rows: [{
                                projection_id: PROJ_ID,
                                memory_id: 'ghost-uuid',
                                target_system: 'mem0',
                            }],
                        });
                    }
                    // INSERT INTO memory_integrity_issues
                    if (sql.includes('INSERT INTO memory_integrity_issues')) {
                        return Promise.resolve({
                            rows: [{ issue_id: ISSUE_ID, detected_at: NOW }],
                        });
                    }
                    // All other checks return no rows
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const report = await svc.validateIntegrity();

            expect(report.orphan_count).toBe(1);
            expect(report.issues.length).toBeGreaterThanOrEqual(1);

            const orphanIssue = report.issues.find(i => i.issue_kind === 'orphan');
            expect(orphanIssue).toBeDefined();
            expect(orphanIssue?.severity).toBe('error');
            expect(orphanIssue?.affected_system).toBe('mem0');
        });

        it('reports zero orphans when all projections have valid canonical records', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('COUNT(*) AS cnt FROM memory_records WHERE authority_status')) {
                        return Promise.resolve({ rows: [{ cnt: '3' }] });
                    }
                    if (sql.includes('COUNT(*) AS cnt FROM memory_projections')) {
                        return Promise.resolve({ rows: [{ cnt: '3' }] });
                    }
                    // All detail queries return empty — no issues
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const report = await svc.validateIntegrity();

            expect(report.orphan_count).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // 5. projection records are created
    // -----------------------------------------------------------------------
    describe('validateIntegrity — projection mismatch', () => {
        it('reports projection_mismatch when projected_version lags canonical version', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('COUNT(*) AS cnt FROM memory_records')) {
                        return Promise.resolve({ rows: [{ cnt: '1' }] });
                    }
                    if (sql.includes('COUNT(*) AS cnt FROM memory_projections')) {
                        return Promise.resolve({ rows: [{ cnt: '3' }] });
                    }
                    if (sql.includes('LEFT JOIN memory_records') && sql.includes('WHERE r.memory_id IS NULL')) {
                        return Promise.resolve({ rows: [] }); // no orphans
                    }
                    if (sql.includes('projected_version < r.version')) {
                        return Promise.resolve({
                            rows: [{
                                projection_id: PROJ_ID,
                                memory_id: MEMORY_ID,
                                target_system: 'graph',
                                canonical_version: 3,
                                projected_version: 1,
                            }],
                        });
                    }
                    if (sql.includes('INSERT INTO memory_integrity_issues')) {
                        return Promise.resolve({
                            rows: [{ issue_id: ISSUE_ID, detected_at: NOW }],
                        });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const report = await svc.validateIntegrity();

            expect(report.projection_mismatch_count).toBe(1);
            const mismatchIssue = report.issues.find(i => i.issue_kind === 'projection_mismatch');
            expect(mismatchIssue).toBeDefined();
            expect(mismatchIssue?.severity).toBe('warning');
        });
    });

    // -----------------------------------------------------------------------
    // 6. rebuild does not lose data
    // -----------------------------------------------------------------------
    describe('rebuildDerivedState', () => {
        it('reads all canonical records and produces rebuild actions for missing projections', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('FROM memory_records') && sql.includes('ORDER BY created_at')) {
                        // First batch has 1 record; second batch is empty (terminates loop)
                        if (pool.query.mock.calls.filter((c: unknown[]) =>
                            typeof c[0] === 'string' && (c[0] as string).includes('ORDER BY created_at')
                        ).length <= 1) {
                            return Promise.resolve({
                                rows: [{
                                    memory_id: MEMORY_ID,
                                    memory_type: 'interaction',
                                    subject_id: 'turn-1',
                                    version: 1,
                                    authority_status: 'canonical',
                                }],
                            });
                        }
                        return Promise.resolve({ rows: [] });
                    }
                    if (sql.includes('FROM memory_projections') && sql.includes('WHERE memory_id')) {
                        return Promise.resolve({ rows: [] }); // no existing projections
                    }
                    if (sql.includes('content_text IS NULL')) {
                        return Promise.resolve({ rows: [{ cnt: '0' }] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const report = await svc.rebuildDerivedState();

            expect(report.canonical_records_read).toBeGreaterThanOrEqual(1);
            // Should have 3 'create' actions for mem0, graph, vector
            const createActions = report.actions.filter(a => a.action_kind === 'create');
            expect(createActions.length).toBeGreaterThanOrEqual(3);
            expect(createActions.map(a => a.target_system)).toEqual(
                expect.arrayContaining(['mem0', 'graph', 'vector']),
            );
            expect(report.unreachable_count).toBe(0);
        });

        it('reports unreachable_count for records with NULL content_text', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('ORDER BY created_at')) {
                        return Promise.resolve({ rows: [] }); // no records to iterate
                    }
                    if (sql.includes('content_text IS NULL')) {
                        return Promise.resolve({ rows: [{ cnt: '2' }] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const report = await svc.rebuildDerivedState();

            expect(report.unreachable_count).toBe(2);
        });
    });

    // -----------------------------------------------------------------------
    // 7. canonical precedence: tombstoned records cannot be updated
    // -----------------------------------------------------------------------
    describe('tryTombstoneMemory', () => {
        it('sets authority_status to tombstoned and records lineage', async () => {
            let updateCalled = false;
            let lineageInsertCalled = false;
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('SELECT * FROM memory_records')) {
                        return Promise.resolve({ rows: [makeMemoryRow()] });
                    }
                    if (sql.includes("SET tombstoned_at")) {
                        updateCalled = true;
                        return Promise.resolve({ rows: [] });
                    }
                    if (sql.includes('INSERT INTO memory_lineage')) {
                        lineageInsertCalled = true;
                        return Promise.resolve({ rows: [] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryTombstoneMemory(MEMORY_ID);

            expect(result.success).toBe(true);
            expect(updateCalled).toBe(true);
            expect(lineageInsertCalled).toBe(true);
        });

        it('returns success:false when trying to update a tombstoned record', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('SELECT * FROM memory_records')) {
                        return Promise.resolve({ rows: [makeMemoryRow({ authority_status: 'tombstoned' })] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryUpdateCanonicalMemory(MEMORY_ID, { content_text: 'new content' });
            expect(result.success).toBe(false);
            expect(result.error).toMatch(/tombstoned/);
        });

        it('is idempotent — returns success when already tombstoned', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('SELECT * FROM memory_records')) {
                        return Promise.resolve({ rows: [makeMemoryRow({ authority_status: 'tombstoned' })] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryTombstoneMemory(MEMORY_ID);
            expect(result.success).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // 9. tryUpdateCanonicalMemory increments version and marks projections stale
    // -----------------------------------------------------------------------
    describe('tryUpdateCanonicalMemory', () => {
        it('increments version and marks projections stale', async () => {
            let projectionStaleUpdateCalled = false;
            let lineageInsertCalled = false;
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('SELECT * FROM memory_records')) {
                        return Promise.resolve({ rows: [makeMemoryRow()] });
                    }
                    if (sql.includes('UPDATE memory_records SET')) {
                        return Promise.resolve({ rows: [makeMemoryRow({ version: 2, content_text: 'updated' })] });
                    }
                    if (sql.includes('INSERT INTO memory_lineage')) {
                        lineageInsertCalled = true;
                        return Promise.resolve({ rows: [] });
                    }
                    if (sql.includes("projection_status = 'stale'")) {
                        projectionStaleUpdateCalled = true;
                        return Promise.resolve({ rows: [] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryUpdateCanonicalMemory(MEMORY_ID, { content_text: 'updated content' });

            expect(result.success).toBe(true);
            expect(result.data!.version).toBe(2);
            expect(projectionStaleUpdateCalled).toBe(true);
            expect(lineageInsertCalled).toBe(true);
        });

        it('returns success:false when trying to update a non-existent record', async () => {
            const pool = poolWithRows([]); // _fetchRecord returns null
            const svc = new MemoryAuthorityService(pool as never);

            const result = await svc.tryUpdateCanonicalMemory('non-existent-id', { content_text: 'new' });
            expect(result.success).toBe(false);
            expect(result.error).toMatch(/not found/);
        });
    });

    // -----------------------------------------------------------------------
    // 10. duplicate conflict detection
    // -----------------------------------------------------------------------
    describe('validateIntegrity — duplicate canonical conflicts', () => {
        it('reports duplicate conflict when multiple canonical records share a hash', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('COUNT(*) AS cnt FROM memory_records')) {
                        return Promise.resolve({ rows: [{ cnt: '2' }] });
                    }
                    if (sql.includes('COUNT(*) AS cnt FROM memory_projections')) {
                        return Promise.resolve({ rows: [{ cnt: '0' }] });
                    }
                    if (sql.includes('WHERE r.memory_id IS NULL')) {
                        return Promise.resolve({ rows: [] }); // no orphans
                    }
                    if (sql.includes('projected_version < r.version')) {
                        return Promise.resolve({ rows: [] }); // no mismatches
                    }
                    if (sql.includes('HAVING COUNT(*) > 1')) {
                        return Promise.resolve({
                            rows: [{ canonical_hash: 'dup-hash-xyz', conflict_count: '2' }],
                        });
                    }
                    if (sql.includes('INSERT INTO memory_integrity_issues')) {
                        return Promise.resolve({
                            rows: [{ issue_id: ISSUE_ID, detected_at: NOW }],
                        });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const report = await svc.validateIntegrity();

            expect(report.duplicate_conflict_count).toBe(1);
            const dupIssue = report.issues.find(i => i.issue_kind === 'duplicate');
            expect(dupIssue).toBeDefined();
            expect(dupIssue?.severity).toBe('error');
            expect(dupIssue?.affected_system).toBe('postgres');
        });
    });

    // -----------------------------------------------------------------------
    // 12. tombstone violation detection
    // -----------------------------------------------------------------------
    describe('validateIntegrity — tombstone violations', () => {
        it('reports tombstone_violation when projection still active for tombstoned record', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('COUNT(*) AS cnt FROM memory_records')) {
                        return Promise.resolve({ rows: [{ cnt: '1' }] });
                    }
                    if (sql.includes('COUNT(*) AS cnt FROM memory_projections')) {
                        return Promise.resolve({ rows: [{ cnt: '1' }] });
                    }
                    if (sql.includes('WHERE r.memory_id IS NULL')) {
                        return Promise.resolve({ rows: [] });
                    }
                    if (sql.includes('projected_version < r.version')) {
                        return Promise.resolve({ rows: [] });
                    }
                    if (sql.includes('HAVING COUNT(*) > 1')) {
                        return Promise.resolve({ rows: [] });
                    }
                    if (sql.includes("authority_status = 'tombstoned'") && sql.includes('projected')) {
                        return Promise.resolve({
                            rows: [{
                                projection_id: PROJ_ID,
                                memory_id: MEMORY_ID,
                                target_system: 'vector',
                            }],
                        });
                    }
                    if (sql.includes('INSERT INTO memory_integrity_issues')) {
                        return Promise.resolve({
                            rows: [{ issue_id: ISSUE_ID, detected_at: NOW }],
                        });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const report = await svc.validateIntegrity();

            expect(report.tombstone_violation_count).toBe(1);
            const tsViolation = report.issues.find(i => i.issue_kind === 'tombstone_violation');
            expect(tsViolation).toBeDefined();
            expect(tsViolation?.severity).toBe('critical');
            expect(tsViolation?.affected_system).toBe('vector');
        });
    });

    // -----------------------------------------------------------------------
    // 13. absent projection detection (new hardening check)
    // -----------------------------------------------------------------------
    describe('validateIntegrity — absent projections', () => {
        it('reports absent_projection for canonical records with no projection row', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('COUNT(*) AS cnt FROM memory_records')) {
                        return Promise.resolve({ rows: [{ cnt: '1' }] });
                    }
                    if (sql.includes('COUNT(*) AS cnt FROM memory_projections')) {
                        return Promise.resolve({ rows: [{ cnt: '0' }] });
                    }
                    // All standard checks return empty
                    if (sql.includes('WHERE r.memory_id IS NULL')) return Promise.resolve({ rows: [] });
                    if (sql.includes('projected_version < r.version')) return Promise.resolve({ rows: [] });
                    if (sql.includes('HAVING COUNT(*) > 1')) return Promise.resolve({ rows: [] });
                    if (sql.includes("authority_status = 'tombstoned'") && sql.includes('projected')) {
                        return Promise.resolve({ rows: [] });
                    }
                    // Absent projection check: LEFT JOIN looking for p.memory_id IS NULL
                    if (sql.includes('LEFT JOIN memory_projections p') && sql.includes("authority_status = 'canonical'")) {
                        return Promise.resolve({
                            rows: [{ memory_id: MEMORY_ID, memory_type: 'interaction' }],
                        });
                    }
                    if (sql.includes('INSERT INTO memory_integrity_issues')) {
                        return Promise.resolve({
                            rows: [{ issue_id: ISSUE_ID, detected_at: NOW }],
                        });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const report = await svc.validateIntegrity();

            // 3 absent projections: one for each of mem0, graph, vector
            expect(report.absent_projection_count).toBeGreaterThanOrEqual(1);
            const absentIssue = report.issues.find(i => i.issue_kind === 'absent_projection');
            expect(absentIssue).toBeDefined();
            expect(absentIssue?.severity).toBe('warning');
            expect(absentIssue?.affected_memory_id).toBe(MEMORY_ID);
        });

        it('reports zero absent projections when all canonical records have projection rows', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('COUNT(*) AS cnt FROM memory_records')) {
                        return Promise.resolve({ rows: [{ cnt: '1' }] });
                    }
                    if (sql.includes('COUNT(*) AS cnt FROM memory_projections')) {
                        return Promise.resolve({ rows: [{ cnt: '3' }] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const report = await svc.validateIntegrity();

            expect(report.absent_projection_count).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // 14. superseded-active-projection detection (new hardening check)
    // -----------------------------------------------------------------------
    describe('validateIntegrity — superseded active projections', () => {
        it('reports superseded_active_projection for superseded records still projected', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('COUNT(*) AS cnt FROM memory_records')) {
                        return Promise.resolve({ rows: [{ cnt: '1' }] });
                    }
                    if (sql.includes('COUNT(*) AS cnt FROM memory_projections')) {
                        return Promise.resolve({ rows: [{ cnt: '1' }] });
                    }
                    if (sql.includes('WHERE r.memory_id IS NULL')) return Promise.resolve({ rows: [] });
                    if (sql.includes('projected_version < r.version')) return Promise.resolve({ rows: [] });
                    if (sql.includes('HAVING COUNT(*) > 1')) return Promise.resolve({ rows: [] });
                    if (sql.includes("authority_status = 'tombstoned'") && sql.includes('projected')) {
                        return Promise.resolve({ rows: [] });
                    }
                    if (sql.includes('LEFT JOIN memory_projections p') && sql.includes("authority_status = 'canonical'")) {
                        return Promise.resolve({ rows: [] });
                    }
                    // Superseded active projection check
                    if (sql.includes("authority_status = 'superseded'") && sql.includes("projection_status = 'projected'")) {
                        return Promise.resolve({
                            rows: [{
                                projection_id: PROJ_ID,
                                memory_id: MEMORY_ID,
                                target_system: 'mem0',
                            }],
                        });
                    }
                    if (sql.includes('INSERT INTO memory_integrity_issues')) {
                        return Promise.resolve({
                            rows: [{ issue_id: ISSUE_ID, detected_at: NOW }],
                        });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const report = await svc.validateIntegrity();

            expect(report.superseded_active_projection_count).toBe(1);
            const issue = report.issues.find(i => i.issue_kind === 'superseded_active_projection');
            expect(issue).toBeDefined();
            expect(issue?.severity).toBe('warning');
            expect(issue?.affected_system).toBe('mem0');
        });
    });

    // -----------------------------------------------------------------------
    // 15. rebuild target stubs (mem0, graph, vector)
    // -----------------------------------------------------------------------
    describe('rebuildMem0FromCanonical / rebuildGraphFromCanonical / rebuildVectorIndexFromCanonical', () => {
        function makeRebuildPool() {
            return {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('ORDER BY created_at')) {
                        if ((makeRebuildPool as any)._calls === undefined) (makeRebuildPool as any)._calls = 0;
                        (makeRebuildPool as any)._calls++;
                        return Promise.resolve({
                            rows: [{
                                memory_id: MEMORY_ID,
                                memory_type: 'interaction',
                                subject_id: 'turn-1',
                                version: 1,
                                authority_status: 'canonical',
                                content_text: 'some content',
                            }],
                        });
                    }
                    if (sql.includes('FROM memory_projections') && sql.includes('AND target_system')) {
                        return Promise.resolve({ rows: [] }); // no existing projections
                    }
                    if (sql.includes('content_text IS NULL')) {
                        return Promise.resolve({ rows: [{ cnt: '0' }] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };
        }

        it('rebuildMem0FromCanonical produces create actions for missing mem0 projections', async () => {
            let orderByCalls = 0;
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('ORDER BY created_at')) {
                        orderByCalls++;
                        if (orderByCalls === 1) {
                            return Promise.resolve({ rows: [{ memory_id: MEMORY_ID, memory_type: 'interaction', subject_id: 'turn-1', version: 1, authority_status: 'canonical', content_text: 'some content' }] });
                        }
                        return Promise.resolve({ rows: [] });
                    }
                    if (sql.includes('FROM memory_projections') && sql.includes('AND target_system')) {
                        return Promise.resolve({ rows: [] });
                    }
                    if (sql.includes('content_text IS NULL')) {
                        return Promise.resolve({ rows: [{ cnt: '0' }] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const report = await svc.rebuildMem0FromCanonical();

            expect(report.canonical_records_read).toBe(1);
            const createActions = report.actions.filter(a => a.action_kind === 'create');
            expect(createActions.length).toBe(1);
            expect(createActions[0].target_system).toBe('mem0');
            expect(report.unreachable_count).toBe(0);
        });

        it('rebuildGraphFromCanonical produces create actions for missing graph projections', async () => {
            let orderByCalls = 0;
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('ORDER BY created_at')) {
                        orderByCalls++;
                        if (orderByCalls === 1) {
                            return Promise.resolve({ rows: [{ memory_id: MEMORY_ID, memory_type: 'interaction', subject_id: 'turn-1', version: 2, authority_status: 'canonical', content_text: 'some content' }] });
                        }
                        return Promise.resolve({ rows: [] });
                    }
                    if (sql.includes('FROM memory_projections') && sql.includes('AND target_system')) {
                        return Promise.resolve({ rows: [] });
                    }
                    if (sql.includes('content_text IS NULL')) {
                        return Promise.resolve({ rows: [{ cnt: '0' }] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const report = await svc.rebuildGraphFromCanonical();

            expect(report.canonical_records_read).toBe(1);
            const createActions = report.actions.filter(a => a.action_kind === 'create');
            expect(createActions[0].target_system).toBe('graph');
        });

        it('rebuildVectorIndexFromCanonical skips records with NULL content_text', async () => {
            let orderByCalls = 0;
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('ORDER BY created_at')) {
                        orderByCalls++;
                        if (orderByCalls === 1) {
                            return Promise.resolve({ rows: [{ memory_id: MEMORY_ID, memory_type: 'interaction', subject_id: 'turn-1', version: 1, authority_status: 'canonical', content_text: null }] });
                        }
                        return Promise.resolve({ rows: [] });
                    }
                    if (sql.includes('content_text IS NULL')) {
                        return Promise.resolve({ rows: [{ cnt: '1' }] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const report = await svc.rebuildVectorIndexFromCanonical();

            expect(report.unreachable_count).toBe(1);
            const skipActions = report.actions.filter(a => a.action_kind === 'skip');
            expect(skipActions.length).toBe(1);
            expect(skipActions[0].target_system).toBe('vector');
        });

        it('rebuildDerivedState skip action when projection is already current', async () => {
            let orderByCalls = 0;
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('FROM memory_records') && sql.includes('ORDER BY created_at')) {
                        orderByCalls++;
                        if (orderByCalls === 1) {
                            return Promise.resolve({ rows: [{ memory_id: MEMORY_ID, memory_type: 'interaction', subject_id: 'turn-1', version: 1, authority_status: 'canonical' }] });
                        }
                        return Promise.resolve({ rows: [] });
                    }
                    if (sql.includes('FROM memory_projections') && sql.includes('WHERE memory_id')) {
                        return Promise.resolve({
                            rows: [
                                { target_system: 'mem0', projection_status: 'projected', projected_version: 1 },
                                { target_system: 'graph', projection_status: 'projected', projected_version: 1 },
                                { target_system: 'vector', projection_status: 'projected', projected_version: 1 },
                            ],
                        });
                    }
                    if (sql.includes('content_text IS NULL')) {
                        return Promise.resolve({ rows: [{ cnt: '0' }] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            const report = await svc.rebuildDerivedState();

            const skipActions = report.actions.filter(a => a.action_kind === 'skip');
            expect(skipActions.length).toBe(3);
            const createActions = report.actions.filter(a => a.action_kind === 'create');
            expect(createActions.length).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // 16. authority ranking and conflict resolution
    // -----------------------------------------------------------------------
    describe('rankMemoryByAuthority', () => {
        it('ranks canonical source first, speculative last', () => {
            const svc = new MemoryAuthorityService({} as never);
            const ranked = svc.rankMemoryByAuthority([
                { content: 'speculative fact', source_description: 'unknown-source', is_transient: false },
                { content: 'canonical fact', source_description: 'postgres', is_canonical_source: true },
                { content: 'transient fact', source_description: 'session', is_transient: true },
                { content: 'verified derived', source_description: 'mem0', canonical_memory_id: MEMORY_ID },
            ]);

            expect(ranked[0].tier).toBe('canonical');
            expect(ranked[1].tier).toBe('verified_derived');
            expect(ranked[2].tier).toBe('transient');
            expect(ranked[3].tier).toBe('speculative');
        });

        it('returns empty array for empty input', () => {
            const svc = new MemoryAuthorityService({} as never);
            expect(svc.rankMemoryByAuthority([])).toEqual([]);
        });
    });

    describe('resolveMemoryAuthorityConflict', () => {
        it('canonical always wins when content differs', () => {
            const svc = new MemoryAuthorityService({} as never);
            const result = svc.resolveMemoryAuthorityConflict(
                { memory_id: MEMORY_ID, content_text: 'canonical truth', version: 2 },
                { content: 'derived lie', canonical_memory_id: MEMORY_ID },
                'test-context',
            );

            expect(result.winner_content).toBe('canonical truth');
            expect(result.conflict_logged).toBe(true);
        });

        it('no conflict when content matches', () => {
            const svc = new MemoryAuthorityService({} as never);
            const result = svc.resolveMemoryAuthorityConflict(
                { memory_id: MEMORY_ID, content_text: 'same truth', version: 1 },
                { content: 'same truth', canonical_memory_id: MEMORY_ID },
                'test-context',
            );

            expect(result.winner_content).toBe('same truth');
            expect(result.conflict_logged).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // 17. Unified CRUD facade — createMemory / readMemory / updateMemory / deleteMemory
    // -----------------------------------------------------------------------
    describe('Unified CRUD facade', () => {
        const INPUT = {
            memory_type: 'interaction',
            subject_type: 'conversation',
            subject_id: 'turn-1',
            content_text: 'User: "hello" | Tala: "hi"',
        };

        describe('createMemory', () => {
            it('delegates to _createCanonicalMemoryCore and returns success with the memory_id', async () => {
                const pool = poolSequenced([
                    { rows: [] },                          // detectDuplicates: exact hash check
                    { rows: [{ memory_id: MEMORY_ID }] }, // INSERT memory_records
                    { rows: [] },                          // _appendLineage
                    { rows: [] },                          // _emitProjectionEvents: mem0
                    { rows: [] },                          // _emitProjectionEvents: graph
                    { rows: [] },                          // _emitProjectionEvents: vector
                ]);
                const svc = new MemoryAuthorityService(pool as never);
                const result = await svc.createMemory(INPUT);
                expect(result.success).toBe(true);
                expect(result.data).toBe(MEMORY_ID);
                expect(typeof result.durationMs).toBe('number');
            });

            it('returns success with the existing memory_id when a duplicate is detected', async () => {
                const pool = poolWithRows([{ memory_id: MEMORY_ID }]);
                const svc = new MemoryAuthorityService(pool as never);
                const result = await svc.createMemory(INPUT);
                expect(result.success).toBe(true);
                expect(result.data).toBe(MEMORY_ID);
            });
        });

        describe('readMemory', () => {
            it('returns the canonical record when found', async () => {
                const pool = poolWithRows([makeMemoryRow()]);
                const svc = new MemoryAuthorityService(pool as never);
                const record = await svc.readMemory(MEMORY_ID);
                expect(record).not.toBeNull();
                expect(record!.memory_id).toBe(MEMORY_ID);
                expect(record!.authority_status).toBe('canonical');
            });

            it('returns null when the memory_id does not exist', async () => {
                const pool = poolWithRows([]);
                const svc = new MemoryAuthorityService(pool as never);
                const record = await svc.readMemory('non-existent-id');
                expect(record).toBeNull();
            });
        });

        describe('updateMemory', () => {
            it('delegates to _updateCanonicalMemoryCore and returns success with the updated record', async () => {
                const updatedRow = makeMemoryRow({
                    content_text: 'updated text',
                    version: 2,
                    canonical_hash: 'newhash456',
                });
                const pool = poolSequenced([
                    { rows: [makeMemoryRow()] },  // _fetchRecord
                    { rows: [updatedRow] },         // UPDATE memory_records
                    { rows: [] },                   // _appendLineage
                    { rows: [] },                   // _markProjectionsStale
                ]);
                const svc = new MemoryAuthorityService(pool as never);
                const result = await svc.updateMemory(MEMORY_ID, { content_text: 'updated text' });
                expect(result.success).toBe(true);
                expect(result.data!.memory_id).toBe(MEMORY_ID);
                expect(result.data!.version).toBe(2);
                expect(typeof result.durationMs).toBe('number');
            });

            it('forwards executionMode from context to the policy gate', async () => {
                const updatedRow = makeMemoryRow({ version: 2, canonical_hash: 'h2' });
                const pool = poolSequenced([
                    { rows: [makeMemoryRow()] },
                    { rows: [updatedRow] },
                    { rows: [] },
                    { rows: [] },
                ]);
                const svc = new MemoryAuthorityService(pool as never);
                const result = await svc.updateMemory(
                    MEMORY_ID,
                    { content_text: 'new' },
                    { executionMode: 'assistant' },
                );
                expect(result.success).toBe(true);
            });
        });

        describe('deleteMemory', () => {
            it('delegates to _tombstoneMemoryCore and returns success', async () => {
                const pool = poolSequenced([
                    { rows: [makeMemoryRow()] }, // _fetchRecord
                    { rows: [] },                 // UPDATE tombstoned_at
                    { rows: [] },                 // _appendLineage
                ]);
                const svc = new MemoryAuthorityService(pool as never);
                const result = await svc.deleteMemory(MEMORY_ID);
                expect(result.success).toBe(true);
                expect(typeof result.durationMs).toBe('number');
            });

            it('returns success when the record is already tombstoned (idempotent)', async () => {
                const pool = poolWithRows([makeMemoryRow({ authority_status: 'tombstoned', tombstoned_at: NOW })]);
                const svc = new MemoryAuthorityService(pool as never);
                const result = await svc.deleteMemory(MEMORY_ID);
                expect(result.success).toBe(true);
            });

            it('returns success:false (no throw) when the memory_id does not exist', async () => {
                const pool = poolWithRows([]);
                const svc = new MemoryAuthorityService(pool as never);
                const result = await svc.deleteMemory('missing-id');
                expect(result.success).toBe(false);
                expect(result.error).toMatch('not found');
            });
        });
    });

    // -----------------------------------------------------------------------
    // 18. TelemetryBus integration — memory.write_* events
    // -----------------------------------------------------------------------
    describe('TelemetryBus telemetry', () => {
        let capturedEvents: RuntimeEvent[];
        let unsub: () => void;

        beforeEach(() => {
            TelemetryBus._resetForTesting();
            capturedEvents = [];
            unsub = TelemetryBus.getInstance().subscribe((evt) => capturedEvents.push(evt));
        });

        afterEach(() => {
            unsub();
            TelemetryBus._resetForTesting();
        });

        it('tryCreateCanonicalMemory emits write_requested then write_completed on success', async () => {
            const pool = poolSequenced([
                { rows: [] },                          // detectDuplicates: exact hash check
                { rows: [{ memory_id: MEMORY_ID }] }, // INSERT memory_records
                { rows: [] },                          // _appendLineage
                { rows: [] },                          // _emitProjectionEvents: mem0
                { rows: [] },                          // _emitProjectionEvents: graph
                { rows: [] },                          // _emitProjectionEvents: vector
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            await svc.tryCreateCanonicalMemory({
                memory_type: 'interaction',
                subject_type: 'conversation',
                subject_id: 'turn-1',
                content_text: 'hello',
            });

            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            expect(memEvents.length).toBe(2);
            expect(memEvents[0].event).toBe('memory.write_requested');
            expect(memEvents[0].payload).toMatchObject({ operation: 'create' });
            expect(memEvents[1].event).toBe('memory.write_completed');
            expect(memEvents[1].payload).toMatchObject({ operation: 'create', memory_id: MEMORY_ID });
            // Both events share the same executionId (the write operation ID)
            expect(memEvents[0].executionId).toBe(memEvents[1].executionId);
        });

        it('tryCreateCanonicalMemory emits write_requested then write_completed for a duplicate', async () => {
            const pool = poolWithRows([{ memory_id: MEMORY_ID }]); // exact duplicate found
            const svc = new MemoryAuthorityService(pool as never);
            await svc.tryCreateCanonicalMemory({
                memory_type: 'interaction',
                subject_type: 'conversation',
                subject_id: 'turn-1',
                content_text: 'hello',
            });

            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            expect(memEvents.length).toBe(2);
            expect(memEvents[0].event).toBe('memory.write_requested');
            expect(memEvents[1].event).toBe('memory.write_completed');
            expect(memEvents[1].payload).toMatchObject({ duplicate: true });
        });

        it('tryCreateCanonicalMemory emits write_failed when the DB throws', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('FROM memory_records') && sql.includes('canonical_hash')) {
                        return Promise.resolve({ rows: [] }); // no duplicate
                    }
                    return Promise.reject(new Error('DB connection lost'));
                }),
            };
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryCreateCanonicalMemory({
                memory_type: 'interaction',
                subject_type: 'conversation',
                subject_id: 'turn-1',
                content_text: 'hello',
            });
            expect(result.success).toBe(false);
            expect(result.error).toContain('DB connection lost');

            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            expect(memEvents.some(e => e.event === 'memory.write_requested')).toBe(true);
            expect(memEvents.some(e => e.event === 'memory.write_failed')).toBe(true);
            const failEvent = memEvents.find(e => e.event === 'memory.write_failed')!;
            expect(failEvent.payload).toMatchObject({ operation: 'create' });
        });

        it('tryUpdateCanonicalMemory emits write_requested then write_completed on success', async () => {
            const updatedRow = makeMemoryRow({ version: 2, canonical_hash: 'newhash' });
            const pool = poolSequenced([
                { rows: [makeMemoryRow()] },  // _fetchRecord
                { rows: [updatedRow] },         // UPDATE
                { rows: [] },                   // _appendLineage
                { rows: [] },                   // _markProjectionsStale
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            await svc.tryUpdateCanonicalMemory(MEMORY_ID, { content_text: 'updated' });

            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            expect(memEvents.length).toBe(2);
            expect(memEvents[0].event).toBe('memory.write_requested');
            expect(memEvents[0].payload).toMatchObject({ operation: 'update', memory_id: MEMORY_ID });
            expect(memEvents[1].event).toBe('memory.write_completed');
            expect(memEvents[1].payload).toMatchObject({ operation: 'update', memory_id: MEMORY_ID });
        });

        it('tryUpdateCanonicalMemory emits write_failed when record not found', async () => {
            const pool = poolWithRows([]); // _fetchRecord returns nothing
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryUpdateCanonicalMemory(MEMORY_ID, { content_text: 'x' });
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');

            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            expect(memEvents.some(e => e.event === 'memory.write_failed')).toBe(true);
            expect(memEvents.find(e => e.event === 'memory.write_failed')!.payload)
                .toMatchObject({ operation: 'update' });
        });

        it('tryTombstoneMemory emits write_requested then write_completed on success', async () => {
            const pool = poolSequenced([
                { rows: [makeMemoryRow()] }, // _fetchRecord
                { rows: [] },                 // UPDATE tombstoned_at
                { rows: [] },                 // _appendLineage
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            await svc.tryTombstoneMemory(MEMORY_ID);

            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            expect(memEvents.length).toBe(2);
            expect(memEvents[0].event).toBe('memory.write_requested');
            expect(memEvents[0].payload).toMatchObject({ operation: 'delete', memory_id: MEMORY_ID });
            expect(memEvents[1].event).toBe('memory.write_completed');
            expect(memEvents[1].payload).toMatchObject({ operation: 'delete', memory_id: MEMORY_ID });
        });

        it('tryTombstoneMemory emits write_completed (idempotent) when already tombstoned', async () => {
            const pool = poolWithRows([makeMemoryRow({ authority_status: 'tombstoned', tombstoned_at: NOW })]);
            const svc = new MemoryAuthorityService(pool as never);
            await svc.tryTombstoneMemory(MEMORY_ID);

            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            expect(memEvents.length).toBe(2);
            expect(memEvents[1].event).toBe('memory.write_completed');
            expect(memEvents[1].payload).toMatchObject({ idempotent: true });
        });

        it('tryTombstoneMemory emits write_failed when record not found', async () => {
            const pool = poolWithRows([]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryTombstoneMemory('missing-id');
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');

            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            expect(memEvents.some(e => e.event === 'memory.write_failed')).toBe(true);
        });

        it('each write operation uses its own unique executionId', async () => {
            const pool1 = poolSequenced([
                { rows: [] },
                { rows: [{ memory_id: MEMORY_ID }] },
                { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
            ]);
            const pool2 = poolSequenced([
                { rows: [] },
                { rows: [{ memory_id: '00000000-0000-0000-0000-000000000002' }] },
                { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool1 as never);
            const input = { memory_type: 'interaction', subject_type: 'conversation', subject_id: 's', content_text: 'a' };
            await svc.tryCreateCanonicalMemory(input);

            const svc2 = new MemoryAuthorityService(pool2 as never);
            await svc2.tryCreateCanonicalMemory({ ...input, content_text: 'b' });

            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            const firstId = memEvents[0].executionId;
            const thirdId = memEvents[2].executionId;
            expect(firstId).not.toBe(thirdId);
        });
    });

    // -----------------------------------------------------------------------
    // 19. MemoryOperationResult — structured result, timing, error normalization,
    //     policy blocking, and executionId alignment
    // -----------------------------------------------------------------------
    describe('MemoryOperationResult', () => {
        let capturedEvents: RuntimeEvent[];
        let unsub: () => void;

        beforeEach(() => {
            TelemetryBus._resetForTesting();
            capturedEvents = [];
            unsub = TelemetryBus.getInstance().subscribe((evt) => capturedEvents.push(evt));
        });

        afterEach(() => {
            unsub();
            TelemetryBus._resetForTesting();
        });

        // ── Allowed writes ───────────────────────────────────────────────────

        it('MOR1: createMemory returns { success:true, data:memoryId, durationMs }', async () => {
            const pool = poolSequenced([
                { rows: [] },
                { rows: [{ memory_id: MEMORY_ID }] },
                { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.createMemory({
                memory_type: 'interaction', subject_type: 'conversation',
                subject_id: 'turn-1', content_text: 'hello',
            });
            expect(result.success).toBe(true);
            expect(result.data).toBe(MEMORY_ID);
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
            expect(result.error).toBeUndefined();
        });

        it('MOR2: updateMemory returns { success:true, data:CanonicalMemory, durationMs }', async () => {
            const updatedRow = makeMemoryRow({ version: 2, canonical_hash: 'h2' });
            const pool = poolSequenced([
                { rows: [makeMemoryRow()] },
                { rows: [updatedRow] },
                { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.updateMemory(MEMORY_ID, { content_text: 'new text' });
            expect(result.success).toBe(true);
            expect(result.data!.memory_id).toBe(MEMORY_ID);
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
            expect(result.error).toBeUndefined();
        });

        it('MOR3: deleteMemory returns { success:true, durationMs } with no data', async () => {
            const pool = poolSequenced([
                { rows: [makeMemoryRow()] }, { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.deleteMemory(MEMORY_ID);
            expect(result.success).toBe(true);
            expect(result.data).toBeUndefined();
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
        });

        // ── Blocked writes (PolicyDeniedError) ────────────────────────────────

        it('MOR4: createMemory returns { success:false, error } when policy blocks — no write occurs', async () => {
            // policyGate is allow-all by default in tests; mock assertSideEffect to deny
            const { policyGate: pg } = await import('../electron/services/policy/PolicyGate');
            const spy = vi.spyOn(pg, 'assertSideEffect').mockImplementationOnce(() => {
                throw Object.assign(new Error('memory_write blocked in rp mode'), { name: 'PolicyDeniedError' });
            });

            const pool = { query: vi.fn() }; // should never be called
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.createMemory({
                memory_type: 'interaction', subject_type: 'user',
                subject_id: 'u1', content_text: 'blocked',
            });

            expect(result.success).toBe(false);
            expect(result.error).toMatch('blocked');
            expect(pool.query).not.toHaveBeenCalled(); // no DB write
            spy.mockRestore();
        });

        it('MOR5: updateMemory returns { success:false, error } when policy blocks — no write occurs', async () => {
            const { policyGate: pg } = await import('../electron/services/policy/PolicyGate');
            const spy = vi.spyOn(pg, 'assertSideEffect').mockImplementationOnce(() => {
                throw Object.assign(new Error('memory_write blocked'), { name: 'PolicyDeniedError' });
            });

            const pool = { query: vi.fn() };
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.updateMemory(MEMORY_ID, { content_text: 'x' });

            expect(result.success).toBe(false);
            expect(pool.query).not.toHaveBeenCalled();
            spy.mockRestore();
        });

        it('MOR6: deleteMemory returns { success:false, error } when policy blocks — no write occurs', async () => {
            const { policyGate: pg } = await import('../electron/services/policy/PolicyGate');
            const spy = vi.spyOn(pg, 'assertSideEffect').mockImplementationOnce(() => {
                throw Object.assign(new Error('memory_write blocked'), { name: 'PolicyDeniedError' });
            });

            const pool = { query: vi.fn() };
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.deleteMemory(MEMORY_ID);

            expect(result.success).toBe(false);
            expect(pool.query).not.toHaveBeenCalled();
            spy.mockRestore();
        });

        // ── Error normalization ────────────────────────────────────────────────

        it('MOR7: createMemory returns { success:false, error } on DB failure — does not throw', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('FROM memory_records') && sql.includes('canonical_hash')) {
                        return Promise.resolve({ rows: [] });
                    }
                    return Promise.reject(new Error('connection reset'));
                }),
            };
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.createMemory({
                memory_type: 'interaction', subject_type: 'conversation',
                subject_id: 's', content_text: 'x',
            });
            expect(result.success).toBe(false);
            expect(result.error).toMatch('connection reset');
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
        });

        it('MOR8: updateMemory returns { success:false, error } when record not found — does not throw', async () => {
            const pool = poolWithRows([]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.updateMemory(MEMORY_ID, { content_text: 'new' });
            expect(result.success).toBe(false);
            expect(result.error).toMatch('not found');
        });

        it('MOR9: deleteMemory returns { success:false, error } when record not found — does not throw', async () => {
            const pool = poolWithRows([]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.deleteMemory('missing');
            expect(result.success).toBe(false);
            expect(result.error).toMatch('not found');
        });

        // ── Telemetry emission via facade ─────────────────────────────────────

        it('MOR10: createMemory emits memory.write_requested then memory.write_completed on success', async () => {
            const pool = poolSequenced([
                { rows: [] },
                { rows: [{ memory_id: MEMORY_ID }] },
                { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            await svc.createMemory({
                memory_type: 'interaction', subject_type: 'conversation',
                subject_id: 'turn-1', content_text: 'hello',
            });
            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            expect(memEvents.some(e => e.event === 'memory.write_requested')).toBe(true);
            expect(memEvents.some(e => e.event === 'memory.write_completed')).toBe(true);
        });

        it('MOR11: createMemory emits memory.write_failed on DB error', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('FROM memory_records') && sql.includes('canonical_hash')) {
                        return Promise.resolve({ rows: [] });
                    }
                    return Promise.reject(new Error('db error'));
                }),
            };
            const svc = new MemoryAuthorityService(pool as never);
            await svc.createMemory({
                memory_type: 'interaction', subject_type: 'conversation',
                subject_id: 's', content_text: 'x',
            });
            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            expect(memEvents.some(e => e.event === 'memory.write_failed')).toBe(true);
        });

        // ── executionId alignment ─────────────────────────────────────────────

        it('MOR12: createMemory uses caller executionId in telemetry when provided in context', async () => {
            const pool = poolSequenced([
                { rows: [] },
                { rows: [{ memory_id: MEMORY_ID }] },
                { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            const callerExecutionId = 'turn-exec-abc123';
            await svc.createMemory(
                { memory_type: 'interaction', subject_type: 'conversation', subject_id: 's', content_text: 'x' },
                { executionId: callerExecutionId },
            );
            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            expect(memEvents.every(e => e.executionId === callerExecutionId)).toBe(true);
        });

        it('MOR13: updateMemory uses caller executionId in telemetry when provided in context', async () => {
            const updatedRow = makeMemoryRow({ version: 2, canonical_hash: 'h2' });
            const pool = poolSequenced([
                { rows: [makeMemoryRow()] }, { rows: [updatedRow] }, { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            const callerExecutionId = 'turn-exec-def456';
            await svc.updateMemory(
                MEMORY_ID,
                { content_text: 'updated' },
                { executionId: callerExecutionId },
            );
            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            expect(memEvents.every(e => e.executionId === callerExecutionId)).toBe(true);
        });

        it('MOR14: auto-generates executionId when none provided in context', async () => {
            const pool = poolSequenced([
                { rows: [] },
                { rows: [{ memory_id: MEMORY_ID }] },
                { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            await svc.createMemory({
                memory_type: 'interaction', subject_type: 'conversation', subject_id: 's', content_text: 'x',
            });
            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            expect(memEvents.length).toBeGreaterThan(0);
            expect(memEvents[0].executionId).toMatch(/^mem-write-/);
            // All events in the same operation share the same executionId
            const ids = new Set(memEvents.map(e => e.executionId));
            expect(ids.size).toBe(1);
        });
    });

    // -----------------------------------------------------------------------
    // 20. Normalized canonical wrappers — tryCreateCanonicalMemory,
    //     tryUpdateCanonicalMemory, tryTombstoneMemory
    // -----------------------------------------------------------------------
    describe('Normalized canonical wrappers (try* variants)', () => {
        let capturedEvents: RuntimeEvent[];
        let unsub: () => void;

        beforeEach(() => {
            TelemetryBus._resetForTesting();
            capturedEvents = [];
            unsub = TelemetryBus.getInstance().subscribe((evt) => capturedEvents.push(evt));
        });

        afterEach(() => {
            unsub();
            TelemetryBus._resetForTesting();
        });

        // ── Successful operations ─────────────────────────────────────────────

        it('TRY1: tryCreateCanonicalMemory returns { success:true, data:memoryId, durationMs }', async () => {
            const pool = poolSequenced([
                { rows: [] },
                { rows: [{ memory_id: MEMORY_ID }] },
                { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryCreateCanonicalMemory({
                memory_type: 'interaction', subject_type: 'conversation',
                subject_id: 'turn-1', content_text: 'hello',
            });
            expect(result.success).toBe(true);
            expect(result.data).toBe(MEMORY_ID);
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
            expect(result.error).toBeUndefined();
        });

        it('TRY2: tryUpdateCanonicalMemory returns { success:true, data:CanonicalMemory, durationMs }', async () => {
            const updatedRow = makeMemoryRow({ version: 2, canonical_hash: 'h2' });
            const pool = poolSequenced([
                { rows: [makeMemoryRow()] },
                { rows: [updatedRow] },
                { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryUpdateCanonicalMemory(MEMORY_ID, { content_text: 'new text' });
            expect(result.success).toBe(true);
            expect(result.data!.memory_id).toBe(MEMORY_ID);
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
            expect(result.error).toBeUndefined();
        });

        it('TRY3: tryTombstoneMemory returns { success:true, durationMs } with no data', async () => {
            const pool = poolSequenced([
                { rows: [makeMemoryRow()] }, { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryTombstoneMemory(MEMORY_ID);
            expect(result.success).toBe(true);
            expect(result.data).toBeUndefined();
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
        });

        // ── Policy-blocked writes ─────────────────────────────────────────────

        it('TRY4: tryCreateCanonicalMemory returns { success:false, error } when policy blocks — does not throw', async () => {
            const { policyGate: pg } = await import('../electron/services/policy/PolicyGate');
            const spy = vi.spyOn(pg, 'assertSideEffect').mockImplementationOnce(() => {
                throw Object.assign(new Error('memory_write blocked in rp mode'), { name: 'PolicyDeniedError' });
            });

            const pool = { query: vi.fn() };
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryCreateCanonicalMemory({
                memory_type: 'interaction', subject_type: 'user',
                subject_id: 'u1', content_text: 'blocked',
            });

            expect(result.success).toBe(false);
            expect(result.error).toMatch('blocked');
            expect(pool.query).not.toHaveBeenCalled();
            spy.mockRestore();
        });

        it('TRY5: tryUpdateCanonicalMemory returns { success:false, error } when policy blocks — does not throw', async () => {
            const { policyGate: pg } = await import('../electron/services/policy/PolicyGate');
            const spy = vi.spyOn(pg, 'assertSideEffect').mockImplementationOnce(() => {
                throw Object.assign(new Error('memory_write blocked'), { name: 'PolicyDeniedError' });
            });

            const pool = { query: vi.fn() };
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryUpdateCanonicalMemory(MEMORY_ID, { content_text: 'x' });

            expect(result.success).toBe(false);
            expect(result.error).toMatch('blocked');
            expect(pool.query).not.toHaveBeenCalled();
            spy.mockRestore();
        });

        it('TRY6: tryTombstoneMemory returns { success:false, error } when policy blocks — does not throw', async () => {
            const { policyGate: pg } = await import('../electron/services/policy/PolicyGate');
            const spy = vi.spyOn(pg, 'assertSideEffect').mockImplementationOnce(() => {
                throw Object.assign(new Error('memory_write blocked'), { name: 'PolicyDeniedError' });
            });

            const pool = { query: vi.fn() };
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryTombstoneMemory(MEMORY_ID);

            expect(result.success).toBe(false);
            expect(result.error).toMatch('blocked');
            expect(pool.query).not.toHaveBeenCalled();
            spy.mockRestore();
        });

        // ── Repository / DB error normalization ───────────────────────────────

        it('TRY7: tryCreateCanonicalMemory returns { success:false, error } on DB failure — does not throw', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('FROM memory_records') && sql.includes('canonical_hash')) {
                        return Promise.resolve({ rows: [] });
                    }
                    return Promise.reject(new Error('connection reset'));
                }),
            };
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryCreateCanonicalMemory({
                memory_type: 'interaction', subject_type: 'conversation',
                subject_id: 's', content_text: 'x',
            });
            expect(result.success).toBe(false);
            expect(result.error).toMatch('connection reset');
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
        });

        it('TRY8: tryUpdateCanonicalMemory returns { success:false, error } when record not found — does not throw', async () => {
            const pool = poolWithRows([]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryUpdateCanonicalMemory(MEMORY_ID, { content_text: 'new' });
            expect(result.success).toBe(false);
            expect(result.error).toMatch('not found');
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
        });

        it('TRY9: tryTombstoneMemory returns { success:false, error } when record not found — does not throw', async () => {
            const pool = poolWithRows([]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryTombstoneMemory('missing-id');
            expect(result.success).toBe(false);
            expect(result.error).toMatch('not found');
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
        });

        // ── durationMs present ────────────────────────────────────────────────

        it('TRY10: tryCreateCanonicalMemory always includes durationMs', async () => {
            const pool = poolSequenced([
                { rows: [] },
                { rows: [{ memory_id: MEMORY_ID }] },
                { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryCreateCanonicalMemory({
                memory_type: 'interaction', subject_type: 'conversation',
                subject_id: 's', content_text: 'x',
            });
            expect(typeof result.durationMs).toBe('number');
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
        });

        it('TRY11: tryUpdateCanonicalMemory always includes durationMs even on error', async () => {
            const pool = poolWithRows([]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryUpdateCanonicalMemory(MEMORY_ID, { content_text: 'x' });
            expect(typeof result.durationMs).toBe('number');
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
        });

        it('TRY12: tryTombstoneMemory always includes durationMs even on error', async () => {
            const pool = poolWithRows([]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryTombstoneMemory('missing-id');
            expect(typeof result.durationMs).toBe('number');
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
        });

        // ── executionId correlation ───────────────────────────────────────────

        it('TRY13: tryCreateCanonicalMemory uses caller executionId in telemetry when context is supplied', async () => {
            const pool = poolSequenced([
                { rows: [] },
                { rows: [{ memory_id: MEMORY_ID }] },
                { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            const callerExecutionId = 'turn-exec-try-abc';
            await svc.tryCreateCanonicalMemory(
                { memory_type: 'interaction', subject_type: 'conversation', subject_id: 's', content_text: 'x' },
                { executionId: callerExecutionId },
            );
            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            expect(memEvents.length).toBeGreaterThan(0);
            expect(memEvents.every(e => e.executionId === callerExecutionId)).toBe(true);
        });

        it('TRY14: tryUpdateCanonicalMemory uses caller executionId in telemetry when context is supplied', async () => {
            const updatedRow = makeMemoryRow({ version: 2, canonical_hash: 'h2' });
            const pool = poolSequenced([
                { rows: [makeMemoryRow()] }, { rows: [updatedRow] }, { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            const callerExecutionId = 'turn-exec-try-def';
            await svc.tryUpdateCanonicalMemory(
                MEMORY_ID,
                { content_text: 'updated' },
                { executionId: callerExecutionId },
            );
            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            expect(memEvents.length).toBeGreaterThan(0);
            expect(memEvents.every(e => e.executionId === callerExecutionId)).toBe(true);
        });

        it('TRY15: tryTombstoneMemory uses caller executionId in telemetry when context is supplied', async () => {
            const pool = poolSequenced([
                { rows: [makeMemoryRow()] }, { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            const callerExecutionId = 'turn-exec-try-ghi';
            await svc.tryTombstoneMemory(MEMORY_ID, { executionId: callerExecutionId });
            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            expect(memEvents.length).toBeGreaterThan(0);
            expect(memEvents.every(e => e.executionId === callerExecutionId)).toBe(true);
        });

    });

    // -----------------------------------------------------------------------
    // 21. Preferred-path contract (DEP1–DEP4, DEP6)
    //
    // Confirms that the try* normalized wrappers are the canonical mutation
    // entry points.  These tests serve as regression guards and architectural
    // documentation.
    // -----------------------------------------------------------------------

    describe('21. Preferred-path contract', () => {
        let capturedEvents: RuntimeEvent[];
        let unsub: () => void;

        beforeEach(() => {
            TelemetryBus._resetForTesting();
            capturedEvents = [];
            unsub = TelemetryBus.getInstance().subscribe((evt) => capturedEvents.push(evt));
        });

        afterEach(() => {
            unsub();
            TelemetryBus._resetForTesting();
        });

        it('DEP1: tryCreateCanonicalMemory is the preferred entry point — returns success result without throwing', async () => {
            const pool = poolSequenced([
                { rows: [] },
                { rows: [{ memory_id: MEMORY_ID }] },
                { rows: [] },
                { rows: [] }, { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryCreateCanonicalMemory({
                memory_type: 'interaction', subject_type: 'conversation',
                subject_id: 'turn-1', content_text: 'hello',
            });
            expect(result.success).toBe(true);
            expect(result.data).toBe(MEMORY_ID);
            expect(typeof result.durationMs).toBe('number');
        });

        it('DEP2: tryUpdateCanonicalMemory is the preferred entry point — returns success result without throwing', async () => {
            const pool = poolSequenced([
                { rows: [makeMemoryRow()] },
                { rows: [makeMemoryRow({ version: 2, content_text: 'updated content' })] },
                { rows: [] },
                { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryUpdateCanonicalMemory(MEMORY_ID, { content_text: 'updated content' });
            expect(result.success).toBe(true);
            expect(result.data).toBeDefined();
            expect(typeof result.durationMs).toBe('number');
        });

        it('DEP2b: tryUpdateCanonicalMemory returns success:false on DB failure — no throw propagates', async () => {
            const pool = poolWithRows([]);   // empty rows → record not found → legacy throws
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryUpdateCanonicalMemory(MEMORY_ID, { content_text: 'x' });
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
            expect(typeof result.durationMs).toBe('number');
        });

        it('DEP3: tryTombstoneMemory is the preferred entry point — returns success result without throwing', async () => {
            const pool = poolSequenced([
                { rows: [makeMemoryRow()] },
                { rows: [] },
                { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryTombstoneMemory(MEMORY_ID);
            expect(result.success).toBe(true);
            expect(typeof result.durationMs).toBe('number');
        });

        it('DEP3b: tryTombstoneMemory returns success:false on DB failure — no throw propagates', async () => {
            const pool = poolWithRows([]);   // empty rows → record not found → legacy throws
            const svc = new MemoryAuthorityService(pool as never);
            const result = await svc.tryTombstoneMemory(MEMORY_ID);
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
            expect(typeof result.durationMs).toBe('number');
        });

        it('DEP4: preferred try* wrappers return success:false on DB failure — no throw propagates', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('FROM memory_records') && sql.includes('canonical_hash')) {
                        return Promise.resolve({ rows: [] });
                    }
                    return Promise.reject(new Error('db unavailable'));
                }),
            };
            const svc = new MemoryAuthorityService(pool as never);
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const result = await svc.tryCreateCanonicalMemory({
                memory_type: 'interaction', subject_type: 'conversation',
                subject_id: 'turn-1', content_text: 'test',
            });
            expect(result.success).toBe(false);
            expect(result.error).toContain('db unavailable');
            expect(typeof result.durationMs).toBe('number');
            warnSpy.mockRestore();
        });

        it('DEP6: try* wrappers emit the correct telemetry events', async () => {
            const pool = poolSequenced([
                { rows: [] },
                { rows: [{ memory_id: MEMORY_ID }] },
                { rows: [] },
                { rows: [] }, { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            await svc.tryCreateCanonicalMemory({
                memory_type: 'interaction', subject_type: 'conversation',
                subject_id: 'turn-1', content_text: 'telemetry parity check',
            });
            const memEvents = capturedEvents.filter(e => e.subsystem === 'memory');
            const eventTypes = memEvents.map(e => e.event);
            expect(eventTypes).toContain('memory.write_requested');
            expect(eventTypes).toContain('memory.write_completed');
        });
    });

    // -----------------------------------------------------------------------
    // 22. Private mutation core contract (COR1–COR8)
    //
    // Exercises _createCanonicalMemoryCore, _updateCanonicalMemoryCore, and
    // _tombstoneMemoryCore directly (via `as any` since they are private).
    //
    // These tests confirm:
    //   - Core methods never throw — errors are returned as {success:false}
    //   - PolicyDeniedError is captured, not propagated
    //   - durationMs is always present
    //   - Telemetry events fire correctly from the core
    //   - The _cause field carries the original Error instance for legacy adapters
    // -----------------------------------------------------------------------

    describe('22. Private mutation core contract', () => {
        let capturedEvents: RuntimeEvent[];
        let unsub: () => void;

        beforeEach(() => {
            TelemetryBus._resetForTesting();
            capturedEvents = [];
            unsub = TelemetryBus.getInstance().subscribe((evt) => capturedEvents.push(evt));
        });

        afterEach(() => {
            unsub();
            TelemetryBus._resetForTesting();
        });

        it('COR1: _createCanonicalMemoryCore succeeds and returns MemoryOperationResult<string>', async () => {
            const pool = poolSequenced([
                { rows: [] },
                { rows: [{ memory_id: MEMORY_ID }] },
                { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
            ]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await (svc as never as Record<string, unknown>)['_createCanonicalMemoryCore']({
                memory_type: 'interaction', subject_type: 'conversation',
                subject_id: 'turn-1', content_text: 'core create',
            }, 'core-op-id');
            const r = result as { success: boolean; data: string; durationMs: number };
            expect(r.success).toBe(true);
            expect(r.data).toBe(MEMORY_ID);
            expect(typeof r.durationMs).toBe('number');
        });

        it('COR2: _createCanonicalMemoryCore returns {success:false} on DB error — no throw', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('FROM memory_records') && sql.includes('canonical_hash')) {
                        return Promise.resolve({ rows: [] });
                    }
                    return Promise.reject(new Error('core db fail'));
                }),
            };
            const svc = new MemoryAuthorityService(pool as never);
            const result = await (svc as never as Record<string, unknown>)['_createCanonicalMemoryCore']({
                memory_type: 'interaction', subject_type: 'conversation',
                subject_id: 'turn-1', content_text: 'test',
            }, 'core-op-id') as { success: boolean; error: string; _cause: Error; durationMs: number };
            expect(result.success).toBe(false);
            expect(result.error).toContain('core db fail');
            expect(result._cause).toBeInstanceOf(Error);
            expect(typeof result.durationMs).toBe('number');
        });

        it('COR3: _updateCanonicalMemoryCore returns {success:false} when record not found — no throw', async () => {
            const pool = poolWithRows([]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await (svc as never as Record<string, unknown>)['_updateCanonicalMemoryCore'](
                MEMORY_ID, { content_text: 'x' }, undefined, 'core-op-id',
            ) as { success: boolean; error: string; durationMs: number };
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
            expect(typeof result.durationMs).toBe('number');
        });

        it('COR4: _tombstoneMemoryCore returns {success:false} when record not found — no throw', async () => {
            const pool = poolWithRows([]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await (svc as never as Record<string, unknown>)['_tombstoneMemoryCore'](
                MEMORY_ID, undefined, 'core-op-id',
            ) as { success: boolean; error: string; durationMs: number };
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
            expect(typeof result.durationMs).toBe('number');
        });

        it('COR5: _createCanonicalMemoryCore captures PolicyDeniedError as {success:false} — no throw', async () => {
            const { policyGate } = await import('../electron/services/policy/PolicyGate');
            const spy = vi.spyOn(policyGate, 'assertSideEffect').mockImplementationOnce(() => {
                const err = new Error('policy denied by test');
                err.name = 'PolicyDeniedError';
                throw err;
            });
            const pool = poolWithRows([]);
            const svc = new MemoryAuthorityService(pool as never);
            const result = await (svc as never as Record<string, unknown>)['_createCanonicalMemoryCore']({
                memory_type: 'interaction', subject_type: 'conversation',
                subject_id: 'turn-1', content_text: 'policy test',
            }, 'core-policy-id') as { success: boolean; error: string; durationMs: number };
            expect(result.success).toBe(false);
            expect(result.error).toContain('policy denied by test');
            expect(typeof result.durationMs).toBe('number');
            spy.mockRestore();
        });

        it('COR6: _cause carries original error instance for legacy adapter re-throw', async () => {
            const pool = poolWithRows([]);
            const svc = new MemoryAuthorityService(pool as never);
            // updateCore: record not found → Error thrown internally
            const result = await (svc as never as Record<string, unknown>)['_updateCanonicalMemoryCore'](
                MEMORY_ID, { content_text: 'x' }, undefined, 'core-op-id',
            ) as { success: boolean; _cause?: Error };
            expect(result.success).toBe(false);
            expect(result._cause).toBeInstanceOf(Error);
        });

        it('COR7: core methods emit write_failed on DB error', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('canonical_hash')) return Promise.resolve({ rows: [] });
                    return Promise.reject(new Error('db gone'));
                }),
            };
            const svc = new MemoryAuthorityService(pool as never);
            await (svc as never as Record<string, unknown>)['_createCanonicalMemoryCore']({
                memory_type: 'interaction', subject_type: 'conversation',
                subject_id: 'turn-1', content_text: 'test',
            }, 'core-tel-id');
            const failed = capturedEvents.filter(e => e.event === 'memory.write_failed');
            expect(failed.length).toBeGreaterThan(0);
            expect(failed.every(e => e.executionId === 'core-tel-id')).toBe(true);
        });

        it('COR8: durationMs is present and non-negative in all core failure results', async () => {
            const pool = poolWithRows([]);
            const svc = new MemoryAuthorityService(pool as never);
            const [r1, r2] = await Promise.all([
                (svc as never as Record<string, unknown>)['_updateCanonicalMemoryCore'](
                    MEMORY_ID, {}, undefined, 'id1',
                ) as Promise<{ durationMs: number }>,
                (svc as never as Record<string, unknown>)['_tombstoneMemoryCore'](
                    MEMORY_ID, undefined, 'id2',
                ) as Promise<{ durationMs: number }>,
            ]);
            expect(r1.durationMs).toBeGreaterThanOrEqual(0);
            expect(r2.durationMs).toBeGreaterThanOrEqual(0);
        });
    });
});
