/**
 * P7DCrossLayerAuthorityEnforcement.test.ts
 *
 * P7D specification tests — Cross-Layer Authority Enforcement (Feed 4).
 *
 * Validates all P7D Feed 4 non-negotiable rules:
 *   1. Canonical candidate always outranks derived candidates for the same canonicalId
 *   2. Derived candidates suppressed by canonical receive 'excluded.superseded_by_canonical'
 *   3. Derived candidates included alongside canonical receive 'included.supporting_derived'
 *   4. Non-canonical authority conflicts produce 'excluded.authority_conflict'
 *   5. Layer hierarchy: canonical_memory > mem0 > graph > rag
 *   6. Affective weighting MUST NOT override authority enforcement
 *   7. Conflicts are visible in diagnostics.conflictResolutionRecords
 *   8. Canonical winners have conflictResolved=true in their decision record
 *   9. No derived item outranks a canonical candidate for the same canonicalId
 *  10. Candidates with no canonicalId are not involved in any conflict
 *  11. resolveMemoryAuthorityConflict() is independently testable
 *
 * Uses mocked RetrievalOrchestrator and GraphTraversalService — no real DB or network.
 */

import { describe, it, expect, vi } from 'vitest';
import { ContextAssemblyService } from '../electron/services/context/ContextAssemblyService';
import { MemoryPolicyService } from '../electron/services/policy/MemoryPolicyService';
import { GraphTraversalService } from '../electron/services/graph/GraphTraversalService';
import {
  resolveMemoryAuthorityConflict,
  AUTHORITY_LAYER_PRIORITY,
} from '../electron/services/context/authorityConflictResolver';
import type { RetrievalOrchestrator } from '../electron/services/retrieval/RetrievalOrchestrator';
import type {
  NormalizedSearchResult,
  RetrievalResponse,
  RetrievalScopeResolved,
} from '../shared/retrieval/retrievalTypes';
import type {
  ContextAssemblyRequest,
  ContextAssemblyItem,
} from '../shared/policy/memoryPolicyTypes';
import type { RankedContextCandidate } from '../shared/context/contextDeterminismTypes';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    score: overrides.score ?? 0.5,
    metadata: overrides.metadata ?? {},
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
    sourceKey: `graph_node:${overrides.sourceKey ?? 'abc'}`,
    title: 'Graph node',
    score: 0.5,
    graphEdgeType: 'contains',
    graphEdgeTrust: 'derived',
    metadata: overrides.metadata ?? {},
    ...overrides,
  };
}

