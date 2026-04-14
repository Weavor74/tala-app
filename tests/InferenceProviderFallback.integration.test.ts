import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IBrain, BrainResponse, ChatMessage } from '../electron/brains/IBrain';
import { ProviderSelectionService } from '../electron/services/inference/ProviderSelectionService';
import { InferenceService } from '../electron/services/InferenceService';
import { promptProfileSelector } from '../electron/services/cognitive/PromptProfileSelector';
import type {
    InferenceProviderDescriptor,
    InferenceProviderInventory,
} from '../shared/inferenceProviderTypes';

vi.mock('../electron/services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn(),
        audit: vi.fn(),
    },
}));

vi.mock('../electron/services/reflection/ReflectionEngine', () => ({
    ReflectionEngine: {
        reportSignal: vi.fn(),
    },
}));

vi.mock('../electron/services/InferenceDiagnosticsService', () => ({
    inferenceDiagnostics: {
        recordStreamStart: vi.fn(),
        recordStreamActive: vi.fn(),
        recordStreamResult: vi.fn(),
        recordProviderSelected: vi.fn(),
        updateFromInventory: vi.fn(),
    },
}));

vi.mock('../electron/services/policy/PolicyEnforcement', () => ({
    enforceSideEffectWithGuardrails: vi.fn().mockResolvedValue(undefined),
}));

function makeProvider(overrides: Partial<InferenceProviderDescriptor> = {}): InferenceProviderDescriptor {
    return {
        providerId: 'ollama',
        displayName: 'Ollama',
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
        capabilities: {
            streaming: true,
            toolCalls: true,
            vision: false,
            embeddings: true,
        },
        models: ['qwen2.5:3b'],
        preferredModel: 'qwen2.5:3b',
        ...overrides,
    };
}

function makeInventory(
    providers: InferenceProviderDescriptor[],
    selectedProviderId?: string,
): InferenceProviderInventory {
    return {
        providers,
        selectedProviderId,
        lastRefreshed: '2026-04-14T00:00:00.000Z',
        refreshing: false,
    };
}

function makeSelectionService(
    providers: InferenceProviderDescriptor[],
    selectedProviderId?: string,
): ProviderSelectionService {
    const inventory = makeInventory(providers, selectedProviderId);
    const fakeRegistry = {
        getInventory: () => inventory,
        getSelectedProviderId: () => inventory.selectedProviderId,
    };
    return new ProviderSelectionService(fakeRegistry as any);
}

type BrainStep =
    | { kind: 'success'; content: string; toolCalls?: any[] }
    | { kind: 'throw'; error: Error }
    | { kind: 'hang' }
    | { kind: 'malformed' };

