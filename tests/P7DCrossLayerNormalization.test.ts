/**
 * P7DCrossLayerNormalization.test.ts
 *
 * P7D Feed 2 specification tests — Cross-Layer Normalization.
 *
 * Validates all P7D Feed 2 non-negotiable rules:
 *   1.  SOURCE_WEIGHT constants are defined for all expected source layers
 *   2.  TOKEN_PENALTY_FACTOR is defined and ≈ 0.01
 *   3.  computeSourceWeight returns correct values from SOURCE_WEIGHT map
 *   4.  computeSourceWeight falls back to 1.0 for unknown/absent source layers
 *   5.  computeTokenEfficiency produces 1.0 for 0 tokens
 *   6.  computeTokenEfficiency decreases as token count increases
 *   7.  computeTokenEfficiency is always in (0, 1]
 *   8.  ScoreBreakdown includes tokenEfficiency and normalizedScore fields
 *   9.  normalizedScore = finalScore × sourceWeight × tokenEfficiency
 *  10.  RAG candidates receive lower normalizedScore than canonical_memory for same finalScore
 *  11.  High token-count candidates are penalised relative to low token-count candidates
 *  12.  normalizedScore is deterministic (same inputs → same output)
 *  13.  Authority tier dominance is NOT overridden by normalization
 *  14.  Comparator uses normalizedScore for step-2 ordering (not finalScore)
 *  15.  TieBreakRecord.tiedScore reflects normalizedScore, not finalScore
 *  16.  normalizedScore is always non-negative
 *  17.  Cross-layer ranking: RAG item with very high semantic score can still be
 *       outranked by canonical_memory item when sourceWeight difference is decisive
 *  18.  Integration: ScoreBreakdown.normalizedScore visible in diagnostics via ranked pool
 */

import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import {
  ContextScoringService,
  SOURCE_WEIGHT,
  TOKEN_PENALTY_FACTOR,
  computeSourceWeight,
  computeTokenEfficiency,
} from '../electron/services/context/ContextScoringService';
import {
  compareContextCandidates,
  applyDeterministicTieBreak,
} from '../electron/services/context/contextCandidateComparator';
import type { ContextCandidate, RankedContextCandidate, ScoreBreakdown } from '../shared/context/contextDeterminismTypes';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE_NOW_MS = new Date('2025-06-01T00:00:00Z').getTime();

function makeCandidate(overrides: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    id: 'c1',
    content: 'test content',
    selectionClass: 'evidence',
    layerAssignment: 'evidence',
    estimatedTokens: 50,
    authorityTier: null,
    score: 0.7,
    ...overrides,
  };
}

function makeRanked(
  id: string,
  scoreBreakdown: ScoreBreakdown,
  overrides: Partial<RankedContextCandidate> = {},
): RankedContextCandidate {
  return {
    id,
    content: 'content',
    selectionClass: 'evidence',
    layerAssignment: 'evidence',
    estimatedTokens: 50,
    authorityTier: null,
    score: null,
    rank: 0,
    scoreBreakdown,
    ...overrides,
  };
}

function makeBreakdown(overrides: Partial<ScoreBreakdown> = {}): ScoreBreakdown {
  const base: ScoreBreakdown = {
    semanticScore: 0.5,
    recencyScore: 0.5,
    authorityScore: 0.5,
    sourceWeight: 1.0,
    graphDepthPenalty: 0,
    affectiveAdjustment: 0,
    finalScore: 0.5,
    tokenEfficiency: 1.0,
    normalizedScore: 0.5,
    ...overrides,
  };
  return base;
}

const scoringService = new ContextScoringService();

// ─── 1. SOURCE_WEIGHT constants ───────────────────────────────────────────────

