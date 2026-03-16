/**
 * Canonical Streaming Tests — Phase 1B Streaming Hardening
 *
 * Validates InferenceService.executeStream() lifecycle behavior:
 * - Successful stream emits stream_opened then stream_completed
 * - Stream failure before first token triggers fallback when allowed
 * - Stream failure after partial output does NOT retry
 * - Timeout emits inference_timeout and calls ReflectionEngine.reportSignal
 * - Successful stream does not create failure signals in ReflectionEngine
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InferenceService } from '../../services/InferenceService';
import type { IBrain, BrainResponse } from '../../brains/IBrain';
import type {
    InferenceProviderDescriptor,
    StreamInferenceRequest,
} from '../../../shared/inferenceProviderTypes';

// ─── Telemetry mock ───────────────────────────────────────────────────────────

const emittedEvents: Array<{ eventType: string; status: string; summary: string }> = [];

vi.mock('../../services/TelemetryService', () => ({
    telemetry: {
        emit: (_s: string, et: string, _sv: string, _a: string, summary: string, st: string) => {
            emittedEvents.push({ eventType: et, status: st, summary });
        },
        operational: (_s: string, et: string, _sv: string, _a: string, summary: string, st: string) => {
            emittedEvents.push({ eventType: et, status: st, summary });
        },
        audit: (_s: string, et: string, _a: string, summary: string, st: string) => {
            emittedEvents.push({ eventType: et, status: st, summary: summary ?? '' });
        },
        debug: (_s: string, et: string, _a: string, summary: string) => {
            emittedEvents.push({ eventType: et, status: 'debug', summary: summary ?? '' });
        },
    },
}));

// ─── ReflectionEngine mock ────────────────────────────────────────────────────

const reportedSignals: Array<{ category: string; description: string }> = [];

vi.mock('../../services/reflection/ReflectionEngine', () => ({
    ReflectionEngine: {
        reportSignal: (signal: { category: string; description: string }) => {
            reportedSignals.push({ category: signal.category, description: signal.description });
        },
    },
}));

// ─── Electron / fs mocks (InferenceService uses app.getPath indirectly) ──────

vi.mock('electron', () => ({
    app: {
        getPath: () => '/tmp/tala-test',
        getAppPath: () => '/tmp/tala-test',
        isPackaged: false,
    },
    WebContents: {},
}));

vi.mock('../../services/LocalEngineService', () => ({
    LocalEngineService: vi.fn().mockImplementation(function (this: any) {
        this.start = vi.fn();
        this.stop = vi.fn();
        this.extinguish = vi.fn();
        this.getStatus = vi.fn(() => 'stopped');
        this.isRunning = vi.fn(() => false);
    }),
}));

vi.mock('../../services/LocalInferenceManager', () => ({
    LocalInferenceManager: vi.fn().mockImplementation(function (this: any) {
        this.start = vi.fn();
        this.stop = vi.fn();
        this.isReady = vi.fn(() => false);
        this.getState = vi.fn(() => ({ status: 'disabled' }));
        this.shutdown = vi.fn();
    }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProvider(id = 'ollama-test'): InferenceProviderDescriptor {
    return {
        providerId: id,
        displayName: id,
        providerType: 'ollama',
        scope: 'local',
        transport: 'http_ollama',
        endpoint: 'http://127.0.0.1:11434',
        configured: true,
        detected: true,
        ready: true,
        health: 'healthy',
        status: 'ready',
        priority: 10,
        preferredModel: 'llama3',
    };
}

function makeBrain(streamImpl: IBrain['streamResponse']): IBrain {
    return {
        id: 'test-brain',
        ping: async () => true,
        generateResponse: async () => ({ content: '' }),
        streamResponse: streamImpl,
    };
}

function makeRequest(
    provider = makeProvider(),
    overrides: Partial<StreamInferenceRequest> = {}
): StreamInferenceRequest {
    return {
        provider,
        turnId: 'turn-001',
        sessionId: 'session-001',
        fallbackAllowed: false,
        ...overrides,
    };
}

function makeService(): InferenceService {
    return new InferenceService();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('InferenceService.executeStream()', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
        reportedSignals.length = 0;
    });

    it('successful stream emits inference_started, stream_opened, stream_completed, inference_completed', async () => {
        const service = makeService();
        const tokens: string[] = [];

        const brain = makeBrain(async (_msgs, _sys, onChunk, _signal, _tools, _opts) => {
            onChunk('hello');
            onChunk(' world');
            return { content: 'hello world' } satisfies BrainResponse;
        });

        const result = await service.executeStream(
            brain,
            [{ role: 'user', content: 'hi' }],
            'You are helpful',
            (chunk) => tokens.push(chunk),
            makeRequest()
        );

        expect(result.success).toBe(true);
        expect(result.streamStatus).toBe('completed');
        expect(result.isPartial).toBe(false);
        expect(result.content).toBe('hello world');
        expect(tokens).toEqual(['hello', ' world']);

        const eventTypes = emittedEvents.map((e) => e.eventType);
        expect(eventTypes).toContain('inference_started');
        expect(eventTypes).toContain('stream_opened');
        expect(eventTypes).toContain('stream_completed');
        expect(eventTypes).toContain('inference_completed');
        // stream_opened must come before stream_completed
        expect(eventTypes.indexOf('stream_opened')).toBeLessThan(eventTypes.indexOf('stream_completed'));
    });

    it('successful stream does not create failure signals in ReflectionEngine', async () => {
        const service = makeService();

        const brain = makeBrain(async (_msgs, _sys, onChunk) => {
            onChunk('ok');
            return { content: 'ok' };
        });

        await service.executeStream(brain, [], '', () => {}, makeRequest());

        expect(reportedSignals).toHaveLength(0);
    });

    it('stream failure before first token triggers fallback when fallbackAllowed=true', async () => {
        const service = makeService();
        const primaryProvider = makeProvider('primary');
        const fallbackProvider = makeProvider('fallback');

        let callCount = 0;
        const brain = makeBrain(async (_msgs, _sys, onChunk) => {
            callCount++;
            if (callCount === 1) {
                throw new Error('connection refused');
            }
            onChunk('fallback token');
            return { content: 'fallback token' };
        });

        const result = await service.executeStream(
            brain,
            [],
            '',
            () => {},
            makeRequest(primaryProvider, {
                fallbackAllowed: true,
                fallbackProviders: [fallbackProvider],
            })
        );

        expect(result.success).toBe(true);
        expect(result.fallbackApplied).toBe(true);
        expect(result.providerId).toBe('fallback');
        expect(result.attemptedProviders).toEqual(['primary', 'fallback']);

        // A degraded_fallback signal must be reported
        expect(reportedSignals.some((s) => s.category === 'degraded_fallback')).toBe(true);

        const eventTypes = emittedEvents.map((e) => e.eventType);
        expect(eventTypes).toContain('provider_fallback_applied');
    });

    it('stream failure after partial output does NOT retry, returns isPartial=true', async () => {
        const service = makeService();
        const primaryProvider = makeProvider('primary');
        const fallbackProvider = makeProvider('fallback');

        let tokensSent = 0;
        const brain = makeBrain(async (_msgs, _sys, onChunk) => {
            onChunk('partial');
            tokensSent++;
            throw new Error('mid-stream disconnect');
        });

        const result = await service.executeStream(
            brain,
            [],
            '',
            () => {},
            makeRequest(primaryProvider, {
                fallbackAllowed: true,
                fallbackProviders: [fallbackProvider],
            })
        );

        expect(result.success).toBe(false);
        expect(result.isPartial).toBe(true);
        expect(result.streamStatus).toBe('failed');
        expect(result.providerId).toBe('primary');
        // Fallback must NOT have been attempted after partial output
        expect(result.attemptedProviders).toEqual(['primary']);
        expect(result.fallbackApplied).toBe(false);
        expect(result.errorCode).toBe('partial_stream');

        const eventTypes = emittedEvents.map((e) => e.eventType);
        expect(eventTypes).toContain('stream_aborted');
        expect(reportedSignals.some((s) => s.category === 'inference_failure')).toBe(true);
    });

    it('timeout error emits inference_timeout and calls ReflectionEngine.reportSignal with inference_timeout', async () => {
        const service = makeService();

        const brain = makeBrain(async () => {
            const err = new Error('Request timeout exceeded');
            throw err;
        });

        const result = await service.executeStream(brain, [], '', () => {}, makeRequest());

        expect(result.success).toBe(false);
        expect(result.streamStatus).toBe('timeout');
        expect(result.errorCode).toBe('timeout');

        const eventTypes = emittedEvents.map((e) => e.eventType);
        expect(eventTypes).toContain('inference_timeout');

        expect(reportedSignals.some((s) => s.category === 'inference_timeout')).toBe(true);
    });

    it('abort signal sets streamStatus=aborted', async () => {
        const service = makeService();
        const controller = new AbortController();

        const brain = makeBrain(async () => {
            controller.abort();
            const err = new Error('Aborted');
            (err as any).name = 'AbortError';
            throw err;
        });

        const result = await service.executeStream(
            brain,
            [],
            '',
            () => {},
            makeRequest(makeProvider(), { signal: controller.signal })
        );

        expect(result.success).toBe(false);
        expect(result.streamStatus).toBe('aborted');
    });

    it('all providers exhausted emits stream_aborted and reports inference_failure signal', async () => {
        const service = makeService();

        const brain = makeBrain(async () => {
            throw new Error('connection refused');
        });

        const result = await service.executeStream(brain, [], '', () => {}, makeRequest());

        expect(result.success).toBe(false);
        expect(result.streamStatus).toBe('failed');

        const eventTypes = emittedEvents.map((e) => e.eventType);
        expect(eventTypes).toContain('stream_aborted');
        expect(eventTypes).toContain('inference_failed');

        expect(
            reportedSignals.some(
                (s) => s.category === 'inference_failure' || s.category === 'degraded_fallback'
            )
        ).toBe(true);
    });

    it('result carries provider metadata from the descriptor', async () => {
        const service = makeService();
        const provider = makeProvider('my-ollama');

        const brain = makeBrain(async (_m, _s, onChunk) => {
            onChunk('x');
            return { content: 'x', metadata: { usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } } };
        });

        const result = await service.executeStream(brain, [], '', () => {}, makeRequest(provider));

        expect(result.providerId).toBe('my-ollama');
        expect(result.providerType).toBe('ollama');
        expect(result.modelName).toBe('llama3');
        expect(result.turnId).toBe('turn-001');
        expect(result.promptTokens).toBe(5);
        expect(result.completionTokens).toBe(10);
    });
});
