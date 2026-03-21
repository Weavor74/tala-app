-- 007_embeddings_upsert_key.sql
-- Adds a unique index on embeddings (owner_kind, owner_id, chunk_index, embedding_model).
-- This enables upsert semantics:
--   INSERT ... ON CONFLICT (owner_kind, owner_id, chunk_index, embedding_model) DO UPDATE
-- so that re-indexing a canonical record with a newer vector or model always overwrites
-- the previous entry rather than duplicating it.

CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_upsert_key
  ON embeddings (owner_kind, owner_id, chunk_index, embedding_model);