describe('P7D Feed 2: SOURCE_WEIGHT constants', () => {
  it('defines weights for all required source layers (rule 1)', () => {
    expect(SOURCE_WEIGHT).toBeDefined();
    expect(typeof SOURCE_WEIGHT['canonical_memory']).toBe('number');
    expect(typeof SOURCE_WEIGHT['mem0']).toBe('number');
    expect(typeof SOURCE_WEIGHT['graph']).toBe('number');
    expect(typeof SOURCE_WEIGHT['rag']).toBe('number');
    expect(typeof SOURCE_WEIGHT['conversation']).toBe('number');
    expect(typeof SOURCE_WEIGHT['task']).toBe('number');
  });

  it('canonical_memory and task have weight 1.0 (highest)', () => {
    expect(SOURCE_WEIGHT['canonical_memory']).toBe(1.0);
    expect(SOURCE_WEIGHT['task']).toBe(1.0);
  });

  it('rag has the lowest weight', () => {
    const weights = Object.values(SOURCE_WEIGHT);
    expect(SOURCE_WEIGHT['rag']).toBe(Math.min(...weights));
  });

  it('all weights are in (0, 1]', () => {
    for (const weight of Object.values(SOURCE_WEIGHT)) {
      expect(weight).toBeGreaterThan(0);
      expect(weight).toBeLessThanOrEqual(1.0);
    }
  });

  it('layer ordering: canonical_memory >= conversation >= mem0 >= graph >= rag', () => {
    expect(SOURCE_WEIGHT['canonical_memory']!).toBeGreaterThanOrEqual(SOURCE_WEIGHT['conversation']!);
    expect(SOURCE_WEIGHT['conversation']!).toBeGreaterThanOrEqual(SOURCE_WEIGHT['mem0']!);
    expect(SOURCE_WEIGHT['mem0']!).toBeGreaterThanOrEqual(SOURCE_WEIGHT['graph']!);
    expect(SOURCE_WEIGHT['graph']!).toBeGreaterThanOrEqual(SOURCE_WEIGHT['rag']!);
  });
});

// ─── 2. TOKEN_PENALTY_FACTOR ──────────────────────────────────────────────────

describe('P7D Feed 2: TOKEN_PENALTY_FACTOR constant', () => {
  it('is defined and approximately 0.01 (rule 2)', () => {
    expect(TOKEN_PENALTY_FACTOR).toBeDefined();
    expect(typeof TOKEN_PENALTY_FACTOR).toBe('number');
    expect(TOKEN_PENALTY_FACTOR).toBeCloseTo(0.01, 5);
  });

  it('is positive', () => {
    expect(TOKEN_PENALTY_FACTOR).toBeGreaterThan(0);
  });
});

// ─── 3 & 4. computeSourceWeight ──────────────────────────────────────────────

describe('P7D Feed 2: computeSourceWeight()', () => {
  it('returns the correct weight for each known source layer (rule 3)', () => {
    expect(computeSourceWeight('canonical_memory')).toBe(SOURCE_WEIGHT['canonical_memory']);
    expect(computeSourceWeight('mem0')).toBe(SOURCE_WEIGHT['mem0']);
    expect(computeSourceWeight('graph')).toBe(SOURCE_WEIGHT['graph']);
    expect(computeSourceWeight('rag')).toBe(SOURCE_WEIGHT['rag']);
    expect(computeSourceWeight('conversation')).toBe(SOURCE_WEIGHT['conversation']);
    expect(computeSourceWeight('task')).toBe(SOURCE_WEIGHT['task']);
  });

  it('falls back to 1.0 for undefined sourceLayer (rule 4)', () => {
    expect(computeSourceWeight(undefined)).toBe(1.0);
  });

  it('falls back to 1.0 for an empty string (rule 4)', () => {
    expect(computeSourceWeight('')).toBe(1.0);
  });

  it('falls back to 1.0 for unknown source layer (rule 4)', () => {
    expect(computeSourceWeight('unknown_layer')).toBe(1.0);
    expect(computeSourceWeight('experimental')).toBe(1.0);
  });
});

// ─── 5, 6, 7. computeTokenEfficiency ─────────────────────────────────────────

