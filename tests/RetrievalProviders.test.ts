/**
 * RetrievalProviders.test.ts
 *
 * Unit tests for LocalSearchProvider and ExternalApiSearchProvider.
 *
 * Validates:
 *   1. LocalSearchProvider normalization — FileService results → NormalizedSearchResult
 *   2. ExternalApiSearchProvider normalization — per-type adapters (serper, brave, tavily, generic)
 *   3. Provider filtering via providerIds in RetrievalOrchestrator
 *   4. Mixed-provider retrieval merge / dedup
 *   5. Graceful failure handling — provider errors captured as warnings
 *   6. resolveActiveSearchProviderConfig helper
 *   7. ExternalApiSearchProvider with null / disabled config
 *
 * No real network or database connections are used.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalSearchProvider } from '../electron/services/retrieval/providers/LocalSearchProvider';
import {
  ExternalApiSearchProvider,
  resolveActiveSearchProviderConfig,
} from '../electron/services/retrieval/providers/ExternalApiSearchProvider';
import { RetrievalOrchestrator } from '../electron/services/retrieval/RetrievalOrchestrator';
import type {
  NormalizedSearchResult,
  RetrievalScopeResolved,
  RetrievalProviderOptions,
} from '../shared/retrieval/retrievalTypes';
import type { SearchProvider as SettingsSearchProvider } from '../shared/settings';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function globalScope(): RetrievalScopeResolved {
  return { scopeType: 'global', uris: [], sourcePaths: [], itemKeys: [] };
}

function defaultOptions(overrides?: Partial<RetrievalProviderOptions>): RetrievalProviderOptions {
  return { topK: undefined, minScore: undefined, filters: undefined, ...overrides };
}

function makeSettingsProvider(overrides: Partial<SettingsSearchProvider> = {}): SettingsSearchProvider {
  return {
    id: 'test-provider',
    name: 'Test Provider',
    type: 'custom',
    endpoint: 'https://example.com/search',
    apiKey: 'test-key',
    enabled: true,
    ...overrides,
  };
}

// ─── LocalSearchProvider ──────────────────────────────────────────────────────

describe('LocalSearchProvider', () => {
  function makeFileService(results: { path: string; content: string }[]) {
    return {
      searchFiles: vi.fn(async (_query: string) => results),
    } as unknown as import('../electron/services/FileService').FileService;
  }

  it('has id "local" and supports keyword mode', () => {
    const provider = new LocalSearchProvider(makeFileService([]));
    expect(provider.id).toBe('local');
    expect(provider.supportedModes).toContain('keyword');
  });

  it('normalizes FileService results into NormalizedSearchResult shape', async () => {
    const provider = new LocalSearchProvider(
      makeFileService([
        { path: 'src/foo.ts', content: 'function foo() {}' },
        { path: 'docs/bar.md', content: 'Some doc text' },
      ]),
    );
    const result = await provider.search('foo', globalScope(), defaultOptions());
    expect(result.providerId).toBe('local');
    expect(result.error).toBeNull();
    expect(result.results).toHaveLength(2);

    const first = result.results[0];
    expect(first.itemKey).toBe('local:src/foo.ts');
    expect(first.title).toBe('src/foo.ts');
    expect(first.sourcePath).toBe('src/foo.ts');
    expect(first.snippet).toBe('function foo() {}');
    expect(first.uri).toBeNull();
    expect(first.providerId).toBe('local');
    expect(first.sourceType).toBe('local_file');
  });

  it('generates stable itemKey from path', async () => {
    const provider = new LocalSearchProvider(
      makeFileService([{ path: 'electron/main.ts', content: 'test' }]),
    );
    const result = await provider.search('test', globalScope(), defaultOptions());
    expect(result.results[0].itemKey).toBe('local:electron/main.ts');
  });

  it('respects topK option', async () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      path: `file${i}.ts`,
      content: `content ${i}`,
    }));
    const provider = new LocalSearchProvider(makeFileService(files));
    const result = await provider.search('content', globalScope(), defaultOptions({ topK: 3 }));
    expect(result.results).toHaveLength(3);
  });

  it('returns empty results when FileService returns empty array', async () => {
    const provider = new LocalSearchProvider(makeFileService([]));
    const result = await provider.search('nothing', globalScope(), defaultOptions());
    expect(result.results).toEqual([]);
    expect(result.error).toBeNull();
  });

  it('returns error (not throws) when FileService throws', async () => {
    const fileService = {
      searchFiles: vi.fn(async () => { throw new Error('FS unavailable'); }),
    } as unknown as import('../electron/services/FileService').FileService;
    const provider = new LocalSearchProvider(fileService);
    const result = await provider.search('test', globalScope(), defaultOptions());
    expect(result.error).toMatch(/FS unavailable/);
    expect(result.results).toEqual([]);
  });
});

// ─── ExternalApiSearchProvider ────────────────────────────────────────────────

describe('ExternalApiSearchProvider', () => {
  it('has id "external:<configId>" when config is provided', () => {
    const provider = new ExternalApiSearchProvider(makeSettingsProvider({ id: 'brave-main' }));
    expect(provider.id).toBe('external:brave-main');
  });

  it('has id "external:unconfigured" when config is null', () => {
    const provider = new ExternalApiSearchProvider(null);
    expect(provider.id).toBe('external:unconfigured');
  });

  it('supports keyword mode', () => {
    const provider = new ExternalApiSearchProvider(null);
    expect(provider.supportedModes).toContain('keyword');
  });

  it('returns error result when config is null', async () => {
    const provider = new ExternalApiSearchProvider(null);
    const result = await provider.search('test', globalScope(), defaultOptions());
    expect(result.error).toMatch(/no search provider configured/);
    expect(result.results).toEqual([]);
  });

  it('returns error result when provider is disabled', async () => {
    const provider = new ExternalApiSearchProvider(makeSettingsProvider({ enabled: false }));
    const result = await provider.search('test', globalScope(), defaultOptions());
    expect(result.error).toMatch(/disabled/);
    expect(result.results).toEqual([]);
  });

  it('refreshFromSettings updates the provider id and config', () => {
    const provider = new ExternalApiSearchProvider(makeSettingsProvider({ id: 'old-id' }));
    expect(provider.id).toBe('external:old-id');
    provider.refreshFromSettings(makeSettingsProvider({ id: 'new-id' }));
    expect(provider.id).toBe('external:new-id');
    provider.refreshFromSettings(null);
    expect(provider.id).toBe('external:unconfigured');
  });

  describe('result normalization (via mocked HTTP)', () => {
    /**
     * We cannot make real HTTP calls in tests. Instead we mock the provider's
     * internal _executeSearch via a subclass override or monkey-patch approach.
     * We test the normalizeToResult step by patching the private method.
     */

    it('normalizes serper-style response into NormalizedSearchResult', async () => {
      const provider = new ExternalApiSearchProvider(
        makeSettingsProvider({ id: 'serper1', type: 'serper' }),
      );
      // Patch internal method to return pre-parsed data
      (provider as any)._executeSearch = vi.fn(async () => [
        { title: 'Result 1', uri: 'https://r1.com', snippet: 'Snippet 1', externalId: '1', metadata: { source: 'serper' } },
        { title: 'Result 2', uri: 'https://r2.com', snippet: null, externalId: '2', metadata: { source: 'serper' } },
      ]);

      const result = await provider.search('test', globalScope(), defaultOptions());
      expect(result.error).toBeNull();
      expect(result.results).toHaveLength(2);

      const first = result.results[0];
      expect(first.itemKey).toBe('external:serper1:https://r1.com');
      expect(first.title).toBe('Result 1');
      expect(first.uri).toBe('https://r1.com');
      expect(first.snippet).toBe('Snippet 1');
      expect(first.providerId).toBe('external:serper1');
      expect(first.sourceType).toBe('web');
      expect(first.metadata?.providerType).toBe('serper');
    });

    it('respects topK option', async () => {
      const provider = new ExternalApiSearchProvider(makeSettingsProvider({ id: 'p1', type: 'brave' }));
      (provider as any)._executeSearch = vi.fn(async () =>
        Array.from({ length: 10 }, (_, i) => ({
          title: `R${i}`, uri: `https://r${i}.com`, snippet: null, externalId: String(i), metadata: {},
        })),
      );
      const result = await provider.search('q', globalScope(), defaultOptions({ topK: 4 }));
      expect(result.results).toHaveLength(4);
    });

    it('returns graceful error result when _executeSearch throws', async () => {
      const provider = new ExternalApiSearchProvider(makeSettingsProvider({ id: 'p1' }));
      (provider as any)._executeSearch = vi.fn(async () => {
        throw new Error('Network timeout');
      });
      const result = await provider.search('q', globalScope(), defaultOptions());
      expect(result.error).toMatch(/Network timeout/);
      expect(result.results).toEqual([]);
    });

    it('preserves metadata fields (providerType, providerName, endpoint)', async () => {
      const cfg = makeSettingsProvider({ id: 'p1', type: 'tavily', name: 'Tavily', endpoint: 'https://api.tavily.com/search' });
      const provider = new ExternalApiSearchProvider(cfg);
      (provider as any)._executeSearch = vi.fn(async () => [
        { title: 'T1', uri: 'https://t.com', snippet: 'S', externalId: '1', metadata: { source: 'tavily' } },
      ]);
      const result = await provider.search('q', globalScope(), defaultOptions());
      const meta = result.results[0].metadata;
      expect(meta?.providerType).toBe('tavily');
      expect(meta?.providerName).toBe('Tavily');
      expect(meta?.endpoint).toBe('https://api.tavily.com/search');
    });
  });
});