function makeRequest(
  policyOverride: Partial<Parameters<ContextAssemblyService['assemble']>[0]['policy']> = {},
): ContextAssemblyRequest {
  return {
    query: 'authority enforcement test',
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

/** Build a minimal RankedContextCandidate for unit-testing the resolver. */
function makeRanked(
  id: string,
  opts: {
    sourceLayer?: string;
    isCanonical?: boolean;
    authorityTier?: 'canonical' | 'verified_derived' | 'transient' | 'speculative' | null;
    canonicalId?: string;
    score?: number;
  } = {},
): RankedContextCandidate {
  return {
    id,
    content: `Content for ${id}`,
    selectionClass: 'evidence',
    layerAssignment: 'evidence',
    estimatedTokens: 50,
    score: opts.score ?? 0.5,
    authorityTier: opts.authorityTier ?? null,
    sourceLayer: opts.sourceLayer,
    isCanonical: opts.isCanonical ?? false,
    canonicalId: opts.canonicalId,
    rank: 1,
    scoreBreakdown: {
      semanticScore: opts.score ?? 0.5,
      recencyScore: 0.5,
      authorityScore: 0.5,
      sourceWeight: 1.0,
      graphDepthPenalty: 0,
      affectiveAdjustment: 0,
      finalScore: opts.score ?? 0.5,
      tokenEfficiency: 0.67,
      normalizedScore: (opts.score ?? 0.5) * 0.67,
    },
    affectiveReasonCode: null,
  };
}

const policyService = new MemoryPolicyService();

// ─── 1. AUTHORITY_LAYER_PRIORITY constant ─────────────────────────────────────

describe('P7D Feed 4: AUTHORITY_LAYER_PRIORITY hierarchy', () => {
  it('canonical_memory has the lowest (highest authority) priority number', () => {
    expect(AUTHORITY_LAYER_PRIORITY['canonical_memory']).toBeLessThan(
      AUTHORITY_LAYER_PRIORITY['mem0']!,
    );
  });

  it('mem0 has higher authority than graph', () => {
    expect(AUTHORITY_LAYER_PRIORITY['mem0']).toBeLessThan(AUTHORITY_LAYER_PRIORITY['graph']!);
  });

  it('graph has higher authority than rag', () => {
    expect(AUTHORITY_LAYER_PRIORITY['graph']).toBeLessThan(AUTHORITY_LAYER_PRIORITY['rag']!);
  });

  it('hierarchy order: canonical_memory < mem0 < graph < rag', () => {
    const keys = ['canonical_memory', 'mem0', 'graph', 'rag'];
    const priorities = keys.map(k => AUTHORITY_LAYER_PRIORITY[k]!);
    for (let i = 0; i < priorities.length - 1; i++) {
      expect(priorities[i]).toBeLessThan(priorities[i + 1]!);
    }
  });
});

// ─── 2. resolveMemoryAuthorityConflict unit tests ─────────────────────────────

describe('P7D Feed 4: resolveMemoryAuthorityConflict — no conflicts', () => {
  it('returns empty sets when no candidates have canonicalId', () => {
    const candidates = [
      makeRanked('a', { sourceLayer: 'rag' }),
      makeRanked('b', { sourceLayer: 'mem0' }),
    ];
    const { supportingIds, conflictLoserIds, records } = resolveMemoryAuthorityConflict(candidates);
    expect(supportingIds.size).toBe(0);
    expect(conflictLoserIds.size).toBe(0);
    expect(records.length).toBe(0);
  });

  it('returns empty sets when every canonicalId is unique (no conflict)', () => {
    const candidates = [
      makeRanked('a', { sourceLayer: 'rag', canonicalId: 'canon-1' }),
      makeRanked('b', { sourceLayer: 'mem0', canonicalId: 'canon-2' }),
    ];
    const { supportingIds, conflictLoserIds, records } = resolveMemoryAuthorityConflict(candidates);
    expect(supportingIds.size).toBe(0);
    expect(conflictLoserIds.size).toBe(0);
    expect(records.length).toBe(0);
  });
});

describe('P7D Feed 4: resolveMemoryAuthorityConflict — canonical wins', () => {
  it('derived candidate is added to supportingIds when canonical exists in group', () => {
    const canonical = makeRanked('canon-a', {
      sourceLayer: 'canonical_memory',
      isCanonical: true,
      authorityTier: 'canonical',
      canonicalId: 'mem-x',
    });
    const derived = makeRanked('mem0-a', {
      sourceLayer: 'mem0',
      canonicalId: 'mem-x',
    });
    const { supportingIds, conflictLoserIds, records } = resolveMemoryAuthorityConflict([
      canonical, derived,
    ]);
    expect(supportingIds.has('mem0-a')).toBe(true);
    expect(conflictLoserIds.size).toBe(0);
    expect(records.length).toBe(1);
    expect(records[0]!.winner).toBe('canonical');
    expect(records[0]!.canonicalCandidateId).toBe('canon-a');
    expect(records[0]!.derivedCandidateId).toBe('mem0-a');
  });

  it('canonical winner is NOT added to supportingIds', () => {
    const canonical = makeRanked('canon-a', {
      sourceLayer: 'canonical_memory',
      isCanonical: true,
      authorityTier: 'canonical',
      canonicalId: 'mem-x',
    });
    const derived = makeRanked('rag-a', { sourceLayer: 'rag', canonicalId: 'mem-x' });
    const { supportingIds } = resolveMemoryAuthorityConflict([canonical, derived]);
    expect(supportingIds.has('canon-a')).toBe(false);
  });

  it('canonical winner is added to canonicalWinnerIds', () => {
    const canonical = makeRanked('canon-a', {
      sourceLayer: 'canonical_memory',
      isCanonical: true,
      authorityTier: 'canonical',
      canonicalId: 'mem-x',
    });
    const derived = makeRanked('rag-a', { sourceLayer: 'rag', canonicalId: 'mem-x' });
    const { canonicalWinnerIds } = resolveMemoryAuthorityConflict([canonical, derived]);
    expect(canonicalWinnerIds.has('canon-a')).toBe(true);
  });

  it('multiple derived candidates are all added to supportingIds', () => {
    const canonical = makeRanked('canon-a', {
      sourceLayer: 'canonical_memory',
      isCanonical: true,
      authorityTier: 'canonical',
      canonicalId: 'mem-x',
    });
    const mem0 = makeRanked('mem0-a', { sourceLayer: 'mem0', canonicalId: 'mem-x' });
    const graph = makeRanked('graph-a', { sourceLayer: 'graph', canonicalId: 'mem-x' });
    const rag = makeRanked('rag-a', { sourceLayer: 'rag', canonicalId: 'mem-x' });
    const { supportingIds, records } = resolveMemoryAuthorityConflict([
      canonical, mem0, graph, rag,
    ]);
    expect(supportingIds.has('mem0-a')).toBe(true);
    expect(supportingIds.has('graph-a')).toBe(true);
    expect(supportingIds.has('rag-a')).toBe(true);
    expect(records.length).toBe(3);
    expect(records.every(r => r.winner === 'canonical')).toBe(true);
  });
});

describe('P7D Feed 4: resolveMemoryAuthorityConflict — non-canonical conflict', () => {
  it('mem0 beats rag for same canonicalId — rag is conflict loser', () => {
    const mem0 = makeRanked('mem0-a', { sourceLayer: 'mem0', canonicalId: 'mem-y' });
    const rag = makeRanked('rag-a', { sourceLayer: 'rag', canonicalId: 'mem-y' });
    const { conflictLoserIds, supportingIds, records } = resolveMemoryAuthorityConflict([
      mem0, rag,
    ]);
    expect(conflictLoserIds.has('rag-a')).toBe(true);
    expect(supportingIds.size).toBe(0);
    expect(records.length).toBe(1);
    expect(records[0]!.winner).toBe('higher_authority_layer');
    expect(records[0]!.canonicalCandidateId).toBe('mem0-a');
    expect(records[0]!.derivedCandidateId).toBe('rag-a');
  });

  it('graph beats rag for same canonicalId', () => {
    const graph = makeRanked('graph-a', { sourceLayer: 'graph', canonicalId: 'mem-z' });
    const rag = makeRanked('rag-a', { sourceLayer: 'rag', canonicalId: 'mem-z' });
    const { conflictLoserIds } = resolveMemoryAuthorityConflict([graph, rag]);
    expect(conflictLoserIds.has('rag-a')).toBe(true);
    expect(conflictLoserIds.has('graph-a')).toBe(false);
  });

  it('mem0 beats both graph and rag for same canonicalId', () => {
    const mem0 = makeRanked('mem0-a', { sourceLayer: 'mem0', canonicalId: 'mem-q' });
    const graph = makeRanked('graph-a', { sourceLayer: 'graph', canonicalId: 'mem-q' });
    const rag = makeRanked('rag-a', { sourceLayer: 'rag', canonicalId: 'mem-q' });
    const { conflictLoserIds } = resolveMemoryAuthorityConflict([mem0, graph, rag]);
    expect(conflictLoserIds.has('graph-a')).toBe(true);
    expect(conflictLoserIds.has('rag-a')).toBe(true);
    expect(conflictLoserIds.has('mem0-a')).toBe(false);
  });

  it('deterministic tie-break by id when sourceLayer priority is equal', () => {
    // Two candidates from the same layer (or unknown layers) with same priority
    const a = makeRanked('aaa', { canonicalId: 'mem-tie' });
    const b = makeRanked('bbb', { canonicalId: 'mem-tie' });
    const { conflictLoserIds } = resolveMemoryAuthorityConflict([a, b]);
    // 'aaa' < 'bbb' lexicographically → 'aaa' wins
    expect(conflictLoserIds.has('bbb')).toBe(true);
    expect(conflictLoserIds.has('aaa')).toBe(false);
  });
});

// ─── 3. Integration: reason codes in _selectItemsGlobal ──────────────────────

describe('P7D Feed 4: excluded.superseded_by_canonical reason code', () => {
  it('derived evidence candidate gets excluded.superseded_by_canonical when canonical consumes budget', async () => {
    // Canonical graph item (graphEdgeTrust: 'canonical' → authorityTier: 'canonical')
    const graphCanonical = makeGraphContextItem({
      sourceKey: 'canon:mem-x',
      content: 'Canonical memory content',
      score: 1.0,
      graphEdgeTrust: 'canonical',
      metadata: { canonicalId: 'mem-x' },
    });
    // RAG evidence candidate sharing the same canonicalId — no canonical authority tier
    const ragResult = makeResult({
      itemKey: 'rag:mem-x',
      title: 'RAG derived',
      providerId: 'local',
      score: 0.5,
      metadata: { canonicalId: 'mem-x' },
    });

    const orchestrator = makeMockOrchestrator([ragResult]);
    const graphService = makeGraphServiceReturning([graphCanonical]);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);

    // Budget = 1: canonical graph item (isCanonical=true, authorityScore=1.0) ranks first
    // and consumes the sole budget slot. RAG item is then excluded as superseded.
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 1 } }));

    const d = result.diagnostics!;
    const ragDecision = d.decisions.find(dec => dec.candidateId === 'rag:mem-x');
    expect(ragDecision).toBeDefined();
    expect(ragDecision!.reasons).toContain('excluded.superseded_by_canonical');
  });
});

