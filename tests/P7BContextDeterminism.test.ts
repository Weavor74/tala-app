/**
 * P7BContextDeterminism.test.ts
 *
 * P7B determinism tests for context assembly.
 *
 * Verifies:
 *   1. Same inputs → same final context ordering (repeatability)
 *   2. Same inputs → same inclusion/exclusion reason codes
 *   3. Tie scores resolve identically every run
 *   4. Layer budgets are respected deterministically
 *   5. Canonical memory outranks conflicting derived memory
 *   6. Truncation policy is deterministic (per-document cap)
 *   7. Diagnostics fully explain final assembly
 *   8. Modifying a score input changes result predictably
 *   9. No candidate disappears without a decision record
 *  10. ContextScoringService produces stable ScoreBreakdown
 *  11. compareContextCandidates provides total order
 *  12. applyDeterministicTieBreak emits TieBreakRecords for equal scores
 *  13. Regression: graph_context budget cap still applies
 *  14. Regression: strict mode still excludes graph_context items
 *
 * Uses mocked RetrievalOrchestrator — no real DB or network.
 */

import { describe, it, expect, vi } from 'vitest';
import { ContextAssemblyService } from '../electron/services/context/ContextAssemblyService';
import { MemoryPolicyService } from '../electron/services/policy/MemoryPolicyService';
import { GraphTraversalService } from '../electron/services/graph/GraphTraversalService';
import {
  ContextScoringService,
  computeRecencyScore,
  computeAuthorityScore,
  computeGraphDepthPenalty,
  SCORING_WEIGHTS,
  AUTHORITY_TIER_SCORES,
  NEUTRAL_RECENCY_SCORE,
} from '../electron/services/context/ContextScoringService';
import {
  compareContextCandidates,
  applyDeterministicTieBreak,
} from '../electron/services/context/contextCandidateComparator';
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
import type {
  RankedContextCandidate,
  ScoreBreakdown,
} from '../shared/context/contextDeterminismTypes';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

// ─── Shared helpers ────────────────────────────────────────────────────────────

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

function makeRequest(policyOverride: Partial<MemoryPolicy> = {}): ContextAssemblyRequest {
  return {
    query: 'test query',
    policy: { groundingMode: 'graph_assisted', ...policyOverride } as MemoryPolicy,
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
  // normalizedScore defaults to finalScore × sourceWeight × tokenEfficiency
  // so that tests that don't override it behave consistently with the formula.
  return {
    ...base,
    normalizedScore: base.finalScore * base.sourceWeight * base.tokenEfficiency,
    ...('normalizedScore' in overrides ? { normalizedScore: (overrides as ScoreBreakdown).normalizedScore } : {}),
  };
}

const policyService = new MemoryPolicyService();

// ─── 1. Same inputs → same final context ordering ─────────────────────────────

describe('P7B: repeatability', () => {
  it('same retrieval results produce identical item ordering across multiple runs', async () => {
    const results = [
      makeResult({ itemKey: 'r3', title: 'Doc C', providerId: 'local', score: 0.7 }),
      makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', score: 0.9 }),
      makeResult({ itemKey: 'r2', title: 'Doc B', providerId: 'local', score: 0.8 }),
    ];

    const runAssembly = async () => {
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
      return service.assemble(makeRequest({ contextBudget: { maxItems: 10 } }));
    };

    const resultA = await runAssembly();
    const resultB = await runAssembly();
    const resultC = await runAssembly();

    // All runs must produce the same item ordering
    expect(resultA.items.map(i => i.sourceKey)).toEqual(resultB.items.map(i => i.sourceKey));
    expect(resultB.items.map(i => i.sourceKey)).toEqual(resultC.items.map(i => i.sourceKey));
  });

  it('same inputs → items sorted by deterministic score (highest score first)', async () => {
    // Results provided in reverse score order — assembler must sort them
    const results = [
      makeResult({ itemKey: 'r3', title: 'Doc C', providerId: 'local', score: 0.3 }),
      makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', score: 0.9 }),
      makeResult({ itemKey: 'r2', title: 'Doc B', providerId: 'local', score: 0.6 }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 10 } }));

    const evidenceItems = result.items.filter(i => i.selectionClass === 'evidence');
    // Highest score first
    expect(evidenceItems[0]?.sourceKey).toBe('r1');
    expect(evidenceItems[1]?.sourceKey).toBe('r2');
    expect(evidenceItems[2]?.sourceKey).toBe('r3');
  });

  it('retrieval results in arbitrary order still produce same final order as score-ordered input', async () => {
    const baseResults = [
      makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', score: 0.9 }),
      makeResult({ itemKey: 'r2', title: 'Doc B', providerId: 'local', score: 0.8 }),
      makeResult({ itemKey: 'r3', title: 'Doc C', providerId: 'local', score: 0.7 }),
    ];
    const shuffledResults = [
      makeResult({ itemKey: 'r3', title: 'Doc C', providerId: 'local', score: 0.7 }),
      makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', score: 0.9 }),
      makeResult({ itemKey: 'r2', title: 'Doc B', providerId: 'local', score: 0.8 }),
    ];

    const assembleWith = async (results: NormalizedSearchResult[]) => {
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
      return service.assemble(makeRequest({ contextBudget: { maxItems: 10 } }));
    };

    const r1 = await assembleWith(baseResults);
    const r2 = await assembleWith(shuffledResults);

    expect(r1.items.map(i => i.sourceKey)).toEqual(r2.items.map(i => i.sourceKey));
  });
});

