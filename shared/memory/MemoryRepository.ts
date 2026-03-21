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
  UpsertEmbeddingInput,
  SimilaritySearchOptions,
  SemanticSearchResult,
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
  UpsertEmbeddingInput,
  SimilaritySearchOptions,
  SemanticSearchResult,
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

  /**
   * Upsert a vector embedding keyed on (owner_kind, owner_id, chunk_index, embedding_model).
   *
   * If an embedding for that composite key already exists, updates the content,
   * content_hash, embedding vector, and metadata in place. Otherwise inserts a new row.
   * The returned record has embedding: null to avoid large payloads.
   *
   * Requires migration 007_embeddings_upsert_key.sql to be applied.
   */
  upsertEmbedding(input: UpsertEmbeddingInput): Promise<EmbeddingRecord>;

  /**
   * Search observations by semantic similarity to a query embedding.
   *
   * Performs a nearest-neighbor search over the embeddings index using pgvector
   * cosine distance (<=>), joins back to the observations table, and returns
   * the top-K matching ObservationRecord instances ranked by similarity.
   *
   * Only embeddings with owner_kind = 'observation' and a non-null vector are
   * considered. Results below minSimilarity (if set) are excluded.
   *
   * @param queryEmbedding - vector(1536) query vector
   * @param options - model filter, topK, minSimilarity
   */
  searchObservationsBySimilarity(
    queryEmbedding: number[],
    options?: SimilaritySearchOptions,
  ): Promise<SemanticSearchResult<ObservationRecord>[]>;
}
