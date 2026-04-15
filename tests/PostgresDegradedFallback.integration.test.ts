import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshSettingsFromDisk } from '../electron/services/SettingsManager';
import { StorageConfigPersistenceService } from '../electron/services/storage/storageConfigPersistence';
import { StorageProviderRegistryService } from '../electron/services/storage/StorageProviderRegistryService';
import { StorageValidationService } from '../electron/services/storage/StorageValidationService';
import {
    StorageAuthMode,
    StorageAuthStatus,
    StorageCapability,
    StorageHealthStatus,
    StorageLocality,
    StorageProviderKind,
    StorageRegistrationMode,
    StorageRole,
    StorageValidationDimension,
    StorageValidationDimensionStatus,
} from '../electron/services/storage/storageTypes';
import { buildProviderVisibilityModels, buildStorageAuthoritySummary } from '../src/renderer/storage/StorageViewModels';

let mockDbConfig = {
    host: 'localhost',
    port: 5432,
    database: 'tala',
    user: 'postgres',
    password: 'postgres',
    ssl: false,
    connectionString: '',
    poolMax: 5,
    queryTimeoutMs: 10000,
};

let mockDbHealth: {
    reachable: boolean;
    authenticated: boolean;
    databaseExists: boolean;
    pgvectorInstalled: boolean;
    migrationsApplied: boolean;
    error?: string;
} | null = null;

const mockProbeTcpPort = vi.fn(async () => true);

vi.mock('../electron/services/db/resolveDatabaseConfig', () => ({
    resolveDatabaseConfig: () => mockDbConfig,
}));

vi.mock('../electron/services/db/initMemoryStore', () => ({
    getLastDbHealth: () => mockDbHealth,
    checkCanonicalDbHealth: vi.fn(async () => mockDbHealth),
}));

vi.mock('../electron/services/db/probeTcpPort', () => ({
    probeTcpPort: (...args: Parameters<typeof mockProbeTcpPort>) => mockProbeTcpPort(...args),
}));

function makeSettingsPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-pg-degraded-fallback-'));
    return path.join(dir, 'app_settings.json');
}

function makeRegistry(settingsPath: string): StorageProviderRegistryService {
    const persistence = new StorageConfigPersistenceService(settingsPath);
    return new StorageProviderRegistryService(persistence, undefined, () => '2026-04-15T12:00:00.000Z');
}

function addCanonicalPostgres(registry: StorageProviderRegistryService): void {
    registry.addProvider({
        id: 'postgresql:localhost:5432:tala',
        name: 'Canonical PostgreSQL',
        kind: StorageProviderKind.POSTGRESQL,
        locality: StorageLocality.LOCAL,
        registrationMode: StorageRegistrationMode.MANUAL,
        supportedRoles: [StorageRole.CANONICAL_MEMORY, StorageRole.VECTOR_INDEX],
        capabilities: [StorageCapability.STRUCTURED_RECORDS, StorageCapability.VECTOR_SEARCH, StorageCapability.VECTOR_INDEXING],
        enabled: true,
        connection: { endpoint: 'localhost:5432', database: 'tala' },
        auth: { mode: StorageAuthMode.BASIC, status: StorageAuthStatus.AUTHENTICATED, lastCheckedAt: null, reason: null },
        health: { status: StorageHealthStatus.HEALTHY, checkedAt: null, reason: null },
    });
    registry.assignRole('postgresql:localhost:5432:tala', StorageRole.CANONICAL_MEMORY);
}