// ─── 2. Same inputs → same reason codes ──────────────────────────────────────

describe('P7B: reason code determinism', () => {
  it('included items always receive reason codes', async () => {
    const results = [
      makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', score: 0.9 }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    expect(result.diagnostics).toBeDefined();
    const includedDecisions = result.diagnostics!.decisions.filter(d => d.status === 'included');
    expect(includedDecisions.length).toBeGreaterThan(0);
    for (const d of includedDecisions) {
      expect(d.reasons.length).toBeGreaterThan(0);
    }
  });

  it('excluded (latent) items always receive reason codes', async () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeResult({ itemKey: `r${i}`, title: `Doc ${i}`, providerId: 'local', score: 0.9 - i * 0.1 }),
    );
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    // Budget of 2 → 3 items overflow to latent
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 2 } }));

    const latentDecisions = result.diagnostics!.decisions.filter(d => d.status === 'latent');
    expect(latentDecisions.length).toBeGreaterThan(0);
    for (const d of latentDecisions) {
      expect(d.reasons.length).toBeGreaterThan(0);
      expect(d.reasons.some(r => r === 'overflow.to_latent')).toBe(true);
    }
  });

  it('same assembly produces same decision records across runs', async () => {
    const results = [
      makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', score: 0.9 }),
      makeResult({ itemKey: 'r2', title: 'Doc B', providerId: 'local', score: 0.5 }),
    ];

    const runAssembly = async () => {
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
      return service.assemble(makeRequest({ contextBudget: { maxItems: 1 } }));
    };

    const r1 = await runAssembly();
    const r2 = await runAssembly();

    // Same candidate IDs in same decisions
    const extractDecisionSummary = (r: typeof r1) =>
      r.diagnostics!.decisions
        .map(d => `${d.candidateId}:${d.status}:${d.reasons.join(',')}`)
        .sort();

    expect(extractDecisionSummary(r1)).toEqual(extractDecisionSummary(r2));
  });
});

// ─── 3. Tie scores resolve identically ───────────────────────────────────────

