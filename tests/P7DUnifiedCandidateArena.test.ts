/**
 * P7DUnifiedCandidateArena.test.ts
 *
 * P7D specification tests — Cross-Layer Competitive Ranking (Feed 1: Unified Candidate Arena).
 *
 * Validates all P7D non-negotiable rules:
 *   1. All candidates compete in ONE unified scoring + ranking pass
 *   2. No layer is ranked independently before scoring
 *   3. All candidates carry P7D source metadata (sourceLayer, isCanonical, canonicalId)
 *   4. Existing P7B scoring formulas remain intact
 *   5. Existing P7C affective weighting remains intact (per-layer gates still apply)
 *   6. Pipeline is still deterministic after unification
 *   7. Layer-specific budget enforcement still applies after unified ranking
 *   8. Evidence budget cap is still enforced post-ranking
 *   9. Graph_context budget cap is still enforced post-ranking
 *  10. sourceLayer is 'rag' for retrieval evidence, 'graph' for graph_context
 *  11. isCanonical is false for retrieval evidence (authorityTier null)
 *  12. isCanonical is true only for graph items with canonical edge trust
 *
 * Uses mocked RetrievalOrchestrator and AffectiveGraphService — no real DB or network.
 */

import { describe, it, expect, vi } from 'vitest';
import { ContextAssemblyService } from '../electron/services/context/ContextAssemblyService';
import { MemoryPolicyService } from '../electron/services/policy/MemoryPolicyService';
import { GraphTraversalService } from '../electron/services/graph/GraphTraversalService';
import type { AffectiveGraphService } from '../electron/services/graph/AffectiveGraphService';
import type { RetrievalOrchestrator } from '../electron/services/retrieval/RetrievalOrchestrator';
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
    snippet: overrides.snippet ?? `Content for ${overrides.title}`,
    sourceType: null,
    externalId: null,
    contentHash: null,
    score: null,
    metadata: {},
    ...overrides,
  };
}

function makeScopeResolved(): RetrievalScopeResolved {
  return { scopeType: 'global', uris: [], sourcePaths: [], itemKeys: [] };
}

function makeRetrievalResponse(results: NormalizedSearchResult[]): RetrievalResponse {
  return {
    query: 'test',
    mode: 'hybrid',
    scopeResolved: makeScopeResolved(),
    results,
    providerResults: [],
    totalResults: results.length,
    durationMs: 2,
  };
}

function makeMockOrchestrator(results: NormalizedSearchResult[]): RetrievalOrchestrator {
  return {
    retrieve: vi.fn().mockResolvedValue(makeRetrievalResponse(results)),
  } as unknown as RetrievalOrchestrator;
}

function makeNoopGraphService(): GraphTraversalService {
  return {
    expandFromEvidence: vi.fn().mockResolvedValue([]),
  } as unknown as GraphTraversalService;
}

function makeGraphServiceReturning(items: ContextAssemblyItem[]): GraphTraversalService {
  return {
    expandFromEvidence: vi.fn().mockResolvedValue(items),
  } as unknown as GraphTraversalService;
}

function makeMockAffectiveService(items: ContextAssemblyItem[]): AffectiveGraphService {
  return {
    getActiveAffectiveContext: vi.fn().mockResolvedValue(items),
  } as unknown as AffectiveGraphService;
}

function makeAffectiveItem(overrides: Partial<ContextAssemblyItem> = {}): ContextAssemblyItem {
  return {
    content: '[Affective context — not evidence]',
    selectionClass: 'graph_context',
    sourceType: 'astro_state',
    sourceKey: 'astro_state:global',
    title: 'Affective state',
    score: 0.1,
    graphEdgeType: 'modulates',
    graphEdgeTrust: 'session_only',
    metadata: {
      affective: true,
      affectiveNodeType: 'astro_state',
      rawAstroState: null,
    },
    ...overrides,
  };
}

function makeGraphContextItem(overrides: Partial<ContextAssemblyItem> = {}): ContextAssemblyItem {
  return {
    content: 'Graph node content',
    selectionClass: 'graph_context',
    sourceType: 'graph_node',
    sourceKey: 'graph_node:abc',
    title: 'Graph node',
    score: 0.5,
    graphEdgeType: 'contains',
    graphEdgeTrust: 'derived',
    metadata: {},
    ...overrides,
  };
}

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

function makeRequest(policyOverride: Partial<MemoryPolicy> = {}): ContextAssemblyRequest {
  return {
    query: 'test query',
    policy: { groundingMode: 'graph_assisted', ...policyOverride } as MemoryPolicy,
  };
}

const policyService = new MemoryPolicyService();