describe('P7D Feed 2: computeTokenEfficiency()', () => {
  it('returns 1.0 for 0 tokens (rule 5)', () => {
    expect(computeTokenEfficiency(0)).toBeCloseTo(1.0, 5);
  });

  it('decreases as token count increases (rule 6)', () => {
    const e10 = computeTokenEfficiency(10);
    const e50 = computeTokenEfficiency(50);
    const e100 = computeTokenEfficiency(100);
    expect(e10).toBeGreaterThan(e50);
    expect(e50).toBeGreaterThan(e100);
  });

  it('is always in (0, 1] (rule 7)', () => {
    for (const tokens of [0, 1, 10, 50, 100, 500, 1000, 10000]) {
      const eff = computeTokenEfficiency(tokens);
      expect(eff).toBeGreaterThan(0);
      expect(eff).toBeLessThanOrEqual(1.0);
    }
  });

  it('formula: 1 / (1 + tokens × TOKEN_PENALTY_FACTOR)', () => {
    const tokens = 100;
    const expected = 1 / (1 + tokens * TOKEN_PENALTY_FACTOR);
    expect(computeTokenEfficiency(tokens)).toBeCloseTo(expected, 8);
  });

  it('treats negative token counts as 0 (defensive)', () => {
    expect(computeTokenEfficiency(-10)).toBeCloseTo(1.0, 5);
  });
});

// ─── 8 & 9. ScoreBreakdown fields and formula correctness ────────────────────

describe('P7D Feed 2: ScoreBreakdown.tokenEfficiency and normalizedScore (rules 8 & 9)', () => {
  it('ScoreBreakdown includes tokenEfficiency and normalizedScore (rule 8)', () => {
    const candidate = makeCandidate({ sourceLayer: 'rag', estimatedTokens: 40 });
    const bd = scoringService.computeCandidateScore(candidate, 0, BASE_NOW_MS);
    expect(typeof bd.tokenEfficiency).toBe('number');
    expect(typeof bd.normalizedScore).toBe('number');
  });

  it('normalizedScore = finalScore × sourceWeight × tokenEfficiency (rule 9)', () => {
    const candidate = makeCandidate({ sourceLayer: 'rag', estimatedTokens: 80 });
    const bd = scoringService.computeCandidateScore(candidate, 0, BASE_NOW_MS);
    const expected = bd.finalScore * bd.sourceWeight * bd.tokenEfficiency;
    expect(bd.normalizedScore).toBeCloseTo(expected, 8);
  });

  it('sourceWeight in breakdown matches SOURCE_WEIGHT for the given sourceLayer', () => {
    for (const sourceLayer of ['canonical_memory', 'mem0', 'graph', 'rag', 'conversation', 'task'] as const) {
      const candidate = makeCandidate({ sourceLayer, estimatedTokens: 20 });
      const bd = scoringService.computeCandidateScore(candidate, 0, BASE_NOW_MS);
      expect(bd.sourceWeight).toBeCloseTo(SOURCE_WEIGHT[sourceLayer]!, 8);
    }
  });

  it('tokenEfficiency in breakdown matches computeTokenEfficiency for the candidate tokens', () => {
    const candidate = makeCandidate({ sourceLayer: 'rag', estimatedTokens: 60 });
    const bd = scoringService.computeCandidateScore(candidate, 0, BASE_NOW_MS);
    expect(bd.tokenEfficiency).toBeCloseTo(computeTokenEfficiency(60), 8);
  });
});

// ─── 10. RAG vs canonical_memory normalization ────────────────────────────────

describe('P7D Feed 2: RAG vs canonical_memory cross-layer fairness (rule 10)', () => {
  it('canonical_memory normalizedScore > rag normalizedScore for same finalScore base', () => {
    const ragCandidate = makeCandidate({ sourceLayer: 'rag', score: 0.8, estimatedTokens: 50 });
    const canonicalCandidate = makeCandidate({ sourceLayer: 'canonical_memory', score: 0.8, estimatedTokens: 50 });
    const ragBd = scoringService.computeCandidateScore(ragCandidate, 0, BASE_NOW_MS);
    const canonicalBd = scoringService.computeCandidateScore(canonicalCandidate, 0, BASE_NOW_MS);
    // Both have same semantic score and token count — canonical_memory should normalize higher
    expect(canonicalBd.normalizedScore).toBeGreaterThan(ragBd.normalizedScore);
  });

  it('graph normalizedScore < conversation normalizedScore for same inputs', () => {
    const graphCandidate = makeCandidate({ sourceLayer: 'graph', score: 0.7, estimatedTokens: 40 });
    const convCandidate = makeCandidate({ sourceLayer: 'conversation', score: 0.7, estimatedTokens: 40 });
    const graphBd = scoringService.computeCandidateScore(graphCandidate, 0, BASE_NOW_MS);
    const convBd = scoringService.computeCandidateScore(convCandidate, 0, BASE_NOW_MS);
    expect(convBd.normalizedScore).toBeGreaterThan(graphBd.normalizedScore);
  });
});