describe('P7B: tie-break determinism', () => {
  it('candidates with identical scores are sorted by lexical ID (final tie-break)', () => {
    const breakdownHigh = makeScoreBreakdown(0.5, { authorityScore: 0.5 });
    const cA = makeRankedCandidate({ id: 'zzz-candidate', scoreBreakdown: breakdownHigh, estimatedTokens: 10 });
    const cB = makeRankedCandidate({ id: 'aaa-candidate', scoreBreakdown: breakdownHigh, estimatedTokens: 10 });
    const cC = makeRankedCandidate({ id: 'mmm-candidate', scoreBreakdown: breakdownHigh, estimatedTokens: 10 });

    const { sorted } = applyDeterministicTieBreak([cA, cC, cB]);

    // aaa < mmm < zzz — consistent every run
    expect(sorted[0]!.id).toBe('aaa-candidate');
    expect(sorted[1]!.id).toBe('mmm-candidate');
    expect(sorted[2]!.id).toBe('zzz-candidate');
  });

  it('tie-break records are emitted when scores are equal', () => {
    const bd = makeScoreBreakdown(0.5, { authorityScore: 0.5 });
    const cA = makeRankedCandidate({ id: 'b-item', scoreBreakdown: bd, estimatedTokens: 10 });
    const cB = makeRankedCandidate({ id: 'a-item', scoreBreakdown: bd, estimatedTokens: 10 });

    const { tieBreakRecords } = applyDeterministicTieBreak([cA, cB]);
    expect(tieBreakRecords.length).toBeGreaterThan(0);
    expect(tieBreakRecords[0]!.tieBreakCriteria).toBe('lexical_id:asc');
    expect(tieBreakRecords[0]!.winnerCandidateId).toBe('a-item');
  });

  it('token cost breaks a score tie before lexical ID', () => {
    const bd = makeScoreBreakdown(0.5, { authorityScore: 0.5 });
    // cA has fewer tokens → should win
    const cA = makeRankedCandidate({ id: 'zzz', scoreBreakdown: bd, estimatedTokens: 5 });
    const cB = makeRankedCandidate({ id: 'aaa', scoreBreakdown: bd, estimatedTokens: 100 });

    const { sorted, tieBreakRecords } = applyDeterministicTieBreak([cB, cA]);
    // cA wins on token cost (lower = better), even though cA.id > cB.id lexically
    expect(sorted[0]!.id).toBe('zzz');
    expect(tieBreakRecords[0]!.tieBreakCriteria).toBe('token_cost:asc');
  });

  it('same set of tied candidates always sorts identically', () => {
    const bd = makeScoreBreakdown(0.5, { authorityScore: 0.5 });
    const candidates = [
      makeRankedCandidate({ id: 'c3', scoreBreakdown: bd, estimatedTokens: 10 }),
      makeRankedCandidate({ id: 'c1', scoreBreakdown: bd, estimatedTokens: 10 }),
      makeRankedCandidate({ id: 'c2', scoreBreakdown: bd, estimatedTokens: 10 }),
    ];

    const r1 = applyDeterministicTieBreak(candidates.slice()).sorted.map(c => c.id);
    const r2 = applyDeterministicTieBreak(candidates.slice().reverse()).sorted.map(c => c.id);
    const r3 = applyDeterministicTieBreak([candidates[2]!, candidates[0]!, candidates[1]!]).sorted.map(c => c.id);

    expect(r1).toEqual(['c1', 'c2', 'c3']);
    expect(r2).toEqual(['c1', 'c2', 'c3']);
    expect(r3).toEqual(['c1', 'c2', 'c3']);
  });
});

// ─── 4. Layer budgets respected deterministically ────────────────────────────

describe('P7B: layer budget determinism', () => {
  it('evidence cap is deterministically applied (top N by score)', async () => {
    const results = Array.from({ length: 8 }, (_, i) =>
      makeResult({ itemKey: `r${i}`, title: `Doc ${i}`, providerId: 'local', score: 0.9 - i * 0.1 }),
    );
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 3 } }));

    const evidenceItems = result.items.filter(i => i.selectionClass === 'evidence');
    expect(evidenceItems.length).toBe(3);
    // Top 3 by score: r0 (0.9), r1 (0.8), r2 (0.7)
    expect(evidenceItems.map(i => i.sourceKey)).toEqual(['r0', 'r1', 'r2']);
  });

  it('global budget cap is deterministically applied', async () => {
    const orchestrator = makeMockOrchestrator([]);
    const service = new ContextAssemblyService(
      orchestrator,
      policyService,
      // GraphTraversalService that returns 5 items
      {
        expandFromEvidence: vi.fn().mockResolvedValue(
          Array.from({ length: 5 }, (_, i) => ({
            content: `Graph node ${i}`,
            selectionClass: 'graph_context',
            sourceKey: `g${i}`,
            score: 0.5 - i * 0.05,
            graphEdgeType: 'related_to',
            graphEdgeTrust: 'derived',
            metadata: {},
          })),
        ),
      } as unknown as GraphTraversalService,
    );
    const result = await service.assemble(makeRequest({
      groundingMode: 'graph_assisted',
      contextBudget: { maxItems: 3 },
    }));

    const graphItems = result.items.filter(i => i.selectionClass === 'graph_context');
    expect(graphItems.length).toBe(3);
  });

  it('diagnostics record all candidates with correct layer assignment', async () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeResult({ itemKey: `r${i}`, title: `Doc ${i}`, providerId: 'local', score: 0.9 - i * 0.1 }),
    );
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 3 } }));

    const diagnostics = result.diagnostics!;
    expect(diagnostics).toBeDefined();
    // All 5 candidates should have decisions
    expect(diagnostics.decisions.length).toBe(5);
    expect(diagnostics.totalCandidatesConsidered).toBe(5);
    // 3 included, 2 latent
    expect(diagnostics.includedCandidates.length).toBe(3);
    expect(diagnostics.latentCandidates.length).toBe(2);
  });
});

