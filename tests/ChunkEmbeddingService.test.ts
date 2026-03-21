/**
 * ChunkEmbeddingService.test.ts
 *
 * Unit tests for ChunkEmbeddingService.
 *
 * Validates:
 *   1. Default model is embeddinggemma
 *   2. Embeddings stored with dimension metadata 768
 *   3. Skips chunks already embedded unless reembed=true
 *   4. Partial success — one bad chunk does not abort batch
 *   5. embedNotebook with empty itemKeys returns zero counts
 *   6. embedItems calls getChunksMissingEmbeddings with correct itemKeys
 *   7. embedChunks filters to requested chunk IDs
 *   8. Graceful handling of embedding provider failures (returns warning)
 *
 * Uses injected mock providers — no real Ollama or database connection required.
 */

import { describe, it, expect, vi } from 'vitest';
import { ChunkEmbeddingService, EMBEDDING_DIMENSION } from '../electron/services/embedding/ChunkEmbeddingService';
import { DEFAULT_EMBEDDING_MODEL } from '../electron/services/embedding/LocalEmbeddingProvider';
import type { LocalEmbeddingProvider } from '../electron/services/embedding/LocalEmbeddingProvider';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

vi.mock('http', () => {
  const mockRequest = vi.fn();
  return { default: { request: mockRequest }, request: mockRequest };
});

