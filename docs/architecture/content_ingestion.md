# Content Ingestion Pipeline

**Status:** Implemented (Phase 5A)
**Migration:** `electron/migrations/009_content_ingestion.sql`

---

## Overview

The content ingestion pipeline enables Tala to store full source content locally in PostgreSQL alongside citation metadata needed for grounded answers and future semantic retrieval. Ingestion is always an **explicit** user action — it never happens automatically when search results are saved.

---

## Data Model: Three Layers

### 1. `notebook_items` — Curated references (unchanged by ingestion)

The existing curation gate. Items in `notebook_items` are lightweight references: they hold a `title`, `uri`, `source_path`, `snippet`, and `item_key`, but **not** full content. Adding items to a notebook does not trigger ingestion.

### 2. `source_documents` — Canonical stored content

Created by the ingestion pipeline. Each row stores the full normalized text content of one notebook item plus complete provenance and citation metadata:

| Field | Purpose |
|---|---|
| `item_key` | Links back to the originating `notebook_item` |
| `notebook_id` | Optional notebook context under which this was ingested |
| `content` | Full normalized text (whitespace normalized, HTML stripped) |
| `content_hash` | SHA-256 of `content` — deduplication key |
| `citation_label` | Human-readable citation string for grounded responses |
| `display_domain` | Derived hostname (e.g. `example.com`) |
| `author` / `published_at` | Extracted provenance when available |
| `provider_id` / `external_id` | Originating retrieval provider identity |
| `fetched_at` | When content was retrieved |
| `uri` / `source_path` | Original source location |

Deduplication constraint: `UNIQUE(item_key, content_hash)` — re-ingesting identical content for the same item is a no-op unless `refetch=true`.

### 3. `document_chunks` — Deterministic retrieval units

Each `source_document` is split into `document_chunks` during ingestion. These are the future pgvector retrieval targets.

| Field | Purpose |
|---|---|
| `document_id` | FK → `source_documents.id` (CASCADE DELETE) |
| `item_key` | Denormalized for efficient lookups without joins |
| `chunk_index` | Zero-based, sequential within the document |
| `content` | The chunk text |
| `token_estimate` | Approximate token count (`len / 4`) |
| `content_hash` | SHA-256 of chunk content |
| `char_start` / `char_end` | Character offsets into the parent document `content` |
| `section_label` | Optional heading extracted from document structure |
| `page_number` | Optional page number for paginated sources |

Constraint: `UNIQUE(document_id, chunk_index)` — chunk sets are replaced atomically on re-ingestion.

**No embedding columns are present yet.** They will be added in a future migration alongside pgvector integration.

---

## Citation Model

A grounded response needs to cite the source of a specific claim. The ingestion pipeline preserves all information required to do this at both the document level and the chunk level:

```
Claim in response
  → document_chunks row (content, char_start, char_end, chunk_index)
  → source_documents row (citation_label, display_domain, uri, title, author, published_at)
  → notebook_items row (original curation metadata)
```

When generating a cited response, the system can:
1. Retrieve matching chunks (future: by embedding similarity).
2. Join to `source_documents` to get `citation_label`, `display_domain`, `uri`.
3. Format: `"According to [citation_label] (display_domain)"` with link to `uri`.

---

## Ingestion Workflow

```
User clicks "INGEST NOTEBOOK" in Notebooks.tsx
  ↓
IPC: ingestion:ingestNotebook(notebookId)
  ↓
ContentIngestionService.ingestNotebook(notebookId)
  ↓
  For each notebook_item:
    1. fetchContentForItem()
       - source_path → read file
       - uri         → HTTP GET, HTML strip, normalize whitespace
    2. SHA-256 hash of normalized content
    3. documentExists(item_key, content_hash)?
       - YES (and !refetch) → skip (documentsSkipped++)
       - NO / refetch=true  → proceed
    4. upsertSourceDocument() → source_documents row
    5. chunkContent() → deterministic chunks with offsets
    6. insertChunks() → delete old chunks, insert new batch
    7. Return IngestionResult stats
```

