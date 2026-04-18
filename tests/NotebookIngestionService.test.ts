import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotebookIngestionService } from '../electron/services/ingestion/NotebookIngestionService';
import { ContentIngestionService } from '../electron/services/ingestion/ContentIngestionService';
import type { NotebookIngestionJob, NotebookItemRecord } from '../shared/researchTypes';

function makeItem(overrides: Partial<NotebookItemRecord> & { item_key: string }): NotebookItemRecord {
  return {
    id: `item-${overrides.item_key}`,
    notebook_id: 'nb-1',
    item_key: overrides.item_key,
    item_type: 'web',
    source_id: null,
    source_path: null,
    title: 'Test Item',
    uri: null,
    snippet: null,
    content_hash: null,
    added_from_search_run_id: null,
    added_at: new Date().toISOString(),
    metadata_json: {},
    ...overrides,
  };
}

function makeJob(overrides: Partial<NotebookIngestionJob> & { jobId: string; notebookId: string; itemKey: string }): NotebookIngestionJob {
  return {
    jobId: overrides.jobId,
    notebookId: overrides.notebookId,
    itemKey: overrides.itemKey,
    sourceType: overrides.sourceType ?? 'web',
    uri: overrides.uri ?? null,
    sourcePath: overrides.sourcePath ?? null,
    state: overrides.state ?? 'running',
    stage: overrides.stage ?? 'fetch',
    attemptCount: overrides.attemptCount ?? 1,
    maxAttempts: overrides.maxAttempts ?? 3,
    lastError: overrides.lastError ?? null,
    nextRetryAt: overrides.nextRetryAt ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

describe('NotebookIngestionService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('queues ingestion for web-backed notebook item', async () => {
    const research = {
      getNotebookItemForUpgrade: vi.fn(async () => makeItem({ item_key: 'https://example.com', uri: 'https://example.com' })),
      createNotebookIngestionJob: vi.fn(async () => makeJob({ jobId: 'job-1', notebookId: 'nb-1', itemKey: 'https://example.com' })),
      updateNotebookRetrievalStatus: vi.fn(async () => makeItem({ item_key: 'https://example.com', uri: 'https://example.com', metadata_json: { retrievalStatus: 'queued' } })),
    };
    const content = {} as any;
    const service = new NotebookIngestionService(research as any, content as any, null);

    const queued = await service.queueNotebookItemUpgrade('nb-1', 'https://example.com');

    expect(queued).toBe(true);
    expect(research.createNotebookIngestionJob).toHaveBeenCalledTimes(1);
    expect(research.updateNotebookRetrievalStatus).toHaveBeenCalledWith('nb-1', 'https://example.com', expect.objectContaining({ retrievalStatus: 'queued' }));
  });

  it('keeps metadata-only items ungrounded in strict synchronous upgrade', async () => {
    const research = {
      getNotebookItemForUpgrade: vi.fn(async () => makeItem({ item_key: 'legacy', title: 'Title only', uri: null, source_path: null })),
      updateNotebookRetrievalStatus: vi.fn(async () => makeItem({ item_key: 'legacy', metadata_json: { retrievalStatus: 'saved_metadata_only' } })),
    };
    const content = {} as any;
    const service = new NotebookIngestionService(research as any, content as any, null);

    const result = await service.upgradeNotebookItemsNow('nb-1', ['legacy']);

    expect(result.groundedItemKeys).toEqual([]);
    expect(result.unavailable[0]?.retrievalStatus).toBe('saved_metadata_only');
    expect(result.unavailable[0]?.reason).toContain('metadata_only');
  });

  it('schedules retry for transient fetch failures', async () => {
    const job = makeJob({
      jobId: 'job-timeout',
      notebookId: 'nb-1',
      itemKey: 'https://retry.example.com',
      sourceType: 'web',
      uri: 'https://retry.example.com',
      attemptCount: 1,
      maxAttempts: 3,
    });
    const research = {
      getNotebookItemForUpgrade: vi.fn(async () => makeItem({ item_key: job.itemKey, uri: 'https://retry.example.com' })),
      updateNotebookRetrievalStatus: vi.fn(async () => makeItem({ item_key: job.itemKey })),
      updateNotebookIngestionJob: vi.fn(async () => job),
      linkNotebookItemToSourceDocument: vi.fn(),
    };
    const content = {
      upsertSourceDocument: vi.fn(),
      insertChunks: vi.fn(),
    };
    const service = new NotebookIngestionService(research as any, content as any, null);
    vi.spyOn(ContentIngestionService.prototype, 'fetchContentForItem').mockResolvedValue({
      content: null,
      warning: 'Could not fetch URI https://retry.example.com: HTTP request timed out for https://retry.example.com',
      retryable: true,
    });

    await service.processNotebookIngestionJob(job);

    expect(research.updateNotebookIngestionJob).toHaveBeenCalledWith(
      'job-timeout',
      expect.objectContaining({ state: 'retry_scheduled' }),
    );
  });

  it('processes local item to chunked state in background pipeline', async () => {
    const job = makeJob({
      jobId: 'job-local',
      notebookId: 'nb-1',
      itemKey: '/workspace/notes.md',
      sourceType: 'local',
      sourcePath: '/workspace/notes.md',
      attemptCount: 1,
      maxAttempts: 3,
    });
    const research = {
      getNotebookItemForUpgrade: vi.fn(async () => makeItem({
        item_key: '/workspace/notes.md',
        source_path: '/workspace/notes.md',
        uri: null,
        item_type: 'local_file',
      })),
      updateNotebookRetrievalStatus: vi.fn(async () => makeItem({ item_key: '/workspace/notes.md' })),
      updateNotebookIngestionJob: vi.fn(async () => job),
      linkNotebookItemToSourceDocument: vi.fn(async () => makeItem({
        item_key: '/workspace/notes.md',
        metadata_json: { sourceDocumentId: 'doc-1', chunkCount: 1 },
      })),
    };
    const content = {
      upsertSourceDocument: vi.fn(async () => ({ id: 'doc-1' })),
      insertChunks: vi.fn(async () => [{ id: 'chunk-1' }]),
    };
    const service = new NotebookIngestionService(research as any, content as any, null);
    vi.spyOn(ContentIngestionService.prototype, 'fetchContentForItem').mockResolvedValue({
      content: 'Local notebook content to chunk and index.',
      metadata: { mime_type: 'text/markdown' },
      retryable: false,
    });

    await service.processNotebookIngestionJob(job);

    expect(content.upsertSourceDocument).toHaveBeenCalledTimes(1);
    expect(content.insertChunks).toHaveBeenCalledTimes(1);
    expect(research.linkNotebookItemToSourceDocument).toHaveBeenCalledWith(
      'nb-1',
      '/workspace/notes.md',
      'doc-1',
      1,
      expect.any(String),
    );
    expect(research.updateNotebookIngestionJob).toHaveBeenCalledWith(
      'job-local',
      expect.objectContaining({ state: 'succeeded' }),
    );
  });
});

