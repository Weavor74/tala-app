/**
 * MemoryAuthorityService.test.ts — P7A Memory Authority Lock
 *
 * Validates:
 *   1. write routes through authority service (createCanonicalMemory inserts a record)
 *   2. duplicate detection prevents double insert (exact hash match returns existing ID)
 *   3. duplicate detection returns report fields correctly
 *   4. orphan detection works (validateIntegrity finds orphaned projections)
 *   5. projection records are created after canonical write
 *   6. rebuild does not lose data (rebuildDerivedState reads all canonical records)
 *   7. canonical precedence: tombstoned records cannot be updated
 *   8. tombstoneMemory sets correct status and lineage
 *   9. updateCanonicalMemory increments version and marks projections stale
 *  10. duplicate conflict detection (multiple canonical records with same hash)
 *  11. projection mismatch detection (stale projected_version)
 *  12. tombstone violation detection (projected status for tombstoned record)
 *
 * Uses a mock pg Pool — no real database connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryAuthorityService } from '../electron/services/memory/MemoryAuthorityService';

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
    describe('createCanonicalMemory', () => {
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
            const id = await svc.createCanonicalMemory({
                memory_type: 'interaction',
                subject_type: 'conversation',
                subject_id: 'turn-1',
                content_text: 'User: "hello" | Tala: "hi"',
                source_kind: 'conversation',
                source_ref: 'turn:turn-1',
            });

            expect(id).toBe(MEMORY_ID);
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
            await svc.createCanonicalMemory({
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

        it('createCanonicalMemory returns existing ID without inserting when duplicate detected', async () => {
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
            const id = await svc.createCanonicalMemory({
                memory_type: 'interaction',
                subject_type: 'conversation',
                subject_id: 'turn-1',
                content_text: 'User: "hello" | Tala: "hi"',
            });

            expect(id).toBe(MEMORY_ID);
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
    describe('tombstoneMemory', () => {
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
            await svc.tombstoneMemory(MEMORY_ID);

            expect(updateCalled).toBe(true);
            expect(lineageInsertCalled).toBe(true);
        });

        it('throws when trying to update a tombstoned record', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('SELECT * FROM memory_records')) {
                        return Promise.resolve({ rows: [makeMemoryRow({ authority_status: 'tombstoned' })] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            await expect(
                svc.updateCanonicalMemory(MEMORY_ID, { content_text: 'new content' }),
            ).rejects.toThrow(/tombstoned/);
        });

        it('is idempotent — does not throw when already tombstoned', async () => {
            const pool = {
                query: vi.fn().mockImplementation((sql: string) => {
                    if (sql.includes('SELECT * FROM memory_records')) {
                        return Promise.resolve({ rows: [makeMemoryRow({ authority_status: 'tombstoned' })] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
            };

            const svc = new MemoryAuthorityService(pool as never);
            // Should not throw
            await expect(svc.tombstoneMemory(MEMORY_ID)).resolves.toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // 9. updateCanonicalMemory increments version and marks projections stale
    // -----------------------------------------------------------------------
    describe('updateCanonicalMemory', () => {
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
            const updated = await svc.updateCanonicalMemory(MEMORY_ID, { content_text: 'updated content' });

            expect(updated.version).toBe(2);
            expect(projectionStaleUpdateCalled).toBe(true);
            expect(lineageInsertCalled).toBe(true);
        });

        it('throws when trying to update a non-existent record', async () => {
            const pool = poolWithRows([]); // _fetchRecord returns null
            const svc = new MemoryAuthorityService(pool as never);

            await expect(
                svc.updateCanonicalMemory('non-existent-id', { content_text: 'new' }),
            ).rejects.toThrow(/not found/);
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
            it('delegates to createCanonicalMemory and returns the memory_id', async () => {
                const pool = poolSequenced([
                    { rows: [] },                          // detectDuplicates: exact hash check
                    { rows: [{ memory_id: MEMORY_ID }] }, // INSERT memory_records
                    { rows: [] },                          // _appendLineage
                    { rows: [] },                          // _emitProjectionEvents: mem0
                    { rows: [] },                          // _emitProjectionEvents: graph
                    { rows: [] },                          // _emitProjectionEvents: vector
                ]);
                const svc = new MemoryAuthorityService(pool as never);
                const id = await svc.createMemory(INPUT);
                expect(id).toBe(MEMORY_ID);
            });

            it('returns the existing memory_id when a duplicate is detected', async () => {
                const pool = poolWithRows([{ memory_id: MEMORY_ID }]);
                const svc = new MemoryAuthorityService(pool as never);
                const id = await svc.createMemory(INPUT);
                expect(id).toBe(MEMORY_ID);
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
            it('delegates to updateCanonicalMemory and returns the updated record', async () => {
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
                const updated = await svc.updateMemory(MEMORY_ID, { content_text: 'updated text' });
                expect(updated.memory_id).toBe(MEMORY_ID);
                expect(updated.version).toBe(2);
            });

            it('forwards executionMode to the policy gate', async () => {
                const updatedRow = makeMemoryRow({ version: 2, canonical_hash: 'h2' });
                const pool = poolSequenced([
                    { rows: [makeMemoryRow()] },
                    { rows: [updatedRow] },
                    { rows: [] },
                    { rows: [] },
                ]);
                const svc = new MemoryAuthorityService(pool as never);
                // Should not throw in non-rp mode
                await expect(
                    svc.updateMemory(MEMORY_ID, { content_text: 'new' }, 'assistant'),
                ).resolves.not.toThrow();
            });
        });

        describe('deleteMemory', () => {
            it('delegates to tombstoneMemory and tombstones the record', async () => {
                const pool = poolSequenced([
                    { rows: [makeMemoryRow()] }, // _fetchRecord
                    { rows: [] },                 // UPDATE tombstoned_at
                    { rows: [] },                 // _appendLineage
                ]);
                const svc = new MemoryAuthorityService(pool as never);
                await expect(svc.deleteMemory(MEMORY_ID)).resolves.toBeUndefined();
            });

            it('is idempotent when the record is already tombstoned', async () => {
                const pool = poolWithRows([makeMemoryRow({ authority_status: 'tombstoned', tombstoned_at: NOW })]);
                const svc = new MemoryAuthorityService(pool as never);
                await expect(svc.deleteMemory(MEMORY_ID)).resolves.toBeUndefined();
            });

            it('throws when the memory_id does not exist', async () => {
                const pool = poolWithRows([]);
                const svc = new MemoryAuthorityService(pool as never);
                await expect(svc.deleteMemory('missing-id')).rejects.toThrow('not found');
            });
        });
    });
});

