-- 013_memory_repair_outcomes.sql
-- Memory Repair Outcome History (Repair Learning Layer)
--
-- Persistent log of every significant repair-related lifecycle event.
-- Provides the raw data consumed by MemoryRepairAnalyticsService to detect
-- recurring failure patterns, measure repair action effectiveness, and
-- surface escalation-worthy conditions.
--
-- Event kinds:
--   repair_trigger     — MemoryRepairTriggerService.maybeEmit / emitDirect
--   repair_cycle       — MemoryRepairExecutionService.runRepairCycle result
--   repair_action      — MemoryRepairExecutionService per-action result
--   health_transition  — MemoryService._trackTransition state changes
--   deferred_replay    — DeferredMemoryReplayService item completions / failures
--   dead_letter        — DeferredMemoryWorkRepository dead-letter transitions
--
-- Analytics queries:
--   * Recurring failures: GROUP BY reason, COUNT(*) WHERE occurred_at >= window
--   * Action effectiveness: GROUP BY action_type, outcome WHERE event_type='repair_action'
--   * Dead-letter growth: COUNT(*) WHERE event_type='dead_letter' in time buckets
--   * Escalation scan: same reason N times in M hours
--
-- Retention policy:
--   Rows older than 90 days can be archived / pruned without affecting
--   correctness (analytics windows are bounded, defaults ≤ 48 hours).
--   A future maintenance pass may add a created_at index for pruning.

CREATE TABLE IF NOT EXISTS memory_repair_outcomes (
    id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Event classification
    event_type          TEXT        NOT NULL,
                                    -- 'repair_trigger' | 'repair_cycle' | 'repair_action'
                                    -- | 'health_transition' | 'deferred_replay' | 'dead_letter'

    -- Optional severity of the associated signal
    severity            TEXT,       -- 'info' | 'warning' | 'error' | 'critical'

    -- Failure reason for trigger/cycle events (maps to MemoryFailureReason)
    reason              TEXT,

    -- Memory subsystem state at event time
    state               TEXT,       -- 'healthy' | 'reduced' | 'degraded' | 'critical' | 'disabled'

    -- Resolved memory mode at event time
    mode                TEXT,       -- 'canonical_only' | 'canonical_plus_embeddings' | 'full_memory' | 'unknown'

    -- Cycle / action outcome
    outcome             TEXT,       -- 'recovered' | 'partial' | 'failed' | 'skipped'

    -- Repair action kind (repair_action events only)
    action_type         TEXT,       -- maps to RepairActionKind

    -- Subsystem label for aggregation (e.g. 'mem0', 'canonical', 'graph', 'rag')
    subsystem           TEXT,

    -- Optional canonical memory record involved (deferred_replay / dead_letter)
    canonical_memory_id TEXT,

    -- Optional repair cycle correlation ID
    cycle_id            TEXT,

    -- Structured event details as JSONB (must not contain PII or raw content)
    details_json        JSONB       NOT NULL DEFAULT '{}',

    -- Time the event actually occurred (from the emitter)
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Time the row was inserted
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes for analytics queries ────────────────────────────────────────────

-- Most analytics queries filter by occurred_at first
CREATE INDEX IF NOT EXISTS idx_mro_occurred_at
    ON memory_repair_outcomes (occurred_at DESC);

-- Aggregation by event_type and occurred_at (e.g. trigger counts in window)
CREATE INDEX IF NOT EXISTS idx_mro_event_type_occurred
    ON memory_repair_outcomes (event_type, occurred_at DESC);

-- Aggregation by reason (recurring failure detection)
CREATE INDEX IF NOT EXISTS idx_mro_reason_occurred
    ON memory_repair_outcomes (reason, occurred_at DESC)
    WHERE reason IS NOT NULL;

-- Aggregation by action_type (action effectiveness)
CREATE INDEX IF NOT EXISTS idx_mro_action_type_occurred
    ON memory_repair_outcomes (action_type, occurred_at DESC)
    WHERE action_type IS NOT NULL;

-- Grouping events within a cycle
CREATE INDEX IF NOT EXISTS idx_mro_cycle_id
    ON memory_repair_outcomes (cycle_id)
    WHERE cycle_id IS NOT NULL;
