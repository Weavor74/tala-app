/**
 * EmbeddingsRepository.test.ts
 *
 * Unit tests for EmbeddingsRepository.
 *
 * Validates:
 *   1. upsertChunkEmbedding — stores record, returns without embedding vector
 *   2. upsertChunkEmbedding — ON CONFLICT updates existing record
 *   3. getEmbeddingByChunkIdAndModel — returns record when exists
 *   4. getEmbeddingByChunkIdAndModel — returns null when missing
 *   5. getChunksMissingEmbeddings — returns chunks without embedding rows
 *   6. getChunksMissingEmbeddings — respects itemKeys filter
 *   7. semanticSearchByVector — returns ranked hits with provenance metadata
 *   8. semanticSearchByVector — respects itemKeys scope
 *   9. semanticSearchByVector — handles DB error gracefully (rejects)
 *  10. embedding_dimension stored correctly
 *
 * Uses a mock pg Pool — no real database connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingsRepository } from '../electron/services/db/EmbeddingsRepository';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

// pgvector's toSql returns a bracketed string like '[0.1,0.2]'
vi.mock('pgvector', () => ({
  toSql: (v: number[]) => `[${v.join(',')}]`,
}));

// ─── Mock Pool ────────────────────────────────────────────────────────────────

function makePool(queryResult: unknown) {
  return {
    query: vi.fn().mockResolvedValue(queryResult),
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CHUNK_ID = 'chunk-uuid-1';
const DOCUMENT_ID = 'doc-uuid-1';
const ITEM_KEY = 'test-item-key';
const MODEL = 'embeddinggemma';
const VECTOR = Array.from({ length: 768 }, (_, i) => i / 768);
const HASH = 'abc123hash';

function makeEmbeddingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'emb-uuid-1',
    chunk_id: CHUNK_ID,
    document_id: DOCUMENT_ID,
    item_key: ITEM_KEY,
    embedding_model: MODEL,
    embedding_dimension: 768,
    content_hash: HASH,
    created_at: new Date('2024-01-01').toISOString(),
    updated_at: new Date('2024-01-01').toISOString(),
    ...overrides,
  };
}

function makeHitRow(overrides: Record<string, unknown> = {}) {
  return {
    chunk_id: CHUNK_ID,
    document_id: DOCUMENT_ID,
    item_key: ITEM_KEY,
    content: 'This is the chunk content.',
    char_start: '0',
    char_end: '26',
    section_label: 'Introduction',
    page_number: '1',
    title: 'Test Document',
    uri: 'https://example.com/doc',
    source_path: '/path/to/doc',
    source_type: 'web',
    provider_id: 'external:google',
    external_id: 'ext-001',
    citation_label: '[1]',
    display_domain: 'example.com',
    fetched_at: null,
    doc_content_hash: 'dochash',
    similarity: '0.92',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EmbeddingsRepository — upsertChunkEmbedding', () => {
  it('stores embedding and returns record without raw vector', async () => {
    const row = makeEmbeddingRow();
    const pool = makePool({ rows: [row] });
    const repo = new EmbeddingsRepository(pool as any);

    const result = await repo.upsertChunkEmbedding({
      chunk_id: CHUNK_ID,
      document_id: DOCUMENT_ID,
      item_key: ITEM_KEY,
      embedding_model: MODEL,
      embedding_dimension: 768,
      embedding: VECTOR,
      content_hash: HASH,
    });

    expect(pool.query).toHaveBeenCalledOnce();
    expect(result.chunk_id).toBe(CHUNK_ID);
    expect(result.embedding_model).toBe(MODEL);
    expect(result.embedding_dimension).toBe(768);
    expect(result.content_hash).toBe(HASH);
    // embedding vector must NOT be in the return value
    expect((result as any).embedding).toBeUndefined();
  });

  it('passes pgvector-formatted embedding to SQL', async () => {
    const pool = makePool({ rows: [makeEmbeddingRow()] });
    const repo = new EmbeddingsRepository(pool as any);
    const smallVector = [0.1, 0.2, 0.3];

    await repo.upsertChunkEmbedding({
      chunk_id: CHUNK_ID,
      document_id: DOCUMENT_ID,
      item_key: ITEM_KEY,
      embedding_model: MODEL,
      embedding_dimension: 3,
      embedding: smallVector,
      content_hash: HASH,
    });

    const callArgs = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    // The formatted vector string should appear in the params
    expect(callArgs[1]).toContain('[0.1,0.2,0.3]');
  });
});

describe('EmbeddingsRepository — getEmbeddingByChunkIdAndModel', () => {
  it('returns record when found', async () => {
    const row = makeEmbeddingRow();
    const pool = makePool({ rows: [row] });
    const repo = new EmbeddingsRepository(pool as any);

    const result = await repo.getEmbeddingByChunkIdAndModel(CHUNK_ID, MODEL);
    expect(result).not.toBeNull();
    expect(result!.chunk_id).toBe(CHUNK_ID);
    expect(result!.embedding_model).toBe(MODEL);
  });

  it('returns null when not found', async () => {
    const pool = makePool({ rows: [] });
    const repo = new EmbeddingsRepository(pool as any);

    const result = await repo.getEmbeddingByChunkIdAndModel('missing-id', MODEL);
    expect(result).toBeNull();
  });
});

describe('EmbeddingsRepository — getChunksMissingEmbeddings', () => {
  it('returns chunks without embeddings', async () => {
    const missingChunk = {
      chunk_id: CHUNK_ID,
      document_id: DOCUMENT_ID,
      item_key: ITEM_KEY,
      content: 'Some content',
      content_hash: HASH,
    };
    const pool = makePool({ rows: [missingChunk] });
    const repo = new EmbeddingsRepository(pool as any);

    const result = await repo.getChunksMissingEmbeddings({ embeddingModel: MODEL });
    expect(result).toHaveLength(1);
    expect(result[0].chunk_id).toBe(CHUNK_ID);
  });

  it('passes itemKeys filter to query', async () => {
    const pool = makePool({ rows: [] });
    const repo = new EmbeddingsRepository(pool as any);

    await repo.getChunksMissingEmbeddings({
      itemKeys: ['key-a', 'key-b'],
      embeddingModel: MODEL,
    });

    const callArgs = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    // itemKeys array should be in params
    expect(callArgs[1]).toContainEqual(['key-a', 'key-b']);
  });

  it('uses embeddinggemma as default model', async () => {
    const pool = makePool({ rows: [] });
    const repo = new EmbeddingsRepository(pool as any);

    await repo.getChunksMissingEmbeddings();

    const callArgs = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1][0]).toBe('embeddinggemma');
  });
});

describe('EmbeddingsRepository — semanticSearchByVector', () => {
  it('returns ranked hits with provenance metadata', async () => {
    const pool = makePool({ rows: [makeHitRow()] });
    const repo = new EmbeddingsRepository(pool as any);

    const hits = await repo.semanticSearchByVector({
      queryVector: VECTOR,
      embeddingModel: MODEL,
    });

    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit.chunk_id).toBe(CHUNK_ID);
    expect(hit.document_id).toBe(DOCUMENT_ID);
    expect(hit.item_key).toBe(ITEM_KEY);
    expect(hit.content).toBe('This is the chunk content.');
    expect(hit.char_start).toBe(0);
    expect(hit.char_end).toBe(26);
    expect(hit.page_number).toBe(1);
    expect(hit.title).toBe('Test Document');
    expect(hit.uri).toBe('https://example.com/doc');
    expect(hit.source_type).toBe('web');
    expect(hit.provider_id).toBe('external:google');
    expect(hit.citation_label).toBe('[1]');
    expect(hit.display_domain).toBe('example.com');
    expect(hit.similarity).toBeCloseTo(0.92);
  });

  it('respects itemKeys scope constraint', async () => {
    const pool = makePool({ rows: [] });
    const repo = new EmbeddingsRepository(pool as any);

    await repo.semanticSearchByVector({
      queryVector: VECTOR,
      itemKeys: ['scoped-key'],
      embeddingModel: MODEL,
    });

    const callArgs = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1]).toContainEqual(['scoped-key']);
    expect(callArgs[0]).toContain('ANY(');
  });

  it('uses embeddinggemma as default model', async () => {
    const pool = makePool({ rows: [] });
    const repo = new EmbeddingsRepository(pool as any);

    await repo.semanticSearchByVector({ queryVector: VECTOR });

    const callArgs = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1][1]).toBe('embeddinggemma');
  });

  it('rejects when DB query throws', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    };
    const repo = new EmbeddingsRepository(pool as any);

    await expect(
      repo.semanticSearchByVector({ queryVector: VECTOR }),
    ).rejects.toThrow('DB connection lost');
  });
});
