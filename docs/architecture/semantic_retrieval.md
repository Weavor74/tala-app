# Semantic Retrieval Architecture

## Overview

Tala's semantic retrieval layer provides dense vector similarity search over
ingested document chunks. It uses Ollama for embedding generation and pgvector
(inside PostgreSQL) as the vector store. Semantic retrieval integrates with the
existing `RetrievalOrchestrator` — the same entry point used for keyword and
external search.

## Components

| Component | Location | Role |
|-----------|----------|------|
| `LocalEmbeddingProvider` | `electron/services/embedding/LocalEmbeddingProvider.ts` | Calls Ollama `/api/embeddings` to generate embedding vectors |
| `ChunkEmbeddingService` | `electron/services/embedding/ChunkEmbeddingService.ts` | Batch-embeds document chunks; stores results via EmbeddingsRepository |
| `EmbeddingsRepository` | `electron/services/db/EmbeddingsRepository.ts` | DB access for chunk_embeddings table (upsert, lookup, semantic search) |
| `SemanticSearchProvider` | `electron/services/retrieval/providers/SemanticSearchProvider.ts` | Implements `SearchProvider` interface; wired into RetrievalOrchestrator |
| `RetrievalOrchestrator` | `electron/services/retrieval/RetrievalOrchestrator.ts` | Canonical retrieval path — unchanged; SemanticSearchProvider registers here |
| Migration `010_pgvector_embeddings.sql` | `electron/migrations/` | Creates `chunk_embeddings` table with `vector(768)` column |

## Embedding Configuration

| Property | Value |
|----------|-------|
| Engine | Ollama (local) |
| Model | `embeddinggemma` |
| Dimension | 768 |
| Default endpoint | `http://127.0.0.1:11434` |

These are fixed for this pass. The model name is the exact string Ollama expects.

## Database Schema

```sql
chunk_embeddings (
  id                  uuid PRIMARY KEY,
  chunk_id            uuid NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  document_id         uuid NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  item_key            text NOT NULL,
  embedding_model     text NOT NULL,
  embedding_dimension integer NOT NULL,
  embedding           vector(768) NOT NULL,
  content_hash        text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chunk_id, embedding_model)
)
```

A HNSW cosine-distance index (`idx_chunk_embeddings_vector`) accelerates
nearest-neighbor queries. The unique index on `(chunk_id, embedding_model)`
ensures idempotent upserts.

## Embedding Attachment

Embeddings attach to `document_chunks`, not `source_documents`. The full
ingestion pipeline is:

```
notebook_items
  → (ingestNotebook / ingestItems)
    → source_documents + document_chunks
      → (embedNotebook / embedItems)
        → chunk_embeddings
```

Ingestion and embedding are explicit, separate steps. Neither is automatic.

## Semantic Retrieval Flow

```
Search UI / agent
  → tala.retrievalRetrieve({ mode: 'semantic', ... })
    → IPC: retrieval:retrieve
      → RetrievalOrchestrator.retrieve(request)
        → SemanticSearchProvider.search(query, scope, options)
          1. LocalEmbeddingProvider.embedText(query)   → vector[768]
          2. EmbeddingsRepository.semanticSearchByVector({ queryVector, itemKeys, ... })
             → SQL: SELECT ... FROM chunk_embeddings JOIN document_chunks JOIN source_documents
                    ORDER BY embedding <=> $1::vector LIMIT $topK
          3. Map hits → NormalizedSearchResult[]
        → merged results returned in RetrievalResponse
```

## Notebook Scope

When `scope === 'notebook'`, `RetrievalOrchestrator` calls
`ResearchRepository.resolveNotebookScope(notebookId)` to expand the notebook
into `{ uris, sourcePaths, itemKeys }`. `SemanticSearchProvider` then filters
the pgvector query with `WHERE ce.item_key = ANY($itemKeys)`.

Notebook scope enforcement happens in the backend SQL query — not in renderer
filtering.

## Citation and Provenance

`semanticSearchByVector` joins `document_chunks` and `source_documents` in a
single query. All provenance fields survive to the normalized result:

| DB field | NormalizedSearchResult field |
|----------|------------------------------|
| `sd.title` | `title` |
| `sd.uri` | `uri` |
| `sd.source_path` | `sourcePath` |
| `sd.source_type` | `sourceType` |
| `sd.provider_id` | `metadata.providerProvenance` |
| `sd.external_id` | `externalId` |
| `sd.citation_label` | `metadata.citationLabel` |
| `sd.display_domain` | `metadata.displayDomain` |
| `sd.fetched_at` | `metadata.fetchedAt` |
| `sd.content_hash` | `contentHash` |
| `dc.content` | `snippet` (truncated to 500 chars) |
| `dc.char_start` / `dc.char_end` | `metadata.charStart` / `metadata.charEnd` |
| `dc.section_label` | `metadata.sectionLabel` |
| `dc.page_number` | `metadata.pageNumber` |
| similarity score | `score` + `metadata.similarity` |

## IPC Surface

| Channel | Purpose |
|---------|---------|
| `embeddings:embedNotebook` | Embed all chunks for a notebook's item_keys |
| `embeddings:embedItems` | Embed chunks for explicit item_keys |
| `embeddings:embedChunks` | Embed specific chunk IDs |
| `retrieval:retrieve` (existing) | Semantic retrieval via `mode: 'semantic'` |

No new IPC is needed for semantic search — it flows through the existing
`retrieval:retrieve` handler with `mode: 'semantic'`.

## UI Entry Point

The Notebooks view (`src/renderer/components/Notebooks.tsx`) exposes an
**EMBED NOTEBOOK** button that calls `window.tala.embedNotebook(notebookId)`.
This is a non-invasive addition to the existing action bar.

## Architectural Guarantees

- PostgreSQL remains the single truth layer.
- pgvector lives inside PostgreSQL (no separate vector store).
- Embeddings attach to `document_chunks`, not `source_documents`.
- Semantic retrieval uses `LocalEmbeddingProvider` + pgvector.
- `RetrievalOrchestrator` remains the canonical retrieval path.
- Notebook scope is enforced in backend SQL queries.
- Citation/provenance metadata is preserved through all semantic hits.

## Future: Hybrid Retrieval

`SemanticSearchProvider.supportedModes` includes `'hybrid'`. When
`mode: 'hybrid'` is requested, the orchestrator will run both
`LocalSearchProvider` (keyword) and `SemanticSearchProvider` (semantic) in
parallel, then merge by itemKey with score ranking. No additional code change
is required — the orchestrator already supports this pattern.

Reciprocal Rank Fusion (RRF) or weighted score blending can be added later
as a merge step in `RetrievalOrchestrator.mergeResults()`.
