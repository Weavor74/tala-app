/**
 * embeddingConstants.ts
 *
 * Canonical constants for the pgvector embedding layer.
 *
 * The embedding table is fixed at vector(1536) in migration 004_embeddings.sql.
 * All embedding writes must use a model whose output dimension matches this value.
 *
 * Chosen model: text-embedding-ada-002 (OpenAI / OpenAI-compatible local servers)
 *   - Dimension: 1536
 *   - API: POST /v1/embeddings  { model: "text-embedding-ada-002", input: "..." }
 *   - Compatible with any llama.cpp or other OpenAI-compatible embedding endpoint.
 *
 * This file is compiled by both electron/tsconfig.json (Node) and tsconfig.app.json
 * (renderer). It must remain pure TypeScript — no Node.js APIs.
 */

/** The canonical embedding model name used throughout Tala's pgvector layer. */
export const TALA_EMBEDDING_MODEL = 'text-embedding-ada-002' as const;

/** Vector dimension required by the embeddings table (vector(1536)). */
export const TALA_EMBEDDING_DIM = 1536 as const;

/** owner_kind value used for observation embeddings. */
export const EMBEDDING_OWNER_KIND_OBSERVATION = 'observation' as const;
