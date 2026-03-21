-- 010_pgvector_embeddings.sql
-- Semantic embedding layer for document_chunks.
--
-- Architecture:
--   document_chunks   → retrieval units (created by ingestion pipeline)
--   chunk_embeddings  → dense vectors attached to each chunk
--
-- Embedding engine:  Ollama
-- Model:             embeddinggemma
-- Dimension:         768
--
-- Semantic retrieval flows through RetrievalOrchestrator → SemanticSearchProvider
-- → EmbeddingsRepository.semanticSearchByVector() — never bypassing the orchestrator.

-- Ensure pgvector extension is available.
-- (Already enabled in 001_enable_extensions.sql but CREATE EXTENSION IF NOT EXISTS is idempotent.)
CREATE EXTENSION IF NOT EXISTS vector;

-- chunk_embeddings: Dense vector representations of document_chunks.
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  id                  uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  chunk_id            uuid        NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  document_id         uuid        NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  item_key            text        NOT NULL,
  embedding_model     text        NOT NULL,
  embedding_dimension integer     NOT NULL,
  embedding           vector(768) NOT NULL,
  content_hash        text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- A chunk should only have one embedding per model.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chunk_embeddings_upsert_key
  ON chunk_embeddings (chunk_id, embedding_model);

-- Lookup indexes for common query patterns.
CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_item_key
  ON chunk_embeddings (item_key);

CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_document_id
  ON chunk_embeddings (document_id);

CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_embedding_model
  ON chunk_embeddings (embedding_model);

-- pgvector nearest-neighbor index using cosine distance (HNSW).
--
-- HNSW is the recommended index type for pgvector cosine similarity search.
-- It requires the vector extension ≥ 0.5.0.  If the installed pgvector version
-- does not support HNSW, comment out this block and use IVFFlat instead, or
-- rely on exact (sequential scan) search for development/small datasets.
--
-- TODO: tune m and ef_construction for production dataset sizes.
CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_vector
  ON chunk_embeddings USING hnsw (embedding vector_cosine_ops);