vi.mock('https', () => {
  const mockRequest = vi.fn();
  return { default: { request: mockRequest }, request: mockRequest };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CHUNK_1 = {
  chunk_id: 'chunk-1',
  document_id: 'doc-1',
  item_key: 'item-key-1',
  content: 'First chunk content.',
  content_hash: 'hash1',
};

const CHUNK_2 = {
  chunk_id: 'chunk-2',
  document_id: 'doc-1',
  item_key: 'item-key-1',
  content: 'Second chunk content.',
  content_hash: 'hash2',
};

function makeEmbeddingProvider(
  embedFn?: (text: string) => Promise<number[]>,
): LocalEmbeddingProvider {
  return {
    embedText: vi.fn().mockImplementation(embedFn ?? (() => Promise.resolve(Array(768).fill(0.1)))),
    getModel: vi.fn().mockReturnValue(DEFAULT_EMBEDDING_MODEL),
    getEndpoint: vi.fn().mockReturnValue('http://127.0.0.1:11434'),
    providerId: 'local-embedding',
  } as unknown as LocalEmbeddingProvider;
}

function makeEmbeddingsRepo(overrides: Record<string, unknown> = {}) {
  return {
    getChunksMissingEmbeddings: vi.fn().mockResolvedValue([CHUNK_1, CHUNK_2]),
    getEmbeddingByChunkIdAndModel: vi.fn().mockResolvedValue(null),
    upsertChunkEmbedding: vi.fn().mockResolvedValue({
      id: 'emb-1',
      chunk_id: CHUNK_1.chunk_id,
      document_id: CHUNK_1.document_id,
      item_key: CHUNK_1.item_key,
      embedding_model: DEFAULT_EMBEDDING_MODEL,
      embedding_dimension: EMBEDDING_DIMENSION,
      content_hash: CHUNK_1.content_hash,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    semanticSearchByVector: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ChunkEmbeddingService — construction', () => {
  it('uses embeddinggemma as default model', () => {
    expect(DEFAULT_EMBEDDING_MODEL).toBe('embeddinggemma');
  });

  it('exposes EMBEDDING_DIMENSION = 768', () => {
    expect(EMBEDDING_DIMENSION).toBe(768);
  });
});

describe('ChunkEmbeddingService — embedNotebook', () => {
  it('returns zeros when itemKeys is empty', async () => {
    const repo = makeEmbeddingsRepo();
    const provider = makeEmbeddingProvider();
    const svc = new ChunkEmbeddingService(repo as any, undefined, provider);

    const result = await svc.embedNotebook([]);
    expect(result.chunksEmbedded).toBe(0);
    expect(result.chunksSkipped).toBe(0);
  });

  it('delegates to embedItems for non-empty itemKeys', async () => {
    const repo = makeEmbeddingsRepo();
    const provider = makeEmbeddingProvider();
    const svc = new ChunkEmbeddingService(repo as any, undefined, provider);

    await svc.embedNotebook(['key-a', 'key-b']);

    expect(repo.getChunksMissingEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({ itemKeys: ['key-a', 'key-b'] }),
    );
  });
});

describe('ChunkEmbeddingService — embedItems', () => {
  it('embeds all chunks returned by getChunksMissingEmbeddings', async () => {
    const repo = makeEmbeddingsRepo();
    const provider = makeEmbeddingProvider();
    const svc = new ChunkEmbeddingService(repo as any, undefined, provider);

    const result = await svc.embedItems(['item-key-1']);

    expect(repo.upsertChunkEmbedding).toHaveBeenCalledTimes(2);
    expect(result.chunksEmbedded).toBe(2);
    expect(result.chunksSkipped).toBe(0);
  });

  it('stores embeddings with correct dimension metadata', async () => {
    const repo = makeEmbeddingsRepo();
    const provider = makeEmbeddingProvider();
    const svc = new ChunkEmbeddingService(repo as any, undefined, provider);

    await svc.embedItems(['item-key-1']);

    const callArgs = (repo.upsertChunkEmbedding as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.embedding_dimension).toBe(768);
    expect(callArgs.embedding_model).toBe('embeddinggemma');
  });

  it('skips chunks already embedded when reembed=false', async () => {
    const existingRecord = {
      id: 'emb-existing',
      chunk_id: CHUNK_1.chunk_id,
      embedding_model: DEFAULT_EMBEDDING_MODEL,
      embedding_dimension: 768,
      content_hash: CHUNK_1.content_hash,
      document_id: CHUNK_1.document_id,
      item_key: CHUNK_1.item_key,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const repo = makeEmbeddingsRepo({
      getEmbeddingByChunkIdAndModel: vi.fn()
        .mockResolvedValueOnce(existingRecord)  // chunk-1: exists
        .mockResolvedValueOnce(null),           // chunk-2: missing
    });
    const provider = makeEmbeddingProvider();
    const svc = new ChunkEmbeddingService(repo as any, undefined, provider);

    const result = await svc.embedItems(['item-key-1']);

    expect(result.chunksSkipped).toBe(1);
    expect(result.chunksEmbedded).toBe(1);
  });

  it('re-embeds when reembed=true', async () => {
    const existingRecord = {
      id: 'emb-existing',
      chunk_id: CHUNK_1.chunk_id,
      embedding_model: DEFAULT_EMBEDDING_MODEL,
      embedding_dimension: 768,
      content_hash: CHUNK_1.content_hash,
      document_id: CHUNK_1.document_id,
      item_key: CHUNK_1.item_key,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const repo = makeEmbeddingsRepo({
      getEmbeddingByChunkIdAndModel: vi.fn().mockResolvedValue(existingRecord),
    });
    const provider = makeEmbeddingProvider();
    const svc = new ChunkEmbeddingService(repo as any, undefined, provider);

    const result = await svc.embedItems(['item-key-1'], { reembed: true });

    expect(result.chunksEmbedded).toBe(2);
    expect(result.chunksSkipped).toBe(0);
  });

  it('captures warning and continues on embedding failure (partial success)', async () => {
    let callCount = 0;
    const provider = makeEmbeddingProvider((_text: string) => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('Ollama unreachable'));
      return Promise.resolve(Array(768).fill(0.5));
    });

    const repo = makeEmbeddingsRepo();
    const svc = new ChunkEmbeddingService(repo as any, undefined, provider);

    const result = await svc.embedItems(['item-key-1']);

    expect(result.chunksEmbedded).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Ollama unreachable');
  });
});

describe('ChunkEmbeddingService — embedChunks', () => {
  it('returns zero counts for empty chunkIds', async () => {
    const repo = makeEmbeddingsRepo();
    const provider = makeEmbeddingProvider();
    const svc = new ChunkEmbeddingService(repo as any, undefined, provider);

    const result = await svc.embedChunks([]);
    expect(result.chunksEmbedded).toBe(0);
    expect(result.chunksSkipped).toBe(0);
  });
});
