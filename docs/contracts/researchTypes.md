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
}
```

