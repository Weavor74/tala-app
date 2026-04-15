import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshSettingsFromDisk } from '../../services/SettingsManager';
import { StorageConfigPersistenceService } from '../../services/storage/storageConfigPersistence';
import { StorageProviderRegistryService } from '../../services/storage/StorageProviderRegistryService';
import { StorageValidationService } from '../../services/storage/StorageValidationService';
import {
    StorageAuthMode,
    StorageAuthStatus,
    StorageCapability,
    StorageHealthStatus,
    StorageLocality,
    StorageProviderKind,
    StorageRegistrationMode,
    StorageRole,
    StorageValidationDimensionStatus,
} from '../../services/storage/storageTypes';

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

vi.mock('../../services/db/resolveDatabaseConfig', () => ({
    resolveDatabaseConfig: () => mockDbConfig,
}));

vi.mock('../../services/db/initMemoryStore', () => ({
    getLastDbHealth: () => mockDbHealth,
    checkCanonicalDbHealth: vi.fn(async () => mockDbHealth),
}));

vi.mock('../../services/db/probeTcpPort', () => ({
    probeTcpPort: (...args: Parameters<typeof mockProbeTcpPort>) => mockProbeTcpPort(...args),
}));

function makeSettingsPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-storage-pg-runtime-'));
    return path.join(dir, 'app_settings.json');
}

function makeRegistry(settingsPath: string): StorageProviderRegistryService {
    const persistence = new StorageConfigPersistenceService(settingsPath);
    return new StorageProviderRegistryService(persistence, undefined, () => '2026-04-14T12:00:00.000Z');
}