// ─── 1. Unified single-pass ranking ──────────────────────────────────────────

describe('P7D: unified candidate arena', () => {
  it('evidence and graph_context candidates both appear in diagnostics after assembly', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence A', providerId: 'local', score: 0.9 }),
      makeResult({ itemKey: 'e2', title: 'Evidence B', providerId: 'local', score: 0.8 }),
    ];
    const graphItem = makeGraphContextItem({ sourceKey: 'g1' });
    const orchestrator = makeMockOrchestrator(results);
    const graphService = makeGraphServiceReturning([graphItem]);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({
      contextBudget: { maxItems: 5, maxItemsPerClass: { graph_context: 3 } },
    }));

    const d = result.diagnostics!;
    expect(d.candidatePoolByLayer['evidence']).toBeDefined();
    expect(d.candidatePoolByLayer['graph_context']).toBeDefined();
    expect(d.candidatePoolByLayer['evidence']!.length).toBe(2);
    expect(d.candidatePoolByLayer['graph_context']!.length).toBe(1);
    // All candidates are considered
    expect(d.totalCandidatesConsidered).toBe(3);
  });

  it('totalCandidatesConsidered includes both evidence and graph candidates', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence A', providerId: 'local', score: 0.9 }),
      makeResult({ itemKey: 'e2', title: 'Evidence B', providerId: 'local', score: 0.8 }),
      makeResult({ itemKey: 'e3', title: 'Evidence C', providerId: 'local', score: 0.7 }),
    ];
    const graphItems = [
      makeGraphContextItem({ sourceKey: 'g1' }),
      makeGraphContextItem({ sourceKey: 'g2', score: 0.4 }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const graphService = makeGraphServiceReturning(graphItems);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({
      contextBudget: { maxItems: 5, maxItemsPerClass: { graph_context: 3 } },
    }));

    // 3 evidence + 2 graph = 5 total
    expect(result.diagnostics!.totalCandidatesConsidered).toBe(5);
  });

  it('decisions cover every candidate — no candidate is silently dropped', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence A', providerId: 'local', score: 0.9 }),
      makeResult({ itemKey: 'e2', title: 'Evidence B', providerId: 'local', score: 0.8 }),
    ];
    const graphItem = makeGraphContextItem({ sourceKey: 'g1' });
    const orchestrator = makeMockOrchestrator(results);
    const graphService = makeGraphServiceReturning([graphItem]);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({
      contextBudget: { maxItems: 5, maxItemsPerClass: { graph_context: 3 } },
    }));

    const d = result.diagnostics!;
    // 3 candidates → 3 decisions
    expect(d.decisions.length).toBe(3);
    const decisionIds = new Set(d.decisions.map(dec => dec.candidateId));
    expect(decisionIds.has('e1')).toBe(true);
    expect(decisionIds.has('e2')).toBe(true);
    expect(decisionIds.has('g1')).toBe(true);
  });
});

// ─── 2. P7D source metadata ───────────────────────────────────────────────────

