/**
 * Content Ingestion — Shared Types
 *
 * Pure TypeScript type definitions for the content ingestion pipeline.
 * No Node.js APIs — safe for use in both the renderer and the Electron main process.
 *
 * Architecture:
 *   notebook_items    → curated references (curation gate, NOT modified by ingestion)
 *   source_documents  → canonical stored content with citation/provenance metadata
 *   document_chunks   → deterministic retrieval units with location metadata
 *
 * Future: pgvector embedding columns will attach to document_chunks.
 */

// ─── Source Documents ─────────────────────────────────────────────────────────

/** Canonical stored content record with full provenance and citation metadata. */
export interface SourceDocumentRecord {
  id: string;
  /** Stable key linking back to the originating notebook_item. */
  item_key: string;
  /** Optional notebook context this document was ingested under. */
  notebook_id: string | null;
  title: string | null;
  uri: string | null;
  source_path: string | null;
  /** Provider that originally surfaced this item (e.g. 'local', 'external:brave'). */
  provider_id: string | null;
  /** Provider-specific identifier for the source item. */
  external_id: string | null;
  /** Broad source category: 'web', 'file', 'api', etc. */
  source_type: string | null;
  mime_type: string | null;
  /** Human-readable label used when citing this document in grounded responses. */
  citation_label: string | null;
  /** Derived domain name for display (e.g. 'example.com'). */
  display_domain: string | null;
  author: string | null;
  published_at: string | null;
  fetched_at: string | null;
  /** Full normalized text content. */
  content: string;
  /** SHA-256 hex digest of content — used for deduplication. */
  content_hash: string;
  created_at: string;
  updated_at: string;
}

/** Input shape for creating or upserting a source document. */
export interface UpsertSourceDocumentInput {
  item_key: string;
  notebook_id?: string | null;
  title?: string | null;
  uri?: string | null;
  source_path?: string | null;
  provider_id?: string | null;
  external_id?: string | null;
  source_type?: string | null;
  mime_type?: string | null;
  citation_label?: string | null;
  display_domain?: string | null;
  author?: string | null;
  published_at?: string | null;
  fetched_at?: string | null;
  content: string;
  content_hash: string;
}

// ─── Document Chunks ──────────────────────────────────────────────────────────

/** A deterministic retrieval unit derived from a source document. */
export interface DocumentChunkRecord {
  id: string;
  /** FK → source_documents.id */
  document_id: string;
  /** Duplicated from parent for efficient lookups without joins. */
  item_key: string;
  /** Zero-based sequential index within the document. */
  chunk_index: number;
  content: string;
  /** Approximate token count for context-window budgeting. */
  token_estimate: number;
  /** SHA-256 hex digest of the chunk content. */
  content_hash: string;
  /** Byte/character offset of this chunk's start in the full document content. */
  char_start: number;
  /** Byte/character offset of this chunk's end (exclusive) in the full document content. */
  char_end: number;
  /** Optional heading or section label extracted from the document structure. */
  section_label: string | null;
  /** Optional page number for paginated sources (PDFs, etc.). */
  page_number: integer | null;
  created_at: string;
}

// ─── Ingestion Request / Result ───────────────────────────────────────────────

/** Request to ingest content for one or more notebook items. */
export interface IngestionRequest {
  /** item_key values of the notebook_items to ingest. */
  itemKeys: string[];
  /** If provided, link source_documents to this notebook. */
  notebookId?: string;
  /** If true, re-fetch and re-store even if content_hash already exists. */
  refetch?: boolean;
}

/** Summary returned after an ingestion batch completes (possibly partially). */
export interface IngestionResult {
  /** Number of source_documents newly created or updated. */
  documentsCreated: number;
  /** Number of items skipped because the same content_hash already exists. */
  documentsSkipped: number;
  /** Total document_chunks written across all ingested documents. */
  chunksCreated: number;
  /** Non-fatal warnings accumulated during the batch (one per problematic item). */
  warnings?: string[];
}

// ─── Chunking ────────────────────────────────────────────────────────────────

/** Controls how content is divided into document_chunks. */
export interface ChunkingOptions {
  /** Maximum approximate token count per chunk. Default: 512. */
  maxTokensPerChunk: number;
  /** Number of overlapping tokens between adjacent chunks. Default: 64. */
  overlapTokens: number;
  /**
   * Chunking strategy:
   *   'paragraph' — split on blank lines first, then fall back to fixed-size
   *   'fixed'     — split purely by token count with overlap
   *   'hybrid'    — paragraph-aware with fixed-size fallback (default)
   */
  strategy: 'paragraph' | 'fixed' | 'hybrid';
}

// ─── Workaround: integer alias (pure TS, no runtime impact) ──────────────────
type integer = number;
