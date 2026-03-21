-- 009_content_ingestion.sql
-- Content ingestion pipeline: source_documents and document_chunks.
--
-- Architecture:
--   notebook_items    → curated references (the curation gate)
--   source_documents  → canonical stored content with citation metadata
--   document_chunks   → deterministic retrieval units with location metadata
--
-- Future: embedding columns will attach to document_chunks, not here.

-- source_documents: Full ingested content with provenance/citation metadata.
CREATE TABLE IF NOT EXISTS source_documents (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_key        text        NOT NULL,
  notebook_id     uuid        NULL REFERENCES notebooks(id) ON DELETE SET NULL,
  title           text        NULL,
  uri             text        NULL,
  source_path     text        NULL,
  provider_id     text        NULL,
  external_id     text        NULL,
  source_type     text        NULL,
  mime_type       text        NULL,
  citation_label  text        NULL,
  display_domain  text        NULL,
  author          text        NULL,
  published_at    timestamptz NULL,
  fetched_at      timestamptz NULL,
  content         text        NOT NULL,
  content_hash    text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_key, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_source_documents_item_key     ON source_documents (item_key);
CREATE INDEX IF NOT EXISTS idx_source_documents_notebook_id  ON source_documents (notebook_id);
CREATE INDEX IF NOT EXISTS idx_source_documents_uri          ON source_documents (uri);
CREATE INDEX IF NOT EXISTS idx_source_documents_content_hash ON source_documents (content_hash);

-- document_chunks: Deterministic retrieval units derived from source_documents.
-- Each chunk preserves character offsets into the parent document content.
CREATE TABLE IF NOT EXISTS document_chunks (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id     uuid        NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  item_key        text        NOT NULL,
  chunk_index     integer     NOT NULL,
  content         text        NOT NULL,
  token_estimate  integer     NOT NULL,
  content_hash    text        NOT NULL,
  char_start      integer     NOT NULL,
  char_end        integer     NOT NULL,
  section_label   text        NULL,
  page_number     integer     NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_item_key    ON document_chunks (item_key);
CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id ON document_chunks (document_id);
