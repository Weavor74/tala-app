/**
 * affectiveWeightingTypes.ts — P7C Affective Weighting shared contracts
 *
 * Defines the types used by AffectiveWeightingService to communicate bounded,
 * deterministic affective adjustments to the context scoring pipeline.
 *
 * DESIGN RULES:
 *   - AffectiveState is the normalized input: mood labels → intensity [0, 1].
 *   - AffectiveAdjustmentResult is the output: a single bounded adjustment
 *     value with full traceability (matched keywords, reason code).
 *   - AffectiveReasonCode is emitted for every candidate — no silent decisions.
 *   - No randomness, no LLM scoring, no probability distributions.
 *
 * Pure TypeScript — no Node.js APIs. Compiled by both tsconfig targets.
 */

// ─── AffectiveState ───────────────────────────────────────────────────────────

/**
 * Normalized representation of affective signals used for context weighting.
 *
 * Produced by ContextAssemblyService from the affective graph items returned by
 * AffectiveGraphService. Keys are lowercase mood/emotion labels; values are
 * intensity scores in [0, 1].
 *
 * Example:
 *   { moodVector: { 'warmly_focused': 0.7, 'warmth': 0.7, 'intensity': 0.6 },
 *     dominantMood: 'warmly_focused' }
 */
export interface AffectiveState {
  /**
   * Map of mood/emotion label → intensity score [0, 1].
   * Keys are lowercase strings (e.g., mood labels, emotional vector component
   * names). Values are normalised intensities.
   */
  moodVector: Record<string, number>;

  /**
   * The dominant (highest-intensity) mood label from the moodVector.
   * Optional; used as a display hint and a primary keyword source.
   */
  dominantMood?: string;

  /**
   * Optional session identifier for diagnostics and audit correlation.
   * Does not affect adjustment computation.
   */
  sessionId?: string;
}

// ─── AffectiveAdjustmentResult ────────────────────────────────────────────────

/**
 * Result of an affective adjustment computation for a single context candidate.
 *
 * Produced by AffectiveWeightingService.computeAdjustment().
 * Every call produces exactly one result with a non-null reasonCode.
 */
export interface AffectiveAdjustmentResult {
  /**
   * Bounded affective score adjustment for the candidate.
   *
   * Range: [0, MAX_AFFECTIVE_WEIGHT × AFFECTIVE_BOOST_FACTOR] = [0, 0.15].
   * 0.0 when no affective state is available or no keywords matched.
   * Must already be clamped before being passed to ContextScoringService.
   */
  adjustment: number;

  /**
   * The keywords from the affective state that matched the candidate text.
   * Empty when adjustment === 0 (or when no state / no keywords / no match).
   * Used for diagnostics and traceability.
   */
  matchedKeywords: string[];

  /**
   * Reason code explaining the outcome of this computation.
   * Always set — no silent decisions.
   */
  reasonCode: AffectiveReasonCode;
}

// ─── AffectiveReasonCode ──────────────────────────────────────────────────────

/**
 * Reason codes emitted by AffectiveWeightingService for every candidate
 * considered for an affective adjustment.
 *
 * These codes appear in ContextDecision.affectiveReasonCode and provide
 * full traceability of when and why affective influence was applied or skipped.
 */
export type AffectiveReasonCode =
  /** No AffectiveState was available for this assembly pass. */
  | 'affective.no_state'
  /**
   * Policy has affective weighting disabled:
   *   - policy.affectiveModulation is absent or enabled === false, or
   *   - affectiveWeight === 0.
   */
  | 'affective.policy_disabled'
  /**
   * The target layer is not eligible for affective adjustment:
   *   - layer === 'evidence' but allowEvidenceReordering === false, or
   *   - layer === 'graph_context' but allowGraphOrderingInfluence === false.
   */
  | 'affective.layer_not_eligible'
  /** Affective state was present but no keywords could be extracted from it. */
  | 'affective.no_keywords'
  /** Keywords were extracted from the state but none overlapped with the candidate. */
  | 'affective.no_keyword_match'
  /** One or more keywords overlapped with the candidate — adjustment applied. */
  | 'affective.keyword_boost_applied';
