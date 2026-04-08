/**
 * MemoryProviderResolver.test.ts — PR-TS-01 through PR-TS-14
 *
 * Validates the deterministic selection logic in MemoryProviderResolver:
 *   - provider priority order (ollama > vllm > llamacpp > cloud)
 *   - fallback when preferred providers are absent or unavailable
 *   - canonical_only / canonical_plus_embeddings / full_memory mode derivation
 *   - determinism over repeated resolutions
 *   - stable tie-breaks by type, model name, and provider ID
 *   - user preference signals
 *   - local vs remote locality preference
 *
 * No live services, no environment dependencies, no real model runtimes.
 */

import { describe, it, expect } from 'vitest';
import { MemoryProviderResolver } from '../electron/services/memory/MemoryProviderResolver';
import type {
    InferenceProviderDescriptor,
    InferenceProviderInventory,
} from '../shared/inferenceProviderTypes';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeDescriptor(overrides: Partial<InferenceProviderDescriptor> = {}): InferenceProviderDescriptor {
    return {
        providerId: 'provider-a',
        displayName: 'Provider A',
        providerType: 'ollama',
        scope: 'local',
        transport: 'http_ollama',
        endpoint: 'http://localhost:11434',
        configured: true,
        detected: true,
        ready: true,
        health: 'healthy',
        status: 'ready',
        priority: 10,
        capabilities: {
            streaming: true,
            toolCalls: false,
            vision: false,
            embeddings: true,
        },
        models: ['model-a'],
        preferredModel: 'model-a',
        ...overrides,
    };
}

function makeInventory(
    providers: InferenceProviderDescriptor[],
    overrides: Partial<InferenceProviderInventory> = {},
): InferenceProviderInventory {
    return {
        providers,
        lastRefreshed: '2024-01-01T00:00:00.000Z',
        refreshing: false,
        ...overrides,
    };
}

// ─── PR-TS-01 — Ollama wins when all core local providers are available ────────

describe('PR-TS-01 — Ollama wins when all core local providers are available', () => {
    const providers = [
        makeDescriptor({ providerId: 'ollama-1', providerType: 'ollama', scope: 'local', status: 'ready', ready: true }),
        makeDescriptor({ providerId: 'vllm-1',   providerType: 'vllm',   scope: 'local', status: 'ready', ready: true, transport: 'http_openai_compat' }),
        makeDescriptor({ providerId: 'llama-1',  providerType: 'llamacpp', scope: 'local', status: 'ready', ready: true, transport: 'http_openai_compat' }),
    ];
    const resolver = new MemoryProviderResolver(makeInventory(providers));

    it('extraction selects ollama', () => {
        expect(resolver.resolveExtraction().providerId).toBe('ollama-1');
    });

    it('extraction is enabled', () => {
        expect(resolver.resolveExtraction().enabled).toBe(true);
    });

    it('embeddings resolve to a valid provider', () => {
        const emb = resolver.resolveEmbeddings();
        expect(emb.enabled).toBe(true);
        expect(emb.providerId).toBeDefined();
    });
});

// ─── PR-TS-02 — vLLM selected when Ollama is absent ──────────────────────────

describe('PR-TS-02 — vLLM selected when Ollama is absent', () => {
    const providers = [
        makeDescriptor({ providerId: 'ollama-1', providerType: 'ollama', scope: 'local', ready: false, status: 'unavailable' }),
        makeDescriptor({ providerId: 'vllm-1',   providerType: 'vllm',   scope: 'local', ready: true,  status: 'ready', transport: 'http_openai_compat' }),
        makeDescriptor({ providerId: 'llama-1',  providerType: 'llamacpp', scope: 'local', ready: true, status: 'ready', transport: 'http_openai_compat' }),
    ];
    const resolver = new MemoryProviderResolver(makeInventory(providers));

    it('extraction selects vllm', () => {
        expect(resolver.resolveExtraction().providerId).toBe('vllm-1');
    });
});