describe('P7D: source metadata on candidates', () => {
  it('evidence candidates have sourceLayer rag in diagnostics candidatePool', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence A', providerId: 'local', score: 0.9 }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    const pool = result.diagnostics!.candidatePoolByLayer['evidence']!;
    expect(pool.length).toBe(1);
    expect(pool[0]!.sourceLayer).toBe('rag');
  });

  it('graph_context candidates have sourceLayer graph in diagnostics candidatePool', async () => {
    const orchestrator = makeMockOrchestrator([]);
    const graphItem = makeGraphContextItem({ sourceKey: 'g1' });
    const graphService = makeGraphServiceReturning([graphItem]);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({
      contextBudget: { maxItems: 5, maxItemsPerClass: { graph_context: 3 } },
    }));

    const pool = result.diagnostics!.candidatePoolByLayer['graph_context']!;
    expect(pool.length).toBe(1);
    expect(pool[0]!.sourceLayer).toBe('graph');
  });

  it('evidence candidates have isCanonical=false (retrieval items have null authority)', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence A', providerId: 'local', score: 0.9 }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    const pool = result.diagnostics!.candidatePoolByLayer['evidence']!;
    expect(pool[0]!.isCanonical).toBe(false);
  });

  it('graph_context items with canonical edge trust have isCanonical=true', async () => {
    const orchestrator = makeMockOrchestrator([]);
    const canonicalGraphItem = makeGraphContextItem({
      sourceKey: 'g_canonical',
      graphEdgeTrust: 'canonical',
    });
    const graphService = makeGraphServiceReturning([canonicalGraphItem]);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({
      contextBudget: { maxItems: 5, maxItemsPerClass: { graph_context: 3 } },
    }));

    const pool = result.diagnostics!.candidatePoolByLayer['graph_context']!;
    expect(pool.length).toBe(1);
    expect(pool[0]!.isCanonical).toBe(true);
  });

  it('graph_context items with derived edge trust have isCanonical=false', async () => {
    const orchestrator = makeMockOrchestrator([]);
    const derivedGraphItem = makeGraphContextItem({
      sourceKey: 'g_derived',
      graphEdgeTrust: 'derived',
    });
    const graphService = makeGraphServiceReturning([derivedGraphItem]);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({
      contextBudget: { maxItems: 5, maxItemsPerClass: { graph_context: 3 } },
    }));

    const pool = result.diagnostics!.candidatePoolByLayer['graph_context']!;
    expect(pool[0]!.isCanonical).toBe(false);
  });

  it('canonicalId is set from metadata.canonicalId when present', async () => {
    const orchestrator = makeMockOrchestrator([]);
    const graphItemWithCanonicalId = makeGraphContextItem({
      sourceKey: 'g1',
      metadata: { canonicalId: 'canon-record-xyz' },
    });
    const graphService = makeGraphServiceReturning([graphItemWithCanonicalId]);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({
      contextBudget: { maxItems: 5, maxItemsPerClass: { graph_context: 3 } },
    }));

    const pool = result.diagnostics!.candidatePoolByLayer['graph_context']!;
    expect(pool[0]!.canonicalId).toBe('canon-record-xyz');
  });

  it('canonicalId is undefined when metadata.canonicalId is absent', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence A', providerId: 'local', score: 0.9 }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    const pool = result.diagnostics!.candidatePoolByLayer['evidence']!;
    expect(pool[0]!.canonicalId).toBeUndefined();
  });
});

// ─── 3. P7B scoring intact in unified pool ────────────────────────────────────

describe('P7D: P7B scoring formulas intact after unification', () => {
  it('score breakdowns are present for all candidates in unified pool', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence A', providerId: 'local', score: 0.9 }),
    ];
    const graphItem = makeGraphContextItem({ sourceKey: 'g1', score: 0.5 });
    const orchestrator = makeMockOrchestrator(results);
    const graphService = makeGraphServiceReturning([graphItem]);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({
      contextBudget: { maxItems: 5, maxItemsPerClass: { graph_context: 3 } },
    }));

    const d = result.diagnostics!;
    for (const [, pool] of Object.entries(d.candidatePoolByLayer)) {
      for (const c of pool ?? []) {
        expect(c.scoreBreakdown).toBeDefined();
        expect(typeof c.scoreBreakdown.finalScore).toBe('number');
        expect(typeof c.scoreBreakdown.semanticScore).toBe('number');
        expect(typeof c.scoreBreakdown.authorityScore).toBe('number');
        expect(typeof c.scoreBreakdown.recencyScore).toBe('number');
      }
    }
  });

  it('same inputs produce identical assembly results across multiple runs (determinism)', async () => {
    const results = [
      makeResult({ itemKey: 'e3', title: 'Doc C', providerId: 'local', score: 0.7 }),
      makeResult({ itemKey: 'e1', title: 'Doc A', providerId: 'local', score: 0.9 }),
      makeResult({ itemKey: 'e2', title: 'Doc B', providerId: 'local', score: 0.8 }),
    ];
    const graphItems = [
      makeGraphContextItem({ sourceKey: 'g1', score: 0.6 }),
    ];

    const runAssembly = async () => {
      const orchestrator = makeMockOrchestrator(results);
      const graphService = makeGraphServiceReturning(graphItems);
      const service = new ContextAssemblyService(orchestrator, policyService, graphService);
      return service.assemble(makeRequest({
        contextBudget: { maxItems: 10, maxItemsPerClass: { graph_context: 3 } },
      }));
    };

    const resultA = await runAssembly();
    const resultB = await runAssembly();

    expect(resultA.items.map(i => i.sourceKey)).toEqual(resultB.items.map(i => i.sourceKey));
  });
});

// ─── 4. P7C affective weighting intact in unified pool ───────────────────────

