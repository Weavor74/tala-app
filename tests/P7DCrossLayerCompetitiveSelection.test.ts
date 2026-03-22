/**
 * P7DCrossLayerCompetitiveSelection.test.ts
 *
 * P7D specification tests — Cross-Layer Competitive Selection (Feed 3).
 *
 * Validates all P7D Feed 3 non-negotiable rules:
 *   1. ALL candidates (evidence + graph_context) compete under ONE global budget
 *   2. Per-layer quota enforcement is removed — no layer is guaranteed dominance
 *   3. Selection is greedy and deterministic: rank order, then global budget check
 *   4. New reason codes: included.cross_layer_top_rank,
 *                        excluded.cross_layer_budget_exceeded,
 *                        excluded.outcompeted_by_higher_rank
 *   5. Evidence overflow still goes to latent (not dropped)
 *   6. Graph_context overflow is excluded (not moved to latent)
 *   7. Per-document chunk cap still applies to evidence items
 *   8. Optional minimum canonical memory floor is respected
 *   9. Global token budget (maxTokens) is enforced when set
 *  10. All candidates produce ContextDecision records (no silent drops)
 *  11. included.high_authority co-emitted with included.cross_layer_top_rank
 *      when candidate has canonical authority tier
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

function makeCanonicalGraphItem(overrides: Partial<ContextAssemblyItem> = {}): ContextAssemblyItem {
  return {
    content: 'Canonical graph node content',
    selectionClass: 'graph_context',
    sourceType: 'graph_node',
    sourceKey: 'canonical_node:xyz',
    title: 'Canonical graph node',
    score: 1.0,
    graphEdgeType: 'contains',
    graphEdgeTrust: 'canonical',
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

function makeRequest(
  policyOverride: Partial<Parameters<ContextAssemblyService['assemble']>[0]['policy']> = {},
): ContextAssemblyRequest {
  return {
    query: 'cross-layer competitive selection test',
    policy: {
      groundingMode: 'graph_assisted',
      retrievalMode: 'hybrid',
      scope: 'global',
      graphTraversal: {
        enabled: true,
        maxHopDepth: 1,
        maxRelatedNodes: 10,
        maxNodesPerType: {},
      },
      contextBudget: { maxItems: 10 },
      ...policyOverride,
    } as Parameters<ContextAssemblyService['assemble']>[0]['policy'],
  };
}

const policyService = new MemoryPolicyService();

// ─── 1. Global budget replaces per-layer quotas ───────────────────────────────

describe('P7D Feed 3: global budget replaces per-layer quotas', () => {
  it('total included count does not exceed globalItemCap', async () => {
    const results = Array.from({ length: 4 }, (_, i) =>
      makeResult({ itemKey: `e${i}`, title: `Evidence ${i}`, providerId: 'local', score: 0.9 - i * 0.1 }),
    );
    const graphItems = [
      makeGraphContextItem({ sourceKey: 'g1', score: 0.8 }),
      makeGraphContextItem({ sourceKey: 'g2', score: 0.7 }),
      makeGraphContextItem({ sourceKey: 'g3', score: 0.6 }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const graphService = makeGraphServiceReturning(graphItems);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);

    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    const included = result.items.filter(i => i.selectionClass !== 'latent');
    expect(included.length).toBeLessThanOrEqual(5);
  });

  it('evidence and graph_context compete for the same global budget', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence', providerId: 'local', score: 0.5 }),
    ];
    // Canonical graph item — ranks above evidence (canonical authority > null)
    const graphItems = [
      makeCanonicalGraphItem({ sourceKey: 'g1' }),
      makeCanonicalGraphItem({ sourceKey: 'g2' }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const graphService = makeGraphServiceReturning(graphItems);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);

    // Budget = 2: canonical graph items rank first, may crowd out evidence
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 2 } }));

    const totalIncluded = result.items.filter(
      i => i.selectionClass === 'evidence' || i.selectionClass === 'graph_context',
    ).length;
    expect(totalIncluded).toBeLessThanOrEqual(2);
    expect(result.diagnostics!.totalIncluded).toBeLessThanOrEqual(2);
  });

  it('no layer guaranteed dominance: graph items included when they rank above evidence', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence A', providerId: 'local', score: 0.3 }),
    ];
    // Two canonical graph items (high authority tier = higher rank)
    const graphItems = [
      makeCanonicalGraphItem({ sourceKey: 'g1' }),
      makeCanonicalGraphItem({ sourceKey: 'g2' }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const graphService = makeGraphServiceReturning(graphItems);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);

    // Budget = 2: canonical graph items rank first, evidence may not fit
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 2 } }));

    const graphIncluded = result.items.filter(i => i.selectionClass === 'graph_context').length;
    expect(graphIncluded).toBeGreaterThanOrEqual(1);
  });
});

// ─── 2. New reason codes ──────────────────────────────────────────────────────

describe('P7D Feed 3: new reason codes emitted', () => {
  it('included candidates use included.cross_layer_top_rank reason', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence A', providerId: 'local', score: 0.9 }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    const d = result.diagnostics!;
    const includedDecisions = d.decisions.filter(dec => dec.status === 'included');
    expect(includedDecisions.length).toBeGreaterThan(0);
    for (const dec of includedDecisions) {
      expect(dec.reasons).toContain('included.cross_layer_top_rank');
    }
  });

  it('canonical candidates also carry included.high_authority alongside cross_layer_top_rank', async () => {
    const results: NormalizedSearchResult[] = [];
    const graphItems = [makeCanonicalGraphItem({ sourceKey: 'canon1' })];
    const orchestrator = makeMockOrchestrator(results);
    const graphService = makeGraphServiceReturning(graphItems);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    const d = result.diagnostics!;
    const canonDecision = d.decisions.find(dec => dec.candidateId === 'canon1');
    expect(canonDecision).toBeDefined();
    expect(canonDecision!.status).toBe('included');
    expect(canonDecision!.reasons).toContain('included.high_authority');
    expect(canonDecision!.reasons).toContain('included.cross_layer_top_rank');
  });

  it('budget-exceeded evidence items carry excluded.cross_layer_budget_exceeded + overflow.to_latent', async () => {
    const results = Array.from({ length: 4 }, (_, i) =>
      makeResult({ itemKey: `e${i}`, title: `Doc ${i}`, providerId: 'local', score: 0.9 - i * 0.1 }),
    );
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 2 } }));

    const d = result.diagnostics!;
    const latentDecisions = d.decisions.filter(dec => dec.status === 'latent');
    expect(latentDecisions.length).toBe(2);
    for (const dec of latentDecisions) {
      expect(dec.reasons).toContain('excluded.cross_layer_budget_exceeded');
      expect(dec.reasons).toContain('overflow.to_latent');
    }
  });

  it('budget-exceeded graph_context items carry excluded.cross_layer_budget_exceeded', async () => {
    const graphItems = [
      makeGraphContextItem({ sourceKey: 'g1', score: 0.9 }),
      makeGraphContextItem({ sourceKey: 'g2', score: 0.8 }),
      makeGraphContextItem({ sourceKey: 'g3', score: 0.7 }),
    ];
    const orchestrator = makeMockOrchestrator([]);
    const graphService = makeGraphServiceReturning(graphItems);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 2 } }));

    const d = result.diagnostics!;
    const excludedGraph = d.decisions.filter(
      dec => dec.layerAssignment === 'graph_context' && dec.status === 'excluded',
    );
    expect(excludedGraph.length).toBe(1);
    expect(excludedGraph[0]!.reasons).toContain('excluded.cross_layer_budget_exceeded');
    // Graph items are NOT moved to latent — they are excluded
    const latentDecisions = d.decisions.filter(dec => dec.status === 'latent');
    expect(latentDecisions.length).toBe(0);
  });

  it('per-document cap carries excluded.outcompeted_by_higher_rank reason', async () => {
    // 3 chunks from the same doc; per-doc cap = ceil(2/2)=1, global cap = 2
    const results = Array.from({ length: 3 }, (_, i) =>
      makeResult({
        itemKey: `chunk-${i}`,
        title: `Chunk ${i}`,
        providerId: 'local',
        metadata: { documentId: 'doc-1', chunkContent: `chunk content ${i}` },
      }),
    );
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 2 } }));

    const d = result.diagnostics!;
    const perDocExcluded = d.decisions.filter(
      dec => dec.reasons.includes('excluded.outcompeted_by_higher_rank'),
    );
    expect(perDocExcluded.length).toBeGreaterThan(0);
    for (const dec of perDocExcluded) {
      expect(dec.reasons).toContain('excluded.per_document_cap');
      expect(dec.reasons).toContain('overflow.to_latent');
    }
  });
});

// ─── 3. Greedy + deterministic selection ─────────────────────────────────────

describe('P7D Feed 3: greedy and deterministic selection', () => {
  it('items are selected in rank order until global budget is exhausted', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Doc A', providerId: 'local', score: 0.9 }),
      makeResult({ itemKey: 'e2', title: 'Doc B', providerId: 'local', score: 0.7 }),
      makeResult({ itemKey: 'e3', title: 'Doc C', providerId: 'local', score: 0.5 }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 2 } }));

    const included = result.items.filter(i => i.selectionClass === 'evidence');
    expect(included.length).toBe(2);
    // Highest-scored items should be included (top-ranked first)
    const includedKeys = included.map(i => i.sourceKey);
    expect(includedKeys).toContain('e1');
    expect(includedKeys).toContain('e2');
    expect(includedKeys).not.toContain('e3');
  });

  it('same inputs produce identical selection across multiple runs (determinism)', async () => {
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
      return service.assemble(makeRequest({ contextBudget: { maxItems: 4 } }));
    };

    const resultA = await runAssembly();
    const resultB = await runAssembly();

    expect(resultA.items.map(i => i.sourceKey)).toEqual(resultB.items.map(i => i.sourceKey));
  });

  it('every candidate produces exactly one decision record (no silent drops)', async () => {
    const results = Array.from({ length: 3 }, (_, i) =>
      makeResult({ itemKey: `e${i}`, title: `Doc ${i}`, providerId: 'local' }),
    );
    const graphItems = [
      makeGraphContextItem({ sourceKey: 'g1' }),
      makeGraphContextItem({ sourceKey: 'g2' }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const graphService = makeGraphServiceReturning(graphItems);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 3 } }));

    const d = result.diagnostics!;
    // 3 evidence + 2 graph = 5 total candidates → 5 decisions
    expect(d.decisions.length).toBe(5);
    expect(d.totalCandidatesConsidered).toBe(5);
  });
});

// ─── 4. Evidence overflow goes to latent; graph overflow is excluded ──────────

describe('P7D Feed 3: overflow routing by layer', () => {
  it('evidence items beyond global budget are moved to latent, not dropped', async () => {
    const results = Array.from({ length: 4 }, (_, i) =>
      makeResult({ itemKey: `e${i}`, title: `Doc ${i}`, providerId: 'local', score: 0.9 - i * 0.1 }),
    );
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 2 } }));

    const evidence = result.items.filter(i => i.selectionClass === 'evidence');
    const latent = result.items.filter(i => i.selectionClass === 'latent');
    expect(evidence.length).toBe(2);
    expect(latent.length).toBe(2);
    // Total items = 4 (included + latent)
    expect(result.items.length).toBe(4);
  });

  it('graph_context items beyond global budget are excluded (not moved to latent)', async () => {
    const graphItems = Array.from({ length: 4 }, (_, i) =>
      makeGraphContextItem({ sourceKey: `g${i}`, score: 0.9 - i * 0.1 }),
    );
    const orchestrator = makeMockOrchestrator([]);
    const graphService = makeGraphServiceReturning(graphItems);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 2 } }));

    const graphIncluded = result.items.filter(i => i.selectionClass === 'graph_context');
    const latent = result.items.filter(i => i.selectionClass === 'latent');
    expect(graphIncluded.length).toBe(2);
    expect(latent.length).toBe(0); // graph items are excluded, not latent

    const d = result.diagnostics!;
    expect(d.excludedCandidates.length).toBe(2);
    expect(d.latentCandidates.length).toBe(0);
  });

  it('latent items preserve metadata and full content', async () => {
    const results = [
      makeResult({
        itemKey: 'e1', title: 'Doc A', providerId: 'local', score: 0.9,
        metadata: { documentId: 'doc-1', citationLabel: 'Source A' },
      }),
      makeResult({
        itemKey: 'e2', title: 'Doc B', providerId: 'local', score: 0.7,
        metadata: { documentId: 'doc-2', citationLabel: 'Source B' },
      }),
      makeResult({
        itemKey: 'e3', title: 'Doc C', providerId: 'local', score: 0.5,
        metadata: { documentId: 'doc-3', citationLabel: 'Source C' },
      }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 2 } }));

    const latent = result.items.filter(i => i.selectionClass === 'latent');
    expect(latent.length).toBe(1);
    expect(latent[0]!.metadata).toBeDefined();
    expect(latent[0]!.metadata?.citationLabel).toBe('Source C');
  });
});

// ─── 5. Per-document chunk cap still applies ──────────────────────────────────

describe('P7D Feed 3: per-document chunk cap preserved', () => {
  it('caps chunks from same document at ceil(globalItemCap / 2)', async () => {
    // 4 chunks from same doc, global cap = 4 → per-doc cap = ceil(4/2) = 2
    const results = Array.from({ length: 4 }, (_, i) =>
      makeResult({
        itemKey: `chunk-${i}`,
        title: `Chunk ${i}`,
        providerId: 'local',
        metadata: { documentId: 'doc-1', chunkContent: `Content chunk ${i}` },
      }),
    );
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 4 } }));

    const fromDoc1 = result.items.filter(
      i => (i.selectionClass === 'evidence') && (i.metadata?.documentId as string) === 'doc-1',
    );
    expect(fromDoc1.length).toBeLessThanOrEqual(2);
  });

  it('per-document cap does not apply when documentId is absent', async () => {
    const results = Array.from({ length: 3 }, (_, i) =>
      makeResult({ itemKey: `e${i}`, title: `Doc ${i}`, providerId: 'local' }),
    );
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    const evidence = result.items.filter(i => i.selectionClass === 'evidence');
    expect(evidence.length).toBe(3);
  });
});

// ─── 6. Optional minimum canonical memory floor ──────────────────────────────

describe('P7D Feed 3: optional minimum canonical memory floor', () => {
  it('minCanonicalItems=0 has no effect (default behavior)', async () => {
    const results = Array.from({ length: 3 }, (_, i) =>
      makeResult({ itemKey: `e${i}`, title: `Doc ${i}`, providerId: 'local', score: 0.9 - i * 0.1 }),
    );
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({
      contextBudget: { maxItems: 2, minCanonicalItems: 0 },
    }));

    const included = result.items.filter(i => i.selectionClass === 'evidence');
    expect(included.length).toBe(2);
  });

  it('canonical items are naturally included first via authority ranking (no floor needed)', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Low score evidence', providerId: 'local', score: 0.1 }),
    ];
    // Canonical graph item ranks first (canonical authority > null)
    const graphItems = [makeCanonicalGraphItem({ sourceKey: 'canon1' })];
    const orchestrator = makeMockOrchestrator(results);
    const graphService = makeGraphServiceReturning(graphItems);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 1 } }));

    // Canonical item should be included even with tight budget (it ranks first)
    const d = result.diagnostics!;
    const canonDecision = d.decisions.find(dec => dec.candidateId === 'canon1');
    expect(canonDecision?.status).toBe('included');
    expect(canonDecision?.authorityTier).toBe('canonical');
  });

  it('minCanonicalItems floor includes canonical items even when budget is tight', async () => {
    // Evidence items that would normally fill the budget
    const results = Array.from({ length: 3 }, (_, i) =>
      makeResult({ itemKey: `e${i}`, title: `Evidence ${i}`, providerId: 'local', score: 0.9 - i * 0.1 }),
    );
    // Canonical graph items (high authority — already rank first, but floor ensures minimum)
    const graphItems = [
      makeCanonicalGraphItem({ sourceKey: 'canon1' }),
      makeCanonicalGraphItem({ sourceKey: 'canon2' }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const graphService = makeGraphServiceReturning(graphItems);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({
      contextBudget: { maxItems: 3, minCanonicalItems: 2 },
    }));

    const d = result.diagnostics!;
    const canonIncluded = d.decisions.filter(
      dec => dec.status === 'included' && dec.authorityTier === 'canonical',
    );
    expect(canonIncluded.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── 7. Global token budget enforcement ──────────────────────────────────────

describe('P7D Feed 3: global token budget (maxTokens) enforcement', () => {
  it('stops including when accumulated token cost exceeds maxTokens', async () => {
    // Each item has ~4-char content → ~1 token. maxTokens=1 allows only 1 item.
    const results = [
      makeResult({ itemKey: 'e1', title: 'A', providerId: 'local', snippet: 'A' }),
      makeResult({ itemKey: 'e2', title: 'B', providerId: 'local', snippet: 'B' }),
      makeResult({ itemKey: 'e3', title: 'C', providerId: 'local', snippet: 'C' }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({
      contextBudget: { maxItems: 10, maxTokens: 1 },
    }));

    const included = result.items.filter(i => i.selectionClass === 'evidence');
    // With maxTokens=1 and ~1 token per item, only the first item fits
    expect(included.length).toBeLessThanOrEqual(1);
  });

  it('token budget exhaustion uses excluded.cross_layer_budget_exceeded reason', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'A', providerId: 'local', snippet: 'short' }),
      makeResult({ itemKey: 'e2', title: 'B', providerId: 'local', snippet: 'short too' }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    // maxTokens=1 means the second item cannot fit
    const result = await service.assemble(makeRequest({
      contextBudget: { maxItems: 10, maxTokens: 1 },
    }));

    const d = result.diagnostics!;
    const budgetExceeded = d.decisions.filter(
      dec => dec.reasons.includes('excluded.cross_layer_budget_exceeded'),
    );
    expect(budgetExceeded.length).toBeGreaterThan(0);
  });
});

// ─── 8. Diagnostics completeness ──────────────────────────────────────────────

describe('P7D Feed 3: diagnostics completeness', () => {
  it('diagnostics.decisions count equals total candidates considered', async () => {
    const results = Array.from({ length: 3 }, (_, i) =>
      makeResult({ itemKey: `e${i}`, title: `Doc ${i}`, providerId: 'local' }),
    );
    const graphItems = [
      makeGraphContextItem({ sourceKey: 'g1' }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const graphService = makeGraphServiceReturning(graphItems);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 2 } }));

    const d = result.diagnostics!;
    expect(d.decisions.length).toBe(d.totalCandidatesConsidered);
  });

  it('totalIncluded matches the count of included decisions', async () => {
    const results = Array.from({ length: 4 }, (_, i) =>
      makeResult({ itemKey: `e${i}`, title: `Doc ${i}`, providerId: 'local' }),
    );
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 3 } }));

    const d = result.diagnostics!;
    expect(d.totalIncluded).toBe(d.includedCandidates.length);
    expect(d.totalIncluded).toBe(3);
  });

  it('candidatePoolByLayer contains all ranked candidates split by layer', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence', providerId: 'local' }),
    ];
    const graphItems = [makeGraphContextItem({ sourceKey: 'g1' })];
    const orchestrator = makeMockOrchestrator(results);
    const graphService = makeGraphServiceReturning(graphItems);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 10 } }));

    const d = result.diagnostics!;
    expect(d.candidatePoolByLayer['evidence']).toBeDefined();
    expect(d.candidatePoolByLayer['graph_context']).toBeDefined();
    expect(d.candidatePoolByLayer['evidence']!.length).toBe(1);
    expect(d.candidatePoolByLayer['graph_context']!.length).toBe(1);
  });

  it('finalTokenUsageByLayer reflects actual included items per layer', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'E', providerId: 'local', snippet: 'Evidence content' }),
    ];
    const graphItems = [
      makeGraphContextItem({ sourceKey: 'g1', content: 'Graph content' }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const graphService = makeGraphServiceReturning(graphItems);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 10 } }));

    const d = result.diagnostics!;
    expect(d.finalTokenUsageByLayer['evidence']).toBeGreaterThan(0);
    expect(d.finalTokenUsageByLayer['graph_context']).toBeGreaterThan(0);
  });
});