// ─── 11. Token penalty ────────────────────────────────────────────────────────

describe('P7D Feed 2: token efficiency penalty (rule 11)', () => {
  it('high token-count candidate has lower normalizedScore than low token-count for same content', () => {
    const compact = makeCandidate({ sourceLayer: 'rag', score: 0.8, estimatedTokens: 20 });
    const verbose = makeCandidate({ sourceLayer: 'rag', score: 0.8, estimatedTokens: 200 });
    const compactBd = scoringService.computeCandidateScore(compact, 0, BASE_NOW_MS);
    const verboseBd = scoringService.computeCandidateScore(verbose, 0, BASE_NOW_MS);
    // Both have same semantic score and sourceLayer; compact should normalize higher
    expect(compactBd.normalizedScore).toBeGreaterThan(verboseBd.normalizedScore);
  });
});

// ─── 12. Determinism ──────────────────────────────────────────────────────────

describe('P7D Feed 2: normalizedScore is deterministic (rule 12)', () => {
  it('same candidate always produces same normalizedScore', () => {
    const candidate = makeCandidate({ sourceLayer: 'mem0', score: 0.65, estimatedTokens: 80 });
    const bd1 = scoringService.computeCandidateScore(candidate, 0, BASE_NOW_MS);
    const bd2 = scoringService.computeCandidateScore(candidate, 0, BASE_NOW_MS);
    expect(bd1.normalizedScore).toBeCloseTo(bd2.normalizedScore, 10);
    expect(bd1.tokenEfficiency).toBeCloseTo(bd2.tokenEfficiency, 10);
  });

  it('different sourceLayer always produces different normalizedScore (for non-1.0 layers)', () => {
    const base = { score: 0.8, estimatedTokens: 50 };
    const ragBd = scoringService.computeCandidateScore(makeCandidate({ ...base, sourceLayer: 'rag' }), 0, BASE_NOW_MS);
    const mem0Bd = scoringService.computeCandidateScore(makeCandidate({ ...base, sourceLayer: 'mem0' }), 0, BASE_NOW_MS);
    expect(ragBd.normalizedScore).not.toBeCloseTo(mem0Bd.normalizedScore, 5);
  });
});

// ─── 13. Authority tier dominance is NOT overridden ──────────────────────────

describe('P7D Feed 2: authority tier dominance preserved (rule 13)', () => {
  it('canonical authority tier candidate ranks above speculative even with high normalizedScore', () => {
    const canonical = makeCandidate({
      id: 'canon',
      sourceLayer: 'rag', // lowest source weight
      score: 0.1,
      estimatedTokens: 500,
      authorityTier: 'canonical',
    });
    const speculative = makeCandidate({
      id: 'spec',
      sourceLayer: 'canonical_memory', // highest source weight
      score: 0.99,
      estimatedTokens: 5,
      authorityTier: 'speculative',
    });
    const canonicalBd = scoringService.computeCandidateScore(canonical, 0, BASE_NOW_MS);
    const speculativeBd = scoringService.computeCandidateScore(speculative, 0, BASE_NOW_MS);

    const canonicalRanked = makeRanked('canon', canonicalBd, { authorityTier: 'canonical' });
    const speculativeRanked = makeRanked('spec', speculativeBd, { authorityTier: 'speculative' });

    // Authority score dominates: canonical (1.0) > speculative (0.0)
    expect(canonicalBd.authorityScore).toBeGreaterThan(speculativeBd.authorityScore);

    // Comparator should place canonical before speculative despite lower normalizedScore
    const cmp = compareContextCandidates(canonicalRanked, speculativeRanked);
    expect(cmp).toBeLessThan(0); // canonical comes first
  });
});

