-- 005_indexes_constraints.sql
-- Practical indexes and constraints for the canonical memory schema.

-- ─── Entity indexes ─────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_canonical_name
  ON entities (canonical_name);

CREATE INDEX IF NOT EXISTS idx_entities_type
  ON entities (entity_type);

CREATE INDEX IF NOT EXISTS idx_entities_updated_at
  ON entities (updated_at);

-- ─── Entity Alias indexes ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias
  ON entity_aliases (alias);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity_id
  ON entity_aliases (entity_id);

-- ─── Episode indexes ────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_episodes_type
  ON episodes (episode_type);

CREATE INDEX IF NOT EXISTS idx_episodes_observed_at
  ON episodes (observed_at);

CREATE INDEX IF NOT EXISTS idx_episodes_importance
  ON episodes (importance);

CREATE INDEX IF NOT EXISTS idx_episodes_metadata
  ON episodes USING GIN (metadata);

-- ─── Observation indexes ────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_observations_subject
  ON observations (subject_entity_id);

CREATE INDEX IF NOT EXISTS idx_observations_predicate
  ON observations (predicate);

CREATE INDEX IF NOT EXISTS idx_observations_observed_at
  ON observations (observed_at);

CREATE INDEX IF NOT EXISTS idx_observations_source_episode
  ON observations (source_episode_id);

CREATE INDEX IF NOT EXISTS idx_observations_metadata
  ON observations USING GIN (metadata);

-- ─── Relationship indexes ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_relationships_from
  ON relationships (from_entity_id);

CREATE INDEX IF NOT EXISTS idx_relationships_to
  ON relationships (to_entity_id);

CREATE INDEX IF NOT EXISTS idx_relationships_type
  ON relationships (relationship_type);

CREATE INDEX IF NOT EXISTS idx_relationships_metadata
  ON relationships USING GIN (metadata);

-- ─── Artifact indexes ───────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_artifacts_type
  ON artifacts (artifact_type);

CREATE INDEX IF NOT EXISTS idx_artifacts_content_hash
  ON artifacts (content_hash);

CREATE INDEX IF NOT EXISTS idx_artifacts_metadata
  ON artifacts USING GIN (metadata);

-- ─── Memory Link indexes ────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_memory_links_from
  ON memory_links (from_kind, from_id);

CREATE INDEX IF NOT EXISTS idx_memory_links_to
  ON memory_links (to_kind, to_id);

CREATE INDEX IF NOT EXISTS idx_memory_links_type
  ON memory_links (link_type);

-- ─── Embedding indexes ──────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_embeddings_owner
  ON embeddings (owner_kind, owner_id);

CREATE INDEX IF NOT EXISTS idx_embeddings_model
  ON embeddings (embedding_model);

CREATE INDEX IF NOT EXISTS idx_embeddings_content_hash
  ON embeddings (content_hash);

CREATE INDEX IF NOT EXISTS idx_embeddings_metadata
  ON embeddings USING GIN (metadata);

-- HNSW vector index for cosine similarity search.
-- This accelerates nearest-neighbor queries on the embedding column.
CREATE INDEX IF NOT EXISTS idx_embeddings_vector
  ON embeddings USING hnsw (embedding vector_cosine_ops);
