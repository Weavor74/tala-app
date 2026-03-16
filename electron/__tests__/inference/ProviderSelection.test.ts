/**
 * Provider Selection Tests
 *
 * Validates the ProviderSelectionService deterministic fallback policy.
 * Uses a mock InferenceProviderRegistry to control provider state.
 *
 * Coverage:
 * - Explicit selected provider ready → chosen
 * - Explicit selected provider unavailable → fallback applied
 * - No selection, best local provider chosen by priority
 * - No local providers → embedded llama.cpp chosen
 * - No local or embedded → cloud chosen
 * - No providers available → explicit failure result
 * - local-only mode skips cloud
 * - cloud-only mode skips local/embedded
 * - Telemetry emitted for selection and fallback events
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProviderSelectionService } from '../../services/inference/ProviderSelectionService';
import { InferenceProviderRegistry } from '../../services/inference/InferenceProviderRegistry';
import type { InferenceProviderDescriptor } from '../../../shared/inferenceProviderTypes';

// ─── Telemetry mock ───────────────────────────────────────────────────────────

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
        debug: (_s: string, et: string, _a: string, _sum: string) => {
            emittedEvents.push({ eventType: et, status: 'success' });
        },
    },
}));

// ─── Registry mock helpers ────────────────────────────────────────────────────

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

/**
 * Creates an InferenceProviderRegistry pre-populated with given descriptors.
 * Bypasses actual probing by patching the internal map directly.
 */
function makeRegistry(descriptors: InferenceProviderDescriptor[]): InferenceProviderRegistry {
    const registry = new InferenceProviderRegistry({});
    // Inject descriptors directly
    const map = (registry as any).descriptors as Map<string, InferenceProviderDescriptor>;
    map.clear();
    for (const d of descriptors) map.set(d.providerId, d);
    return registry;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ProviderSelectionService — explicit selection', () => {
    beforeEach(() => { emittedEvents.length = 0; });

    it('returns the explicitly selected provider when it is ready', () => {
        const ollama = makeDescriptor({ providerId: 'ollama', ready: true, priority: 10 });
        const cloud = makeDescriptor({ providerId: 'cloud', providerType: 'cloud', scope: 'cloud', ready: true, priority: 100 });
        const registry = makeRegistry([ollama, cloud]);
        const svc = new ProviderSelectionService(registry);

        const result = svc.select({ preferredProviderId: 'ollama' });

        expect(result.success).toBe(true);
        expect(result.selectedProvider!.providerId).toBe('ollama');
        expect(result.fallbackApplied).toBe(false);
    });

    it('falls back when selected provider is not ready', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', ready: false, status: 'not_running', priority: 10 });
        const cloud = makeDescriptor({ providerId: 'cloud', providerType: 'cloud', scope: 'cloud', ready: true, priority: 100 });
        const registry = makeRegistry([ollamaDown, cloud]);
        registry.setSelectedProviderId('ollama');
        const svc = new ProviderSelectionService(registry);

        const result = svc.select({ preferredProviderId: 'ollama', fallbackAllowed: true });

        expect(result.success).toBe(true);
        expect(result.fallbackApplied).toBe(true);
        expect(result.selectedProvider!.providerId).toBe('cloud');
    });

    it('returns failure when selected provider unavailable and fallback disabled', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', ready: false, status: 'not_running', priority: 10 });
        const cloud = makeDescriptor({ providerId: 'cloud', providerType: 'cloud', scope: 'cloud', ready: true, priority: 100 });
        const registry = makeRegistry([ollamaDown, cloud]);
        const svc = new ProviderSelectionService(registry);

        const result = svc.select({ preferredProviderId: 'ollama', fallbackAllowed: false });

        expect(result.success).toBe(false);
        expect(result.failure).toBeDefined();
        expect(result.failure!.code).toBe('no_provider');
    });

    it('emits provider_fallback_applied telemetry when fallback is triggered', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', ready: false, status: 'not_running', priority: 10 });
        const cloud = makeDescriptor({ providerId: 'cloud', providerType: 'cloud', scope: 'cloud', ready: true, priority: 100 });
        const registry = makeRegistry([ollamaDown, cloud]);
        const svc = new ProviderSelectionService(registry);

        svc.select({ preferredProviderId: 'ollama', fallbackAllowed: true });

        const fallbackEvents = emittedEvents.filter(e => e.eventType === 'provider_fallback_applied');
        expect(fallbackEvents.length).toBeGreaterThan(0);
    });
});

