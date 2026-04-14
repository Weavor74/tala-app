import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseBootstrapCoordinator } from '../electron/services/db/DatabaseBootstrapCoordinator';
import { DbHealthService } from '../electron/services/db/DbHealthService';

type CanonicalDbHealth = {
    reachable: boolean;
    authenticated: boolean;
    databaseExists: boolean;
    pgvectorInstalled: boolean;
    migrationsApplied: boolean;
    error?: string;
};

type InitMemoryStoreMockOptions = {
    bootstrapResult?: {
        success: boolean;
        mode: string;
        config: Record<string, unknown>;
        error?: string;
        nativeRuntimeActive?: boolean;
    };
    initializeError?: Error;
    dbHealth?: CanonicalDbHealth;
    runMigrationsError?: Error;
};

async function loadInitMemoryStoreWithMocks(opts: InitMemoryStoreMockOptions = {}) {
    vi.resetModules();

    const bootstrap = vi.fn().mockResolvedValue(
        opts.bootstrapResult ?? {
            success: true,
            mode: 'native-runtime',
            config: { host: '127.0.0.1', port: 5432, database: 'tala', user: 'tala', password: 'tala_local' },
            nativeRuntimeActive: true,
        },
    );

    const shutdown = vi.fn().mockResolvedValue(undefined);
    const initialize = opts.initializeError
        ? vi.fn().mockRejectedValue(opts.initializeError)
        : vi.fn().mockResolvedValue(undefined);
    const runMigrations = opts.runMigrationsError
        ? vi.fn().mockRejectedValue(opts.runMigrationsError)
        : vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const getSharedPool = vi.fn().mockReturnValue({ mock: 'pool' });
    const getConfigSummary = vi.fn().mockReturnValue('127.0.0.1:5432/tala');

    const check = vi.fn().mockResolvedValue(
        opts.dbHealth ?? {
            reachable: true,
            authenticated: true,
            databaseExists: true,
            pgvectorInstalled: true,
            migrationsApplied: true,
        },
    );

    class MockPostgresMemoryRepository {
        public initialize = initialize;
        public runMigrations = runMigrations;
        public close = close;
        public getSharedPool = getSharedPool;
        public getConfigSummary = getConfigSummary;
        constructor(_cfg?: unknown, _migrationsDir?: unknown) {}
    }

    class MockDatabaseBootstrapCoordinator {
        public bootstrap = bootstrap;
        public shutdown = shutdown;
        constructor(_opts?: unknown) {}
    }

    class MockDbHealthService {
        public check = check;
        constructor(_pool?: unknown, _opts?: unknown) {}
    }

    vi.doMock('../electron/services/db/PostgresMemoryRepository', () => ({
        PostgresMemoryRepository: MockPostgresMemoryRepository,
    }));
    vi.doMock('../electron/services/db/DatabaseBootstrapCoordinator', () => ({
        DatabaseBootstrapCoordinator: MockDatabaseBootstrapCoordinator,
    }));
    vi.doMock('../electron/services/db/DbHealthService', () => ({
        DbHealthService: MockDbHealthService,
    }));
    vi.doMock('../electron/services/db/ResearchRepository', () => ({
        ResearchRepository: class {
            constructor(_pool?: unknown) {}
        },
    }));
    vi.doMock('../electron/services/db/ContentRepository', () => ({
        ContentRepository: class {
            constructor(_pool?: unknown) {}
        },
    }));
    vi.doMock('../electron/services/db/EmbeddingsRepository', () => ({
        EmbeddingsRepository: class {
            constructor(_pool?: unknown) {}
        },
    }));

    const mod = await import('../electron/services/db/initMemoryStore');
    return {
        mod,
        spies: {
            bootstrap,
            shutdown,
            initialize,
            runMigrations,
            close,
            getSharedPool,
            check,
        },
    };
}

type SoulHarnessOptions = {
    failMem0?: boolean;
    failAstro?: boolean;
    failGraph?: boolean;
    inferenceInventory?: any;
    dbHealth?: CanonicalDbHealth | null;
    canonicalRepoPresent?: boolean;
};

