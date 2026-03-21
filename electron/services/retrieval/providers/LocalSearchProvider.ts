/**
 * LocalSearchProvider
 *
 * Wraps the existing FileService.searchFiles() local workspace search and
 * normalizes results into the canonical NormalizedSearchResult shape expected
 * by RetrievalOrchestrator.
 *
 * - providerId: 'local'
 * - supportedModes: ['keyword']
 * - Stable itemKey: 'local:<relPath>'
 * - Maps FileService result fields → NormalizedSearchResult
 * - Fails gracefully — never throws; errors returned as SearchProviderResult.error
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import type { FileService } from '../../FileService';
import type {
  SearchProvider,
  SearchProviderResult,
  NormalizedSearchResult,
  RetrievalScopeResolved,
  RetrievalProviderOptions,
  RetrievalMode,
} from '../../../../shared/retrieval/retrievalTypes';

export class LocalSearchProvider implements SearchProvider {
  readonly id = 'local';
  readonly supportedModes: RetrievalMode[] = ['keyword'];

  constructor(private readonly fileService: FileService) {}

  async search(
    query: string,
    _scope: RetrievalScopeResolved,
    options: RetrievalProviderOptions,
  ): Promise<SearchProviderResult> {
    const startMs = Date.now();
    try {
      const rawResults = await this.fileService.searchFiles(query);

      const topK = options.topK;
      const limited = topK != null ? rawResults.slice(0, topK) : rawResults;

      const results: NormalizedSearchResult[] = limited.map(r => ({
        itemKey: `local:${r.path}`,
        title: r.path,
        uri: null,
        sourcePath: r.path,
        snippet: r.content ?? null,
        sourceType: 'local_file',
        providerId: 'local',
        externalId: null,
        contentHash: null,
        score: null,
        metadata: {},
      }));

      return {
        providerId: 'local',
        results,
        durationMs: Date.now() - startMs,
        error: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        providerId: 'local',
        results: [],
        durationMs: Date.now() - startMs,
        error: msg,
      };
    }
  }
}