describe('ProviderSelectionService — automatic selection', () => {
    beforeEach(() => { emittedEvents.length = 0; });

    it('chooses best local provider by priority when no explicit selection', () => {
        const ollama = makeDescriptor({ providerId: 'ollama', providerType: 'ollama', scope: 'local', ready: true, priority: 10 });
        const vllm = makeDescriptor({ providerId: 'vllm', providerType: 'vllm', scope: 'local', ready: true, priority: 25 });
        const registry = makeRegistry([ollama, vllm]);
        const svc = new ProviderSelectionService(registry);

        const result = svc.select({});

        expect(result.success).toBe(true);
        expect(result.selectedProvider!.providerId).toBe('ollama'); // lower priority number wins
    });

    it('falls back to embedded llama.cpp when no local provider is ready', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', providerType: 'ollama', scope: 'local', ready: false, priority: 10 });
        const embedded = makeDescriptor({ providerId: 'embedded_llamacpp', providerType: 'embedded_llamacpp', scope: 'embedded', ready: true, priority: 30 });
        const registry = makeRegistry([ollamaDown, embedded]);
        const svc = new ProviderSelectionService(registry);

        const result = svc.select({});

        expect(result.success).toBe(true);
        expect(result.selectedProvider!.providerId).toBe('embedded_llamacpp');
        expect(result.fallbackApplied).toBe(true);
    });

    it('falls back to cloud when no local or embedded provider is ready', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', providerType: 'ollama', scope: 'local', ready: false, priority: 10 });
        const embDown = makeDescriptor({ providerId: 'embedded_llamacpp', providerType: 'embedded_llamacpp', scope: 'embedded', ready: false, priority: 30 });
        const cloud = makeDescriptor({ providerId: 'cloud', providerType: 'cloud', scope: 'cloud', ready: true, priority: 100 });
        const registry = makeRegistry([ollamaDown, embDown, cloud]);
        const svc = new ProviderSelectionService(registry);

        const result = svc.select({});

        expect(result.success).toBe(true);
        expect(result.selectedProvider!.providerId).toBe('cloud');
        expect(result.fallbackApplied).toBe(true);
    });

    it('returns failure with structured error when no providers are viable', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', providerType: 'ollama', scope: 'local', ready: false, priority: 10 });
        const registry = makeRegistry([ollamaDown]);
        const svc = new ProviderSelectionService(registry);

        const result = svc.select({});

        expect(result.success).toBe(false);
        expect(result.failure).toBeDefined();
        expect(result.failure!.code).toBe('no_provider');
        expect(result.failure!.fallbackExhausted).toBe(true);
    });
});

describe('ProviderSelectionService — routing modes', () => {
    beforeEach(() => { emittedEvents.length = 0; });

    it('local-only mode does not select cloud even when local is unavailable', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', providerType: 'ollama', scope: 'local', ready: false, priority: 10 });
        const cloud = makeDescriptor({ providerId: 'cloud', providerType: 'cloud', scope: 'cloud', ready: true, priority: 100 });
        const registry = makeRegistry([ollamaDown, cloud]);
        const svc = new ProviderSelectionService(registry);

        const result = svc.select({ mode: 'local-only' });

        expect(result.success).toBe(false);
    });

    it('local-only mode selects embedded when local is unavailable but embedded is ready', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', providerType: 'ollama', scope: 'local', ready: false, priority: 10 });
        const embedded = makeDescriptor({ providerId: 'embedded_llamacpp', providerType: 'embedded_llamacpp', scope: 'embedded', ready: true, priority: 30 });
        const registry = makeRegistry([ollamaDown, embedded]);
        const svc = new ProviderSelectionService(registry);

        const result = svc.select({ mode: 'local-only' });

        expect(result.success).toBe(true);
        expect(result.selectedProvider!.providerId).toBe('embedded_llamacpp');
    });

    it('cloud-only mode selects cloud and ignores ready local providers', () => {
        const ollama = makeDescriptor({ providerId: 'ollama', providerType: 'ollama', scope: 'local', ready: true, priority: 10 });
        const cloud = makeDescriptor({ providerId: 'cloud', providerType: 'cloud', scope: 'cloud', ready: true, priority: 100 });
        const registry = makeRegistry([ollama, cloud]);
        const svc = new ProviderSelectionService(registry);

        const result = svc.select({ mode: 'cloud-only' });

        expect(result.success).toBe(true);
        expect(result.selectedProvider!.providerId).toBe('cloud');
    });

    it('cloud-only mode returns failure when cloud is not configured or ready', () => {
        const ollama = makeDescriptor({ providerId: 'ollama', providerType: 'ollama', scope: 'local', ready: true, priority: 10 });
        const registry = makeRegistry([ollama]); // No cloud provider
        const svc = new ProviderSelectionService(registry);

        const result = svc.select({ mode: 'cloud-only' });

        expect(result.success).toBe(false);
    });
});

describe('ProviderSelectionService — telemetry', () => {
    beforeEach(() => { emittedEvents.length = 0; });

    it('emits provider_selected on successful selection', () => {
        const ollama = makeDescriptor({ providerId: 'ollama', ready: true, priority: 10 });
        const registry = makeRegistry([ollama]);
        const svc = new ProviderSelectionService(registry);

        svc.select({});

        const selected = emittedEvents.filter(e => e.eventType === 'provider_selected');
        expect(selected.length).toBeGreaterThan(0);
        expect(selected[0].status).toBe('success');
    });

    it('emits provider_unavailable on failure when no provider found', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', ready: false, priority: 10 });
        const registry = makeRegistry([ollamaDown]);
        const svc = new ProviderSelectionService(registry);

        svc.select({});

        const unavailable = emittedEvents.filter(e => e.eventType === 'provider_unavailable');
        expect(unavailable.length).toBeGreaterThan(0);
    });

    it('attemptedProviders in failure result lists skipped providers', () => {
        const ollamaDown = makeDescriptor({ providerId: 'ollama', providerType: 'ollama', scope: 'local', ready: false, priority: 10 });
        const embDown = makeDescriptor({ providerId: 'embedded_llamacpp', providerType: 'embedded_llamacpp', scope: 'embedded', ready: false, priority: 30 });
        const cloudDown = makeDescriptor({ providerId: 'cloud', providerType: 'cloud', scope: 'cloud', ready: false, priority: 100 });
        const registry = makeRegistry([ollamaDown, embDown, cloudDown]);
        const svc = new ProviderSelectionService(registry);

        const result = svc.select({});

        expect(result.success).toBe(false);
        expect(result.attemptedProviders.length).toBeGreaterThan(0);
    });
});