describe('P7D Feed 4: excluded.authority_conflict reason code', () => {
  it('lower-priority layer candidate gets excluded.authority_conflict in non-canonical conflict', async () => {
    // Graph context item (sourceLayer='graph') — higher authority than rag (no canonical)
    const graphItem = makeGraphContextItem({
      sourceKey: 'graph:mem-y',
      content: 'Graph version',
      score: 0.7,
      graphEdgeTrust: 'derived', // NOT canonical
      metadata: { canonicalId: 'mem-y' },
    });
    // RAG evidence item (sourceLayer='rag') — lower authority
    const ragResult = makeResult({
      itemKey: 'rag:mem-y',
      title: 'RAG version',
      providerId: 'local',
      score: 0.7,
      metadata: { canonicalId: 'mem-y' },
    });
    // Neither is canonical, so layer hierarchy (graph > rag) determines the winner.
    // RAG item → conflictLoserIds → excluded.authority_conflict.

    const orchestrator = makeMockOrchestrator([ragResult]);
    const graphService = makeGraphServiceReturning([graphItem]);
    const service = new ContextAssemblyService(
      orchestrator,
      policyService,
      graphService,
    );

    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    const d = result.diagnostics!;
    const conflictDecisions = d.decisions.filter(dec =>
      dec.reasons.includes('excluded.authority_conflict'),
    );
    expect(conflictDecisions.length).toBeGreaterThan(0);
  });
});