// ─── 5. Canonical memory outranks conflicting derived memory ──────────────────

describe('P7B: authority ranking', () => {
  it('canonical authority score is highest in AUTHORITY_TIER_SCORES', () => {
    expect(AUTHORITY_TIER_SCORES.canonical).toBeGreaterThan(AUTHORITY_TIER_SCORES.verified_derived);
    expect(AUTHORITY_TIER_SCORES.verified_derived).toBeGreaterThan(AUTHORITY_TIER_SCORES.transient);
    expect(AUTHORITY_TIER_SCORES.transient).toBeGreaterThan(AUTHORITY_TIER_SCORES.speculative);
  });

  it('compareContextCandidates places canonical candidate before speculative even with lower score', () => {
    const canonicalBreakdown = makeScoreBreakdown(0.3, { authorityScore: AUTHORITY_TIER_SCORES.canonical });
    const speculativeBreakdown = makeScoreBreakdown(0.9, { authorityScore: AUTHORITY_TIER_SCORES.speculative });

    const canonical = makeRankedCandidate({
      id: 'canonical-item',
      authorityTier: 'canonical',
      scoreBreakdown: canonicalBreakdown,
    });
    const speculative = makeRankedCandidate({
      id: 'speculative-item',
      authorityTier: 'speculative',
      scoreBreakdown: speculativeBreakdown,
    });

    // canonical should rank higher (authority wins over raw score)
    const result = compareContextCandidates(canonical, speculative);
    expect(result).toBeLessThan(0); // canonical comes first
  });

  it('computeAuthorityScore returns expected values for all tiers', () => {
    expect(computeAuthorityScore('canonical')).toBe(1.0);
    expect(computeAuthorityScore('verified_derived')).toBe(0.75);
    expect(computeAuthorityScore('transient')).toBe(0.25);
    expect(computeAuthorityScore('speculative')).toBe(0.0);
    expect(computeAuthorityScore(null)).toBe(0.5); // neutral
    expect(computeAuthorityScore(undefined)).toBe(0.5); // neutral
  });
});

// ─── 6. Truncation policy is deterministic ───────────────────────────────────

describe('P7B: per-document chunk cap determinism', () => {
  it('per-document cap consistently selects the highest-ranked chunks', async () => {
    const docId = 'doc-xyz';
    // 6 chunks from the same document with different scores
    const results = Array.from({ length: 6 }, (_, i) =>
      makeResult({
        itemKey: `chunk-${i}`,
        title: `Chunk ${i}`,
        providerId: 'local',
        score: 0.9 - i * 0.1,
        metadata: { documentId: docId },
      }),
    );

    const runAssembly = async () => {
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
      // evidenceCap=4 → maxChunksPerDoc = ceil(4/2) = 2
      return service.assemble(makeRequest({ contextBudget: { maxItems: 4 } }));
    };

    const r1 = await runAssembly();
    const r2 = await runAssembly();

    // Both runs produce identical item sets
    expect(r1.items.map(i => i.sourceKey)).toEqual(r2.items.map(i => i.sourceKey));

    // At most 2 chunks from the same document
    const included = r1.items.filter(i => i.selectionClass === 'evidence');
    const fromDoc = included.filter(i => i.metadata?.documentId === docId);
    expect(fromDoc.length).toBeLessThanOrEqual(2);
  });

  it('per-document cap decisions carry excluded.per_document_cap reason', async () => {
    const docId = 'doc-abc';
    const results = Array.from({ length: 6 }, (_, i) =>
      makeResult({
        itemKey: `chunk-${i}`,
        title: `Chunk ${i}`,
        providerId: 'local',
        score: 0.9 - i * 0.05,
        metadata: { documentId: docId },
      }),
    );
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 4 } }));

    const docCapDecisions = result.diagnostics!.decisions.filter(d =>
      d.reasons.includes('excluded.per_document_cap'),
    );
    expect(docCapDecisions.length).toBeGreaterThan(0);
  });
});

