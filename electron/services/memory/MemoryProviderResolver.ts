/**
 * MemoryProviderResolver
 *
 * Deterministic resolver that maps Tala's canonical provider inventory to
 * a MemoryRuntimeResolution consumed by mem0-core at launch time.
 *
 * Resolution priority (extraction and embeddings share the same comparator
 * but differ in their capability filter):
 *   1. Capability validity (must support the requested use case)
 *   2. Availability (ready=true beats ready=false)
 *   3. Running state (status='ready' beats other statuses)
 *   4. User preference (inventory.selectedProviderId boost, only when valid)
 *   5. Locality (scope='local'|'embedded' beats scope='cloud')
 *   6. Provider type priority (ollama > vllm > llamacpp > koboldcpp > cloud)
 *   7. Model name (lexical ascending — stable tie-break)
 *   8. Provider ID (lexical ascending — final stable tie-break)
 *
 * Design invariants:
 *   - Never probes external endpoints.
 *   - Uses only the pre-resolved InferenceProviderInventory.
 *   - Extraction and embeddings are resolved independently.
 *   - Selection does NOT depend on upstream inventory array order.
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

// ─── Ranked candidate ────────────────────────────────────────────────────────

/**
 * Normalised ranking structure derived from an InferenceProviderDescriptor.
 * All comparison logic operates on this shape — never on raw descriptor fields.
 */
export interface RankedMemoryCandidate {
    providerId: string;
    providerType: MemoryBackendType;
    inferenceProviderType: InferenceProviderType;
    model: string | null;
    isAvailable: boolean;
    isRunning: boolean;
    isLocal: boolean;
    isPreferred: boolean;
    supportsExtraction: boolean;
    supportsEmbeddings: boolean;
    typePriority: number;
    /** Reference back to the source descriptor for resolved-backend construction. */
    _descriptor: InferenceProviderDescriptor;
}

// ─── Provider type priority table ────────────────────────────────────────────

/**
 * Unified provider type priority (lower = higher priority).
 * Shared by both extraction and embeddings ranking.
 */
