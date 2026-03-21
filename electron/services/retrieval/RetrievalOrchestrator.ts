/**
 * RetrievalOrchestrator
 *
 * Canonical retrieval orchestration layer for TALA.
 *
 * Responsibilities:
 *   1. Accept a RetrievalRequest from any caller (Search UI, agent context path).
 *   2. Resolve the retrieval scope (global / notebook / explicit_sources).
 *   3. Select registered providers that support the requested RetrievalMode.
 *   4. Execute selected providers in parallel, capturing per-provider results.
 *   5. Merge, deduplicate (by itemKey), and score-sort the normalized results.
 *   6. Return a RetrievalResponse with the merged results and full diagnostics.
 *
 * Provider registration is open — future pgvector and graph providers register
 * themselves with registerProvider() without changing the orchestrator core.
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import type { ResearchRepository } from '../db/ResearchRepository';
import type {
  RetrievalRequest,
  RetrievalResponse,
  RetrievalScopeResolved,
  SearchProvider,
  SearchProviderResult,
  NormalizedSearchResult,
} from '../../../shared/retrieval/retrievalTypes';

// ─── Hybrid scoring constants ─────────────────────────────────────────────────

const SEMANTIC_WEIGHT = 0.6;
const KEYWORD_WEIGHT = 0.4;
const NOTEBOOK_BOOST = 0.1;

export class RetrievalOrchestrator {
  private readonly providers = new Map<string, SearchProvider>();

  /**
   * @param researchRepo  Optional ResearchRepository used to expand notebook
   *                      scopes. When omitted, notebook-scoped requests return
   *                      an empty scope (safe degraded mode).
   */
  constructor(private readonly researchRepo?: ResearchRepository) {}

  // ─── Provider Registry ─────────────────────────────────────────────────────

  /**
   * Register a retrieval provider.
   * Providers with duplicate IDs replace the previously registered one.
   */
  registerProvider(provider: SearchProvider): void {
    this.providers.set(provider.id, provider);
  }

  /**
   * Unregister a provider by ID.
   * Returns true if the provider was found and removed.
   */
  unregisterProvider(id: string): boolean {
    return this.providers.delete(id);
  }

  /** Return a snapshot of all currently registered providers. */
  listProviders(): SearchProvider[] {
    return Array.from(this.providers.values());
  }

  // ─── Primary Entry Point ───────────────────────────────────────────────────

  /**
   * Execute a retrieval request end-to-end.
   *
   * - Resolves the scope from the request (calls ResearchRepository for notebooks).
   * - Selects providers matching the requested mode (and optional providerIds filter).
   * - Runs selected providers in parallel; provider errors are captured as warnings.
   * - Merges and deduplicates results by itemKey, then sorts by score descending.
   * - Caps the final result list at request.topK when provided.
   */
  async retrieve(request: RetrievalRequest): Promise<RetrievalResponse> {
    const startMs = Date.now();
    const warnings: string[] = [];

    // 1. Resolve scope
    const scopeResolved = await this.resolveScope(request, warnings);

    // 2. Select eligible providers
    const eligible = this.selectProviders(request);

    // 3. Execute providers in parallel
    const providerResults = await this.executeProviders(
      eligible,
      request,
      scopeResolved,
      warnings,
    );

    // 4. Merge and deduplicate
    const results = this.mergeResults(providerResults, request.mode, scopeResolved, request.topK);

    return {
      query: request.query,
      mode: request.mode,
      scopeResolved,
      results,
      providerResults,
      totalResults: results.length,
      durationMs: Date.now() - startMs,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // ─── Scope Resolution ──────────────────────────────────────────────────────

  private async resolveScope(
    request: RetrievalRequest,
    warnings: string[],
  ): Promise<RetrievalScopeResolved> {
    if (request.scope === 'notebook') {
      if (!request.notebookId) {
        warnings.push(
          'RetrievalRequest.scope is "notebook" but notebookId was not provided; falling back to global scope.',
        );
        return emptyGlobalScope();
      }
      if (!this.researchRepo) {
        warnings.push(
          'RetrievalRequest.scope is "notebook" but no ResearchRepository is configured; falling back to global scope.',
        );
        return emptyGlobalScope();
      }
      try {
        const raw = await this.researchRepo.resolveNotebookScope(request.notebookId);
        return {
          scopeType: 'notebook',
          notebookId: request.notebookId,
          uris: raw.uris,
          sourcePaths: raw.sourcePaths,
          itemKeys: raw.itemKeys,
        };
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : String(err);
        warnings.push(
          `Failed to resolve notebook scope for "${request.notebookId}": ${msg}. Falling back to global scope.`,
        );
        return emptyGlobalScope();
      }
    }

    if (request.scope === 'explicit_sources') {
      return {
        scopeType: 'explicit_sources',
        uris: request.explicitSources ?? [],
        sourcePaths: [],
        itemKeys: [],
      };
    }

    // Default: global
    return emptyGlobalScope();
  }

  // ─── Provider Selection ───────────────────────────────────────────────────

  private selectProviders(request: RetrievalRequest): SearchProvider[] {
    const eligible: SearchProvider[] = [];
    for (const [id, provider] of this.providers) {
      if (request.providerIds && !request.providerIds.includes(id)) {
        continue;
      }
      if (provider.supportedModes.includes(request.mode)) {
        eligible.push(provider);
      }
    }
    return eligible;
  }

  // ─── Provider Execution ───────────────────────────────────────────────────

  private async executeProviders(
    providers: SearchProvider[],
    request: RetrievalRequest,
    scope: RetrievalScopeResolved,
    warnings: string[],
  ): Promise<SearchProviderResult[]> {
    const providerOptions = {
      topK: request.topK,
      minScore: request.minScore,
      filters: request.filters,
    };

    const settled = await Promise.allSettled(
      providers.map(p => p.search(request.query, scope, providerOptions)),
    );

    return settled.map((outcome, i): SearchProviderResult => {
      if (outcome.status === 'fulfilled') {
        return outcome.value;
      }
      const provider = providers[i];
      const msg =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
      warnings.push(`Provider "${provider.id}" failed: ${msg}`);
      return {
        providerId: provider.id,
        results: [],
        durationMs: 0,
        error: msg,
      };
    });
  }

  // ─── Result Merging ───────────────────────────────────────────────────────

  /**
   * Merge provider results.
   *
   * - For 'hybrid' mode: applies score normalization, weighted fusion scoring,
   *   URI/contentHash-based deduplication, and optional notebook boost.
   * - For all other modes: deduplicate by itemKey (first occurrence wins),
   *   sort by score descending, cap at topK.
   */
  private mergeResults(
    providerResults: SearchProviderResult[],
    mode: import('../../../shared/retrieval/retrievalTypes').RetrievalMode,
    scope: RetrievalScopeResolved,
    topK?: number,
  ): NormalizedSearchResult[] {
    if (mode === 'hybrid') {
      return this.hybridMergeResults(providerResults, scope, topK);
    }

    const seen = new Set<string>();
    const merged: NormalizedSearchResult[] = [];

    for (const pr of providerResults) {
      for (const result of pr.results) {
        if (!seen.has(result.itemKey)) {
          seen.add(result.itemKey);
          merged.push(result);
        }
      }
    }

    // Sort by score descending; results without a score sort after scored ones.
    merged.sort((a, b) => {
      const sa = a.score ?? -Infinity;
      const sb = b.score ?? -Infinity;
      return sb - sa;
    });

    return topK != null ? merged.slice(0, topK) : merged;
  }

  // ─── Hybrid Fusion ────────────────────────────────────────────────────────

  /**
   * Merge results from semantic and keyword providers using weighted score fusion.
   *
   * Steps:
   *   1. Normalize scores to [0,1] per provider type.
   *   2. Deduplicate across providers by itemKey, URI, or contentHash.
   *   3. Compute fusedScore = (SEMANTIC_WEIGHT * semanticScore) + (KEYWORD_WEIGHT * keywordScore).
   *   4. Apply notebook boost (+NOTEBOOK_BOOST) when scopeType === 'notebook'.
   *   5. Sort by fusedScore descending; apply topK.
   *   6. Emit semanticScore, keywordScore, fusedScore, sourceProviders in metadata.
   */
  private hybridMergeResults(
    providerResults: SearchProviderResult[],
    scope: RetrievalScopeResolved,
    topK?: number,
  ): NormalizedSearchResult[] {
    type MergeCandidate = {
      result: NormalizedSearchResult;
      semanticScore: number;
      keywordScore: number;
      sourceProviders: string[];
    };

    const mergeMap = new Map<string, MergeCandidate>();
    // Secondary lookup tables: URI → canonical itemKey, contentHash → canonical itemKey
    const uriToKey = new Map<string, string>();
    const hashToKey = new Map<string, string>();

    const findExistingKey = (result: NormalizedSearchResult): string | undefined => {
      if (mergeMap.has(result.itemKey)) return result.itemKey;
      if (result.uri) {
        const k = uriToKey.get(result.uri);
        if (k !== undefined) return k;
      }
      if (result.contentHash) {
        const k = hashToKey.get(result.contentHash);
        if (k !== undefined) return k;
      }
      return undefined;
    };

    for (const pr of providerResults) {
      const isSemantic = this.isSemanticProviderById(pr.providerId);

      for (const result of pr.results) {
        const normalizedScore = normalizeScore(result.score);
        const existingKey = findExistingKey(result);

        if (existingKey !== undefined) {
          // Merge into existing candidate
          const cand = mergeMap.get(existingKey)!;
          if (isSemantic) {
            cand.semanticScore = Math.max(cand.semanticScore, normalizedScore);
          } else {
            cand.keywordScore = Math.max(cand.keywordScore, normalizedScore);
          }
          // Keep best title (prefer non-key titles)
          if (
            (cand.result.title === cand.result.itemKey || !cand.result.title) &&
            result.title &&
            result.title !== result.itemKey
          ) {
            cand.result = { ...cand.result, title: result.title };
          }
          // Keep first non-null snippet
          if (!cand.result.snippet && result.snippet) {
            cand.result = { ...cand.result, snippet: result.snippet };
          }
          if (!cand.sourceProviders.includes(pr.providerId)) {
            cand.sourceProviders.push(pr.providerId);
          }
        } else {
          // New entry
          const cand: MergeCandidate = {
            result: { ...result },
            semanticScore: isSemantic ? normalizedScore : 0,
            keywordScore: isSemantic ? 0 : normalizedScore,
            sourceProviders: [pr.providerId],
          };
          mergeMap.set(result.itemKey, cand);
          if (result.uri) uriToKey.set(result.uri, result.itemKey);
          if (result.contentHash) hashToKey.set(result.contentHash, result.itemKey);
        }
      }
    }

    // Compute fusedScore and build final results
    const isNotebook = scope.scopeType === 'notebook';
    const merged: NormalizedSearchResult[] = [];

    for (const [, cand] of mergeMap) {
      const fused =
        SEMANTIC_WEIGHT * cand.semanticScore + KEYWORD_WEIGHT * cand.keywordScore;
      const fusedScore = isNotebook ? Math.min(1, fused + NOTEBOOK_BOOST) : fused;

      merged.push({
        ...cand.result,
        score: fusedScore,
        metadata: {
          ...cand.result.metadata,
          semanticScore: cand.semanticScore,
          keywordScore: cand.keywordScore,
          fusedScore,
          sourceProviders: cand.sourceProviders,
        },
      });
    }

    // Sort by fusedScore descending
    merged.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));

    return topK != null ? merged.slice(0, topK) : merged;
  }

  /**
   * Returns true if the provider identified by `id` is a semantic provider.
   *
   * A provider is considered semantic when it supports 'semantic' mode but not
   * 'keyword' mode.  This capability-based check avoids relying on a hardcoded
   * provider ID and remains correct if multiple semantic backends are registered.
   */
  private isSemanticProviderById(id: string): boolean {
    const provider = this.providers.get(id);
    if (!provider) return false;
    return (
      provider.supportedModes.includes('semantic') &&
      !provider.supportedModes.includes('keyword')
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyGlobalScope(): RetrievalScopeResolved {
  return { scopeType: 'global', uris: [], sourcePaths: [], itemKeys: [] };
}

/**
 * Normalize a raw provider score to the [0,1] range.
 *
 * Both semantic (cosine similarity) and keyword scores may exceed [0,1] in
 * some implementations. Clamp to ensure the fusion formula is consistent.
 * If no score is provided, fall back to a default of 0.5.
 */
function normalizeScore(score: number | null | undefined): number {
  if (score == null) return 0.5;
  return Math.max(0, Math.min(1, score));
}