// ─── 7. Diagnostics fully explain final assembly ──────────────────────────────

describe('P7B: diagnostics completeness', () => {
  it('diagnostics.totalCandidatesConsidered equals number of candidates processed', async () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeResult({ itemKey: `r${i}`, title: `Doc ${i}`, providerId: 'local', score: 0.9 - i * 0.1 }),
    );
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    expect(result.diagnostics!.totalCandidatesConsidered).toBe(5);
  });

  it('diagnostics.decisions covers every candidate — no silent drops', async () => {
    const results = Array.from({ length: 7 }, (_, i) =>
      makeResult({ itemKey: `r${i}`, title: `Doc ${i}`, providerId: 'local', score: 0.9 - i * 0.1 }),
    );
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 3 } }));

    // Every candidate must have a decision
    expect(result.diagnostics!.decisions.length).toBe(7);
    // IDs in decisions match original item keys
    const decisionIds = new Set(result.diagnostics!.decisions.map(d => d.candidateId));
    for (let i = 0; i < 7; i++) {
      expect(decisionIds.has(`r${i}`)).toBe(true);
    }
  });

  it('included + latent candidate counts in diagnostics sum to total', async () => {
    const results = Array.from({ length: 6 }, (_, i) =>
      makeResult({ itemKey: `r${i}`, title: `Doc ${i}`, providerId: 'local', score: 0.9 - i * 0.1 }),
    );
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 4 } }));

    const d = result.diagnostics!;
    const total = d.includedCandidates.length + d.excludedCandidates.length
      + d.truncatedCandidates.length + d.latentCandidates.length;
    expect(total).toBe(d.decisions.length);
  });

  it('diagnostics include candidatePoolByLayer with score breakdowns', async () => {
    const results = [
      makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', score: 0.9 }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    const d = result.diagnostics!;
    expect(d.candidatePoolByLayer['evidence']).toBeDefined();
    const pool = d.candidatePoolByLayer['evidence']!;
    expect(pool.length).toBe(1);
    expect(pool[0]!.scoreBreakdown).toBeDefined();
    expect(typeof pool[0]!.scoreBreakdown.finalScore).toBe('number');
    expect(typeof pool[0]!.scoreBreakdown.semanticScore).toBe('number');
    expect(typeof pool[0]!.scoreBreakdown.authorityScore).toBe('number');
  });

  it('diagnostics assemblyMode matches policy groundingMode', async () => {
    const orchestrator = makeMockOrchestrator([]);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({
      groundingMode: 'exploratory',
      contextBudget: { maxItems: 5 },
    }));
    expect(result.diagnostics!.assemblyMode).toBe('exploratory');
  });
});

// ─── 8. Modifying score input changes result predictably ─────────────────────