describe('P7D Feed 4: included.supporting_derived reason code', () => {
  it('derived graph candidate included alongside canonical gets included.supporting_derived', async () => {
    // Canonical graph item (graphEdgeTrust: 'canonical' → isCanonical=true, authorityTier='canonical')
    const canonicalGraph = makeGraphContextItem({
      sourceKey: 'canon:mem-z',
      content: 'Canonical graph content',
      score: 1.0,
      graphEdgeTrust: 'canonical',
      metadata: { canonicalId: 'mem-z' },
    });
    // Derived graph item — same canonicalId, non-canonical trust
    const derivedGraph = makeGraphContextItem({
      sourceKey: 'derived:mem-z',
      content: 'Derived graph content',
      score: 0.5,
      graphEdgeTrust: 'derived',
      metadata: { canonicalId: 'mem-z' },
    });

    const orchestrator = makeMockOrchestrator([]);
    const graphService = makeGraphServiceReturning([canonicalGraph, derivedGraph]);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);

    // Large budget — both candidates fit. Canonical is selected normally;
    // derived is included as supporting context with 'included.supporting_derived'.
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 10 } }));

    const d = result.diagnostics!;
    const derivedDecision = d.decisions.find(dec => dec.candidateId.includes('derived:mem-z'));
    expect(derivedDecision).toBeDefined();
    expect(derivedDecision!.status).toBe('included');
    expect(derivedDecision!.reasons).toContain('included.supporting_derived');
  });
});

// ─── 4. Canonical always ranks higher than derived for same canonicalId ────────

