/**
 * ContextAssemblyDeterminism.test.ts
 *
 * Feed 6: Determinism + Regression Proof Suite
 *
 * Verifies that context assembly remains deterministic under cross-layer
 * competition, tie-breaking, authority resolution, affective modulation,
 * and budget constraints.
 */

import { describe, it, expect, vi } from 'vitest';
import { ContextAssemblyService } from '../../services/context/ContextAssemblyService';
import { MemoryPolicyService } from '../../services/policy/MemoryPolicyService';
import { GraphTraversalService } from '../../services/graph/GraphTraversalService';
import type { AffectiveGraphService } from '../../services/graph/AffectiveGraphService';
import { applyDeterministicTieBreak } from '../../services/context/contextCandidateComparator';
import type { RetrievalOrchestrator } from '../../services/retrieval/RetrievalOrchestrator';
import type {
  NormalizedSearchResult,
  RetrievalResponse,
  RetrievalScopeResolved,
} from '../../../shared/retrieval/retrievalTypes';
import type {
  ContextAssemblyRequest,
  MemoryPolicy,
  ContextAssemblyItem,
  AffectiveModulationPolicy,
} from '../../../shared/policy/memoryPolicyTypes';
import type {
  RankedContextCandidate,
  ScoreBreakdown,
} from '../../../shared/context/contextDeterminismTypes';

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

