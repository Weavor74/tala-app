/**
 * authorityConflictResolver.ts — P7D Feed 4: Cross-Layer Authority Enforcement
 *
 * Detects and resolves canonical-vs-derived conflicts in a unified candidate
 * pool BEFORE the greedy selection pass.
 *
 * Authority hierarchy (descending):
 *   canonical_memory > mem0 > graph > rag
 *
 * A conflict occurs when two or more candidates share the same canonicalId.
 * The candidate from the highest-authority layer (or the one with isCanonical=true
 * / authorityTier='canonical') wins. The others are marked either as:
 *   - "supporting" (canonical winner exists → derived may still enter context
 *     as supporting context, but canonical takes priority for budget)
 *   - "conflict_loser" (no canonical exists → lower-layer candidate is excluded)
 *
 * Affective weighting is NOT consulted here — authority always dominates.
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import type {
  RankedContextCandidate,
  ConflictResolutionRecord,
} from '../../../shared/context/contextDeterminismTypes';

// ─── Authority layer priority ─────────────────────────────────────────────────

/**
 * Source-layer priority for cross-layer authority conflict resolution.
 *
 * Lower number = higher authority.
 * canonical_memory is listed for completeness, but candidates with
 * isCanonical=true or authorityTier='canonical' are handled separately
 * (they always win regardless of sourceLayer).
 *
 * Unknown / absent sourceLayer defaults to 999 (lowest priority).
 */
export const AUTHORITY_LAYER_PRIORITY: Record<string, number> = {
  canonical_memory: 0,
  mem0: 1,
  graph: 2,
  rag: 3,
};

// ─── Result type ──────────────────────────────────────────────────────────────

/**
 * The outcome of a cross-layer authority conflict resolution pass.
 *
 * Produced by resolveMemoryAuthorityConflict() for consumption by the
 * greedy selection loop in ContextAssemblyService._selectItemsGlobal().
 */
export interface AuthorityConflictResult {
  /**
   * IDs of derived candidates that are in a conflict group where a canonical
   * candidate (isCanonical=true or authorityTier='canonical') is the winner.
   *
   * These candidates MAY still enter context as supporting information when
   * the global budget allows. At selection time:
   *   - If included → reason: 'included.supporting_derived'
   *   - If excluded / moved to latent → reason: 'excluded.superseded_by_canonical'
   */
  supportingIds: Set<string>;

  /**
   * IDs of non-canonical candidates that lost an authority conflict where
   * no canonical candidate was present (e.g. mem0 vs rag for the same
   * canonicalId). The winner is the higher-priority-layer candidate.
   *
   * These candidates are always excluded regardless of budget.
   * At selection time → reason: 'excluded.authority_conflict'.
   */
  conflictLoserIds: Set<string>;

  /**
   * IDs of canonical candidates (isCanonical=true or authorityTier='canonical')
   * that won a conflict. These are flagged so that conflictResolved=true
   * can be set on their ContextDecision.
   */
  canonicalWinnerIds: Set<string>;

  /**
   * Conflict resolution records emitted for every conflict pair.
   * Appended to ContextAssemblyDiagnostics.conflictResolutionRecords.
   */
  records: ConflictResolutionRecord[];
}

// ─── Core resolver ────────────────────────────────────────────────────────────

/**
 * Resolve cross-layer authority conflicts in a unified ranked candidate pool.
 *
 * Algorithm:
 *   1. Group candidates by canonicalId (skip those with no canonicalId).
 *   2. For each conflict group (2+ members):
 *        a. If any member is canonical (isCanonical=true or authorityTier='canonical'):
 *             - That member is the canonical winner.
 *             - All other members are added to supportingIds.
 *             - A ConflictResolutionRecord(winner='canonical') is emitted per pair.
 *        b. If no canonical member exists:
 *             - Sort by AUTHORITY_LAYER_PRIORITY (lower = higher authority).
 *             - Tie on priority: deterministic sort by candidate id.
 *             - The first sorted member wins.
 *             - All others are added to conflictLoserIds.
 *             - A ConflictResolutionRecord(winner='higher_authority_layer') is emitted per pair.
 *   3. Candidates with no canonicalId are not touched.
 *
 * @param candidates  Ranked candidates from the unified pool (_rankItems output).
 * @returns           AuthorityConflictResult containing three ID sets + records.
 */