describe('P7D Feed 4: canonical always dominates derived for same canonicalId', () => {
  it('canonical graph item is included when derived evidence item shares canonicalId and budget=1', async () => {
    const derivedEvidence = makeResult({
      itemKey: 'rag:mem-aa',
      title: 'Derived evidence',
      providerId: 'local',
      score: 0.9, // High score but derived
      metadata: { canonicalId: 'mem-aa' },
    });
    const canonicalGraph = makeGraphContextItem({
      sourceKey: 'canon:mem-aa',
      score: 0.3, // Lower score but canonical
      graphEdgeTrust: 'canonical',
      metadata: { canonicalId: 'mem-aa' },
    });

    const orchestrator = makeMockOrchestrator([derivedEvidence]);
    const graphService = makeGraphServiceReturning([canonicalGraph]);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);

    // Budget = 1: canonical should be preferred
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 1 } }));

    const d = result.diagnostics!;
    const canonicalDecision = d.decisions.find(dec => dec.candidateId.includes('canon:mem-aa'));
    expect(canonicalDecision).toBeDefined();
    // The canonical should be included
    expect(canonicalDecision!.status).toBe('included');
  });

  it('no derived item outranks a canonical item for the same canonicalId', async () => {
    const canonical = makeRanked('canon-a', {
      sourceLayer: 'canonical_memory',
      isCanonical: true,
      authorityTier: 'canonical',
      canonicalId: 'mem-bb',
      score: 0.1, // Very low score
    });
    const derived = makeRanked('rag-a', {
      sourceLayer: 'rag',
      canonicalId: 'mem-bb',
      score: 0.99, // Very high score
    });

    const { supportingIds, conflictLoserIds } = resolveMemoryAuthorityConflict([
      canonical, derived,
    ]);
    // Derived should be in supportingIds (or conflictLoserIds), not allowed to win
    expect(supportingIds.has('rag-a') || conflictLoserIds.has('rag-a')).toBe(true);
    expect(supportingIds.has('canon-a') || conflictLoserIds.has('canon-a')).toBe(false);
  });
});

// ─── 5. Affective weighting must NOT override authority ───────────────────────

describe('P7D Feed 4: affective weighting does not override authority', () => {
  it('conflict resolution is applied independent of any score component', () => {
    // A derived candidate with a high affective adjustment still loses to canonical
    const canonical = makeRanked('canon-a', {
      sourceLayer: 'canonical_memory',
      isCanonical: true,
      authorityTier: 'canonical',
      canonicalId: 'mem-cc',
    });

    // Simulate a derived candidate that somehow has a very high score (as if affective boosted)
    const highScoreDerived: RankedContextCandidate = {
      ...makeRanked('derived-a', {
        sourceLayer: 'mem0',
        canonicalId: 'mem-cc',
        score: 1.0,
      }),
      scoreBreakdown: {
        semanticScore: 1.0,
        recencyScore: 1.0,
        authorityScore: 0.75,
        sourceWeight: 0.9,
        graphDepthPenalty: 0,
        affectiveAdjustment: 0.15, // Maximum affective boost
        finalScore: 1.0,
        tokenEfficiency: 1.0,
        normalizedScore: 1.0, // Highest possible score
      },
    };

    const { supportingIds, conflictLoserIds } = resolveMemoryAuthorityConflict([
      canonical, highScoreDerived,
    ]);
    // Despite high score, derived-a should be in supportingIds (conflict group with canonical)
    expect(supportingIds.has('derived-a')).toBe(true);
    expect(conflictLoserIds.has('derived-a')).toBe(false);
    // Canonical is never marked as loser
    expect(supportingIds.has('canon-a')).toBe(false);
    expect(conflictLoserIds.has('canon-a')).toBe(false);
  });
});

// ─── 6. Conflict records in diagnostics ──────────────────────────────────────