// ─── PR-TS-03 — llama.cpp selected when it is the best valid remaining provider

describe('PR-TS-03 — llama.cpp selected when only local remaining provider', () => {
    const providers = [
        makeDescriptor({ providerId: 'ollama-1', providerType: 'ollama',   scope: 'local', ready: false, status: 'unavailable' }),
        makeDescriptor({ providerId: 'vllm-1',   providerType: 'vllm',     scope: 'local', ready: false, status: 'unavailable', transport: 'http_openai_compat' }),
        makeDescriptor({ providerId: 'llama-1',  providerType: 'llamacpp', scope: 'local', ready: true,  status: 'ready',       transport: 'http_openai_compat' }),
    ];
    const resolver = new MemoryProviderResolver(makeInventory(providers));

    it('extraction resolves to llamacpp', () => {
        expect(resolver.resolveExtraction().providerId).toBe('llama-1');
    });

    it('embeddings resolve to llamacpp', () => {
        expect(resolver.resolveEmbeddings().providerId).toBe('llama-1');
    });
});

// ─── PR-TS-04 — canonical_only when no valid providers exist ─────────────────

describe('PR-TS-04 — canonical_only when no valid providers exist', () => {
    const providers = [
        makeDescriptor({ providerId: 'ollama-1', providerType: 'ollama', ready: false, status: 'unavailable' }),
        makeDescriptor({ providerId: 'vllm-1',   providerType: 'vllm',   ready: false, status: 'unavailable', transport: 'http_openai_compat' }),
    ];
    const resolver = new MemoryProviderResolver(makeInventory(providers));

    it('mode is canonical_only', () => {
        expect(resolver.resolve().mode).toBe('canonical_only');
    });

    it('extraction providerType is none', () => {
        expect(resolver.resolveExtraction().providerType).toBe('none');
    });

    it('embeddings providerType is none', () => {
        expect(resolver.resolveEmbeddings().providerType).toBe('none');
    });
});

// ─── PR-TS-05 — canonical_plus_embeddings when only embeddings backend exists ─

describe('PR-TS-05 — canonical_plus_embeddings when only embeddings backend exists', () => {
    // An embeddings-only provider: streaming=false (no text generation), embeddings=true
    const providers = [
        makeDescriptor({
            providerId: 'embed-only-1',
            providerType: 'cloud',
            scope: 'cloud',
            ready: true,
            status: 'ready',
            transport: 'http_openai_compat',
            capabilities: { streaming: false, toolCalls: false, vision: false, embeddings: true },
        }),
    ];
    const resolver = new MemoryProviderResolver(makeInventory(providers));

    it('mode is canonical_plus_embeddings', () => {
        expect(resolver.resolve().mode).toBe('canonical_plus_embeddings');
    });

    it('extraction is disabled', () => {
        expect(resolver.resolveExtraction().enabled).toBe(false);
    });

    it('embeddings is enabled', () => {
        expect(resolver.resolveEmbeddings().enabled).toBe(true);
    });
});

// ─── PR-TS-06 — full_memory when both paths resolve ─────────────────────────

describe('PR-TS-06 — full_memory when both paths resolve', () => {
    const providers = [
        makeDescriptor({ providerId: 'ollama-1', providerType: 'ollama', scope: 'local', ready: true, status: 'ready' }),
    ];
    const resolver = new MemoryProviderResolver(makeInventory(providers));

    it('mode is full_memory', () => {
        expect(resolver.resolve().mode).toBe('full_memory');
    });
});

// ─── PR-TS-07 — determinism over repeated resolution ─────────────────────────

