/**
 * EmbeddingsRepository
 *
 * Repository layer for chunk_embeddings.
 * Uses the shared pg Pool (same pool as ContentRepository and ResearchRepository).
 *
 * Responsibilities:
 *   - upsertChunkEmbedding  — store or replace a dense vector for a chunk+model pair
 *   - getEmbeddingByChunkIdAndModel  — lookup for skip-existing logic in ChunkEmbeddingService
 *   - getChunksMissingEmbeddings  — batch selection of chunks not yet embedded
 *   - semanticSearchByVector  — cosine-similarity search with full provenance metadata
 *
 * No ORM. All queries use parameterized SQL.
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { toSql as pgvectorToSql } from 'pgvector';
import { toIsoString, toIsoStringOrNull } from './dbUtils';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A stored embedding record (embedding vector omitted — large payload). */
export interface ChunkEmbeddingRecord {
  id: string;
  chunk_id: string;
  document_id: string;
  item_key: string;
  embedding_model: string;
  embedding_dimension: number;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertChunkEmbeddingInput {
  chunk_id: string;
  document_id: string;
  item_key: string;
  embedding_model: string;
  embedding_dimension: number;
  embedding: number[];
  content_hash: string;
}

/** A single semantic search hit with full provenance from document_chunks and source_documents. */
export interface SemanticSearchHit {
  chunk_id: string;
  document_id: string;
  item_key: string;
  /** Chunk content — the text that was embedded. */
  content: string;
  char_start: number;
  char_end: number;
  section_label: string | null;
  page_number: number | null;
  /** source_documents fields */
  title: string | null;
  uri: string | null;
  source_path: string | null;
  source_type: string | null;
  provider_id: string | null;
  external_id: string | null;
  citation_label: string | null;
  display_domain: string | null;
  fetched_at: string | null;
  doc_content_hash: string;
  /** Cosine similarity score in [0, 1]. Higher = more similar. */
  similarity: number;
}

export interface SemanticSearchArgs {
  queryVector: number[];
  /** Restrict results to chunks belonging to these item_keys. */
  itemKeys?: string[];
  /** Restrict results to a specific embedding model. */
  embeddingModel?: string;
  topK?: number;
  minSimilarity?: number;
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class EmbeddingsRepository {
  constructor(private pool: Pool) {}

  // ─── Write ────────────────────────────────────────────────────────────────

  /**
   * Insert or replace the embedding for a (chunk_id, embedding_model) pair.
   * Returns the persisted record (embedding vector excluded from response).
   */
  async upsertChunkEmbedding(input: UpsertChunkEmbeddingInput): Promise<ChunkEmbeddingRecord> {
    const id = uuidv4();
    const embeddingValue = pgvectorToSql(input.embedding);

    const result = await this.pool.query<ChunkEmbeddingRecord>(
      `INSERT INTO chunk_embeddings
         (id, chunk_id, document_id, item_key, embedding_model,
          embedding_dimension, embedding, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8)
       ON CONFLICT (chunk_id, embedding_model) DO UPDATE
         SET embedding_dimension = EXCLUDED.embedding_dimension,
             embedding           = EXCLUDED.embedding,
             content_hash        = EXCLUDED.content_hash,
             updated_at          = now()
       RETURNING id, chunk_id, document_id, item_key, embedding_model,
                 embedding_dimension, content_hash, created_at, updated_at`,
      [
        id,
        input.chunk_id,
        input.document_id,
        input.item_key,
        input.embedding_model,
        input.embedding_dimension,
        embeddingValue,
        input.content_hash,
      ]
    );
    return this.mapRecord(result.rows[0]);
  }

  // ─── Read ─────────────────────────────────────────────────────────────────

  /**
   * Look up an existing embedding record for a specific chunk + model.
   * Returns null when the embedding does not exist yet.
   */
  async getEmbeddingByChunkIdAndModel(
    chunkId: string,
    embeddingModel: string,
  ): Promise<ChunkEmbeddingRecord | null> {
    const result = await this.pool.query<ChunkEmbeddingRecord>(
      `SELECT id, chunk_id, document_id, item_key, embedding_model,
              embedding_dimension, content_hash, created_at, updated_at
       FROM chunk_embeddings
       WHERE chunk_id = $1 AND embedding_model = $2
       LIMIT 1`,
      [chunkId, embeddingModel]
    );
    return result.rows[0] ? this.mapRecord(result.rows[0]) : null;
  }

  /**
   * Return document_chunks that do not yet have a chunk_embeddings row for
   * the given embedding_model.
   *
   * Optional filters:
   *   itemKeys   — restrict to chunks belonging to these item_keys
   *   notebookId — (future) restrict to chunks whose source_document belongs
   *                to a notebook; currently filtering is done via itemKeys
   *   embeddingModel — which model to check for (defaults to 'embeddinggemma')
   */
  async getChunksMissingEmbeddings(opts: {
    itemKeys?: string[];
    notebookId?: string;
    embeddingModel?: string;
  } = {}): Promise<Array<{
    chunk_id: string;
    document_id: string;
    item_key: string;
    content: string;
    content_hash: string;
  }>> {
    const model = opts.embeddingModel ?? 'embeddinggemma';
    const params: unknown[] = [model];
    const conditions: string[] = [];

    if (opts.itemKeys && opts.itemKeys.length > 0) {
      params.push(opts.itemKeys);
      conditions.push(`dc.item_key = ANY($${params.length})`);
    }

    const whereClause =
      conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

    const result = await this.pool.query<{
      chunk_id: string;
      document_id: string;
      item_key: string;
      content: string;
      content_hash: string;
    }>(
      `SELECT dc.id AS chunk_id,
              dc.document_id,
              dc.item_key,
              dc.content,
              dc.content_hash
       FROM document_chunks dc
       WHERE NOT EXISTS (
         SELECT 1 FROM chunk_embeddings ce
         WHERE ce.chunk_id = dc.id
           AND ce.embedding_model = $1
       )
       ${whereClause}
       ORDER BY dc.item_key, dc.chunk_index`,
      params
    );
    return result.rows;
  }

  // ─── Semantic Search ──────────────────────────────────────────────────────

  /**
   * Cosine-similarity search over chunk_embeddings joined to document_chunks
   * and source_documents.
   *
   * Returns ranked hits with full citation/provenance metadata.
   */
  async semanticSearchByVector(args: SemanticSearchArgs): Promise<SemanticSearchHit[]> {
    const {
      queryVector,
      itemKeys,
      embeddingModel = 'embeddinggemma',
      topK = 10,
      minSimilarity = 0,
    } = args;

    const queryVec = pgvectorToSql(queryVector);
    const params: unknown[] = [queryVec, embeddingModel, minSimilarity, topK];
    const conditions: string[] = [];

    if (itemKeys && itemKeys.length > 0) {
      params.push(itemKeys);
      conditions.push(`ce.item_key = ANY($${params.length})`);
    }

    const whereClause =
      conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

    const result = await this.pool.query<{
      chunk_id: string;
      document_id: string;
      item_key: string;
      content: string;
      char_start: string;
      char_end: string;
      section_label: string | null;
      page_number: string | null;
      title: string | null;
      uri: string | null;
      source_path: string | null;
      source_type: string | null;
      provider_id: string | null;
      external_id: string | null;
      citation_label: string | null;
      display_domain: string | null;
      fetched_at: string | null;
      doc_content_hash: string;
      similarity: string;
    }>(
      `SELECT
         ce.chunk_id,
         ce.document_id,
         ce.item_key,
         dc.content,
         dc.char_start,
         dc.char_end,
         dc.section_label,
         dc.page_number,
         sd.title,
         sd.uri,
         sd.source_path,
         sd.source_type,
         sd.provider_id,
         sd.external_id,
         sd.citation_label,
         sd.display_domain,
         sd.fetched_at,
         sd.content_hash AS doc_content_hash,
         (1 - (ce.embedding <=> $1::vector)) AS similarity
       FROM chunk_embeddings ce
       JOIN document_chunks dc ON dc.id = ce.chunk_id
       JOIN source_documents sd ON sd.id = ce.document_id
       WHERE ce.embedding_model = $2
         AND (1 - (ce.embedding <=> $1::vector)) >= $3
         ${whereClause}
       ORDER BY ce.embedding <=> $1::vector
       LIMIT $4`,
      params
    );

    return result.rows.map((row: any) => ({
      chunk_id: row.chunk_id,
      document_id: row.document_id,
      item_key: row.item_key,
      content: row.content,
      char_start: Number(row.char_start),
      char_end: Number(row.char_end),
      section_label: row.section_label,
      page_number: row.page_number != null ? Number(row.page_number) : null,
      title: row.title,
      uri: row.uri,
      source_path: row.source_path,
      source_type: row.source_type,
      provider_id: row.provider_id,
      external_id: row.external_id,
      citation_label: row.citation_label,
      display_domain: row.display_domain,
      fetched_at: toIsoStringOrNull(row.fetched_at),
      doc_content_hash: row.doc_content_hash,
      similarity: Number(row.similarity),
    }));
  }

  // ─── Mapper ───────────────────────────────────────────────────────────────

  private mapRecord(row: ChunkEmbeddingRecord): ChunkEmbeddingRecord {
    return {
      ...row,
      embedding_dimension: Number(row.embedding_dimension),
      created_at: toIsoString(row.created_at),
      updated_at: toIsoString(row.updated_at),
    };
  }
}
