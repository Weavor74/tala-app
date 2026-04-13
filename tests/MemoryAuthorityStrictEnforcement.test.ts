import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryService } from '../electron/services/MemoryService';
import { MemoryAuthorityService } from '../electron/services/memory/MemoryAuthorityService';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

const repoState = vi.hoisted(() => ({ repo: null as any }));
vi.mock('../electron/services/db/initMemoryStore', () => ({
  getCanonicalMemoryRepository: () => repoState.repo,
}));

const NOW = new Date('2026-01-01T00:00:00.000Z');

function makeMemoryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memory_id: '00000000-0000-0000-0000-000000000001',
    memory_type: 'interaction',
    subject_type: 'conversation',
    subject_id: 'turn-1',
    content_text: 'User: hello | Tala: hi',
    content_structured: null,
    canonical_hash: 'abc123',
    authority_status: 'canonical',
    version: 1,
    confidence: 0.9,
    source_kind: 'conversation',
    source_ref: 'turn:1',
    created_at: NOW,
    updated_at: NOW,
    valid_from: NOW,
    valid_to: null,
    tombstoned_at: null,
    supersedes_memory_id: null,
    ...overrides,
  };
}

describe('Memory authority strict enforcement', () => {
  beforeEach(() => {
    process.env.TALA_STRICT_MEMORY = '1';
    repoState.repo = null;
  });

  it('blocks legacy MemoryService.add durable mutation API', async () => {
    const memoryService = new MemoryService();
    await expect(
      memoryService.add('orphan write', { source: 'test' }, 'assistant'),
    ).rejects.toThrow('Durable mutation API blocked');
  });

  it('blocks legacy MemoryService.update durable mutation API', async () => {
    const memoryService = new MemoryService();
    await expect(
      memoryService.update('00000000-0000-0000-0000-000000000001', 'updated'),
    ).rejects.toThrow('update() is blocked');
  });

  it('blocks legacy MemoryService.delete durable mutation API', async () => {
    const memoryService = new MemoryService();
    await expect(
      memoryService.delete('00000000-0000-0000-0000-000000000001'),
    ).rejects.toThrow('delete() is blocked');
  });

  it('suppresses non-canonical local memories from recall', async () => {
    const memoryService = new MemoryService();
    const orphan = {
      id: 'orphan-local-id',
      text: 'orphan candidate',
      metadata: { source: 'mem0', role: 'core' },
      timestamp: Date.now(),
      salience: 0.5,
      confidence: 0.5,
      created_at: Date.now(),
      last_accessed_at: null,
      last_reinforced_at: null,
      access_count: 0,
      associations: [],
      status: 'active' as const,
    };
    const canonical = {
      ...orphan,
      id: '00000000-0000-0000-0000-0000000000aa',
      text: 'canonical derived projection',
      metadata: {
        source: 'mem0',
        role: 'core',
        canonical_memory_id: '00000000-0000-0000-0000-0000000000aa',
      },
    };
    (memoryService as unknown as { localMemories: typeof orphan[] }).localMemories = [orphan, canonical];

    const recalled = await memoryService.getAll();
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.metadata?.canonical_memory_id).toBe('00000000-0000-0000-0000-0000000000aa');
  });

  it('mergeCanonicalMemory deterministically merges target and supersedes source', async () => {
    const sourceId = '00000000-0000-0000-0000-0000000000ab';
    const targetId = '00000000-0000-0000-0000-0000000000ac';
    const issuedSql: string[] = [];

    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        issuedSql.push(sql);
        if (sql.includes('SELECT * FROM memory_records WHERE memory_id = $1')) {
          const callCount = issuedSql.filter(entry => entry.includes('SELECT * FROM memory_records WHERE memory_id = $1')).length;
          if (callCount === 1) return Promise.resolve({ rows: [makeMemoryRow({ memory_id: sourceId, content_text: 'source fact', canonical_hash: 'sourcehash' })] });
          if (callCount === 2) return Promise.resolve({ rows: [makeMemoryRow({ memory_id: targetId, content_text: 'target fact', canonical_hash: 'targethash' })] });
          return Promise.resolve({ rows: [makeMemoryRow({ memory_id: targetId, content_text: 'target fact', canonical_hash: 'targethash' })] });
        }
        if (sql.includes('UPDATE memory_records SET') && sql.includes('RETURNING *')) {
          return Promise.resolve({ rows: [makeMemoryRow({ memory_id: targetId, version: 2, content_text: 'target fact\n\n[MERGED:' + sourceId + '] source fact' })] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    const authorityService = new MemoryAuthorityService(pool as never);
    const result = await authorityService.mergeCanonicalMemory(sourceId, targetId, 'deduplicate');

    expect(result.success).toBe(true);
    expect(result.data?.decision).toBe('merge');
    expect(result.data?.canonical_memory_id).toBe(targetId);
    expect(
      issuedSql.some(sql => sql.includes("SET authority_status = 'superseded'")),
    ).toBe(true);
  });

  it('allows canonical-anchored derived projection sync from authority-routed flow', async () => {
    const canonicalId = '00000000-0000-0000-0000-000000000001';
    const pool = {
      query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT authority_status') && sql.includes('FROM memory_records')) {
          return Promise.resolve({ rows: [{ authority_status: 'canonical' }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };
    repoState.repo = {
      getSharedPool: () => pool,
    };

    const memoryService = new MemoryService();
    const ok = await memoryService.syncDerivedProjectionFromCanonical({
      canonicalMemoryId: canonicalId,
      text: 'authority-derived memory projection',
      metadata: { source: 'test' },
      source: 'test',
    });

    expect(ok).toBe(true);
    const all = await memoryService.getAll();
    expect(all.some(m => m.metadata?.canonical_memory_id === canonicalId)).toBe(true);
  });

  it('allows canonical-anchored derived projection removal for tombstoned canonical memory', async () => {
    const canonicalId = '00000000-0000-0000-0000-0000000000aa';
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT authority_status') && sql.includes('FROM memory_records')) {
          return Promise.resolve({ rows: [{ authority_status: 'tombstoned' }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };
    repoState.repo = {
      getSharedPool: () => pool,
    };

    const memoryService = new MemoryService();
    (memoryService as unknown as { localMemories: Array<{ id: string; text: string; metadata: { canonical_memory_id: string }; timestamp: number; salience: number; confidence: number; created_at: number; last_accessed_at: number | null; last_reinforced_at: number | null; access_count: number; associations: Array<{ target_id: string; type: 'related_to' | 'contradicts' | 'supersedes'; weight: number }>; status: 'active' | 'contested' | 'superseded' | 'archived' }> }).localMemories = [
      {
        id: canonicalId,
        text: 'to remove',
        metadata: { canonical_memory_id: canonicalId },
        timestamp: Date.now(),
        salience: 0.5,
        confidence: 0.9,
        created_at: Date.now(),
        last_accessed_at: null,
        last_reinforced_at: Date.now(),
        access_count: 0,
        associations: [],
        status: 'active',
      },
    ];

    const removed = await memoryService.removeDerivedProjectionForCanonical(canonicalId);
    expect(removed).toBe(true);
    const all = await memoryService.getAll();
    expect(all).toHaveLength(0);
  });
});
