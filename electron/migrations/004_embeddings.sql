-- 004_embeddings.sql
-- Vector embeddings table for semantic search.

CREATE TABLE IF NOT EXISTS embeddings (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_kind      text        NOT NULL,
  owner_id        uuid        NOT NULL,
  chunk_index     integer     NOT NULL DEFAULT 0,
  embedding_model text        NOT NULL,
  content         text        NOT NULL,
  content_hash    text        NOT NULL,
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  embedding       vector(1536)
);