describe('PR-TS-07 — determinism over repeated resolution', () => {
    const providers = [
        makeDescriptor({ providerId: 'ollama-1', providerType: 'ollama',   scope: 'local', ready: true, status: 'ready' }),
        makeDescriptor({ providerId: 'vllm-1',   providerType: 'vllm',     scope: 'local', ready: true, status: 'ready', transport: 'http_openai_compat' }),
        makeDescriptor({ providerId: 'llama-1',  providerType: 'llamacpp', scope: 'local', ready: true, status: 'ready', transport: 'http_openai_compat' }),
    ];
    const resolver = new MemoryProviderResolver(makeInventory(providers));

    it('resolves identically 100 times', () => {
        const baseline = resolver.resolve();
        const { resolvedAt: _baseTs, ...baselineStable } = baseline;
        for (let i = 0; i < 100; i++) {
            const { resolvedAt: _ts, ...result } = resolver.resolve();
            expect(result).toEqual(baselineStable);
        }
    });
});

// ─── PR-TS-08 — deterministic tie-break by provider type ─────────────────────

describe('PR-TS-08 — deterministic tie-break by provider type', () => {
    // Same model, same availability/running/locality — only provider type differs
    const providers = [
        makeDescriptor({ providerId: 'llama-1',  providerType: 'llamacpp', scope: 'local', ready: true, status: 'ready', transport: 'http_openai_compat', models: ['model-x'], preferredModel: 'model-x' }),
        makeDescriptor({ providerId: 'ollama-1', providerType: 'ollama',   scope: 'local', ready: true, status: 'ready', models: ['model-x'], preferredModel: 'model-x' }),
        makeDescriptor({ providerId: 'vllm-1',   providerType: 'vllm',     scope: 'local', ready: true, status: 'ready', transport: 'http_openai_compat', models: ['model-x'], preferredModel: 'model-x' }),
    ];
    const resolver = new MemoryProviderResolver(makeInventory(providers));

    it('ollama wins (lowest type priority = highest rank)', () => {
        expect(resolver.resolveExtraction().providerId).toBe('ollama-1');
    });
});

// ─── PR-TS-09 — deterministic tie-break by model name ────────────────────────

describe('PR-TS-09 — deterministic tie-break by model name', () => {
    // Same type and locality; differ only by model name → lexical ascending
    const providers = [
        makeDescriptor({ providerId: 'ollama-c', providerType: 'ollama', scope: 'local', ready: true, status: 'ready', models: ['model-c'], preferredModel: 'model-c' }),
        makeDescriptor({ providerId: 'ollama-a', providerType: 'ollama', scope: 'local', ready: true, status: 'ready', models: ['model-a'], preferredModel: 'model-a' }),
        makeDescriptor({ providerId: 'ollama-b', providerType: 'ollama', scope: 'local', ready: true, status: 'ready', models: ['model-b'], preferredModel: 'model-b' }),
    ];
    const resolver = new MemoryProviderResolver(makeInventory(providers));

    it('provider with model-a wins (lexical first)', () => {
        expect(resolver.resolveExtraction().model).toBe('model-a');
    });
});

// ─── PR-TS-10 — deterministic tie-break by provider ID ───────────────────────

describe('PR-TS-10 — deterministic tie-break by provider ID', () => {
    // Same type, same model — differ only by provider ID → lexical ascending
    const providers = [
        makeDescriptor({ providerId: 'provider-c', providerType: 'ollama', scope: 'local', ready: true, status: 'ready', models: ['model-x'], preferredModel: 'model-x' }),
        makeDescriptor({ providerId: 'provider-a', providerType: 'ollama', scope: 'local', ready: true, status: 'ready', models: ['model-x'], preferredModel: 'model-x' }),
        makeDescriptor({ providerId: 'provider-b', providerType: 'ollama', scope: 'local', ready: true, status: 'ready', models: ['model-x'], preferredModel: 'model-x' }),
    ];
    const resolver = new MemoryProviderResolver(makeInventory(providers));

    it('provider-a wins (lexical first ID)', () => {
        expect(resolver.resolveExtraction().providerId).toBe('provider-a');
    });
});

// ─── PR-TS-11 — user-preferred provider wins when valid ──────────────────────

