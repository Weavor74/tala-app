/**
 * ContextScoringService.ts — P7B Deterministic Scoring Formulas + P7D Feed 2 Cross-Layer Normalization
 *
 * Centralizes all scoring logic for context candidates so that:
 *   - Formulas are explicit and numeric.
 *   - Weights/constants are readable and independently testable.
 *   - No LLM/ML judgment is involved.
 *   - Same input always produces the same ScoreBreakdown.
 *
 * P7D Feed 2 adds a normalization stage AFTER base scoring to prevent any
 * single source layer from dominating cross-layer ranking due to scale or bias:
 *   normalizedScore = finalScore × sourceWeight × tokenEfficiencyFactor
 *
 * Consumed by ContextAssemblyService to score candidates before
 * the total-order comparator sorts them.
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import type { ContextCandidate, ScoreBreakdown } from '../../../shared/context/contextDeterminismTypes';
import type { MemoryAuthorityTier } from '../../../shared/memory/authorityTypes';

// ─── Scoring constants ────────────────────────────────────────────────────────

/**
 * Component weights used to compute the final composite score.
 *
 * All weights sum to 1.0. Changing any weight automatically affects all
 * candidates proportionally — no hidden side-effects.
 *
 * Weight rationale:
 *   semantic   0.40 — retrieval relevance is the primary signal
 *   authority  0.25 — canonical items should rank above derived/speculative
 *   recency    0.15 — newer items preferred when relevance is similar
 *   source     0.10 — source-type differentiation (extension point)
 *   graphDepth 0.05 — minor penalty for deep graph hops
 *   affective  0.05 — bounded affective adjustment (capped independently)
 */
export const SCORING_WEIGHTS = {
  semantic: 0.40,
  authority: 0.25,
  recency: 0.15,
  source: 0.10,
  graphDepth: 0.05,
  affective: 0.05,
} as const;

/**
 * Numeric value assigned to each MemoryAuthorityTier for scoring.
 *
 * Higher = more authoritative. Used as the authority component in scoring.
 */
export const AUTHORITY_TIER_SCORES: Record<MemoryAuthorityTier, number> = {
  canonical: 1.0,
  verified_derived: 0.75,
  transient: 0.25,
  speculative: 0.0,
};

/**
 * Neutral authority score used for candidates with no authority tier.
 * Positioned between verified_derived and transient.
 */
export const NEUTRAL_AUTHORITY_SCORE = 0.5;

/**
 * Graph depth penalty applied per hop level.
 * A candidate 2 hops from its evidence seed receives penalty = −(2 × 0.10) = −0.20.
 * Maximum penalty is capped at −0.5 to prevent negative final scores.
 */
export const GRAPH_DEPTH_PENALTY_PER_HOP = 0.10;

/**
 * Maximum absolute graph depth penalty.
 * Prevents deeply nested nodes from receiving extreme negative scores.
 */
export const MAX_GRAPH_DEPTH_PENALTY = 0.5;

/**
 * Recency reference window in milliseconds.
 * Items created within this window receive full recency score (1.0).
 * Items older than (RECENCY_FULL_WINDOW_MS × 4) receive minimum recency score (0.0).
 * Items with no timestamp receive NEUTRAL_RECENCY_SCORE.
 */
export const RECENCY_FULL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Neutral recency score for items with no timestamp. */
export const NEUTRAL_RECENCY_SCORE = 0.5;

// ─── P7D Feed 2: Cross-Layer Normalization constants ─────────────────────────

/**
 * Per-source-layer weight constants for cross-layer normalization (P7D Feed 2).
 *
 * Applied as a multiplier to the base finalScore so that no single source type
 * dominates the unified candidate ranking due to scale or bias.
 *
 * Weight rationale:
 *   canonical_memory 1.0  — highest authority; canonical records
 *   task             1.0  — active task state; equally authoritative
 *   conversation     0.95 — recent conversation; high relevance signal
 *   mem0             0.9  — derived memory layer; trusted but not canonical
 *   graph            0.85 — graph-derived context; structural, one step removed
 *   rag              0.8  — external retrieval; least anchored to canonical truth
 *
 * Unknown or absent sourceLayer falls back to 1.0 (neutral, no penalty).
 */
