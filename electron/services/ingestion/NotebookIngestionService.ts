import crypto from 'crypto';
import type { EmbeddingsRepository } from '../db/EmbeddingsRepository';
import type { ContentRepository, InsertChunkInput } from '../db/ContentRepository';
import type { ResearchRepository } from '../db/ResearchRepository';
import { ChunkEmbeddingService } from '../embedding/ChunkEmbeddingService';
import { telemetry } from '../TelemetryService';
import { ContentIngestionService } from './ContentIngestionService';
import {
  normalizeNotebookSourceRecord,
  type NotebookIngestionJob,
  type NotebookRetrievalStatus,
} from '../../../shared/researchTypes';
import type { ChunkingOptions } from '../../../shared/ingestion/ingestionTypes';

const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
  maxTokensPerChunk: 512,
  overlapTokens: 64,
  strategy: 'hybrid',
};

const BASE_RETRY_DELAY_MS = 10_000;

export interface StrictNotebookUpgradeResultItem {
  itemKey: string;
  retrievalStatus: NotebookRetrievalStatus;
  grounded: boolean;
  reason: string | null;
}

export interface StrictNotebookUpgradeResult {
  groundedItemKeys: string[];
  unavailable: StrictNotebookUpgradeResultItem[];
  items: StrictNotebookUpgradeResultItem[];
}

type UpgradeOutcome = {
  retrievalStatus: NotebookRetrievalStatus;
  retrievalError: string | null;
  contentHash: string | null;
  sourceDocumentId: string | null;
  chunkCount: number | null;
  retryable: boolean;
};

export class NotebookIngestionService {
  private timer: NodeJS.Timeout | null = null;
  private pumpInFlight = false;
  private readonly ingestion: ContentIngestionService;
  private readonly embeddingService: ChunkEmbeddingService | null;

  constructor(
    private readonly research: ResearchRepository,
    private readonly content: ContentRepository,
    embeddingsRepo?: EmbeddingsRepository | null,
  ) {
    this.ingestion = new ContentIngestionService(this.research, this.content);
    this.embeddingService = embeddingsRepo ? new ChunkEmbeddingService(embeddingsRepo) : null;
  }

  start(intervalMs = 2_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pumpOnce();
    }, intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async queueNotebookItemUpgrade(notebookId: string, itemKey: string): Promise<boolean> {
    const item = await this.research.getNotebookItemForUpgrade(notebookId, itemKey);
    if (!item) return false;
    const source = normalizeNotebookSourceRecord(item);
    if (!this.isUpgradeableSource(source)) {
      await this.research.updateNotebookRetrievalStatus(notebookId, itemKey, {
        retrievalStatus: 'saved_metadata_only',
        retrievalError: 'metadata_only: source lacks contentText, uri, and sourcePath',
      });
      return false;
    }
    await this.research.createNotebookIngestionJob({
      notebookId,
      itemKey,
      sourceType: source.sourceType,
      uri: source.uri,
      sourcePath: source.sourcePath,
      stage: 'fetch',
      maxAttempts: 3,
    });
    await this.research.updateNotebookRetrievalStatus(notebookId, itemKey, {
      retrievalStatus: 'queued',
      retrievalError: null,
    });
    this.emitNotebookIngestionTelemetry('notebook.ingestion_queued', {
      notebookId,
      itemKey,
      sourceType: source.sourceType,
      uri: source.uri,
      sourcePath: source.sourcePath,
      stage: 'fetch',
      attemptCount: 0,
    }, 'success');
    return true;
  }

  async pumpOnce(): Promise<void> {
    if (this.pumpInFlight) return;
    this.pumpInFlight = true;
    try {
      const job = await this.research.claimNextNotebookIngestionJob();
      if (!job) return;
      await this.processNotebookIngestionJob(job);
    } finally {
      this.pumpInFlight = false;
    }
  }

