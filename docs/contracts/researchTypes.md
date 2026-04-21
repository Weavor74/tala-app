# Contract: researchTypes.ts

**Source**: [shared\researchTypes.ts](../../shared/researchTypes.ts)

## Interfaces

### `NotebookRecord`
```typescript
interface NotebookRecord {
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
```

### `CreateNotebookInput`
```typescript
interface CreateNotebookInput {
  name: string;
  description?: string;
  is_dynamic?: boolean;
  query_template?: string;
  source_scope_json?: unknown;
  tags_json?: unknown;
}
```

### `UpdateNotebookInput`
```typescript
interface UpdateNotebookInput {
  name?: string;
  description?: string;
  is_dynamic?: boolean;
  query_template?: string;
  source_scope_json?: unknown;
  tags_json?: unknown;
}
```

### `SearchRunRecord`
```typescript
interface SearchRunRecord {
  id: string;
  query_text: string;
  normalized_query: string | null;
  filters_json: unknown | null;
  source_scope_json: unknown | null;
  executed_at: string;
  executed_by: string | null;
  notebook_id: string | null;
}
```

### `CreateSearchRunInput`
```typescript
interface CreateSearchRunInput {
  query_text: string;
  normalized_query?: string;
  filters_json?: unknown;
  source_scope_json?: unknown;
  executed_by?: string;
  notebook_id?: string;
}
```

### `NotebookSourceRecord`
```typescript
interface NotebookSourceRecord {
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
  retrievalError: string | null;
  sourceDocumentId: string | null;
  chunkCount: number | null;
  createdFromSearch: boolean;
}
```

### `NotebookIngestionJob`
```typescript
interface NotebookIngestionJob {
  jobId: string;
  notebookId: string;
  itemKey: string;
  sourceType: NotebookSourceType;
  uri: string | null;
  sourcePath: string | null;
  state: NotebookIngestionJobState;
  stage: NotebookIngestionJobStage;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### `SearchRunResultRecord`
```typescript
interface SearchRunResultRecord {
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
  retrievalError?: string | null;
  sourceDocumentId?: string | null;
  chunkCount?: number | null;
  openTarget?: string | null;
  openTargetType?: NotebookOpenTargetType;
  createdFromSearch?: boolean;
}
```

### `CreateSearchRunResultInput`
```typescript
interface CreateSearchRunResultInput {
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
  retrievalError?: string | null;
  sourceDocumentId?: string | null;
  chunkCount?: number | null;
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
```

### `NotebookItemRecord`
```typescript
interface NotebookItemRecord {
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
  retrievalError?: string | null;
  sourceDocumentId?: string | null;
  chunkCount?: number | null;
  openTarget?: string | null;
  openTargetType?: NotebookOpenTargetType;
  createdFromSearch?: boolean;
}
```

### `AddNotebookItemInput`
```typescript
interface AddNotebookItemInput {
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
  retrievalError?: string | null;
  sourceDocumentId?: string | null;
  chunkCount?: number | null;
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
```

### `NormalizedNotebookItemForStorage`
```typescript
interface NormalizedNotebookItemForStorage {
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
```

### `NotebookOpenResolution`
```typescript
interface NotebookOpenResolution {
  openTarget: string | null;
  openTargetType: NotebookOpenTargetType;
  sourceUnavailableReason: string | null;
}
```

### `NotebookSourceType`
```typescript
type NotebookSourceType =  'web' | 'local' | 'generated' | 'api' | 'internal';
```

### `NotebookRetrievalStatus`
```typescript
type NotebookRetrievalStatus = 
  | 'none'
  | 'saved_metadata_only'
  | 'queued'
  | 'fetching'
  | 'content_fetched'
  | 'chunking'
  | 'chunked'
  | 'embedding'
  | 'ready'
  | 'failed';
```

### `NotebookOpenTargetType`
```typescript
type NotebookOpenTargetType = 
  | 'browser'
  | 'workspace_file'
  | 'generated'
  | 'none';
```

### `NotebookIngestionJobState`
```typescript
type NotebookIngestionJobState = 
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'retry_scheduled'
  | 'cancelled';
```

### `NotebookIngestionJobStage`
```typescript
type NotebookIngestionJobStage = 
  | 'fetch'
  | 'extract'
  | 'document_upsert'
  | 'chunk'
  | 'embed'
  | 'finalize';
```