describe('PR-TS-11 — user-preferred provider wins when valid', () => {
    const providers = [
        // Higher default priority but NOT preferred
        makeDescriptor({ providerId: 'ollama-1', providerType: 'ollama', scope: 'local', ready: true, status: 'ready' }),
        // Lower default priority but IS preferred
        makeDescriptor({ providerId: 'vllm-preferred', providerType: 'vllm', scope: 'local', ready: true, status: 'ready', transport: 'http_openai_compat' }),
    ];
    const resolver = new MemoryProviderResolver(
        makeInventory(providers, { selectedProviderId: 'vllm-preferred' }),
    );

    it('preferred provider wins over higher-priority default', () => {
        expect(resolver.resolveExtraction().providerId).toBe('vllm-preferred');
    });
});

// ─── PR-TS-12 — invalid preferred provider is ignored ────────────────────────

describe('PR-TS-12 — invalid preferred provider is ignored', () => {
    const providers = [
        // Preferred but unavailable (ready=false)
        makeDescriptor({ providerId: 'unavailable-preferred', providerType: 'vllm', scope: 'local', ready: false, status: 'unavailable', transport: 'http_openai_compat' }),
        // Not preferred but valid
        makeDescriptor({ providerId: 'ollama-valid', providerType: 'ollama', scope: 'local', ready: true, status: 'ready' }),
    ];
    const resolver = new MemoryProviderResolver(
        makeInventory(providers, { selectedProviderId: 'unavailable-preferred' }),
    );

    it('valid provider wins over unavailable preferred provider', () => {
        expect(resolver.resolveExtraction().providerId).toBe('ollama-valid');
    });
});

// ─── PR-TS-13 — embeddings and extraction resolve to different providers ──────

describe('PR-TS-13 — embeddings and extraction resolve to different providers', () => {
    const providers = [
        // Supports extraction only (streaming=true, embeddings=false)
        makeDescriptor({
            providerId: 'extraction-only',
            providerType: 'ollama',
            scope: 'local',
            ready: true,
            status: 'ready',
            capabilities: { streaming: true, toolCalls: false, vision: false, embeddings: false },
        }),
        // Supports embeddings only (streaming=false, embeddings=true)
        makeDescriptor({
            providerId: 'embedding-only',
            providerType: 'cloud',
            scope: 'cloud',
            ready: true,
            status: 'ready',
            transport: 'http_openai_compat',
            capabilities: { streaming: false, toolCalls: false, vision: false, embeddings: true },
        }),
    ];
    const resolver = new MemoryProviderResolver(makeInventory(providers));

    it('extraction uses the extraction-capable provider', () => {
        expect(resolver.resolveExtraction().providerId).toBe('extraction-only');
    });

    it('embeddings uses the embeddings-capable provider', () => {
        expect(resolver.resolveEmbeddings().providerId).toBe('embedding-only');
    });

    it('mode is full_memory when both paths resolve', () => {
        expect(resolver.resolve().mode).toBe('full_memory');
    });
});

// ─── PR-TS-14 — remote provider loses to equivalent local provider ────────────

describe('PR-TS-14 — remote provider loses to equivalent local provider', () => {
    const providers = [
        // Remote (cloud scope) — same type mapping, same model
        makeDescriptor({
            providerId: 'cloud-provider',
            providerType: 'cloud',
            scope: 'cloud',
            ready: true,
            status: 'ready',
            transport: 'http_openai_compat',
            models: ['model-x'],
            preferredModel: 'model-x',
        }),
        // Local — same model, local scope wins via locality comparator
        makeDescriptor({
            providerId: 'local-provider',
            providerType: 'ollama',
            scope: 'local',
            ready: true,
            status: 'ready',
            models: ['model-x'],
            preferredModel: 'model-x',
        }),
    ];
    const resolver = new MemoryProviderResolver(makeInventory(providers));

    it('local provider wins over remote provider', () => {
        expect(resolver.resolveExtraction().providerId).toBe('local-provider');
    });
});