describe('P7D Feed 4: conflict records visible in diagnostics', () => {
  it('conflictResolutionRecords is non-empty when authority conflicts occur', async () => {
    // Two graph items sharing same canonicalId: one canonical, one derived
    const canonicalGraph = makeGraphContextItem({
      sourceKey: 'canon:mem-dd',
      content: 'Canonical version',
      score: 1.0,
      graphEdgeTrust: 'canonical',
      metadata: { canonicalId: 'mem-dd' },
    });
    const derivedGraph = makeGraphContextItem({
      sourceKey: 'derived:mem-dd',
      content: 'Derived version',
      score: 0.5,
      graphEdgeTrust: 'derived',
      metadata: { canonicalId: 'mem-dd' },
    });

    const orchestrator = makeMockOrchestrator([]);
    const graphService = makeGraphServiceReturning([canonicalGraph, derivedGraph]);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);

    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    const d = result.diagnostics!;
    expect(d.conflictResolutionRecords.length).toBeGreaterThan(0);
  });

  it('conflictResolutionRecords includes winner and derivedCandidateId', async () => {
    const canonicalGraph = makeGraphContextItem({
      sourceKey: 'canon:mem-ee',
      content: 'Canonical content',
      score: 1.0,
      graphEdgeTrust: 'canonical',
      metadata: { canonicalId: 'mem-ee' },
    });
    const derivedGraph = makeGraphContextItem({
      sourceKey: 'derived:mem-ee',
      content: 'Derived content',
      score: 0.5,
      graphEdgeTrust: 'derived',
      metadata: { canonicalId: 'mem-ee' },
    });

    const orchestrator = makeMockOrchestrator([]);
    const graphService = makeGraphServiceReturning([canonicalGraph, derivedGraph]);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);

    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    const d = result.diagnostics!;
    const record = d.conflictResolutionRecords[0];
    expect(record).toBeDefined();
    expect(record!.winner).toBe('canonical');
    expect(record!.reason).toContain('canonicalId=mem-ee');
  });

  it('conflictResolutionRecords is empty when no canonicalId conflicts exist', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence 1', providerId: 'local' }),
      makeResult({ itemKey: 'e2', title: 'Evidence 2', providerId: 'local' }),
    ];

    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(
      orchestrator,
      policyService,
      makeNoopGraphService(),
    );

    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    expect(result.diagnostics!.conflictResolutionRecords.length).toBe(0);
  });

  it('conflictResolved=true on canonical winner decision', async () => {
    const canonicalGraph = makeGraphContextItem({
      sourceKey: 'canon:mem-ff',
      content: 'Canonical',
      score: 1.0,
      graphEdgeTrust: 'canonical',
      metadata: { canonicalId: 'mem-ff' },
    });
    const derivedGraph = makeGraphContextItem({
      sourceKey: 'derived:mem-ff',
      content: 'Derived',
      score: 0.3,
      graphEdgeTrust: 'derived',
      metadata: { canonicalId: 'mem-ff' },
    });

    const orchestrator = makeMockOrchestrator([]);
    const graphService = makeGraphServiceReturning([canonicalGraph, derivedGraph]);
    const service = new ContextAssemblyService(orchestrator, policyService, graphService);

    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    const d = result.diagnostics!;
    // The canonical winner and the derived candidate should both have conflictResolved=true
    const canonicalDecision = d.decisions.find(dec =>
      dec.candidateId.includes('canon:mem-ff'),
    );
    expect(canonicalDecision?.conflictResolved).toBe(true);
  });
});

// ─── 7. Candidates with no canonicalId are unaffected ────────────────────────

describe('P7D Feed 4: candidates without canonicalId are not affected', () => {
  it('candidates with no canonicalId receive standard inclusion reason', async () => {
    const results = [
      makeResult({
        itemKey: 'e-no-canon',
        title: 'No canonical ID',
        providerId: 'local',
        score: 0.8,
      }),
    ];

    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(
      orchestrator,
      policyService,
      makeNoopGraphService(),
    );

    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    const d = result.diagnostics!;
    const dec = d.decisions.find(d => d.candidateId === 'e-no-canon');
    expect(dec).toBeDefined();
    expect(dec!.status).toBe('included');
    expect(dec!.reasons).toContain('included.cross_layer_top_rank');
    expect(dec!.reasons).not.toContain('excluded.superseded_by_canonical');
    expect(dec!.reasons).not.toContain('excluded.authority_conflict');
    expect(dec!.reasons).not.toContain('included.supporting_derived');
  });

  it('conflict resolution does not produce records for candidates with no canonicalId', () => {
    const a = makeRanked('a', { sourceLayer: 'rag' });
    const b = makeRanked('b', { sourceLayer: 'mem0' });
    const { records, supportingIds, conflictLoserIds } = resolveMemoryAuthorityConflict([a, b]);
    expect(records.length).toBe(0);
    expect(supportingIds.size).toBe(0);
    expect(conflictLoserIds.size).toBe(0);
  });
});

// ─── 8. Multiple conflict groups in one pass ──────────────────────────────────

describe('P7D Feed 4: multiple conflict groups resolved independently', () => {
  it('resolves two independent conflict groups correctly', () => {
    const canon1 = makeRanked('canon-1', {
      isCanonical: true,
      authorityTier: 'canonical',
      canonicalId: 'group-A',
    });
    const derived1 = makeRanked('rag-1', { sourceLayer: 'rag', canonicalId: 'group-A' });
    const mem0Win = makeRanked('mem0-2', { sourceLayer: 'mem0', canonicalId: 'group-B' });
    const ragLose = makeRanked('rag-2', { sourceLayer: 'rag', canonicalId: 'group-B' });

    const { supportingIds, conflictLoserIds, records } = resolveMemoryAuthorityConflict([
      canon1, derived1, mem0Win, ragLose,
    ]);

    expect(supportingIds.has('rag-1')).toBe(true);
    expect(conflictLoserIds.has('rag-2')).toBe(true);
    expect(records.length).toBe(2);
    expect(records.some(r => r.winner === 'canonical')).toBe(true);
    expect(records.some(r => r.winner === 'higher_authority_layer')).toBe(true);
  });
});