export const SOURCE_WEIGHT: Record<string, number> = {
  canonical_memory: 1.0,
  task: 1.0,
  conversation: 0.95,
  mem0: 0.9,
  graph: 0.85,
  rag: 0.8,
};

/**
 * Token penalty factor for the token efficiency formula (P7D Feed 2).
 *
 * tokenEfficiencyFactor = 1 / (1 + estimatedTokens × TOKEN_PENALTY_FACTOR)
 *
 * A value of 0.01 means a 100-token item has efficiency ≈ 0.50,
 * and a 50-token item has efficiency ≈ 0.67. Compact items are mildly preferred.
 */
export const TOKEN_PENALTY_FACTOR = 0.01;

// ─── ContextScoringService ────────────────────────────────────────────────────

export class ContextScoringService {
  /**
   * Compute a deterministic ScoreBreakdown for a context candidate.
   *
   * All formula components are explicit:
   *   - semanticScore   from candidate.score (retrieval provider output)
   *   - recencyScore    from candidate.timestamp (ISO-8601) and RECENCY_FULL_WINDOW_MS
   *   - authorityScore  from candidate.authorityTier and AUTHORITY_TIER_SCORES
   *   - sourceWeight    from candidate.sourceLayer and SOURCE_WEIGHT map (P7D Feed 2)
   *   - graphDepthPenalty from candidate.graphHopDepth and GRAPH_DEPTH_PENALTY_PER_HOP
   *   - affectiveAdjustment passed in as an explicit bounded value (caller-supplied)
   *
   * P7D Feed 2: After computing finalScore (base), applies cross-layer normalization:
   *   tokenEfficiency = 1 / (1 + estimatedTokens × TOKEN_PENALTY_FACTOR)
   *   normalizedScore = finalScore × sourceWeight × tokenEfficiency
   *
   * @param candidate           The candidate to score.
   * @param affectiveAdjustment Optional affective boost [0, MAX_AFFECTIVE_BOOST].
   *                            Must already be clamped by the caller before passing in.
   * @param weightMultipliers   P7E: Optional strategy-driven multipliers for source layers.
   * @param nowMs               Reference timestamp for recency calculation.
   *                            Defaults to Date.now(). Override in tests for determinism.
   */
  computeCandidateScore(
    candidate: ContextCandidate,
    affectiveAdjustment: number = 0,
    nowMs: number = Date.now(),
    weightMultipliers: Record<string, number> = {},
  ): ScoreBreakdown {
    const semanticScore = this._clamp01(candidate.score ?? 0);
    const recencyScore = computeRecencyScore(candidate.timestamp ?? null, nowMs);
    const authorityScore = computeAuthorityScore(candidate.authorityTier);
    
    // P7E: Apply optional strategy multiplier to the base source weight
    const baseSourceWeight = computeSourceWeight(candidate.sourceLayer);
    const multiplier = candidate.sourceLayer ? (weightMultipliers[candidate.sourceLayer] ?? 1.0) : 1.0;
    const sourceWeight = this._clamp(baseSourceWeight * multiplier, 0.1, 2.0);

    const graphDepthPenalty = computeGraphDepthPenalty(candidate.graphHopDepth ?? 0);
    const clampedAffective = this._clamp(affectiveAdjustment, 0, 0.3 * 0.5); // max 0.15

    const finalScore =
      semanticScore * SCORING_WEIGHTS.semantic +
      authorityScore * SCORING_WEIGHTS.authority +
      recencyScore * SCORING_WEIGHTS.recency +
      sourceWeight * SCORING_WEIGHTS.source +
      graphDepthPenalty * SCORING_WEIGHTS.graphDepth +
      clampedAffective * SCORING_WEIGHTS.affective;

    // P7D Feed 2: Cross-layer normalization — applied AFTER base scoring.
    const tokenEfficiency = computeTokenEfficiency(candidate.estimatedTokens);
    const normalizedScore = finalScore * sourceWeight * tokenEfficiency;

    return {
      semanticScore,
      recencyScore,
      authorityScore,
      sourceWeight,
      graphDepthPenalty,
      affectiveAdjustment: clampedAffective,
      finalScore,
      tokenEfficiency,
      normalizedScore,
    };
  }

