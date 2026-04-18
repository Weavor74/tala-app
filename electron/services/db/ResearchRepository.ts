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
} from '../../../shared/researchTypes';
import {
  normalizeNotebookItemForStorage,
  normalizeNotebookSourceRecord,
  resolveNotebookOpenTarget,
} from '../../../shared/researchTypes';

export class ResearchRepository {
  constructor(private pool: Pool) {}

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
          JSON.stringify(normalized.metadata_json ?? {}),
        ]
      );
      if (result.rows[0]) inserted.push(this.mapNotebookItem(result.rows[0]));
    }
    return inserted;
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
      openTarget: normalized.openTarget,
      openTargetType: normalized.openTargetType,
      createdFromSearch: normalized.createdFromSearch,
    };
  }
}
