/**
 * HybridRetrieval.test.ts
 *
 * Tests for the hybrid retrieval mode implemented in RetrievalOrchestrator.
 *
 * Validates:
 *   1. Both keyword and semantic providers are called in hybrid mode.
 *   2. Semantic-only results appear with correct fusedScore.
 *   3. Keyword-only results appear with correct fusedScore.
 *   4. Duplicate results across providers are merged (by itemKey, URI, contentHash).
 *   5. fusedScore computation: semantic * 0.6 + keyword * 0.4.
 *   6. Notebook boost (+0.1) applied only in notebook scope.
 *   7. providerIds filtering still works in hybrid mode.
 *   8. topK limit respected after fusion.
 *   9. Citation / provenance metadata is preserved through hybrid merge.
 *  10. Keyword and semantic modes are unaffected by hybrid changes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  NormalizedSearchResult,
  RetrievalProviderOptions,
  RetrievalScopeResolved,
  SearchProvider,
  SearchProviderResult,
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
}) {
  return {
    resolveNotebookScope: vi.fn(async () => ({
      uris: overrides?.uris ?? ['https://example.com/doc1'],
      sourcePaths: overrides?.sourcePaths ?? ['/ws/doc1.md'],
      itemKeys: overrides?.itemKeys ?? ['key:doc1'],
    })),
  } as unknown as import('../electron/services/db/ResearchRepository').ResearchRepository;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Hybrid Retrieval', () => {
  let orchestrator: RetrievalOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new RetrievalOrchestrator();
  });

  // ── Provider invocation ────────────────────────────────────────────────────

  describe('provider invocation', () => {
    it('calls both keyword and semantic providers for hybrid mode', async () => {
      const kw = makeProvider('local', ['keyword', 'hybrid']);
      const sem = makeProvider('semantic', ['semantic', 'hybrid']);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(sem);

      await orchestrator.retrieve({ query: 'test', mode: 'hybrid', scope: 'global' });

      expect(kw.search).toHaveBeenCalledTimes(1);
      expect(sem.search).toHaveBeenCalledTimes(1);
    });

    it('treats a provider as semantic when it supports semantic but not keyword mode', async () => {
      // Provider has a non-standard ID but is still semantic by capabilities
      const altSem = makeProvider('pgvector_v2', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'alt:1', title: 'Alt Semantic', providerId: 'pgvector_v2', score: 0.8 }),
      ]);
      orchestrator.registerProvider(altSem);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      expect(res.results).toHaveLength(1);
      // Should be classified as semantic → semanticScore 0.8, fusedScore = 0.6 * 0.8 = 0.48
      expect(res.results[0].metadata?.semanticScore).toBeCloseTo(0.8);
      expect(res.results[0].metadata?.keywordScore).toBe(0);
      expect(res.results[0].score).toBeCloseTo(0.48);
    });

    it('does not call keyword-only provider for semantic mode', async () => {
      const kw = makeProvider('local', ['keyword', 'hybrid']);
      const sem = makeProvider('semantic', ['semantic', 'hybrid']);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(sem);

      await orchestrator.retrieve({ query: 'test', mode: 'semantic', scope: 'global' });

      expect(kw.search).not.toHaveBeenCalled();
      expect(sem.search).toHaveBeenCalledTimes(1);
    });

    it('does not call semantic provider for keyword mode', async () => {
      const kw = makeProvider('local', ['keyword', 'hybrid']);
      const sem = makeProvider('semantic', ['semantic', 'hybrid']);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(sem);

      await orchestrator.retrieve({ query: 'test', mode: 'keyword', scope: 'global' });

      expect(kw.search).toHaveBeenCalledTimes(1);
      expect(sem.search).not.toHaveBeenCalled();
    });

    it('returns empty results gracefully when no providers support hybrid', async () => {
      const kw = makeProvider('local', ['keyword']);
      orchestrator.registerProvider(kw);

      const res = await orchestrator.retrieve({ query: 'test', mode: 'hybrid', scope: 'global' });

      expect(res.results).toHaveLength(0);
      expect(kw.search).not.toHaveBeenCalled();
    });
  });

  // ── Semantic-only results ─────────────────────────────────────────────────

  describe('semantic-only results', () => {
    it('produces fusedScore = semanticWeight * semanticScore for semantic-only results', async () => {
      // SEMANTIC_WEIGHT = 0.6
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'sem:1', title: 'Semantic Doc', providerId: 'semantic', score: 0.8 }),
      ]);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      expect(res.results).toHaveLength(1);
      const r = res.results[0];
      // fusedScore = 0.6 * 0.8 + 0.4 * 0 = 0.48
      expect(r.score).toBeCloseTo(0.48);
      expect(r.metadata?.semanticScore).toBeCloseTo(0.8);
      expect(r.metadata?.keywordScore).toBe(0);
      expect(r.metadata?.fusedScore).toBeCloseTo(0.48);
    });

    it('preserves semantic result metadata (provenance fields)', async () => {
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({
          itemKey: 'sem:doc',
          title: 'Doc',
          providerId: 'semantic',
          score: 0.9,
          uri: 'https://example.com/doc',
          contentHash: 'sha256:abc',
          metadata: {
            chunkId: 'chunk-1',
            citationLabel: 'Doc (2024)',
            similarity: 0.9,
          },
        }),
      ]);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      expect(res.results).toHaveLength(1);
      const r = res.results[0];
      // Provenance fields from original metadata must be preserved
      expect(r.metadata?.chunkId).toBe('chunk-1');
      expect(r.metadata?.citationLabel).toBe('Doc (2024)');
      expect(r.metadata?.similarity).toBe(0.9);
      // Hybrid fusion fields added
      expect(r.metadata?.fusedScore).toBeDefined();
      expect(r.metadata?.sourceProviders).toEqual(['semantic']);
    });
  });

  // ── Keyword-only results ───────────────────────────────────────────────────

  describe('keyword-only results', () => {
    it('produces fusedScore = keywordWeight * keywordScore for keyword-only results', async () => {
      // KEYWORD_WEIGHT = 0.4
      const kw = makeProvider('local', ['keyword', 'hybrid'], [
        makeResult({ itemKey: 'local:doc.md', title: 'local:doc.md', providerId: 'local', score: 0.7 }),
      ]);
      orchestrator.registerProvider(kw);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      expect(res.results).toHaveLength(1);
      const r = res.results[0];
      // fusedScore = 0.6 * 0 + 0.4 * 0.7 = 0.28
      expect(r.score).toBeCloseTo(0.28);
      expect(r.metadata?.semanticScore).toBe(0);
      expect(r.metadata?.keywordScore).toBeCloseTo(0.7);
      expect(r.metadata?.fusedScore).toBeCloseTo(0.28);
    });

    it('assigns default score 0.5 to keyword result with null score', async () => {
      const kw = makeProvider('local', ['keyword', 'hybrid'], [
        makeResult({ itemKey: 'local:no-score', title: 'No Score', providerId: 'local', score: null }),
      ]);
      orchestrator.registerProvider(kw);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      expect(res.results).toHaveLength(1);
      // Default score: 0.5, fusedScore = 0.6 * 0 + 0.4 * 0.5 = 0.2
      expect(res.results[0].metadata?.keywordScore).toBeCloseTo(0.5);
      expect(res.results[0].score).toBeCloseTo(0.2);
    });
  });

  // ── Duplicate merging ─────────────────────────────────────────────────────

  describe('duplicate merging', () => {
    it('merges duplicates with the same itemKey from semantic and keyword providers', async () => {
      const kw = makeProvider('local', ['keyword', 'hybrid'], [
        makeResult({ itemKey: 'shared:key', title: 'Keyword Title', providerId: 'local', score: 0.6 }),
      ]);
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'shared:key', title: 'Semantic Title', providerId: 'semantic', score: 0.8 }),
      ]);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      // Should merge into one result
      expect(res.results).toHaveLength(1);
      const r = res.results[0];
      // fusedScore = 0.6 * 0.8 + 0.4 * 0.6 = 0.48 + 0.24 = 0.72
      expect(r.score).toBeCloseTo(0.72);
      expect(r.metadata?.semanticScore).toBeCloseTo(0.8);
      expect(r.metadata?.keywordScore).toBeCloseTo(0.6);
    });

    it('merges duplicates with the same URI even when itemKeys differ', async () => {
      const sharedUri = 'https://example.com/document';
      const kw = makeProvider('local', ['keyword', 'hybrid'], [
        makeResult({ itemKey: 'local:doc', title: 'Local Title', providerId: 'local', score: 0.5, uri: sharedUri }),
      ]);
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'semantic:doc', title: 'Semantic Title', providerId: 'semantic', score: 0.9, uri: sharedUri }),
      ]);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      // Should merge into one result (URI-based dedup)
      expect(res.results).toHaveLength(1);
      const r = res.results[0];
      expect(r.metadata?.sourceProviders).toContain('local');
      expect(r.metadata?.sourceProviders).toContain('semantic');
    });

    it('merges duplicates with the same contentHash even when itemKeys differ', async () => {
      const hash = 'sha256:abc123';
      const kw = makeProvider('local', ['keyword', 'hybrid'], [
        makeResult({ itemKey: 'local:file', title: 'File', providerId: 'local', score: 0.4, contentHash: hash }),
      ]);
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'semantic:chunk', title: 'Chunk', providerId: 'semantic', score: 0.7, contentHash: hash }),
      ]);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      expect(res.results).toHaveLength(1);
      const r = res.results[0];
      expect(r.metadata?.semanticScore).toBeCloseTo(0.7);
      expect(r.metadata?.keywordScore).toBeCloseTo(0.4);
    });

    it('does NOT merge distinct documents into one result', async () => {
      const kw = makeProvider('local', ['keyword', 'hybrid'], [
        makeResult({ itemKey: 'local:a', title: 'Doc A', providerId: 'local', score: 0.5 }),
        makeResult({ itemKey: 'local:b', title: 'Doc B', providerId: 'local', score: 0.4 }),
      ]);
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'semantic:c', title: 'Doc C', providerId: 'semantic', score: 0.9 }),
      ]);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      expect(res.results).toHaveLength(3);
    });

    it('keeps sourceProviders list for merged result', async () => {
      const kw = makeProvider('local', ['keyword', 'hybrid'], [
        makeResult({ itemKey: 'key:1', title: 'Doc', providerId: 'local', score: 0.5 }),
      ]);
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'key:1', title: 'Doc', providerId: 'semantic', score: 0.8 }),
      ]);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      expect(res.results).toHaveLength(1);
      const providers = res.results[0].metadata?.sourceProviders as string[];
      expect(providers).toContain('local');
      expect(providers).toContain('semantic');
    });
  });

  // ── fusedScore computation ─────────────────────────────────────────────────

  describe('fusedScore computation', () => {
    it('computes correct fusedScore with both providers contributing', async () => {
      // semanticScore = 1.0, keywordScore = 1.0
      // fusedScore = 0.6 * 1.0 + 0.4 * 1.0 = 1.0
      const kw = makeProvider('local', ['keyword', 'hybrid'], [
        makeResult({ itemKey: 'k', title: 'K', providerId: 'local', score: 1.0 }),
      ]);
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'k', title: 'K', providerId: 'semantic', score: 1.0 }),
      ]);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      expect(res.results[0].score).toBeCloseTo(1.0);
    });

    it('clamps raw scores above 1 to 1 before fusion', async () => {
      // Keyword provider returns score > 1 (raw BM25-style); should be clamped
      const kw = makeProvider('local', ['keyword', 'hybrid'], [
        makeResult({ itemKey: 'doc', title: 'Doc', providerId: 'local', score: 3.5 }),
      ]);
      orchestrator.registerProvider(kw);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      // After clamping: 1.0. fusedScore = 0.4 * 1.0 = 0.4
      expect(res.results[0].score).toBeCloseTo(0.4);
      expect(res.results[0].metadata?.keywordScore).toBeCloseTo(1.0);
    });

    it('sorts results by fusedScore descending', async () => {
      const kw = makeProvider('local', ['keyword', 'hybrid'], [
        makeResult({ itemKey: 'low', title: 'Low', providerId: 'local', score: 0.2 }),
        makeResult({ itemKey: 'high', title: 'High', providerId: 'local', score: 0.9 }),
        makeResult({ itemKey: 'mid', title: 'Mid', providerId: 'local', score: 0.5 }),
      ]);
      orchestrator.registerProvider(kw);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      // Sorted by fusedScore = 0.4 * score
      expect(res.results[0].itemKey).toBe('high');
      expect(res.results[1].itemKey).toBe('mid');
      expect(res.results[2].itemKey).toBe('low');
    });
  });

  // ── Notebook boost ─────────────────────────────────────────────────────────

  describe('notebook boost', () => {
    it('applies notebook boost (+0.1) in notebook scope', async () => {
      const repo = makeNotebookRepo();
      const orch = new RetrievalOrchestrator(repo);

      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'sem:doc', title: 'Doc', providerId: 'semantic', score: 0.5 }),
      ]);
      orch.registerProvider(sem);

      const res = await orch.retrieve({
        query: 'q',
        mode: 'hybrid',
        scope: 'notebook',
        notebookId: 'nb-1',
      });

      // baseFused = 0.6 * 0.5 = 0.3; with boost = 0.3 + 0.1 = 0.4
      expect(res.results).toHaveLength(1);
      expect(res.results[0].score).toBeCloseTo(0.4);
    });

    it('does NOT apply notebook boost in global scope', async () => {
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'sem:doc', title: 'Doc', providerId: 'semantic', score: 0.5 }),
      ]);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      // baseFused = 0.6 * 0.5 = 0.3; no boost
      expect(res.results[0].score).toBeCloseTo(0.3);
    });

    it('does NOT apply notebook boost in explicit_sources scope', async () => {
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'sem:doc', title: 'Doc', providerId: 'semantic', score: 0.5 }),
      ]);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({
        query: 'q',
        mode: 'hybrid',
        scope: 'explicit_sources',
        explicitSources: ['https://example.com'],
      });

      // No boost
      expect(res.results[0].score).toBeCloseTo(0.3);
    });

    it('caps fusedScore at 1.0 after notebook boost', async () => {
      const repo = makeNotebookRepo();
      const orch = new RetrievalOrchestrator(repo);

      // Both providers match with maximum scores
      const kw = makeProvider('local', ['keyword', 'hybrid'], [
        makeResult({ itemKey: 'key', title: 'K', providerId: 'local', score: 1.0 }),
      ]);
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'key', title: 'K', providerId: 'semantic', score: 1.0 }),
      ]);
      orch.registerProvider(kw);
      orch.registerProvider(sem);

      const res = await orch.retrieve({
        query: 'q',
        mode: 'hybrid',
        scope: 'notebook',
        notebookId: 'nb-1',
      });

      // fused = 0.6 * 1 + 0.4 * 1 = 1.0; boost capped at 1.0
      expect(res.results[0].score).toBeCloseTo(1.0);
    });
  });

  // ── providerIds filtering ──────────────────────────────────────────────────

  describe('providerIds filtering in hybrid mode', () => {
    it('restricts hybrid execution to specified providerIds', async () => {
      const kw = makeProvider('local', ['keyword', 'hybrid']);
      const sem = makeProvider('semantic', ['semantic', 'hybrid']);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(sem);

      await orchestrator.retrieve({
        query: 'q',
        mode: 'hybrid',
        scope: 'global',
        providerIds: ['semantic'],
      });

      expect(kw.search).not.toHaveBeenCalled();
      expect(sem.search).toHaveBeenCalledTimes(1);
    });

    it('runs only keyword provider when providerIds restricts to keyword provider', async () => {
      const kw = makeProvider('local', ['keyword', 'hybrid'], [
        makeResult({ itemKey: 'k1', title: 'K', providerId: 'local', score: 0.6 }),
      ]);
      const sem = makeProvider('semantic', ['semantic', 'hybrid']);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({
        query: 'q',
        mode: 'hybrid',
        scope: 'global',
        providerIds: ['local'],
      });

      expect(sem.search).not.toHaveBeenCalled();
      expect(res.results).toHaveLength(1);
    });
  });

  // ── topK limit ────────────────────────────────────────────────────────────

  describe('topK limit in hybrid mode', () => {
    it('respects topK after fusion and sorting', async () => {
      const kw = makeProvider('local', ['keyword', 'hybrid'], [
        makeResult({ itemKey: 'a', title: 'A', providerId: 'local', score: 0.9 }),
        makeResult({ itemKey: 'b', title: 'B', providerId: 'local', score: 0.8 }),
        makeResult({ itemKey: 'c', title: 'C', providerId: 'local', score: 0.7 }),
      ]);
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'd', title: 'D', providerId: 'semantic', score: 0.6 }),
        makeResult({ itemKey: 'e', title: 'E', providerId: 'semantic', score: 0.5 }),
      ]);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({
        query: 'q',
        mode: 'hybrid',
        scope: 'global',
        topK: 3,
      });

      expect(res.results).toHaveLength(3);
      expect(res.totalResults).toBe(3);
    });

    it('returns top-ranked items after fusion sorting when topK is applied', async () => {
      // kw item 'high' has score 1.0 → fusedScore = 0.4 * 1.0 = 0.4
      // sem item 'sem-high' has score 0.9 → fusedScore = 0.6 * 0.9 = 0.54
      const kw = makeProvider('local', ['keyword', 'hybrid'], [
        makeResult({ itemKey: 'high', title: 'High KW', providerId: 'local', score: 1.0 }),
        makeResult({ itemKey: 'low', title: 'Low KW', providerId: 'local', score: 0.1 }),
      ]);
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'sem-high', title: 'High Sem', providerId: 'semantic', score: 0.9 }),
      ]);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({
        query: 'q',
        mode: 'hybrid',
        scope: 'global',
        topK: 2,
      });

      expect(res.results).toHaveLength(2);
      // sem-high (0.54) should rank above high (0.4)
      expect(res.results[0].itemKey).toBe('sem-high');
      expect(res.results[1].itemKey).toBe('high');
    });
  });

  // ── Citation / provenance integrity ───────────────────────────────────────

  describe('citation and provenance metadata preservation', () => {
    it('preserves all original metadata fields from semantic provider', async () => {
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({
          itemKey: 'sem:article',
          title: 'Research Article',
          providerId: 'semantic',
          score: 0.85,
          uri: 'https://research.example.com/article',
          sourcePath: '/workspace/articles/article.pdf',
          contentHash: 'sha256:deadbeef',
          metadata: {
            chunkId: 'chunk-42',
            documentId: 'doc-100',
            citationLabel: 'Smith et al. (2024)',
            sectionLabel: 'Introduction',
            pageNumber: 3,
            fetchedAt: '2024-01-01T00:00:00Z',
            displayDomain: 'research.example.com',
          },
        }),
      ]);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      expect(res.results).toHaveLength(1);
      const r = res.results[0];
      // Original fields preserved
      expect(r.uri).toBe('https://research.example.com/article');
      expect(r.sourcePath).toBe('/workspace/articles/article.pdf');
      expect(r.contentHash).toBe('sha256:deadbeef');
      expect(r.metadata?.chunkId).toBe('chunk-42');
      expect(r.metadata?.documentId).toBe('doc-100');
      expect(r.metadata?.citationLabel).toBe('Smith et al. (2024)');
      expect(r.metadata?.sectionLabel).toBe('Introduction');
      expect(r.metadata?.pageNumber).toBe(3);
      // Hybrid fusion fields added alongside
      expect(r.metadata?.fusedScore).toBeDefined();
      expect(r.metadata?.sourceProviders).toEqual(['semantic']);
    });

    it('preserves providerId from originating provider', async () => {
      const kw = makeProvider('local', ['keyword', 'hybrid'], [
        makeResult({ itemKey: 'loc:file.md', title: 'File', providerId: 'local', score: 0.5 }),
      ]);
      orchestrator.registerProvider(kw);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      expect(res.results[0].providerId).toBe('local');
    });
  });

  // ── Non-hybrid modes unaffected ───────────────────────────────────────────

  describe('keyword and semantic modes are unaffected', () => {
    it('keyword mode does not apply hybrid fusion scoring', async () => {
      const kw = makeProvider('local', ['keyword', 'hybrid'], [
        makeResult({ itemKey: 'k1', title: 'K1', providerId: 'local', score: 0.8 }),
        makeResult({ itemKey: 'k2', title: 'K2', providerId: 'local', score: 0.5 }),
      ]);
      orchestrator.registerProvider(kw);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'keyword', scope: 'global' });

      // Scores unchanged — no fusion applied
      expect(res.results[0].score).toBe(0.8);
      expect(res.results[1].score).toBe(0.5);
      expect(res.results[0].metadata?.fusedScore).toBeUndefined();
    });

    it('semantic mode does not apply hybrid fusion scoring', async () => {
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'sem:1', title: 'S1', providerId: 'semantic', score: 0.9 }),
      ]);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'semantic', scope: 'global' });

      expect(res.results[0].score).toBe(0.9);
      expect(res.results[0].metadata?.fusedScore).toBeUndefined();
    });

    it('keyword mode deduplication uses first-occurrence-wins (not URI-based)', async () => {
      const kw1 = makeProvider('p1', ['keyword'], [
        makeResult({ itemKey: 'dup', title: 'From P1', providerId: 'p1', score: 0.8 }),
      ]);
      const kw2 = makeProvider('p2', ['keyword'], [
        makeResult({ itemKey: 'dup', title: 'From P2', providerId: 'p2', score: 0.6 }),
      ]);
      orchestrator.registerProvider(kw1);
      orchestrator.registerProvider(kw2);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'keyword', scope: 'global' });

      expect(res.results).toHaveLength(1);
      expect(res.results[0].title).toBe('From P1');
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles provider failure gracefully in hybrid mode', async () => {
      const kw = makeProvider('local', ['keyword', 'hybrid'], [], 'disk read error');
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'sem:1', title: 'Semantic Result', providerId: 'semantic', score: 0.7 }),
      ]);
      orchestrator.registerProvider(kw);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      expect(res.results).toHaveLength(1);
      expect(res.results[0].itemKey).toBe('sem:1');
      expect(res.warnings).toBeDefined();
      expect(res.warnings!.some(w => w.includes('disk read error'))).toBe(true);
    });

    it('returns empty results when hybrid mode has no providers registered', async () => {
      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      expect(res.results).toEqual([]);
      expect(res.totalResults).toBe(0);
    });

    it('handles hybrid mode with null-score semantic result gracefully', async () => {
      const sem = makeProvider('semantic', ['semantic', 'hybrid'], [
        makeResult({ itemKey: 'sem:null', title: 'Null Score', providerId: 'semantic', score: null }),
      ]);
      orchestrator.registerProvider(sem);

      const res = await orchestrator.retrieve({ query: 'q', mode: 'hybrid', scope: 'global' });

      expect(res.results).toHaveLength(1);
      // Default score = 0.5; fusedScore = 0.6 * 0.5 = 0.3
      expect(res.results[0].score).toBeCloseTo(0.3);
    });
  });
});