  async processNotebookIngestionJob(job: NotebookIngestionJob): Promise<void> {
    this.emitNotebookIngestionTelemetry('notebook.ingestion_started', {
      notebookId: job.notebookId,
      itemKey: job.itemKey,
      sourceType: job.sourceType,
      uri: job.uri,
      sourcePath: job.sourcePath,
      stage: job.stage,
      attemptCount: job.attemptCount,
    }, 'success');

    const startMs = Date.now();
    const outcome = await this.upgradeNotebookItemInternal(job.notebookId, job.itemKey);

    if (outcome.retrievalStatus === 'ready' || outcome.retrievalStatus === 'chunked') {
      await this.research.updateNotebookIngestionJob(job.jobId, {
        state: 'succeeded',
        stage: 'finalize',
        lastError: null,
        nextRetryAt: null,
      });
      this.emitNotebookIngestionTelemetry('notebook.ingestion_ready', {
        notebookId: job.notebookId,
        itemKey: job.itemKey,
        sourceType: job.sourceType,
        sourceDocumentId: outcome.sourceDocumentId,
        contentHash: outcome.contentHash,
        chunkCount: outcome.chunkCount,
        attemptCount: job.attemptCount,
        stage: 'finalize',
        durationMs: Date.now() - startMs,
      }, 'success');
      return;
    }

    const canRetry = outcome.retryable && job.attemptCount < job.maxAttempts;
    if (canRetry) {
      const nextRetryAtIso = new Date(Date.now() + BASE_RETRY_DELAY_MS * Math.max(1, job.attemptCount)).toISOString();
      await this.research.updateNotebookIngestionJob(job.jobId, {
        state: 'retry_scheduled',
        lastError: outcome.retrievalError,
        nextRetryAt: nextRetryAtIso,
      });
      this.emitNotebookIngestionTelemetry('notebook.ingestion_retry_scheduled', {
        notebookId: job.notebookId,
        itemKey: job.itemKey,
        sourceType: job.sourceType,
        attemptCount: job.attemptCount,
        stage: 'fetch',
        error: outcome.retrievalError,
        durationMs: Date.now() - startMs,
      }, 'partial');
      return;
    }

    await this.research.updateNotebookIngestionJob(job.jobId, {
      state: 'failed',
      lastError: outcome.retrievalError,
      nextRetryAt: null,
    });
    this.emitNotebookIngestionTelemetry('notebook.ingestion_failed', {
      notebookId: job.notebookId,
      itemKey: job.itemKey,
      sourceType: job.sourceType,
      attemptCount: job.attemptCount,
      stage: 'finalize',
      error: outcome.retrievalError,
      durationMs: Date.now() - startMs,
    }, 'failure');
  }

  async upgradeNotebookItemsNow(notebookId: string, itemKeys: string[]): Promise<StrictNotebookUpgradeResult> {
    const items: StrictNotebookUpgradeResultItem[] = [];
    for (const itemKey of itemKeys) {
      const item = await this.research.getNotebookItemForUpgrade(notebookId, itemKey);
      if (!item) {
        items.push({
          itemKey,
          grounded: false,
          retrievalStatus: 'failed',
          reason: `notebook_item_not_found:${itemKey}`,
        });
        continue;
      }
      const source = normalizeNotebookSourceRecord(item);
      if (source.retrievalStatus === 'ready' || source.retrievalStatus === 'chunked') {
        items.push({
          itemKey,
          grounded: true,
          retrievalStatus: source.retrievalStatus,
          reason: null,
        });
        continue;
      }
      if (!this.isUpgradeableSource(source)) {
        await this.research.updateNotebookRetrievalStatus(notebookId, itemKey, {
          retrievalStatus: 'saved_metadata_only',
          retrievalError: 'metadata_only: no canonical source reference or content to ingest',
        });
        items.push({
          itemKey,
          grounded: false,
          retrievalStatus: 'saved_metadata_only',
          reason: 'metadata_only: no canonical source reference or content to ingest',
        });
        continue;
      }
      const outcome = await this.upgradeNotebookItemInternal(notebookId, itemKey);
      items.push({
        itemKey,
        grounded: outcome.retrievalStatus === 'ready' || outcome.retrievalStatus === 'chunked',
        retrievalStatus: outcome.retrievalStatus,
        reason: outcome.retrievalError,
      });
    }
    return {
      groundedItemKeys: items.filter((i) => i.grounded).map((i) => i.itemKey),
      unavailable: items.filter((i) => !i.grounded),
      items,
    };
  }

