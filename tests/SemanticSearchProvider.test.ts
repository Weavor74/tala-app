/**
 * SemanticSearchProvider.test.ts
 *
 * Unit tests for SemanticSearchProvider.
 *
 * Validates:
 *   1. providerId is 'semantic'
 *   2. supportedModes includes 'semantic' and 'hybrid'
 *   3. search() embeds query and calls semanticSearchByVector
 *   4. Results normalized to NormalizedSearchResult with correct field mapping
 *   5. Notebook scope passes itemKeys to DB query
 *   6. Citation/provenance metadata preserved in result.metadata
 *   7. Graceful error handling — provider returns error without throwing
 *   8. Empty result set returns empty results array
 *   9. snippet truncated to 500 chars
 *  10. score equals similarity from DB hit
 *
 * Uses injected mock embedding provider — no real Ollama or database required.
 */

import { describe, it, expect, vi } from 'vitest';
import { SemanticSearchProvider, SEMANTIC_PROVIDER_ID } from '../electron/services/retrieval/providers/SemanticSearchProvider';
import type { RetrievalScopeResolved, RetrievalProviderOptions } from '../shared/retrieval/retrievalTypes';
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

const GLOBAL_SCOPE: RetrievalScopeResolved = {
  scopeType: 'global',
  uris: [],
  sourcePaths: [],
  itemKeys: [],
};

const NOTEBOOK_SCOPE: RetrievalScopeResolved = {
  scopeType: 'notebook',
  notebookId: 'nb-1',
  uris: ['https://example.com/a'],
  sourcePaths: [],
  itemKeys: ['item-key-1', 'item-key-2'],
};

const DEFAULT_OPTIONS: RetrievalProviderOptions = { topK: 5 };

function makeHit(overrides: Record<string, unknown> = {}) {
  return {
    chunk_id: 'chunk-uuid-1',
    document_id: 'doc-uuid-1',
    item_key: 'item-key-1',
    content: 'This is a test chunk.',
    char_start: 0,
    char_end: 21,
    section_label: 'Introduction',
    page_number: 1,
    title: 'Test Document',
    uri: 'https://example.com/doc',
    source_path: '/path/to/doc',
    source_type: 'web',
    provider_id: 'external:google',
    external_id: 'ext-001',
    citation_label: '[1]',
    display_domain: 'example.com',
    fetched_at: null,
    doc_content_hash: 'dochash123',
    similarity: 0.87,
    ...overrides,
  };
}

function makeEmbeddingProvider(
  embedFn?: (text: string) => Promise<number[]>,
): LocalEmbeddingProvider {
  return {
    embedText: vi.fn().mockImplementation(embedFn ?? (() => Promise.resolve(Array(768).fill(0.1)))),
    getModel: vi.fn().mockReturnValue('embeddinggemma'),
    getEndpoint: vi.fn().mockReturnValue('http://127.0.0.1:11434'),
    providerId: 'local-embedding',
  } as unknown as LocalEmbeddingProvider;
}

function makeEmbeddingsRepo(hits: ReturnType<typeof makeHit>[] = [makeHit()]) {
  return {
    semanticSearchByVector: vi.fn().mockResolvedValue(hits),
    upsertChunkEmbedding: vi.fn(),
    getEmbeddingByChunkIdAndModel: vi.fn().mockResolvedValue(null),
    getChunksMissingEmbeddings: vi.fn().mockResolvedValue([]),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SemanticSearchProvider — identity', () => {
  it('has providerId = semantic', () => {
    const repo = makeEmbeddingsRepo();
    const provider = new SemanticSearchProvider(repo as any, undefined, makeEmbeddingProvider());
    expect(provider.id).toBe(SEMANTIC_PROVIDER_ID);
    expect(provider.id).toBe('semantic');
  });

  it('supports semantic and hybrid modes', () => {
    const repo = makeEmbeddingsRepo();
    const provider = new SemanticSearchProvider(repo as any, undefined, makeEmbeddingProvider());
    expect(provider.supportedModes).toContain('semantic');
    expect(provider.supportedModes).toContain('hybrid');
  });
});

