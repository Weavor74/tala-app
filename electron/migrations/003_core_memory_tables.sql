-- 003_core_memory_tables.sql
-- Episodes, observations, relationships, artifacts, and memory links.

-- Episodes: temporal records of events, conversations, or interactions.
CREATE TABLE IF NOT EXISTS episodes (
  id            uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  episode_type  text        NOT NULL,
  title         text        NULL,
  summary       text        NULL,
  content       text        NULL,
  source_type   text        NULL,
  source_ref    text        NULL,
  importance    smallint    NOT NULL DEFAULT 0,
  confidence    numeric     NOT NULL DEFAULT 0.5,
  created_at    timestamptz NOT NULL DEFAULT now(),
  observed_at   timestamptz NOT NULL DEFAULT now(),
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- Observations: structured facts / assertions about entities.
CREATE TABLE IF NOT EXISTS observations (
  id                uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  observation_type  text        NOT NULL,
  subject_entity_id uuid       NULL REFERENCES entities(id) ON DELETE SET NULL,
  predicate         text        NOT NULL,
  object_text       text        NULL,
  object_entity_id  uuid        NULL REFERENCES entities(id) ON DELETE SET NULL,
  value_json        jsonb       NULL,
  confidence        numeric     NOT NULL DEFAULT 0.5,
  authority         text        NULL,
  observed_at       timestamptz NOT NULL DEFAULT now(),
  valid_from        timestamptz NULL,
  valid_until       timestamptz NULL,
  source_episode_id uuid        NULL REFERENCES episodes(id) ON DELETE SET NULL,
  metadata          jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- Relationships: directed edges between entities.
CREATE TABLE IF NOT EXISTS relationships (
  id                uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_entity_id    uuid        NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship_type text        NOT NULL,
  to_entity_id      uuid        NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  confidence        numeric     NOT NULL DEFAULT 0.5,
  source_episode_id uuid        NULL REFERENCES episodes(id) ON DELETE SET NULL,
  metadata          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Artifacts: external files, URIs, or content references.
CREATE TABLE IF NOT EXISTS artifacts (
  id            uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  artifact_type text        NOT NULL,
  title         text        NULL,
  uri           text        NULL,
  path          text        NULL,
  content_hash  text        NULL,
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Memory links: cross-domain typed edges between any memory objects.
CREATE TABLE IF NOT EXISTS memory_links (
  id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_kind   text        NOT NULL,
  from_id     uuid        NOT NULL,
  link_type   text        NOT NULL,
  to_kind     text        NOT NULL,
  to_id       uuid        NOT NULL,
  weight      numeric     NOT NULL DEFAULT 1.0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