  private async upgradeNotebookItemInternal(notebookId: string, itemKey: string): Promise<UpgradeOutcome> {
    const item = await this.research.getNotebookItemForUpgrade(notebookId, itemKey);
    if (!item) {
      return {
        retrievalStatus: 'failed',
        retrievalError: `notebook_item_not_found:${itemKey}`,
        contentHash: null,
        sourceDocumentId: null,
        chunkCount: null,
        retryable: false,
      };
    }
    const source = normalizeNotebookSourceRecord(item);
    if (!this.isUpgradeableSource(source)) {
      await this.research.updateNotebookRetrievalStatus(notebookId, itemKey, {
        retrievalStatus: 'saved_metadata_only',
        retrievalError: 'metadata_only: no canonical source reference or content to ingest',
      });
      return {
        retrievalStatus: 'saved_metadata_only',
        retrievalError: 'metadata_only: no canonical source reference or content to ingest',
        contentHash: null,
        sourceDocumentId: null,
        chunkCount: null,
        retryable: false,
      };
    }

    await this.research.updateNotebookRetrievalStatus(notebookId, itemKey, {
      retrievalStatus: 'fetching',
      retrievalError: null,
    });
    const fetchStarted = Date.now();
    const fetched = await this.ingestion.fetchContentForItem(item);
    if (!fetched.content) {
      const failure = fetched.warning ?? 'ingestion_fetch_failed';
      await this.research.updateNotebookRetrievalStatus(notebookId, itemKey, {
        retrievalStatus: 'failed',
        retrievalError: failure,
      });
      return {
        retrievalStatus: 'failed',
        retrievalError: failure,
        contentHash: null,
        sourceDocumentId: null,
        chunkCount: null,
        retryable: Boolean(fetched.retryable),
      };
    }
    this.emitNotebookIngestionTelemetry('notebook.ingestion_fetch_completed', {
      notebookId,
      itemKey,
      sourceType: source.sourceType,
      stage: 'fetch',
      durationMs: Date.now() - fetchStarted,
    }, 'success');

    await this.research.updateNotebookRetrievalStatus(notebookId, itemKey, {
      retrievalStatus: 'content_fetched',
      retrievalError: null,
      mimeType: fetched.metadata?.mime_type ?? source.mimeType,
      contentText: source.sourceType === 'generated' || source.sourceType === 'internal'
        ? fetched.content
        : undefined,
    });
    this.emitNotebookIngestionTelemetry('notebook.ingestion_extract_completed', {
      notebookId,
      itemKey,
      sourceType: source.sourceType,
      stage: 'extract',
    }, 'success');

    const contentHash = this.sha256(fetched.content);
    await this.research.updateNotebookRetrievalStatus(notebookId, itemKey, {
      retrievalStatus: 'chunking',
      retrievalError: null,
      contentHash,
    });

    const upsertStart = Date.now();
    const doc = await this.content.upsertSourceDocument({
      item_key: item.item_key,
      notebook_id: notebookId,
      title: source.title,
      uri: source.uri,
      source_path: source.sourcePath,
      provider_id: source.providerId,
      source_type: source.sourceType,
      content: fetched.content,
      content_hash: contentHash,
      mime_type: fetched.metadata?.mime_type ?? source.mimeType ?? null,
      citation_label: source.title,
      fetched_at: new Date().toISOString(),
      display_domain: fetched.metadata?.display_domain ?? null,
    });
    this.emitNotebookIngestionTelemetry('notebook.ingestion_document_upserted', {
      notebookId,
      itemKey,
      sourceType: source.sourceType,
      sourceDocumentId: doc.id,
      contentHash,
      stage: 'document_upsert',
      durationMs: Date.now() - upsertStart,
    }, 'success');

    const chunksStart = Date.now();
    const chunks = this.ingestion.chunkContent(fetched.content, DEFAULT_CHUNKING_OPTIONS);
    const chunkInputs: InsertChunkInput[] = chunks.map((chunk, index) => ({
      item_key: item.item_key,
      chunk_index: index,
      content: chunk.content,
      token_estimate: chunk.tokenEstimate,
      content_hash: this.sha256(chunk.content),
      char_start: chunk.charStart,
      char_end: chunk.charEnd,
      section_label: chunk.sectionLabel ?? null,
    }));
    const insertedChunks = await this.content.insertChunks(doc.id, item.item_key, chunkInputs);
    await this.research.linkNotebookItemToSourceDocument(
      notebookId,
      itemKey,
      doc.id,
      insertedChunks.length,
      contentHash,
    );
    await this.research.updateNotebookRetrievalStatus(notebookId, itemKey, {
      retrievalStatus: 'chunked',
      retrievalError: null,
      sourceDocumentId: doc.id,
      chunkCount: insertedChunks.length,
      contentHash,
    });
    this.emitNotebookIngestionTelemetry('notebook.ingestion_chunk_completed', {
      notebookId,
      itemKey,
      sourceType: source.sourceType,
      sourceDocumentId: doc.id,
      contentHash,
      chunkCount: insertedChunks.length,
      stage: 'chunk',
      durationMs: Date.now() - chunksStart,
    }, 'success');

    if (!this.embeddingService || insertedChunks.length === 0) {
      await this.research.updateNotebookRetrievalStatus(notebookId, itemKey, {
        retrievalStatus: 'chunked',
        retrievalError: !this.embeddingService ? 'embedding_unavailable' : 'chunking_produced_no_chunks',
        sourceDocumentId: doc.id,
        chunkCount: insertedChunks.length,
        contentHash,
      });
      return {
        retrievalStatus: 'chunked',
        retrievalError: !this.embeddingService ? 'embedding_unavailable' : 'chunking_produced_no_chunks',
        contentHash,
        sourceDocumentId: doc.id,
        chunkCount: insertedChunks.length,
        retryable: false,
      };
    }

    await this.research.updateNotebookRetrievalStatus(notebookId, itemKey, {
      retrievalStatus: 'embedding',
      retrievalError: null,
    });
    const embedStart = Date.now();
    const embedResult = await this.embeddingService.embedChunks(insertedChunks.map((chunk) => chunk.id));
    const embeddingUnavailable = embedResult.chunksEmbedded === 0 && embedResult.warnings.length > 0;
    const finalStatus: NotebookRetrievalStatus = embeddingUnavailable ? 'chunked' : 'ready';
    const finalError = embeddingUnavailable ? embedResult.warnings[0] : null;
    await this.research.updateNotebookRetrievalStatus(notebookId, itemKey, {
      retrievalStatus: finalStatus,
      retrievalError: finalError,
      sourceDocumentId: doc.id,
      chunkCount: insertedChunks.length,
      contentHash,
    });
    this.emitNotebookIngestionTelemetry('notebook.ingestion_embedding_completed', {
      notebookId,
      itemKey,
      sourceType: source.sourceType,
      sourceDocumentId: doc.id,
      contentHash,
      chunkCount: insertedChunks.length,
      stage: 'embed',
      durationMs: Date.now() - embedStart,
      error: finalError,
    }, embeddingUnavailable ? 'partial' : 'success');

    return {
      retrievalStatus: finalStatus,
      retrievalError: finalError,
      contentHash,
      sourceDocumentId: doc.id,
      chunkCount: insertedChunks.length,
      retryable: false,
    };
  }

  private isUpgradeableSource(source: ReturnType<typeof normalizeNotebookSourceRecord>): boolean {
    if (source.contentText && source.contentText.trim().length > 0) return true;
    if (source.sourceType === 'local' && source.sourcePath) return true;
    if (source.sourceType === 'web' && source.uri) return true;
    return false;
  }

  private emitNotebookIngestionTelemetry(
    eventType:
      | 'notebook.ingestion_queued'
      | 'notebook.ingestion_started'
      | 'notebook.ingestion_fetch_completed'
      | 'notebook.ingestion_extract_completed'
      | 'notebook.ingestion_document_upserted'
      | 'notebook.ingestion_chunk_completed'
      | 'notebook.ingestion_embedding_completed'
      | 'notebook.ingestion_ready'
      | 'notebook.ingestion_failed'
      | 'notebook.ingestion_retry_scheduled',
    payload: Record<string, unknown>,
    status: 'success' | 'failure' | 'partial',
  ): void {
    telemetry.emit(
      'retrieval',
      eventType,
      status === 'failure' ? 'warn' : 'info',
      'NotebookIngestionService',
      eventType,
      status,
      { payload },
    );
  }

  private sha256(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
  }

}
