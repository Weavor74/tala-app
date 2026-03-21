/**
 * ContextAssemblyService.test.ts
 *
 * Unit tests for ContextAssemblyService.
 *
 * Validates:
 *   - Evidence selection obeys maxItems budget.
 *   - Max chunks per document cap is enforced via metadata.documentId.
 *   - Overflow items move to latent (selectionClass: 'latent').
 *   - Latent items preserve full metadata and citation provenance.
 *   - Citation metadata from retrieval results survives into assembled context.
 *   - Strict mode: no graph_context items in result.
 *   - Graph-assisted and exploratory modes are structurally distinct.
 *   - renderPromptBlocks() produces deterministic prompt strings.
 *   - renderPromptBlocks() omits [DIRECT GRAPH CONTEXT] when no graph items.
 *   - renderPromptBlocks() includes [LATENT MEMORY SUMMARY] when latent items exist.
 *   - Retrieval failure returns graceful result with warning.
 *   - Empty retrieval returns valid empty ContextAssemblyResult.
 *
 * Uses mocked RetrievalOrchestrator — no real DB or network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextAssemblyService } from '../electron/services/context/ContextAssemblyService';
import { MemoryPolicyService } from '../electron/services/policy/MemoryPolicyService';
import type { RetrievalOrchestrator } from '../electron/services/retrieval/RetrievalOrchestrator';
import type {
  NormalizedSearchResult,
  RetrievalResponse,
  RetrievalScopeResolved,
} from '../shared/retrieval/retrievalTypes';
import type {
  ContextAssemblyRequest,
  MemoryPolicy,
} from '../shared/policy/memoryPolicyTypes';

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

function makeScopeResolved(overrides: Partial<RetrievalScopeResolved> = {}): RetrievalScopeResolved {
  return {
    scopeType: 'global',
    uris: [],
    sourcePaths: [],
    itemKeys: [],
    ...overrides,
  };
}

function makeRetrievalResponse(
  results: NormalizedSearchResult[],
  overrides: Partial<RetrievalResponse> = {},
): RetrievalResponse {
  return {
    query: 'test',
    mode: 'hybrid',
    scopeResolved: makeScopeResolved(),
    results,
    providerResults: [],
    totalResults: results.length,
    durationMs: 5,
    ...overrides,
  };
}

function makeMockOrchestrator(results: NormalizedSearchResult[]): RetrievalOrchestrator {
  return {
    retrieve: vi.fn().mockResolvedValue(makeRetrievalResponse(results)),
  } as unknown as RetrievalOrchestrator;
}

function makeRequest(policyOverride: Partial<MemoryPolicy> = {}): ContextAssemblyRequest {
  const partialPolicy: Partial<MemoryPolicy> = {
    groundingMode: 'graph_assisted',
    ...policyOverride,
  };
  return {
    query: 'test query',
    policy: partialPolicy as MemoryPolicy,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ContextAssemblyService', () => {
  let policyService: MemoryPolicyService;

  beforeEach(() => {
    policyService = new MemoryPolicyService();
  });

  // ── Basic assembly ─────────────────────────────────────────────────────────

  describe('basic assembly', () => {
    it('returns a valid ContextAssemblyResult with items', async () => {
      const results = [
        makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', score: 0.9 }),
        makeResult({ itemKey: 'r2', title: 'Doc B', providerId: 'local', score: 0.8 }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = await service.assemble(makeRequest());

      expect(result.items.length).toBeGreaterThan(0);
      expect(result.totalItems).toBe(result.items.length);
      expect(result.policy).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns empty result when retrieval returns no results', async () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = await service.assemble(makeRequest());

      expect(result.items).toHaveLength(0);
      expect(result.totalItems).toBe(0);
    });

    it('all injected items have selectionClass evidence', async () => {
      const results = [
        makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local' }),
        makeResult({ itemKey: 'r2', title: 'Doc B', providerId: 'local' }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = await service.assemble(makeRequest());

      const evidenceItems = result.items.filter(i => i.selectionClass === 'evidence');
      const latentItems = result.items.filter(i => i.selectionClass === 'latent');
      // All items are evidence or latent
      expect(evidenceItems.length + latentItems.length).toBe(result.items.length);
    });
  });

  // ── Budget enforcement ─────────────────────────────────────────────────────

  describe('evidence selection budget enforcement', () => {
    it('caps injected items at policy maxItems', async () => {
      const results = Array.from({ length: 10 }, (_, i) =>
        makeResult({ itemKey: `r${i}`, title: `Doc ${i}`, providerId: 'local', score: 0.9 - i * 0.05 }),
      );
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const request = makeRequest({ contextBudget: { maxItems: 3 } });
      const result = await service.assemble(request);

      const injected = result.items.filter(i => i.selectionClass === 'evidence');
      expect(injected.length).toBeLessThanOrEqual(3);
    });

    it('caps injected items at maxItemsPerClass.evidence when set', async () => {
      const results = Array.from({ length: 8 }, (_, i) =>
        makeResult({ itemKey: `r${i}`, title: `Doc ${i}`, providerId: 'local' }),
      );
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const request = makeRequest({
        contextBudget: { maxItems: 10, maxItemsPerClass: { evidence: 4 } },
      });
      const result = await service.assemble(request);

      const injected = result.items.filter(i => i.selectionClass === 'evidence');
      expect(injected.length).toBeLessThanOrEqual(4);
    });
  });

  // ── Max chunks per document ────────────────────────────────────────────────

  describe('max chunks per document cap', () => {
    it('enforces max chunks per document when documentId is present in metadata', async () => {
      // 4 chunks from the same document, maxItems=4, evidenceCap/2 = 2 chunks per doc
      const results = Array.from({ length: 4 }, (_, i) =>
        makeResult({
          itemKey: `chunk-${i}`,
          title: `Chunk ${i}`,
          providerId: 'local',
          metadata: { documentId: 'doc-1' },
        }),
      );
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const request = makeRequest({ contextBudget: { maxItems: 4, maxItemsPerClass: { evidence: 4 } } });
      const result = await service.assemble(request);

      const injectedFromDoc1 = result.items.filter(
        i => i.selectionClass === 'evidence' && (i.metadata?.documentId as string) === 'doc-1',
      );
      // Should be capped at ceil(4/2) = 2
      expect(injectedFromDoc1.length).toBeLessThanOrEqual(2);
    });

    it('does not apply per-doc cap when documentId is absent', async () => {
      const results = Array.from({ length: 3 }, (_, i) =>
        makeResult({ itemKey: `r${i}`, title: `Doc ${i}`, providerId: 'local' }),
      );
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const request = makeRequest({ contextBudget: { maxItems: 5 } });
      const result = await service.assemble(request);

      const injected = result.items.filter(i => i.selectionClass === 'evidence');
      expect(injected.length).toBe(3);
    });
  });

  // ── Latent overflow ────────────────────────────────────────────────────────

  describe('latent overflow', () => {
    it('moves overflow items to latent selectionClass', async () => {
      const results = Array.from({ length: 8 }, (_, i) =>
        makeResult({ itemKey: `r${i}`, title: `Doc ${i}`, providerId: 'local' }),
      );
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const request = makeRequest({ contextBudget: { maxItems: 3 } });
      const result = await service.assemble(request);

      const latent = result.items.filter(i => i.selectionClass === 'latent');
      expect(latent.length).toBeGreaterThan(0);
    });

    it('latent items preserve metadata and citation provenance', async () => {
      const results = Array.from({ length: 6 }, (_, i) =>
        makeResult({
          itemKey: `r${i}`,
          title: `Doc ${i}`,
          providerId: 'local',
          uri: `file:///doc-${i}.md`,
          metadata: { chunkId: `chunk-${i}`, documentId: `doc-${i}`, sectionLabel: `Section ${i}` },
        }),
      );
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const request = makeRequest({ contextBudget: { maxItems: 2 } });
      const result = await service.assemble(request);

      const latent = result.items.filter(i => i.selectionClass === 'latent');
      expect(latent.length).toBeGreaterThan(0);
      for (const item of latent) {
        expect(item.metadata).toBeDefined();
        expect(item.sourceKey).toBeDefined();
      }
    });

    it('preserves ranked order in latent items', async () => {
      const results = [
        makeResult({ itemKey: 'r0', title: 'First', providerId: 'local', score: 0.9 }),
        makeResult({ itemKey: 'r1', title: 'Second', providerId: 'local', score: 0.8 }),
        makeResult({ itemKey: 'r2', title: 'Third', providerId: 'local', score: 0.7 }),
        makeResult({ itemKey: 'r3', title: 'Fourth', providerId: 'local', score: 0.6 }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const request = makeRequest({ contextBudget: { maxItems: 2 } });
      const result = await service.assemble(request);

      const latent = result.items.filter(i => i.selectionClass === 'latent');
      // Latent items should be the lower-ranked ones (indices 2 and 3)
      expect(latent.length).toBe(2);
      expect(latent[0].sourceKey).toBe('r2');
      expect(latent[1].sourceKey).toBe('r3');
    });
  });

  // ── Citation/provenance preservation ──────────────────────────────────────

  describe('citation and provenance metadata preservation', () => {
    it('preserves title, uri, sourceKey, score from retrieval result', async () => {
      const results = [
        makeResult({
          itemKey: 'item-key-1',
          title: 'Architecture Overview',
          providerId: 'local',
          uri: 'file:///docs/architecture.md',
          score: 0.95,
        }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = await service.assemble(makeRequest());

      const item = result.items[0];
      expect(item.title).toBe('Architecture Overview');
      expect(item.uri).toBe('file:///docs/architecture.md');
      expect(item.sourceKey).toBe('item-key-1');
      expect(item.score).toBe(0.95);
    });

    it('preserves chunkId, documentId, charStart, charEnd in metadata', async () => {
      const results = [
        makeResult({
          itemKey: 'chunk-1',
          title: 'Chunk',
          providerId: 'local',
          metadata: {
            chunkId: 'c-1',
            documentId: 'd-1',
            charStart: 100,
            charEnd: 500,
            sectionLabel: 'Introduction',
            pageNumber: 3,
          },
        }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = await service.assemble(makeRequest());

      const item = result.items[0];
      expect(item.metadata?.chunkId).toBe('c-1');
      expect(item.metadata?.documentId).toBe('d-1');
      expect(item.metadata?.charStart).toBe(100);
      expect(item.metadata?.charEnd).toBe(500);
      expect(item.metadata?.sectionLabel).toBe('Introduction');
      expect(item.metadata?.pageNumber).toBe(3);
    });

    it('uses metadata.chunkContent as content when available', async () => {
      const results = [
        makeResult({
          itemKey: 'r1',
          title: 'Doc',
          providerId: 'local',
          snippet: 'fallback snippet',
          metadata: { chunkContent: 'primary chunk text' },
        }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = await service.assemble(makeRequest());

      expect(result.items[0].content).toBe('primary chunk text');
    });

    it('falls back to snippet when chunkContent is absent', async () => {
      const results = [
        makeResult({
          itemKey: 'r1',
          title: 'Doc',
          providerId: 'local',
          snippet: 'the snippet text',
        }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = await service.assemble(makeRequest());

      expect(result.items[0].content).toBe('the snippet text');
    });
  });

  // ── Strict mode graph_context ─────────────────────────────────────────────

  describe('strict mode: no graph_context items', () => {
    it('strict mode result has no graph_context items', async () => {
      const results = [
        makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local' }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const request = makeRequest({ groundingMode: 'strict' });
      const result = await service.assemble(request);

      const graphItems = result.items.filter(i => i.selectionClass === 'graph_context');
      expect(graphItems).toHaveLength(0);
    });

    it('strict mode: resolved policy groundingMode is strict', async () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const request = makeRequest({ groundingMode: 'strict' });
      const result = await service.assemble(request);

      expect(result.policy.groundingMode).toBe('strict');
      expect(result.policy.graphTraversal.enabled).toBe(false);
    });
  });

  // ── Graph_assisted and exploratory mode distinctness ──────────────────────

  describe('graph_assisted and exploratory mode distinctness', () => {
    it('graph_assisted result policy has graphTraversal.enabled true', async () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const request = makeRequest({ groundingMode: 'graph_assisted' });
      const result = await service.assemble(request);

      expect(result.policy.groundingMode).toBe('graph_assisted');
      expect(result.policy.graphTraversal.enabled).toBe(true);
    });

    it('exploratory result policy has graphTraversal.enabled true', async () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const request = makeRequest({ groundingMode: 'exploratory' });
      const result = await service.assemble(request);

      expect(result.policy.groundingMode).toBe('exploratory');
      expect(result.policy.graphTraversal.enabled).toBe(true);
    });

    it('exploratory policy has larger maxHopDepth than graph_assisted', async () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const gaResult = await service.assemble(makeRequest({ groundingMode: 'graph_assisted' }));
      const exResult = await service.assemble(makeRequest({ groundingMode: 'exploratory' }));

      expect(exResult.policy.graphTraversal.maxHopDepth).toBeGreaterThan(
        gaResult.policy.graphTraversal.maxHopDepth,
      );
    });
  });

  // ── Render prompt blocks ────────────────────────────────────────────────────

  describe('renderPromptBlocks', () => {
    it('produces deterministic output for the same result', async () => {
      const results = [
        makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', snippet: 'Content A' }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = await service.assemble(makeRequest());

      const block1 = service.renderPromptBlocks(result);
      const block2 = service.renderPromptBlocks(result);
      expect(block1).toBe(block2);
    });

    it('includes [PRIMARY EVIDENCE] section when evidence items exist', async () => {
      const results = [
        makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', snippet: 'Content A' }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = await service.assemble(makeRequest());
      const block = service.renderPromptBlocks(result);

      expect(block).toContain('[PRIMARY EVIDENCE]');
    });

    it('omits [DIRECT GRAPH CONTEXT] when no graph_context items exist', async () => {
      const results = [
        makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local' }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = await service.assemble(makeRequest());
      const block = service.renderPromptBlocks(result);

      expect(block).not.toContain('[DIRECT GRAPH CONTEXT]');
    });

    it('includes [POLICY CONSTRAINTS] section', async () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = await service.assemble(makeRequest());
      const block = service.renderPromptBlocks(result);

      expect(block).toContain('[POLICY CONSTRAINTS]');
      expect(block).toContain('groundingMode:');
      expect(block).toContain('retrievalMode:');
      expect(block).toContain('scope:');
    });

    it('includes [LATENT MEMORY SUMMARY] when latent items exist', async () => {
      const results = Array.from({ length: 6 }, (_, i) =>
        makeResult({ itemKey: `r${i}`, title: `Doc ${i}`, providerId: 'local' }),
      );
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const request = makeRequest({ contextBudget: { maxItems: 2 } });
      const result = await service.assemble(request);
      const block = service.renderPromptBlocks(result);

      expect(block).toContain('[LATENT MEMORY SUMMARY]');
    });

    it('omits [LATENT MEMORY SUMMARY] when no latent items exist', async () => {
      const results = [
        makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local' }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const request = makeRequest({ contextBudget: { maxItems: 10 } });
      const result = await service.assemble(request);
      const block = service.renderPromptBlocks(result);

      expect(block).not.toContain('[LATENT MEMORY SUMMARY]');
    });

    it('includes notebookId in POLICY CONSTRAINTS when present', async () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const request = makeRequest({ groundingMode: 'strict', scope: 'notebook', notebookId: 'nb-99' });
      const result = await service.assemble(request);
      const block = service.renderPromptBlocks(result);

      expect(block).toContain('nb-99');
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns graceful result with warning when retrieval throws', async () => {
      const orchestrator = {
        retrieve: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      } as unknown as RetrievalOrchestrator;
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = await service.assemble(makeRequest());

      expect(result.items).toHaveLength(0);
      expect(result.warnings).toBeDefined();
      expect(result.warnings![0]).toContain('Retrieval failed');
    });
  });

  // ── itemCountByClass ──────────────────────────────────────────────────────

  describe('itemCountByClass', () => {
    it('accurately counts evidence and latent items', async () => {
      const results = Array.from({ length: 5 }, (_, i) =>
        makeResult({ itemKey: `r${i}`, title: `Doc ${i}`, providerId: 'local' }),
      );
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const request = makeRequest({ contextBudget: { maxItems: 3 } });
      const result = await service.assemble(request);

      const evidenceCount = result.items.filter(i => i.selectionClass === 'evidence').length;
      const latentCount = result.items.filter(i => i.selectionClass === 'latent').length;

      expect(result.itemCountByClass.evidence).toBe(evidenceCount);
      expect(result.itemCountByClass.latent).toBe(latentCount);
    });
  });
});
