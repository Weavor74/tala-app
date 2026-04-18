/**
 * Research Collections - Shared Types
 *
 * Pure TypeScript type definitions for notebooks, search runs, search run results,
 * and notebook items. No Node.js APIs - safe for use in both the renderer and
 * the Electron main process.
 */

// --- Notebooks ---------------------------------------------------------------

export interface NotebookRecord {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  is_dynamic: boolean;
  query_template: string | null;
  source_scope_json: unknown | null;
  tags_json: unknown | null;
}

export interface CreateNotebookInput {
  name: string;
  description?: string;
  is_dynamic?: boolean;
  query_template?: string;
  source_scope_json?: unknown;
  tags_json?: unknown;
}

export interface UpdateNotebookInput {
  name?: string;
  description?: string;
  is_dynamic?: boolean;
  query_template?: string;
  source_scope_json?: unknown;
  tags_json?: unknown;
}

// --- Search Runs -------------------------------------------------------------

export interface SearchRunRecord {
  id: string;
  query_text: string;
  normalized_query: string | null;
  filters_json: unknown | null;
  source_scope_json: unknown | null;
  executed_at: string;
  executed_by: string | null;
  notebook_id: string | null;
}

export interface CreateSearchRunInput {
  query_text: string;
  normalized_query?: string;
  filters_json?: unknown;
  source_scope_json?: unknown;
  executed_by?: string;
  notebook_id?: string;
}

// --- Source Identity ---------------------------------------------------------

export type NotebookSourceType = 'web' | 'local' | 'generated' | 'api' | 'internal';

export type NotebookRetrievalStatus =
  | 'none'
  | 'saved_metadata_only'
  | 'content_fetched'
  | 'chunked';

export type NotebookOpenTargetType =
  | 'browser'
  | 'workspace_file'
  | 'generated'
  | 'none';

export interface NotebookSourceRecord {
  title: string;
  sourceType: NotebookSourceType;
  uri: string | null;
  sourcePath: string | null;
  openTarget: string | null;
  openTargetType: NotebookOpenTargetType;
  providerId: string | null;
  snippet: string | null;
  summary: string | null;
  contentText: string | null;
  contentHash: string | null;
  mimeType: string | null;
  retrievalStatus: NotebookRetrievalStatus;
  createdFromSearch: boolean;
}

// --- Search Run Results ------------------------------------------------------

export interface SearchRunResultRecord {
  id: string;
  search_run_id: string;
  item_key: string;
  item_type: string;
  source_id: string | null;
  source_path: string | null;
  title: string | null;
  uri: string | null;
  snippet: string | null;
  score: number | null;
  metadata_json: unknown;
  content_hash: string | null;
  captured_at: string;
  sourceType?: NotebookSourceType;
  providerId?: string | null;
  summary?: string | null;
  contentText?: string | null;
  mimeType?: string | null;
  retrievalStatus?: NotebookRetrievalStatus;
  openTarget?: string | null;
  openTargetType?: NotebookOpenTargetType;
  createdFromSearch?: boolean;
}

export interface CreateSearchRunResultInput {
  item_key: string;
  item_type?: string;
  source_id?: string;
  source_path?: string;
  title?: string;
  uri?: string;
  snippet?: string;
  score?: number;
  metadata_json?: unknown;
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
  provider_id?: string;
  sourcePath?: string;
  sourceId?: string;
  sourceTypeRaw?: string;
  url?: string;
  path?: string;
}

// --- Notebook Items ----------------------------------------------------------

export interface NotebookItemRecord {
  id: string;
  notebook_id: string;
  item_key: string;
  item_type: string;
  source_id: string | null;
  source_path: string | null;
  title: string | null;
  uri: string | null;
  snippet: string | null;
  content_hash: string | null;
  added_from_search_run_id: string | null;
  added_at: string;
  metadata_json: unknown;
  sourceType?: NotebookSourceType;
  providerId?: string | null;
  summary?: string | null;
  contentText?: string | null;
  mimeType?: string | null;
  retrievalStatus?: NotebookRetrievalStatus;
  openTarget?: string | null;
  openTargetType?: NotebookOpenTargetType;
  createdFromSearch?: boolean;
}

export interface AddNotebookItemInput {
  item_key: string;
  item_type?: string;
  source_id?: string;
  source_path?: string;
  title?: string;
  uri?: string;
  snippet?: string;
  content_hash?: string;
  added_from_search_run_id?: string;
  metadata_json?: unknown;
  sourceType?: NotebookSourceType;
  providerId?: string | null;
  summary?: string | null;
  contentText?: string | null;
  mimeType?: string | null;
  retrievalStatus?: NotebookRetrievalStatus;
  openTarget?: string | null;
  openTargetType?: NotebookOpenTargetType;
  createdFromSearch?: boolean;
  provider_id?: string;
  sourcePath?: string;
  sourceId?: string;
  sourceTypeRaw?: string;
  url?: string;
  path?: string;
}

