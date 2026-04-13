import { describe, it, expect, vi } from 'vitest';
import { MemoryAuthorityService } from '../electron/services/memory/MemoryAuthorityService';
import type { ProjectionTargetSystem } from '../shared/memory/authorityTypes';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

type MemoryRow = {
  memory_id: string;
  memory_type: string;
  subject_id: string;
  version: number;
  authority_status: 'canonical' | 'superseded' | 'tombstoned';
  content_text: string | null;
  created_at?: string;
};

type ProjectionRow = {
  projection_id: string;
  memory_id: string;
  target_system: ProjectionTargetSystem;
  projection_status: 'pending' | 'projected' | 'failed' | 'stale';
  canonical_version: number;
  projected_version: number | null;
  projection_ref: string | null;
  attempted_at: Date;
  projected_at: Date | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

function makeRebuildPool(options: {
  records: MemoryRow[];
  projections?: ProjectionRow[];
  failTarget?: { memory_id: string; target_system: ProjectionTargetSystem };
}) {
  const records = [...options.records];
  const projections: ProjectionRow[] = [...(options.projections ?? [])];
  let idCounter = 1;

  const pool = {
    query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM memory_records') && sql.includes('memory_id = ANY')) {
        const ids = new Set<string>((params?.[0] as string[]) ?? []);
        const rows = records.filter(r => ids.has(r.memory_id));
        return Promise.resolve({ rows });
      }

      if (sql.includes('FROM memory_records') && sql.includes('ORDER BY created_at')) {
        const limit = Number(params?.[0] ?? 200);
        const offset = Number(params?.[1] ?? 0);
        const includeTombstoned = sql.includes("'tombstoned'");
        const allowed = includeTombstoned
          ? new Set(['canonical', 'superseded', 'tombstoned'])
          : new Set(['canonical', 'superseded']);
        const filtered = records.filter(r => allowed.has(r.authority_status));
        return Promise.resolve({ rows: filtered.slice(offset, offset + limit) });
      }

      if (sql.includes('SELECT projection_id, memory_id, target_system') && sql.includes('FROM memory_projections')) {
        const memoryId = params?.[0] as string;
        const target = params?.[1] as ProjectionTargetSystem;
        const row = projections
          .filter(p => p.memory_id === memoryId && p.target_system === target)
          .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())[0];
        return Promise.resolve({ rows: row ? [row] : [] });
      }

      if (sql.includes("UPDATE memory_projections") && sql.includes("projection_status = 'projected'")) {
        const projectionId = params?.[0] as string;
        const version = params?.[1] as number;
        const row = projections.find(p => p.projection_id === projectionId);
        if (!row) return Promise.resolve({ rows: [] });
        if (options.failTarget && row.memory_id === options.failTarget.memory_id && row.target_system === options.failTarget.target_system) {
          throw new Error(`simulated projection failure for ${row.target_system}`);
        }
        row.projection_status = 'projected';
        row.canonical_version = version;
        row.projected_version = version;
        row.projected_at = new Date();
        row.error_message = null;
        row.updated_at = new Date();
        row.attempted_at = new Date();
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("UPDATE memory_projections") && sql.includes("projection_status = 'stale'")) {
        const projectionId = params?.[0] as string;
        const version = params?.[1] as number;
        const row = projections.find(p => p.projection_id === projectionId);
        if (!row) return Promise.resolve({ rows: [] });
        row.projection_status = 'stale';
        row.canonical_version = version;
        row.projected_version = null;
        row.error_message = null;
        row.updated_at = new Date();
        row.attempted_at = new Date();
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes('INSERT INTO memory_projections') && sql.includes("'projected'")) {
        const memoryId = params?.[0] as string;
        const target = params?.[1] as ProjectionTargetSystem;
        const version = params?.[2] as number;
        if (options.failTarget && memoryId === options.failTarget.memory_id && target === options.failTarget.target_system) {
          throw new Error(`simulated projection failure for ${target}`);
        }
        projections.push({
          projection_id: `proj-${idCounter++}`,
          memory_id: memoryId,
          target_system: target,
          projection_status: 'projected',
          canonical_version: version,
          projected_version: version,
          projection_ref: null,
          attempted_at: new Date(),
          projected_at: new Date(),
          error_message: null,
          created_at: new Date(),
          updated_at: new Date(),
        });
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes('INSERT INTO memory_projections') && sql.includes("'stale'")) {
        const memoryId = params?.[0] as string;
        const target = params?.[1] as ProjectionTargetSystem;
        const version = params?.[2] as number;
        projections.push({
          projection_id: `proj-${idCounter++}`,
          memory_id: memoryId,
          target_system: target,
          projection_status: 'stale',
          canonical_version: version,
          projected_version: null,
          projection_ref: null,
          attempted_at: new Date(),
          projected_at: null,
          error_message: 'canonical_not_active',
          created_at: new Date(),
          updated_at: new Date(),
        });
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes('COUNT(*) AS cnt FROM memory_records') && sql.includes('content_text IS NULL')) {
        const cnt = records.filter(r => r.authority_status === 'canonical' && r.content_text === null).length;
        return Promise.resolve({ rows: [{ cnt: String(cnt) }] });
      }

      return Promise.resolve({ rows: [] });
    }),
    __state: { records, projections },
  };

  return pool;
}

