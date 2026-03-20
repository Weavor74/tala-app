/**
 * memoryTypes.ts
 *
 * Typed records and create-input interfaces for all 8 canonical memory DB entities.
 * Shapes are derived directly from the SQL schema in electron/migrations/.
 *
 * This file is compiled by both electron/tsconfig.json (Node) and tsconfig.app.json
 * (renderer). It must remain pure TypeScript — no Node.js APIs (process, fs, path).
 */

// ─── Entity ─────────────────────────────────────────────────────────────────

export interface EntityRecord {
  id: string;
  entity_type: string;
  canonical_name: string;
  display_name: string | null;
  status: string | null;
  /** jsonb stored as parsed object */
  attributes: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface CreateEntityInput {
  /** Optional; a UUID v4 is generated if omitted. */
  id?: string;
  entity_type: string;
  canonical_name: string;
  display_name?: string | null;
  status?: string | null;
  attributes?: Record<string, unknown>;
}

// ─── EntityAlias ────────────────────────────────────────────────────────────

export interface EntityAliasRecord {
  id: string;
  entity_id: string;
  alias: string;
  alias_type: string | null;
  created_at: Date;
}

export interface CreateEntityAliasInput {
  /** Optional; a UUID v4 is generated if omitted. */
  id?: string;
  entity_id: string;
  alias: string;
  alias_type?: string | null;
}

// ─── Episode ────────────────────────────────────────────────────────────────

export interface EpisodeRecord {
  id: string;
  episode_type: string;
  title: string | null;
  summary: string | null;
  content: string | null;
  source_type: string | null;
  source_ref: string | null;
  /** smallint: 0–100 scale */
  importance: number;
  /** numeric(3,2): 0.0–1.0 */
  confidence: number;
  created_at: Date;
  observed_at: Date;
  metadata: Record<string, unknown>;
}

export interface CreateEpisodeInput {
  /** Optional; a UUID v4 is generated if omitted. */
  id?: string;
  episode_type: string;
  title?: string | null;
  summary?: string | null;
  content?: string | null;
  source_type?: string | null;
  source_ref?: string | null;
  /** Defaults to 0 */
  importance?: number;
  /** Defaults to 0.5 */
  confidence?: number;
  /** Defaults to now() */
  observed_at?: Date;
  metadata?: Record<string, unknown>;
}

// ─── Observation ────────────────────────────────────────────────────────────

export interface ObservationRecord {
  id: string;
  observation_type: string;
  subject_entity_id: string | null;
  predicate: string;
  object_text: string | null;
  object_entity_id: string | null;
  value_json: unknown | null;
  confidence: number;
  authority: string | null;
  observed_at: Date;
  valid_from: Date | null;
  valid_until: Date | null;
  source_episode_id: string | null;
  metadata: Record<string, unknown>;
}

export interface CreateObservationInput {
  /** Optional; a UUID v4 is generated if omitted. */
  id?: string;
  observation_type: string;
  subject_entity_id?: string | null;
  predicate: string;
  object_text?: string | null;
  object_entity_id?: string | null;
  value_json?: unknown | null;
  /** Defaults to 0.5 */
  confidence?: number;
  authority?: string | null;
  /** Defaults to now() */
  observed_at?: Date;
  valid_from?: Date | null;
  valid_until?: Date | null;
  source_episode_id?: string | null;
  metadata?: Record<string, unknown>;
}

// ─── Relationship ───────────────────────────────────────────────────────────

export interface RelationshipRecord {
  id: string;
  from_entity_id: string;
  relationship_type: string;
  to_entity_id: string;
  confidence: number;
  source_episode_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface CreateRelationshipInput {
  /** Optional; a UUID v4 is generated if omitted. */
  id?: string;
  from_entity_id: string;
  relationship_type: string;
  to_entity_id: string;
  /** Defaults to 0.5 */
  confidence?: number;
  source_episode_id?: string | null;
  metadata?: Record<string, unknown>;
}

// ─── Artifact ───────────────────────────────────────────────────────────────

export interface ArtifactRecord {
  id: string;
  artifact_type: string;
  title: string | null;
  uri: string | null;
  path: string | null;
  content_hash: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface CreateArtifactInput {
  /** Optional; a UUID v4 is generated if omitted. */
  id?: string;
  artifact_type: string;
  title?: string | null;
  uri?: string | null;
  path?: string | null;
  content_hash?: string | null;
  metadata?: Record<string, unknown>;
}

// ─── MemoryLink ─────────────────────────────────────────────────────────────

export interface MemoryLinkRecord {
  id: string;
  from_kind: string;
  from_id: string;
  link_type: string;
  to_kind: string;
  to_id: string;
  /** numeric: defaults to 1.0 */
  weight: number;
  created_at: Date;
}

export interface CreateMemoryLinkInput {
  /** Optional; a UUID v4 is generated if omitted. */
  id?: string;
  from_kind: string;
  from_id: string;
  link_type: string;
  to_kind: string;
  to_id: string;
  /** Defaults to 1.0 */
  weight?: number;
}

// ─── Embedding ──────────────────────────────────────────────────────────────

export interface EmbeddingRecord {
  id: string;
  owner_kind: string;
  owner_id: string;
  chunk_index: number;
  embedding_model: string;
  content: string;
  content_hash: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  /**
   * The raw vector is intentionally excluded from SELECT returns
   * (large payload). Null is returned after insert by the repository.
   */
  embedding: number[] | null;
}

export interface CreateEmbeddingInput {
  /** Optional; a UUID v4 is generated if omitted. */
  id?: string;
  owner_kind: string;
  owner_id: string;
  /** Defaults to 0 */
  chunk_index?: number;
  embedding_model: string;
  content: string;
  content_hash: string;
  metadata?: Record<string, unknown>;
  /** vector(1536) value; null when no embedding is available yet */
  embedding?: number[] | null;
}
