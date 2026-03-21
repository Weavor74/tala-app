/**
 * RetrievalOrchestrator.test.ts
 *
 * Unit tests for the canonical retrieval orchestration layer.
 *
 * Validates:
 *   1. Type contracts — all public types are importable and structurally correct.
 *   2. Scope resolution — global, notebook-scoped, explicit_sources, degraded paths.
 *   3. Provider registration — register, list, unregister.
 *   4. Provider selection — mode filtering, providerIds filtering.
 *   5. Result merging — deduplication by itemKey, score sort, topK cap.
 *   6. Provider error handling — non-fatal, captured as warning in response.
 *   7. No-provider path — returns empty results gracefully.
 *   8. Parallel execution — all providers called concurrently.
 *
 * No real database connections are used. ResearchRepository and SearchProvider
 * are injected as mocks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  RetrievalRequest,
  RetrievalResponse,
  RetrievalScopeResolved,
  SearchProvider,
  SearchProviderResult,
  NormalizedSearchResult,
  RetrievalProviderOptions,
} from '../shared/retrieval/retrievalTypes';
import { RetrievalOrchestrator } from '../electron/services/retrieval/RetrievalOrchestrator';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeResult(
  overrides: Partial<NormalizedSearchResult> & { itemKey: string; title: string; providerId: string },
): NormalizedSearchResult {
  return {
    uri: null,
    sourcePath: null,
    snippet: null,
    sourceType: null,
    externalId: null,
    contentHash: null,
    score: null,
    metadata: {},
    ...overrides,
  };
}

function makeProvider(
  id: string,
  modes: import('../shared/retrieval/retrievalTypes').RetrievalMode[],
  results: NormalizedSearchResult[] = [],
  errorMsg?: string,
): SearchProvider {
  return {
    id,
    supportedModes: modes,
    search: vi.fn(
      async (
        _query: string,
        _scope: RetrievalScopeResolved,
        _opts: RetrievalProviderOptions,
      ): Promise<SearchProviderResult> => {
        if (errorMsg) throw new Error(errorMsg);
        return {
          providerId: id,
          results,
          durationMs: 1,
          error: null,
        };
      },
    ),
  };
}

function makeNotebookRepo(overrides?: {
  uris?: string[];
  sourcePaths?: string[];
  itemKeys?: string[];
  shouldThrow?: boolean;
}) {
  return {
    resolveNotebookScope: vi.fn(async (_id: string) => {
      if (overrides?.shouldThrow) throw new Error('DB connection lost');
      return {
        uris: overrides?.uris ?? ['https://example.com/doc1'],
        sourcePaths: overrides?.sourcePaths ?? ['/workspace/docs/doc1.md'],
        itemKeys: overrides?.itemKeys ?? ['key:doc1'],
      };
    }),
  } as unknown as import('../electron/services/db/ResearchRepository').ResearchRepository;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RetrievalOrchestrator', () => {
  let orchestrator: RetrievalOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new RetrievalOrchestrator();
  });

  // ── Type contracts ──────────────────────────────────────────────────────────

  describe('retrievalTypes — shape validation', () => {
    it('NormalizedSearchResult has required fields itemKey, title, providerId', () => {
      const r: NormalizedSearchResult = makeResult({
        itemKey: 'k1',
        title: 'Hello',
        providerId: 'test',
      });
      expect(r.itemKey).toBe('k1');
      expect(r.title).toBe('Hello');
      expect(r.providerId).toBe('test');
    });

    it('RetrievalRequest accepts all scope types', () => {
      const global: RetrievalRequest = { query: 'q', mode: 'keyword', scope: 'global' };
      const notebook: RetrievalRequest = { query: 'q', mode: 'semantic', scope: 'notebook', notebookId: 'nb-1' };
      const explicit: RetrievalRequest = { query: 'q', mode: 'hybrid', scope: 'explicit_sources', explicitSources: ['https://x.com'] };
      expect(global.scope).toBe('global');
      expect(notebook.scope).toBe('notebook');
      expect(explicit.scope).toBe('explicit_sources');
    });

    it('RetrievalMode covers all four strategies', () => {
      const modes: import('../shared/retrieval/retrievalTypes').RetrievalMode[] = [
        'keyword', 'semantic', 'hybrid', 'graph',
      ];
      expect(modes).toHaveLength(4);
    });
  });

  // ── Provider registration ───────────────────────────────────────────────────

  describe('registerProvider / listProviders / unregisterProvider', () => {
    it('registers a provider and makes it visible via listProviders()', () => {
      const p = makeProvider('kw', ['keyword']);
      orchestrator.registerProvider(p);
      expect(orchestrator.listProviders()).toHaveLength(1);
      expect(orchestrator.listProviders()[0].id).toBe('kw');
    });

    it('replacing an existing provider ID overwrites the previous registration', () => {
      orchestrator.registerProvider(makeProvider('kw', ['keyword']));
      const updated = makeProvider('kw', ['keyword', 'hybrid']);
      orchestrator.registerProvider(updated);
      expect(orchestrator.listProviders()).toHaveLength(1);
      expect(orchestrator.listProviders()[0].supportedModes).toContain('hybrid');
    });

    it('unregisterProvider returns true and removes the provider', () => {
      orchestrator.registerProvider(makeProvider('kw', ['keyword']));
      const removed = orchestrator.unregisterProvider('kw');
      expect(removed).toBe(true);
      expect(orchestrator.listProviders()).toHaveLength(0);
    });

    it('unregisterProvider returns false for unknown ID', () => {
      expect(orchestrator.unregisterProvider('nope')).toBe(false);
    });
  });

  // ── Global scope retrieval ──────────────────────────────────────────────────

  describe('global scope', () => {
    it('returns a global scope with empty boundaries', async () => {
      const res: RetrievalResponse = await orchestrator.retrieve({
        query: 'coffee',
        mode: 'keyword',
        scope: 'global',
      });
      expect(res.scopeResolved.scopeType).toBe('global');
      expect(res.scopeResolved.uris).toEqual([]);
      expect(res.scopeResolved.sourcePaths).toEqual([]);
      expect(res.scopeResolved.itemKeys).toEqual([]);
    });

    it('returns empty results when no providers are registered', async () => {
      const res = await orchestrator.retrieve({ query: 'hello', mode: 'keyword', scope: 'global' });
      expect(res.results).toEqual([]);
      expect(res.totalResults).toBe(0);
      expect(res.providerResults).toEqual([]);
    });
  });

  // ── Notebook scope resolution ──────────────────────────────────────────────

  describe('notebook scope', () => {
    it('resolves notebook scope from ResearchRepository', async () => {
      const repo = makeNotebookRepo({
        uris: ['https://example.com/a'],
        sourcePaths: ['/ws/a.md'],
        itemKeys: ['item:a'],
      });
      const orch = new RetrievalOrchestrator(repo);
      const res = await orch.retrieve({
        query: 'test',
        mode: 'keyword',
        scope: 'notebook',
        notebookId: 'nb-123',
      });
      expect(res.scopeResolved.scopeType).toBe('notebook');
      expect(res.scopeResolved.notebookId).toBe('nb-123');
      expect(res.scopeResolved.uris).toEqual(['https://example.com/a']);
      expect(res.scopeResolved.sourcePaths).toEqual(['/ws/a.md']);
      expect(res.scopeResolved.itemKeys).toEqual(['item:a']);
      expect(repo.resolveNotebookScope).toHaveBeenCalledWith('nb-123');
    });

    it('falls back to global scope when notebookId is missing', async () => {
      const res = await orchestrator.retrieve({
        query: 'test',
        mode: 'keyword',
        scope: 'notebook',
        // notebookId intentionally omitted
      });
      expect(res.scopeResolved.scopeType).toBe('global');
      expect(res.warnings).toBeDefined();
      expect(res.warnings![0]).toMatch(/notebookId was not provided/);
    });

    it('falls back to global scope when no ResearchRepository is configured', async () => {
      // orchestrator has no repo
      const res = await orchestrator.retrieve({
        query: 'test',
        mode: 'keyword',
        scope: 'notebook',
        notebookId: 'nb-999',
      });
      expect(res.scopeResolved.scopeType).toBe('global');
      expect(res.warnings).toBeDefined();
      expect(res.warnings![0]).toMatch(/no ResearchRepository is configured/);
    });

    it('falls back to global scope and emits warning when ResearchRepository throws', async () => {
      const repo = makeNotebookRepo({ shouldThrow: true });
      const orch = new RetrievalOrchestrator(repo);
      const res = await orch.retrieve({
        query: 'test',
        mode: 'keyword',
        scope: 'notebook',
        notebookId: 'nb-bad',
      });
      expect(res.scopeResolved.scopeType).toBe('global');
      expect(res.warnings).toBeDefined();
      expect(res.warnings!.some(w => w.includes('DB connection lost'))).toBe(true);
    });
  });

  // ── Explicit sources scope ─────────────────────────────────────────────────

  describe('explicit_sources scope', () => {
    it('resolves to the provided URIs', async () => {
      const res = await orchestrator.retrieve({
        query: 'search',
        mode: 'keyword',
        scope: 'explicit_sources',
        explicitSources: ['https://a.com', 'https://b.com'],
      });
      expect(res.scopeResolved.scopeType).toBe('explicit_sources');
      expect(res.scopeResolved.uris).toEqual(['https://a.com', 'https://b.com']);
      expect(res.scopeResolved.sourcePaths).toEqual([]);
      expect(res.scopeResolved.itemKeys).toEqual([]);
    });

    it('treats undefined explicitSources as empty array', async () => {
      const res = await orchestrator.retrieve({
        query: 'search',
        mode: 'keyword',
        scope: 'explicit_sources',
        // explicitSources intentionally omitted
      });
      expect(res.scopeResolved.uris).toEqual([]);
    });
  });

  // ── Provider mode selection ────────────────────────────────────────────────

  describe('provider selection by mode', () => {
    it('calls only providers whose supportedModes include the request mode', async () => {
      const kw = makeProvider('kw', ['keyword']);
      const sem = makeProvider('sem', ['semantic']);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(sem);

      await orchestrator.retrieve({ query: 'q', mode: 'keyword', scope: 'global' });

      expect(kw.search).toHaveBeenCalledTimes(1);
      expect(sem.search).not.toHaveBeenCalled();
    });

    it('calls both providers for hybrid mode when both support it', async () => {
      const kw = makeProvider('kw', ['keyword', 'hybrid']);
      const sem = makeProvider('sem', ['semantic', 'hybrid']);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(sem);

      await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      expect(kw.search).toHaveBeenCalledTimes(1);
      expect(sem.search).toHaveBeenCalledTimes(1);
    });

    it('restricts to providerIds when specified', async () => {
      const kw = makeProvider('kw', ['keyword']);
      const kw2 = makeProvider('kw2', ['keyword']);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(kw2);

      await orchestrator.retrieve({
        query: 'q',
        mode: 'keyword',
        scope: 'global',
        providerIds: ['kw'],
      });

      expect(kw.search).toHaveBeenCalledTimes(1);
      expect(kw2.search).not.toHaveBeenCalled();
    });

    it('skips providers not supporting the requested mode even if in providerIds', async () => {
      const sem = makeProvider('sem', ['semantic']);
      orchestrator.registerProvider(sem);

      await orchestrator.retrieve({
        query: 'q',
        mode: 'keyword',
        scope: 'global',
        providerIds: ['sem'],
      });

      expect(sem.search).not.toHaveBeenCalled();
    });
  });

  // ── Result merging ─────────────────────────────────────────────────────────

  describe('result merging — deduplication, sort, topK', () => {
    it('merges results from multiple providers into a flat array', async () => {
      orchestrator.registerProvider(
        makeProvider('p1', ['keyword'], [
          makeResult({ itemKey: 'k1', title: 'R1', providerId: 'p1', score: 0.9 }),
        ]),
      );
      orchestrator.registerProvider(
        makeProvider('p2', ['keyword'], [
          makeResult({ itemKey: 'k2', title: 'R2', providerId: 'p2', score: 0.7 }),
        ]),
      );

      const res = await orchestrator.retrieve({ query: 'q', mode: 'keyword', scope: 'global' });
      expect(res.results).toHaveLength(2);
    });

    it('deduplicates results with the same itemKey (first occurrence wins)', async () => {
      orchestrator.registerProvider(
        makeProvider('p1', ['keyword'], [
          makeResult({ itemKey: 'dup', title: 'From P1', providerId: 'p1', score: 0.8 }),
        ]),
      );
      orchestrator.registerProvider(
        makeProvider('p2', ['keyword'], [
          makeResult({ itemKey: 'dup', title: 'From P2', providerId: 'p2', score: 0.6 }),
        ]),
      );

      const res = await orchestrator.retrieve({ query: 'q', mode: 'keyword', scope: 'global' });
      expect(res.results).toHaveLength(1);
      expect(res.results[0].title).toBe('From P1');
    });

    it('sorts merged results by score descending', async () => {
      orchestrator.registerProvider(
        makeProvider('p1', ['keyword'], [
          makeResult({ itemKey: 'low', title: 'Low', providerId: 'p1', score: 0.3 }),
          makeResult({ itemKey: 'high', title: 'High', providerId: 'p1', score: 0.95 }),
          makeResult({ itemKey: 'mid', title: 'Mid', providerId: 'p1', score: 0.6 }),
        ]),
      );

      const res = await orchestrator.retrieve({ query: 'q', mode: 'keyword', scope: 'global' });
      expect(res.results[0].itemKey).toBe('high');
      expect(res.results[1].itemKey).toBe('mid');
      expect(res.results[2].itemKey).toBe('low');
    });

    it('places null-score results after scored results', async () => {
      orchestrator.registerProvider(
        makeProvider('p1', ['keyword'], [
          makeResult({ itemKey: 'noscr', title: 'No Score', providerId: 'p1', score: null }),
          makeResult({ itemKey: 'scored', title: 'Scored', providerId: 'p1', score: 0.5 }),
        ]),
      );

      const res = await orchestrator.retrieve({ query: 'q', mode: 'keyword', scope: 'global' });
      expect(res.results[0].itemKey).toBe('scored');
      expect(res.results[1].itemKey).toBe('noscr');
    });

    it('caps results at topK', async () => {
      orchestrator.registerProvider(
        makeProvider('p1', ['keyword'], [
          makeResult({ itemKey: 'a', title: 'A', providerId: 'p1', score: 0.9 }),
          makeResult({ itemKey: 'b', title: 'B', providerId: 'p1', score: 0.8 }),
          makeResult({ itemKey: 'c', title: 'C', providerId: 'p1', score: 0.7 }),
          makeResult({ itemKey: 'd', title: 'D', providerId: 'p1', score: 0.6 }),
        ]),
      );

      const res = await orchestrator.retrieve({
        query: 'q',
        mode: 'keyword',
        scope: 'global',
        topK: 2,
      });
      expect(res.results).toHaveLength(2);
      expect(res.totalResults).toBe(2);
      expect(res.results[0].itemKey).toBe('a');
      expect(res.results[1].itemKey).toBe('b');
    });
  });

  // ── Provider error handling ────────────────────────────────────────────────

  describe('provider error handling', () => {
    it('captures provider throw as a non-fatal warning and returns empty results for that provider', async () => {
      const failing = makeProvider('bad', ['keyword'], [], 'upstream timeout');
      const good = makeProvider('good', ['keyword'], [
        makeResult({ itemKey: 'g1', title: 'Good', providerId: 'good', score: 0.8 }),
      ]);
      orchestrator.registerProvider(failing);
      orchestrator.registerProvider(good);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'keyword', scope: 'global' });

      // Response is still usable — good provider results come through
      expect(res.results).toHaveLength(1);
      expect(res.results[0].itemKey).toBe('g1');
      expect(res.warnings).toBeDefined();
      expect(res.warnings!.some(w => w.includes('upstream timeout'))).toBe(true);

      // Failing provider entry preserved in providerResults
      const badEntry = res.providerResults.find(p => p.providerId === 'bad');
      expect(badEntry).toBeDefined();
      expect(badEntry!.error).toMatch(/upstream timeout/);
      expect(badEntry!.results).toEqual([]);
    });

    it('returns no warnings when all providers succeed', async () => {
      orchestrator.registerProvider(
        makeProvider('p1', ['keyword'], [
          makeResult({ itemKey: 'r1', title: 'R1', providerId: 'p1' }),
        ]),
      );

      const res = await orchestrator.retrieve({ query: 'q', mode: 'keyword', scope: 'global' });
      expect(res.warnings).toBeUndefined();
    });
  });

  // ── Response shape ─────────────────────────────────────────────────────────

  describe('response metadata', () => {
    it('echoes query and mode from the request', async () => {
      const res = await orchestrator.retrieve({ query: 'my query', mode: 'semantic', scope: 'global' });
      expect(res.query).toBe('my query');
      expect(res.mode).toBe('semantic');
    });

    it('reports durationMs as a non-negative number', async () => {
      const res = await orchestrator.retrieve({ query: 'q', mode: 'keyword', scope: 'global' });
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('includes per-provider results in providerResults', async () => {
      orchestrator.registerProvider(
        makeProvider('p1', ['keyword'], [
          makeResult({ itemKey: 'r1', title: 'R1', providerId: 'p1' }),
        ]),
      );

      const res = await orchestrator.retrieve({ query: 'q', mode: 'keyword', scope: 'global' });
      expect(res.providerResults).toHaveLength(1);
      expect(res.providerResults[0].providerId).toBe('p1');
    });
  });

  // ── Forward provider options ───────────────────────────────────────────────

  describe('provider option forwarding', () => {
    it('passes topK, minScore, and filters to the provider', async () => {
      const p = makeProvider('p1', ['keyword'], []);
      orchestrator.registerProvider(p);

      await orchestrator.retrieve({
        query: 'q',
        mode: 'keyword',
        scope: 'global',
        topK: 5,
        minScore: 0.4,
        filters: { lang: 'en' },
      });

      expect(p.search).toHaveBeenCalledWith(
        'q',
        expect.objectContaining({ scopeType: 'global' }),
        { topK: 5, minScore: 0.4, filters: { lang: 'en' } },
      );
    });
  });
});