describe('MemoryAuthorityService Derived Rebuild Engine', () => {
  it('rebuilds a specific canonical memory id and updates derived projection state', async () => {
    const pool = makeRebuildPool({
      records: [
        { memory_id: '11111111-1111-1111-1111-111111111111', memory_type: 'interaction', subject_id: 'turn-1', version: 2, authority_status: 'canonical', content_text: 'memory one' },
        { memory_id: '22222222-2222-2222-2222-222222222222', memory_type: 'interaction', subject_id: 'turn-2', version: 1, authority_status: 'canonical', content_text: 'memory two' },
      ],
    });

    const svc = new MemoryAuthorityService(pool as never);
    const report = await svc.rebuildDerivedState({ canonicalMemoryId: '11111111-1111-1111-1111-111111111111' });

    expect(report.canonical_ids_processed).toEqual(['11111111-1111-1111-1111-111111111111']);
    expect(report.projections_rebuilt).toBe(3);
    expect(pool.__state.projections.filter(p => p.memory_id === '11111111-1111-1111-1111-111111111111')).toHaveLength(3);
    expect(pool.__state.projections.filter(p => p.memory_id === '22222222-2222-2222-2222-222222222222')).toHaveLength(0);
  });

  it('rebuilds multiple canonical ids deterministically and remains idempotent across runs', async () => {
    const idA = '33333333-3333-3333-3333-333333333333';
    const idB = '44444444-4444-4444-4444-444444444444';
    const pool = makeRebuildPool({
      records: [
        { memory_id: idA, memory_type: 'interaction', subject_id: 'turn-3', version: 1, authority_status: 'canonical', content_text: 'A' },
        { memory_id: idB, memory_type: 'interaction', subject_id: 'turn-4', version: 1, authority_status: 'canonical', content_text: 'B' },
      ],
    });

    const svc = new MemoryAuthorityService(pool as never);
    const first = await svc.rebuildDerivedState({ canonicalMemoryIds: [idA, idB] });
    const second = await svc.rebuildDerivedState({ canonicalMemoryIds: [idA, idB] });

    expect(first.canonical_ids_processed).toEqual([idA, idB]);
    expect(second.canonical_ids_processed).toEqual([idA, idB]);
    expect(pool.__state.projections.filter(p => p.memory_id === idA)).toHaveLength(3);
    expect(pool.__state.projections.filter(p => p.memory_id === idB)).toHaveLength(3);
    expect(second.projections_rebuilt).toBe(0);
    expect(second.projections_skipped).toBe(6);
  });

  it('staleOnly rebuild processes only stale/missing targets', async () => {
    const freshId = '55555555-5555-5555-5555-555555555555';
    const staleId = '66666666-6666-6666-6666-666666666666';
    const now = new Date();
    const pool = makeRebuildPool({
      records: [
        { memory_id: freshId, memory_type: 'interaction', subject_id: 'turn-5', version: 2, authority_status: 'canonical', content_text: 'fresh' },
        { memory_id: staleId, memory_type: 'interaction', subject_id: 'turn-6', version: 2, authority_status: 'canonical', content_text: 'stale' },
      ],
      projections: [
        { projection_id: 'f-mem0', memory_id: freshId, target_system: 'mem0', projection_status: 'projected', canonical_version: 2, projected_version: 2, projection_ref: null, attempted_at: now, projected_at: now, error_message: null, created_at: now, updated_at: now },
        { projection_id: 'f-graph', memory_id: freshId, target_system: 'graph', projection_status: 'projected', canonical_version: 2, projected_version: 2, projection_ref: null, attempted_at: now, projected_at: now, error_message: null, created_at: now, updated_at: now },
        { projection_id: 'f-vector', memory_id: freshId, target_system: 'vector', projection_status: 'projected', canonical_version: 2, projected_version: 2, projection_ref: null, attempted_at: now, projected_at: now, error_message: null, created_at: now, updated_at: now },
        { projection_id: 's-mem0', memory_id: staleId, target_system: 'mem0', projection_status: 'stale', canonical_version: 2, projected_version: null, projection_ref: null, attempted_at: now, projected_at: null, error_message: null, created_at: now, updated_at: now },
      ],
    });

    const svc = new MemoryAuthorityService(pool as never);
    const report = await svc.rebuildDerivedState({ staleOnly: true });

    expect(report.canonical_ids_processed).toEqual([staleId]);
    expect(report.projections_rebuilt).toBeGreaterThanOrEqual(2);
  });

  it('propagates tombstoned canonical state as stale projections', async () => {
    const tombId = '77777777-7777-7777-7777-777777777777';
    const now = new Date();
    const pool = makeRebuildPool({
      records: [
        { memory_id: tombId, memory_type: 'interaction', subject_id: 'turn-7', version: 5, authority_status: 'tombstoned', content_text: 'old memory' },
      ],
      projections: [
        { projection_id: 't-mem0', memory_id: tombId, target_system: 'mem0', projection_status: 'projected', canonical_version: 4, projected_version: 4, projection_ref: null, attempted_at: now, projected_at: now, error_message: null, created_at: now, updated_at: now },
      ],
    });

    const svc = new MemoryAuthorityService(pool as never);
    await svc.rebuildDerivedState({ canonicalMemoryId: tombId, fullRebuild: true });

    const mem0Projection = pool.__state.projections.find(p => p.memory_id === tombId && p.target_system === 'mem0');
    expect(mem0Projection?.projection_status).toBe('stale');
    expect(mem0Projection?.projected_version).toBeNull();
  });

  it('does not treat orphan/non-canonical projection rows as rebuild targets', async () => {
    const canonicalId = '88888888-8888-8888-8888-888888888888';
    const orphanId = '99999999-9999-9999-9999-999999999999';
    const now = new Date();
    const pool = makeRebuildPool({
      records: [
        { memory_id: canonicalId, memory_type: 'interaction', subject_id: 'turn-8', version: 1, authority_status: 'canonical', content_text: 'canonical' },
      ],
      projections: [
        { projection_id: 'orphan-1', memory_id: orphanId, target_system: 'mem0', projection_status: 'projected', canonical_version: 1, projected_version: 1, projection_ref: null, attempted_at: now, projected_at: now, error_message: null, created_at: now, updated_at: now },
      ],
    });

    const svc = new MemoryAuthorityService(pool as never);
    const report = await svc.rebuildDerivedState();

    expect(report.canonical_ids_processed).toEqual([canonicalId]);
    expect(report.canonical_ids_processed).not.toContain(orphanId);
    expect(pool.__state.projections.find(p => p.projection_id === 'orphan-1')).toBeDefined();
  });

  it('reports partial failures cleanly when a projection layer cannot rebuild', async () => {
    const failId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const pool = makeRebuildPool({
      records: [
        { memory_id: failId, memory_type: 'interaction', subject_id: 'turn-9', version: 1, authority_status: 'canonical', content_text: 'fails graph' },
      ],
      failTarget: { memory_id: failId, target_system: 'graph' },
    });

    const svc = new MemoryAuthorityService(pool as never);
    const report = await svc.rebuildDerivedState({ canonicalMemoryId: failId });

    expect(report.partial_failure).toBe(true);
    expect(report.failures.some(f => f.memory_id === failId && f.target_system === 'graph')).toBe(true);
    expect(report.projections_rebuilt).toBe(2);
  });
});
