/**
 * ContextScoringService.ts — P7B Deterministic Scoring Formulas
 *
 * Centralizes all scoring logic for context candidates so that:
 *   - Formulas are explicit and numeric.
 *   - Weights/constants are readable and independently testable.
 *   - No LLM/ML judgment is involved.
 *   - Same input always produces the same ScoreBreakdown.
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

// ─── ContextScoringService ────────────────────────────────────────────────────

export class ContextScoringService {
  /**
   * Compute a deterministic ScoreBreakdown for a context candidate.
   *
   * All formula components are explicit:
   *   - semanticScore   from candidate.score (retrieval provider output)
   *   - recencyScore    from candidate.timestamp (ISO-8601) and RECENCY_FULL_WINDOW_MS
   *   - authorityScore  from candidate.authorityTier and AUTHORITY_TIER_SCORES
   *   - sourceWeight    always 1.0 (extension point for future source weights)
   *   - graphDepthPenalty from candidate.graphHopDepth and GRAPH_DEPTH_PENALTY_PER_HOP
   *   - affectiveAdjustment passed in as an explicit bounded value (caller-supplied)
   *
   * @param candidate           The candidate to score.
   * @param affectiveAdjustment Optional affective boost [0, MAX_AFFECTIVE_BOOST].
   *                            Must already be clamped by the caller before passing in.
   * @param nowMs               Reference timestamp for recency calculation.
   *                            Defaults to Date.now(). Override in tests for determinism.
   */
  computeCandidateScore(
    candidate: ContextCandidate,
    affectiveAdjustment: number = 0,
    nowMs: number = Date.now(),
  ): ScoreBreakdown {
    const semanticScore = this._clamp01(candidate.score ?? 0);
    const recencyScore = computeRecencyScore(candidate.timestamp ?? null, nowMs);
    const authorityScore = computeAuthorityScore(candidate.authorityTier);
    const sourceWeight = 1.0; // Extension point: future source-specific weights go here
    const graphDepthPenalty = computeGraphDepthPenalty(candidate.graphHopDepth ?? 0);
    const clampedAffective = this._clamp(affectiveAdjustment, 0, 0.3 * 0.5); // max 0.15

    const finalScore =
      semanticScore * SCORING_WEIGHTS.semantic +
      authorityScore * SCORING_WEIGHTS.authority +
      recencyScore * SCORING_WEIGHTS.recency +
      sourceWeight * SCORING_WEIGHTS.source +
      graphDepthPenalty * SCORING_WEIGHTS.graphDepth +
      clampedAffective * SCORING_WEIGHTS.affective;

    return {
      semanticScore,
      recencyScore,
      authorityScore,
      sourceWeight,
      graphDepthPenalty,
      affectiveAdjustment: clampedAffective,
      finalScore,
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
