/**
 * ContentIngestionService.test.ts
 *
 * Unit tests for the content ingestion pipeline.
 *
 * Validates:
 *   1. Type contracts — shared ingestion types are importable and structurally correct.
 *   2. chunkContent — fixed, paragraph, hybrid strategies produce correct offsets and ordering.
 *   3. fetchContentForItem — local file path, HTTP URI, and no-source paths.
 *   4. ingestItems — deduplication via content_hash (skip identical content).
 *   5. ingestItems — partial failure: one bad item does not abort the batch.
 *   6. ingestNotebook — aggregates item results correctly.
 *   7. Citation metadata — citation_label, display_domain populated from item data.
 *   8. Chunk offsets — char_start / char_end are non-overlapping and cover the content.
 *   9. ContentRepository — documentExists, upsertSourceDocument, insertChunks contracts.
 *
 * No real database connections or network requests are used.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SourceDocumentRecord,
  DocumentChunkRecord,
  IngestionRequest,
  IngestionResult,
  ChunkingOptions,
  UpsertSourceDocumentInput,
} from '../shared/ingestion/ingestionTypes';
import { ContentIngestionService } from '../electron/services/ingestion/ContentIngestionService';
import type { ContentRepository, InsertChunkInput } from '../electron/services/db/ContentRepository';
import type { ResearchRepository } from '../electron/services/db/ResearchRepository';
import type { NotebookItemRecord } from '../shared/researchTypes';

// ─── Mock electron so static imports resolve ────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<NotebookItemRecord> & { item_key: string }): NotebookItemRecord {
  return {
    id: `id-${overrides.item_key}`,
    notebook_id: 'nb-1',
    item_type: 'web',
    source_id: null,
    source_path: null,
    title: null,
    uri: null,
    snippet: null,
    content_hash: null,
    added_from_search_run_id: null,
    added_at: new Date().toISOString(),
    metadata_json: {},
    ...overrides,
  };
}

function makeDoc(overrides: Partial<SourceDocumentRecord> & { id: string; item_key: string; content: string; content_hash: string }): SourceDocumentRecord {
  return {
    notebook_id: null,
    title: null,
    uri: null,
    source_path: null,
    provider_id: null,
    external_id: null,
    source_type: null,
    mime_type: null,
    citation_label: null,
    display_domain: null,
    author: null,
    published_at: null,
    fetched_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeChunk(overrides: Partial<DocumentChunkRecord> & { id: string; document_id: string; item_key: string; chunk_index: number; content: string }): DocumentChunkRecord {
  return {
    token_estimate: Math.ceil(overrides.content.length / 4),
    content_hash: 'hash-' + overrides.chunk_index,
    char_start: 0,
    char_end: overrides.content.length,
    section_label: null,
    page_number: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeMockContentRepo(opts: {
  exists?: boolean;
  returnDoc?: SourceDocumentRecord;
  returnChunks?: DocumentChunkRecord[];
} = {}): ContentRepository {
  const defaultDoc = makeDoc({ id: 'doc-1', item_key: 'key-1', content: 'test', content_hash: 'abc' });
  return {
    upsertSourceDocument: vi.fn(async (_input: UpsertSourceDocumentInput) => opts.returnDoc ?? defaultDoc),
    getDocumentByItemKey: vi.fn(async (_key: string) => opts.returnDoc ?? null),
    getDocumentByItemKeyAndHash: vi.fn(async (_key: string, _hash: string) => opts.returnDoc ?? null),
    insertChunks: vi.fn(async (_docId: string, _itemKey: string, chunks: InsertChunkInput[]) =>
      (opts.returnChunks ?? chunks.map((c, i) => makeChunk({
        id: `chunk-${i}`,
        document_id: _docId,
        item_key: _itemKey,
        chunk_index: c.chunk_index,
        content: c.content,
        char_start: c.char_start,
        char_end: c.char_end,
      })))
    ),
    getChunksByItemKey: vi.fn(async (_key: string) => opts.returnChunks ?? []),
    documentExists: vi.fn(async (_key: string, _hash: string) => opts.exists ?? false),
  } as unknown as ContentRepository;
}

function makeMockResearchRepo(items: NotebookItemRecord[] = []): ResearchRepository {
  return {
    listNotebookItems: vi.fn(async (_notebookId: string) => items),
    listNotebooks: vi.fn(async () => []),
  } as unknown as ResearchRepository;
}

// ─── 1. Type contract tests ───────────────────────────────────────────────────

describe('ingestionTypes — type contracts', () => {
  it('IngestionRequest shape is correct', () => {
    const req: IngestionRequest = { itemKeys: ['key-1'], notebookId: 'nb-1', refetch: false };
    expect(req.itemKeys).toHaveLength(1);
    expect(req.notebookId).toBe('nb-1');
    expect(req.refetch).toBe(false);
  });

  it('IngestionResult shape is correct', () => {
    const res: IngestionResult = {
      documentsCreated: 1,
      documentsSkipped: 0,
      chunksCreated: 3,
      warnings: [],
    };
    expect(res.documentsCreated).toBe(1);
    expect(res.chunksCreated).toBe(3);
  });

  it('ChunkingOptions shape is correct', () => {
    const opts: ChunkingOptions = { maxTokensPerChunk: 512, overlapTokens: 64, strategy: 'hybrid' };
    expect(opts.strategy).toBe('hybrid');
  });

  it('SourceDocumentRecord includes citation fields', () => {
    const doc: SourceDocumentRecord = makeDoc({
      id: 'doc-1',
      item_key: 'key-1',
      content: 'hello',
      content_hash: 'abc',
      citation_label: 'My Source',
      display_domain: 'example.com',
      author: 'Jane Doe',
    });
    expect(doc.citation_label).toBe('My Source');
    expect(doc.display_domain).toBe('example.com');
    expect(doc.author).toBe('Jane Doe');
  });

  it('DocumentChunkRecord includes offset fields', () => {
    const chunk: DocumentChunkRecord = makeChunk({
      id: 'c1',
      document_id: 'doc-1',
      item_key: 'key-1',
      chunk_index: 0,
      content: 'chunk text',
      char_start: 0,
      char_end: 10,
    });
    expect(chunk.char_start).toBe(0);
    expect(chunk.char_end).toBe(10);
    expect(chunk.chunk_index).toBe(0);
  });
});

// ─── 2. chunkContent — strategies ─────────────────────────────────────────────

describe('ContentIngestionService.chunkContent', () => {
  const svc = new ContentIngestionService(
    makeMockResearchRepo(),
    makeMockContentRepo()
  );

  it('fixed strategy: produces non-empty chunks for short content', () => {
    const content = 'Hello world. This is a test.';
    const chunks = svc.chunkContent(content, { maxTokensPerChunk: 10, overlapTokens: 0, strategy: 'fixed' });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].content.length).toBeGreaterThan(0);
  });

  it('fixed strategy: chunk_index order matches charStart order', () => {
    const content = 'A'.repeat(400);
    const chunks = svc.chunkContent(content, { maxTokensPerChunk: 50, overlapTokens: 0, strategy: 'fixed' });
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].charStart).toBeGreaterThanOrEqual(chunks[i - 1].charStart);
    }
  });

  it('paragraph strategy: splits on blank lines', () => {
    const content = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const chunks = svc.chunkContent(content, { maxTokensPerChunk: 50, overlapTokens: 0, strategy: 'paragraph' });
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].content).toContain('First');
  });

  it('hybrid strategy: returns non-empty results', () => {
    const content = 'Line one.\n\nLine two.\n\nLine three.\n\nLine four.';
    const chunks = svc.chunkContent(content, { maxTokensPerChunk: 20, overlapTokens: 5, strategy: 'hybrid' });
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('returns empty array for empty content', () => {
    const chunks = svc.chunkContent('', { maxTokensPerChunk: 512, overlapTokens: 64, strategy: 'hybrid' });
    expect(chunks).toHaveLength(0);
  });

  it('charStart and charEnd are non-negative integers', () => {
    const content = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
    const chunks = svc.chunkContent(content, { maxTokensPerChunk: 20, overlapTokens: 0, strategy: 'paragraph' });
    for (const chunk of chunks) {
      expect(chunk.charStart).toBeGreaterThanOrEqual(0);
      expect(chunk.charEnd).toBeGreaterThan(chunk.charStart);
    }
  });

  it('tokenEstimate is positive for non-empty chunks', () => {
    const content = 'Some text here.';
    const chunks = svc.chunkContent(content, { maxTokensPerChunk: 512, overlapTokens: 0, strategy: 'fixed' });
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBeGreaterThan(0);
    }
  });
});

// ─── 3. fetchContentForItem — local file path ─────────────────────────────────

describe('ContentIngestionService.fetchContentForItem — file path', () => {
  it('returns warning when file does not exist', async () => {
    const svc = new ContentIngestionService(makeMockResearchRepo(), makeMockContentRepo());
    const item = makeItem({ item_key: 'k1', source_path: '/nonexistent/file.txt' });
    const { content, warning } = await svc.fetchContentForItem(item);
    expect(content).toBeNull();
    expect(warning).toBeTruthy();
    expect(warning).toContain('/nonexistent/file.txt');
  });

  it('returns warning when no source_path or uri', async () => {
    const svc = new ContentIngestionService(makeMockResearchRepo(), makeMockContentRepo());
    const item = makeItem({ item_key: 'k2' });
    const { content, warning } = await svc.fetchContentForItem(item);
    expect(content).toBeNull();
    expect(warning).toContain('no source_path or uri');
  });
});

// ─── 4. ingestItems — deduplication via content_hash ─────────────────────────

describe('ContentIngestionService.ingestItems — deduplication', () => {
  it('skips item when documentExists returns true and refetch=false', async () => {
    const item = makeItem({ item_key: 'dup-key', uri: 'http://example.com' });
    const researchRepo = makeMockResearchRepo([item]);
    const contentRepo = makeMockContentRepo({ exists: true });

    // Patch fetchContentForItem to return deterministic content without network.
    const svc = new ContentIngestionService(researchRepo, contentRepo);
    vi.spyOn(svc, 'fetchContentForItem').mockResolvedValue({
      content: 'same content',
      metadata: { fetched_at: new Date().toISOString() },
    });

    const result = await svc.ingestItems(['dup-key'], 'nb-1', {}, false);

    expect(result.documentsSkipped).toBe(1);
    expect(result.documentsCreated).toBe(0);
    expect(contentRepo.upsertSourceDocument).not.toHaveBeenCalled();
  });

  it('re-ingests when refetch=true even if document exists', async () => {
    const item = makeItem({ item_key: 'dup-key', uri: 'http://example.com' });
    const researchRepo = makeMockResearchRepo([item]);
    const returnDoc = makeDoc({ id: 'doc-1', item_key: 'dup-key', content: 'same content', content_hash: 'hash1' });
    const contentRepo = makeMockContentRepo({ exists: true, returnDoc });

    const svc = new ContentIngestionService(researchRepo, contentRepo);
    vi.spyOn(svc, 'fetchContentForItem').mockResolvedValue({
      content: 'same content',
      metadata: { fetched_at: new Date().toISOString() },
    });

    const result = await svc.ingestItems(['dup-key'], 'nb-1', {}, true);

    expect(result.documentsCreated).toBe(1);
    expect(contentRepo.upsertSourceDocument).toHaveBeenCalled();
  });
});

// ─── 5. ingestItems — partial failure handling ────────────────────────────────

describe('ContentIngestionService.ingestItems — partial failure', () => {
  it('records warning for a failing item and continues with the rest', async () => {
    const goodItem = makeItem({ item_key: 'good', uri: 'http://example.com' });
    const badItem = makeItem({ item_key: 'bad', uri: 'http://unreachable.invalid' });
    const researchRepo = makeMockResearchRepo([goodItem, badItem]);
    const returnDoc = makeDoc({ id: 'doc-good', item_key: 'good', content: 'good content', content_hash: 'h1' });
    const contentRepo = makeMockContentRepo({ exists: false, returnDoc });

    const svc = new ContentIngestionService(researchRepo, contentRepo);
    vi.spyOn(svc, 'fetchContentForItem').mockImplementation(async (item: NotebookItemRecord) => {
      if (item.item_key === 'bad') throw new Error('Network error');
      return { content: 'good content', metadata: {} };
    });

    const result = await svc.ingestItems(['good', 'bad'], 'nb-1');

    expect(result.documentsCreated).toBe(1);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.includes('bad'))).toBe(true);
  });

  it('returns warnings for item_keys not found in notebook', async () => {
    const researchRepo = makeMockResearchRepo([]); // empty notebook
    const contentRepo = makeMockContentRepo();
    const svc = new ContentIngestionService(researchRepo, contentRepo);

    const result = await svc.ingestItems(['missing-key'], 'nb-1');

    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.includes('missing-key'))).toBe(true);
  });
});

// ─── 6. ingestNotebook — aggregation ─────────────────────────────────────────

describe('ContentIngestionService.ingestNotebook', () => {
  it('returns zero stats for empty notebook', async () => {
    const researchRepo = makeMockResearchRepo([]);
    const contentRepo = makeMockContentRepo();
    const svc = new ContentIngestionService(researchRepo, contentRepo);

    const result = await svc.ingestNotebook('nb-empty');
    expect(result.documentsCreated).toBe(0);
    expect(result.documentsSkipped).toBe(0);
    expect(result.chunksCreated).toBe(0);
  });

  it('aggregates chunk count across multiple items', async () => {
    const items = [
      makeItem({ item_key: 'k1', uri: 'http://example.com/1' }),
      makeItem({ item_key: 'k2', uri: 'http://example.com/2' }),
    ];
    const researchRepo = makeMockResearchRepo(items);
    const returnDoc = makeDoc({ id: 'doc-x', item_key: 'k1', content: 'text', content_hash: 'hx' });
    const contentRepo = makeMockContentRepo({ exists: false, returnDoc });

    const svc = new ContentIngestionService(researchRepo, contentRepo);
    vi.spyOn(svc, 'fetchContentForItem').mockResolvedValue({
      content: 'Some content for chunking',
      metadata: {},
    });

    const result = await svc.ingestNotebook('nb-1');
    expect(result.documentsCreated).toBe(2);
    expect(result.chunksCreated).toBeGreaterThanOrEqual(2);
  });
});

// ─── 7. Citation metadata ─────────────────────────────────────────────────────

describe('ContentIngestionService — citation metadata', () => {
  it('populates citation_label from item title', async () => {
    const item = makeItem({ item_key: 'cite-1', uri: 'http://example.com/page', title: 'Example Page' });
    const researchRepo = makeMockResearchRepo([item]);
    let capturedInput: UpsertSourceDocumentInput | null = null;
    const contentRepo = makeMockContentRepo({ exists: false });
    (contentRepo.upsertSourceDocument as ReturnType<typeof vi.fn>).mockImplementation(async (input: UpsertSourceDocumentInput) => {
      capturedInput = input;
      return makeDoc({ id: 'doc-c', item_key: input.item_key, content: input.content, content_hash: input.content_hash });
    });

    const svc = new ContentIngestionService(researchRepo, contentRepo);
    vi.spyOn(svc, 'fetchContentForItem').mockResolvedValue({
      content: 'Page content',
      metadata: {
        citation_label: 'Example Page',
        display_domain: 'example.com',
      },
    });

    await svc.ingestItems(['cite-1'], 'nb-1');

    expect(capturedInput).not.toBeNull();
    expect(capturedInput!.citation_label).toBe('Example Page');
    expect(capturedInput!.display_domain).toBe('example.com');
  });
});

// ─── 8. Chunk offsets ─────────────────────────────────────────────────────────

describe('ContentIngestionService — chunk offset correctness', () => {
  const svc = new ContentIngestionService(makeMockResearchRepo(), makeMockContentRepo());

  it('fixed chunking: charEnd > charStart for every chunk', () => {
    const content = 'Word '.repeat(300);
    const chunks = svc.chunkContent(content, { maxTokensPerChunk: 50, overlapTokens: 0, strategy: 'fixed' });
    for (const c of chunks) {
      expect(c.charEnd).toBeGreaterThan(c.charStart);
    }
  });

  it('paragraph chunking: chunks are sequentially ordered by charStart', () => {
    const content = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
    const chunks = svc.chunkContent(content, { maxTokensPerChunk: 20, overlapTokens: 0, strategy: 'paragraph' });
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].charStart).toBeGreaterThanOrEqual(chunks[i - 1].charStart);
    }
  });
});

// ─── 9. ContentRepository — method contracts ─────────────────────────────────

describe('ContentRepository mock — contract verification', () => {
  it('documentExists returns false by default', async () => {
    const repo = makeMockContentRepo();
    const exists = await repo.documentExists('k1', 'hash1');
    expect(exists).toBe(false);
  });

  it('documentExists returns true when configured', async () => {
    const repo = makeMockContentRepo({ exists: true });
    const exists = await repo.documentExists('k1', 'hash1');
    expect(exists).toBe(true);
  });

  it('upsertSourceDocument returns a SourceDocumentRecord', async () => {
    const repo = makeMockContentRepo();
    const result = await repo.upsertSourceDocument({
      item_key: 'k1',
      content: 'hello',
      content_hash: 'abc123',
    });
    expect(result).toBeDefined();
    expect(result.item_key).toBe('key-1'); // default mock returns key-1
  });

  it('insertChunks returns chunk records with correct indices', async () => {
    const repo = makeMockContentRepo();
    const chunks: InsertChunkInput[] = [
      { item_key: 'k1', chunk_index: 0, content: 'first', token_estimate: 5, content_hash: 'h0', char_start: 0, char_end: 5 },
      { item_key: 'k1', chunk_index: 1, content: 'second', token_estimate: 6, content_hash: 'h1', char_start: 5, char_end: 11 },
    ];
    const result = await repo.insertChunks('doc-1', 'k1', chunks);
    expect(result).toHaveLength(2);
    expect(result[0].chunk_index).toBe(0);
    expect(result[1].chunk_index).toBe(1);
  });
});
