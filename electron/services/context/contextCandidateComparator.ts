/**
 * contextCandidateComparator.ts — P7B Total-Order Comparator
 *
 * Provides a single, deterministic, total-order comparator for context candidates.
 * The comparator eliminates all tie ambiguity: for any two distinct candidates,
 * the same call always produces the same ordering.
 *
 * Tie-break order:
 *   1. Higher authority tier score   (canonical > verified_derived > transient > speculative)
 *   2. Higher normalized score       (P7D Feed 2: finalScore × sourceWeight × tokenEfficiency)
 *   3. Lower estimated token cost    (prefer compact items when scores are equal)
 *   4. Newer timestamp               (ISO-8601; missing timestamp treated as epoch 0)
 *   5. Lexicographically smaller id  (stable string sort; guarantees total order)
 *
 * Authority tier dominance (step 1) is never overridden by normalization (P7D constraint).
 *
 * Usage:
 *   const sorted = applyDeterministicTieBreak(candidates);
 *   // or directly:
 *   candidates.sort(compareContextCandidates);
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import type {
  RankedContextCandidate,
  TieBreakRecord,
} from '../../../shared/context/contextDeterminismTypes';

// ─── Total-order comparator ───────────────────────────────────────────────────

/**
 * Compare two RankedContextCandidates for deterministic ordering.
 *
 * Returns a negative number if `a` should come BEFORE `b` (higher priority),
 * a positive number if `b` should come before `a`, or 0 only for identical IDs
 * (which should never happen in a well-formed candidate pool).
 *
 * The comparator is pure and has no side effects.
 * Suitable for use as an Array.sort() comparator.
 */
export function compareContextCandidates(
  a: RankedContextCandidate,
  b: RankedContextCandidate,
): number {
  // 1. Authority tier score: higher is better (canonical > verified_derived > ...)
  const authDiff = b.scoreBreakdown.authorityScore - a.scoreBreakdown.authorityScore;
  if (authDiff !== 0) return authDiff;

  // 2. Normalized score (P7D Feed 2): higher is better
  //    normalizedScore = finalScore × sourceWeight × tokenEfficiency
  //    Prevents any source layer from dominating cross-layer ranking.
  const scoreDiff = b.scoreBreakdown.normalizedScore - a.scoreBreakdown.normalizedScore;
  if (scoreDiff !== 0) return scoreDiff;

  // 3. Token cost: lower is better (prefer compact items to maximise diversity)
  const tokenDiff = a.estimatedTokens - b.estimatedTokens;
  if (tokenDiff !== 0) return tokenDiff;

  // 4. Timestamp: newer is better (missing → treated as epoch 0 = oldest)
  const tsA = parseTimestampMs(a.timestamp);
  const tsB = parseTimestampMs(b.timestamp);
  const tsDiff = tsB - tsA;
  if (tsDiff !== 0) return tsDiff;

  // 5. Lexicographic ID: smaller string sorts first (stable, reproducible)
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

// ─── Tie-break-aware sort ─────────────────────────────────────────────────────

/**
 * Sort a list of RankedContextCandidates using the total-order comparator
 * and collect TieBreakRecords for every tie that was resolved.
 *
 * A TieBreakRecord is emitted whenever two candidates compared equal at
 * stage 1 or 2 (authority or score), meaning a lower-priority criterion
 * had to be used to determine order.
 *
 * Returns a new sorted array (does not mutate the input).
 * Also returns the tie-break records for diagnostics.
 */
export function applyDeterministicTieBreak(candidates: RankedContextCandidate[]): {
  sorted: RankedContextCandidate[];
  tieBreakRecords: TieBreakRecord[];
} {
  if (candidates.length <= 1) {
    return { sorted: candidates.slice(), tieBreakRecords: [] };
  }

  // Clone for safe sort
  const sorted = candidates.slice().sort(compareContextCandidates);
  const tieBreakRecords: TieBreakRecord[] = [];

  // Walk the sorted result looking for pairs where tie-breaking was needed
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const record = detectTieBreakRecord(a, b);
    if (record) {
      tieBreakRecords.push(record);
    }
  }

  return { sorted, tieBreakRecords };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function parseTimestampMs(ts: string | null | undefined): number {
  if (!ts) return 0;
  const ms = Date.parse(ts);
  return isNaN(ms) ? 0 : ms;
}

/**
 * Determine whether a tie-break record should be emitted for an adjacent pair
 * in the sorted output.
 *
 * A tie-break occurred when the pair compared equal at stage 1 or 2 but
 * were separated by a lower-priority criterion.
 */
function detectTieBreakRecord(
  a: RankedContextCandidate,
  b: RankedContextCandidate,
): TieBreakRecord | null {
  const authEqual = a.scoreBreakdown.authorityScore === b.scoreBreakdown.authorityScore;
  const scoreEqual = a.scoreBreakdown.normalizedScore === b.scoreBreakdown.normalizedScore;

  if (!authEqual) return null; // Separated cleanly by authority — no tie
  if (!scoreEqual) return null; // Separated cleanly by normalized score — no tie

  // Both authority and normalized score are equal; a lower-priority criterion was used
  const tokenEqual = a.estimatedTokens === b.estimatedTokens;
  const tsA = parseTimestampMs(a.timestamp);
  const tsB = parseTimestampMs(b.timestamp);
  const timestampEqual = tsA === tsB;

  let criteria: string;
  if (!tokenEqual) {
    criteria = 'token_cost:asc';
  } else if (!timestampEqual) {
    criteria = 'timestamp:desc';
  } else {
    criteria = 'lexical_id:asc';
  }

  return {
    candidateIds: [a.id, b.id],
    tiedScore: a.scoreBreakdown.normalizedScore,
    winnerCandidateId: a.id, // a comes before b in sorted order
    tieBreakCriteria: criteria,
  };
}