type NormalizableItemInput =
  | AddNotebookItemInput
  | CreateSearchRunResultInput
  | NotebookItemRecord
  | SearchRunResultRecord
  | Record<string, unknown>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function findFirstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim();
  }
  return null;
}

function isWebUri(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function readMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const metadata = input.metadata_json;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return { ...(metadata as Record<string, unknown>) };
  }
  return {};
}

function parseSourceType(raw: string | null): NotebookSourceType | null {
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (value === 'web' || value === 'local' || value === 'generated' || value === 'api' || value === 'internal') {
    return value;
  }
  if (value === 'local_file' || value === 'file' || value === 'workspace') return 'local';
  if (value === 'note' || value === 'generated_note') return 'generated';
  if (value.startsWith('api_') || value === 'provider') return 'api';
  if (value.includes('web') || value.includes('url')) return 'web';
  return null;
}

function inferSourceType(args: { uri: string | null; sourcePath: string | null; rawSourceType: string | null; contentText: string | null }): NotebookSourceType {
  if (args.sourcePath) return 'local';
  if (args.uri) return isWebUri(args.uri) ? 'web' : 'api';
  const parsed = parseSourceType(args.rawSourceType);
  if (parsed && parsed !== 'web') return parsed;
  if (args.contentText) return 'generated';
  if (parsed) return parsed;
  return 'generated';
}

function deriveOpenTarget(args: { sourceType: NotebookSourceType; uri: string | null; sourcePath: string | null; contentText: string | null }): {
  openTarget: string | null;
  openTargetType: NotebookOpenTargetType;
} {
  if (args.sourceType === 'web' && args.uri && isWebUri(args.uri)) {
    return { openTarget: args.uri, openTargetType: 'browser' };
  }
  if (args.sourceType === 'local' && args.sourcePath) {
    return { openTarget: args.sourcePath, openTargetType: 'workspace_file' };
  }
  if ((args.sourceType === 'generated' || args.sourceType === 'internal' || args.sourceType === 'api') && args.contentText) {
    return { openTarget: null, openTargetType: 'generated' };
  }
  return { openTarget: null, openTargetType: 'none' };
}

function deriveRetrievalStatus(args: {
  rawStatus: string | null;
  contentText: string | null;
  contentHash: string | null;
  metadata: Record<string, unknown>;
}): NotebookRetrievalStatus {
  const status = args.rawStatus;
  if (status === 'none' || status === 'saved_metadata_only' || status === 'content_fetched' || status === 'chunked') {
    return status;
  }
  if (args.metadata.chunkCount != null || args.metadata.chunksCreated === true) {
    return 'chunked';
  }
  if (args.contentText || args.contentHash) {
    return 'content_fetched';
  }
  return 'saved_metadata_only';
}

export function normalizeNotebookSourceRecord(input: NormalizableItemInput): NotebookSourceRecord {
  const raw = (input ?? {}) as Record<string, unknown>;
  const metadata = readMetadata(raw);

  const uri = findFirstNonEmptyString([
    raw.uri,
    raw.url,
    metadata.uri,
    metadata.url,
  ]);
  const sourcePath = findFirstNonEmptyString([
    raw.source_path,
    raw.sourcePath,
    raw.path,
    metadata.sourcePath,
    metadata.source_path,
  ]);
  const contentText = findFirstNonEmptyString([
    raw.contentText,
    raw.content_text,
    metadata.contentText,
    metadata.content_text,
  ]);
  const sourceType = inferSourceType({
    uri,
    sourcePath,
    rawSourceType: findFirstNonEmptyString([
      raw.sourceType,
      raw.source_type,
      raw.sourceTypeRaw,
      raw.item_type,
      metadata.sourceType,
      metadata.source_type,
    ]),
    contentText,
  });

  const open = deriveOpenTarget({ sourceType, uri, sourcePath, contentText });

  const retrievalStatus = deriveRetrievalStatus({
    rawStatus: findFirstNonEmptyString([
      raw.retrievalStatus,
      raw.retrieval_status,
      metadata.retrievalStatus,
      metadata.retrieval_status,
    ]),
    contentText,
    contentHash: findFirstNonEmptyString([raw.content_hash, raw.contentHash, metadata.content_hash, metadata.contentHash]),
    metadata,
  });

  const title = findFirstNonEmptyString([raw.title, metadata.title, uri, sourcePath, raw.item_key, raw.id]) ?? 'Untitled Source';

  return {
    title,
    sourceType,
    uri,
    sourcePath,
    openTarget: findFirstNonEmptyString([raw.openTarget, metadata.openTarget, open.openTarget]),
    openTargetType: (findFirstNonEmptyString([raw.openTargetType, metadata.openTargetType]) as NotebookOpenTargetType | null) ?? open.openTargetType,
    providerId: findFirstNonEmptyString([
      raw.providerId,
      raw.provider_id,
      raw.source_id,
      raw.sourceId,
      metadata.providerId,
      metadata.provider_id,
      metadata.source_id,
    ]),
    snippet: findFirstNonEmptyString([raw.snippet, metadata.snippet]),
    summary: findFirstNonEmptyString([raw.summary, metadata.summary]),
    contentText,
    contentHash: findFirstNonEmptyString([raw.content_hash, raw.contentHash, metadata.content_hash, metadata.contentHash]),
    mimeType: findFirstNonEmptyString([raw.mimeType, raw.mime_type, metadata.mimeType, metadata.mime_type]),
    retrievalStatus,
    createdFromSearch: Boolean(raw.added_from_search_run_id ?? raw.search_run_id ?? raw.createdFromSearch ?? metadata.createdFromSearch),
  };
}

