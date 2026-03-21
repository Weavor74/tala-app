/**
 * ChunkEmbeddingService
 *
 * Generates embeddings for document_chunks and stores them in chunk_embeddings.
 *
 * Embedding engine: Ollama (via LocalEmbeddingProvider)
 * Default model:    embeddinggemma
 * Dimension:        768
 *
 * Architecture:
 *   - Reads document_chunks via EmbeddingsRepository.getChunksMissingEmbeddings()
 *   - Calls LocalEmbeddingProvider.embedText() per chunk
 *   - Persists via EmbeddingsRepository.upsertChunkEmbedding()
 *   - Allows partial success — individual chunk failures are captured as warnings
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import type { EmbeddingsRepository } from '../db/EmbeddingsRepository';
import { LocalEmbeddingProvider, DEFAULT_EMBEDDING_MODEL } from './LocalEmbeddingProvider';

// The embedding dimension produced by embeddinggemma via Ollama.
export const EMBEDDING_DIMENSION = 768;

export interface EmbedBatchResult {
  chunksEmbedded: number;
  chunksSkipped: number;
  warnings: string[];
}

export interface EmbedOptions {
  /** When true, re-embed chunks that already have an embedding. */
  reembed?: boolean;
}

export class ChunkEmbeddingService {
  private readonly embeddingProvider: LocalEmbeddingProvider;
  private readonly model: string;

  constructor(
    private embeddingsRepo: EmbeddingsRepository,
    /** Optional: override the embedding model name. Defaults to embeddinggemma. */
    modelOverride?: string,
    /** Optional: inject an embedding provider (used for testing). */
    embeddingProviderOverride?: LocalEmbeddingProvider,
  ) {
    this.model = modelOverride?.trim() || DEFAULT_EMBEDDING_MODEL;
    this.embeddingProvider =
      embeddingProviderOverride ?? new LocalEmbeddingProvider(null, this.model);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Embed all document_chunks belonging to items in a notebook.
   * Resolves item_keys from the notebook then delegates to embedItems().
   *
   * NOTE: This method requires the caller to supply the item_keys for the
   * notebook (resolved via ResearchRepository.listNotebookItems or similar).
   * The service itself is kept repository-agnostic beyond EmbeddingsRepository.
   */
  async embedNotebook(
    itemKeys: string[],
    options: EmbedOptions = {},
  ): Promise<EmbedBatchResult> {
    if (itemKeys.length === 0) {
      return { chunksEmbedded: 0, chunksSkipped: 0, warnings: [] };
    }
    return this.embedItems(itemKeys, options);
  }

  /**
   * Embed all document_chunks belonging to the given item_keys.
   */
  async embedItems(
    itemKeys: string[],
    options: EmbedOptions = {},
  ): Promise<EmbedBatchResult> {
    const chunks = await this.embeddingsRepo.getChunksMissingEmbeddings({
      itemKeys,
      embeddingModel: this.model,
    });

    const allChunkIds = chunks.map(c => c.chunk_id);
    return this._embedChunkRows(chunks, allChunkIds, options);
  }

  /**
   * Embed a specific set of document_chunks by their IDs.
   * When reembed=false (default) any chunk that already has an embedding
   * for this model is skipped.
   */
  async embedChunks(
    chunkIds: string[],
    options: EmbedOptions = {},
  ): Promise<EmbedBatchResult> {
    if (chunkIds.length === 0) {
      return { chunksEmbedded: 0, chunksSkipped: 0, warnings: [] };
    }

    // Fetch missing embeddings scoped to these specific chunk IDs.
    // We rely on the "missing" query and then filter to only the requested IDs.
    const missing = await this.embeddingsRepo.getChunksMissingEmbeddings({
      embeddingModel: this.model,
    });

    const missingIds = new Set(missing.map(c => c.chunk_id));
    const rows = options.reembed
      ? missing.filter(c => chunkIds.includes(c.chunk_id))
      : missing.filter(c => chunkIds.includes(c.chunk_id) && missingIds.has(c.chunk_id));

    const skipped = chunkIds.length - rows.length;
    const result = await this._embedChunkRows(rows, chunkIds, options);
    return { ...result, chunksSkipped: result.chunksSkipped + skipped };
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Embed a list of chunk rows and upsert results.
   * Never throws — errors are captured as warnings.
   */
  private async _embedChunkRows(
    rows: Array<{
      chunk_id: string;
      document_id: string;
      item_key: string;
      content: string;
      content_hash: string;
    }>,
    _requestedIds: string[],
    options: EmbedOptions,
  ): Promise<EmbedBatchResult> {
    let chunksEmbedded = 0;
    let chunksSkipped = 0;
    const warnings: string[] = [];

    for (const chunk of rows) {
      // Skip if already embedded (and reembed not requested)
      if (!options.reembed) {
        const existing = await this.embeddingsRepo
          .getEmbeddingByChunkIdAndModel(chunk.chunk_id, this.model)
          .catch(() => null);
        if (existing) {
          chunksSkipped++;
          continue;
        }
      }

      try {
        const vector = await this.embeddingProvider.embedText(chunk.content);

        if (vector.length !== EMBEDDING_DIMENSION) {
          warnings.push(
            `Chunk ${chunk.chunk_id}: unexpected embedding dimension ${vector.length} (expected ${EMBEDDING_DIMENSION}).`,
          );
          // Store anyway — the DB constraint enforces vector(768) so this
          // would fail at upsert time; catch below will capture the warning.
        }

        await this.embeddingsRepo.upsertChunkEmbedding({
          chunk_id: chunk.chunk_id,
          document_id: chunk.document_id,
          item_key: chunk.item_key,
          embedding_model: this.model,
          embedding_dimension: vector.length,
          embedding: vector,
          content_hash: chunk.content_hash,
        });

        chunksEmbedded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Chunk ${chunk.chunk_id}: embedding failed — ${msg}`);
      }
    }

    return { chunksEmbedded, chunksSkipped, warnings };
  }
}
