/**
 * MemoryProviderResolver
 *
 * Deterministic resolver that maps Tala's canonical provider inventory to
 * a MemoryRuntimeResolution consumed by mem0-core at launch time.
 *
 * Resolution order (extraction):
 *   1. ollama (local)
 *   2. vllm (local)
 *   3. llamacpp / embedded_llamacpp
 *   4. other configured local provider
 *   5. cloud provider
 *   6. none
 *
 * Resolution order (embeddings):
 *   1. ollama (embeddings capability)
 *   2. llamacpp / embedded_llamacpp (embeddings capability)
 *   3. vllm (embeddings capability)
 *   4. other local provider with embeddings
 *   5. cloud provider with embeddings
 *   6. none
 *
 * Design invariants:
 *   - Never probes external endpoints.
 *   - Uses only the pre-resolved InferenceProviderInventory.
 *   - Extraction and embeddings are resolved independently.
 *   - Results are logged and observable.
 */

import type {
    InferenceProviderDescriptor,
    InferenceProviderInventory,
    InferenceProviderType,
} from '../../../shared/inferenceProviderTypes';
import type {
    MemoryBackendType,
    MemoryRuntimeMode,
    MemoryRuntimeResolution,
    ResolvedMemoryBackend,
} from '../../../shared/memory/MemoryRuntimeResolution';

// ─── Priority tables ──────────────────────────────────────────────────────────

/**
 * Provider type ranking for extraction (lower = higher priority).
 * Only providers that are ready in the inventory are considered.
 */
const EXTRACTION_TYPE_PRIORITY: Record<InferenceProviderType, number> = {
    ollama: 10,
    vllm: 20,
    embedded_vllm: 25,
    llamacpp: 30,
    embedded_llamacpp: 35,
    koboldcpp: 40,
    cloud: 50,
};

/**
 * Provider type ranking for embeddings (lower = higher priority).
 * Only providers with capabilities.embeddings=true are considered.
 */
const EMBEDDINGS_TYPE_PRIORITY: Record<InferenceProviderType, number> = {
    ollama: 10,
    llamacpp: 20,
    embedded_llamacpp: 25,
    vllm: 30,
    embedded_vllm: 35,
    koboldcpp: 40,
    cloud: 50,
};

// ─── Type mapping ─────────────────────────────────────────────────────────────

function toMemoryBackendType(providerType: InferenceProviderType): MemoryBackendType {
    switch (providerType) {
        case 'ollama':            return 'ollama';
        case 'vllm':              return 'vllm';
        case 'embedded_vllm':     return 'vllm';
        case 'llamacpp':          return 'llamacpp';
        case 'embedded_llamacpp': return 'llamacpp';
        case 'koboldcpp':         return 'openai_compatible';
        case 'cloud':             return 'openai_compatible';
        default:                  return 'other';
    }
}

// ─── Resolver class ───────────────────────────────────────────────────────────

export class MemoryProviderResolver {
    private readonly inventory: InferenceProviderInventory;

    constructor(inventory: InferenceProviderInventory) {
        this.inventory = inventory;
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Resolves the full MemoryRuntimeResolution from the current inventory.
     * Logs resolution decisions to the console for observability.
     */
    public resolve(): MemoryRuntimeResolution {
        const extraction = this.resolveExtraction();
        const embeddings = this.resolveEmbeddings();
        const mode = this.deriveMode(extraction, embeddings);

        console.log(`[MemoryProviderResolver] Extraction resolved: ${extraction.providerType}${extraction.model ? ' / ' + extraction.model : ''} — ${extraction.reason}`);
        console.log(`[MemoryProviderResolver] Embeddings resolved: ${embeddings.providerType}${embeddings.model ? ' / ' + embeddings.model : ''} — ${embeddings.reason}`);

        return {
            extraction,
            embeddings,
            mode,
            resolvedAt: new Date().toISOString(),
        };
    }

    /**
     * Resolves the extraction backend (LLM-based fact extraction).
     */
    public resolveExtraction(): ResolvedMemoryBackend {
        const candidates = this._readyProviders();

        const ranked = candidates
            .map(p => ({ p, rank: EXTRACTION_TYPE_PRIORITY[p.providerType] ?? 99 }))
            .sort((a, b) => a.rank - b.rank || a.p.priority - b.p.priority);

        if (ranked.length === 0) {
            return this._none('no_provider_resolved');
        }

        const chosen = ranked[0].p;
        return this._buildResolved(chosen, 'deterministic_rank');
    }

    /**
     * Resolves the embeddings backend.
     * Only providers with capabilities.embeddings = true are considered.
     */
    public resolveEmbeddings(): ResolvedMemoryBackend {
        const candidates = this._readyProviders().filter(p => p.capabilities.embeddings);

        const ranked = candidates
            .map(p => ({ p, rank: EMBEDDINGS_TYPE_PRIORITY[p.providerType] ?? 99 }))
            .sort((a, b) => a.rank - b.rank || a.p.priority - b.p.priority);

        if (ranked.length === 0) {
            return this._none('no_embedding_provider_resolved');
        }

        const chosen = ranked[0].p;
        return this._buildResolved(chosen, 'deterministic_rank');
    }

    /**
     * Derives the memory runtime mode from the resolved backends.
     */
    public deriveMode(
        extraction: ResolvedMemoryBackend,
        embeddings: ResolvedMemoryBackend,
    ): MemoryRuntimeMode {
        if (extraction.enabled && embeddings.enabled) return 'full_memory';
        if (embeddings.enabled) return 'canonical_plus_embeddings';
        return 'canonical_only';
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private _readyProviders(): InferenceProviderDescriptor[] {
        return this.inventory.providers.filter(p => p.ready);
    }

    private _buildResolved(
        descriptor: InferenceProviderDescriptor,
        reason: string,
    ): ResolvedMemoryBackend {
        return {
            enabled: true,
            providerId: descriptor.providerId,
            providerType: toMemoryBackendType(descriptor.providerType),
            model: descriptor.preferredModel ?? (descriptor.models[0] ?? null),
            baseUrl: descriptor.endpoint,
            reason,
        };
    }

    private _none(reason: string): ResolvedMemoryBackend {
        return {
            enabled: false,
            providerId: null,
            providerType: 'none',
            model: null,
            reason,
        };
    }
}