const PROVIDER_TYPE_PRIORITY: Partial<Record<InferenceProviderType, number>> = {
    ollama:            10,
    vllm:              20,
    embedded_vllm:     25,
    llamacpp:          30,
    embedded_llamacpp: 35,
    koboldcpp:         40,
    cloud:             50,
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns a stable numeric priority for a provider type.
 * Unknown types fall back to 99 (lowest priority).
 */
export function rankProviderType(providerType: InferenceProviderType): number {
    return PROVIDER_TYPE_PRIORITY[providerType] ?? 99;
}

/**
 * Normalises a string for lexical comparison: trims, lowercases, and
 * converts null/undefined to '' so comparisons are always well-defined.
 */
export function normalizeString(value: string | null | undefined): string {
    return (value ?? '').trim().toLowerCase();
}

/**
 * Builds a RankedMemoryCandidate from a raw InferenceProviderDescriptor.
 */
export function buildRankedCandidate(
    descriptor: InferenceProviderDescriptor,
    preferredProviderId: string | undefined,
): RankedMemoryCandidate {
    const isLocal = descriptor.scope === 'local' || descriptor.scope === 'embedded';
    const isRunning = descriptor.status === 'ready';
    // isAvailable: ready flag OR at least configured+responding (not unavailable/disabled)
    const isAvailable = descriptor.ready;
    const isPreferred =
        !!preferredProviderId &&
        descriptor.providerId === preferredProviderId &&
        isAvailable;

    const model =
        descriptor.preferredModel ??
        (descriptor.models.length > 0 ? descriptor.models[0] : null);

    return {
        providerId: descriptor.providerId,
        providerType: toMemoryBackendType(descriptor.providerType),
        inferenceProviderType: descriptor.providerType,
        model,
        isAvailable,
        isRunning,
        isLocal,
        isPreferred,
        supportsExtraction: descriptor.capabilities.streaming, // text-generation capable providers only
        supportsEmbeddings: descriptor.capabilities.embeddings,
        typePriority: rankProviderType(descriptor.providerType),
        _descriptor: descriptor,
    };
}

/**
 * Deterministic comparator for RankedMemoryCandidate.
 *
 * Sort order (ascending — first element wins):
 *   1. availability  (available = 0, unavailable = 1)
 *   2. running state (running = 0, not running = 1)
 *   3. preference    (preferred = 0, not preferred = 1)
 *   4. locality      (local = 0, remote = 1)
 *   5. type priority (lower number wins)
 *   6. model name    (lexical ascending)
 *   7. provider ID   (lexical ascending — final tie-break)
 */
export function compareRankedCandidates(
    a: RankedMemoryCandidate,
    b: RankedMemoryCandidate,
): number {
    // 1. Availability
    const availDiff = (a.isAvailable ? 0 : 1) - (b.isAvailable ? 0 : 1);
    if (availDiff !== 0) return availDiff;

    // 2. Running state
    const runDiff = (a.isRunning ? 0 : 1) - (b.isRunning ? 0 : 1);
    if (runDiff !== 0) return runDiff;

    // 3. User preference (preferred wins, but only when valid and available — enforced by buildRankedCandidate)
    const prefDiff = (a.isPreferred ? 0 : 1) - (b.isPreferred ? 0 : 1);
    if (prefDiff !== 0) return prefDiff;

    // 4. Locality
    const localDiff = (a.isLocal ? 0 : 1) - (b.isLocal ? 0 : 1);
    if (localDiff !== 0) return localDiff;

    // 5. Provider type priority
    const typeDiff = a.typePriority - b.typePriority;
    if (typeDiff !== 0) return typeDiff;

    // 6. Model name (lexical ascending)
    const modelA = normalizeString(a.model);
    const modelB = normalizeString(b.model);
    if (modelA < modelB) return -1;
    if (modelA > modelB) return 1;

    // 7. Provider ID (lexical ascending — final stable tie-break)
    const idA = normalizeString(a.providerId);
    const idB = normalizeString(b.providerId);
    if (idA < idB) return -1;
    if (idA > idB) return 1;

    return 0;
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

        console.log(
            `[MemoryProviderResolver] Extraction resolved: ${extraction.providerType}` +
            `${extraction.model ? ' / ' + extraction.model : ''} — ${extraction.reason}`,
        );
        console.log(
            `[MemoryProviderResolver] Embeddings resolved: ${embeddings.providerType}` +
            `${embeddings.model ? ' / ' + embeddings.model : ''} — ${embeddings.reason}`,
        );

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
        const candidates = this._buildRankedCandidates()
            .filter(c => c.supportsExtraction && c.isAvailable);

        candidates.sort(compareRankedCandidates);

        if (candidates.length === 0) {
            return this._none('no_provider_resolved');
        }

        const chosen = candidates[0];
        const reason = this._describeSelection(chosen, 'extraction');
        return this._buildResolved(chosen._descriptor, reason);
    }

    /**
     * Resolves the embeddings backend.
     * Only providers with capabilities.embeddings = true are considered.
     */
    public resolveEmbeddings(): ResolvedMemoryBackend {
        const candidates = this._buildRankedCandidates()
            .filter(c => c.supportsEmbeddings && c.isAvailable);

        candidates.sort(compareRankedCandidates);

        if (candidates.length === 0) {
            return this._none('no_embedding_provider_resolved');
        }

        const chosen = candidates[0];
        const reason = this._describeSelection(chosen, 'embeddings');
        return this._buildResolved(chosen._descriptor, reason);
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

    private _buildRankedCandidates(): RankedMemoryCandidate[] {
        const preferred = this.inventory.selectedProviderId;
        return this.inventory.providers.map(p => buildRankedCandidate(p, preferred));
    }

    private _buildResolved(
        descriptor: InferenceProviderDescriptor,
        reason: string,
    ): ResolvedMemoryBackend {
        return {
            enabled: true,
            providerId: descriptor.providerId,
            providerType: toMemoryBackendType(descriptor.providerType),
            model:
                descriptor.preferredModel ??
                (descriptor.models.length > 0 ? descriptor.models[0] : null),
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

    private _describeSelection(
        candidate: RankedMemoryCandidate,
        use: 'extraction' | 'embeddings',
    ): string {
        const parts: string[] = ['deterministic_rank'];
        if (candidate.isPreferred) parts.push('preferred');
        if (candidate.isLocal) parts.push('local');
        if (candidate.isRunning) parts.push('running');
        if (candidate.isAvailable) parts.push('available');
        parts.push(`type_priority=${candidate.typePriority}`);
        parts.push(`use=${use}`);
        return parts.join('+');
    }
}
