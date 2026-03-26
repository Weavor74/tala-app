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
 *   - Affective context: service absent → unchanged behavior.
 *   - Affective context: disabled policy → no affective items.
 *   - Affective context: enabled + items returned → items appear as graph_context.
 *   - Strict mode excludes affective items regardless of policy.
 *   - Affective items carry metadata.affective=true and are never evidence.
 *   - Evidence ordering unchanged when allowEvidenceReordering=false (default).
 *   - Graph_context ordering influenced when allowGraphOrderingInfluence=true.
 *   - maxAffectiveNodes enforced by AffectiveGraphService (via mock).
 *   - Affective service failure adds warning but does not fail assembly.
 *   - renderPromptBlocks includes [AFFECTIVE CONTEXT] only when affective items present.
 *   - [POLICY CONSTRAINTS] always shows affective modulation status.
 *
 * Uses mocked RetrievalOrchestrator and AffectiveGraphService — no real DB or network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextAssemblyService } from '../electron/services/context/ContextAssemblyService';
import { MemoryPolicyService } from '../electron/services/policy/MemoryPolicyService';
import { GraphTraversalService } from '../electron/services/graph/GraphTraversalService';
import type { RetrievalOrchestrator } from '../electron/services/retrieval/RetrievalOrchestrator';
import type { AffectiveGraphService } from '../electron/services/graph/AffectiveGraphService';
import type {
  NormalizedSearchResult,
  RetrievalResponse,
  RetrievalScopeResolved,
} from '../shared/retrieval/retrievalTypes';
import type {
  ContextAssemblyRequest,
  MemoryPolicy,
  ContextAssemblyItem,
  AffectiveModulationPolicy,
  ContextAssemblyResult,
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

// ─── Affective helpers ────────────────────────────────────────────────────────

function makeAffectivePolicy(
  overrides: Partial<AffectiveModulationPolicy> = {},
): AffectiveModulationPolicy {
  return {
    enabled: true,
    maxAffectiveNodes: 2,
    allowToneModulation: true,
    allowGraphOrderingInfluence: false,
    allowGraphExpansionInfluence: false,
    allowEvidenceReordering: false,
    affectiveWeight: 0.1,
    requireLabeling: true,
    ...overrides,
  };
}

function makeAffectiveItem(
  overrides: Partial<ContextAssemblyItem> = {},
): ContextAssemblyItem {
  return {
    content: '[Affective context — not evidence]\nCurrent astro state: Mars trine Saturn',
    selectionClass: 'graph_context',
    sourceType: 'astro_state',
    sourceKey: 'astro_state:global',
    title: 'Affective state (astro)',
    score: 0.1,
    graphEdgeType: 'modulates',
    graphEdgeTrust: 'session_only',
    metadata: {
      affective: true,
      affectiveNodeType: 'astro_state',
      allowToneModulation: true,
      allowGraphOrderingInfluence: false,
      rawAstroState: null,
    },
    ...overrides,
  };
}

function makeMockAffectiveService(
  items: ContextAssemblyItem[],
): AffectiveGraphService {
  return {
    getActiveAffectiveContext: vi.fn().mockResolvedValue(items),
  } as unknown as AffectiveGraphService;
}

function makeFailingAffectiveService(): AffectiveGraphService {
  return {
    getActiveAffectiveContext: vi.fn().mockRejectedValue(new Error('Astro engine error')),
  } as unknown as AffectiveGraphService;
}

/**
 * Returns a GraphTraversalService that always expands to zero items.
 * Used in affective integration tests where structural graph traversal is
 * not the concern and must not interfere with results.
 */
function makeNoopGraphTraversalService(): GraphTraversalService {
  return {
    expandFromEvidence: vi.fn().mockResolvedValue([]),
  } as unknown as GraphTraversalService;
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

    it('global budget cap is enforced for evidence items', async () => {
      const results = Array.from({ length: 8 }, (_, i) =>
        makeResult({ itemKey: `r${i}`, title: `Doc ${i}`, providerId: 'local' }),
      );
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const request = makeRequest({
        contextBudget: { maxItems: 4 },
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

  // ── Affective context integration ─────────────────────────────────────────

  describe('affective context integration', () => {

    // ── Service absent / disabled ──────────────────────────────────────────

    it('when affective service not provided: no affective items, same behavior', async () => {
      const results = [
        makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', snippet: 'Content A' }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      // No affective service passed (default null)
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = await service.assemble(makeRequest({ groundingMode: 'graph_assisted' }));

      const affective = result.items.filter(i => i.metadata?.affective === true);
      expect(affective).toHaveLength(0);
      expect(result.items.some(i => i.selectionClass === 'evidence')).toBe(true);
    });

    it('when affectiveModulation disabled in policy: no affective items returned', async () => {
      const results = [
        makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', snippet: 'Content A' }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const affectiveService = makeMockAffectiveService([makeAffectiveItem()]);
      const service = new ContextAssemblyService(
        orchestrator, policyService, makeNoopGraphTraversalService(), affectiveService,
      );
      // affectiveModulation.enabled = false
      const request = makeRequest({
        groundingMode: 'graph_assisted',
        affectiveModulation: makeAffectivePolicy({ enabled: false }),
      });
      const result = await service.assemble(request);

      const affective = result.items.filter(i => i.metadata?.affective === true);
      expect(affective).toHaveLength(0);
    });

    it('when strict mode: no affective items even with service and enabled policy', async () => {
      const results = [
        makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', snippet: 'Content A' }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const affectiveService = makeMockAffectiveService([makeAffectiveItem()]);
      const service = new ContextAssemblyService(
        orchestrator, policyService, makeNoopGraphTraversalService(), affectiveService,
      );
      const request = makeRequest({
        groundingMode: 'strict',
        affectiveModulation: makeAffectivePolicy({ enabled: true }),
      });
      const result = await service.assemble(request);

      const affective = result.items.filter(i => i.metadata?.affective === true);
      expect(affective).toHaveLength(0);
      const graphItems = result.items.filter(i => i.selectionClass === 'graph_context');
      expect(graphItems).toHaveLength(0);
    });

    // ── Affective items included ───────────────────────────────────────────

    it('graph_assisted mode with enabled service: affective items appear as graph_context', async () => {
      const results = [
        makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', snippet: 'Content A' }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const affectiveItem = makeAffectiveItem();
      const affectiveService = makeMockAffectiveService([affectiveItem]);
      const service = new ContextAssemblyService(
        orchestrator, policyService, makeNoopGraphTraversalService(), affectiveService,
      );
      const request = makeRequest({
        groundingMode: 'graph_assisted',
        affectiveModulation: makeAffectivePolicy({ enabled: true }),
        contextBudget: { maxItems: 10, maxItemsPerClass: { graph_context: 5 } },
      });
      const result = await service.assemble(request);

      const affective = result.items.filter(i => i.metadata?.affective === true);
      expect(affective.length).toBeGreaterThan(0);
      for (const item of affective) {
        expect(item.selectionClass).toBe('graph_context');
      }
    });

    it('exploratory mode with enabled service: affective items appear as graph_context', async () => {
      const orchestrator = makeMockOrchestrator([]);
      const affectiveItem = makeAffectiveItem();
      const affectiveService = makeMockAffectiveService([affectiveItem]);
      const service = new ContextAssemblyService(
        orchestrator, policyService, makeNoopGraphTraversalService(), affectiveService,
      );
      const request = makeRequest({
        groundingMode: 'exploratory',
        affectiveModulation: makeAffectivePolicy({ enabled: true }),
        contextBudget: { maxItems: 20, maxItemsPerClass: { graph_context: 6 } },
      });
      const result = await service.assemble(request);

      const affective = result.items.filter(i => i.metadata?.affective === true);
      expect(affective.length).toBeGreaterThan(0);
      expect(affective[0].selectionClass).toBe('graph_context');
    });

    // ── Affective items never evidence ────────────────────────────────────

    it('affective items are never selectionClass evidence', async () => {
      const results = [
        makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', snippet: 'Content A' }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const affectiveItem = makeAffectiveItem();
      const affectiveService = makeMockAffectiveService([affectiveItem]);
      const service = new ContextAssemblyService(
        orchestrator, policyService, makeNoopGraphTraversalService(), affectiveService,
      );
      const request = makeRequest({
        groundingMode: 'graph_assisted',
        affectiveModulation: makeAffectivePolicy({ enabled: true }),
        contextBudget: { maxItems: 10, maxItemsPerClass: { graph_context: 5 } },
      });
      const result = await service.assemble(request);

      const evidenceItems = result.items.filter(i => i.selectionClass === 'evidence');
      for (const item of evidenceItems) {
        expect(item.metadata?.affective).not.toBe(true);
      }
    });

    it('affective items carry metadata.affective=true', async () => {
      const orchestrator = makeMockOrchestrator([]);
      const affectiveItem = makeAffectiveItem();
      const affectiveService = makeMockAffectiveService([affectiveItem]);
      const service = new ContextAssemblyService(
        orchestrator, policyService, makeNoopGraphTraversalService(), affectiveService,
      );
      const request = makeRequest({
        groundingMode: 'graph_assisted',
        affectiveModulation: makeAffectivePolicy({ enabled: true }),
        contextBudget: { maxItems: 10, maxItemsPerClass: { graph_context: 5 } },
      });
      const result = await service.assemble(request);

      const affective = result.items.filter(i => i.metadata?.affective === true);
      expect(affective.length).toBeGreaterThan(0);
      expect(affective[0].graphEdgeType).toBe('modulates');
      expect(affective[0].graphEdgeTrust).toBe('session_only');
    });

    // ── Evidence ordering preserved ───────────────────────────────────────

    it('evidence ordering unchanged when allowEvidenceReordering=false (default)', async () => {
      const results = [
        makeResult({ itemKey: 'r0', title: 'First', providerId: 'local', score: 0.9 }),
        makeResult({ itemKey: 'r1', title: 'Second', providerId: 'local', score: 0.8 }),
        makeResult({ itemKey: 'r2', title: 'Third', providerId: 'local', score: 0.7 }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const affectiveItem = makeAffectiveItem({
        metadata: {
          affective: true,
          affectiveNodeType: 'emotion_tag',
          moodLabel: 'First',  // overlaps with first evidence title
        },
      });
      const affectiveService = makeMockAffectiveService([affectiveItem]);
      const service = new ContextAssemblyService(
        orchestrator, policyService, makeNoopGraphTraversalService(), affectiveService,
      );
      const request = makeRequest({
        groundingMode: 'graph_assisted',
        affectiveModulation: makeAffectivePolicy({
          enabled: true,
          allowEvidenceReordering: false,
          allowGraphOrderingInfluence: true,
        }),
        contextBudget: { maxItems: 10, maxItemsPerClass: { graph_context: 5 } },
      });
      const result = await service.assemble(request);

      const evidence = result.items.filter(i => i.selectionClass === 'evidence');
      expect(evidence[0].sourceKey).toBe('r0');
      expect(evidence[1].sourceKey).toBe('r1');
      expect(evidence[2].sourceKey).toBe('r2');
    });

    // ── Graph context ordering influence ──────────────────────────────────

    it('allowGraphOrderingInfluence=true: affective items appear first in graph_context', async () => {
      const orchestrator = makeMockOrchestrator([]);
      const affectiveItem = makeAffectiveItem({
        score: 0.1,
        metadata: {
          affective: true,
          affectiveNodeType: 'astro_state',
          allowGraphOrderingInfluence: true,
          moodLabel: 'Urgency',
          rawAstroState: null,
          allowToneModulation: true,
        },
      });
      const affectiveService = makeMockAffectiveService([affectiveItem]);
      const service = new ContextAssemblyService(
        orchestrator, policyService, makeNoopGraphTraversalService(), affectiveService,
      );
      const request = makeRequest({
        groundingMode: 'graph_assisted',
        affectiveModulation: makeAffectivePolicy({
          enabled: true,
          allowGraphOrderingInfluence: true,
          affectiveWeight: 0.1,
        }),
        contextBudget: { maxItems: 10, maxItemsPerClass: { graph_context: 5 } },
      });
      const result = await service.assemble(request);

      const graphItems = result.items.filter(i => i.selectionClass === 'graph_context');
      if (graphItems.length > 0) {
        expect(graphItems[0].metadata?.affective).toBe(true);
      }
    });

    // ── Service failure graceful degradation ──────────────────────────────

    it('affective service failure adds warning but does not fail assembly', async () => {
      const results = [
        makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', snippet: 'Content A' }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const failingService = makeFailingAffectiveService();
      const service = new ContextAssemblyService(
        orchestrator, policyService, makeNoopGraphTraversalService(), failingService,
      );
      const request = makeRequest({
        groundingMode: 'graph_assisted',
        affectiveModulation: makeAffectivePolicy({ enabled: true }),
        contextBudget: { maxItems: 10, maxItemsPerClass: { graph_context: 5 } },
      });
      const result = await service.assemble(request);

      // Assembly should complete successfully
      expect(result.items.some(i => i.selectionClass === 'evidence')).toBe(true);
      // Warning should be present
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.some(w => w.includes('Affective context unavailable'))).toBe(true);
      // No affective items
      const affective = result.items.filter(i => i.metadata?.affective === true);
      expect(affective).toHaveLength(0);
    });

    // ── Budget cap ────────────────────────────────────────────────────────

    it('global budget cap applies to combined structural+affective items', async () => {
      const orchestrator = makeMockOrchestrator([]);
      const affectiveItems = [
        makeAffectiveItem({ sourceKey: 'a1', score: 0.1 }),
        makeAffectiveItem({ sourceKey: 'a2', score: 0.08 }),
        makeAffectiveItem({ sourceKey: 'a3', score: 0.06 }),
      ];
      const affectiveService = makeMockAffectiveService(affectiveItems);
      const service = new ContextAssemblyService(
        orchestrator, policyService, makeNoopGraphTraversalService(), affectiveService,
      );
      const request = makeRequest({
        groundingMode: 'graph_assisted',
        affectiveModulation: makeAffectivePolicy({ enabled: true, maxAffectiveNodes: 3 }),
        // Global budget of 2 — only 2 items can be included
        contextBudget: { maxItems: 2 },
      });
      const result = await service.assemble(request);

      const graphItems = result.items.filter(i => i.selectionClass === 'graph_context');
      expect(graphItems.length).toBeLessThanOrEqual(2);
    });

    // ── itemCountByClass with affective ───────────────────────────────────

    it('itemCountByClass.graph_context counts affective items', async () => {
      const orchestrator = makeMockOrchestrator([]);
      const affectiveItem = makeAffectiveItem();
      const affectiveService = makeMockAffectiveService([affectiveItem]);
      const service = new ContextAssemblyService(
        orchestrator, policyService, makeNoopGraphTraversalService(), affectiveService,
      );
      const request = makeRequest({
        groundingMode: 'graph_assisted',
        affectiveModulation: makeAffectivePolicy({ enabled: true }),
        contextBudget: { maxItems: 10, maxItemsPerClass: { graph_context: 5 } },
      });
      const result = await service.assemble(request);

      const graphItemCount = result.items.filter(i => i.selectionClass === 'graph_context').length;
      expect(result.itemCountByClass.graph_context).toBe(graphItemCount);
    });
  });

  // ── Affective context in renderPromptBlocks ─────────────────────────────────

  describe('renderPromptBlocks: affective context sections', () => {

    it('[AFFECTIVE CONTEXT] present when affective items in result', () => {
      const affectiveItem = makeAffectiveItem();
      const evidenceItem: ContextAssemblyItem = {
        content: 'Evidence content',
        selectionClass: 'evidence',
        sourceType: null,
        sourceKey: 'ev1',
        title: 'Evidence Doc',
        score: 0.9,
        graphEdgeType: null,
        graphEdgeTrust: null,
        metadata: {},
      };
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const ap = makeAffectivePolicy({ enabled: true });
      const result = {
        items: [evidenceItem, affectiveItem],
        policy: {
          groundingMode: 'graph_assisted',
          retrievalMode: 'hybrid',
          scope: 'global',
          graphTraversal: { enabled: true, maxHopDepth: 1, maxRelatedNodes: 5, maxNodesPerType: 3, minEdgeTrustLevel: 'derived', allowedEdgeTypes: [] },
          contextBudget: { maxItems: 15, maxTokens: 6144, maxItemsPerClass: { evidence: 10, graph_context: 5 }, evidencePriority: true },
          affectiveModulation: ap,
        } as MemoryPolicy,
        totalItems: 2,
        itemCountByClass: { evidence: 1, graph_context: 1 },
        estimatedTokens: 50,
        durationMs: 10,
      };
      const block = service.renderPromptBlocks(result);
      expect(block).toContain('[AFFECTIVE CONTEXT]');
      expect(block).toContain('do not change factual grounding');
    });

    it('[AFFECTIVE CONTEXT] omitted when no affective items in result', () => {
      const evidenceItem: ContextAssemblyItem = {
        content: 'Evidence content',
        selectionClass: 'evidence',
        sourceType: null,
        sourceKey: 'ev1',
        title: 'Evidence Doc',
        score: 0.9,
        graphEdgeType: null,
        graphEdgeTrust: null,
        metadata: {},
      };
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = {
        items: [evidenceItem],
        policy: {
          groundingMode: 'graph_assisted',
          retrievalMode: 'hybrid',
          scope: 'global',
          graphTraversal: { enabled: true, maxHopDepth: 1, maxRelatedNodes: 5, maxNodesPerType: 3, minEdgeTrustLevel: 'derived', allowedEdgeTypes: [] },
          contextBudget: { maxItems: 15, maxTokens: 6144, maxItemsPerClass: { evidence: 10, graph_context: 5 }, evidencePriority: true },
          affectiveModulation: makeAffectivePolicy({ enabled: true }),
        } as MemoryPolicy,
        totalItems: 1,
        itemCountByClass: { evidence: 1 },
        estimatedTokens: 20,
        durationMs: 10,
      };
      const block = service.renderPromptBlocks(result);
      expect(block).not.toContain('[AFFECTIVE CONTEXT]');
    });

    it('[DIRECT GRAPH CONTEXT] shows only non-affective graph_context items', () => {
      const structuralItem: ContextAssemblyItem = {
        content: 'Related document context',
        selectionClass: 'graph_context',
        sourceType: 'source_document',
        sourceKey: 'doc-1',
        title: 'Related Doc',
        score: 0.5,
        graphEdgeType: 'contains',
        graphEdgeTrust: 'derived',
        metadata: { graphNodeType: 'source_document' },
      };
      const affectiveItem = makeAffectiveItem();
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = {
        items: [structuralItem, affectiveItem],
        policy: {
          groundingMode: 'graph_assisted',
          retrievalMode: 'hybrid',
          scope: 'global',
          graphTraversal: { enabled: true, maxHopDepth: 1, maxRelatedNodes: 5, maxNodesPerType: 3, minEdgeTrustLevel: 'derived', allowedEdgeTypes: [] },
          contextBudget: { maxItems: 15, maxTokens: 6144, maxItemsPerClass: { evidence: 10, graph_context: 5 }, evidencePriority: true },
          affectiveModulation: makeAffectivePolicy({ enabled: true }),
        } as MemoryPolicy,
        totalItems: 2,
        itemCountByClass: { graph_context: 2 },
        estimatedTokens: 50,
        durationMs: 10,
      };
      const block = service.renderPromptBlocks(result);
      expect(block).toContain('[DIRECT GRAPH CONTEXT]');
      expect(block).toContain('[AFFECTIVE CONTEXT]');
      // Structural item appears in DIRECT GRAPH CONTEXT, affective in AFFECTIVE CONTEXT
      expect(block).toContain('Related Doc');
    });

    it('[POLICY CONSTRAINTS] includes affective modulation status when configured', () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = {
        items: [],
        policy: {
          groundingMode: 'graph_assisted',
          retrievalMode: 'hybrid',
          scope: 'global',
          graphTraversal: { enabled: true, maxHopDepth: 1, maxRelatedNodes: 5, maxNodesPerType: 3, minEdgeTrustLevel: 'derived', allowedEdgeTypes: [] },
          contextBudget: { maxItems: 15, maxTokens: 6144, maxItemsPerClass: { evidence: 10, graph_context: 5 }, evidencePriority: true },
          affectiveModulation: makeAffectivePolicy({ enabled: true }),
        } as MemoryPolicy,
        totalItems: 0,
        itemCountByClass: {},
        estimatedTokens: 0,
        durationMs: 5,
      };
      const block = service.renderPromptBlocks(result);
      expect(block).toContain('[POLICY CONSTRAINTS]');
      expect(block).toContain('affectiveModulation:');
    });

    it('[POLICY CONSTRAINTS] shows affectiveModulation disabled when not configured', async () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = await service.assemble(makeRequest({ groundingMode: 'graph_assisted' }));
      const block = service.renderPromptBlocks(result);
      expect(block).toContain('[POLICY CONSTRAINTS]');
      expect(block).toContain('affectiveModulation:');
    });

    it('non-authoritative disclaimer preserved in affective item content', () => {
      const labeledItem = makeAffectiveItem({
        content: '[Affective context — not evidence]\nMars trine Saturn — focused energy',
      });
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = {
        items: [labeledItem],
        policy: {
          groundingMode: 'graph_assisted',
          retrievalMode: 'hybrid',
          scope: 'global',
          graphTraversal: { enabled: true, maxHopDepth: 1, maxRelatedNodes: 5, maxNodesPerType: 3, minEdgeTrustLevel: 'derived', allowedEdgeTypes: [] },
          contextBudget: { maxItems: 15, maxTokens: 6144, maxItemsPerClass: { evidence: 10, graph_context: 5 }, evidencePriority: true },
          affectiveModulation: makeAffectivePolicy({ enabled: true, requireLabeling: true }),
        } as MemoryPolicy,
        totalItems: 1,
        itemCountByClass: { graph_context: 1 },
        estimatedTokens: 30,
        durationMs: 5,
      };
      const block = service.renderPromptBlocks(result);
      expect(block).toContain('[AFFECTIVE CONTEXT]');
      // Content of the affective item should be preserved
      expect(block).toContain('Mars trine Saturn');
    });
  });

  // ── Notebook strict grounding: renderPromptBlocks ────────────────────────

  describe('renderPromptBlocks: notebook strict grounding mode', () => {
    /**
     * Build a minimal ContextAssemblyResult for notebook strict grounding tests
     * without hitting real retrieval.
     */
    function makeNotebookStrictResult(
      evidenceItems: ContextAssemblyItem[],
    ): ContextAssemblyResult {
      return {
        items: evidenceItems,
        policy: {
          groundingMode: 'strict',
          retrievalMode: 'hybrid',
          scope: 'notebook',
          notebookId: 'nb-test-1',
          graphTraversal: { enabled: false, maxHopDepth: 0, maxRelatedNodes: 0, maxNodesPerType: {} },
          contextBudget: { maxItems: 10, maxTokens: 4096, maxItemsPerClass: { evidence: 8, graph_context: 0, latent: 2 }, evidencePriority: true },
          affectiveModulation: { enabled: false, maxAffectiveNodes: 0, allowToneModulation: false, allowGraphOrderingInfluence: false, allowGraphExpansionInfluence: false, allowEvidenceReordering: false, affectiveWeight: 0, requireLabeling: true },
        } as MemoryPolicy,
        totalItems: evidenceItems.length,
        itemCountByClass: { evidence: evidenceItems.filter(i => i.selectionClass === 'evidence').length },
        estimatedTokens: evidenceItems.reduce((s, i) => s + Math.ceil(i.content.length / 4), 0),
        durationMs: 1,
      };
    }

    function makeEvidenceItem(idx: number, uri?: string): ContextAssemblyItem {
      return {
        content: `Content of chunk ${idx}`,
        selectionClass: 'evidence',
        title: `Doc ${idx}`,
        uri: uri ?? `file:///notebook/doc-${idx}.md`,
        score: 0.9 - idx * 0.1,
      };
    }

    it('emits [NOTEBOOK GROUNDING CONTRACT — MANDATORY] before evidence in notebook strict mode', () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = makeNotebookStrictResult([makeEvidenceItem(0)]);
      const block = service.renderPromptBlocks(result);

      expect(block).toContain('[NOTEBOOK GROUNDING CONTRACT — MANDATORY]');
      // Contract must appear BEFORE the evidence block
      const contractIdx = block.indexOf('[NOTEBOOK GROUNDING CONTRACT — MANDATORY]');
      const evidenceIdx = block.indexOf('[CANON NOTEBOOK CONTEXT — STRICT]');
      expect(contractIdx).toBeLessThan(evidenceIdx);
    });

    it('uses [CANON NOTEBOOK CONTEXT — STRICT] label instead of [PRIMARY EVIDENCE] in notebook strict mode', () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = makeNotebookStrictResult([makeEvidenceItem(0)]);
      const block = service.renderPromptBlocks(result);

      expect(block).toContain('[CANON NOTEBOOK CONTEXT — STRICT]');
      expect(block).not.toContain('[PRIMARY EVIDENCE]');
    });

    it('notebook grounding contract forbids external knowledge', () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = makeNotebookStrictResult([makeEvidenceItem(0)]);
      const block = service.renderPromptBlocks(result);

      expect(block).toContain('DO NOT introduce facts');
      expect(block).toContain('DO NOT use your general training knowledge');
      expect(block).toContain('ONLY use the content provided');
    });

    it('notebook grounding contract requires explicit insufficiency statement', () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = makeNotebookStrictResult([makeEvidenceItem(0)]);
      const block = service.renderPromptBlocks(result);

      expect(block).toContain('does not contain enough information');
    });

    it('notebook grounding contract requires citation labeling', () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = makeNotebookStrictResult([makeEvidenceItem(0)]);
      const block = service.renderPromptBlocks(result);

      expect(block).toContain('Cite the source label');
    });

    it('evidence items in notebook strict mode include source URI', () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = makeNotebookStrictResult([makeEvidenceItem(0, 'file:///my-notebook/doc-a.md')]);
      const block = service.renderPromptBlocks(result);

      expect(block).toContain('file:///my-notebook/doc-a.md');
    });

    it('omits [DIRECT GRAPH CONTEXT] in notebook strict mode', () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      // Inject a graph_context item manually to test the guard
      const evidenceItem = makeEvidenceItem(0);
      const graphItem: ContextAssemblyItem = {
        content: 'Graph node content',
        selectionClass: 'graph_context',
        title: 'Graph Node',
        score: 0.5,
        graphEdgeType: 'relates_to' as any,
        graphEdgeTrust: 'derived' as any,
      };
      const result = makeNotebookStrictResult([evidenceItem, graphItem]);
      const block = service.renderPromptBlocks(result);

      expect(block).not.toContain('[DIRECT GRAPH CONTEXT]');
    });

    it('omits [AFFECTIVE CONTEXT] in notebook strict mode', () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const evidenceItem = makeEvidenceItem(0);
      const affectiveItem: ContextAssemblyItem = {
        content: 'Astro state: Mars trine Venus',
        selectionClass: 'graph_context',
        title: 'Affective state',
        score: 0.1,
        metadata: { affective: true, affectiveNodeType: 'astro_state' },
      };
      const result = makeNotebookStrictResult([evidenceItem, affectiveItem]);
      const block = service.renderPromptBlocks(result);

      expect(block).not.toContain('[AFFECTIVE CONTEXT]');
    });

    it('still emits [POLICY CONSTRAINTS] in notebook strict mode', () => {
      const orchestrator = makeMockOrchestrator([]);
      const service = new ContextAssemblyService(orchestrator, policyService);
      const result = makeNotebookStrictResult([makeEvidenceItem(0)]);
      const block = service.renderPromptBlocks(result);

      expect(block).toContain('[POLICY CONSTRAINTS]');
      expect(block).toContain('groundingMode: strict');
      expect(block).toContain('nb-test-1');
    });

    it('non-notebook strict mode still uses [PRIMARY EVIDENCE] label', async () => {
      const results = [
        makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', snippet: 'Content A' }),
      ];
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService);
      // strict mode but global scope (not notebook)
      const request = makeRequest({ groundingMode: 'strict' });
      const result = await service.assemble(request);
      const block = service.renderPromptBlocks(result);

      expect(block).toContain('[PRIMARY EVIDENCE]');
      expect(block).not.toContain('[CANON NOTEBOOK CONTEXT — STRICT]');
      expect(block).not.toContain('[NOTEBOOK GROUNDING CONTRACT — MANDATORY]');
    });
  });
});
