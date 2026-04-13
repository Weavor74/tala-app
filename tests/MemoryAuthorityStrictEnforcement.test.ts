import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryService } from '../electron/services/MemoryService';
import { MemoryAuthorityService } from '../electron/services/memory/MemoryAuthorityService';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
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
  });

  it('blocks derived memory write when canonical_memory_id is missing', async () => {
    const memoryService = new MemoryService();
    await expect(
      memoryService.add('orphan write', { source: 'test' }, 'assistant'),
    ).rejects.toThrow('Derived write without canonical_memory_id');
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
});
