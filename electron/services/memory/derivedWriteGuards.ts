/**
 * derivedWriteGuards.ts — P7A Derived Write Enforcement Utilities
 *
 * ARCHITECTURAL CONSTRAINT:
 *   Every durable write to a derived system (mem0, graph, vector, local JSON)
 *   MUST carry a canonical_memory_id that references a memory_records row in
 *   PostgreSQL. MemoryAuthorityService is the only gateway for issuing such IDs.
 *
 *   These guards are called by derived stores before persisting. They do NOT
 *   block legitimate transient/in-memory operations. Only durable writes
 *   (local JSON, remote mem0, graph DB, vector index) are in scope.
 *
 * Behaviour:
 *   - In test / strict mode (TALA_STRICT_MEMORY=1): throws on violation.
 *   - In production: logs a warning; the write proceeds but the violation is
 *     flagged for later integrity audit.
 *
 * Integration points:
 *   - MemoryService.add()       → rejectAuthoritativeWriteOutsideMemoryAuthority()
 *   - ToolService mem0_add tool → assertDerivedMemoryAnchor()
 *   - AgentService.addMemory()  → canonicalises before deriving (write gate)
 *   - Any future derived store  → assertDerivedMemoryAnchor() at write site
 */

import type { DerivedWriteAnchor, RankedMemoryCandidate, MemoryAuthorityTier } from '../../../shared/memory/authorityTypes';

// Re-export so callers can import guards + types from one place.
export type { DerivedWriteAnchor, RankedMemoryCandidate, MemoryAuthorityTier };

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

function isStrictMode(): boolean {
    return (
        process.env.NODE_ENV === 'test' ||
        process.env.TALA_STRICT_MEMORY === '1'
    );
}

// ---------------------------------------------------------------------------
// assertDerivedMemoryAnchor
// ---------------------------------------------------------------------------

/**
 * Assert that a durable derived write is anchored to a canonical record.
 *
 * @param anchor       - The anchor metadata from the caller.
 * @param source       - Human-readable description of the calling site.
 * @param isDurable    - Set to false for transient/in-memory writes (no enforcement).
 *
 * Throws in test/strict mode; warns in production.
 */
export function assertDerivedMemoryAnchor(
    anchor: DerivedWriteAnchor,
    source: string,
    isDurable: boolean = true,
): void {
    if (!isDurable) return;

    if (!anchor.canonical_memory_id) {
        const message =
            `[P7A] Derived write without canonical_memory_id from "${source}". ` +
            `This violates the Memory Authority Lock. ` +
            `Ensure MemoryAuthorityService.createCanonicalMemory() is called first ` +
            `and the returned ID is passed as canonical_memory_id in metadata.`;

        if (isStrictMode()) {
            throw new Error(message);
        }
        console.warn(message);
    }
}

// ---------------------------------------------------------------------------
// assertCanonicalReferencePresent
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Assert that a canonical_memory_id is present and is a well-formed UUID.
 *
 * @param canonicalMemoryId - The ID to validate.
 * @param source            - Human-readable description of the calling site.
 *
 * Throws in test/strict mode; warns in production.
 */
export function assertCanonicalReferencePresent(
    canonicalMemoryId: string | null | undefined,
    source: string,
): void {
    if (!canonicalMemoryId) {
        const message = `[P7A] Missing canonical_memory_id in "${source}"`;
        if (isStrictMode()) {
            throw new Error(message);
        }
        console.warn(message);
        return;
    }

    if (!UUID_RE.test(canonicalMemoryId)) {
        // Non-UUID synthetic IDs (e.g. 'MEM-xxx') are classified as warnings only —
        // they may originate from graceful degradation paths where Postgres was unavailable.
        console.warn(
            `[P7A] canonical_memory_id "${canonicalMemoryId}" is not a valid UUID in "${source}". ` +
            `This may indicate the write bypassed MemoryAuthorityService.`,
        );
    }
}

// ---------------------------------------------------------------------------
// rejectAuthoritativeWriteOutsideMemoryAuthority
// ---------------------------------------------------------------------------

/**
 * Block a durable memory write that bypasses MemoryAuthorityService.
 *
 * Call this from any derived system (mem0, graph, vector, local JSON) before
 * persisting durable memory-like data. Pass isDurable=false for transient/
 * session-only writes where canonical anchoring is not required.
 *
 * @param anchor   - Anchor metadata from the caller.
 * @param source   - Human-readable calling site (for diagnostics).
 * @param isDurable - Default true. Set false for intentionally transient writes.
 */
export function rejectAuthoritativeWriteOutsideMemoryAuthority(
    anchor: DerivedWriteAnchor,
    source: string,
    isDurable: boolean = true,
): void {
    if (!isDurable) return;
    assertDerivedMemoryAnchor(anchor, source, isDurable);
}

// ---------------------------------------------------------------------------
// rankMemoryByAuthority
// ---------------------------------------------------------------------------

/**
 * Deterministically rank memory candidates by authority tier.
 *
 * Priority (ascending = higher authority):
 *   1 = canonical        (Postgres, status='canonical', UUID anchor)
 *   2 = verified_derived (projected, UUID anchor, version in sync)
 *   3 = transient        (no UUID anchor but acknowledged as temporary)
 *   4 = speculative      (no anchor, unknown origin)
 *
 * @param candidates - Unordered candidate items from various sources.
 * @returns           Ranked list, highest authority first.
 */
export function rankMemoryByAuthority(
    candidates: Array<{
        content: string;
        source_description: string;
        canonical_memory_id?: string | null;
        is_canonical_source?: boolean;
        is_transient?: boolean;
    }>,
): RankedMemoryCandidate[] {
    const ranked: RankedMemoryCandidate[] = candidates.map(c => {
        let tier: MemoryAuthorityTier;
        let priority: number;

        if (c.is_canonical_source) {
            tier = 'canonical';
            priority = 1;
        } else if (c.canonical_memory_id && UUID_RE.test(c.canonical_memory_id)) {
            tier = 'verified_derived';
            priority = 2;
        } else if (c.is_transient) {
            tier = 'transient';
            priority = 3;
        } else {
            tier = 'speculative';
            priority = 4;
        }

        return {
            content: c.content,
            tier,
            canonical_memory_id: c.canonical_memory_id ?? null,
            priority,
            source_description: c.source_description,
        };
    });

    return ranked.sort((a, b) => a.priority - b.priority);
}

// ---------------------------------------------------------------------------
// resolveMemoryAuthorityConflict
// ---------------------------------------------------------------------------

/**
 * Resolve a conflict between a canonical record and a derived record.
 *
 * The canonical record ALWAYS wins. The derived conflict is logged for
 * integrity diagnostics but never silently replaces the canonical fact.
 *
 * @param canonical - The authoritative Postgres record.
 * @param derived   - The derived candidate (mem0, graph, vector).
 * @param source    - Description of the calling context (for diagnostics).
 * @returns         The canonical content and whether a conflict was logged.
 */
export function resolveMemoryAuthorityConflict(
    canonical: { memory_id: string; content_text: string; version: number },
    derived: { content: string; canonical_memory_id: string | null },
    source: string,
): { winner_content: string; conflict_logged: boolean } {
    const conflict = canonical.content_text !== derived.content;
    if (conflict) {
        console.warn(
            `[P7A] Authority conflict detected in "${source}": ` +
            `canonical memory_id=${canonical.memory_id} v${canonical.version} ` +
            `differs from derived (anchor=${derived.canonical_memory_id ?? 'none'}). ` +
            `Canonical wins. Derived content discarded.`,
        );
    }
    return { winner_content: canonical.content_text, conflict_logged: conflict };
}
