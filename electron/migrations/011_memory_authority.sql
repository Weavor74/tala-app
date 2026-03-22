-- 011_memory_authority.sql
-- Memory Authority Lock (P7A)
--
-- Enforces PostgreSQL as the SINGLE SOURCE OF TRUTH for all persistent memory.
-- All derived systems (mem0, graph, vector index) must reference canonical_memory_id
-- from memory_records and may only be rebuilt from this table.
--
-- Tables:
--   memory_records          — canonical truth for every persistent memory write
--   memory_lineage          — version history and supersession chain
--   memory_projections      — tracks which derived systems have received each record
--   memory_integrity_issues — validation audit log and repair tracking
--   memory_duplicates       — duplicate detection groups

-- ---------------------------------------------------------------------------
-- 1. memory_records — canonical truth
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_records (
    memory_id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    memory_type             TEXT        NOT NULL,
    subject_type            TEXT        NOT NULL,
    subject_id              TEXT        NOT NULL,
    content_text            TEXT        NOT NULL DEFAULT '',
    content_structured      JSONB,
    canonical_hash          TEXT        NOT NULL,
    authority_status        TEXT        NOT NULL DEFAULT 'canonical',
    version                 INTEGER     NOT NULL DEFAULT 1,
    confidence              FLOAT       NOT NULL DEFAULT 1.0,
    source_kind             TEXT        NOT NULL DEFAULT 'unknown',
    source_ref              TEXT        NOT NULL DEFAULT '',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_from              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_to                TIMESTAMPTZ,
    tombstoned_at           TIMESTAMPTZ,
    supersedes_memory_id    UUID        REFERENCES memory_records(memory_id) ON DELETE SET NULL
);

-- Indexes for common lookup patterns
CREATE INDEX IF NOT EXISTS idx_memory_records_canonical_hash  ON memory_records (canonical_hash);
CREATE INDEX IF NOT EXISTS idx_memory_records_subject_id      ON memory_records (subject_id);
CREATE INDEX IF NOT EXISTS idx_memory_records_memory_type     ON memory_records (memory_type);
CREATE INDEX IF NOT EXISTS idx_memory_records_created_at      ON memory_records (created_at);
CREATE INDEX IF NOT EXISTS idx_memory_records_authority_status ON memory_records (authority_status);

-- ---------------------------------------------------------------------------
-- 2. memory_lineage — versioning and supersession chain
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_lineage (
    lineage_id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    memory_id               UUID        NOT NULL REFERENCES memory_records(memory_id) ON DELETE CASCADE,
    parent_memory_id        UUID        REFERENCES memory_records(memory_id) ON DELETE SET NULL,
    version                 INTEGER     NOT NULL,
    change_kind             TEXT        NOT NULL DEFAULT 'update',  -- 'create' | 'update' | 'tombstone'
    changed_fields          TEXT[]      NOT NULL DEFAULT '{}',
    prior_hash              TEXT,
    new_hash                TEXT        NOT NULL,
    changed_by              TEXT        NOT NULL DEFAULT 'system',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_lineage_memory_id    ON memory_lineage (memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_lineage_created_at   ON memory_lineage (created_at);

-- ---------------------------------------------------------------------------
-- 3. memory_projections — tracking derived systems
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_projections (
    projection_id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    memory_id               UUID        NOT NULL REFERENCES memory_records(memory_id) ON DELETE CASCADE,
    target_system           TEXT        NOT NULL,  -- 'mem0' | 'graph' | 'vector'
    projection_status       TEXT        NOT NULL DEFAULT 'pending',  -- 'pending' | 'projected' | 'failed' | 'stale'
    canonical_version       INTEGER     NOT NULL,
    projected_version       INTEGER,
    projection_ref          TEXT,       -- external ID in the derived system, if known
    attempted_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    projected_at            TIMESTAMPTZ,
    error_message           TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_projections_memory_id      ON memory_projections (memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_projections_target_system  ON memory_projections (target_system);
CREATE INDEX IF NOT EXISTS idx_memory_projections_status         ON memory_projections (projection_status);

-- ---------------------------------------------------------------------------
-- 4. memory_integrity_issues — validation and repair tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_integrity_issues (
    issue_id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    issue_kind              TEXT        NOT NULL,   -- 'orphan' | 'duplicate' | 'divergence' | 'projection_mismatch' | 'tombstone_violation'
    severity                TEXT        NOT NULL DEFAULT 'warning',  -- 'info' | 'warning' | 'error' | 'critical'
    affected_memory_id      UUID        REFERENCES memory_records(memory_id) ON DELETE SET NULL,
    affected_system         TEXT,                   -- 'mem0' | 'graph' | 'vector' | 'postgres'
    description             TEXT        NOT NULL,
    repair_suggestion       TEXT,
    repair_status           TEXT        NOT NULL DEFAULT 'open',  -- 'open' | 'repaired' | 'ignored'
    detected_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    repaired_at             TIMESTAMPTZ,
    metadata                JSONB
);

CREATE INDEX IF NOT EXISTS idx_memory_integrity_issues_kind          ON memory_integrity_issues (issue_kind);
CREATE INDEX IF NOT EXISTS idx_memory_integrity_issues_severity      ON memory_integrity_issues (severity);
CREATE INDEX IF NOT EXISTS idx_memory_integrity_issues_status        ON memory_integrity_issues (repair_status);
CREATE INDEX IF NOT EXISTS idx_memory_integrity_issues_detected_at   ON memory_integrity_issues (detected_at);

-- ---------------------------------------------------------------------------
-- 5. memory_duplicates — duplicate detection groups
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_duplicates (
    duplicate_id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    canonical_memory_id     UUID        NOT NULL REFERENCES memory_records(memory_id) ON DELETE CASCADE,
    duplicate_memory_id     UUID        REFERENCES memory_records(memory_id) ON DELETE SET NULL,
    match_kind              TEXT        NOT NULL DEFAULT 'exact',  -- 'exact' | 'semantic' | 'near'
    match_score             FLOAT       NOT NULL DEFAULT 1.0,
    canonical_hash          TEXT        NOT NULL,
    resolution              TEXT        NOT NULL DEFAULT 'pending',  -- 'pending' | 'merged' | 'kept_canonical' | 'dismissed'
    detected_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at             TIMESTAMPTZ,
    metadata                JSONB
);

CREATE INDEX IF NOT EXISTS idx_memory_duplicates_canonical_id    ON memory_duplicates (canonical_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_duplicates_hash            ON memory_duplicates (canonical_hash);
CREATE INDEX IF NOT EXISTS idx_memory_duplicates_resolution      ON memory_duplicates (resolution);
