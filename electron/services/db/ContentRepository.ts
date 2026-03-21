/**
 * ContentRepository
 *
 * Repository layer for source_documents and document_chunks.
 * Uses the shared pg Pool from PostgresMemoryRepository.
 * No ORM. All queries use parameterized SQL.
 */

import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import type {
  SourceDocumentRecord,
  DocumentChunkRecord,
  UpsertSourceDocumentInput,
} from '../../../shared/ingestion/ingestionTypes';

/** Minimal input type for inserting a batch of chunks. */
export interface InsertChunkInput {
  item_key: string;
  chunk_index: number;
  content: string;
  token_estimate: number;
  content_hash: string;
  char_start: number;
  char_end: number;
  section_label?: string | null;
  page_number?: number | null;
}

export class ContentRepository {
  constructor(private pool: Pool) {}

  // ─── Source Documents ───────────────────────────────────────────────────────

  /**
   * Insert a new source_document or update the metadata of an existing one
   * that already matches (item_key, content_hash).
   * Returns the persisted record.
   */
  async upsertSourceDocument(input: UpsertSourceDocumentInput): Promise<SourceDocumentRecord> {
    const id = uuidv4();
    const result = await this.pool.query<SourceDocumentRecord>(
      `INSERT INTO source_documents
         (id, item_key, notebook_id, title, uri, source_path, provider_id, external_id,
          source_type, mime_type, citation_label, display_domain, author, published_at,
          fetched_at, content, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (item_key, content_hash) DO UPDATE
         SET title          = EXCLUDED.title,
             uri            = EXCLUDED.uri,
             source_path    = EXCLUDED.source_path,
             provider_id    = EXCLUDED.provider_id,
             external_id    = EXCLUDED.external_id,
             source_type    = EXCLUDED.source_type,
             mime_type      = EXCLUDED.mime_type,
             citation_label = EXCLUDED.citation_label,
             display_domain = EXCLUDED.display_domain,
             author         = EXCLUDED.author,
             published_at   = EXCLUDED.published_at,
             fetched_at     = EXCLUDED.fetched_at,
             notebook_id    = COALESCE(EXCLUDED.notebook_id, source_documents.notebook_id),
             updated_at     = now()
       RETURNING *`,
      [
        id,
        input.item_key,
        input.notebook_id ?? null,
        input.title ?? null,
        input.uri ?? null,
        input.source_path ?? null,
        input.provider_id ?? null,
        input.external_id ?? null,
        input.source_type ?? null,
        input.mime_type ?? null,
        input.citation_label ?? null,
        input.display_domain ?? null,
        input.author ?? null,
        input.published_at ?? null,
        input.fetched_at ?? null,
        input.content,
        input.content_hash,
      ]
    );
    return this.mapSourceDocument(result.rows[0]);
  }

  /** Retrieve the most recently stored source_document for a given item_key. */
  async getDocumentByItemKey(itemKey: string): Promise<SourceDocumentRecord | null> {
    const result = await this.pool.query<SourceDocumentRecord>(
      `SELECT * FROM source_documents WHERE item_key = $1 ORDER BY updated_at DESC LIMIT 1`,
      [itemKey]
    );
    return result.rows[0] ? this.mapSourceDocument(result.rows[0]) : null;
  }

  /** Retrieve a source_document matching both item_key and content_hash. */
  async getDocumentByItemKeyAndHash(
    itemKey: string,
    contentHash: string
  ): Promise<SourceDocumentRecord | null> {
    const result = await this.pool.query<SourceDocumentRecord>(
      `SELECT * FROM source_documents WHERE item_key = $1 AND content_hash = $2 LIMIT 1`,
      [itemKey, contentHash]
    );
    return result.rows[0] ? this.mapSourceDocument(result.rows[0]) : null;
  }

  /**
   * Return true if a source_document with this (item_key, content_hash) pair
   * already exists — used to skip re-ingestion.
   */
  async documentExists(itemKey: string, contentHash: string): Promise<boolean> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM source_documents
       WHERE item_key = $1 AND content_hash = $2`,
      [itemKey, contentHash]
    );
    return parseInt(result.rows[0]?.count ?? '0', 10) > 0;
  }

  // ─── Document Chunks ────────────────────────────────────────────────────────

  /**
   * Replace all existing chunks for a document and insert the new batch.
   * Deletion cascades from source_documents, but we do explicit DELETE here
   * so callers can re-chunk without re-inserting the parent document.
   */
  async insertChunks(
    documentId: string,
    itemKey: string,
    chunks: InsertChunkInput[]
  ): Promise<DocumentChunkRecord[]> {
    // Remove any stale chunks for this document first.
    await this.pool.query(
      `DELETE FROM document_chunks WHERE document_id = $1`,
      [documentId]
    );

    const inserted: DocumentChunkRecord[] = [];
    for (const chunk of chunks) {
      const id = uuidv4();
      const result = await this.pool.query<DocumentChunkRecord>(
        `INSERT INTO document_chunks
           (id, document_id, item_key, chunk_index, content, token_estimate,
            content_hash, char_start, char_end, section_label, page_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          id,
          documentId,
          itemKey,
          chunk.chunk_index,
          chunk.content,
          chunk.token_estimate,
          chunk.content_hash,
          chunk.char_start,
          chunk.char_end,
          chunk.section_label ?? null,
          chunk.page_number ?? null,
        ]
      );
      if (result.rows[0]) inserted.push(this.mapChunk(result.rows[0]));
    }
    return inserted;
  }

  /** Retrieve all chunks for a given item_key, ordered by chunk_index. */
  async getChunksByItemKey(itemKey: string): Promise<DocumentChunkRecord[]> {
    const result = await this.pool.query<DocumentChunkRecord>(
      `SELECT dc.*
       FROM document_chunks dc
       JOIN source_documents sd ON sd.id = dc.document_id
       WHERE dc.item_key = $1
       ORDER BY dc.chunk_index ASC`,
      [itemKey]
    );
    return result.rows.map(r => this.mapChunk(r));
  }

  // ─── Row Mappers ─────────────────────────────────────────────────────────────

  private mapSourceDocument(row: SourceDocumentRecord): SourceDocumentRecord {
    return {
      ...row,
      published_at: row.published_at instanceof Date
        ? (row.published_at as unknown as Date).toISOString()
        : row.published_at,
      fetched_at: row.fetched_at instanceof Date
        ? (row.fetched_at as unknown as Date).toISOString()
        : row.fetched_at,
      created_at: row.created_at instanceof Date
        ? (row.created_at as unknown as Date).toISOString()
        : row.created_at,
      updated_at: row.updated_at instanceof Date
        ? (row.updated_at as unknown as Date).toISOString()
        : row.updated_at,
    };
  }

  private mapChunk(row: DocumentChunkRecord): DocumentChunkRecord {
    return {
      ...row,
      token_estimate: Number(row.token_estimate),
      chunk_index: Number(row.chunk_index),
      char_start: Number(row.char_start),
      char_end: Number(row.char_end),
      page_number: row.page_number != null ? Number(row.page_number) : null,
      created_at: row.created_at instanceof Date
        ? (row.created_at as unknown as Date).toISOString()
        : row.created_at,
    };
  }
}