export function resolveMemoryAuthorityConflict(
  candidates: RankedContextCandidate[],
): AuthorityConflictResult {
  const supportingIds = new Set<string>();
  const conflictLoserIds = new Set<string>();
  const canonicalWinnerIds = new Set<string>();
  const records: ConflictResolutionRecord[] = [];

  // Step 1: Group by canonicalId.
  const groups = new Map<string, RankedContextCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.canonicalId) {
      let group = groups.get(candidate.canonicalId);
      if (!group) {
        group = [];
        groups.set(candidate.canonicalId, group);
      }
      group.push(candidate);
    }
  }

  // Step 2: Resolve each conflict group.
  for (const [canonicalId, group] of groups) {
    if (group.length < 2) continue; // Single-member group — no conflict.

    const canonicalMembers = group.filter(
      c => c.isCanonical === true || c.authorityTier === 'canonical',
    );

    if (canonicalMembers.length > 0) {
      // ── Case A: canonical winner exists ───────────────────────────────────
      // Use the first canonical member (they are already in rank order from
      // _rankItems, so the top-ranked canonical comes first).
      const canonicalWinner = canonicalMembers[0]!;
      canonicalWinnerIds.add(canonicalWinner.id);

      const derivedMembers = group.filter(
        c => c.isCanonical !== true && c.authorityTier !== 'canonical',
      );

      for (const derived of derivedMembers) {
        supportingIds.add(derived.id);
        records.push({
          canonicalCandidateId: canonicalWinner.id,
          derivedCandidateId: derived.id,
          winner: 'canonical',
          reason:
            `Canonical candidate (id=${canonicalWinner.id}, ` +
            `sourceLayer=${canonicalWinner.sourceLayer ?? 'unknown'}) ` +
            `has authority over derived candidate (id=${derived.id}, ` +
            `sourceLayer=${derived.sourceLayer ?? 'unknown'}) ` +
            `for canonicalId=${canonicalId}.`,
        });
      }
    } else {
      // ── Case B: no canonical — resolve by layer priority ──────────────────
      // Sort by AUTHORITY_LAYER_PRIORITY, then by id for full determinism.
      // Sort in place — group is a local reference used only in this iteration.
      group.sort((a, b) => {
        const prioA = AUTHORITY_LAYER_PRIORITY[a.sourceLayer ?? ''] ?? 999;
        const prioB = AUTHORITY_LAYER_PRIORITY[b.sourceLayer ?? ''] ?? 999;
        if (prioA !== prioB) return prioA - prioB;
        // Tie on priority: lexicographic id (matches total-order comparator convention).
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      });

      const winner = group[0]!;
      const losers = group.slice(1);

      for (const loser of losers) {
        conflictLoserIds.add(loser.id);
        records.push({
          canonicalCandidateId: winner.id,
          derivedCandidateId: loser.id,
          winner: 'higher_authority_layer',
          reason:
            `Layer authority conflict: candidate (id=${winner.id}, ` +
            `sourceLayer=${winner.sourceLayer ?? 'unknown'}) ` +
            `outranks candidate (id=${loser.id}, ` +
            `sourceLayer=${loser.sourceLayer ?? 'unknown'}) ` +
            `for canonicalId=${canonicalId}. ` +
            `Authority hierarchy: canonical_memory > mem0 > graph > rag.`,
        });
      }
    }
  }

  return { supportingIds, conflictLoserIds, canonicalWinnerIds, records };
}
