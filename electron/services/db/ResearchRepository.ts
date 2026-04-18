/**
 * ResearchRepository
 *
 * Repository layer for research collections: notebooks, search runs,
 * search run results, and notebook items. Uses a shared pg Pool.
 * No ORM. All queries use parameterized SQL.
 */

import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { toIsoString } from './dbUtils';
import type {
  NotebookRecord,
  CreateNotebookInput,
  UpdateNotebookInput,
  SearchRunRecord,
  CreateSearchRunInput,
  SearchRunResultRecord,
  CreateSearchRunResultInput,
  NotebookItemRecord,
  AddNotebookItemInput,
  NotebookSourceType,
  NotebookRetrievalStatus,
  NotebookOpenTargetType,
  NotebookIngestionJob,
  NotebookIngestionJobState,
  NotebookIngestionJobStage,
} from '../../../shared/researchTypes';
import {
  normalizeNotebookItemForStorage,
  normalizeNotebookSourceRecord,
  resolveNotebookOpenTarget,
} from '../../../shared/researchTypes';

export class ResearchRepository {
  constructor(private pool: Pool) {}

  private static readonly DEFAULT_MAX_INGESTION_ATTEMPTS = 3;

  // ─── Notebooks ─────────────────────────────────────────────────────────────

  async createNotebook(input: CreateNotebookInput): Promise<NotebookRecord> {
    const id = uuidv4();
    const result = await this.pool.query<NotebookRecord>(
      `INSERT INTO notebooks
         (id, name, description, is_dynamic, query_template, source_scope_json, tags_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       RETURNING *`,
      [
        id,
        input.name,
        input.description ?? null,
        input.is_dynamic ?? false,
        input.query_template ?? null,
        input.source_scope_json != null ? JSON.stringify(input.source_scope_json) : null,
        input.tags_json != null ? JSON.stringify(input.tags_json) : null,
      ]
    );
    return this.mapNotebook(result.rows[0]);
  }

  async listNotebooks(): Promise<NotebookRecord[]> {
    const result = await this.pool.query<NotebookRecord>(
      `SELECT * FROM notebooks ORDER BY created_at DESC`
    );
    return result.rows.map((r: any) => this.mapNotebook(r));
  }