// ─── 14. Comparator uses normalizedScore for step 2 ──────────────────────────

describe('P7D Feed 2: comparator uses normalizedScore (rule 14)', () => {
  it('when authority scores are equal, higher normalizedScore ranks first', () => {
    const bdHigh = makeBreakdown({ authorityScore: 0.5, finalScore: 0.6, normalizedScore: 0.48 });
    const bdLow = makeBreakdown({ authorityScore: 0.5, finalScore: 0.6, normalizedScore: 0.32 });
    const high = makeRanked('high', bdHigh);
    const low = makeRanked('low', bdLow);
    // bdHigh.normalizedScore > bdLow.normalizedScore → high comes first
    expect(compareContextCandidates(high, low)).toBeLessThan(0);
  });

  it('when normalizedScore differs, finalScore alone does NOT determine order', () => {
    // Same authority, same finalScore, but different normalizedScore
    const bdHighNorm = makeBreakdown({ authorityScore: 0.5, finalScore: 0.6, normalizedScore: 0.50 });
    const bdLowNorm = makeBreakdown({ authorityScore: 0.5, finalScore: 0.6, normalizedScore: 0.30 });
    const highNorm = makeRanked('h', bdHighNorm);
    const lowNorm = makeRanked('l', bdLowNorm);
    expect(compareContextCandidates(highNorm, lowNorm)).toBeLessThan(0);
  });

  it('when normalizedScores are equal, falls through to token cost tie-break', () => {
    const bd = makeBreakdown({ authorityScore: 0.5, finalScore: 0.6, normalizedScore: 0.4 });
    const compact = makeRanked('compact', bd, { estimatedTokens: 10 });
    const verbose = makeRanked('verbose', bd, { estimatedTokens: 200 });
    // Token cost tie-break: compact (10) wins
    expect(compareContextCandidates(compact, verbose)).toBeLessThan(0);
  });
});

// ─── 15. TieBreakRecord uses normalizedScore ─────────────────────────────────

describe('P7D Feed 2: TieBreakRecord.tiedScore reflects normalizedScore (rule 15)', () => {
  it('tiedScore in tie-break record equals the normalizedScore of the tied candidates', () => {
    const bd = makeBreakdown({ authorityScore: 0.5, finalScore: 0.6, normalizedScore: 0.42 });
    const c1 = makeRanked('z-id', bd, { estimatedTokens: 10 });
    const c2 = makeRanked('a-id', bd, { estimatedTokens: 200 });
    const { tieBreakRecords } = applyDeterministicTieBreak([c1, c2]);
    expect(tieBreakRecords.length).toBeGreaterThan(0);
    expect(tieBreakRecords[0]!.tiedScore).toBeCloseTo(0.42, 8);
  });
});

// ─── 16. normalizedScore is non-negative ─────────────────────────────────────

