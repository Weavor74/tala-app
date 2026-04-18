/**
 * ResearchRepository.test.ts
 *
 * Validates the notebook/collection persistence SQL round-trip for
 * ResearchRepository without requiring a live PostgreSQL instance.
 *
 * Uses the same mock-pool injection pattern as PgvectorSemanticMemory.test.ts:
 * vi.mock('pg') + direct pool field injection to intercept every pool.query()
 * call, inspect bound parameters, and return shaped row fixtures.
 *
 * Coverage:
 *   1. createNotebook     — INSERT with correct params, returns mapped record
 *   2. listNotebooks      — SELECT returning mapped array
 *   3. getNotebook        — SELECT by id, returns mapped record or null
 *   4. addItemsToNotebook — INSERT with ON CONFLICT upsert, item_key identity
 *   5. listNotebookItems  — SELECT by notebook_id, returns mapped items
 *   6. removeNotebookItem — DELETE by notebook_id + item_key, returns boolean
 *   7. deleteNotebook     — DELETE by id, returns boolean
 *   8. resolveNotebookScope — aggregates uris/sourcePaths/itemKeys from items
 *
 * What is NOT tested here (requires live DB or contract-level tests):
 *   - ON CONFLICT actual merge semantics (database enforces)
 *   - FK constraint enforcement (database enforces)
 *   - transaction isolation (database enforces)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import type {
  NotebookRecord,
  CreateNotebookInput,
  NotebookItemRecord,
  AddNotebookItemInput,
} from '../shared/researchTypes';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-fixed'),
}));

// pg is a native module; mock the Pool so no live DB is needed.
vi.mock('pg', () => ({
  Pool: class MockPool {
    query = vi.fn();
    connect = vi.fn();
    end = vi.fn();
  },
}));

import { ResearchRepository } from '../electron/services/db/ResearchRepository';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a ResearchRepository with a fresh mock pool injected directly.
 * The pool.query mock is returned for per-test configuration.
 */
function buildRepo() {
  const mockQuery = vi.fn();
  // ResearchRepository accepts a pg.Pool in its constructor.
  const repo = new ResearchRepository({ query: mockQuery } as unknown as Pool);
  return { repo, mockQuery };
}

/** Minimal NotebookRecord row fixture as returned from the DB. */
function makeNotebookRow(overrides: Partial<NotebookRecord> = {}): NotebookRecord {
  return {
    id: 'nb-uuid-1',
    name: 'Test Notebook',
    description: null,
    created_at: new Date('2024-01-01T00:00:00Z') as any, // raw Date from pg driver
    updated_at: new Date('2024-01-01T00:00:00Z') as any,
    is_dynamic: false,
    query_template: null,
    source_scope_json: null,
    tags_json: null,
    ...overrides,
  };
}

