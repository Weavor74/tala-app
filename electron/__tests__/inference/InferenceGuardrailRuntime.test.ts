import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InferenceService } from '../../services/InferenceService';
import type { IBrain } from '../../brains/IBrain';
import type { InferenceProviderDescriptor, StreamInferenceRequest } from '../../../shared/inferenceProviderTypes';

vi.mock('../../services/TelemetryService', () => ({
    telemetry: {
        emit: vi.fn(),
        operational: vi.fn(),
        audit: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('../../services/reflection/ReflectionEngine', () => ({
    ReflectionEngine: { reportSignal: vi.fn() },
}));

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

vi.mock('../../services/LocalInferenceOrchestrator', () => ({
    LocalInferenceOrchestrator: vi.fn().mockImplementation(function (this: any) {
        this.start = vi.fn();
        this.stop = vi.fn();
        this.isReady = vi.fn(() => false);
        this.getState = vi.fn(() => ({ status: 'disabled' }));
        this.shutdown = vi.fn();
    }),
}));

function provider(id: string): InferenceProviderDescriptor {
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
        capabilities: { streaming: true, toolCalls: false, vision: false, embeddings: false },
        models: ['llama3:latest'],
        preferredModel: 'llama3',
    };
}

function req(overrides: Partial<StreamInferenceRequest> = {}): StreamInferenceRequest {
    return {
        provider: provider('primary'),
        turnId: 'turn-1',
        sessionId: 'session-1',
        fallbackAllowed: false,
        ...overrides,
    };
}

describe('InferenceService runtime guardrail integration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('retries pre-stream-open failures on the same provider', async () => {
        const service = new InferenceService();
        let calls = 0;
        const brain: IBrain = {
            id: 'b',
            ping: async () => true,
            configure: () => {},
            generateResponse: async () => ({ content: '' }),
            streamResponse: async (_m, _s, onToken) => {
                calls++;
                if (calls === 1) throw new Error('ECONNRESET');
                onToken('ok');
                return { content: 'ok' };
            },
        };

        const result = await service.executeStream(
            brain,
            [],
            '',
            () => {},
            req(),
        );

        expect(result.success).toBe(true);
        expect(result.providerId).toBe('primary');
        expect(result.attemptedProviders).toEqual(['primary']);
        expect(calls).toBe(2);
    });

    it('does not retry after mid-stream failure (no duplicate partial stream)', async () => {
        const service = new InferenceService();
        let calls = 0;
        const brain: IBrain = {
            id: 'b',
            ping: async () => true,
            configure: () => {},
            generateResponse: async () => ({ content: '' }),
            streamResponse: async (_m, _s, onToken) => {
                calls++;
                onToken('partial');
                throw new Error('mid-stream failure');
            },
        };

        const result = await service.executeStream(
            brain,
            [],
            '',
            () => {},
            req({ fallbackAllowed: true, fallbackProviders: [provider('fallback')] }),
        );

        expect(result.success).toBe(false);
        expect(result.isPartial).toBe(true);
        expect(result.providerId).toBe('primary');
        expect(result.attemptedProviders).toEqual(['primary']);
        expect(calls).toBe(1);
    });
});