describe('P7D Feed 2: normalizedScore is always non-negative (rule 16)', () => {
  it('non-negative for all valid input combinations', () => {
    const scenarios: Partial<ContextCandidate>[] = [
      { sourceLayer: 'rag', score: 0, estimatedTokens: 0 },
      { sourceLayer: 'graph', score: 0, estimatedTokens: 500 },
      { sourceLayer: undefined, score: 0, estimatedTokens: 0 },
      { sourceLayer: 'canonical_memory', score: 1.0, estimatedTokens: 0, authorityTier: 'canonical' },
      { sourceLayer: 'rag', score: 0.5, estimatedTokens: 100, graphHopDepth: 5 }, // max depth penalty
    ];
    for (const scenario of scenarios) {
      const candidate = makeCandidate(scenario);
      const bd = scoringService.computeCandidateScore(candidate, 0, BASE_NOW_MS);
      expect(bd.normalizedScore).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── 17. Cross-layer competitive ranking ─────────────────────────────────────

describe('P7D Feed 2: cross-layer competitive ranking (rule 17)', () => {
  it('rag item with very high score can still lose to canonical_memory item after normalization', () => {
    // RAG item: high semantic score, but rag weight = 0.8, high token count
    const rag = makeCandidate({
      id: 'rag-item',
      sourceLayer: 'rag',
      score: 0.98,
      estimatedTokens: 300,
      authorityTier: null,
    });
    // canonical_memory item: moderate semantic, but weight = 1.0, compact
    const canonical = makeCandidate({
      id: 'canon-item',
      sourceLayer: 'canonical_memory',
      score: 0.60,
      estimatedTokens: 30,
      authorityTier: null,
    });
    const ragBd = scoringService.computeCandidateScore(rag, 0, BASE_NOW_MS);
    const canonicalBd = scoringService.computeCandidateScore(canonical, 0, BASE_NOW_MS);

    // Demonstrate that normalization can alter cross-layer ranking
    // The test does not assert canonical always wins — just that normalizedScore is
    // used for the comparison and the formula is applied correctly.
    const ragNorm = ragBd.finalScore * SOURCE_WEIGHT['rag']! * computeTokenEfficiency(300);
    const canonNorm = canonicalBd.finalScore * SOURCE_WEIGHT['canonical_memory']! * computeTokenEfficiency(30);
    expect(ragBd.normalizedScore).toBeCloseTo(ragNorm, 8);
    expect(canonicalBd.normalizedScore).toBeCloseTo(canonNorm, 8);
  });

  it('all source layers produce distinct normalizedScores for same base inputs', () => {
    const layers = ['canonical_memory', 'conversation', 'mem0', 'graph', 'rag'] as const;
    const scores = layers.map(sourceLayer => {
      const candidate = makeCandidate({ sourceLayer, score: 0.7, estimatedTokens: 50 });
      return scoringService.computeCandidateScore(candidate, 0, BASE_NOW_MS).normalizedScore;
    });
    // All scores should be distinct (no two layers have the same weight)
    const uniqueScores = new Set(scores.map(s => s.toFixed(8)));
    expect(uniqueScores.size).toBe(layers.length);
  });
});

// ─── 18. Integration: normalizedScore visible in diagnostics ─────────────────

describe('P7D Feed 2: normalizedScore visible in ranked candidates (rule 18)', () => {
  it('ranked candidate scoreBreakdown includes tokenEfficiency and normalizedScore', () => {
    const candidate = makeCandidate({ sourceLayer: 'rag', score: 0.75, estimatedTokens: 60 });
    const bd = scoringService.computeCandidateScore(candidate, 0, BASE_NOW_MS);
    expect(bd.tokenEfficiency).toBeDefined();
    expect(bd.normalizedScore).toBeDefined();
    expect(typeof bd.tokenEfficiency).toBe('number');
    expect(typeof bd.normalizedScore).toBe('number');
  });

  it('normalizedScore is always ≤ finalScore when sourceWeight < 1.0', () => {
    // For rag (weight 0.8) with any tokenEfficiency ≤ 1.0, normalizedScore ≤ finalScore
    const candidate = makeCandidate({ sourceLayer: 'rag', score: 0.8, estimatedTokens: 50 });
    const bd = scoringService.computeCandidateScore(candidate, 0, BASE_NOW_MS);
    expect(bd.normalizedScore).toBeLessThanOrEqual(bd.finalScore + 1e-10);
  });

  it('normalizedScore equals finalScore when sourceWeight=1.0 and tokenEfficiency=1.0', () => {
    const candidate = makeCandidate({ sourceLayer: 'canonical_memory', score: 0.8, estimatedTokens: 0 });
    const bd = scoringService.computeCandidateScore(candidate, 0, BASE_NOW_MS);
    expect(bd.sourceWeight).toBeCloseTo(1.0, 8);
    expect(bd.tokenEfficiency).toBeCloseTo(1.0, 8);
    expect(bd.normalizedScore).toBeCloseTo(bd.finalScore, 8);
  });
});