describe('P7B: score sensitivity', () => {
  it('lowering a candidate score moves it after higher-scored candidates', async () => {
    const resultsHigh = [
      makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', score: 0.9 }),
      makeResult({ itemKey: 'r2', title: 'Doc B', providerId: 'local', score: 0.5 }),
    ];
    const resultsLow = [
      makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', score: 0.1 }), // r1 demoted
      makeResult({ itemKey: 'r2', title: 'Doc B', providerId: 'local', score: 0.5 }),
    ];

    const assembleWith = async (results: NormalizedSearchResult[]) => {
      const orchestrator = makeMockOrchestrator(results);
      const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
      return service.assemble(makeRequest({ contextBudget: { maxItems: 10 } }));
    };

    const rHigh = await assembleWith(resultsHigh);
    const rLow = await assembleWith(resultsLow);

    const highEvidence = rHigh.items.filter(i => i.selectionClass === 'evidence');
    const lowEvidence = rLow.items.filter(i => i.selectionClass === 'evidence');

    // When r1 has high score, it comes first
    expect(highEvidence[0]?.sourceKey).toBe('r1');
    // When r1 has low score, r2 comes first
    expect(lowEvidence[0]?.sourceKey).toBe('r2');
  });

  it('ContextScoringService: higher semantic score always yields higher finalScore', () => {
    const scoringService = new ContextScoringService();
    const baseCandidate = {
      id: 'test',
      content: 'test',
      selectionClass: 'evidence',
      layerAssignment: 'evidence' as const,
      estimatedTokens: 10,
      authorityTier: null,
    };

    const scoreHigh = scoringService.computeCandidateScore({ ...baseCandidate, score: 0.9 });
    const scoreLow = scoringService.computeCandidateScore({ ...baseCandidate, score: 0.1 });

    expect(scoreHigh.finalScore).toBeGreaterThan(scoreLow.finalScore);
    expect(scoreHigh.semanticScore).toBeGreaterThan(scoreLow.semanticScore);
  });
});

// ─── 9. No candidate disappears without a decision record ────────────────────

describe('P7B: no silent drops', () => {
  it('every candidate has exactly one decision record', async () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeResult({ itemKey: `r${i}`, title: `Doc ${i}`, providerId: 'local', score: 0.9 - i * 0.08 }),
    );
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    const d = result.diagnostics!;
    // 10 evidence candidates → 10 decisions
    expect(d.decisions.length).toBe(10);
    // No duplicate candidate IDs
    const seen = new Set<string>();
    for (const dec of d.decisions) {
      expect(seen.has(dec.candidateId)).toBe(false);
      seen.add(dec.candidateId);
    }
  });

  it('empty retrieval still produces valid diagnostics with zero candidates', async () => {
    const orchestrator = makeMockOrchestrator([]);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    const d = result.diagnostics!;
    expect(d).toBeDefined();
    expect(d.decisions).toHaveLength(0);
    expect(d.totalCandidatesConsidered).toBe(0);
    expect(d.totalIncluded).toBe(0);
  });

  it('retrieval failure still produces valid diagnostics', async () => {
    const orchestrator = {
      retrieve: vi.fn().mockRejectedValue(new Error('Connection failed')),
    } as unknown as RetrievalOrchestrator;
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    expect(result.diagnostics).toBeDefined();
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some(w => w.includes('Retrieval failed'))).toBe(true);
  });
});

// ─── 10. ContextScoringService formula correctness ───────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

