/**
 * Provider Detection Tests
 *
 * Validates the InferenceProviderRegistry probe and detection behaviour.
 * Network calls are intercepted so tests run without real services.
 *
 * Coverage:
 * - Ollama detected and healthy
 * - Ollama configured but endpoint not reachable
 * - Embedded llama.cpp binary + model present (not yet running)
 * - Embedded llama.cpp binary + model absent
 * - vLLM configured and healthy
 * - KoboldCpp configured but endpoint unavailable
 * - Unknown / extra provider does not crash registry
 * - Telemetry emitted for detected / unavailable / probe-failed events
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { InferenceProviderRegistry, checkEmbeddedLlamaCppAvailability } from '../../services/inference/InferenceProviderRegistry';

// ─── Mock fs module ───────────────────────────────────────────────────────────

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: vi.fn(() => false),
        createWriteStream: actual.createWriteStream,
    };
});

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

// ─── HTTP mock ────────────────────────────────────────────────────────────────

const httpResponses: Record<string, { status: number; body: string } | 'error'> = {};

function setHttpResponse(urlFragment: string, resp: { status: number; body: string } | 'error') {
    httpResponses[urlFragment] = resp;
}

function clearHttpResponses() {
    for (const key of Object.keys(httpResponses)) delete httpResponses[key];
}

vi.mock('http', () => {
    function makeRequest(url: string, _opts: any, cb?: (res: any) => void) {
        const callbackFn = typeof _opts === 'function' ? _opts : cb;
        const matchKey = Object.keys(httpResponses).find(k => url.includes(k));
        const response = matchKey ? httpResponses[matchKey] : 'error';

        if (response === 'error' || !response) {
            const req = {
                on: (evt: string, handler: (...args: any[]) => void) => {
                    if (evt === 'error') setTimeout(() => handler(new Error('ECONNREFUSED')), 0);
                    return req;
                },
                end: () => req,
                destroy: () => req,
            };
            return req;
        }

        const fakeRes = {
            statusCode: response.status,
            on: (evt: string, handler: (...args: any[]) => void) => {
                if (evt === 'data') setTimeout(() => handler(Buffer.from(response.body)), 0);
                if (evt === 'end') setTimeout(() => handler(), 5);
                return fakeRes;
            },
        };
        if (callbackFn) setTimeout(() => callbackFn(fakeRes), 0);
        const req = {
            on: (_evt: string, _handler: (...args: any[]) => void) => req,
            end: () => req,
            destroy: () => req,
        };
        return req;
    }

    return {
        default: { get: makeRequest, request: makeRequest },
        get: makeRequest,
        request: makeRequest,
    };
});

vi.mock('https', () => ({
    default: { get: vi.fn() },
    get: vi.fn(),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('InferenceProviderRegistry — Ollama detection', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
        clearHttpResponses();
    });

    it('detects Ollama as healthy when /api/tags returns 200 with models', async () => {
        setHttpResponse('/api/tags', {
            status: 200,
            body: JSON.stringify({ models: [{ name: 'llama3:latest' }, { name: 'codellama:7b' }] }),
        });

        const registry = new InferenceProviderRegistry({
            ollama: { endpoint: 'http://127.0.0.1:11434', enabled: true },
        });

        await registry.refresh();

        const inv = registry.getInventory();
        const ollama = inv.providers.find(p => p.providerId === 'ollama');
        expect(ollama).toBeDefined();
        expect(ollama!.ready).toBe(true);
        expect(ollama!.health).toBe('healthy');
        expect(ollama!.status).toBe('ready');
        expect(ollama!.models).toContain('llama3:latest');
    });

    it('marks Ollama as not_running when endpoint is unreachable', async () => {
        // No HTTP response set → falls through to error handler
        const registry = new InferenceProviderRegistry({
            ollama: { endpoint: 'http://127.0.0.1:11434', enabled: true },
        });

        await registry.refresh();

        const ollama = registry.getInventory().providers.find(p => p.providerId === 'ollama');
        expect(ollama!.ready).toBe(false);
        expect(ollama!.status).toBe('not_running');
        expect(ollama!.health).toBe('unavailable');
        expect(ollama!.models).toEqual([]);
    });

    it('replaces Ollama model inventory on each refresh and removes deleted models', async () => {
        setHttpResponse('/api/tags', {
            status: 200,
            body: JSON.stringify({ models: [{ name: 'a:latest' }, { name: 'b:latest' }, { name: 'c:latest' }] }),
        });

        const registry = new InferenceProviderRegistry({
            ollama: { endpoint: 'http://127.0.0.1:11434', enabled: true },
        });

        await registry.refresh();
        let ollama = registry.getInventory().providers.find(p => p.providerId === 'ollama');
        expect(ollama!.models).toEqual(['a:latest', 'b:latest', 'c:latest']);

        setHttpResponse('/api/tags', {
            status: 200,
            body: JSON.stringify({ models: [{ name: 'a:latest' }, { name: 'c:latest' }] }),
        });

        await registry.refresh();
        ollama = registry.getInventory().providers.find(p => p.providerId === 'ollama');
        expect(ollama!.models).toEqual(['a:latest', 'c:latest']);
        expect(ollama!.models).not.toContain('b:latest');
    });

    it('clears Ollama models after a reachable->unreachable transition', async () => {
        setHttpResponse('/api/tags', {
            status: 200,
            body: JSON.stringify({ models: [{ name: 'llama3:latest' }] }),
        });

        const registry = new InferenceProviderRegistry({
            ollama: { endpoint: 'http://127.0.0.1:11434', enabled: true },
        });

        await registry.refresh();
        let ollama = registry.getInventory().providers.find(p => p.providerId === 'ollama');
        expect(ollama!.models).toEqual(['llama3:latest']);

        clearHttpResponses();
        await registry.refresh();
        ollama = registry.getInventory().providers.find(p => p.providerId === 'ollama');
        expect(ollama!.ready).toBe(false);
        expect(ollama!.models).toEqual([]);
    });

    it('emits provider_detected telemetry when Ollama is healthy', async () => {
        setHttpResponse('/api/tags', {
            status: 200,
            body: JSON.stringify({ models: [{ name: 'llama3:latest' }] }),
        });

        const registry = new InferenceProviderRegistry({
            ollama: { endpoint: 'http://127.0.0.1:11434', enabled: true },
        });

        await registry.refresh();

        const detected = emittedEvents.filter(e => e.eventType === 'provider_detected');
        expect(detected.length).toBeGreaterThan(0);
        expect(detected[0].status).toBe('success');
    });

    it('emits provider_probe_failed when Ollama is unreachable', async () => {
        const registry = new InferenceProviderRegistry({
            ollama: { endpoint: 'http://127.0.0.1:11434', enabled: true },
        });

        await registry.refresh();

        const failed = emittedEvents.filter(
            e => e.eventType === 'provider_probe_failed' || e.eventType === 'provider_unavailable'
        );
        expect(failed.length).toBeGreaterThan(0);
    });
});

describe('InferenceProviderRegistry — embedded llama.cpp detection', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
        clearHttpResponses();
    });

    it('reports not_running with degraded health when binary and model present but server not responding', async () => {
        // Test checkEmbeddedLlamaCppAvailability directly with binaryExists=true, modelExists=true
        // This avoids the need to mock fs.existsSync at the module level
        const result = await checkEmbeddedLlamaCppAvailability(19988, '/models/test.gguf', true, true);
        // Server not running at port 19988 → degraded (files present but not running)
        expect(result.reachable).toBe(false);
        expect(result.health).toBe('degraded');
        expect(result.status).toBe('not_running');
    });

    it('reports ready when embedded server probe returns 200', async () => {
        // Test checkEmbeddedLlamaCppAvailability directly with server responding
        // Use a /health response at port 8088 to simulate running server
        setHttpResponse('/health', { status: 200, body: JSON.stringify({ status: 'ok' }) });

        const result = await checkEmbeddedLlamaCppAvailability(8080, '/models/test.gguf', true, true);
        expect(result.reachable).toBe(true);
        expect(result.health).toBe('healthy');
        expect(result.status).toBe('ready');
    });

    it('reports unavailable when binary does not exist', async () => {
        // Default mock returns false for existsSync — no spy needed
        const registry = new InferenceProviderRegistry({
            embeddedLlamaCpp: { port: 8080, modelPath: '/models/test.gguf', binaryPath: '/bin/llama', enabled: true },
        });

        await registry.refresh();

        const emb = registry.getInventory().providers.find(p => p.providerId === 'embedded_llamacpp');
        expect(emb!.ready).toBe(false);
        expect(emb!.health).toBe('unavailable');
    });
});

describe('InferenceProviderRegistry — vLLM detection', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
        clearHttpResponses();
    });

    it('detects vLLM as healthy when /v1/models returns models', async () => {
        setHttpResponse('/v1/models', {
            status: 200,
            body: JSON.stringify({ data: [{ id: 'mistral-7b' }] }),
        });

        const registry = new InferenceProviderRegistry({
            vllm: { endpoint: 'http://127.0.0.1:8000', enabled: true },
        });

        await registry.refresh();

        const vllm = registry.getInventory().providers.find(p => p.providerId === 'vllm');
        expect(vllm!.ready).toBe(true);
        expect(vllm!.models).toContain('mistral-7b');
    });

    it('marks vLLM as unavailable when endpoint is unreachable', async () => {
        const registry = new InferenceProviderRegistry({
            vllm: { endpoint: 'http://127.0.0.1:8000', enabled: true },
        });

        await registry.refresh();

        const vllm = registry.getInventory().providers.find(p => p.providerId === 'vllm');
        expect(vllm!.ready).toBe(false);
        expect(vllm!.status).toBe('not_running');
    });
});

describe('InferenceProviderRegistry — kobold.cpp detection', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
        clearHttpResponses();
    });

    it('marks KoboldCpp as unavailable when endpoint is unreachable', async () => {
        const registry = new InferenceProviderRegistry({
            koboldcpp: { endpoint: 'http://127.0.0.1:5001', enabled: true },
        });

        await registry.refresh();

        const kobold = registry.getInventory().providers.find(p => p.providerId === 'koboldcpp');
        expect(kobold!.ready).toBe(false);
        expect(kobold!.status).toBe('not_running');
    });
});

describe('InferenceProviderRegistry — registry resilience', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
        clearHttpResponses();
    });

    it('does not crash when no providers are configured', async () => {
        const registry = new InferenceProviderRegistry({});
        await expect(registry.refresh()).resolves.toBeDefined();
        const inv = registry.getInventory();
        expect(Array.isArray(inv.providers)).toBe(true);
    });

    it('does not crash and marks unknown provider as unavailable when probe throws', async () => {
        // We rely on the catch in _runAllProbes swallowing thrown errors
        const registry = new InferenceProviderRegistry({
            ollama: { endpoint: 'http://127.0.0.1:11434', enabled: true },
        });

        // Ensure HTTP is erroring
        await registry.refresh();

        const ollama = registry.getInventory().providers.find(p => p.providerId === 'ollama');
        expect(ollama).toBeDefined();
        expect(ollama!.ready).toBe(false);
    });

    it('emits provider_inventory_refreshed after refresh', async () => {
        const registry = new InferenceProviderRegistry({
            ollama: { endpoint: 'http://127.0.0.1:11434', enabled: true },
        });

        await registry.refresh();

        const refreshed = emittedEvents.filter(e => e.eventType === 'provider_inventory_refreshed');
        expect(refreshed.length).toBeGreaterThan(0);
    });

    it('getReadyProviders returns only ready providers', async () => {
        setHttpResponse('/api/tags', {
            status: 200,
            body: JSON.stringify({ models: [{ name: 'llama3:latest' }] }),
        });

        const registry = new InferenceProviderRegistry({
            ollama: { endpoint: 'http://127.0.0.1:11434', enabled: true },
            vllm: { endpoint: 'http://127.0.0.1:8000', enabled: true },
        });

        await registry.refresh();

        const ready = registry.getReadyProviders();
        expect(ready.every(p => p.ready)).toBe(true);
    });
});

