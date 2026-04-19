import { beforeEach, describe, expect, it, vi } from 'vitest';

type SoulHarnessOptions = {
    ragStartupResult?: { state: 'ready' | 'slow_start' | 'degraded' | 'failed'; reason?: string; elapsedMs: number };
    ragReadyInitially?: boolean;
    ragReadyAfterMs?: number;
};

async function loadAgentSoulHarness(opts: SoulHarnessOptions = {}) {
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

    let ragReady = opts.ragReadyInitially ?? false;
    const rag = {
        ignite: vi.fn().mockImplementation(async () => {
            const startupResult = opts.ragStartupResult ?? { state: 'slow_start', reason: 'startup_timeout_entered_grace', elapsedMs: 15 };
            if ((opts.ragReadyAfterMs ?? 0) > 0) {
                setTimeout(() => {
                    ragReady = true;
                }, opts.ragReadyAfterMs);
            } else if (startupResult.state === 'ready') {
                ragReady = true;
            }
            return startupResult;
        }),
        getReadyStatus: vi.fn(() => ragReady),
        getStartupState: vi.fn(() => (ragReady ? 'ready' : (opts.ragStartupResult?.state ?? 'slow_start'))),
        getLastStartupResult: vi.fn(() =>
            ragReady
                ? { state: 'ready', reason: 'slow_start_recovered', elapsedMs: 30 }
                : (opts.ragStartupResult ?? { state: 'slow_start', reason: 'startup_timeout_entered_grace', elapsedMs: 15 }),
        ),
        shutdown: vi.fn().mockResolvedValue(undefined),
    };

    const memory = {
        ignite: vi.fn().mockResolvedValue(undefined),
        getReadyStatus: vi.fn(() => true),
        setSubsystemAvailability: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
        getHealthStatus: vi.fn().mockReturnValue({ state: 'healthy' }),
    };

    const astro = {
        ignite: vi.fn().mockResolvedValue(undefined),
        getReadyStatus: vi.fn(() => true),
        shutdown: vi.fn().mockResolvedValue(undefined),
    };

    const world = {
        ignite: vi.fn().mockResolvedValue(undefined),
        getReadyStatus: vi.fn(() => true),
        shutdown: vi.fn().mockResolvedValue(undefined),
    };

    const mcpService = {
        setPythonPath: vi.fn(),
        connect: vi.fn().mockResolvedValue(true),
        isServiceCallable: vi.fn().mockReturnValue(true),
    };

    const inference = {
        getProviderInventory: vi.fn().mockReturnValue({
            selectedProviderId: 'ollama',
            providers: [],
            refreshedAt: new Date().toISOString(),
        }),
        getLocalEngine: vi.fn().mockReturnValue({ extinguish: vi.fn().mockResolvedValue(undefined) }),
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
        rag,
        memory,
        astro,
        world,
        mcpService,
        inference,
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

    return { AgentService, agent };
}

describe('AgentServiceStartupAggregation', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    it('does not project permanent igniteSoul failure for rag slow_start that later reaches ready', async () => {
        vi.useFakeTimers();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { AgentService, agent } = await loadAgentSoulHarness({
            ragStartupResult: { state: 'slow_start', reason: 'startup_timeout_entered_grace', elapsedMs: 15 },
            ragReadyInitially: false,
            ragReadyAfterMs: 30,
        });

        await AgentService.prototype.igniteSoul.call(agent, 'python');
        const statusAfterIgnite = AgentService.prototype.getStartupStatus.call(agent);
        expect(statusAfterIgnite.rag).toBe(false);
        expect(statusAfterIgnite.ragStartupState).toBe('slow_start');

        await vi.advanceTimersByTimeAsync(35);
        const recovered = AgentService.prototype.getStartupStatus.call(agent);
        expect(recovered.rag).toBe(true);
        expect(recovered.ragStartupState).toBe('ready');
        expect(errorSpy).not.toHaveBeenCalledWith(
            expect.stringContaining('[AgentService] igniteSoul failed:'),
            expect.anything(),
        );
    });
});