describe('ContextScoringService: deterministic formula', () => {
  it('computeRecencyScore: recent item scores higher than old item', () => {
    const nowMs = Date.now();
    const recentTs = new Date(nowMs - 3 * DAY_MS).toISOString(); // 3 days ago
    const oldTs = new Date(nowMs - 60 * DAY_MS).toISOString(); // 60 days ago
    expect(computeRecencyScore(recentTs, nowMs)).toBeGreaterThan(computeRecencyScore(oldTs, nowMs));
  });

  it('computeRecencyScore: null timestamp returns neutral score', () => {
    expect(computeRecencyScore(null)).toBe(NEUTRAL_RECENCY_SCORE);
    expect(computeRecencyScore(undefined)).toBe(NEUTRAL_RECENCY_SCORE);
  });

  it('computeGraphDepthPenalty: direct evidence has 0 penalty', () => {
    expect(computeGraphDepthPenalty(0)).toBe(0);
  });

  it('computeGraphDepthPenalty: deeper hops have larger negative penalty', () => {
    expect(computeGraphDepthPenalty(1)).toBeLessThan(0);
    expect(computeGraphDepthPenalty(2)).toBeLessThan(computeGraphDepthPenalty(1));
  });

  it('computeGraphDepthPenalty: penalty is capped at -0.5', () => {
    expect(computeGraphDepthPenalty(100)).toBe(-0.5);
  });

  it('SCORING_WEIGHTS sum to approximately 1.0', () => {
    const sum = Object.values(SCORING_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('same candidate always produces same ScoreBreakdown', () => {
    const scoringService = new ContextScoringService();
    const candidate = {
      id: 'test-id',
      content: 'test content',
      selectionClass: 'evidence',
      layerAssignment: 'evidence' as const,
      estimatedTokens: 20,
      score: 0.75,
      authorityTier: 'verified_derived' as const,
      timestamp: '2025-01-01T00:00:00Z',
    };
    const nowMs = new Date('2025-01-08T00:00:00Z').getTime(); // 7 days after candidate

    const score1 = scoringService.computeCandidateScore(candidate, 0, nowMs);
    const score2 = scoringService.computeCandidateScore(candidate, 0, nowMs);

    expect(score1).toEqual(score2);
    expect(score1.finalScore).toBeCloseTo(score2.finalScore);
  });
});

// ─── 11. compareContextCandidates: total-order properties ────────────────────

describe('compareContextCandidates: total-order guarantees', () => {
  it('is antisymmetric: compare(a, b) and compare(b, a) have opposite signs', () => {
    const bdA = makeScoreBreakdown(0.7, { authorityScore: 0.5 });
    const bdB = makeScoreBreakdown(0.4, { authorityScore: 0.5 });
    const a = makeRankedCandidate({ id: 'a', scoreBreakdown: bdA });
    const b = makeRankedCandidate({ id: 'b', scoreBreakdown: bdB });
    expect(Math.sign(compareContextCandidates(a, b))).toBe(-Math.sign(compareContextCandidates(b, a)));
  });

  it('is transitive: if a < b and b < c then a < c', () => {
    const bdA = makeScoreBreakdown(0.9, { authorityScore: 0.9 });
    const bdB = makeScoreBreakdown(0.7, { authorityScore: 0.5 });
    const bdC = makeScoreBreakdown(0.3, { authorityScore: 0.1 });
    const a = makeRankedCandidate({ id: 'a', scoreBreakdown: bdA });
    const b = makeRankedCandidate({ id: 'b', scoreBreakdown: bdB });
    const c = makeRankedCandidate({ id: 'c', scoreBreakdown: bdC });

    expect(compareContextCandidates(a, b)).toBeLessThan(0);
    expect(compareContextCandidates(b, c)).toBeLessThan(0);
    expect(compareContextCandidates(a, c)).toBeLessThan(0);
  });

  it('returns 0 only when IDs are equal', () => {
    const bd = makeScoreBreakdown(0.5, { authorityScore: 0.5 });
    const c = makeRankedCandidate({ id: 'same-id', scoreBreakdown: bd });
    expect(compareContextCandidates(c, c)).toBe(0);
  });
});

// ─── 13. Regression: strict mode still excludes graph_context items ──────────

describe('P7B regression: existing mode behavior preserved', () => {
  it('strict mode: no graph_context items in diagnostics or result', async () => {
    const results = [
      makeResult({ itemKey: 'r1', title: 'Doc A', providerId: 'local', score: 0.9 }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const mockGraph: GraphTraversalService = {
      expandFromEvidence: vi.fn().mockResolvedValue([]),
    } as unknown as GraphTraversalService;
    const service = new ContextAssemblyService(orchestrator, policyService, mockGraph);
    const result = await service.assemble(makeRequest({
      groundingMode: 'strict',
      contextBudget: { maxItems: 5, maxItemsPerClass: { graph_context: 5 } },
    }));

    const graphItems = result.items.filter(i => i.selectionClass === 'graph_context');
    expect(graphItems.length).toBe(0);
    // Graph traversal should NOT be called in strict mode
    expect(mockGraph.expandFromEvidence).not.toHaveBeenCalled();
  });

  it('diagnostics are always populated even when empty', async () => {
    const orchestrator = makeMockOrchestrator([]);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    const result = await service.assemble(makeRequest({ contextBudget: { maxItems: 5 } }));

    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics!.assemblyMode).toBeDefined();
    expect(Array.isArray(result.diagnostics!.decisions)).toBe(true);
    expect(Array.isArray(result.diagnostics!.tieBreakRecords)).toBe(true);
  });
});
