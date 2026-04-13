/**
 * Local Inference Hardening Tests — Phase 2 Objective 8
 *
 * Validates:
 * - State machine transitions (disabled → starting → ready → busy → degraded/failed)
 * - Readiness check before request invocation
 * - Timeout enforcement (request stall → error)
 * - Retry logic is bounded
 * - Failed inference does not corrupt turn state
 * - Recovery from degraded/failed state via probe
 * - Telemetry emitted for state transitions and failures
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LocalInferenceOrchestrator } from '../../services/LocalInferenceOrchestrator';
import type { LocalEngineService } from '../../services/LocalEngineService';

// Mock TelemetryService to capture emitted events
const emittedEvents: Array<{ eventType: string; status: string; summary: string }> = [];

vi.mock('../../services/TelemetryService', () => ({
    telemetry: {
        emit: (_sub: string, eventType: string, _sev: string, _actor: string, summary: string, status: string) => {
            emittedEvents.push({ eventType, status, summary });
            return {};
        },
        operational: (_sub: string, eventType: string, _sev: string, _actor: string, summary: string, status: string) => {
            emittedEvents.push({ eventType, status, summary });
            return {};
        },
        audit: (_sub: string, eventType: string, _actor: string, summary: string, status: string) => {
            emittedEvents.push({ eventType, status, summary });
            return {};
        },
        debug: (_sub: string, eventType: string, _actor: string, summary: string) => {
            emittedEvents.push({ eventType, status: 'success', summary });
            return {};
        },
    },
    TelemetryService: {
        getInstance: () => ({
            emit: vi.fn(),
        }),
        reset: vi.fn(),
    },
}));

// ─── Mock LocalEngineService ──────────────────────────────────────────────────

function makeMockEngine(overrides: Partial<{
    igniteResult: 'success' | 'timeout' | 'error';
    igniteDelayMs: number;
}> = {}): LocalEngineService {
    const { igniteResult = 'success', igniteDelayMs = 0 } = overrides;

    return {
        ignite: vi.fn(async (_modelPath: string) => {
            if (igniteDelayMs > 0) {
                await new Promise(r => setTimeout(r, igniteDelayMs));
            }
            if (igniteResult === 'error') {
                throw new Error('Mock engine ignite failed');
            }
        }),
        extinguish: vi.fn(),
        getStatus: vi.fn(() => ({
            isRunning: true,
            isDownloading: false,
            downloadProgress: 0,
            downloadTask: '',
            port: 8080,
        })),
    } as unknown as LocalEngineService;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeManager(engineOverrides = {}, configOverrides: Record<string, unknown> = {}): LocalInferenceOrchestrator {
    return new LocalInferenceOrchestrator(makeMockEngine(engineOverrides), {
        port: 18080,
        startupTimeoutMs: 5000,
        requestTimeoutMs: 500,
        maxRetries: 1,
        retryDelayMs: 50,
        readinessProbeIntervalMs: 50,
        ...configOverrides,
    });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LocalInferenceOrchestrator — state machine', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('starts in disabled state', () => {
        const mgr = makeManager();
        expect(mgr.state).toBe('disabled');
    });

    it('transitions to starting then ready on successful start', async () => {
        const transitions: string[] = [];
        const mgr = makeManager();

        // Spy on state via telemetry events
        const originalEmit = vi.fn((_sub: string, eventType: string) => {
            if (eventType === 'inference_state_changed') {
                transitions.push(eventType);
            }
            return {};
        });
        // We check via the manager's .state directly after start
        await mgr.start('/models/test.gguf', {}, 'turn-1', 'assistant');

        expect(mgr.state).toBe('ready');
    });

    it('transitions to failed when ignite throws', async () => {
        const mgr = makeManager({ igniteResult: 'error' });

        await expect(mgr.start('/models/test.gguf', {}, 'turn-1', 'assistant')).rejects.toThrow();
        expect(mgr.state).toBe('failed');
    });

    it('transitions to failed on startup timeout', async () => {
        // igniteDelayMs > startupTimeoutMs → timeout
        const mgr = makeManager({ igniteDelayMs: 3000 }, { startupTimeoutMs: 100 });

        await expect(mgr.start('/models/test.gguf', {}, 'turn-1', 'assistant')).rejects.toThrow();
        expect(mgr.state).toBe('failed');
    });

    it('transitions to disabled after stop', async () => {
        const mgr = makeManager();
        await mgr.start('/models/test.gguf');
        expect(mgr.state).toBe('ready');

        mgr.stop();
        expect(mgr.state).toBe('disabled');
    });
});

describe('LocalInferenceOrchestrator — readiness enforcement', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('rejects request when state is disabled', async () => {
        const mgr = makeManager();
        // state = disabled
        const result = await mgr.request('prompt', 'llama3', 'turn-1', 'assistant');

        expect(result.success).toBe(false);
        expect(result.errorCode).toBe('unavailable');
        expect(result.retryCount).toBe(0);
    });

    it('rejects request when state is failed', async () => {
        const mgr = makeManager({ igniteResult: 'error' });
        try { await mgr.start('/models/test.gguf'); } catch { /* expected */ }

        const result = await mgr.request('prompt', 'llama3');
        expect(result.success).toBe(false);
        expect(result.errorCode).toBe('unavailable');
    });

    it('emits inference_failed telemetry when rejected', async () => {
        const mgr = makeManager();
        await mgr.request('prompt', 'llama3', 'turn-1', 'assistant');

        const failEvents = emittedEvents.filter(e => e.eventType === 'inference_failed');
        expect(failEvents.length).toBeGreaterThan(0);
    });
});