function makeBrainFromSteps(steps: BrainStep[]) {
    const streamResponse = vi.fn(async (_messages: ChatMessage[], _systemPrompt: string, onChunk: (chunk: string) => void): Promise<BrainResponse> => {
        const step = steps.shift();
        if (!step) {
            onChunk('ok');
            return {
                content: 'ok',
                metadata: { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
            };
        }

        if (step.kind === 'throw') {
            throw step.error;
        }
        if (step.kind === 'hang') {
            return await new Promise<BrainResponse>(() => {});
        }
        if (step.kind === 'malformed') {
            return {} as BrainResponse;
        }

        onChunk(step.content);
        return {
            content: step.content,
            toolCalls: step.toolCalls as any,
            metadata: { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        };
    });

    const brain: IBrain = {
        id: 'test-brain',
        configure: vi.fn(),
        ping: vi.fn().mockResolvedValue(true),
        generateResponse: vi.fn(),
        streamResponse,
    };

    return { brain, streamResponse };
}

async function loadAgentSoulHarness(inferenceInventory: InferenceProviderInventory) {
    vi.resetModules();

    vi.doMock('electron', () => ({
        app: {
            getAppPath: () => 'D:/src/client1/tala-app',
        },
    }));

    vi.doMock('../electron/services/SettingsManager', () => ({
        loadSettings: vi.fn().mockReturnValue({
            inference: { mode: 'auto', instances: [] },
            memory: { integrityMode: 'balanced' },
        }),
        getActiveMode: vi.fn().mockReturnValue('hybrid'),
        saveSettings: vi.fn(),
    }));

    vi.doMock('../electron/services/db/initMemoryStore', () => ({
        getCanonicalMemoryRepository: () => ({ kind: 'canonical' }),
        getLastDbHealth: () => ({
            reachable: true,
            authenticated: true,
            databaseExists: true,
            pgvectorInstalled: true,
            migrationsApplied: true,
        }),
        initCanonicalMemory: vi.fn().mockResolvedValue({}),
        shutdownCanonicalMemory: vi.fn().mockResolvedValue(undefined),
    }));

    const { AgentService } = await import('../electron/services/AgentService');

    const memory = {
        ignite: vi.fn().mockResolvedValue(undefined),
        getReadyStatus: vi.fn().mockReturnValue(true),
        setSubsystemAvailability: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
        getHealthStatus: vi.fn().mockReturnValue({ state: 'healthy' }),
    };

    const agent: any = Object.create(AgentService.prototype);
    Object.assign(agent, {
        isSoulReady: false,
        USE_STRUCTURED_LTMF: false,
        settingsPath: 'D:/src/client1/tala-app/data/app_settings.json',
        backup: { init: vi.fn() },
        ingestion: {
            setStructuredMode: vi.fn(),
            archiveLegacy: vi.fn().mockResolvedValue(undefined),
            startAutoIngest: vi.fn(),
        },
        rag: {
            ignite: vi.fn().mockResolvedValue(undefined),
            getReadyStatus: vi.fn().mockReturnValue(true),
            shutdown: vi.fn().mockResolvedValue(undefined),
        },
        memory,
        astro: {
            ignite: vi.fn().mockResolvedValue(undefined),
            getReadyStatus: vi.fn().mockReturnValue(true),
            shutdown: vi.fn().mockResolvedValue(undefined),
        },
        world: {
            ignite: vi.fn().mockResolvedValue(undefined),
            getReadyStatus: vi.fn().mockReturnValue(true),
            shutdown: vi.fn().mockResolvedValue(undefined),
        },
        mcpService: {
            setPythonPath: vi.fn(),
            connect: vi.fn().mockResolvedValue(true),
            isServiceCallable: vi.fn().mockReturnValue(true),
        },
        inference: {
            getProviderInventory: vi.fn().mockReturnValue(inferenceInventory),
            getLocalEngine: vi.fn().mockReturnValue({ extinguish: vi.fn().mockResolvedValue(undefined) }),
        },
        userProfile: {
            getIdentityContext: vi.fn().mockReturnValue({ userId: 'u-1', displayName: 'User One' }),
        },
        systemInfo: {
            envVariables: {},
            systemService: {
                resolveMcpPythonPath: vi.fn().mockReturnValue('python'),
                preflightCheck: vi.fn(),
                getMcpEnv: vi.fn().mockImplementation((env: Record<string, string>) => env),
            },
        },
        _wireRepairExecutor: vi.fn(),
        refreshMcpTools: vi.fn().mockResolvedValue(undefined),
        syncAstroProfiles: vi.fn().mockResolvedValue(undefined),
        syncUserProfileAstro: vi.fn().mockResolvedValue(undefined),
        docIntel: { ignite: vi.fn().mockResolvedValue(undefined) },
        stripPIIFromDebug: vi.fn().mockImplementation((err: unknown) => String(err)),
    });

    return { AgentService, agent, memory };
}

describe('Inference Provider Fallback Integration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    it('preferred provider available and selected deterministically', () => {
        const selection = makeSelectionService(
            [
                makeProvider({ providerId: 'ollama', providerType: 'ollama' }),
                makeProvider({ providerId: 'vllm', providerType: 'vllm', transport: 'http_openai_compat' }),
            ],
            'vllm',
        ).select({ fallbackAllowed: true, mode: 'auto' });

        expect(selection.success).toBe(true);
        expect(selection.selectedProvider?.providerId).toBe('vllm');
        expect(selection.fallbackApplied).toBe(false);
    });

    it('Ollama unavailable selects valid fallback without collapsing other providers', () => {
        const service = makeSelectionService([
            makeProvider({ providerId: 'ollama', providerType: 'ollama', ready: false, status: 'not_running' }),
            makeProvider({ providerId: 'vllm', providerType: 'vllm', transport: 'http_openai_compat' }),
            makeProvider({ providerId: 'llamacpp', providerType: 'llamacpp', transport: 'http_openai_compat' }),
        ]);

        const first = service.select({ mode: 'auto', fallbackAllowed: true });
        const second = service.select({ mode: 'auto', fallbackAllowed: true });

        expect(first.selectedProvider?.providerId).toBe('vllm');
        expect(second.selectedProvider?.providerId).toBe('vllm');
        expect(first).toMatchObject({
            success: true,
            attemptedProviders: ['ollama'],
            fallbackApplied: true,
        });
    });

    it('embedded/local fallback is selected before cloud when primary providers are missing', () => {
        const result = makeSelectionService([
            makeProvider({ providerId: 'ollama', providerType: 'ollama', ready: false, status: 'unavailable' }),
            makeProvider({ providerId: 'vllm', providerType: 'vllm', ready: false, status: 'unavailable', transport: 'http_openai_compat' }),
            makeProvider({ providerId: 'embedded_llamacpp', providerType: 'embedded_llamacpp', scope: 'embedded', transport: 'http_openai_compat', preferredModel: 'qwen2.5:3b' }),
            makeProvider({ providerId: 'cloud', providerType: 'cloud', scope: 'cloud', transport: 'http_openai_compat', preferredModel: 'gpt-4o' }),
        ]).select({ mode: 'auto', fallbackAllowed: true });

        expect(result.success).toBe(true);
        expect(result.selectedProvider?.providerId).toBe('embedded_llamacpp');
    });

    it('all providers unavailable returns explicit degraded selection failure', () => {
        const result = makeSelectionService([
            makeProvider({ providerId: 'ollama', providerType: 'ollama', ready: false, status: 'not_running' }),
            makeProvider({ providerId: 'cloud', providerType: 'cloud', scope: 'cloud', ready: false, status: 'not_running', transport: 'http_openai_compat' }),
        ]).select({ mode: 'auto', fallbackAllowed: true });

        expect(result.success).toBe(false);
        expect(result.failure?.code).toBe('no_provider');
        expect(result.failure?.fallbackExhausted).toBe(true);
        expect(result.reason).toContain('No viable inference provider');
    });

    it('provider timeout triggers retry on same provider when no fallback list is supplied', async () => {
        vi.useFakeTimers();
        const service = new InferenceService();
        const timeoutError = new Error('Stream open timeout after 10ms');
        timeoutError.name = 'StreamOpenTimeoutError';
        const { brain, streamResponse } = makeBrainFromSteps([
            { kind: 'throw', error: timeoutError },
            { kind: 'success', content: 'retry-ok' },
        ]);

        const provider = makeProvider({ providerId: 'ollama', providerType: 'ollama' });
        const resultPromise = service.executeStream(
            brain,
            [{ role: 'user', content: 'hello' }],
            'system',
            () => {},
            {
                provider,
                turnId: 'turn-timeout-retry',
                fallbackAllowed: false,
                openTimeoutMs: 10,
            },
        );

        await vi.advanceTimersByTimeAsync(1000);
        const result = await resultPromise;

        expect(streamResponse).toHaveBeenCalledTimes(2);
        expect(result.success).toBe(true);
        expect(result.providerId).toBe('ollama');
        expect(result.fallbackApplied).toBe(false);
    });

    it('provider hard failure triggers fallback provider and reports actual provider used', async () => {
        const service = new InferenceService();
        const { brain } = makeBrainFromSteps([
            { kind: 'throw', error: new Error('ECONNREFUSED') },
            { kind: 'success', content: 'fallback-response' },
        ]);

        const primary = makeProvider({ providerId: 'ollama', providerType: 'ollama' });
        const fallback = makeProvider({ providerId: 'embedded_llamacpp', providerType: 'embedded_llamacpp', scope: 'embedded', transport: 'http_openai_compat' });

        const result = await service.executeStream(
            brain,
            [{ role: 'user', content: 'hello' }],
            'system',
            () => {},
            {
                provider: primary,
                turnId: 'turn-hard-fallback',
                fallbackAllowed: true,
                fallbackProviders: [fallback],
            },
        );

        expect(result.success).toBe(true);
        expect(result.fallbackApplied).toBe(true);
        expect(result.attemptedProviders).toEqual(['ollama', 'embedded_llamacpp']);
        expect(result.providerId).toBe('embedded_llamacpp');
        expect(result.content).toBe('fallback-response');
    });

    it('timeout and hard-failure terminal paths remain distinct when fallback is exhausted', async () => {
        const service = new InferenceService();

        const timeoutErr = new Error('Stream open timeout after 15ms');
        timeoutErr.name = 'StreamOpenTimeoutError';
        const timeoutBrain = makeBrainFromSteps([
            { kind: 'throw', error: timeoutErr },
            { kind: 'throw', error: timeoutErr },
        ]).brain;
        const timeoutResult = await service.executeStream(
            timeoutBrain,
            [{ role: 'user', content: 'timeout' }],
            'system',
            () => {},
            {
                provider: makeProvider({ providerId: 'ollama' }),
                turnId: 'turn-timeout-terminal',
                fallbackAllowed: false,
                openTimeoutMs: 15,
            },
        );

        const hardFailErr = new Error('server exploded');
        const hardFailBrain = makeBrainFromSteps([
            { kind: 'throw', error: hardFailErr },
            { kind: 'throw', error: hardFailErr },
        ]).brain;
        const hardFailResult = await service.executeStream(
            hardFailBrain,
            [{ role: 'user', content: 'boom' }],
            'system',
            () => {},
            {
                provider: makeProvider({ providerId: 'ollama' }),
                turnId: 'turn-hard-terminal',
                fallbackAllowed: false,
            },
        );

        expect(timeoutResult.streamStatus).toBe('timeout');
        expect(timeoutResult.errorCode).toBe('timeout');
        expect(hardFailResult.streamStatus).toBe('failed');
        expect(hardFailResult.errorCode).toBe('server_error');
    });

    it('malformed provider response is handled safely without silent crash', async () => {
        const service = new InferenceService();
        const { brain } = makeBrainFromSteps([{ kind: 'malformed' }]);
        const provider = makeProvider({ providerId: 'ollama' });

        const result = await service.executeStream(
            brain,
            [{ role: 'user', content: 'hello' }],
            'system',
            () => {},
            {
                provider,
                turnId: 'turn-malformed',
                fallbackAllowed: false,
            },
        );

        expect(result.success).toBe(true);
        expect(result.providerId).toBe('ollama');
        expect(result.content).toBe('');
    });

    it('resolved provider config is injected into runtime startup config and passed downstream truthfully', async () => {
        const inventory = makeInventory(
            [
                makeProvider({ providerId: 'ollama', providerType: 'ollama', preferredModel: 'qwen2.5:3b' }),
                makeProvider({ providerId: 'vllm', providerType: 'vllm', transport: 'http_openai_compat', preferredModel: 'mistral:7b' }),
            ],
            'vllm',
        );
        const { AgentService, agent, memory } = await loadAgentSoulHarness(inventory);

        await AgentService.prototype.igniteSoul.call(agent, 'python');

        expect(memory.ignite).toHaveBeenCalledTimes(1);
        const runtimeConfig = (memory.ignite as ReturnType<typeof vi.fn>).mock.calls[0][3];
        expect(runtimeConfig.mode).toBe('full_memory');
        expect(runtimeConfig.extraction.enabled).toBe(true);
        expect(runtimeConfig.extraction.providerId).toBe('vllm');
        expect(runtimeConfig.extraction.model).toBe('mistral:7b');
    });

    it('small-model fallback path resolves to compact/tiny prompt profile where required', () => {
        const selection = makeSelectionService([
            makeProvider({ providerId: 'ollama', providerType: 'ollama', ready: false, status: 'unavailable' }),
            makeProvider({
                providerId: 'embedded_llamacpp',
                providerType: 'embedded_llamacpp',
                scope: 'embedded',
                transport: 'http_openai_compat',
                preferredModel: 'qwen2.5:3b',
                models: ['qwen2.5:3b'],
            }),
        ]).select({ mode: 'auto', fallbackAllowed: true });

        expect(selection.success).toBe(true);
        const profile = promptProfileSelector.select(
            {
                providerId: selection.selectedProvider!.providerId,
                providerType: selection.selectedProvider!.providerType,
                displayName: selection.selectedProvider!.displayName,
            },
            selection.resolvedModel ?? selection.selectedProvider!.preferredModel ?? 'qwen2.5:3b',
            'turn-tiny',
            'assistant',
        );

        expect(profile.parameterClass).toBe('tiny');
        expect(profile.compactionPolicy).toBe('aggressive');
        expect(profile.promptProfileClass).toBe('tiny_profile');
    });
});
