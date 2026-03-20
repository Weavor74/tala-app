/**
 * MemoryRepository.ts
 *
 * Canonical interface for the memory DB layer.
 * PostgresMemoryRepository (electron/services/db/) implements this interface.
 *
 * This file is compiled by both electron/tsconfig.json (Node) and tsconfig.app.json
 * (renderer). It must remain pure TypeScript — no Node.js APIs (process, fs, path).
 *
 * Re-exports all record and input types from memoryTypes.ts so consumers only
 * need a single import point.
 */

import type {
  EntityRecord,
  CreateEntityInput,
  EntityAliasRecord,
  CreateEntityAliasInput,
  EpisodeRecord,
  CreateEpisodeInput,
  ObservationRecord,
  CreateObservationInput,
  RelationshipRecord,
  CreateRelationshipInput,
  ArtifactRecord,
  CreateArtifactInput,
  MemoryLinkRecord,
  CreateMemoryLinkInput,
  EmbeddingRecord,
  CreateEmbeddingInput,
} from './memoryTypes';

export type {
  EntityRecord,
  CreateEntityInput,
  EntityAliasRecord,
  CreateEntityAliasInput,
  EpisodeRecord,
  CreateEpisodeInput,
  ObservationRecord,
  CreateObservationInput,
  RelationshipRecord,
  CreateRelationshipInput,
  ArtifactRecord,
  CreateArtifactInput,
  MemoryLinkRecord,
  CreateMemoryLinkInput,
  EmbeddingRecord,
  CreateEmbeddingInput,
};

export interface MemoryRepository {
  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Establish the database connection pool and verify connectivity. */
  initialize(): Promise<void>;

  /** Run all pending schema migrations. Requires initialize() to have run. */
  runMigrations(): Promise<void>;

  /** Close the database connection pool. */
  close(): Promise<void>;

  // ─── Entity ───────────────────────────────────────────────────────────────

  /**
   * Insert or update an entity by canonical_name.
   * Existing attributes are merged; other fields are updated if supplied.
   */
  upsertEntity(input: CreateEntityInput): Promise<EntityRecord>;

  getEntityById(id: string): Promise<EntityRecord | null>;

  findEntityByCanonicalName(canonicalName: string): Promise<EntityRecord | null>;

  addEntityAlias(input: CreateEntityAliasInput): Promise<EntityAliasRecord>;

  // ─── Episode ──────────────────────────────────────────────────────────────

  createEpisode(input: CreateEpisodeInput): Promise<EpisodeRecord>;

  getEpisodeById(id: string): Promise<EpisodeRecord | null>;

  // ─── Observation ──────────────────────────────────────────────────────────

  createObservation(input: CreateObservationInput): Promise<ObservationRecord>;

  // ─── Relationship ─────────────────────────────────────────────────────────

  createRelationship(input: CreateRelationshipInput): Promise<RelationshipRecord>;

  // ─── Artifact ─────────────────────────────────────────────────────────────

  createArtifact(input: CreateArtifactInput): Promise<ArtifactRecord>;

  // ─── Memory Link ──────────────────────────────────────────────────────────

  createMemoryLink(input: CreateMemoryLinkInput): Promise<MemoryLinkRecord>;

  // ─── Embedding ────────────────────────────────────────────────────────────

  /**
   * Insert a vector embedding. The returned record has embedding: null
   * to avoid returning large vectors in standard responses.
   */
  createEmbedding(input: CreateEmbeddingInput): Promise<EmbeddingRecord>;
}