Partial failure is allowed: if one item fails (network error, missing file), a warning is recorded and the rest of the batch continues. The caller always receives a complete `IngestionResult` with any `warnings[]`.

---

## Chunking Strategies

Three strategies are available via `ChunkingOptions.strategy`:

| Strategy | Behavior |
|---|---|
| `'fixed'` | Pure character-count splitting (1 token ≈ 4 chars), with overlap |
| `'paragraph'` | Split on blank lines; merge paragraphs up to `maxTokensPerChunk`; fall back to fixed for oversized paragraphs |
| `'hybrid'` (default) | Paragraph-aware, then adds overlap by prepending tail of previous chunk |

Default: `maxTokensPerChunk=512`, `overlapTokens=64`, `strategy='hybrid'`.

All strategies assign deterministic `char_start` / `char_end` offsets into the parent document content.

---

## Offline-First Behavior After Fetch

Once content is ingested, it is stored in PostgreSQL. All subsequent retrieval operations read from `source_documents` and `document_chunks` locally — no network access is required. This means:

- Notebooks work offline after initial ingestion.
- Re-ingestion is required only when source content changes (detected via `content_hash`).
- The `refetch=true` flag forces re-fetch and re-chunk even for unchanged content.

---

## IPC Interface

| Channel | Arguments | Description |
|---|---|---|
| `ingestion:ingestNotebook` | `notebookId, options?, refetch?` | Ingest all items in a notebook |
| `ingestion:ingestItems` | `itemKeys[], notebookId?, options?, refetch?` | Ingest specific items by key |

Both return `{ ok: boolean, result?: IngestionResult, error?: string }`.

### Preload (`window.tala`)

```typescript
window.tala.ingestNotebook(notebookId, options?, refetch?)
window.tala.ingestItems(itemKeys, notebookId?, options?, refetch?)
```

---

## Key Files

| File | Role |
|---|---|
| `electron/migrations/009_content_ingestion.sql` | DB schema for source_documents + document_chunks |
| `shared/ingestion/ingestionTypes.ts` | Canonical shared type contracts |
| `electron/services/db/ContentRepository.ts` | DB layer (upsert, query, chunk insert) |
| `electron/services/ingestion/ContentIngestionService.ts` | Fetch, hash, chunk, persist logic |
| `electron/services/db/initMemoryStore.ts` | Wires ContentRepository into shared pool |
| `electron/services/IpcRouter.ts` | IPC handlers for ingestion:* channels |
| `electron/preload.ts` | Exposes ingestNotebook / ingestItems on window.tala |
| `src/renderer/components/Notebooks.tsx` | INGEST NOTEBOOK button |
| `tests/ContentIngestionService.test.ts` | Unit tests (no DB, no network) |

---

## Future pgvector Integration Path

The schema is designed for embedding attachment without migration breakage:

1. Add a future migration (`010_chunk_embeddings.sql` or similar) that adds:
   ```sql
   ALTER TABLE document_chunks ADD COLUMN embedding vector(1536);
   CREATE INDEX ON document_chunks USING ivfflat (embedding vector_cosine_ops);
   ```
2. Add `upsertEmbedding(chunkId, vector)` to `ContentRepository`.
3. Add an embedding step to `ContentIngestionService._ingestSingleItem()` (after chunking).
4. Add a `searchChunksBySimilarity(queryVector, topK, itemKeys?)` method for retrieval.
5. Wire into `RetrievalOrchestrator` as a new `EmbeddingSearchProvider`.

The existing `document_chunks` rows already have `item_key` and `document_id` for efficient filtered vector search scoped to a notebook.

---

## Architectural Guarantees

- PostgreSQL remains the single truth layer — no second database.
- `notebook_items` are curated references — ingestion never modifies them.
- `source_documents` are the canonical content store.
- `document_chunks` are the retrieval unit of record.
- Ingestion is always explicit; it never fires on search or on notebook item save.
- All ingested content preserves enough provenance to cite by document and by chunk.
