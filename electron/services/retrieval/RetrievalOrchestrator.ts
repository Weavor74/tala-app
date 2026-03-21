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
    const results = this.mergeResults(providerResults, request.topK);

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
   * Merge provider results, deduplicate by itemKey (first occurrence wins),
   * sort by score descending (nulls last), and cap at topK.
   */
  private mergeResults(
    providerResults: SearchProviderResult[],
    topK?: number,
  ): NormalizedSearchResult[] {
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
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyGlobalScope(): RetrievalScopeResolved {
  return { scopeType: 'global', uris: [], sourcePaths: [], itemKeys: [] };
}
