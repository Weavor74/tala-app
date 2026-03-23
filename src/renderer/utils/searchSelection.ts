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
    /** Canonical URI for web results. */
    uri?: string;
    /** Absolute file-system path for local results. */
    sourcePath?: string;
    /** Human-readable title. */
    title?: string;
    /** Short excerpt. */
    snippet?: string;
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
 *   1. `uri`  — canonical for web results
 *   2. `sourcePath` — canonical for local file results
 *   3. `result:<fallbackIndex>` — last resort for results with neither
 */
export function resultKey(uri?: string, sourcePath?: string, fallbackIndex = 0): string {
    return uri ?? sourcePath ?? `result:${fallbackIndex}`;
}

// ─── Result → NotebookItem mapping ───────────────────────────────────────────

/**
 * Maps a single search result into a `NotebookItemInput` for persistence.
 */
export function resultToNotebookItem(r: SearchResultInput, fallbackIndex: number): NotebookItemInput {
    const key = resultKey(r.uri, r.sourcePath, fallbackIndex);

    const meta: Record<string, unknown> = { ...r.metadata };
    if (r.providerId) meta.providerId = r.providerId;
    if (r.externalId != null) meta.externalId = r.externalId;

    return {
        item_key: key,
        item_type: r.sourceType ?? (r.providerId === 'local' ? 'local_file' : 'web'),
        source_path: r.sourcePath,
        title: r.title ?? r.sourcePath,
        uri: r.uri,
        snippet: r.snippet?.slice(0, 500),
        metadata_json: Object.keys(meta).length > 0 ? meta : undefined,
    };
}

// ─── Filter helpers ───────────────────────────────────────────────────────────

/**
 * Returns the subset of `results` whose stable key is in `selectedKeys`.
 */
export function filterSelectedResults<T extends SearchResultInput>(
    results: T[],
    selectedKeys: Set<string>,
): Array<{ result: T; index: number }> {
    return results
        .map((r, i) => ({ result: r, index: i }))
        .filter(({ result, index }) => selectedKeys.has(resultKey(result.uri, result.sourcePath, index)));
}

/**
 * Builds a Set of stable keys from *all* results.
 */
export function allResultKeys(results: SearchResultInput[]): Set<string> {
    const keys = new Set<string>();
    results.forEach((r, i) => keys.add(resultKey(r.uri, r.sourcePath, i)));
    return keys;
}