  async getNotebook(id: string): Promise<NotebookRecord | null> {
    const result = await this.pool.query<NotebookRecord>(
      `SELECT * FROM notebooks WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapNotebook(result.rows[0]) : null;
  }

  async updateNotebook(id: string, input: UpdateNotebookInput): Promise<NotebookRecord | null> {
    const sets: string[] = ['updated_at = now()'];
    const values: unknown[] = [];
    let idx = 1;

    if (input.name !== undefined) {
      sets.push(`name = $${idx++}`);
      values.push(input.name);
    }
    if (input.description !== undefined) {
      sets.push(`description = $${idx++}`);
      values.push(input.description);
    }
    if (input.is_dynamic !== undefined) {
      sets.push(`is_dynamic = $${idx++}`);
      values.push(input.is_dynamic);
    }
    if (input.query_template !== undefined) {
      sets.push(`query_template = $${idx++}`);
      values.push(input.query_template);
    }
    if (input.source_scope_json !== undefined) {
      sets.push(`source_scope_json = $${idx++}::jsonb`);
      values.push(input.source_scope_json != null ? JSON.stringify(input.source_scope_json) : null);
    }
    if (input.tags_json !== undefined) {
      sets.push(`tags_json = $${idx++}::jsonb`);
      values.push(input.tags_json != null ? JSON.stringify(input.tags_json) : null);
    }

    values.push(id);
    const result = await this.pool.query<NotebookRecord>(
      `UPDATE notebooks SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return result.rows[0] ? this.mapNotebook(result.rows[0]) : null;
  }

  async deleteNotebook(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM notebooks WHERE id = $1`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ─── Notebook Items ────────────────────────────────────────────────────────

  async addItemsToNotebook(
    notebookId: string,
    items: AddNotebookItemInput[],
    addedFromSearchRunId?: string
  ): Promise<NotebookItemRecord[]> {
    const inserted: NotebookItemRecord[] = [];
    for (const item of items) {
      const id = uuidv4();
      const normalized = normalizeNotebookItemForStorage(item);
      const runId = normalized.added_from_search_run_id ?? addedFromSearchRunId ?? null;
      const source = normalizeNotebookSourceRecord(item);
      const shouldQueueUpgrade = this.isNotebookItemUpgradeable(source);
      const initialRetrievalStatus: NotebookRetrievalStatus = this.resolveInitialRetrievalStatus(source);
      const metadataJson = {
        ...(normalized.metadata_json ?? {}),
        retrievalStatus: initialRetrievalStatus,
        retrievalError: null,
      };
      const result = await this.pool.query<NotebookItemRecord>(
        `INSERT INTO notebook_items
           (id, notebook_id, item_key, item_type, source_id, source_path,
            title, uri, snippet, content_hash, added_from_search_run_id, metadata_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
         ON CONFLICT (notebook_id, item_key) DO UPDATE
           SET item_type   = EXCLUDED.item_type,
               source_id   = EXCLUDED.source_id,
               title      = EXCLUDED.title,
               snippet    = EXCLUDED.snippet,
               uri        = EXCLUDED.uri,
               source_path= EXCLUDED.source_path,
               content_hash = EXCLUDED.content_hash,
               metadata_json = EXCLUDED.metadata_json
         RETURNING *`,
        [
          id,
          notebookId,
          normalized.item_key,
          normalized.item_type ?? 'web',
          normalized.source_id ?? null,
          normalized.source_path ?? null,
          normalized.title ?? null,
          normalized.uri ?? null,
          normalized.snippet ?? null,
          normalized.content_hash ?? null,
          runId,
          JSON.stringify(metadataJson),
        ]
      );
      if (result.rows[0]) {
        const mapped = this.mapNotebookItem(result.rows[0]);
        inserted.push(mapped);
        if (shouldQueueUpgrade) {
          await this.createNotebookIngestionJob({
            notebookId,
            itemKey: mapped.item_key,
            sourceType: source.sourceType,
            uri: source.uri,
            sourcePath: source.sourcePath,
            stage: 'fetch',
            maxAttempts: ResearchRepository.DEFAULT_MAX_INGESTION_ATTEMPTS,
          });
          await this.updateNotebookRetrievalStatus(notebookId, mapped.item_key, {
            retrievalStatus: 'queued',
            retrievalError: null,
          });
        }
      }
    }
    return inserted;
  }

  async getNotebookItemForUpgrade(notebookId: string, itemKey: string): Promise<NotebookItemRecord | null> {
    const result = await this.pool.query<NotebookItemRecord>(
      `SELECT * FROM notebook_items WHERE notebook_id = $1 AND item_key = $2 LIMIT 1`,
      [notebookId, itemKey],
    );
    return result.rows[0] ? this.mapNotebookItem(result.rows[0]) : null;
  }

  async updateNotebookRetrievalStatus(
    notebookId: string,
    itemKey: string,
    patch: {
      retrievalStatus?: NotebookRetrievalStatus;
      retrievalError?: string | null;
      contentHash?: string | null;
      contentText?: string | null;
      mimeType?: string | null;
      sourceDocumentId?: string | null;
      chunkCount?: number | null;
    },
  ): Promise<NotebookItemRecord | null> {
    const metadataPatch: Record<string, unknown> = {};
    if (patch.retrievalStatus !== undefined) metadataPatch.retrievalStatus = patch.retrievalStatus;
    if (patch.retrievalError !== undefined) metadataPatch.retrievalError = patch.retrievalError;
    if (patch.contentText !== undefined) metadataPatch.contentText = patch.contentText;
    if (patch.mimeType !== undefined) metadataPatch.mimeType = patch.mimeType;
    if (patch.sourceDocumentId !== undefined) metadataPatch.sourceDocumentId = patch.sourceDocumentId;
    if (patch.chunkCount !== undefined) metadataPatch.chunkCount = patch.chunkCount;
    if (patch.contentHash !== undefined) metadataPatch.contentHash = patch.contentHash;

    const result = await this.pool.query<NotebookItemRecord>(
      `UPDATE notebook_items
          SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb,
              content_hash = COALESCE($4, content_hash)
        WHERE notebook_id = $1 AND item_key = $2
      RETURNING *`,
      [
        notebookId,
        itemKey,
        JSON.stringify(metadataPatch),
        patch.contentHash ?? null,
      ],
    );
    return result.rows[0] ? this.mapNotebookItem(result.rows[0]) : null;
  }

  async linkNotebookItemToSourceDocument(
    notebookId: string,
    itemKey: string,
    sourceDocumentId: string,
    chunkCount: number,
    contentHash: string,
  ): Promise<NotebookItemRecord | null> {
    return this.updateNotebookRetrievalStatus(notebookId, itemKey, {
      sourceDocumentId,
      chunkCount,
      contentHash,
    });
  }

  async createNotebookIngestionJob(input: {
    notebookId: string;
    itemKey: string;
    sourceType: NotebookSourceType;
    uri: string | null;
    sourcePath: string | null;
    state?: NotebookIngestionJobState;
    stage?: NotebookIngestionJobStage;
    maxAttempts?: number;
  }): Promise<NotebookIngestionJob | null> {
    const state = input.state ?? 'queued';
    const stage = input.stage ?? 'fetch';
    const maxAttempts = input.maxAttempts ?? ResearchRepository.DEFAULT_MAX_INGESTION_ATTEMPTS;
    const result = await this.pool.query(
      `INSERT INTO notebook_ingestion_jobs
         (job_id, notebook_id, item_key, source_type, uri, source_path, state, stage, attempt_count, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)
       ON CONFLICT (notebook_id, item_key) WHERE state IN ('queued', 'running', 'retry_scheduled')
       DO UPDATE SET
         source_type = EXCLUDED.source_type,
         uri = EXCLUDED.uri,
         source_path = EXCLUDED.source_path,
         state = 'queued',
         stage = 'fetch',
         last_error = NULL,
         next_retry_at = NULL,
         updated_at = now()
       RETURNING *`,
      [
        uuidv4(),
        input.notebookId,
        input.itemKey,
        input.sourceType,
        input.uri,
        input.sourcePath,
        state,
        stage,
        maxAttempts,
      ],
    );
    return result.rows[0] ? this.mapNotebookIngestionJob(result.rows[0]) : null;
  }

  async claimNextNotebookIngestionJob(): Promise<NotebookIngestionJob | null> {
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT job_id
           FROM notebook_ingestion_jobs
          WHERE state = 'queued'
             OR (state = 'retry_scheduled' AND (next_retry_at IS NULL OR next_retry_at <= now()))
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE notebook_ingestion_jobs j
          SET state = 'running',
              attempt_count = j.attempt_count + 1,
              updated_at = now()
         FROM candidate c
        WHERE j.job_id = c.job_id
       RETURNING j.*`,
    );
    return result.rows[0] ? this.mapNotebookIngestionJob(result.rows[0]) : null;
  }

  async updateNotebookIngestionJob(
    jobId: string,
    patch: {
      state?: NotebookIngestionJobState;
      stage?: NotebookIngestionJobStage;
      lastError?: string | null;
      nextRetryAt?: string | null;
    },
  ): Promise<NotebookIngestionJob | null> {
    const sets: string[] = ['updated_at = now()'];
    const values: unknown[] = [];
    let idx = 1;
    if (patch.state !== undefined) {
      sets.push(`state = $${idx++}`);
      values.push(patch.state);
    }
    if (patch.stage !== undefined) {
      sets.push(`stage = $${idx++}`);
      values.push(patch.stage);
    }
    if (patch.lastError !== undefined) {
      sets.push(`last_error = $${idx++}`);
      values.push(patch.lastError);
    }
    if (patch.nextRetryAt !== undefined) {
      sets.push(`next_retry_at = $${idx++}`);
      values.push(patch.nextRetryAt);
    }
    values.push(jobId);
    const result = await this.pool.query(
      `UPDATE notebook_ingestion_jobs
          SET ${sets.join(', ')}
        WHERE job_id = $${idx}
      RETURNING *`,
      values,
    );
    return result.rows[0] ? this.mapNotebookIngestionJob(result.rows[0]) : null;
  }

  async listPendingNotebookIngestionJobs(limit = 50): Promise<NotebookIngestionJob[]> {
    const result = await this.pool.query(
      `SELECT *
         FROM notebook_ingestion_jobs
        WHERE state IN ('queued', 'running', 'retry_scheduled')
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row: any) => this.mapNotebookIngestionJob(row));
  }

  async removeNotebookItem(notebookId: string, itemKey: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM notebook_items WHERE notebook_id = $1 AND item_key = $2`,
      [notebookId, itemKey]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Remove multiple items from a notebook in a single query.
   * Returns the number of rows actually deleted.
   * Empty or whitespace-only keys are filtered out before the query.
   */
  async removeNotebookItems(notebookId: string, itemKeys: string[]): Promise<number> {
    const validKeys = itemKeys.filter(k => k && k.trim().length > 0);
    if (validKeys.length === 0) return 0;
    const result = await this.pool.query(
      `DELETE FROM notebook_items WHERE notebook_id = $1 AND item_key = ANY($2)`,
      [notebookId, validKeys]
    );
    return result.rowCount ?? 0;
  }

  async listNotebookItems(notebookId: string): Promise<NotebookItemRecord[]> {
    const result = await this.pool.query<NotebookItemRecord>(
      `SELECT * FROM notebook_items WHERE notebook_id = $1 ORDER BY added_at DESC`,
      [notebookId]
    );
    return result.rows.map((r: any) => this.mapNotebookItem(r));
  }

  // ─── Search Runs ───────────────────────────────────────────────────────────

  async createSearchRun(input: CreateSearchRunInput): Promise<SearchRunRecord> {
    const id = uuidv4();
    const result = await this.pool.query<SearchRunRecord>(
      `INSERT INTO search_runs
         (id, query_text, normalized_query, filters_json, source_scope_json, executed_by, notebook_id)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       RETURNING *`,
      [
        id,
        input.query_text,
        input.normalized_query ?? input.query_text.trim().toLowerCase(),
        input.filters_json != null ? JSON.stringify(input.filters_json) : null,
        input.source_scope_json != null ? JSON.stringify(input.source_scope_json) : null,
        input.executed_by ?? null,
        input.notebook_id ?? null,
      ]
    );
    return this.mapSearchRun(result.rows[0]);
  }

  async getSearchRun(id: string): Promise<SearchRunRecord | null> {
    const result = await this.pool.query<SearchRunRecord>(
      `SELECT * FROM search_runs WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapSearchRun(result.rows[0]) : null;
  }

  async listSearchRuns(notebookId?: string, limit = 50): Promise<SearchRunRecord[]> {
    if (notebookId) {
      const result = await this.pool.query<SearchRunRecord>(
        `SELECT * FROM search_runs WHERE notebook_id = $1 ORDER BY executed_at DESC LIMIT $2`,
        [notebookId, limit]
      );
      return result.rows.map((r: any) => this.mapSearchRun(r));
    }
    const result = await this.pool.query<SearchRunRecord>(
      `SELECT * FROM search_runs ORDER BY executed_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map((r: any) => this.mapSearchRun(r));
  }

  async addSearchRunResults(
    searchRunId: string,
    results: CreateSearchRunResultInput[]
  ): Promise<SearchRunResultRecord[]> {
    const inserted: SearchRunResultRecord[] = [];
    for (const res of results) {
      const id = uuidv4();
      const normalized = normalizeNotebookItemForStorage(res);
      const row = await this.pool.query<SearchRunResultRecord>(
        `INSERT INTO search_run_results
           (id, search_run_id, item_key, item_type, source_id, source_path,
            title, uri, snippet, score, metadata_json, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
         RETURNING *`,
        [
          id,
          searchRunId,
          normalized.item_key,
          normalized.item_type ?? 'web',
          normalized.source_id ?? null,
          normalized.source_path ?? null,
          normalized.title ?? null,
          normalized.uri ?? null,
          normalized.snippet ?? null,
          res.score ?? null,
          JSON.stringify(normalized.metadata_json ?? {}),
          normalized.content_hash ?? null,
        ]
      );
      if (row.rows[0]) inserted.push(this.mapSearchRunResult(row.rows[0]));
    }
    return inserted;
  }

  async getSearchRunResults(searchRunId: string): Promise<SearchRunResultRecord[]> {
    const result = await this.pool.query<SearchRunResultRecord>(
      `SELECT * FROM search_run_results WHERE search_run_id = $1 ORDER BY captured_at ASC`,
      [searchRunId]
    );
    return result.rows.map((r: any) => this.mapSearchRunResult(r));
  }

  // ─── Compound Operations ────────────────────────────────────────────────────

  /** Create a new notebook and attach all results from the given search run. */
  async createNotebookFromSearchRun(
    searchRunId: string,
    notebookName: string,
    description?: string,
    selectedItemKeys?: string[]
  ): Promise<{ notebook: NotebookRecord; itemCount: number }> {
    const notebook = await this.createNotebook({ name: notebookName, description });
    let results = await this.getSearchRunResults(searchRunId);
    if (selectedItemKeys && selectedItemKeys.length > 0) {
      const keys = new Set(selectedItemKeys);
      results = results.filter(r => keys.has(r.item_key));
    }
    const items: AddNotebookItemInput[] = results.map(r => ({
      item_key: r.item_key,
      item_type: r.item_type,
      source_id: r.source_id ?? undefined,
      source_path: r.source_path ?? undefined,
      title: r.title ?? undefined,
      uri: r.uri ?? undefined,
      snippet: r.snippet ?? undefined,
      content_hash: r.content_hash ?? undefined,
      added_from_search_run_id: searchRunId,
      metadata_json: r.metadata_json,
    }));
    await this.addItemsToNotebook(notebook.id, items);
    return { notebook, itemCount: items.length };
  }

  /** Copy all results from a search run into an existing notebook. */
  async addSearchRunResultsToNotebook(
    searchRunId: string,
    notebookId: string,
    selectedItemKeys?: string[]
  ): Promise<{ itemCount: number }> {
    let results = await this.getSearchRunResults(searchRunId);
    if (selectedItemKeys && selectedItemKeys.length > 0) {
      const keys = new Set(selectedItemKeys);
      results = results.filter(r => keys.has(r.item_key));
    }
    const items: AddNotebookItemInput[] = results.map(r => ({
      item_key: r.item_key,
      item_type: r.item_type,
      source_id: r.source_id ?? undefined,
      source_path: r.source_path ?? undefined,
      title: r.title ?? undefined,
      uri: r.uri ?? undefined,
      snippet: r.snippet ?? undefined,
      content_hash: r.content_hash ?? undefined,
      added_from_search_run_id: searchRunId,
      metadata_json: r.metadata_json,
    }));
    await this.addItemsToNotebook(notebookId, items);
    return { itemCount: items.length };
  }

  // ─── Retrieval Scoping (RAG foundation) ─────────────────────────────────────

  /**
   * Resolve the set of URIs and source paths belonging to a notebook.
   * Used as a retrieval scope boundary for future pgvector-based search.
   */
  async resolveNotebookScope(notebookId: string): Promise<{
    uris: string[];
    sourcePaths: string[];
    itemKeys: string[];
  }> {
    const items = await this.listNotebookItems(notebookId);
    return {
      uris: items
        .map(i => normalizeNotebookSourceRecord(i).uri)
        .filter((u): u is string => u != null),
      sourcePaths: items
        .map(i => normalizeNotebookSourceRecord(i).sourcePath)
        .filter((p): p is string => p != null),
      itemKeys: items.map(i => i.item_key),
    };
  }

  async resolveNotebookOpenTarget(
    notebookId: string,
    itemKey: string,
  ): Promise<{
    openTarget: string | null;
    openTargetType: NotebookOpenTargetType;
    sourceUnavailableReason: string | null;
    sourceType: NotebookSourceType;
  }> {
    const items = await this.listNotebookItems(notebookId);
    const item = items.find((candidate) => candidate.item_key === itemKey);
    if (!item) {
      return {
        openTarget: null,
        openTargetType: 'none',
        sourceUnavailableReason: `notebook_item_not_found:${itemKey}`,
        sourceType: 'generated',
      };
    }
    const open = resolveNotebookOpenTarget(item);
    const normalized = normalizeNotebookSourceRecord(item);
    return {
      openTarget: open.openTarget,
      openTargetType: open.openTargetType,
      sourceUnavailableReason: open.sourceUnavailableReason,
      sourceType: normalized.sourceType,
    };
  }

  // ─── Row Mappers ─────────────────────────────────────────────────────────────

  private mapNotebook(row: NotebookRecord): NotebookRecord {
    return {
      ...row,
      created_at: toIsoString(row.created_at),
      updated_at: toIsoString(row.updated_at),
    };
  }

  private mapSearchRun(row: SearchRunRecord): SearchRunRecord {
    return {
      ...row,
      executed_at: toIsoString(row.executed_at),
    };
  }

  private mapSearchRunResult(row: SearchRunResultRecord): SearchRunResultRecord {
    const normalized = normalizeNotebookSourceRecord(row);
    return {
      ...row,
      score: row.score != null ? Number(row.score) : null,
      captured_at: toIsoString(row.captured_at),
      sourceType: normalized.sourceType,
      providerId: normalized.providerId,
      summary: normalized.summary,
      contentText: normalized.contentText,
      mimeType: normalized.mimeType,
      retrievalStatus: normalized.retrievalStatus as NotebookRetrievalStatus,
      openTarget: normalized.openTarget,
      openTargetType: normalized.openTargetType,
      createdFromSearch: normalized.createdFromSearch,
    };
  }

  private mapNotebookItem(row: NotebookItemRecord): NotebookItemRecord {
    const normalized = normalizeNotebookSourceRecord(row);
    return {
      ...row,
      added_at: toIsoString(row.added_at),
      sourceType: normalized.sourceType,
      providerId: normalized.providerId,
      summary: normalized.summary,
      contentText: normalized.contentText,
      mimeType: normalized.mimeType,
      retrievalStatus: normalized.retrievalStatus as NotebookRetrievalStatus,
      retrievalError: normalized.retrievalError,
      sourceDocumentId: normalized.sourceDocumentId,
      chunkCount: normalized.chunkCount,
      openTarget: normalized.openTarget,
      openTargetType: normalized.openTargetType,
      createdFromSearch: normalized.createdFromSearch,
    };
  }

  private mapNotebookIngestionJob(row: Record<string, unknown>): NotebookIngestionJob {
    return {
      jobId: String(row.job_id),
      notebookId: String(row.notebook_id),
      itemKey: String(row.item_key),
      sourceType: String(row.source_type) as NotebookSourceType,
      uri: (row.uri as string | null) ?? null,
      sourcePath: (row.source_path as string | null) ?? null,
      state: String(row.state) as NotebookIngestionJobState,
      stage: String(row.stage) as NotebookIngestionJobStage,
      attemptCount: Number(row.attempt_count ?? 0),
      maxAttempts: Number(row.max_attempts ?? 0),
      lastError: (row.last_error as string | null) ?? null,
      nextRetryAt: row.next_retry_at ? toIsoString(row.next_retry_at as string) : null,
      createdAt: toIsoString(row.created_at as string),
      updatedAt: toIsoString(row.updated_at as string),
    };
  }

  private isNotebookItemUpgradeable(source: ReturnType<typeof normalizeNotebookSourceRecord>): boolean {
    if (source.contentText && source.contentText.trim().length > 0) return true;
    if (source.sourceType === 'local' && source.sourcePath) return true;
    if (source.sourceType === 'web' && source.uri) return true;
    if ((source.sourceType === 'generated' || source.sourceType === 'internal' || source.sourceType === 'api') && source.contentText) {
      return true;
    }
    return false;
  }

  private resolveInitialRetrievalStatus(source: ReturnType<typeof normalizeNotebookSourceRecord>): NotebookRetrievalStatus {
    if (source.sourceDocumentId && source.chunkCount != null) {
      return 'ready';
    }
    if (source.contentText && source.contentText.trim().length > 0) {
      return 'content_fetched';
    }
    if (source.uri || source.sourcePath) {
      return 'queued';
    }
    return 'saved_metadata_only';
  }
}
