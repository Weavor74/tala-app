/**
 * Provider Selection Tests
 *
 * Validates deterministic waterfall selection behavior.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProviderSelectionService } from '../../services/inference/ProviderSelectionService';
import { InferenceProviderRegistry } from '../../services/inference/InferenceProviderRegistry';
import type { InferenceProviderDescriptor } from '../../../shared/inferenceProviderTypes';

const emittedEvents: Array<{ eventType: string; status: string }> = [];

vi.mock('../../services/TelemetryService', () => ({
    telemetry: {
        emit: (_s: string, et: string, _sv: string, _a: string, _sum: string, st: string) => {
            emittedEvents.push({ eventType: et, status: st });
        },
        operational: (_s: string, et: string, _sv: string, _a: string, _sum: string, st: string) => {
            emittedEvents.push({ eventType: et, status: st });
        },
        audit: (_s: string, et: string, _a: string, _sum: string, st: string) => {
            emittedEvents.push({ eventType: et, status: st });
        },
        debug: (_s: string, et: string) => {
            emittedEvents.push({ eventType: et, status: 'success' });
        },
    },
}));

function makeDescriptor(overrides: Partial<InferenceProviderDescriptor> & { providerId: string }): InferenceProviderDescriptor {
    return {
        providerId: overrides.providerId,
        displayName: overrides.displayName ?? overrides.providerId,
        providerType: overrides.providerType ?? 'ollama',
        scope: overrides.scope ?? 'local',
        transport: overrides.transport ?? 'http_ollama',
        endpoint: overrides.endpoint ?? 'http://127.0.0.1:11434',
        configured: true,
        detected: overrides.detected ?? true,
        ready: overrides.ready ?? true,
        health: overrides.health ?? 'healthy',
        status: overrides.status ?? 'ready',
        priority: overrides.priority ?? 10,
        capabilities: overrides.capabilities ?? { streaming: true, toolCalls: true, vision: false, embeddings: false },
        models: overrides.models ?? [],
        preferredModel: overrides.preferredModel,
        apiKey: overrides.apiKey,
    };
}

function makeRegistry(descriptors: InferenceProviderDescriptor[]): InferenceProviderRegistry {
    const registry = new InferenceProviderRegistry({});
    const map = (registry as any).descriptors as Map<string, InferenceProviderDescriptor>;
    map.clear();
    for (const d of descriptors) map.set(d.providerId, d);
    return registry;
}

describe('ProviderSelectionService - preferred provider', () => {
    beforeEach(() => { emittedEvents.length = 0; });

    it('returns request preferred provider when ready', () => {
        const ollama = makeDescriptor({ providerId: 'ollama', ready: true });
        const vllm = makeDescriptor({ providerId: 'vllm', providerType: 'vllm', transport: 'http_openai_compat', endpoint: 'http://127.0.0.1:8100' });
        const svc = new ProviderSelectionService(makeRegistry([ollama, vllm]));

        const result = svc.select({ preferredProviderId: 'vllm' });

        expect(result.success).toBe(true);
        expect(result.selectedProvider!.providerId).toBe('vllm');
        expect(result.fallbackApplied).toBe(false);
    });

    it('uses registry selected provider when request preferredProviderId is omitted', () => {
        const ollama = makeDescriptor({ providerId: 'ollama', ready: true });
        const vllm = makeDescriptor({ providerId: 'vllm', providerType: 'vllm', transport: 'http_openai_compat', endpoint: 'http://127.0.0.1:8100' });
        const registry = makeRegistry([ollama, vllm]);
        registry.setSelectedProviderId('vllm');
        const svc = new ProviderSelectionService(registry);

        const result = svc.select({});

        expect(result.success).toBe(true);
        expect(result.selectedProvider!.providerId).toBe('vllm');
    });

    it('falls through deterministically when selected provider is unavailable', () => {
        const ollama = makeDescriptor({ providerId: 'ollama', ready: true, priority: 1 });
        const vllmDown = makeDescriptor({ providerId: 'vllm', providerType: 'vllm', transport: 'http_openai_compat', endpoint: 'http://127.0.0.1:8100', ready: false, status: 'not_running' });
        const cloud = makeDescriptor({ providerId: 'cloud', providerType: 'cloud', scope: 'cloud', transport: 'http_openai_compat', endpoint: 'https://api.example.com', ready: true, priority: 100 });
        const registry = makeRegistry([ollama, vllmDown, cloud]);
        registry.setSelectedProviderId('vllm');
        const svc = new ProviderSelectionService(registry);

        const result = svc.select({ fallbackAllowed: true });

        expect(result.success).toBe(true);
        expect(result.selectedProvider!.providerId).toBe('ollama');
        expect(result.fallbackApplied).toBe(true);
        expect(result.attemptedProviders).toContain('vllm');
    });
});

describe('ProviderSelectionService - waterfall order', () => {
    beforeEach(() => { emittedEvents.length = 0; });

    it('falls from unavailable ollama to next ready local provider', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', ready: false, status: 'not_running', priority: 1 });
        const vllm = makeDescriptor({ providerId: 'vllm', providerType: 'vllm', transport: 'http_openai_compat', endpoint: 'http://127.0.0.1:8100', ready: true, priority: 50 });
        const cloud = makeDescriptor({ providerId: 'cloud', providerType: 'cloud', scope: 'cloud', transport: 'http_openai_compat', endpoint: 'https://api.example.com', ready: true, priority: 100 });
        const svc = new ProviderSelectionService(makeRegistry([ollamaDown, vllm, cloud]));

        const result = svc.select({});

        expect(result.success).toBe(true);
        expect(result.selectedProvider!.providerId).toBe('vllm');
        expect(result.attemptedProviders).toContain('ollama');
    });

    it('prefers embedded_vllm before embedded_llamacpp when local providers are unavailable', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', ready: false, status: 'not_running' });
        const vllmDown = makeDescriptor({ providerId: 'vllm', providerType: 'vllm', transport: 'http_openai_compat', endpoint: 'http://127.0.0.1:8100', ready: false, status: 'not_running' });
        const embeddedVllm = makeDescriptor({ providerId: 'embedded_vllm', providerType: 'embedded_vllm', scope: 'embedded', transport: 'http_openai_compat', endpoint: 'http://127.0.0.1:8000', ready: true, priority: 999 });
        const embeddedLlama = makeDescriptor({ providerId: 'embedded_llamacpp', providerType: 'embedded_llamacpp', scope: 'embedded', transport: 'http_openai_compat', endpoint: 'http://127.0.0.1:8080', ready: true, priority: 1 });
        const svc = new ProviderSelectionService(makeRegistry([ollamaDown, vllmDown, embeddedVllm, embeddedLlama]));

        const result = svc.select({});

        expect(result.success).toBe(true);
        expect(result.selectedProvider!.providerId).toBe('embedded_vllm');
    });

    it('uses cloud only when local/embedded waterfall is exhausted in auto mode', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', ready: false, status: 'not_running' });
        const vllmDown = makeDescriptor({ providerId: 'vllm', providerType: 'vllm', transport: 'http_openai_compat', endpoint: 'http://127.0.0.1:8100', ready: false, status: 'not_running' });
        const embeddedVllmDown = makeDescriptor({ providerId: 'embedded_vllm', providerType: 'embedded_vllm', scope: 'embedded', transport: 'http_openai_compat', endpoint: 'http://127.0.0.1:8000', ready: false, status: 'not_running' });
        const cloud = makeDescriptor({ providerId: 'cloud', providerType: 'cloud', scope: 'cloud', transport: 'http_openai_compat', endpoint: 'https://api.example.com', ready: true, priority: 1 });
        const svc = new ProviderSelectionService(makeRegistry([ollamaDown, vllmDown, embeddedVllmDown, cloud]));

        const result = svc.select({ mode: 'auto' });

        expect(result.success).toBe(true);
        expect(result.selectedProvider!.providerId).toBe('cloud');
        expect(result.fallbackApplied).toBe(true);
    });

    it('local-only mode does not select cloud', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', ready: false, status: 'not_running' });
        const cloud = makeDescriptor({ providerId: 'cloud', providerType: 'cloud', scope: 'cloud', transport: 'http_openai_compat', endpoint: 'https://api.example.com', ready: true });
        const svc = new ProviderSelectionService(makeRegistry([ollamaDown, cloud]));

        const result = svc.select({ mode: 'local-only' });

        expect(result.success).toBe(false);
    });

    it('cloud-only mode selects cloud and ignores ready local providers', () => {
        const ollama = makeDescriptor({ providerId: 'ollama', ready: true });
        const cloud = makeDescriptor({ providerId: 'cloud', providerType: 'cloud', scope: 'cloud', transport: 'http_openai_compat', endpoint: 'https://api.example.com', ready: true });
        const svc = new ProviderSelectionService(makeRegistry([ollama, cloud]));

        const result = svc.select({ mode: 'cloud-only' });

        expect(result.success).toBe(true);
        expect(result.selectedProvider!.providerId).toBe('cloud');
    });

    it('returns failure when selected provider is unavailable and fallback is disabled', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', ready: false, status: 'not_running' });
        const cloud = makeDescriptor({ providerId: 'cloud', providerType: 'cloud', scope: 'cloud', transport: 'http_openai_compat', endpoint: 'https://api.example.com', ready: true });
        const registry = makeRegistry([ollamaDown, cloud]);
        registry.setSelectedProviderId('ollama');
        const svc = new ProviderSelectionService(registry);

        const result = svc.select({ fallbackAllowed: false });

        expect(result.success).toBe(false);
        expect(result.failure?.code).toBe('no_provider');
    });
});

describe('ProviderSelectionService - telemetry', () => {
    beforeEach(() => { emittedEvents.length = 0; });

    it('emits provider_selected on successful selection', () => {
        const ollama = makeDescriptor({ providerId: 'ollama', ready: true });
        const svc = new ProviderSelectionService(makeRegistry([ollama]));

        svc.select({});

        expect(emittedEvents.some((e) => e.eventType === 'provider_selected')).toBe(true);
    });

    it('emits provider_fallback_applied when preferred provider is unavailable', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', ready: false, status: 'not_running' });
        const vllm = makeDescriptor({ providerId: 'vllm', providerType: 'vllm', transport: 'http_openai_compat', endpoint: 'http://127.0.0.1:8100', ready: true });
        const registry = makeRegistry([ollamaDown, vllm]);
        registry.setSelectedProviderId('ollama');
        const svc = new ProviderSelectionService(registry);

        svc.select({});

        expect(emittedEvents.some((e) => e.eventType === 'provider_fallback_applied')).toBe(true);
    });

    it('emits provider_unavailable when no provider is viable', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', ready: false, status: 'not_running' });
        const svc = new ProviderSelectionService(makeRegistry([ollamaDown]));

        svc.select({ mode: 'local-only' });

        expect(emittedEvents.some((e) => e.eventType === 'provider_unavailable')).toBe(true);
    });
});

describe('ProviderSelectionService - model validation', () => {
    beforeEach(() => { emittedEvents.length = 0; });

    it('does not treat preferredModelId as available when missing from live inventory', () => {
        const ollama = makeDescriptor({
            providerId: 'ollama',
            ready: true,
            models: ['a:latest', 'c:latest'],
            preferredModel: 'legacy:b',
        });
        const svc = new ProviderSelectionService(makeRegistry([ollama]));

        const result = svc.select({ preferredProviderId: 'ollama', preferredModelId: 'legacy:b' });

        expect(result.success).toBe(true);
        expect(result.selectedProvider!.providerId).toBe('ollama');
        expect(result.resolvedModel).toBe('a:latest');
    });
});
