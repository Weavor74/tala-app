/**
 * PgvectorSemanticMemory — Unit tests for the pgvector embedding layer
 *
 * Tests the new repository methods:
 *   - upsertEmbedding: insert-or-update semantics over (owner_kind, owner_id, chunk_index, model)
 *   - searchObservationsBySimilarity: cosine nearest-neighbor over the embeddings index
 *   - createObservation with embedding: auto-upsert integration in the write path
 *
 * Uses direct pool injection (bypassing constructor) to avoid native pg dependency.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  UpsertEmbeddingInput,
  SimilaritySearchOptions,
  ObservationRecord,
  SemanticSearchResult,
} from '../shared/memory/memoryTypes';
import {
  TALA_EMBEDDING_MODEL,
  TALA_EMBEDDING_DIM,
  EMBEDDING_OWNER_KIND_OBSERVATION,
} from '../shared/memory/embeddingConstants';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

vi.mock('pgvector', () => ({
  toSql: (v: number[]) => JSON.stringify(v),
}));

vi.mock('../electron/services/db/MigrationRunner', () => ({
  MigrationRunner: vi.fn().mockImplementation(() => ({ runAll: vi.fn() })),
}));

vi.mock('../electron/services/db/resolveDatabaseConfig', () => ({
  resolveDatabaseConfig: vi.fn(() => ({
    host: 'localhost',
    port: 5432,
    database: 'tala',
    user: 'tala',
    password: '',
    poolMax: 5,
    idleTimeoutMs: 10000,
    connectionTimeoutMs: 5000,
    ssl: false,
  })),
}));

vi.mock('pg', () => ({
  Pool: class MockPool {
    query = vi.fn();
    connect = vi.fn();
    end = vi.fn();
  },
}));

import { PostgresMemoryRepository } from '../electron/services/db/PostgresMemoryRepository';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a deterministic dummy vector of the chosen embedding dimension. */
function makeVector(seed = 0): number[] {
  return Array.from({ length: TALA_EMBEDDING_DIM }, (_, i) =>
    Math.sin(seed + i * 0.01)
  );
}

function makeObservationRow(overrides: Partial<ObservationRecord> = {}): ObservationRecord {
  return {
    id: 'obs-uuid-1',
    observation_type: 'fact',
    subject_entity_id: null,
    predicate: 'likes',
    object_text: 'coffee',
    object_entity_id: null,
    value_json: null,
    confidence: 0.9,
    authority: null,
    observed_at: new Date('2024-01-01'),
    valid_from: null,
    valid_until: null,
    source_episode_id: null,
    metadata: {},
    ...overrides,
  };
}

/**
 * Build a fresh repo with a mock pool injected directly into its private field.
 * This bypasses the pg.Pool constructor (and live DB requirement) entirely.
 */
