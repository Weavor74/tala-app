/**
 * AffectiveWeightingService.ts — P7C Affective Weighting
 *
 * Computes bounded, deterministic affective score adjustments for context
 * candidates. This is the P7C scoring layer: it translates an AffectiveState
 * (mood labels with intensities) into a bounded score modifier for use in
 * ContextScoringService.computeCandidateScore().
 *
 * DESIGN CONSTRAINTS:
 *   1. Deterministic: same inputs always produce the same output.
 *   2. Formula-based: only keyword overlap counts; no ML/LLM scoring.
 *   3. Bounded: adjustment clamped to [0, MAX_AFFECTIVE_WEIGHT × AFFECTIVE_BOOST_FACTOR].
 *   4. Layer-gated:
 *        evidence       → only when allowEvidenceReordering === true
 *        graph_context  → only when allowGraphOrderingInfluence === true
 *   5. All decisions produce an AffectiveReasonCode — no silent outcomes.
 *   6. Canonical authority always dominates affective adjustment (guaranteed by
 *      the comparator ordering in contextCandidateComparator.ts).
 *   7. Toggleable: when policy is absent or disabled, adjustment is always 0.
 *
 * KEYWORD EXTRACTION RULES:
 *   - Keywords are drawn from moodVector keys (mood/emotion labels).
 *   - Labels are split on whitespace and underscores; words < 3 characters excluded.
 *   - Matching is case-insensitive substring matching against candidate text.
 *   - No stemming, no fuzzy matching, no ML.
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import type { AffectiveModulationPolicy } from '../../../shared/policy/memoryPolicyTypes';
import type {
  AffectiveState,
  AffectiveAdjustmentResult,
  AffectiveReasonCode,
} from '../../../shared/context/affectiveWeightingTypes';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Hard upper bound on affectiveWeight from policy.
 * Values above this are silently clamped in computeAdjustment().
 * Must match MAX_AFFECTIVE_WEIGHT in AffectiveGraphService and ContextAssemblyService.
 */
export const MAX_AFFECTIVE_WEIGHT = 0.3;

/**
 * Fraction of the clamped affectiveWeight applied as the per-item boost cap.
 * Keeps affective signals from dominating structural provenance scoring.
 * E.g. affectiveWeight=0.1 → maxBoostPerItem = 0.05.
 */
export const AFFECTIVE_BOOST_FACTOR = 0.5;

/**
 * Score increment applied per matched affective keyword.
 * Multiple matches accumulate, capped at AFFECTIVE_BOOST_FACTOR × clampedWeight.
 */
export const KEYWORD_BOOST_INCREMENT = 0.05;

/**
 * Minimum keyword length (characters). Words shorter than this are ignored.
 * Prevents noise from short stopwords.
 */
const KEYWORD_MIN_LENGTH = 3;

// ─── AffectiveWeightingService ────────────────────────────────────────────────

/**
 * P7C Affective Weighting Service.
 *
 * Provides two public methods:
 *   extractKeywords(state)           — extract lowercase keywords from AffectiveState
 *   computeAdjustment(text, ...)     — compute bounded adjustment for a candidate
 *
 * Both methods are pure and produce no side effects.
 * Instantiate once and reuse across candidates in the same assembly pass.
 */
export class AffectiveWeightingService {

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Extract lowercase keywords from an AffectiveState for overlap scoring.
   *
   * Sources:
   *   - moodVector keys (mood labels, emotional vector component names).
   *
   * Processing:
   *   - Each key is split on whitespace and underscores.
   *   - Words shorter than KEYWORD_MIN_LENGTH characters are excluded.
   *   - All words are lowercased.
   *
   * Returns a Set for O(1) lookup in computeAdjustment().
   */
  extractKeywords(state: AffectiveState): Set<string> {
    const keywords = new Set<string>();

    for (const label of Object.keys(state.moodVector)) {
      // Add the whole label (if long enough)
      const lower = label.toLowerCase();
      if (lower.length >= KEYWORD_MIN_LENGTH) {
        keywords.add(lower);
      }
      // Add individual words (split on whitespace, underscores, hyphens)
      for (const word of lower.split(/[\s_-]+/)) {
        if (word.length >= KEYWORD_MIN_LENGTH) {
          keywords.add(word);
        }
      }
    }

    return keywords;
  }

  /**
   * Compute the bounded affective adjustment for a single context candidate.
   *
   * Algorithm:
   *   1. Gate checks — return 0 + appropriate reasonCode when any gate fails.
   *   2. Extract keywords from state.moodVector.
   *   3. Count keyword matches in candidateText (case-insensitive substring).
   *   4. adjustment = min(matchCount × KEYWORD_BOOST_INCREMENT, maxBoostPerItem)
   *      where maxBoostPerItem = min(affectiveWeight, 0.3) × AFFECTIVE_BOOST_FACTOR.
   *
   * @param candidateText   Lowercased concatenation of candidate title + content.
   *                        Must be pre-lowercased by the caller.
   * @param state           AffectiveState with moodVector. Null returns adjustment=0.
   * @param policy          AffectiveModulationPolicy. Null/disabled returns adjustment=0.
   * @param targetLayer     'evidence' or 'graph_context'. Checked against policy flags.
   */
  computeAdjustment(
    candidateText: string,
    state: AffectiveState | null,
    policy: AffectiveModulationPolicy | null | undefined,
    targetLayer: 'evidence' | 'graph_context',
  ): AffectiveAdjustmentResult {
    // Gate 1: AffectiveState must be available.
    if (!state) {
      return { adjustment: 0, matchedKeywords: [], reasonCode: 'affective.no_state' };
    }

    // Gate 2: Policy must be present, enabled, and have non-zero weight.
    if (!policy || !policy.enabled || policy.affectiveWeight === 0) {
      return { adjustment: 0, matchedKeywords: [], reasonCode: 'affective.policy_disabled' };
    }

    // Gate 3: Layer eligibility check.
    if (targetLayer === 'evidence' && !policy.allowEvidenceReordering) {
      return { adjustment: 0, matchedKeywords: [], reasonCode: 'affective.layer_not_eligible' };
    }
    if (targetLayer === 'graph_context' && !policy.allowGraphOrderingInfluence) {
      return { adjustment: 0, matchedKeywords: [], reasonCode: 'affective.layer_not_eligible' };
    }

    // Gate 4: At least one keyword must be extractable.
    const keywords = this.extractKeywords(state);
    if (keywords.size === 0) {
      return { adjustment: 0, matchedKeywords: [], reasonCode: 'affective.no_keywords' };
    }

    // Compute keyword overlap.
    const matched: string[] = [];
    for (const kw of keywords) {
      if (candidateText.includes(kw)) {
        matched.push(kw);
      }
    }

    // Gate 5: At least one keyword must match.
    if (matched.length === 0) {
      return { adjustment: 0, matchedKeywords: [], reasonCode: 'affective.no_keyword_match' };
    }

    // Compute bounded adjustment.
    const clampedWeight = Math.min(policy.affectiveWeight, MAX_AFFECTIVE_WEIGHT);
    const maxBoostPerItem = clampedWeight * AFFECTIVE_BOOST_FACTOR;
    const rawBoost = matched.length * KEYWORD_BOOST_INCREMENT;
    const adjustment = Math.min(rawBoost, maxBoostPerItem);

    return {
      adjustment,
      matchedKeywords: matched,
      reasonCode: 'affective.keyword_boost_applied',
    };
  }
}