async function loadAgentSoulHarness(opts: SoulHarnessOptions = {}) {
    vi.resetModules();

    const loadSettings = vi.fn().mockReturnValue({
        inference: { mode: 'auto', instances: [] },
        memory: { integrityMode: 'balanced' },
    });

    vi.doMock('electron', () => ({
        app: {
            getAppPath: () => 'D:/src/client1/tala-app',
        },
    }));
    vi.doMock('../electron/services/SettingsManager', () => ({
        loadSettings,
        getActiveMode: vi.fn().mockReturnValue('hybrid'),
        saveSettings: vi.fn(),
    }));
    vi.doMock('../electron/services/db/initMemoryStore', () => ({
        getCanonicalMemoryRepository: () => (opts.canonicalRepoPresent === false ? null : { kind: 'canonical' }),
        getLastDbHealth: () =>
            opts.dbHealth ?? {
                reachable: true,
                authenticated: true,
                databaseExists: true,
                pgvectorInstalled: true,
                migrationsApplied: true,
            },
        initCanonicalMemory: vi.fn().mockResolvedValue({}),
        shutdownCanonicalMemory: vi.fn().mockResolvedValue(undefined),
    }));

    const { AgentService } = await import('../electron/services/AgentService');

    let ragReady = false;
    const rag = {
        ignite: vi.fn().mockImplementation(async () => {
            ragReady = true;
        }),
        getReadyStatus: vi.fn(() => ragReady),
        shutdown: vi.fn().mockResolvedValue(undefined),
    };

    let memoryReady = false;
    const memory = {
        ignite: vi.fn().mockImplementation(async (_python: string, _script: string, _env: any, _cfg: any) => {
            if (opts.failMem0) {
                throw new Error('mem0 unavailable');
            }
            memoryReady = true;
        }),
        getReadyStatus: vi.fn(() => memoryReady),
        setSubsystemAvailability: vi.fn(),
        shutdown: vi.fn().mockResolvedValue(undefined),
        getHealthStatus: vi.fn().mockReturnValue({ state: 'healthy' }),
    };

    let astroReady = false;
    const astro = {
        ignite: vi.fn().mockImplementation(async () => {
            if (opts.failAstro) {
                throw new Error('astro unavailable');
            }
            astroReady = true;
        }),
        getReadyStatus: vi.fn(() => astroReady),
        shutdown: vi.fn().mockResolvedValue(undefined),
    };

    let worldReady = false;
    const world = {
        ignite: vi.fn().mockImplementation(async () => {
            worldReady = true;
        }),
        getReadyStatus: vi.fn(() => worldReady),
        shutdown: vi.fn().mockResolvedValue(undefined),
    };

    const graphCallable = new Set<string>();
    const mcpService = {
        setPythonPath: vi.fn(),
        connect: vi.fn().mockImplementation(async (cfg: any) => {
            if (opts.failGraph) {
                throw new Error('mcp unavailable');
            }
            graphCallable.add(cfg.id);
            return true;
        }),
        isServiceCallable: vi.fn((id: string) => graphCallable.has(id)),
    };

    const inferenceInventory =
        opts.inferenceInventory ??
        {
            selectedProviderId: null,
            providers: [],
            refreshedAt: new Date().toISOString(),
        };
    const inference = {
        getProviderInventory: vi.fn().mockReturnValue(inferenceInventory),
        getLocalEngine: vi.fn().mockReturnValue({ extinguish: vi.fn().mockResolvedValue(undefined) }),
    };

    const agent: any = Object.create(AgentService.prototype);
    Object.assign(agent, {
        isSoulReady: false,
        USE_STRUCTURED_LTMF: false,
        settingsPath: 'D:/src/client1/tala-app/data/app_settings.json',
        backup: {
            init: vi.fn(),
        },
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
        docIntel: {
            ignite: vi.fn().mockResolvedValue(undefined),
        },
        stripPIIFromDebug: vi.fn().mockImplementation((err: unknown) => String(err)),
    });

    return {
        AgentService,
        agent,
        deps: { rag, memory, astro, world, mcpService, inference, loadSettings },
    };
}