describe('StorageValidationService PostgreSQL runtime authority', () => {
    let settingsPath: string;

    beforeEach(() => {
        settingsPath = makeSettingsPath();
        refreshSettingsFromDisk(settingsPath, 'StoragePostgresRuntimeValidation.beforeEach');
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

    it('active runtime PostgreSQL connected + pgvector present -> provider validates as connected and vector-capable', async () => {
        const registry = makeRegistry(settingsPath);
        registry.addProvider({
            id: 'postgresql:localhost:5432:tala',
            name: 'PostgreSQL (Active)',
            kind: StorageProviderKind.POSTGRESQL,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.MANUAL,
            connection: {
                endpoint: 'localhost:5432',
                database: 'tala',
            },
            auth: {
                mode: StorageAuthMode.BASIC,
                status: StorageAuthStatus.UNAUTHENTICATED,
                lastCheckedAt: null,
                reason: null,
            },
            health: {
                status: StorageHealthStatus.UNKNOWN,
                checkedAt: null,
                reason: null,
            },
        });

        const validation = new StorageValidationService(registry);
        const { result } = await validation.validateProvider('postgresql:localhost:5432:tala');
        const updated = registry.getProviderById('postgresql:localhost:5432:tala');

        expect(result.auth.status).toBe(StorageAuthStatus.AUTHENTICATED);
        expect(result.health.status).toBe(StorageHealthStatus.HEALTHY);
        expect(result.detectedCapabilities).toContain(StorageCapability.VECTOR_SEARCH);
        expect(result.detectedRolesSupported).toContain(StorageRole.VECTOR_INDEX);
        expect(result.layeredValidation.dimensions.config_schema.status).toBe(StorageValidationDimensionStatus.PASS);
        expect(result.layeredValidation.dimensions.authentication.status).toBe(StorageValidationDimensionStatus.PASS);
        expect(result.layeredValidation.classification.reachableButUnauthorized).toBe(false);
        expect(updated?.auth.status).toBe(StorageAuthStatus.AUTHENTICATED);
        expect(updated?.capabilities).toContain(StorageCapability.VECTOR_SEARCH);
        expect(updated?.supportedRoles).toContain(StorageRole.VECTOR_INDEX);
    });

    it('vector_index assignment to matching active PostgreSQL provider succeeds after validation', async () => {
        const registry = makeRegistry(settingsPath);
        registry.addProvider({
            id: 'postgresql:localhost:5432:tala',
            name: 'PostgreSQL (Active)',
            kind: StorageProviderKind.POSTGRESQL,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.MANUAL,
            connection: {
                endpoint: 'localhost:5432',
                database: 'tala',
            },
            auth: {
                mode: StorageAuthMode.BASIC,
                status: StorageAuthStatus.UNAUTHENTICATED,
                lastCheckedAt: null,
                reason: null,
            },
            health: {
                status: StorageHealthStatus.UNKNOWN,
                checkedAt: null,
                reason: null,
            },
        });
        const validation = new StorageValidationService(registry);
        await validation.validateProvider('postgresql:localhost:5432:tala');

        expect(() => registry.assignRole('postgresql:localhost:5432:tala', StorageRole.VECTOR_INDEX)).not.toThrow();
    });

    it('non-matching PostgreSQL provider follows normal validation/auth rules', async () => {
        const registry = makeRegistry(settingsPath);
        registry.addProvider({
            id: 'postgresql:db.example.com:5432:tala',
            name: 'PostgreSQL (External)',
            kind: StorageProviderKind.POSTGRESQL,
            locality: StorageLocality.REMOTE,
            registrationMode: StorageRegistrationMode.MANUAL,
            connection: {
                endpoint: 'db.example.com:5432',
                database: 'tala',
            },
            auth: {
                mode: StorageAuthMode.BASIC,
                status: StorageAuthStatus.UNAUTHENTICATED,
                lastCheckedAt: null,
                reason: null,
            },
            health: {
                status: StorageHealthStatus.UNKNOWN,
                checkedAt: null,
                reason: null,
            },
        });

        const validation = new StorageValidationService(registry);
        const { result } = await validation.validateProvider('postgresql:db.example.com:5432:tala');

        expect(result.auth.status).toBe(StorageAuthStatus.UNAUTHENTICATED);
        expect(result.health.status).toBe(StorageHealthStatus.DEGRADED);
        expect(result.warnings.some((item) => item.toLowerCase().includes('does not match the active canonical db target'))).toBe(true);
        expect(result.layeredValidation.classification.reachableButUnauthorized).toBe(false);
        expect(result.layeredValidation.dimensions.authentication.status).toBe(StorageValidationDimensionStatus.WARN);
    });

    it('pgvector absent -> PostgreSQL remains canonical-capable but not vector_index-capable', async () => {
        mockDbHealth = {
            reachable: true,
            authenticated: true,
            databaseExists: true,
            pgvectorInstalled: false,
            migrationsApplied: true,
        };

        const registry = makeRegistry(settingsPath);
        registry.addProvider({
            id: 'postgresql:localhost:5432:tala',
            name: 'PostgreSQL (Active)',
            kind: StorageProviderKind.POSTGRESQL,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.MANUAL,
            connection: {
                endpoint: 'localhost:5432',
                database: 'tala',
            },
            auth: {
                mode: StorageAuthMode.BASIC,
                status: StorageAuthStatus.UNAUTHENTICATED,
                lastCheckedAt: null,
                reason: null,
            },
            health: {
                status: StorageHealthStatus.UNKNOWN,
                checkedAt: null,
                reason: null,
            },
        });

        const validation = new StorageValidationService(registry);
        const { result } = await validation.validateProvider('postgresql:localhost:5432:tala');
        const updated = registry.getProviderById('postgresql:localhost:5432:tala');

        expect(result.detectedRolesSupported).toContain(StorageRole.CANONICAL_MEMORY);
        expect(result.detectedRolesSupported).not.toContain(StorageRole.VECTOR_INDEX);
        expect(result.detectedCapabilities).not.toContain(StorageCapability.VECTOR_SEARCH);
        expect(result.detectedCapabilities).not.toContain(StorageCapability.VECTOR_INDEXING);
        expect(updated?.supportedRoles).toContain(StorageRole.CANONICAL_MEMORY);
        expect(updated?.supportedRoles).not.toContain(StorageRole.VECTOR_INDEX);
        expect(() => registry.assignRole('postgresql:localhost:5432:tala', StorageRole.VECTOR_INDEX)).toThrowError(/does not support requested role/i);
    });
});
