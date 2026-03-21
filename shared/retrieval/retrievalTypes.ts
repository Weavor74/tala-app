/**
 * retrievalTypes.ts
 *
 * Canonical retrieval contracts for the TALA retrieval orchestration layer.
 *
 * These types are the single shared contract consumed by:
 *   - RetrievalOrchestrator (electron/services/retrieval/)
 *   - Search UI (renderer)
 *   - UPDATE AGENT CONTEXT agent path
 *   - Future pgvector and graph retrieval providers
 *
 * Pure TypeScript — no Node.js APIs (process, fs, path).
 * Compiled by both electron/tsconfig.json (Node) and tsconfig.app.json (renderer).
 */

// ─── Scope ───────────────────────────────────────────────────────────────────

/**
 * Controls which sources are eligible for retrieval.
 *
 * - 'global'            — no source boundary; all indexed content is searched.
 * - 'notebook'          — restricted to the URIs / paths / item keys belonging
 *                         to a specific notebook (resolved via ResearchRepository).
 * - 'explicit_sources'  — caller supplies an explicit list of URIs or source paths.
 */
export type RetrievalScopeType = 'global' | 'notebook' | 'explicit_sources';

/**
 * The resolved set of source constraints derived from a RetrievalScopeType.
 * Produced by RetrievalOrchestrator before being handed to each provider.
 */
export interface RetrievalScopeResolved {
  scopeType: RetrievalScopeType;
  /** Present when scopeType === 'notebook'. */
  notebookId?: string;
  /** URIs collected from the scope (notebook items or explicit list). */
  uris: string[];
  /** File-system paths collected from the scope. */
  sourcePaths: string[];
  /** Stable item keys from the scope (used as retrieval boundary for pgvector). */
  itemKeys: string[];
}

// ─── Mode ────────────────────────────────────────────────────────────────────

/**
 * The retrieval strategy to apply.
 *
 * - 'keyword'   — BM25-style full-text matching; maps to PostgreSQL text search
 *                 or UniversalSearchService providers.
 * - 'semantic'  — Dense vector similarity via pgvector; requires embeddings.
 * - 'hybrid'    — Keyword + semantic with score fusion (RRF or weighted).
 * - 'graph'     — Graph-topology traversal via the tala-memory-graph backend.
 */
export type RetrievalMode = 'keyword' | 'semantic' | 'hybrid' | 'graph';

// ─── Normalized Result ───────────────────────────────────────────────────────

/**
 * A single retrieval result normalized across all provider types.
 *
 * Providers map their own result shapes to this interface before returning
 * results to the orchestrator. The orchestrator merges and deduplicates by
 * itemKey before returning a RetrievalResponse.
 */
export interface NormalizedSearchResult {
  /**
   * Stable, provider-agnostic key for deduplication.
   * Typically: `${providerId}:${externalId}` or a content-hash-derived key.
   */
  itemKey: string;
  /** Human-readable title or heading for the result. */
  title: string;
  /** Canonical URI (URL or file URI scheme). Null if unavailable. */
  uri?: string | null;
  /** Absolute or repo-relative file-system path. Null if unavailable. */
  sourcePath?: string | null;
  /** Short excerpt or context window around the match. Null if unavailable. */
  snippet?: string | null;
  /**
   * Source category for downstream context assembly.
   * Examples: 'web', 'notebook_item', 'observation', 'artifact', 'graph_node'.
   */
  sourceType?: string | null;
  /** ID of the provider that produced this result. */
  providerId: string;
  /** Provider-native identifier (e.g., embedding row UUID, search result ID). */
  externalId?: string | null;
  /** SHA-256 or similar hash of the source content for change detection. */
  contentHash?: string | null;
  /** Retrieval score (higher = more relevant). Null if provider does not score. */
  score?: number | null;
  /** Arbitrary provider-specific metadata preserved for downstream consumers. */
  metadata?: Record<string, unknown>;
}

// ─── Provider ────────────────────────────────────────────────────────────────

