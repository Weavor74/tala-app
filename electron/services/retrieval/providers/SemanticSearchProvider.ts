/**
 * SemanticSearchProvider
 *
 * Retrieval provider that performs dense vector similarity search using
 * pgvector embeddings attached to document_chunks.
 *
 * Embedding engine: Ollama (via LocalEmbeddingProvider)
 * Default model:    embeddinggemma
 * Dimension:        768
 *
 * Implements the SearchProvider interface from shared/retrieval/retrievalTypes.ts
 * and registers itself with RetrievalOrchestrator under providerId = 'semantic'.
 *
 * Supports RetrievalMode 'semantic' and 'hybrid'.
 *
 * Never throws — errors are captured as SearchProviderResult.error.
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import type {
  SearchProvider,
  SearchProviderResult,
  NormalizedSearchResult,
  RetrievalScopeResolved,
  RetrievalProviderOptions,
  RetrievalMode,
} from '../../../../shared/retrieval/retrievalTypes';
import { LocalEmbeddingProvider, DEFAULT_EMBEDDING_MODEL } from '../../embedding/LocalEmbeddingProvider';
import type { EmbeddingsRepository } from '../../db/EmbeddingsRepository';

export const SEMANTIC_PROVIDER_ID = 'semantic';

export class SemanticSearchProvider implements SearchProvider {
  readonly id = SEMANTIC_PROVIDER_ID;
  readonly supportedModes: RetrievalMode[] = ['semantic', 'hybrid'];

  private readonly embeddingProvider: LocalEmbeddingProvider;
  private readonly model: string;

  constructor(
    private readonly embeddingsRepo: EmbeddingsRepository,
    modelOverride?: string,
    /** Optional: inject an embedding provider (used for testing). */
    embeddingProviderOverride?: LocalEmbeddingProvider,
  ) {
    this.model = modelOverride?.trim() || DEFAULT_EMBEDDING_MODEL;
    this.embeddingProvider =
      embeddingProviderOverride ?? new LocalEmbeddingProvider(null, this.model);
  }

  /**
   * Execute semantic search for the given query within the resolved scope.
   *
   * Steps:
   *   1. Embed queryText via LocalEmbeddingProvider
   *   2. Call EmbeddingsRepository.semanticSearchByVector() with scope constraints
   *   3. Map DB hits into NormalizedSearchResult[]
   */
  async search(
    query: string,
    scope: RetrievalScopeResolved,
    options: RetrievalProviderOptions,
  ): Promise<SearchProviderResult> {
    const startMs = Date.now();

    try {
      // 1. Embed the query text
      const queryVector = await this.embeddingProvider.embedText(query);

      // 2. Resolve item key scope constraints
      const itemKeys = resolveItemKeys(scope);

      // 3. Query pgvector
      const hits = await this.embeddingsRepo.semanticSearchByVector({
        queryVector,
        itemKeys: itemKeys.length > 0 ? itemKeys : undefined,
        embeddingModel: this.model,
        topK: options.topK ?? 10,
        minSimilarity: options.minScore ?? 0,
      });

      // 4. Map to NormalizedSearchResult
      const results: NormalizedSearchResult[] = hits.map(hit => ({
        itemKey: hit.item_key,
        title: hit.title ?? hit.citation_label ?? hit.uri ?? hit.item_key,
        uri: hit.uri,
        sourcePath: hit.source_path,
        snippet: hit.content.slice(0, 500) || null,
        sourceType: hit.source_type ?? 'semantic_chunk',
        providerId: SEMANTIC_PROVIDER_ID,
        externalId: hit.external_id ?? null,
        contentHash: hit.doc_content_hash,
        score: hit.similarity,
        metadata: {
          chunkId: hit.chunk_id,
          documentId: hit.document_id,
          similarity: hit.similarity,
          charStart: hit.char_start,
          charEnd: hit.char_end,
          sectionLabel: hit.section_label,
          pageNumber: hit.page_number,
          citationLabel: hit.citation_label,
          fetchedAt: hit.fetched_at,
          displayDomain: hit.display_domain,
          providerProvenance: hit.provider_id,
        },
      }));

      return {
        providerId: SEMANTIC_PROVIDER_ID,
        results,
        durationMs: Date.now() - startMs,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        providerId: SEMANTIC_PROVIDER_ID,
        results: [],
        durationMs: Date.now() - startMs,
        error: msg,
      };
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive item_key constraints from a resolved scope.
 *
 * - notebook scope: use resolved itemKeys (set by RetrievalOrchestrator)
 * - explicit_sources: item_keys are not available via URI alone; fall back to
 *   global search (the URI/path filter is left to the DB join)
 * - global: no constraints
 */
function resolveItemKeys(scope: RetrievalScopeResolved): string[] {
  if (scope.scopeType === 'notebook') {
    return scope.itemKeys ?? [];
  }
  // For explicit_sources scope, itemKeys may be empty; semantic search will
  // be unconstrained at the item_key level. Callers can narrow via topK/minScore.
  return scope.itemKeys ?? [];
}
