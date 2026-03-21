/**
 * PostgresMemoryRepository
 *
 * Implements the MemoryRepository interface using PostgreSQL with pgvector.
 * All queries use parameterized SQL. No ORM. No hidden magic.
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { toSql as pgvectorToSql } from 'pgvector';
import { MigrationRunner } from './MigrationRunner';
import { resolveDatabaseConfig } from './resolveDatabaseConfig';
import type { DatabaseConfig } from '../../../shared/dbConfig';
import type { MemoryRepository } from '../../../shared/memory/MemoryRepository';
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
} from '../../../shared/memory/memoryTypes';
import { TALA_EMBEDDING_MODEL, EMBEDDING_OWNER_KIND_OBSERVATION } from '../../../shared/memory/embeddingConstants';

export class PostgresMemoryRepository implements MemoryRepository {
  private pool: Pool | null = null;
  private config: DatabaseConfig;
  private migrationRunner: MigrationRunner | null = null;
  private migrationsDir?: string;

  constructor(configOverrides?: Partial<DatabaseConfig>, migrationsDir?: string) {
    this.config = resolveDatabaseConfig(configOverrides);
    this.migrationsDir = migrationsDir;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /** Return a safe summary of the resolved config for logging (no passwords). */
  getConfigSummary(): string {
    if (this.config.connectionString) return '(connection string)';
    return `${this.config.host}:${this.config.port}/${this.config.database}`;
  }

  async initialize(): Promise<void> {
    if (this.pool) return;

    const poolConfig = this.config.connectionString
      ? {
          connectionString: this.config.connectionString,
          max: this.config.poolMax,
          idleTimeoutMillis: this.config.idleTimeoutMs,
          connectionTimeoutMillis: this.config.connectionTimeoutMs,
          ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
        }
      : {
          host: this.config.host,
          port: this.config.port,
          database: this.config.database,
          user: this.config.user,
          password: this.config.password,
          max: this.config.poolMax,
          idleTimeoutMillis: this.config.idleTimeoutMs,
          connectionTimeoutMillis: this.config.connectionTimeoutMs,
          ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
        };

    this.pool = new Pool(poolConfig);

    // Verify connectivity
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT 1 AS ok');
      if (result.rows[0]?.ok !== 1) {
        throw new Error('PostgreSQL connectivity check failed');
      }
      console.log('[PostgresMemoryRepository] Connected to PostgreSQL');
    } finally {
      client.release();
    }

    this.migrationRunner = new MigrationRunner(this.pool, this.migrationsDir);
  }

  async runMigrations(): Promise<void> {
    if (!this.migrationRunner) {
      throw new Error('PostgresMemoryRepository not initialized. Call initialize() first.');
    }
    await this.migrationRunner.runAll();
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.migrationRunner = null;
      console.log('[PostgresMemoryRepository] Connection pool closed');
    }
  }

  private getPool(): Pool {
    if (!this.pool) {
      throw new Error('PostgresMemoryRepository not initialized. Call initialize() first.');
    }
    return this.pool;
  }

  /** Expose the shared connection pool for sibling repositories (e.g. ResearchRepository). */
  getSharedPool(): Pool {
    return this.getPool();
  }

  // ─── Entity ─────────────────────────────────────────────────────────────────

  async upsertEntity(input: CreateEntityInput): Promise<EntityRecord> {
    const pool = this.getPool();
    const id = input.id ?? uuidv4();
    const attributes = input.attributes ?? {};

    const result = await pool.query<EntityRecord>(
      `INSERT INTO entities (id, entity_type, canonical_name, display_name, status, attributes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (canonical_name) DO UPDATE SET
         entity_type = EXCLUDED.entity_type,
         display_name = COALESCE(EXCLUDED.display_name, entities.display_name),
         status = COALESCE(EXCLUDED.status, entities.status),
         attributes = entities.attributes || EXCLUDED.attributes,
         updated_at = now()
       RETURNING *`,
      [
        id,
        input.entity_type,
        input.canonical_name,
        input.display_name ?? null,
        input.status ?? null,
        JSON.stringify(attributes),
      ]
    );
    return result.rows[0];
  }

  async getEntityById(id: string): Promise<EntityRecord | null> {
    const pool = this.getPool();
    const result = await pool.query<EntityRecord>(
      'SELECT * FROM entities WHERE id = $1',
      [id]
    );
    return result.rows[0] ?? null;
  }

  async findEntityByCanonicalName(canonicalName: string): Promise<EntityRecord | null> {
    const pool = this.getPool();
    const result = await pool.query<EntityRecord>(
      'SELECT * FROM entities WHERE canonical_name = $1',
      [canonicalName]
    );
    return result.rows[0] ?? null;
  }

  async addEntityAlias(input: CreateEntityAliasInput): Promise<EntityAliasRecord> {
    const pool = this.getPool();
    const id = input.id ?? uuidv4();

    const result = await pool.query<EntityAliasRecord>(
      `INSERT INTO entity_aliases (id, entity_id, alias, alias_type)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, input.entity_id, input.alias, input.alias_type ?? null]
    );
    return result.rows[0];
  }

  // ─── Episode ────────────────────────────────────────────────────────────────

  async createEpisode(input: CreateEpisodeInput): Promise<EpisodeRecord> {
    const pool = this.getPool();
    const id = input.id ?? uuidv4();
    const metadata = input.metadata ?? {};

    const result = await pool.query<EpisodeRecord>(
      `INSERT INTO episodes (id, episode_type, title, summary, content, source_type, source_ref,
                             importance, confidence, observed_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        id,
        input.episode_type,
        input.title ?? null,
        input.summary ?? null,
        input.content ?? null,
        input.source_type ?? null,
        input.source_ref ?? null,
        input.importance ?? 0,
        input.confidence ?? 0.5,
        input.observed_at ?? new Date(),
        JSON.stringify(metadata),
      ]
    );
    return result.rows[0];
  }

  async getEpisodeById(id: string): Promise<EpisodeRecord | null> {
    const pool = this.getPool();
    const result = await pool.query<EpisodeRecord>(
      'SELECT * FROM episodes WHERE id = $1',
      [id]
    );
    return result.rows[0] ?? null;
  }

  // ─── Observation ────────────────────────────────────────────────────────────

  async createObservation(input: CreateObservationInput): Promise<ObservationRecord> {
    const pool = this.getPool();
    const id = input.id ?? uuidv4();
    const metadata = input.metadata ?? {};

    const result = await pool.query<ObservationRecord>(
      `INSERT INTO observations (id, observation_type, subject_entity_id, predicate, object_text,
                                  object_entity_id, value_json, confidence, authority, observed_at,
                                  valid_from, valid_until, source_episode_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        id,
        input.observation_type,
        input.subject_entity_id ?? null,
        input.predicate,
        input.object_text ?? null,
        input.object_entity_id ?? null,
        input.value_json != null ? JSON.stringify(input.value_json) : null,
        input.confidence ?? 0.5,
        input.authority ?? null,
        input.observed_at ?? new Date(),
        input.valid_from ?? null,
        input.valid_until ?? null,
        input.source_episode_id ?? null,
        JSON.stringify(metadata),
      ]
    );

    const observation = result.rows[0];

    // When an embedding vector is provided, upsert it into the embeddings index
    // in a follow-up query. The observation is committed first; the embedding
    // upsert is a separate (non-transactional) write that makes the observation
    // available for semantic similarity search without requiring a separate call.
    if (input.embedding && input.embedding.length > 0) {
      const model = input.embedding_model ?? TALA_EMBEDDING_MODEL;
      const content = [input.predicate, input.object_text]
        .filter(x => x !== null && x !== undefined)
        .join(': ');
      await this.upsertEmbedding({
        owner_kind: EMBEDDING_OWNER_KIND_OBSERVATION,
        owner_id: id,
        chunk_index: 0,
        embedding_model: model,
        content,
        content_hash: simpleContentHash(content),
        embedding: input.embedding,
      });
    }

    return observation;
  }

  // ─── Relationship ───────────────────────────────────────────────────────────

  async createRelationship(input: CreateRelationshipInput): Promise<RelationshipRecord> {
    const pool = this.getPool();
    const id = input.id ?? uuidv4();
    const metadata = input.metadata ?? {};

    const result = await pool.query<RelationshipRecord>(
      `INSERT INTO relationships (id, from_entity_id, relationship_type, to_entity_id,
                                   confidence, source_episode_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        input.from_entity_id,
        input.relationship_type,
        input.to_entity_id,
        input.confidence ?? 0.5,
        input.source_episode_id ?? null,
        JSON.stringify(metadata),
      ]
    );
    return result.rows[0];
  }

  // ─── Artifact ───────────────────────────────────────────────────────────────

  async createArtifact(input: CreateArtifactInput): Promise<ArtifactRecord> {
    const pool = this.getPool();
    const id = input.id ?? uuidv4();
    const metadata = input.metadata ?? {};

    const result = await pool.query<ArtifactRecord>(
      `INSERT INTO artifacts (id, artifact_type, title, uri, path, content_hash, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        input.artifact_type,
        input.title ?? null,
        input.uri ?? null,
        input.path ?? null,
        input.content_hash ?? null,
        JSON.stringify(metadata),
      ]
    );
    return result.rows[0];
  }

  // ─── Memory Link ────────────────────────────────────────────────────────────

  async createMemoryLink(input: CreateMemoryLinkInput): Promise<MemoryLinkRecord> {
    const pool = this.getPool();
    const id = input.id ?? uuidv4();

    const result = await pool.query<MemoryLinkRecord>(
      `INSERT INTO memory_links (id, from_kind, from_id, link_type, to_kind, to_id, weight)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        input.from_kind,
        input.from_id,
        input.link_type,
        input.to_kind,
        input.to_id,
        input.weight ?? 1.0,
      ]
    );
    return result.rows[0];
  }

  // ─── Embedding ──────────────────────────────────────────────────────────────

  async createEmbedding(input: CreateEmbeddingInput): Promise<EmbeddingRecord> {
    const pool = this.getPool();
    const id = input.id ?? uuidv4();
    const metadata = input.metadata ?? {};

    const embeddingValue = input.embedding ? pgvectorToSql(input.embedding) : null;

    const result = await pool.query<EmbeddingRecord>(
      `INSERT INTO embeddings (id, owner_kind, owner_id, chunk_index, embedding_model,
                                content, content_hash, metadata, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, owner_kind, owner_id, chunk_index, embedding_model,
                 content, content_hash, metadata, created_at`,
      [
        id,
        input.owner_kind,
        input.owner_id,
        input.chunk_index ?? 0,
        input.embedding_model,
        input.content,
        input.content_hash,
        JSON.stringify(metadata),
        embeddingValue,
      ]
    );

    // Don't return the full vector in the response to avoid large payloads
    return { ...result.rows[0], embedding: null };
  }

  async upsertEmbedding(input: UpsertEmbeddingInput): Promise<EmbeddingRecord> {
    const pool = this.getPool();
    const id = uuidv4();
    const metadata = input.metadata ?? {};
    const embeddingValue = pgvectorToSql(input.embedding);

    // ON CONFLICT key: idx_embeddings_upsert_key on
    //   (owner_kind, owner_id, chunk_index, embedding_model)
    // Applied by migration 007_embeddings_upsert_key.sql.
    const result = await pool.query<EmbeddingRecord>(
      `INSERT INTO embeddings (id, owner_kind, owner_id, chunk_index, embedding_model,
                                content, content_hash, metadata, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (owner_kind, owner_id, chunk_index, embedding_model) DO UPDATE SET
         content       = EXCLUDED.content,
         content_hash  = EXCLUDED.content_hash,
         metadata      = EXCLUDED.metadata,
         embedding     = EXCLUDED.embedding
       RETURNING id, owner_kind, owner_id, chunk_index, embedding_model,
                 content, content_hash, metadata, created_at`,
      [
        id,
        input.owner_kind,
        input.owner_id,
        input.chunk_index ?? 0,
        input.embedding_model,
        input.content,
        input.content_hash,
        JSON.stringify(metadata),
        embeddingValue,
      ]
    );

    return { ...result.rows[0], embedding: null };
  }

  async searchObservationsBySimilarity(
    queryEmbedding: number[],
    options?: SimilaritySearchOptions,
  ): Promise<SemanticSearchResult<ObservationRecord>[]> {
    const pool = this.getPool();
    const topK = options?.topK ?? 10;
    const minSimilarity = options?.minSimilarity ?? 0;
    const model = options?.model ?? TALA_EMBEDDING_MODEL;
    const queryVec = pgvectorToSql(queryEmbedding);

    // Cosine distance: (embedding <=> query). Similarity = 1 - distance.
    // The HNSW index (idx_embeddings_vector) accelerates this query.
    const result = await pool.query<ObservationRecord & { _similarity: string; _embedding_id: string }>(
      `SELECT o.*,
              (1 - (e.embedding <=> $1::vector)) AS _similarity,
              e.id AS _embedding_id
         FROM embeddings e
         JOIN observations o ON o.id = e.owner_id
        WHERE e.owner_kind = $2
          AND e.embedding_model = $3
          AND e.embedding IS NOT NULL
          AND (1 - (e.embedding <=> $1::vector)) >= $4
        ORDER BY e.embedding <=> $1::vector
        LIMIT $5`,
      [queryVec, EMBEDDING_OWNER_KIND_OBSERVATION, model, minSimilarity, topK]
    );

    return result.rows.map(row => {
      const { _similarity, _embedding_id, ...observation } = row;
      return {
        record: observation as ObservationRecord,
        similarity: parseFloat(_similarity),
        embedding_id: _embedding_id,
      };
    });
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Lightweight deterministic content hash using a djb2a-style XOR variant.
 * Used only as a change-detection key for embeddings; not cryptographic.
 * Avoids a Node.js `crypto` dependency so this can stay close to the DB layer.
 * Algorithm: h = ((h << 5) + h) ^ charCode  (djb2a, XOR variant of djb2)
 */
function simpleContentHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h) ^ text.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h.toString(16).padStart(8, '0');
}