function buildRepoWithMockPool() {
  const mockQuery = vi.fn();
  const repo = new PostgresMemoryRepository();
  // Access the private pool field through an escape hatch — standard unit test technique
  // when the constructor requires external infrastructure (a live DB connection).
  (repo as unknown as Record<string, unknown>)['pool'] = { query: mockQuery };
  return { repo, mockQuery };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PgvectorSemanticMemory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── embeddingConstants ──────────────────────────────────────────────────────

  describe('embeddingConstants', () => {
    it('exports TALA_EMBEDDING_MODEL as text-embedding-ada-002', () => {
      expect(TALA_EMBEDDING_MODEL).toBe('text-embedding-ada-002');
    });

    it('exports TALA_EMBEDDING_DIM as 1536', () => {
      expect(TALA_EMBEDDING_DIM).toBe(1536);
    });

    it('exports EMBEDDING_OWNER_KIND_OBSERVATION as observation', () => {
      expect(EMBEDDING_OWNER_KIND_OBSERVATION).toBe('observation');
    });
  });

  // ── upsertEmbedding ─────────────────────────────────────────────────────────

  describe('upsertEmbedding', () => {
    it('inserts a new embedding row and returns metadata without vector', async () => {
      const { repo, mockQuery } = buildRepoWithMockPool();
      const embeddingRow = {
        id: 'emb-uuid-1',
        owner_kind: EMBEDDING_OWNER_KIND_OBSERVATION,
        owner_id: 'obs-uuid-1',
        chunk_index: 0,
        embedding_model: TALA_EMBEDDING_MODEL,
        content: 'likes: coffee',
        content_hash: 'abc12345',
        metadata: {},
        created_at: new Date(),
      };
      mockQuery.mockResolvedValueOnce({ rows: [embeddingRow] });

      const input: UpsertEmbeddingInput = {
        owner_kind: EMBEDDING_OWNER_KIND_OBSERVATION,
        owner_id: 'obs-uuid-1',
        chunk_index: 0,
        embedding_model: TALA_EMBEDDING_MODEL,
        content: 'likes: coffee',
        content_hash: 'abc12345',
        embedding: makeVector(1),
      };

      const result = await repo.upsertEmbedding(input);

      expect(result.owner_kind).toBe(EMBEDDING_OWNER_KIND_OBSERVATION);
      expect(result.owner_id).toBe('obs-uuid-1');
      expect(result.embedding_model).toBe(TALA_EMBEDDING_MODEL);
      // Embedding vector must NOT be returned (large payload protection)
      expect(result.embedding).toBeNull();
    });

    it('uses INSERT ... ON CONFLICT DO UPDATE SQL', async () => {
      const { repo, mockQuery } = buildRepoWithMockPool();
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'e', owner_kind: 'observation', owner_id: 'o', chunk_index: 0, embedding_model: TALA_EMBEDDING_MODEL, content: 'x', content_hash: 'y', metadata: {}, created_at: new Date() }] });

      await repo.upsertEmbedding({
        owner_kind: EMBEDDING_OWNER_KIND_OBSERVATION,
        owner_id: 'obs-uuid-2',
        embedding_model: TALA_EMBEDDING_MODEL,
        content: 'predicate: value',
        content_hash: 'deadbeef',
        embedding: makeVector(2),
      });

      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/ON CONFLICT/);
      expect(sql).toMatch(/DO UPDATE SET/);
    });

    it('defaults chunk_index to 0 when not provided', async () => {
      const { repo, mockQuery } = buildRepoWithMockPool();
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'e', owner_kind: 'observation', owner_id: 'o', chunk_index: 0, embedding_model: TALA_EMBEDDING_MODEL, content: 'x', content_hash: 'y', metadata: {}, created_at: new Date() }] });

      await repo.upsertEmbedding({
        owner_kind: EMBEDDING_OWNER_KIND_OBSERVATION,
        owner_id: 'obs-uuid-3',
        embedding_model: TALA_EMBEDDING_MODEL,
        content: 'test',
        content_hash: 'abc',
        embedding: makeVector(3),
      });

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      // chunk_index is the 4th parameter (index 3)
      expect(params[3]).toBe(0);
    });
  });

  // ── searchObservationsBySimilarity ──────────────────────────────────────────

  describe('searchObservationsBySimilarity', () => {
    it('returns ranked SemanticSearchResult<ObservationRecord> array', async () => {
      const { repo, mockQuery } = buildRepoWithMockPool();
      const obsRow = {
        ...makeObservationRow(),
        _similarity: '0.92',
        _embedding_id: 'emb-uuid-99',
      };
      mockQuery.mockResolvedValueOnce({ rows: [obsRow] });

      const results: SemanticSearchResult<ObservationRecord>[] =
        await repo.searchObservationsBySimilarity(makeVector(0));

      expect(results).toHaveLength(1);
      expect(results[0].similarity).toBeCloseTo(0.92);
      expect(results[0].embedding_id).toBe('emb-uuid-99');
      expect(results[0].record.predicate).toBe('likes');
      // Private helper fields must be stripped from the record
      expect((results[0].record as Record<string, unknown>)._similarity).toBeUndefined();
      expect((results[0].record as Record<string, unknown>)._embedding_id).toBeUndefined();
    });

    it('applies topK default of 10 when no options given', async () => {
      const { repo, mockQuery } = buildRepoWithMockPool();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await repo.searchObservationsBySimilarity(makeVector(0));

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      // topK is the 5th parameter (index 4)
      expect(params[4]).toBe(10);
    });

    it('respects custom topK and minSimilarity options', async () => {
      const { repo, mockQuery } = buildRepoWithMockPool();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const options: SimilaritySearchOptions = { topK: 5, minSimilarity: 0.7 };
      await repo.searchObservationsBySimilarity(makeVector(0), options);

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params[3]).toBe(0.7);  // minSimilarity
      expect(params[4]).toBe(5);    // topK
    });

    it('filters by EMBEDDING_OWNER_KIND_OBSERVATION', async () => {
      const { repo, mockQuery } = buildRepoWithMockPool();
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await repo.searchObservationsBySimilarity(makeVector(0));

      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/owner_kind/);
      expect(params[1]).toBe(EMBEDDING_OWNER_KIND_OBSERVATION);
    });

    it('uses the default TALA_EMBEDDING_MODEL when no model option is given', async () => {
      const { repo, mockQuery } = buildRepoWithMockPool();
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await repo.searchObservationsBySimilarity(makeVector(0));

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params[2]).toBe(TALA_EMBEDDING_MODEL);
    });

    it('returns empty array when no embeddings match', async () => {
      const { repo, mockQuery } = buildRepoWithMockPool();
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const results = await repo.searchObservationsBySimilarity(makeVector(0));
      expect(results).toEqual([]);
    });
  });

  // ── createObservation with embedding ───────────────────────────────────────

  describe('createObservation with embedding integration', () => {
    it('stores the observation and upserts embedding when embedding is provided', async () => {
      const { repo, mockQuery } = buildRepoWithMockPool();
      const obsRow = makeObservationRow({ id: 'obs-auto-1' });
      const embRow = { id: 'emb-auto-1', owner_kind: 'observation', owner_id: 'obs-auto-1', chunk_index: 0, embedding_model: TALA_EMBEDDING_MODEL, content: 'likes: coffee', content_hash: 'x', metadata: {}, created_at: new Date() };

      // First call: INSERT observation RETURNING *
      mockQuery.mockResolvedValueOnce({ rows: [obsRow] });
      // Second call: upsertEmbedding INSERT ON CONFLICT
      mockQuery.mockResolvedValueOnce({ rows: [embRow] });

      const result = await repo.createObservation({
        observation_type: 'fact',
        predicate: 'likes',
        object_text: 'coffee',
        embedding: makeVector(5),
        embedding_model: TALA_EMBEDDING_MODEL,
      });

      expect(result.id).toBe('obs-auto-1');
      // Two DB queries should have been issued (observation + embedding upsert)
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('does NOT upsert an embedding when no embedding is provided', async () => {
      const { repo, mockQuery } = buildRepoWithMockPool();
      mockQuery.mockResolvedValueOnce({ rows: [makeObservationRow()] });

      await repo.createObservation({
        observation_type: 'fact',
        predicate: 'likes',
        object_text: 'tea',
      });

      // Only one DB query (the observation insert)
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('uses TALA_EMBEDDING_MODEL as default when embedding_model is omitted', async () => {
      const { repo, mockQuery } = buildRepoWithMockPool();
      mockQuery.mockResolvedValueOnce({ rows: [makeObservationRow({ id: 'obs-m1' })] });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'e', owner_kind: 'observation', owner_id: 'obs-m1', chunk_index: 0, embedding_model: TALA_EMBEDDING_MODEL, content: 'x', content_hash: 'y', metadata: {}, created_at: new Date() }] });

      await repo.createObservation({
        observation_type: 'fact',
        predicate: 'prefers',
        object_text: 'morning runs',
        embedding: makeVector(6),
        // No embedding_model supplied — should default to TALA_EMBEDDING_MODEL
      });

      const [, params] = mockQuery.mock.calls[1] as [string, unknown[]];
      // embedding_model is the 5th parameter in upsertEmbedding (index 4)
      expect(params[4]).toBe(TALA_EMBEDDING_MODEL);
    });
  });
});