// ─── resolveActiveSearchProviderConfig ───────────────────────────────────────

describe('resolveActiveSearchProviderConfig', () => {
  it('returns null when config is undefined', () => {
    expect(resolveActiveSearchProviderConfig(undefined)).toBeNull();
  });

  it('returns null when providers array is empty', () => {
    expect(resolveActiveSearchProviderConfig({ activeProviderId: 'x', providers: [] })).toBeNull();
  });

  it('returns null when active provider is disabled', () => {
    const cfg = {
      activeProviderId: 'p1',
      providers: [{ id: 'p1', name: 'P1', type: 'brave' as const, enabled: false }],
    };
    expect(resolveActiveSearchProviderConfig(cfg)).toBeNull();
  });

  it('returns null when activeProviderId does not match any provider', () => {
    const cfg = {
      activeProviderId: 'missing',
      providers: [{ id: 'p1', name: 'P1', type: 'brave' as const, enabled: true }],
    };
    expect(resolveActiveSearchProviderConfig(cfg)).toBeNull();
  });

  it('returns the active enabled provider', () => {
    const cfg = {
      activeProviderId: 'brave1',
      providers: [
        { id: 'brave1', name: 'Brave', type: 'brave' as const, enabled: true, apiKey: 'key' },
        { id: 'other', name: 'Other', type: 'custom' as const, enabled: true },
      ],
    };
    const result = resolveActiveSearchProviderConfig(cfg);
    expect(result?.id).toBe('brave1');
  });
});