describe('P7D: P7C affective weighting gates intact after unification', () => {
  it('affective items appear as graph_context candidates in unified pool', async () => {
    const orchestrator = makeMockOrchestrator([]);
    const affectiveItem = makeAffectiveItem({ sourceKey: 'aff1' });
    const affectiveService = makeMockAffectiveService([affectiveItem]);
    const service = new ContextAssemblyService(
      orchestrator, policyService, makeNoopGraphService(), affectiveService,
    );
    const result = await service.assemble(makeRequest({
      groundingMode: 'graph_assisted',
      affectiveModulation: makeAffectivePolicy({ enabled: true }),
      contextBudget: { maxItems: 10, maxItemsPerClass: { graph_context: 5 } },
    }));

    const d = result.diagnostics!;
    expect(d.candidatePoolByLayer['graph_context']).toBeDefined();
    const affPool = d.candidatePoolByLayer['graph_context']!;
    expect(affPool.length).toBeGreaterThan(0);
    // Affective items should carry sourceLayer 'graph'
    for (const c of affPool) {
      expect(c.sourceLayer).toBe('graph');
    }
  });

  it('affective weighting reason codes are present in unified pool candidates', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Warmth evidence', providerId: 'local', score: 0.7 }),
    ];
    const affectiveItem = makeAffectiveItem({
      sourceKey: 'aff1',
      metadata: {
        affective: true,
        affectiveNodeType: 'emotion_tag',
        moodLabel: 'warmth',
        rawAstroState: null,
      },
    });
    const orchestrator = makeMockOrchestrator(results);
    const affectiveService = makeMockAffectiveService([affectiveItem]);
    const service = new ContextAssemblyService(
      orchestrator, policyService, makeNoopGraphService(), affectiveService,
    );
    const result = await service.assemble(makeRequest({
      groundingMode: 'graph_assisted',
      affectiveModulation: makeAffectivePolicy({
        enabled: true,
        allowEvidenceReordering: false,
        allowGraphOrderingInfluence: false,
      }),
      contextBudget: { maxItems: 10, maxItemsPerClass: { graph_context: 5 } },
    }));

    const d = result.diagnostics!;
    // Evidence candidates should have an affective reason code (layer_not_eligible)
    const evidencePool = d.candidatePoolByLayer['evidence']!;
    for (const c of evidencePool) {
      expect(c.affectiveReasonCode).toBeDefined();
    }
    // Graph candidates should also have a reason code
    const graphPool = d.candidatePoolByLayer['graph_context'];
    if (graphPool && graphPool.length > 0) {
      for (const c of graphPool) {
        expect(c.affectiveReasonCode).toBeDefined();
      }
    }
  });
});

// ─── 5. Layer budget enforcement post-unification ─────────────────────────────

describe('P7D: layer budget enforcement still applies after unified ranking', () => {
  it('evidence budget cap is enforced: excess evidence moves to latent', async () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeResult({ itemKey: `e${i}`, title: `Doc ${i}`, providerId: 'local', score: 0.9 - i * 0.1 }),
    );
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 3 } }));

    const evidence = result.items.filter(i => i.selectionClass === 'evidence');
    const latent = result.items.filter(i => i.selectionClass === 'latent');
    expect(evidence.length).toBe(3);
    expect(latent.length).toBe(2);
  });

  it('graph_context budget cap is enforced: excess graph candidates excluded', async () => {
    const orchestrator = makeMockOrchestrator([]);
    const graphItems = [
      makeGraphContextItem({ sourceKey: 'g1', score: 0.9 }),
      makeGraphContextItem({ sourceKey: 'g2', score: 0.8 }),
      makeGraphContextItem({ sourceKey: 'g3', score: 0.7 }),
    ];
    const graphService = makeGraphServiceReturning(graphItems);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({
      contextBudget: { maxItems: 10, maxItemsPerClass: { graph_context: 2 } },
    }));

    const graphInResult = result.items.filter(i => i.selectionClass === 'graph_context');
    expect(graphInResult.length).toBe(2);

    const d = result.diagnostics!;
    const excludedGraph = d.decisions.filter(
      dec => dec.layerAssignment === 'graph_context' && dec.status === 'excluded',
    );
    expect(excludedGraph.length).toBe(1);
  });

  it('evidence and graph_context items both survive to result when within budget', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence A', providerId: 'local', score: 0.9 }),
      makeResult({ itemKey: 'e2', title: 'Evidence B', providerId: 'local', score: 0.8 }),
    ];
    const graphItem = makeGraphContextItem({ sourceKey: 'g1', score: 0.7 });
    const orchestrator = makeMockOrchestrator(results);
    const graphService = makeGraphServiceReturning([graphItem]);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({
      contextBudget: { maxItems: 5, maxItemsPerClass: { graph_context: 2 } },
    }));

    const evidence = result.items.filter(i => i.selectionClass === 'evidence');
    const graph = result.items.filter(i => i.selectionClass === 'graph_context');
    expect(evidence.length).toBe(2);
    expect(graph.length).toBe(1);
  });
});