/** Minimal NotebookItemRecord row fixture as returned from the DB. */
function makeNotebookItemRow(overrides: Partial<NotebookItemRecord> = {}): NotebookItemRecord {
  return {
    id: 'item-uuid-1',
    notebook_id: 'nb-uuid-1',
    item_key: 'key:doc1',
    item_type: 'web',
    source_id: null,
    source_path: null,
    title: 'Doc 1',
    uri: 'https://example.com/doc1',
    snippet: 'Snippet text',
    content_hash: null,
    added_from_search_run_id: null,
    added_at: new Date('2024-01-01T00:00:00Z') as any,
    metadata_json: {},
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ResearchRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── createNotebook ──────────────────────────────────────────────────────────

  describe('createNotebook()', () => {
    it('executes INSERT INTO notebooks with correct positional params', async () => {
      const { repo, mockQuery } = buildRepo();
      const row = makeNotebookRow({ name: 'My Notebook', description: 'A desc' });
      mockQuery.mockResolvedValueOnce({ rows: [row] });

      const input: CreateNotebookInput = { name: 'My Notebook', description: 'A desc' };
      const result = await repo.createNotebook(input);

      expect(mockQuery).toHaveBeenCalledOnce();
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO notebooks');
      expect(sql).toContain('RETURNING *');
      // $1 = id (uuid), $2 = name, $3 = description
      expect(params[1]).toBe('My Notebook');
      expect(params[2]).toBe('A desc');
      // is_dynamic defaults to false
      expect(params[3]).toBe(false);
    });

    it('returns a mapped NotebookRecord with ISO string timestamps', async () => {
      const { repo, mockQuery } = buildRepo();
      const row = makeNotebookRow();
      mockQuery.mockResolvedValueOnce({ rows: [row] });

      const result = await repo.createNotebook({ name: 'Test Notebook' });

      expect(result.id).toBe('nb-uuid-1');
      expect(result.name).toBe('Test Notebook');
      // toIsoString converts Date → ISO string
      expect(typeof result.created_at).toBe('string');
      expect(typeof result.updated_at).toBe('string');
    });

    it('sets description to null when omitted', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({ rows: [makeNotebookRow()] });

      await repo.createNotebook({ name: 'No Desc' });

      const [, params] = mockQuery.mock.calls[0];
      expect(params[2]).toBeNull(); // description is SQL param $3 (array index 2)
    });

    it('serializes source_scope_json as JSON string when provided', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({ rows: [makeNotebookRow()] });

      const scope = { providers: ['web'] };
      await repo.createNotebook({ name: 'Scoped', source_scope_json: scope });

      const [, params] = mockQuery.mock.calls[0];
      expect(params[5]).toBe(JSON.stringify(scope));
    });
  });

  // ── listNotebooks ───────────────────────────────────────────────────────────

  describe('listNotebooks()', () => {
    it('executes SELECT * FROM notebooks ORDER BY created_at DESC', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await repo.listNotebooks();

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain('SELECT * FROM notebooks');
      expect(sql).toContain('ORDER BY created_at DESC');
    });

    it('returns an empty array when no notebooks exist', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await repo.listNotebooks();
      expect(result).toEqual([]);
    });

    it('returns mapped records for every row', async () => {
      const { repo, mockQuery } = buildRepo();
      const rows = [
        makeNotebookRow({ id: 'nb-1', name: 'First' }),
        makeNotebookRow({ id: 'nb-2', name: 'Second' }),
      ];
      mockQuery.mockResolvedValueOnce({ rows });

      const result = await repo.listNotebooks();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('nb-1');
      expect(result[1].id).toBe('nb-2');
    });
  });

  // ── getNotebook ─────────────────────────────────────────────────────────────

  describe('getNotebook()', () => {
    it('executes SELECT with id as $1 param', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({ rows: [makeNotebookRow()] });

      await repo.getNotebook('nb-uuid-1');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('SELECT * FROM notebooks WHERE id = $1');
      expect(params[0]).toBe('nb-uuid-1');
    });

    it('returns the mapped record when found', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({ rows: [makeNotebookRow({ name: 'Found' })] });

      const result = await repo.getNotebook('nb-uuid-1');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Found');
    });

    it('returns null when no row is found', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await repo.getNotebook('nonexistent');
      expect(result).toBeNull();
    });
  });

  // ── addItemsToNotebook ──────────────────────────────────────────────────────

  describe('addItemsToNotebook()', () => {
    it('executes INSERT with ON CONFLICT DO UPDATE for each item', async () => {
      const { repo, mockQuery } = buildRepo();
      const itemRow = makeNotebookItemRow();
      mockQuery
        .mockResolvedValueOnce({ rows: [itemRow] })
        .mockResolvedValueOnce({
          rows: [{
            job_id: 'job-1',
            notebook_id: 'nb-uuid-1',
            item_key: 'key:doc1',
            source_type: 'web',
            uri: 'https://example.com/doc1',
            source_path: null,
            state: 'queued',
            stage: 'fetch',
            attempt_count: 0,
            max_attempts: 3,
            last_error: null,
            next_retry_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }],
        })
        .mockResolvedValueOnce({ rows: [itemRow] });

      const items: AddNotebookItemInput[] = [
        {
          item_key: 'key:doc1',
          item_type: 'web',
          title: 'Doc 1',
          uri: 'https://example.com/doc1',
          snippet: 'Snippet',
        },
      ];
      const result = await repo.addItemsToNotebook('nb-uuid-1', items);

      expect(mockQuery).toHaveBeenCalledTimes(3);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO notebook_items');
      expect(sql).toContain('ON CONFLICT (notebook_id, item_key) DO UPDATE');
      // $2 = notebook_id, $3 = item_key
      expect(params[1]).toBe('nb-uuid-1');
      expect(params[2]).toBe('key:doc1');
      expect(result).toHaveLength(1);
    });

    it('preserves item_key identity — item_key is bound as $3', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValue({ rows: [makeNotebookItemRow({ item_key: 'key:stable' })] });

      await repo.addItemsToNotebook('nb-uuid-1', [{ item_key: 'key:stable' }]);

      const [, params] = mockQuery.mock.calls[0];
      expect(params[2]).toBe('key:stable');
    });

    it('returns empty array when items list is empty', async () => {
      const { repo, mockQuery } = buildRepo();

      const result = await repo.addItemsToNotebook('nb-uuid-1', []);
      expect(result).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('queues ingestion for local file-backed items', async () => {
      const { repo, mockQuery } = buildRepo();
      const row = makeNotebookItemRow({
        item_key: '/workspace/a.md',
        source_path: '/workspace/a.md',
        uri: null,
        metadata_json: { retrievalStatus: 'queued' },
      });
      mockQuery
        .mockResolvedValueOnce({ rows: [row] })
        .mockResolvedValueOnce({
          rows: [{
            job_id: 'job-local',
            notebook_id: 'nb-uuid-1',
            item_key: '/workspace/a.md',
            source_type: 'local',
            uri: null,
            source_path: '/workspace/a.md',
            state: 'queued',
            stage: 'fetch',
            attempt_count: 0,
            max_attempts: 3,
            last_error: null,
            next_retry_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }],
        })
        .mockResolvedValueOnce({ rows: [row] });

      const result = await repo.addItemsToNotebook('nb-uuid-1', [{ item_key: '/workspace/a.md', source_path: '/workspace/a.md' }]);

      expect(result[0]?.retrievalStatus).toBe('queued');
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    it('keeps legacy metadata-only items as saved_metadata_only without queued job', async () => {
      const { repo, mockQuery } = buildRepo();
      const row = makeNotebookItemRow({
        item_key: 'legacy-meta-only',
        uri: null,
        source_path: null,
        metadata_json: { retrievalStatus: 'saved_metadata_only' },
      });
      mockQuery.mockResolvedValueOnce({ rows: [row] });

      const result = await repo.addItemsToNotebook('nb-uuid-1', [{ item_key: 'legacy-meta-only', title: 'Legacy only' }]);

      expect(result[0]?.retrievalStatus).toBe('saved_metadata_only');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('processes multiple items with one query call per item', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery
        .mockResolvedValueOnce({ rows: [makeNotebookItemRow({ item_key: 'key:a' })] })
        .mockResolvedValueOnce({ rows: [makeNotebookItemRow({ item_key: 'key:b' })] });

      const result = await repo.addItemsToNotebook('nb-uuid-1', [
        { item_key: 'key:a' },
        { item_key: 'key:b' },
      ]);

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
    });
  });

  // ── listNotebookItems ───────────────────────────────────────────────────────

  describe('listNotebookItems()', () => {
    it('queries by notebook_id with $1 param', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await repo.listNotebookItems('nb-uuid-1');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('notebook_id = $1');
      expect(params[0]).toBe('nb-uuid-1');
    });

    it('returns mapped items with ISO timestamp for added_at', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({ rows: [makeNotebookItemRow()] });

      const result = await repo.listNotebookItems('nb-uuid-1');

      expect(result).toHaveLength(1);
      expect(result[0].item_key).toBe('key:doc1');
      expect(typeof result[0].added_at).toBe('string');
    });

    it('returns empty array when no items exist', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await repo.listNotebookItems('nb-uuid-1');
      expect(result).toEqual([]);
    });
  });

  // ── removeNotebookItem ──────────────────────────────────────────────────────

  describe('removeNotebookItem()', () => {
    it('executes DELETE with notebook_id and item_key params', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const deleted = await repo.removeNotebookItem('nb-uuid-1', 'key:doc1');

      expect(deleted).toBe(true);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('DELETE FROM notebook_items');
      expect(params[0]).toBe('nb-uuid-1');
      expect(params[1]).toBe('key:doc1');
    });

    it('returns false when rowCount is 0 (item not found)', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const deleted = await repo.removeNotebookItem('nb-uuid-1', 'key:missing');
      expect(deleted).toBe(false);
    });
  });

  // ── deleteNotebook ──────────────────────────────────────────────────────────

  describe('deleteNotebook()', () => {
    it('executes DELETE FROM notebooks with id param', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const deleted = await repo.deleteNotebook('nb-uuid-1');

      expect(deleted).toBe(true);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('DELETE FROM notebooks WHERE id = $1');
      expect(params[0]).toBe('nb-uuid-1');
    });

    it('returns false when rowCount is 0 (notebook not found)', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      const deleted = await repo.deleteNotebook('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  // ── resolveNotebookScope ────────────────────────────────────────────────────

  describe('resolveNotebookScope()', () => {
    it('aggregates uris, sourcePaths, and itemKeys from notebook items', async () => {
      const { repo, mockQuery } = buildRepo();
      const items = [
        makeNotebookItemRow({
          item_key: 'key:doc1',
          uri: 'https://example.com/doc1',
          source_path: '/workspace/doc1.md',
        }),
        makeNotebookItemRow({
          id: 'item-uuid-2',
          item_key: 'key:doc2',
          uri: 'https://example.com/doc2',
          source_path: null,
        }),
      ];
      mockQuery.mockResolvedValueOnce({ rows: items });

      const scope = await repo.resolveNotebookScope('nb-uuid-1');

      expect(scope.itemKeys).toEqual(['key:doc1', 'key:doc2']);
      expect(scope.uris).toEqual(['https://example.com/doc1', 'https://example.com/doc2']);
      // null source_path is filtered out
      expect(scope.sourcePaths).toEqual(['/workspace/doc1.md']);
    });

    it('returns empty arrays when notebook has no items', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const scope = await repo.resolveNotebookScope('nb-uuid-1');

      expect(scope.uris).toEqual([]);
      expect(scope.sourcePaths).toEqual([]);
      expect(scope.itemKeys).toEqual([]);
    });

    it('includes legacy metadata uri/sourcePath values in resolved scope', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeNotebookItemRow({
            item_key: 'legacy-1',
            uri: null,
            source_path: null,
            metadata_json: { uri: 'https://legacy.example.com', sourcePath: '/legacy/path.md' },
          }),
        ],
      });

      const scope = await repo.resolveNotebookScope('nb-uuid-1');

      expect(scope.uris).toEqual(['https://legacy.example.com']);
      expect(scope.sourcePaths).toEqual(['/legacy/path.md']);
      expect(scope.itemKeys).toEqual(['legacy-1']);
    });
  });

  describe('resolveNotebookOpenTarget()', () => {
    it('returns browser target for web-backed notebook item', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({
        rows: [makeNotebookItemRow({ item_key: 'web-1', uri: 'https://example.com' })],
      });

      const resolution = await repo.resolveNotebookOpenTarget('nb-uuid-1', 'web-1');

      expect(resolution.openTargetType).toBe('browser');
      expect(resolution.openTarget).toBe('https://example.com');
      expect(resolution.sourceUnavailableReason).toBeNull();
    });

    it('returns workspace target for local-backed notebook item', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({
        rows: [makeNotebookItemRow({ item_key: 'local-1', source_path: '/workspace/a.md', uri: null })],
      });

      const resolution = await repo.resolveNotebookOpenTarget('nb-uuid-1', 'local-1');

      expect(resolution.openTargetType).toBe('workspace_file');
      expect(resolution.openTarget).toBe('/workspace/a.md');
      expect(resolution.sourceUnavailableReason).toBeNull();
    });

    it('returns none with explicit reason for legacy metadata-only item', async () => {
      const { repo, mockQuery } = buildRepo();
      mockQuery.mockResolvedValueOnce({
        rows: [makeNotebookItemRow({ item_key: 'legacy-none', uri: null, source_path: null, title: 'Title Only' })],
      });

      const resolution = await repo.resolveNotebookOpenTarget('nb-uuid-1', 'legacy-none');

      expect(resolution.openTargetType).toBe('none');
      expect(resolution.openTarget).toBeNull();
      expect(resolution.sourceUnavailableReason).toContain('source_unavailable');
    });
  });
});
