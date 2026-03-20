-- 002_core_entities.sql
-- Core entities table: represents named things Tala knows about.

CREATE TABLE IF NOT EXISTS entities (
  id            uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type   text        NOT NULL,
  canonical_name text       NOT NULL,
  display_name  text        NULL,
  status        text        NULL,
  attributes    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Entity aliases: alternative names / references for an entity.
CREATE TABLE IF NOT EXISTS entity_aliases (
  id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_id   uuid        NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias       text        NOT NULL,
  alias_type  text        NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