describe('Startup Resilience Integration', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    describe('canonical bootstrap startup path', () => {
        it('boots healthy when canonical dependencies are available', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            const { mod, spies } = await loadInitMemoryStoreWithMocks();
            const repo = await mod.initCanonicalMemory();

            expect(repo).toBeTruthy();
            expect(spies.bootstrap).toHaveBeenCalledTimes(1);
            expect(spies.initialize).toHaveBeenCalledTimes(1);
            expect(spies.runMigrations).toHaveBeenCalledTimes(1);
            expect(mod.getCanonicalMemoryRepository()).not.toBeNull();
            expect(mod.getLastDbHealth()).toMatchObject({
                reachable: true,
                pgvectorInstalled: true,
                migrationsApplied: true,
            });
            expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('degraded'));
            expect(errorSpy).not.toHaveBeenCalled();
            await mod.shutdownCanonicalMemory();
        });

        it('surfaces postgres unavailable startup without silent hard-crash in guarded startup flow', async () => {
            const err = new Error('ECONNREFUSED 127.0.0.1:5432');
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            const { mod, spies } = await loadInitMemoryStoreWithMocks({ initializeError: err });

            await expect(mod.initCanonicalMemory()).rejects.toThrow('ECONNREFUSED');
            expect(spies.close).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalledWith(
                '[initCanonicalMemory] Failed to initialize canonical memory store:',
                expect.any(Error),
            );

            const guardedStartup = async () => {
                try {
                    await mod.initCanonicalMemory();
                } catch {
                    return 'degraded-continue';
                }
                return 'healthy';
            };
            await expect(guardedStartup()).resolves.toBe('degraded-continue');
        });

        it('startup retry eventually succeeds for db health probe', async () => {
            const client = {
                query: vi
                    .fn()
                    .mockResolvedValueOnce({})
                    .mockResolvedValueOnce({ rows: [{ extname: 'vector' }] })
                    .mockResolvedValueOnce({ rows: [{ exists: 'public.schema_migrations' }] }),
                release: vi.fn(),
            };
            const connect = vi
                .fn()
                .mockRejectedValueOnce(new Error('boot timeout #1'))
                .mockRejectedValueOnce(new Error('boot timeout #2'))
                .mockResolvedValueOnce(client);
            const pool = { connect } as any;

            const healthSvc = new DbHealthService(pool, { maxRetries: 4, retryDelayMs: 0 });
            const health = await healthSvc.check();

            expect(connect).toHaveBeenCalledTimes(3);
            expect(health.reachable).toBe(true);
            expect(health.pgvectorInstalled).toBe(true);
            expect(health.migrationsApplied).toBe(true);
        });

        it('startup retry exhausts and enters deterministic degraded bootstrap mode', async () => {
            const healthErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const alwaysFailPool = {
                connect: vi.fn().mockRejectedValue(new Error('still unavailable')),
            } as any;
            const healthSvc = new DbHealthService(alwaysFailPool, { maxRetries: 2, retryDelayMs: 0 });
            const health = await healthSvc.check();

            expect(health.reachable).toBe(false);
            expect(health.error).toContain('still unavailable');
            expect(alwaysFailPool.connect).toHaveBeenCalledTimes(2);
            expect(healthErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[DBHealth] reachable=false'));

            const coordinator = new DatabaseBootstrapCoordinator({
                bootstrapConfig: {
                    bootstrapMode: 'auto',
                    allowDockerFallback: false,
                    localRuntime: { enabled: false },
                },
            });
            const first = await coordinator.bootstrap();
            const second = await coordinator.bootstrap();

            expect(first.success).toBe(false);
            expect(first.mode).toBe('degraded');
            expect(first.error).toContain('No viable database bootstrap path configured');
            expect(second).toMatchObject({
                success: false,
                mode: 'degraded',
                error: first.error,
            });
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Database bootstrap degraded'));
        });
    });

    describe('soul startup subsystem availability reporting', () => {
        it('boots healthy with all startup dependencies available', async () => {
            const { AgentService, agent } = await loadAgentSoulHarness({
                inferenceInventory: {
                    selectedProviderId: 'ollama-local',
                    providers: [
                        {
                            providerId: 'ollama-local',
                            providerType: 'ollama',
                            scope: 'local',
                            status: 'ready',
                            ready: true,
                            endpoint: 'http://127.0.0.1:11434',
                            preferredModel: 'qwen2.5:3b',
                            models: ['qwen2.5:3b'],
                            capabilities: { streaming: true, embeddings: true, tools: true },
                        },
                    ],
                    refreshedAt: new Date().toISOString(),
                },
            });

            await AgentService.prototype.igniteSoul.call(agent, 'python');
            const status = AgentService.prototype.getStartupStatus.call(agent);

            expect(status).toMatchObject({
                rag: true,
                memory: true,
                astro: true,
                world: true,
                memoryGraph: true,
                soulReady: true,
            });
        });

        it('flags postgres unavailable startup explicitly in availability update and logs', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const { AgentService, agent, deps } = await loadAgentSoulHarness({
                canonicalRepoPresent: false,
                dbHealth: {
                    reachable: false,
                    authenticated: false,
                    databaseExists: false,
                    pgvectorInstalled: false,
                    migrationsApplied: false,
                    error: 'connection refused',
                },
            });

            await AgentService.prototype.igniteSoul.call(agent, 'python');

            expect(deps.memory.setSubsystemAvailability).toHaveBeenCalledWith(
                expect.objectContaining({
                    canonicalReady: false,
                    ragAvailable: true,
                    integrityMode: 'balanced',
                }),
            );
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[DBHealth] Postgres unreachable'));
        });

        it('flags pgvector missing at startup without false healthy claims', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const { AgentService, agent, deps } = await loadAgentSoulHarness({
                dbHealth: {
                    reachable: true,
                    authenticated: true,
                    databaseExists: true,
                    pgvectorInstalled: false,
                    migrationsApplied: true,
                },
            });

            await AgentService.prototype.igniteSoul.call(agent, 'python');
            const status = AgentService.prototype.getStartupStatus.call(agent);

            expect(status.memory).toBe(true);
            expect(deps.memory.setSubsystemAvailability).toHaveBeenCalledWith(
                expect.objectContaining({ canonicalReady: true }),
            );
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pgvector not installed'));
        });

        it('flags missing migrations at startup without silent partial initialization', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const { AgentService, agent } = await loadAgentSoulHarness({
                dbHealth: {
                    reachable: true,
                    authenticated: true,
                    databaseExists: true,
                    pgvectorInstalled: true,
                    migrationsApplied: false,
                },
            });

            await AgentService.prototype.igniteSoul.call(agent, 'python');
            const status = AgentService.prototype.getStartupStatus.call(agent);

            expect(status.soulReady).toBe(true);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('schema_migrations not found'));
        });

        it('degrades explicitly when inference providers are unavailable at startup', async () => {
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            const { AgentService, agent, deps } = await loadAgentSoulHarness({
                inferenceInventory: {
                    selectedProviderId: null,
                    providers: [],
                    refreshedAt: new Date().toISOString(),
                },
            });

            await AgentService.prototype.igniteSoul.call(agent, 'python');

            expect(deps.memory.ignite).toHaveBeenCalled();
            const resolvedConfig = (deps.memory.ignite as ReturnType<typeof vi.fn>).mock.calls[0][3];
            expect(resolvedConfig.mode).toBe('canonical_only');
            expect(resolvedConfig.extraction.enabled).toBe(false);
            expect(resolvedConfig.embeddings.enabled).toBe(false);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no_provider_resolved'));
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no_embedding_provider_resolved'));
        });

        it('keeps startup deterministic when mem0 sidecar is unavailable', async () => {
            const { AgentService, agent } = await loadAgentSoulHarness({ failMem0: true });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            await AgentService.prototype.igniteSoul.call(agent, 'python');
            const status = AgentService.prototype.getStartupStatus.call(agent);

            expect(status.soulReady).toBe(true);
            expect(status.memory).toBe(false);
            expect(status.rag).toBe(true);
            expect(errorSpy).toHaveBeenCalledWith('Memory ignition failed:', expect.any(Error));
        });

        it('keeps startup deterministic when astro engine is unavailable', async () => {
            const { AgentService, agent } = await loadAgentSoulHarness({ failAstro: true });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            await AgentService.prototype.igniteSoul.call(agent, 'python');
            const status = AgentService.prototype.getStartupStatus.call(agent);

            expect(status.soulReady).toBe(true);
            expect(status.astro).toBe(false);
            expect(status.memory).toBe(true);
            expect(errorSpy).toHaveBeenCalledWith('Astro ignition failed:', expect.any(Error));
        });

        it('reports one unavailable MCP/tool subsystem truthfully (memoryGraph=false)', async () => {
            const { AgentService, agent, deps } = await loadAgentSoulHarness({ failGraph: true });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            await AgentService.prototype.igniteSoul.call(agent, 'python');
            const status = AgentService.prototype.getStartupStatus.call(agent);

            expect(status.soulReady).toBe(true);
            expect(status.memoryGraph).toBe(false);
            expect(deps.memory.setSubsystemAvailability).toHaveBeenCalledWith(
                expect.objectContaining({ graphAvailable: false }),
            );
            expect(errorSpy).toHaveBeenCalledWith('MCP Service connection failed:', expect.any(Error));
        });
    });
});