/**
 * Options forwarded from a RetrievalRequest to each SearchProvider.
 */
export interface RetrievalProviderOptions {
  /** Maximum number of results to return per provider. */
  topK?: number;
  /** Minimum relevance score threshold; results below are excluded. */
  minScore?: number;
  /** Arbitrary provider-specific filter parameters. */
  filters?: Record<string, unknown>;
}

/**
 * The output of a single provider execution.
 * Wraps normalized results with timing and any per-provider error.
 */
export interface SearchProviderResult {
  /** Provider ID that produced these results. */
  providerId: string;
  /** Normalized results from this provider. */
  results: NormalizedSearchResult[];
  /** Wall-clock milliseconds elapsed during the provider call. */
  durationMs: number;
  /** Non-null if the provider encountered a non-fatal error. */
  error?: string | null;
}

/**
 * Contract that every retrieval backend must implement.
 *
 * Providers register themselves with RetrievalOrchestrator.registerProvider().
 * The orchestrator calls search() only when the requested RetrievalMode is
 * listed in the provider's supportedModes.
 *
 * Future providers (pgvector, graph) must implement this interface and
 * register themselves without changing the orchestrator core.
 */
export interface SearchProvider {
  /** Unique, stable identifier (e.g., 'keyword_pg', 'semantic_pgvector', 'graph_memory'). */
  readonly id: string;
  /** Which retrieval modes this provider satisfies. */
  readonly supportedModes: RetrievalMode[];
  /**
   * Execute retrieval for the given query within the resolved scope.
   * Must never throw — errors should be returned as SearchProviderResult.error.
   */
  search(
    query: string,
    scope: RetrievalScopeResolved,
    options: RetrievalProviderOptions,
  ): Promise<SearchProviderResult>;
}

// ─── Request / Response ──────────────────────────────────────────────────────

/**
 * A retrieval request issued by the Search UI or the agent context update path.
 */
export interface RetrievalRequest {
  /** The raw search query string. */
  query: string;
  /** Retrieval strategy to apply. */
  mode: RetrievalMode;
  /** Source boundary for this request. */
  scope: RetrievalScopeType;
  /**
   * Required when scope === 'notebook'.
   * The orchestrator calls ResearchRepository.resolveNotebookScope() to expand
   * this into a RetrievalScopeResolved.
   */
  notebookId?: string;
  /**
   * Required when scope === 'explicit_sources'.
   * A caller-supplied list of URIs or source paths to restrict retrieval to.
   */
  explicitSources?: string[];
  /** Maximum total results to return after merging all providers. */
  topK?: number;
  /** Minimum relevance score; results below are excluded from the final response. */
  minScore?: number;
  /**
   * When set, restricts execution to only these provider IDs.
   * Useful for targeted retrieval (e.g., "semantic only from pgvector provider").
   */
  providerIds?: string[];
  /** Forwarded verbatim to each provider as RetrievalProviderOptions.filters. */
  filters?: Record<string, unknown>;
}

/**
 * The canonical response returned by RetrievalOrchestrator.retrieve().
 * Consumed by the Search UI result panel and by the agent context assembler.
 */
export interface RetrievalResponse {
  /** Original query string from the request. */
  query: string;
  /** Retrieval mode that was applied. */
  mode: RetrievalMode;
  /** Scope as resolved by the orchestrator (expanded from the request). */
  scopeResolved: RetrievalScopeResolved;
  /**
   * Merged, deduplicated, and score-sorted results across all providers.
   * Length is bounded by RetrievalRequest.topK when provided.
   */
  results: NormalizedSearchResult[];
  /** Per-provider raw results, preserved for diagnostics and UI attribution. */
  providerResults: SearchProviderResult[];
  /** Total number of items in results after deduplication and topK capping. */
  totalResults: number;
  /** Wall-clock milliseconds for the full orchestration round-trip. */
  durationMs: number;
  /**
   * Non-fatal warnings (e.g., provider returned an error, scope could not be
   * fully resolved). The response is still usable when warnings are present.
   */
  warnings?: string[];
}
