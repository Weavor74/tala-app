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
    sourceId?: string | null;
    summary?: string | null;
    contentText?: string | null;
    contentHash?: string | null;
    mimeType?: string | null;
    retrievalStatus?: NotebookRetrievalStatus;
    openTarget?: string | null;
    openTargetType?: NotebookOpenTargetType;
    createdFromSearch?: boolean;
}

/**
 * Minimal shape of a notebook item input accepted by
 * `researchAddItemsToNotebook` / `ResearchRepository.addItemsToNotebook`.
 */
export interface NotebookItemInput {
    item_key: string;
    item_type: string;
    source_id?: string;
    source_path?: string;
    title?: string;
    uri?: string;
    snippet?: string;
    content_hash?: string;
    sourceType?: NotebookSourceType;
    providerId?: string | null;
    summary?: string | null;
    contentText?: string | null;
    mimeType?: string | null;
    retrievalStatus?: NotebookRetrievalStatus;
    openTarget?: string | null;
    openTargetType?: NotebookOpenTargetType;
    createdFromSearch?: boolean;
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
 *
 * NOTE: The `result:<fallbackIndex>` fallback is positional (index-based) and
 * is only stable within a single search run. Do NOT use it as a notebook
 * persistence key — it will not round-trip correctly across separate searches.
 * Only pass results with a URI or sourcePath to researchAddItemsToNotebook().
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
    const normalized = normalizeNotebookItemForStorage({
        item_key: key,
        item_type: r.sourceType ?? (r.providerId === 'local' ? 'local_file' : 'web'),
        source_path: r.sourcePath,
        source_id: r.sourceId ?? r.providerId ?? undefined,
        title: r.title ?? r.sourcePath,
        uri: r.uri,
        snippet: r.snippet?.slice(0, 500),
        content_hash: r.contentHash ?? undefined,
        sourceType: (r.sourceType as NotebookSourceType | undefined),
        providerId: r.providerId ?? null,
        summary: r.summary ?? null,
        contentText: r.contentText ?? null,
        mimeType: r.mimeType ?? null,
        retrievalStatus: r.retrievalStatus,
        openTarget: r.openTarget ?? null,
        openTargetType: r.openTargetType,
        createdFromSearch: r.createdFromSearch ?? true,
        metadata_json: {
            ...(r.metadata ?? {}),
            externalId: r.externalId ?? null,
        },
    });
    return {
        item_key: normalized.item_key,
        item_type: normalized.item_type,
        title: normalized.title ?? undefined,
        uri: normalized.uri ?? undefined,
        snippet: normalized.snippet ?? undefined,
        source_id: normalized.source_id ?? undefined,
        source_path: normalized.source_path ?? undefined,
        content_hash: normalized.content_hash ?? undefined,
        metadata_json: normalized.metadata_json,
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
import type {
    NotebookOpenTargetType,
    NotebookRetrievalStatus,
    NotebookSourceType,
} from '../../../shared/researchTypes';
import { normalizeNotebookItemForStorage } from '../../../shared/researchTypes';
