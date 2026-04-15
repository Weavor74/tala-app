import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InferenceProviderRegistry } from '../electron/services/inference/InferenceProviderRegistry';
import { ProviderSelectionService } from '../electron/services/inference/ProviderSelectionService';

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: vi.fn(() => false),
    };
});

vi.mock('../electron/services/TelemetryService', () => ({
    telemetry: {
        emit: vi.fn(),
        operational: vi.fn(),
        audit: vi.fn(),
        debug: vi.fn(),
    },
}));

const httpResponses: Record<string, { status: number; body: string } | 'error'> = {};

function setHttpResponse(urlFragment: string, response: { status: number; body: string } | 'error'): void {
    httpResponses[urlFragment] = response;
}

function clearHttpResponses(): void {
    for (const key of Object.keys(httpResponses)) delete httpResponses[key];
}

vi.mock('http', () => {
    function makeRequest(url: string, _opts: any, cb?: (res: any) => void) {
        const callbackFn = typeof _opts === 'function' ? _opts : cb;
        const key = Object.keys(httpResponses).find((k) => url.includes(k));
        const response = key ? httpResponses[key] : 'error';

        if (response === 'error') {
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
            resume: () => undefined,
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

describe('Inference partial assets startup integration', () => {
    beforeEach(() => {
        clearHttpResponses();
    });

    afterEach(() => {
        clearHttpResponses();
    });

    it('ollama absent plus incomplete embedded fallback never reports fake local readiness', async () => {
        const registry = new InferenceProviderRegistry({
            ollama: { endpoint: 'http://127.0.0.1:11434', enabled: true },
            embeddedLlamaCpp: {
                enabled: true,
                port: 8080,
                modelPath: '/models/missing.gguf',
                binaryPath: '/bin/missing-llama',
            },
            cloud: { endpoint: 'https://api.example.com', enabled: false },
        });
        const inventory = await registry.refresh('turn-partial-1', 'assistant');
        const selection = new ProviderSelectionService(registry).select({
            mode: 'local-only',
            fallbackAllowed: true,
        });
        const ollama = inventory.providers.find((p) => p.providerId === 'ollama');
        const embedded = inventory.providers.find((p) => p.providerId === 'embedded_llamacpp');

        expect(ollama?.detected).toBe(false);
        expect(ollama?.ready).toBe(false);
        expect(embedded?.health).toBe('unavailable');
        expect(selection.success).toBe(false);
        expect(selection.failure?.code).toBe('no_provider');
    });

    it('service detected but required model missing resolves deterministically to fallback model', async () => {
        setHttpResponse('/v1/models', {
            status: 200,
            body: JSON.stringify({ data: [{ id: 'model-other' }] }),
        });
        const registry = new InferenceProviderRegistry({
            vllm: { endpoint: 'http://127.0.0.1:8000', enabled: true },
        });
        await registry.refresh('turn-partial-2', 'assistant');

        const selection = new ProviderSelectionService(registry).select({
            mode: 'auto',
            fallbackAllowed: true,
            preferredProviderId: 'vllm',
            preferredModelId: 'required-model',
        });

        expect(selection.success).toBe(true);
        expect(selection.selectedProvider?.providerId).toBe('vllm');
        expect(selection.resolvedModel).toBe('model-other');
    });

    it('corrupt embedded metadata does not fake unavailable provider to ready', async () => {
        const registry = new InferenceProviderRegistry({
            embeddedVllm: { port: 8000, modelId: 'embedded-required', enabled: true },
        });
        setHttpResponse('/v1/models', {
            status: 200,
            body: '{bad-json',
        });

        const inventory = await registry.refresh('turn-partial-3', 'assistant');
        const provider = inventory.providers.find((p) => p.providerId === 'embedded_vllm');

        expect(provider?.detected).toBe(true);
        expect(provider?.ready).toBe(true);
        expect(provider?.models).toContain('embedded-required');
    });

    it('partial local assets with cloud disabled keep startup in safe degraded state', async () => {
        const registry = new InferenceProviderRegistry({
            embeddedVllm: { port: 8000, modelId: 'embedded-required', enabled: true },
            embeddedLlamaCpp: { port: 8080, modelPath: '/models/missing.gguf', binaryPath: '/bin/missing', enabled: true },
            cloud: { endpoint: 'https://api.example.com', enabled: false },
        });

        const inventory = await registry.refresh('turn-partial-4', 'assistant');
        const selection = new ProviderSelectionService(registry).select({
            mode: 'local-only',
            fallbackAllowed: true,
        });

        expect(inventory.providers.some((p) => p.ready)).toBe(false);
        expect(selection.success).toBe(false);
        expect(selection.failure?.fallbackExhausted).toBe(true);
    });

    it('restored local assets recover provider readiness deterministically on next refresh', async () => {
        const fs = await import('fs');
        const existsSpy = vi.spyOn(fs, 'existsSync');
        existsSpy.mockImplementation(() => false);

        const registry = new InferenceProviderRegistry({
            embeddedLlamaCpp: { port: 8080, modelPath: '/models/restored.gguf', binaryPath: '/bin/restored', enabled: true },
        });
        let inventory = await registry.refresh('turn-partial-5a', 'assistant');
        const first = inventory.providers.find((p) => p.providerId === 'embedded_llamacpp');
        expect(first?.ready).toBe(false);

        existsSpy.mockImplementation((candidate: any) => String(candidate).includes('/models/restored.gguf') || String(candidate).includes('/bin/restored'));
        setHttpResponse('/health', { status: 200, body: '{"status":"ok"}' });
        setHttpResponse('/v1/models', { status: 200, body: JSON.stringify({ data: [{ id: 'restored-model' }] }) });

        inventory = await registry.refresh('turn-partial-5b', 'assistant');
        const second = inventory.providers.find((p) => p.providerId === 'embedded_llamacpp');
        expect(second?.ready).toBe(true);
        expect(second?.models).toContain('restored-model');

        existsSpy.mockRestore();
    });
});

