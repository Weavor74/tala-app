/**
 * searchSelection.ts
 *
 * Pure utility functions for the search result selection and curated
 * save-to-notebook workflow. Extracted from Search.tsx so the logic
 * can be unit-tested without a browser / DOM environment.
 *
 * Architectural contract:
 *   - Search results are *candidate discovery items*, not memory.
 *   - Notebook membership is the *curation gate*.
 *   - Ingestion (source_documents / document_chunks) is a *separate, explicit step*.
 *   - `resultToNotebookItem` must never trigger content scraping or ingestion.
 */

/**
 * Minimal shape of a search result as consumed by the selection utilities.
 * Mirrors the `Result` interface in Search.tsx but is kept independent so this
 * module remains a pure TypeScript unit.
 */
export interface SearchResultInput {
    /** Canonical URL for web results. */
    url?: string;
    /** Absolute file-system path for local results. */
    path?: string;
    /** Human-readable title. */
    title?: string;
    /** Short excerpt. */
    snippet?: string;
    /** Legacy content field used by local search fallback. */
    content?: string;
    /** Retrieval provider ID, e.g. 'local', 'external:brave'. */
    providerId?: string;
    /** Source category, e.g. 'web', 'local_file'. */
    sourceType?: string;
    /** Provider-native identifier (externalId from NormalizedSearchResult). */
    externalId?: string | null;
    /** Arbitrary provider metadata. */
    metadata?: Record<string, unknown>;
}

/**
 * Minimal shape of a notebook item input accepted by
 * `researchAddItemsToNotebook` / `ResearchRepository.addItemsToNotebook`.
 */
export interface NotebookItemInput {
    item_key: string;
    item_type: string;
    source_path?: string;
    title?: string;
    uri?: string;
    snippet?: string;
    metadata_json?: Record<string, unknown>;
}

// ─── Stable result key ────────────────────────────────────────────────────────

/**
 * Returns a stable, provider-agnostic key for a search result.
 *
 * Priority:
 *   1. `url`  — canonical for web results
 *   2. `path` — canonical for local file results
 *   3. `result:<fallbackIndex>` — last resort for results with neither
 *
 * The key doubles as the `item_key` in `notebook_items`, so it must remain
 * stable between the time a user checks a result and the time "Save Selected"
 * is invoked.
 */
export function resultKey(url?: string, path?: string, fallbackIndex = 0): string {
    return url ?? path ?? `result:${fallbackIndex}`;
}

// ─── Result → NotebookItem mapping ───────────────────────────────────────────

/**
 * Maps a single search result into a `NotebookItemInput` for persistence.
 *
 * This mapping is a *metadata-only* operation — it does NOT fetch, scrape,
 * embed, or ingest any content. The resulting record is a curated reference
 * that can be resolved into full content later via an explicit ingestion step.
 *
 * All normalized fields from `NormalizedSearchResult` are preserved:
 *   - itemKey (= item_key)
 *   - title
 *   - uri
 *   - sourcePath (= source_path)
 *   - snippet
 *   - providerId → metadata_json.providerId
 *   - externalId → metadata_json.externalId (when present)
 *   - metadata   → merged into metadata_json
 */
export function resultToNotebookItem(r: SearchResultInput, fallbackIndex: number): NotebookItemInput {
    const key = resultKey(r.url, r.path, fallbackIndex);

    const meta: Record<string, unknown> = { ...r.metadata };
    // Root-level canonical fields (providerId, externalId) take precedence over
    // any same-named keys that may already be in r.metadata.
    if (r.providerId) meta.providerId = r.providerId;
    if (r.externalId != null) meta.externalId = r.externalId;

    return {
        item_key: key,
        item_type: r.sourceType ?? (r.providerId === 'local' ? 'local_file' : 'web'),
        source_path: r.path,
        title: r.title ?? r.path,
        uri: r.url,
        snippet: (r.snippet || r.content)?.slice(0, 500),
        metadata_json: Object.keys(meta).length > 0 ? meta : undefined,
    };
}

// ─── Filter helpers ───────────────────────────────────────────────────────────

/**
 * Returns the subset of `results` whose stable key is in `selectedKeys`,
 * paired with the original index so that index-based fallback keys remain
 * consistent with what was stored in the selection Set.
 */
export function filterSelectedResults<T extends SearchResultInput>(
    results: T[],
    selectedKeys: Set<string>,
): Array<{ result: T; index: number }> {
    return results
        .map((r, i) => ({ result: r, index: i }))
        .filter(({ result, index }) => selectedKeys.has(resultKey(result.url, result.path, index)));
}

/**
 * Builds a Set of stable keys from *all* results.
 * Used to implement "Select All" without iterating results twice in the component.
 */
export function allResultKeys(results: SearchResultInput[]): Set<string> {
    const keys = new Set<string>();
    results.forEach((r, i) => keys.add(resultKey(r.url, r.path, i)));
    return keys;
}
