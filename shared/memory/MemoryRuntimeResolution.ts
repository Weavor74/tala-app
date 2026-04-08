/**
 * MemoryRuntimeResolution
 *
 * Typed contract for the memory runtime configuration that Tala resolves
 * before launching mem0-core.  This is the single source of truth for which
 * inference backend mem0-core uses for extraction and embeddings.
 *
 * Serialised as JSON and passed to mem0-core via
 * TALA_MEMORY_RUNTIME_CONFIG_PATH (file path) or
 * TALA_MEMORY_RUNTIME_CONFIG_JSON (inline JSON, fallback).
 *
 * Design invariants:
 *   - This type must remain flat and JSON-serialisable.
 *   - mem0-core reads this; it must never re-derive it by probing.
 *   - Extraction and embeddings are resolved independently.
 */

// ─── Backend type ─────────────────────────────────────────────────────────────

/**
 * Canonical memory backend type identifier.
 * Maps to InferenceProviderType where applicable.
 */
export type MemoryBackendType =
    | 'ollama'
    | 'vllm'
    | 'llamacpp'
    | 'openai_compatible'
    | 'openai'
    | 'anthropic'
    | 'gemini'
    | 'other'
    | 'none';

// ─── Resolved backend ────────────────────────────────────────────────────────

/**
 * Resolution result for a single memory subsystem (extraction OR embeddings).
 */
export interface ResolvedMemoryBackend {
    /** Whether this subsystem is active (false when providerType is 'none'). */
    enabled: boolean;
    /** Stable provider ID from InferenceProviderRegistry, or null when none. */
    providerId: string | null;
    /** Canonical backend type. */
    providerType: MemoryBackendType;
    /** Model name to use, or null when providerType is 'none'. */
    model: string | null;
    /** Base URL for the inference endpoint. */
    baseUrl?: string;
    /** Embedding dimensions (relevant for embeddings backend only). */
    dimensions?: number;
    /** Human-readable reason code for the resolution decision. */
    reason?: string | null;
}

// ─── Runtime mode ─────────────────────────────────────────────────────────────

/**
 * Derived memory runtime mode.
 *
 * canonical_only            — no extraction, no embeddings.  Canonical Postgres
 *                             writes still succeed; enrichment is deferred.
 * canonical_plus_embeddings — embeddings available but no extraction provider.
 *                             Semantic retrieval works; extraction deferred.
 * full_memory               — both extraction and embeddings available; full
 *                             mem0 pipeline is active.
 */
export type MemoryRuntimeMode =
    | 'canonical_only'
    | 'canonical_plus_embeddings'
    | 'full_memory';

// ─── Runtime resolution ───────────────────────────────────────────────────────

/**
 * Complete memory runtime resolution written by Tala and consumed by mem0-core.
 */
export interface MemoryRuntimeResolution {
    /** Resolved extraction backend (LLM-based fact extraction). */
    extraction: ResolvedMemoryBackend;
    /** Resolved embeddings backend. */
    embeddings: ResolvedMemoryBackend;
    /** Derived mode based on which subsystems are enabled. */
    mode: MemoryRuntimeMode;
    /** ISO 8601 timestamp when this resolution was created. */
    resolvedAt: string;
}