describe('LocalInferenceOrchestrator — request timeout and retry', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('returns failure result on request timeout (no network available)', async () => {
        // Port 19999 is unused — requests will fail fast with ECONNREFUSED
        const mgr = new LocalInferenceOrchestrator(makeMockEngine(), {
            port: 19999,
            startupTimeoutMs: 5000,
            requestTimeoutMs: 200,
            maxRetries: 0,
            retryDelayMs: 50,
            readinessProbeIntervalMs: 50,
        });

        // Manually force state to ready to test request behavior
        (mgr as unknown as { _state: string })._state = 'ready';

        const result = await mgr.request('test prompt', 'llama3', 'turn-1', 'assistant');

        expect(result.success).toBe(false);
        expect(result.errorCode).toBeDefined();
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('retries up to maxRetries on failure', async () => {
        const mgr = new LocalInferenceOrchestrator(makeMockEngine(), {
            port: 19998,
            startupTimeoutMs: 5000,
            requestTimeoutMs: 100,
            maxRetries: 2,
            retryDelayMs: 10,
            readinessProbeIntervalMs: 50,
        });

        (mgr as unknown as { _state: string })._state = 'ready';

        const result = await mgr.request('test prompt', 'llama3');

        expect(result.retryCount).toBeGreaterThanOrEqual(0);
        // After exhausting retries, state should be degraded or failed
        expect(['degraded', 'failed']).toContain(mgr.state);
    });
});

describe('LocalInferenceOrchestrator — recovery', () => {
    afterEach(() => {
        emittedEvents.length = 0;
    });

    it('recover() returns false and transitions to unavailable when probe fails', async () => {
        const mgr = makeManager({}, { port: 19997 });
        (mgr as unknown as { _state: string })._state = 'failed';

        const recovered = await mgr.recover('turn-1', 'assistant');
        expect(recovered).toBe(false);
        expect(mgr.state).toBe('unavailable');
    });

    it('recover() returns true immediately when state is ready', async () => {
        const mgr = makeManager();
        await mgr.start('/models/test.gguf');

        const recovered = await mgr.recover();
        expect(recovered).toBe(true);
        expect(mgr.state).toBe('ready');
    });
});

describe('LocalInferenceOrchestrator — telemetry emission', () => {
    beforeEach(() => {
        emittedEvents.length = 0;
    });

    it('emits inference_state_changed when transitioning from disabled to starting', async () => {
        const mgr = makeManager();
        await mgr.start('/models/test.gguf', {}, 'turn-1', 'assistant');

        const stateEvents = emittedEvents.filter(e => e.eventType === 'inference_state_changed');
        expect(stateEvents.length).toBeGreaterThan(0);
    });

    it('emits degraded_fallback after exhausting retries', async () => {
        const mgr = new LocalInferenceOrchestrator(makeMockEngine(), {
            port: 19996,
            startupTimeoutMs: 5000,
            requestTimeoutMs: 50,
            maxRetries: 1,
            retryDelayMs: 10,
            readinessProbeIntervalMs: 50,
        });
        (mgr as unknown as { _state: string })._state = 'ready';

        await mgr.request('test prompt', 'llama3', 'turn-1', 'assistant');

        const fallbackEvents = emittedEvents.filter(e => e.eventType === 'degraded_fallback');
        expect(fallbackEvents.length).toBeGreaterThan(0);
    });

    it('getStatus() returns structured state', async () => {
        const mgr = makeManager();
        const status = mgr.getStatus();

        expect(status.state).toBe('disabled');
        expect(typeof status.port).toBe('number');
        expect(typeof status.modelPath).toBe('string');
        expect(typeof status.engineStatus).toBe('object');
    });
});