  private _clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
  }

  private _clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
  }
}

// ─── Pure formula functions (exported for testing) ────────────────────────────

/**
 * Compute a recency score in [0, 1] from an ISO-8601 timestamp.
 *
 * Formula (linear decay):
 *   ageMs   = nowMs − timestamp_ms
 *   score   = 1.0 − (ageMs / (4 × RECENCY_FULL_WINDOW_MS))
 *   clamped to [0, 1]
 *
 * A timestamp within the last 7 days scores between 0.75 and 1.0.
 * A timestamp older than 28 days scores 0.
 * A null timestamp returns NEUTRAL_RECENCY_SCORE (0.5).
 */
export function computeRecencyScore(timestamp: string | null | undefined, nowMs: number = Date.now()): number {
  if (!timestamp) return NEUTRAL_RECENCY_SCORE;
  const ts = Date.parse(timestamp);
  if (isNaN(ts)) return NEUTRAL_RECENCY_SCORE;
  const ageMs = nowMs - ts;
  if (ageMs < 0) return 1.0; // Future-dated items are treated as fully recent
  const decayWindow = 4 * RECENCY_FULL_WINDOW_MS;
  return Math.max(0, Math.min(1, 1.0 - ageMs / decayWindow));
}

/**
 * Map a MemoryAuthorityTier to a numeric score in [0, 1].
 *
 * Null tier → NEUTRAL_AUTHORITY_SCORE (0.5).
 */
export function computeAuthorityScore(tier: MemoryAuthorityTier | null | undefined): number {
  if (!tier) return NEUTRAL_AUTHORITY_SCORE;
  return AUTHORITY_TIER_SCORES[tier] ?? NEUTRAL_AUTHORITY_SCORE;
}

/**
 * Compute a graph depth penalty in [−MAX_GRAPH_DEPTH_PENALTY, 0].
 *
 * hopDepth = 0 → 0.0 (no penalty for direct evidence)
 * hopDepth = 1 → −0.10
 * hopDepth = 2 → −0.20
 * hopDepth ≥ 5 → −0.50 (capped)
 */
export function computeGraphDepthPenalty(hopDepth: number): number {
  if (hopDepth <= 0) return 0;
  return -Math.min(hopDepth * GRAPH_DEPTH_PENALTY_PER_HOP, MAX_GRAPH_DEPTH_PENALTY);
}

/**
 * Look up the source-layer weight from the SOURCE_WEIGHT map (P7D Feed 2).
 *
 * Returns 1.0 for absent or unknown source layers (neutral — no penalty).
 *
 * @param sourceLayer  Candidate sourceLayer string (e.g. 'rag', 'graph', 'canonical_memory').
 */
export function computeSourceWeight(sourceLayer: string | undefined): number {
  if (!sourceLayer) return 1.0;
  return SOURCE_WEIGHT[sourceLayer] ?? 1.0;
}

/**
 * Compute the token efficiency factor for the normalization step (P7D Feed 2).
 *
 * Formula: 1 / (1 + estimatedTokens × TOKEN_PENALTY_FACTOR)
 *
 * A 0-token item → 1.0 (maximum efficiency).
 * A 100-token item → ≈ 0.50.
 * A 50-token item → ≈ 0.67.
 *
 * @param estimatedTokens  Estimated token cost of the candidate (non-negative).
 */
export function computeTokenEfficiency(estimatedTokens: number): number {
  const tokens = Math.max(0, estimatedTokens);
  return 1 / (1 + tokens * TOKEN_PENALTY_FACTOR);
}
