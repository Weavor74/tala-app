-- 014_notebook_ingestion_jobs.sql
-- Background ingestion queue for notebook item auto-upgrades.
--
-- This queue is part of external knowledge retrieval readiness.
-- It is not part of canonical learned memory authority.

CREATE TABLE IF NOT EXISTS notebook_ingestion_jobs (
  job_id         uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  notebook_id    uuid        NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  item_key       text        NOT NULL,
  source_type    text        NOT NULL,
  uri            text        NULL,
  source_path    text        NULL,
  state          text        NOT NULL,
  stage          text        NOT NULL,
  attempt_count  integer     NOT NULL DEFAULT 0,
  max_attempts   integer     NOT NULL DEFAULT 3,
  last_error     text        NULL,
  next_retry_at  timestamptz NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_notebook_ingestion_state
    CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'retry_scheduled', 'cancelled')),
  CONSTRAINT chk_notebook_ingestion_stage
    CHECK (stage IN ('fetch', 'extract', 'document_upsert', 'chunk', 'embed', 'finalize'))
);

-- At most one active job per notebook item.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notebook_ingestion_active_item
  ON notebook_ingestion_jobs (notebook_id, item_key)
  WHERE state IN ('queued', 'running', 'retry_scheduled');

CREATE INDEX IF NOT EXISTS idx_notebook_ingestion_claim
  ON notebook_ingestion_jobs (state, next_retry_at, created_at);