// ─── Provider filtering via providerIds ───────────────────────────────────────

describe('RetrievalOrchestrator with LocalSearchProvider and ExternalApiSearchProvider', () => {
  function makeLocalProvider(results: NormalizedSearchResult[]) {
    const fileService = {
      searchFiles: vi.fn(async () =>
        results.map(r => ({ path: r.sourcePath ?? r.title, content: r.snippet ?? '' })),
      ),
    } as unknown as import('../electron/services/FileService').FileService;
    return new LocalSearchProvider(fileService);
  }

  function makeExternalProvider(
    id: string,
    rawResults: Array<{ title: string; uri: string; snippet: string }>,
  ) {
    const provider = new ExternalApiSearchProvider(makeSettingsProvider({ id, type: 'custom' }));
    (provider as any)._executeSearch = vi.fn(async () =>
      rawResults.map((r, i) => ({
        title: r.title,
        uri: r.uri,
        snippet: r.snippet,
        externalId: String(i),
        metadata: {},
      })),
    );
    return provider;
  }

  it('routes local-only requests to local provider when providerIds=["local"]', async () => {
    const orchestrator = new RetrievalOrchestrator();
    const localProvider = makeLocalProvider([
      { itemKey: 'local:a.ts', title: 'a.ts', providerId: 'local', sourcePath: 'a.ts', snippet: 'local content' } as NormalizedSearchResult,
    ]);
    const extProvider = makeExternalProvider('ext1', [{ title: 'Web result', uri: 'https://web.com', snippet: 'web content' }]);

    orchestrator.registerProvider(localProvider);
    orchestrator.registerProvider(extProvider);

    const response = await orchestrator.retrieve({
      query: 'test',
      mode: 'keyword',
      scope: 'global',
      providerIds: ['local'],
    });

    expect(response.results.every(r => r.providerId === 'local')).toBe(true);
    expect(localProvider['fileService'].searchFiles).toHaveBeenCalled();
    expect((extProvider as any)._executeSearch).not.toHaveBeenCalled();
  });

  it('uses all keyword providers when providerIds is omitted', async () => {
    const orchestrator = new RetrievalOrchestrator();
    const localProvider = makeLocalProvider([
      { itemKey: 'local:a.ts', title: 'a.ts', providerId: 'local', sourcePath: 'a.ts' } as NormalizedSearchResult,
    ]);
    const extProvider = makeExternalProvider('ext1', [
      { title: 'Web result', uri: 'https://web.com', snippet: 'snippet' },
    ]);

    orchestrator.registerProvider(localProvider);
    orchestrator.registerProvider(extProvider);

    const response = await orchestrator.retrieve({
      query: 'test',
      mode: 'keyword',
      scope: 'global',
    });

    const ids = response.results.map(r => r.providerId);
    expect(ids).toContain('local');
    expect(ids.some(id => id.startsWith('external:'))).toBe(true);
  });

  it('deduplicates results with matching itemKey across providers', async () => {
    const orchestrator = new RetrievalOrchestrator();

    // Both providers return a result with the same itemKey
    const sharedItemKey = 'shared-key';
    const p1 = {
      id: 'p1',
      supportedModes: ['keyword' as const],
      search: vi.fn(async () => ({
        providerId: 'p1',
        results: [{ itemKey: sharedItemKey, title: 'From P1', providerId: 'p1' } as NormalizedSearchResult],
        durationMs: 1,
        error: null,
      })),
    };
    const p2 = {
      id: 'p2',
      supportedModes: ['keyword' as const],
      search: vi.fn(async () => ({
        providerId: 'p2',
        results: [{ itemKey: sharedItemKey, title: 'From P2', providerId: 'p2' } as NormalizedSearchResult],
        durationMs: 1,
        error: null,
      })),
    };
    orchestrator.registerProvider(p1);
    orchestrator.registerProvider(p2);

    const response = await orchestrator.retrieve({ query: 'q', mode: 'keyword', scope: 'global' });
    const byKey = response.results.filter(r => r.itemKey === sharedItemKey);
    // Only one copy should remain (first occurrence wins)
    expect(byKey).toHaveLength(1);
    expect(response.totalResults).toBe(1);
  });

  it('captures external provider failure as warning and returns partial results', async () => {
    const orchestrator = new RetrievalOrchestrator();
    const localProvider = makeLocalProvider([
      { itemKey: 'local:ok.ts', title: 'ok.ts', providerId: 'local', sourcePath: 'ok.ts' } as NormalizedSearchResult,
    ]);
    const failingExtProvider = new ExternalApiSearchProvider(makeSettingsProvider({ id: 'fail-ext' }));
    (failingExtProvider as any)._executeSearch = vi.fn(async () => {
      throw new Error('External API down');
    });

    orchestrator.registerProvider(localProvider);
    orchestrator.registerProvider(failingExtProvider);

    const response = await orchestrator.retrieve({ query: 'q', mode: 'keyword', scope: 'global' });

    // Local results still present
    expect(response.results.some(r => r.providerId === 'local')).toBe(true);
    // External provider result has an error captured (not a thrown exception —
    // ExternalApiSearchProvider.search() catches internally and returns error field)
    const extResult = response.providerResults.find(pr => pr.providerId === 'external:fail-ext');
    expect(extResult).toBeDefined();
    expect(extResult?.error).toMatch(/External API down/);
    expect(extResult?.results).toEqual([]);
  });

  it('returns empty results gracefully when all providers fail', async () => {
    const orchestrator = new RetrievalOrchestrator();
    const failing = {
      id: 'fail',
      supportedModes: ['keyword' as const],
      search: vi.fn(async () => { throw new Error('Total failure'); }),
    };
    orchestrator.registerProvider(failing);

    const response = await orchestrator.retrieve({ query: 'q', mode: 'keyword', scope: 'global' });
    expect(response.results).toEqual([]);
    expect(response.warnings).toBeDefined();
    expect(response.warnings!.some(w => w.includes('Total failure'))).toBe(true);
  });
});