function makeAffectiveItem(overrides: Partial<ContextAssemblyItem> = {}): ContextAssemblyItem {
  return {
    content: 'joy',
    selectionClass: 'graph_context',
    sourceType: 'emotion_tag',
    sourceKey: 'emotion_tag:joy',
    title: 'Emotion tag',
    score: 0.9,
    graphEdgeType: 'modulates',
    graphEdgeTrust: 'session_only',
    metadata: {
      affective: true,
      affectiveNodeType: 'emotion_tag',
      moodLabel: 'joy',
    },
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
    allowEvidenceReordering: true,
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

function makeScoreBreakdown(finalScore: number, overrides: Partial<ScoreBreakdown> = {}): ScoreBreakdown {
  const base = {
    semanticScore: 0.5,
    recencyScore: 0.5,
    authorityScore: 0.5,
    sourceWeight: 1.0,
    graphDepthPenalty: 0,
    affectiveAdjustment: 0,
    finalScore,
    tokenEfficiency: 1.0,
    ...overrides,
  };
  return {
    ...base,
    normalizedScore: base.finalScore * base.sourceWeight * base.tokenEfficiency,
    ...('normalizedScore' in overrides ? { normalizedScore: (overrides as ScoreBreakdown).normalizedScore } : {}),
  };
}

function makeRankedCandidate(
  overrides: Partial<RankedContextCandidate> & { id: string; scoreBreakdown: ScoreBreakdown },
): RankedContextCandidate {
  return {
    content: 'content',
    selectionClass: 'evidence',
    layerAssignment: 'evidence',
    estimatedTokens: 10,
    authorityTier: null,
    score: null,
    rank: 0,
    ...overrides,
  };
}

const policyService = new MemoryPolicyService();

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ContextAssembly Determinism Proof (Feed 6)', () => {
  it('Proof 1: Same inputs produce identical context and diagnostics', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence A', providerId: 'local', score: 0.9 }),
      makeResult({ itemKey: 'e2', title: 'Evidence B', providerId: 'local', score: 0.8 }),
    ];
    const graphItems = [makeGraphContextItem({ sourceKey: 'g1', score: 0.4 })];

    const runAssembly = async () => {
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(
        orchestrator,
        policyService,
        makeGraphServiceReturning(graphItems),
      );
      return service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));
    };

    const run1 = await runAssembly();
    const run2 = await runAssembly();

    expect(run1.items.map(i => i.sourceKey)).toEqual(run2.items.map(i => i.sourceKey));
    expect(run1.diagnostics!.crossLayerRankingOrder).toEqual(run2.diagnostics!.crossLayerRankingOrder);
    expect(run1.diagnostics!.decisions.map(d => d.status)).toEqual(
      run2.diagnostics!.decisions.map(d => d.status),
    );
  });

  it('Proof 2: Cross-layer tie resolves deterministically', () => {
    const breakdown = makeScoreBreakdown(0.6, { normalizedScore: 0.4, authorityScore: 0.5 });
    const candidates = [
      makeRankedCandidate({
        id: 'graph-tie',
        selectionClass: 'graph_context',
        layerAssignment: 'graph_context',
        sourceLayer: 'graph',
        estimatedTokens: 4,
        scoreBreakdown: breakdown,
      }),
      makeRankedCandidate({
        id: 'rag-tie',
        selectionClass: 'evidence',
        layerAssignment: 'evidence',
        sourceLayer: 'rag',
        estimatedTokens: 9,
        scoreBreakdown: breakdown,
      }),
    ];

    const run1 = applyDeterministicTieBreak(candidates);
    const run2 = applyDeterministicTieBreak(candidates);

    expect(run1.sorted.map(c => c.id)).toEqual(run2.sorted.map(c => c.id));
    expect(run1.tieBreakRecords).toHaveLength(1);
    expect(run1.tieBreakRecords[0]?.tieBreakCriteria).toBe('token_cost:asc');
    expect(run1.sorted[0]?.id).toBe('graph-tie');
  });

  it('Proof 3: Canonical always outranks derived candidates', async () => {
    const results = [
      makeResult({
        itemKey: 'rag_derived',
        title: 'Derived RAG',
        providerId: 'local',
        score: 0.95,
        metadata: { canonicalId: 'conflict_1' },
      }),
    ];
    const graphItems = [
      makeGraphContextItem({
        sourceKey: 'graph_canonical',
        score: 0.2,
        graphEdgeTrust: 'canonical',
        metadata: { canonicalId: 'conflict_1' },
      }),
    ];

    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(
      orchestrator,
      policyService,
      makeGraphServiceReturning(graphItems),
    );

    const result = await service.assemble(
      makeRequest({ contextBudget: { maxItems: 1 } }),
    );

    const decisions = result.diagnostics!.decisions;
    const canonicalDecision = decisions.find(d => d.candidateId === 'graph_canonical');
    const derivedDecision = decisions.find(d => d.candidateId === 'rag_derived');

    expect(canonicalDecision?.status).toBe('included');
    expect(canonicalDecision?.reasons).toContain('included.high_authority');
    expect(derivedDecision?.reasons).toContain('excluded.superseded_by_canonical');
    expect(result.diagnostics!.authorityConflictRecords.length).toBeGreaterThan(0);
  });

  it('Proof 4: Affective weighting does not break determinism', async () => {
    const results = [
      makeResult({
        itemKey: 'e1',
        title: 'Joyful Note',
        providerId: 'local',
        score: 0.7,
        snippet: 'joy is present in this snippet',
      }),
    ];

    const affectiveItems = [makeAffectiveItem()];
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(
      orchestrator,
      policyService,
      makeNoopGraphService(),
      makeMockAffectiveService(affectiveItems),
    );

    const request = makeRequest({
      affectiveModulation: makeAffectivePolicy({ allowEvidenceReordering: true }),
    });
    const run1 = await service.assemble(request);
    const run2 = await service.assemble(request);

    const candidate1 = run1.diagnostics!.crossLayerCandidatePool.find(c => c.id === 'e1');
    const candidate2 = run2.diagnostics!.crossLayerCandidatePool.find(c => c.id === 'e1');

    expect(candidate1?.scoreBreakdown.affectiveAdjustment).toBe(
      candidate2?.scoreBreakdown.affectiveAdjustment,
    );
    expect(candidate1?.scoreBreakdown.affectiveAdjustment ?? 0).toBeGreaterThan(0);
    expect(candidate1?.affectiveReasonCode).toBe('affective.keyword_boost_applied');
    expect(run1.diagnostics!.crossLayerRankingOrder).toEqual(run2.diagnostics!.crossLayerRankingOrder);
  });

  it('Proof 5: Token budget enforcement is stable under cross-layer competition', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence A', providerId: 'local', score: 0.95, snippet: 'A'.repeat(40) }),
      makeResult({ itemKey: 'e2', title: 'Evidence B', providerId: 'local', score: 0.7, snippet: 'B'.repeat(40) }),
    ];
    const graphItems = [
      makeGraphContextItem({ sourceKey: 'g1', score: 0.2, content: 'G'.repeat(40), graphEdgeTrust: null }),
    ];

    const runAssembly = async () => {
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(
        orchestrator,
        policyService,
        makeGraphServiceReturning(graphItems),
      );
      return service.assemble(
        makeRequest({ contextBudget: { maxItems: 3, maxTokens: 12 } }),
      );
    };

    const run1 = await runAssembly();
    const run2 = await runAssembly();

    expect(run1.diagnostics!.includedCandidates).toEqual(run2.diagnostics!.includedCandidates);
    const graphDecision = run1.diagnostics!.decisions.find(d => d.candidateId === 'g1');
    const latentDecision = run1.diagnostics!.decisions.find(d => d.candidateId === 'e2');

    expect(graphDecision?.reasons).toContain('excluded.cross_layer_budget_exceeded');
    expect(latentDecision?.reasons).toContain('overflow.to_latent');
  });

  it('Proof 6: Source normalization behaves predictably', async () => {
    const results = [
      makeResult({ itemKey: 'rag_norm', title: 'RAG Source', providerId: 'local', score: 0.6, snippet: 'R'.repeat(20) }),
    ];
    const graphItems = [
      makeGraphContextItem({ sourceKey: 'graph_norm', score: 0.6, content: 'G'.repeat(20) }),
    ];

    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(
      orchestrator,
      policyService,
      makeGraphServiceReturning(graphItems),
    );
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 2 } }));

    const pool = result.diagnostics!.crossLayerCandidatePool;
    const rag = pool.find(c => c.id === 'rag_norm')!;
    const graph = pool.find(c => c.id === 'graph_norm')!;

    expect(rag.scoreBreakdown.normalizedScore).toBeCloseTo(
      rag.scoreBreakdown.finalScore * rag.scoreBreakdown.sourceWeight * rag.scoreBreakdown.tokenEfficiency,
      6,
    );
    expect(graph.scoreBreakdown.normalizedScore).toBeCloseTo(
      graph.scoreBreakdown.finalScore * graph.scoreBreakdown.sourceWeight * graph.scoreBreakdown.tokenEfficiency,
      6,
    );
    expect(graph.scoreBreakdown.normalizedScore).toBeGreaterThan(rag.scoreBreakdown.normalizedScore);
  });

  it('Proof 7: Diagnostics fully explain decisions', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence A', providerId: 'local', score: 0.9 }),
      makeResult({ itemKey: 'e2', title: 'Evidence B', providerId: 'local', score: 0.8 }),
    ];
    const graphItems = [
      makeGraphContextItem({ sourceKey: 'g1', score: 0.5 }),
    ];

    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(
      orchestrator,
      policyService,
      makeGraphServiceReturning(graphItems),
    );
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 2 } }));
    const diag = result.diagnostics!;

    expect(diag.crossLayerCandidatePool.length).toBe(diag.crossLayerRankingOrder.length);
    expect(diag.decisions.length).toBe(diag.totalCandidatesConsidered);
    for (const candidateId of diag.crossLayerRankingOrder) {
      expect(diag.decisions.some(d => d.candidateId === candidateId)).toBe(true);
    }
    for (const decision of diag.decisions) {
      expect(decision.reasons.length).toBeGreaterThan(0);
    }
    expect(Object.keys(diag.perSourceCounts).length).toBeGreaterThan(0);
    expect(Object.keys(diag.exclusionBreakdown).length).toBeGreaterThan(0);
  });

  it('Proof 8: Removing a top candidate changes ranking predictably', async () => {
    const fullResults = [
      makeResult({ itemKey: 'e1', title: 'Evidence A', providerId: 'local', score: 0.9 }),
      makeResult({ itemKey: 'e2', title: 'Evidence B', providerId: 'local', score: 0.8 }),
      makeResult({ itemKey: 'e3', title: 'Evidence C', providerId: 'local', score: 0.7 }),
    ];

    const fullService = new ContextAssemblyService(
      makeMockOrchestrator(fullResults),
      policyService,
      makeNoopGraphService(),
    );
    const fullResult = await fullService.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    const partialResults = fullResults.slice(1);
    const partialService = new ContextAssemblyService(
      makeMockOrchestrator(partialResults),
      policyService,
      makeNoopGraphService(),
    );
    const partialResult = await partialService.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    expect(partialResult.diagnostics!.crossLayerRankingOrder[0]).toBe(
      fullResult.diagnostics!.crossLayerRankingOrder[1],
    );
    expect(fullResult.diagnostics!.crossLayerRankingOrder[0]).toBe('e1');
  });
});