describe('Postgres degraded fallback integration', () => {
    let settingsPath: string;

    beforeEach(() => {
        settingsPath = makeSettingsPath();
        refreshSettingsFromDisk(settingsPath, 'PostgresDegradedFallback.integration.beforeEach');
        mockDbConfig = {
            host: 'localhost',
            port: 5432,
            database: 'tala',
            user: 'postgres',
            password: 'postgres',
            ssl: false,
            connectionString: '',
            poolMax: 5,
            queryTimeoutMs: 10000,
        };
        mockDbHealth = {
            reachable: true,
            authenticated: true,
            databaseExists: true,
            pgvectorInstalled: true,
            migrationsApplied: true,
        };
        mockProbeTcpPort.mockReset();
        mockProbeTcpPort.mockResolvedValue(true);
    });

    it('unreachable DB at startup keeps canonical assignment and surfaces degraded diagnostics', async () => {
        mockDbHealth = {
            reachable: false,
            authenticated: false,
            databaseExists: true,
            pgvectorInstalled: false,
            migrationsApplied: false,
            error: 'ECONNREFUSED',
        };
        const registry = makeRegistry(settingsPath);
        addCanonicalPostgres(registry);
        const validation = new StorageValidationService(registry);

        const { result } = await validation.validateProvider('postgresql:localhost:5432:tala');
        const snapshot = registry.getRegistrySnapshot();
        const summary = buildStorageAuthoritySummary(snapshot);
        const providers = buildProviderVisibilityModels(snapshot, {
            [result.providerId]: result,
        });

        expect(snapshot.assignments.find((a) => a.role === StorageRole.CANONICAL_MEMORY)?.providerId).toBe('postgresql:localhost:5432:tala');
        expect(result.layeredValidation.dimensions[StorageValidationDimension.REACHABILITY]).toMatchObject({
            status: StorageValidationDimensionStatus.FAIL,
            reasonCode: 'provider_unreachable',
        });
        expect(summary.authorityState.degraded).toBe(true);
        expect(summary.authorityState.reasons).toContain('canonical_runtime_authority_degraded');
        expect(providers['postgresql:localhost:5432:tala'].status.reachable).toBe('offline');
    });

    it('reachable but auth invalid is reported explicitly without fake authorization', async () => {
        mockDbHealth = {
            reachable: true,
            authenticated: false,
            databaseExists: true,
            pgvectorInstalled: true,
            migrationsApplied: true,
            error: 'password authentication failed',
        };
        const registry = makeRegistry(settingsPath);
        addCanonicalPostgres(registry);
        const validation = new StorageValidationService(registry);
        const { result } = await validation.validateProvider('postgresql:localhost:5432:tala');

        expect(result.auth.status).toBe(StorageAuthStatus.UNAUTHENTICATED);
        expect(result.layeredValidation.dimensions[StorageValidationDimension.AUTHENTICATION]).toMatchObject({
            status: StorageValidationDimensionStatus.WARN,
            reasonCode: 'authentication_not_ready',
        });
    });

    it('canonical healthy but pgvector missing never reports vector capability as healthy', async () => {
        mockDbHealth = {
            reachable: true,
            authenticated: true,
            databaseExists: true,
            pgvectorInstalled: false,
            migrationsApplied: true,
        };
        const registry = makeRegistry(settingsPath);
        addCanonicalPostgres(registry);
        const validation = new StorageValidationService(registry);
        const { result } = await validation.validateProvider('postgresql:localhost:5432:tala');

        expect(result.detectedCapabilities).not.toContain(StorageCapability.VECTOR_SEARCH);
        expect(result.detectedCapabilities).not.toContain(StorageCapability.VECTOR_INDEXING);
        expect(result.detectedRolesSupported).not.toContain(StorageRole.VECTOR_INDEX);
        expect(result.warnings.join(' ')).toContain('pgvector');
    });

    it('degraded startup followed by recovery transitions deterministically', async () => {
        const registry = makeRegistry(settingsPath);
        addCanonicalPostgres(registry);
        const validation = new StorageValidationService(registry);

        mockDbHealth = {
            reachable: false,
            authenticated: false,
            databaseExists: false,
            pgvectorInstalled: false,
            migrationsApplied: false,
            error: 'connection refused',
        };
        const first = await validation.validateProvider('postgresql:localhost:5432:tala');

        mockDbHealth = {
            reachable: true,
            authenticated: true,
            databaseExists: true,
            pgvectorInstalled: true,
            migrationsApplied: true,
        };
        const second = await validation.validateProvider('postgresql:localhost:5432:tala');

        expect(first.result.health.status).toBe(StorageHealthStatus.OFFLINE);
        expect(second.result.health.status).toBe(StorageHealthStatus.HEALTHY);
        expect(second.result.auth.status).toBe(StorageAuthStatus.AUTHENTICATED);
    });

    it('healthy startup followed by mid-run degradation preserves canonical assignment and reports fallback posture', async () => {
        const registry = makeRegistry(settingsPath);
        addCanonicalPostgres(registry);
        const validation = new StorageValidationService(registry);

        const healthy = await validation.validateProvider('postgresql:localhost:5432:tala');
        mockDbHealth = {
            reachable: false,
            authenticated: false,
            databaseExists: true,
            pgvectorInstalled: false,
            migrationsApplied: true,
            error: 'mid-run outage',
        };
        const degraded = await validation.validateProvider('postgresql:localhost:5432:tala');
        const snapshot = registry.getRegistrySnapshot();
        const summary = buildStorageAuthoritySummary(snapshot);

        expect(healthy.result.health.status).toBe(StorageHealthStatus.HEALTHY);
        expect(degraded.result.health.status).toBe(StorageHealthStatus.OFFLINE);
        expect(snapshot.assignments.find((a) => a.role === StorageRole.CANONICAL_MEMORY)?.providerId).toBe('postgresql:localhost:5432:tala');
        expect(summary.recoveryActions).toContain('fix_canonical_provider_connectivity_or_auth');
    });
});
