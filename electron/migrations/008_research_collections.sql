-- 008_research_collections.sql
-- Notebooks, search runs, search run results, and notebook items.
-- Implements the Research Collections data layer for the Research sidebar.

-- Notebooks: named, persistent collections of research items.
CREATE TABLE IF NOT EXISTS notebooks (
  id                uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name              text        NOT NULL,
  description       text        NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  is_dynamic        boolean     NOT NULL DEFAULT false,
  query_template    text        NULL,
  source_scope_json jsonb       NULL,
  tags_json         jsonb       NULL
);

-- Search runs: records of executed searches with query metadata.
CREATE TABLE IF NOT EXISTS search_runs (
  id                uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  query_text        text        NOT NULL,
  normalized_query  text        NULL,
  filters_json      jsonb       NULL,
  source_scope_json jsonb       NULL,
  executed_at       timestamptz NOT NULL DEFAULT now(),
  executed_by       text        NULL,
  notebook_id       uuid        NULL REFERENCES notebooks(id) ON DELETE SET NULL
);

-- Search run results: captured results from a specific search run.
CREATE TABLE IF NOT EXISTS search_run_results (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  search_run_id   uuid        NOT NULL REFERENCES search_runs(id) ON DELETE CASCADE,
  item_key        text        NOT NULL,
  item_type       text        NOT NULL DEFAULT 'web',
  source_id       text        NULL,
  source_path     text        NULL,
  title           text        NULL,
  uri             text        NULL,
  snippet         text        NULL,
  score           numeric     NULL,
  metadata_json   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  content_hash    text        NULL,
  captured_at     timestamptz NOT NULL DEFAULT now()
);

-- Notebook items: items explicitly saved into a notebook.
-- item_key is unique per notebook to prevent duplicate membership.
CREATE TABLE IF NOT EXISTS notebook_items (
  id                       uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  notebook_id              uuid        NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  item_key                 text        NOT NULL,
  item_type                text        NOT NULL DEFAULT 'web',
  source_id                text        NULL,
  source_path              text        NULL,
  title                    text        NULL,
  uri                      text        NULL,
  snippet                  text        NULL,
  content_hash             text        NULL,
  added_from_search_run_id uuid        NULL REFERENCES search_runs(id) ON DELETE SET NULL,
  added_at                 timestamptz NOT NULL DEFAULT now(),
  metadata_json            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (notebook_id, item_key)
);

-- Indexes for common access patterns
CREATE INDEX IF NOT EXISTS idx_search_runs_notebook_id        ON search_runs (notebook_id);
CREATE INDEX IF NOT EXISTS idx_search_run_results_run_id      ON search_run_results (search_run_id);
CREATE INDEX IF NOT EXISTS idx_search_run_results_item_key    ON search_run_results (item_key);
CREATE INDEX IF NOT EXISTS idx_search_run_results_source_id   ON search_run_results (source_id);
CREATE INDEX IF NOT EXISTS idx_notebook_items_notebook_id     ON notebook_items (notebook_id);
CREATE INDEX IF NOT EXISTS idx_notebook_items_item_key        ON notebook_items (item_key);
CREATE INDEX IF NOT EXISTS idx_notebook_items_source_id       ON notebook_items (source_id);