export interface NormalizedNotebookItemForStorage {
  item_key: string;
  item_type: string;
  source_id: string | null;
  source_path: string | null;
  title: string | null;
  uri: string | null;
  snippet: string | null;
  content_hash: string | null;
  added_from_search_run_id: string | null;
  metadata_json: Record<string, unknown>;
}

export function normalizeNotebookItemForStorage(input: NormalizableItemInput): NormalizedNotebookItemForStorage {
  const raw = (input ?? {}) as Record<string, unknown>;
  const normalized = normalizeNotebookSourceRecord(raw);
  const metadata = readMetadata(raw);

  const itemKey = findFirstNonEmptyString([raw.item_key, raw.itemKey, normalized.uri, normalized.sourcePath, raw.id]);
  if (!itemKey) {
    throw new Error('Notebook item is missing canonical identity (item_key/uri/sourcePath/id).');
  }

  const itemType = findFirstNonEmptyString([raw.item_type, raw.itemType, raw.sourceType, normalized.sourceType]) ?? normalized.sourceType;
  const providerId = normalized.providerId;

  const mergedMetadata: Record<string, unknown> = {
    ...metadata,
    sourceType: normalized.sourceType,
    providerId,
    summary: normalized.summary,
    contentText: normalized.contentText,
    mimeType: normalized.mimeType,
    retrievalStatus: normalized.retrievalStatus,
    openTarget: normalized.openTarget,
    openTargetType: normalized.openTargetType,
    createdFromSearch: normalized.createdFromSearch,
  };

  return {
    item_key: itemKey,
    item_type: itemType,
    source_id: providerId,
    source_path: normalized.sourcePath,
    title: normalized.title,
    uri: normalized.uri,
    snippet: normalized.snippet,
    content_hash: normalized.contentHash,
    added_from_search_run_id: findFirstNonEmptyString([raw.added_from_search_run_id, raw.addedFromSearchRunId, raw.search_run_id]),
    metadata_json: mergedMetadata,
  };
}

export interface NotebookOpenResolution {
  openTarget: string | null;
  openTargetType: NotebookOpenTargetType;
  sourceUnavailableReason: string | null;
}

export function resolveNotebookOpenTarget(input: NormalizableItemInput): NotebookOpenResolution {
  const normalized = normalizeNotebookSourceRecord(input);
  if (normalized.sourceType === 'web' && normalized.uri && normalized.openTargetType === 'browser') {
    return { openTarget: normalized.openTarget, openTargetType: 'browser', sourceUnavailableReason: null };
  }
  if (normalized.sourceType === 'local' && normalized.sourcePath && normalized.openTargetType === 'workspace_file') {
    return { openTarget: normalized.openTarget, openTargetType: 'workspace_file', sourceUnavailableReason: null };
  }
  if ((normalized.sourceType === 'generated' || normalized.sourceType === 'internal' || normalized.sourceType === 'api') && normalized.contentText) {
    return { openTarget: null, openTargetType: 'generated', sourceUnavailableReason: null };
  }
  return {
    openTarget: null,
    openTargetType: 'none',
    sourceUnavailableReason: 'source_unavailable: missing canonical uri/sourcePath/contentText for this notebook item',
  };
}