describe('SemanticSearchProvider — search', () => {
  it('embeds query text and calls semanticSearchByVector', async () => {
    const repo = makeEmbeddingsRepo();
    const embedProvider = makeEmbeddingProvider();
    const provider = new SemanticSearchProvider(repo as any, undefined, embedProvider);

    await provider.search('test query', GLOBAL_SCOPE, DEFAULT_OPTIONS);

    expect(embedProvider.embedText).toHaveBeenCalledWith('test query');
    expect(repo.semanticSearchByVector).toHaveBeenCalledOnce();
  });

  it('normalizes hit to NormalizedSearchResult', async () => {
    const repo = makeEmbeddingsRepo();
    const provider = new SemanticSearchProvider(repo as any, undefined, makeEmbeddingProvider());

    const result = await provider.search('test query', GLOBAL_SCOPE, DEFAULT_OPTIONS);

    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(1);

    const r = result.results[0];
    expect(r.itemKey).toBe('item-key-1');
    expect(r.title).toBe('Test Document');
    expect(r.uri).toBe('https://example.com/doc');
    expect(r.sourcePath).toBe('/path/to/doc');
    expect(r.sourceType).toBe('web');
    expect(r.providerId).toBe('semantic');
    expect(r.externalId).toBe('ext-001');
    expect(r.contentHash).toBe('dochash123');
    expect(r.score).toBeCloseTo(0.87);
    expect(r.snippet).toBe('This is a test chunk.');
  });

  it('preserves citation/provenance metadata in result.metadata', async () => {
    const repo = makeEmbeddingsRepo();
    const provider = new SemanticSearchProvider(repo as any, undefined, makeEmbeddingProvider());

    const result = await provider.search('test query', GLOBAL_SCOPE, DEFAULT_OPTIONS);
    const meta = result.results[0].metadata!;

    expect(meta.chunkId).toBe('chunk-uuid-1');
    expect(meta.documentId).toBe('doc-uuid-1');
    expect(meta.similarity).toBeCloseTo(0.87);
    expect(meta.charStart).toBe(0);
    expect(meta.charEnd).toBe(21);
    expect(meta.sectionLabel).toBe('Introduction');
    expect(meta.pageNumber).toBe(1);
    expect(meta.citationLabel).toBe('[1]');
    expect(meta.displayDomain).toBe('example.com');
    expect(meta.providerProvenance).toBe('external:google');
  });

  it('passes notebook scope itemKeys to DB query', async () => {
    const repo = makeEmbeddingsRepo();
    const provider = new SemanticSearchProvider(repo as any, undefined, makeEmbeddingProvider());

    await provider.search('notebook query', NOTEBOOK_SCOPE, DEFAULT_OPTIONS);

    expect(repo.semanticSearchByVector).toHaveBeenCalledWith(
      expect.objectContaining({ itemKeys: ['item-key-1', 'item-key-2'] }),
    );
  });

  it('returns empty results gracefully', async () => {
    const repo = makeEmbeddingsRepo([]);
    const provider = new SemanticSearchProvider(repo as any, undefined, makeEmbeddingProvider());

    const result = await provider.search('no results', GLOBAL_SCOPE, DEFAULT_OPTIONS);

    expect(result.results).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });

  it('captures embedding failure as provider error (never throws)', async () => {
    const embedProvider = makeEmbeddingProvider(
      (_text: string) => Promise.reject(new Error('Ollama unavailable')),
    );
    const repo = makeEmbeddingsRepo();
    const provider = new SemanticSearchProvider(repo as any, undefined, embedProvider);

    const result = await provider.search('error query', GLOBAL_SCOPE, DEFAULT_OPTIONS);

    expect(result.results).toHaveLength(0);
    expect(result.error).toContain('Ollama unavailable');
  });

  it('captures DB error as provider error (never throws)', async () => {
    const repo = {
      semanticSearchByVector: vi.fn().mockRejectedValue(new Error('DB query failed')),
    };
    const provider = new SemanticSearchProvider(repo as any, undefined, makeEmbeddingProvider());

    const result = await provider.search('db error', GLOBAL_SCOPE, DEFAULT_OPTIONS);

    expect(result.results).toHaveLength(0);
    expect(result.error).toContain('DB query failed');
  });

  it('truncates snippet to 500 characters', async () => {
    const longContent = 'A'.repeat(1000);
    const repo = makeEmbeddingsRepo([makeHit({ content: longContent })]);
    const provider = new SemanticSearchProvider(repo as any, undefined, makeEmbeddingProvider());

    const result = await provider.search('test', GLOBAL_SCOPE, DEFAULT_OPTIONS);

    expect(result.results[0].snippet!.length).toBeLessThanOrEqual(500);
  });

  it('falls back to citation_label for title when title is null', async () => {
    const repo = makeEmbeddingsRepo([makeHit({ title: null, citation_label: '[2] Fallback Title' })]);
    const provider = new SemanticSearchProvider(repo as any, undefined, makeEmbeddingProvider());

    const result = await provider.search('test', GLOBAL_SCOPE, DEFAULT_OPTIONS);

    expect(result.results[0].title).toBe('[2] Fallback Title');
  });

  it('returns correct providerId in result', async () => {
    const repo = makeEmbeddingsRepo();
    const provider = new SemanticSearchProvider(repo as any, undefined, makeEmbeddingProvider());

    const result = await provider.search('test', GLOBAL_SCOPE, DEFAULT_OPTIONS);

    expect(result.providerId).toBe('semantic');
    expect(result.results[0].providerId).toBe('semantic');
  });
});
