-- 012_deferred_memory_work.sql
-- Deferred Memory Work Queue (Phase 8)
--
-- Persistent, bounded queue for follow-up memory tasks that could not be
-- executed immediately because the relevant capability was unavailable at
-- write time.
--
-- Work kinds:
--   extraction       — LLM fact-extraction step deferred when extraction
--                      provider was unavailable during a memory write
--   embedding        — Embedding pipeline step deferred when the embedding
--                      provider was unavailable during a memory write
--   graph_projection — Memory-graph projection step deferred when
--                      graph_projection was unavailable during a memory write
--
-- Replay is performed by DeferredMemoryReplayService in bounded batches,
-- gated by MemoryIntegrityPolicy health checks, and triggered by the
-- drain_deferred_work action in MemoryRepairExecutionService.

CREATE TABLE IF NOT EXISTS deferred_memory_work (
    id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Work classification
    kind                TEXT        NOT NULL,   -- 'extraction' | 'embedding' | 'graph_projection'
    status              TEXT        NOT NULL DEFAULT 'pending',
                                                -- 'pending' | 'in_progress' | 'completed'
                                                -- | 'failed' | 'dead_letter'

    -- Reference to the canonical memory record that needs follow-up
    canonical_memory_id TEXT        NOT NULL,

    -- Optional correlation context
    session_id          TEXT,
    turn_id             TEXT,

    -- Arbitrary JSON payload supplied by the enqueue caller
    -- (e.g. content_text for extraction, vectors for embedding)
    payload             JSONB       NOT NULL DEFAULT '{}',

    -- Retry bookkeeping
    attempt_count       INTEGER     NOT NULL DEFAULT 0,
    max_attempts        INTEGER     NOT NULL DEFAULT 3,
    last_error          TEXT,

    -- Scheduling
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Audit timestamps
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    dead_lettered_at    TIMESTAMPTZ
);

-- Fast lookup: all pending work of a given kind, ordered by scheduling time
CREATE INDEX IF NOT EXISTS idx_deferred_work_kind_status
    ON deferred_memory_work (kind, status, next_attempt_at);

-- Lookup by canonical memory ID (e.g. to check whether a given record has
-- pending work before re-queueing duplicates)
CREATE INDEX IF NOT EXISTS idx_deferred_work_canonical_id
    ON deferred_memory_work (canonical_memory_id);

-- Index for backlog visibility queries (count by status)
CREATE INDEX IF NOT EXISTS idx_deferred_work_status
    ON deferred_memory_work (status);
