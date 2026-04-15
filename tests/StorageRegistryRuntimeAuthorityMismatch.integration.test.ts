import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshSettingsFromDisk, saveSettings } from '../electron/services/SettingsManager';
import { StorageConfigPersistenceService } from '../electron/services/storage/storageConfigPersistence';
import { StorageProviderRegistryService } from '../electron/services/storage/StorageProviderRegistryService';
import { StorageValidationService } from '../electron/services/storage/StorageValidationService';
import {
    StorageAssignmentReasonCode,
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
import {
    buildProviderVisibilityModels,
    buildRoleVisibilityModels,
    buildStorageAuthoritySummary,
} from '../src/renderer/storage/StorageViewModels';

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

const mockProbeTcpPort = vi.fn(async () => false);

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-storage-runtime-mismatch-'));
    return path.join(dir, 'app_settings.json');
}

function makeRegistry(settingsPath: string): StorageProviderRegistryService {
    const persistence = new StorageConfigPersistenceService(settingsPath);
    return new StorageProviderRegistryService(persistence, undefined, () => '2026-04-15T12:30:00.000Z');
}

function writeSettings(settingsPath: string, patch: Record<string, unknown>): void {
    const ok = saveSettings(settingsPath, patch);
    if (!ok) throw new Error('failed to write settings');
    refreshSettingsFromDisk(settingsPath, 'StorageRegistryRuntimeAuthorityMismatch.writeSettings');
}

describe('Storage Registry vs runtime authority mismatch integration', () => {
    let settingsPath: string;

    beforeEach(() => {
        settingsPath = makeSettingsPath();
        refreshSettingsFromDisk(settingsPath, 'StorageRegistryRuntimeAuthorityMismatch.beforeEach');
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
        mockProbeTcpPort.mockResolvedValue(false);
    });

    it('assigned registry provider can be runtime-unavailable without silent reassignment', async () => {
        const registry = makeRegistry(settingsPath);
        registry.addProvider({
            id: 'postgresql:db.example.com:5432:tala',
            name: 'Remote Canonical',
            kind: StorageProviderKind.POSTGRESQL,
            locality: StorageLocality.REMOTE,
            registrationMode: StorageRegistrationMode.MANUAL,
            enabled: true,
            connection: { endpoint: 'db.example.com:5432', database: 'tala' },
            auth: { mode: StorageAuthMode.BASIC, status: StorageAuthStatus.AUTHENTICATED, lastCheckedAt: null, reason: null },
            health: { status: StorageHealthStatus.HEALTHY, checkedAt: null, reason: null },
        });
        registry.assignRole('postgresql:db.example.com:5432:tala', StorageRole.CANONICAL_MEMORY);
        const validation = new StorageValidationService(registry);

        const { result } = await validation.validateProvider('postgresql:db.example.com:5432:tala');
        const snapshot = registry.getRegistrySnapshot();
        const summary = buildStorageAuthoritySummary(snapshot);
        const roles = buildRoleVisibilityModels(snapshot);

        expect(result.layeredValidation.dimensions[StorageValidationDimension.REACHABILITY].status).toBe(StorageValidationDimensionStatus.FAIL);
        expect(snapshot.assignments.find((a) => a.role === StorageRole.CANONICAL_MEMORY)?.providerId).toBe('postgresql:db.example.com:5432:tala');
        expect(summary.authorityState.degraded).toBe(true);
        expect(roles.find((r) => r.role === StorageRole.CANONICAL_MEMORY)?.eligibilityReasoning).toContain('provider_unreachable');
    });

    it('capability mismatch remains explicit with machine-usable reason code', () => {
        writeSettings(settingsPath, {
            storageRegistry: {
                version: 1,
                updatedAt: '2026-04-15T12:30:00.000Z',
                providers: [
                    {
                        id: 'sqlite:canon.db',
                        name: 'SQLite Canon',
                        kind: StorageProviderKind.SQLITE,
                        locality: StorageLocality.LOCAL,
                        registrationMode: StorageRegistrationMode.MANUAL,
                        supportedRoles: [StorageRole.CANONICAL_MEMORY],
                        capabilities: [StorageCapability.STRUCTURED_RECORDS],
                        enabled: true,
                        connection: { path: 'canon.db' },
                        auth: { mode: StorageAuthMode.NONE, status: StorageAuthStatus.NOT_REQUIRED, lastCheckedAt: null, reason: null },
                        health: { status: StorageHealthStatus.HEALTHY, checkedAt: null, reason: null },
                        assignedRoles: [],
                        createdAt: '2026-04-15T12:30:00.000Z',
                        updatedAt: '2026-04-15T12:30:00.000Z',
                    },
                ],
                assignments: [
                    { role: StorageRole.VECTOR_INDEX, providerId: 'sqlite:canon.db', assignedAt: '2026-04-15T12:30:00.000Z' },
                ],
            },
        });
        const registry = makeRegistry(settingsPath);
        const snapshot = registry.getRegistrySnapshot();
        const decision = snapshot.assignmentDecisions?.find((d) => d.reasonCode === StorageAssignmentReasonCode.BLOCKED_CAPABILITY_MISMATCH);
        expect(decision).toBeTruthy();
        expect(snapshot.assignments.find((a) => a.role === StorageRole.VECTOR_INDEX)?.providerId).toBe('sqlite:canon.db');
    });

    it('explicit registry assignment wins over legacy/bootstrap conflict and emits skip reason code', () => {
        writeSettings(settingsPath, {
            storageRegistry: {
                version: 1,
                updatedAt: '2026-04-15T12:30:00.000Z',
                providers: [
                    {
                        id: 'postgresql:localhost:5432:tala',
                        name: 'Canonical Postgres',
                        kind: StorageProviderKind.POSTGRESQL,
                        locality: StorageLocality.LOCAL,
                        registrationMode: StorageRegistrationMode.MANUAL,
                        supportedRoles: [
                            StorageRole.CANONICAL_MEMORY,
                            StorageRole.VECTOR_INDEX,
                            StorageRole.BLOB_STORE,
                            StorageRole.DOCUMENT_STORE,
                            StorageRole.BACKUP_TARGET,
                            StorageRole.ARTIFACT_STORE,
                        ],
                        capabilities: [
                            StorageCapability.STRUCTURED_RECORDS,
                            StorageCapability.VECTOR_SEARCH,
                            StorageCapability.VECTOR_INDEXING,
                            StorageCapability.BLOB_STORAGE,
                            StorageCapability.DOCUMENT_STORAGE,
                            StorageCapability.BACKUP_TARGET,
                            StorageCapability.ARTIFACT_STORAGE,
                        ],
                        enabled: true,
                        connection: { endpoint: 'localhost:5432', database: 'tala' },
                        auth: { mode: StorageAuthMode.BASIC, status: StorageAuthStatus.AUTHENTICATED, lastCheckedAt: null, reason: null },
                        health: { status: StorageHealthStatus.HEALTHY, checkedAt: null, reason: null },
                        assignedRoles: [],
                        createdAt: '2026-04-15T12:30:00.000Z',
                        updatedAt: '2026-04-15T12:30:00.000Z',
                    },
                ],
                assignments: [
                    { role: StorageRole.CANONICAL_MEMORY, providerId: 'postgresql:localhost:5432:tala', assignedAt: '2026-04-15T12:30:00.000Z' },
                    { role: StorageRole.VECTOR_INDEX, providerId: 'postgresql:localhost:5432:tala', assignedAt: '2026-04-15T12:30:00.000Z' },
                    { role: StorageRole.BLOB_STORE, providerId: 'postgresql:localhost:5432:tala', assignedAt: '2026-04-15T12:30:00.000Z' },
                    { role: StorageRole.DOCUMENT_STORE, providerId: 'postgresql:localhost:5432:tala', assignedAt: '2026-04-15T12:30:00.000Z' },
                    { role: StorageRole.BACKUP_TARGET, providerId: 'postgresql:localhost:5432:tala', assignedAt: '2026-04-15T12:30:00.000Z' },
                    { role: StorageRole.ARTIFACT_STORE, providerId: 'postgresql:localhost:5432:tala', assignedAt: '2026-04-15T12:30:00.000Z' },
                ],
            },
            storage: {
                activeProviderId: 'legacy-chroma',
                providers: [{ id: 'legacy-chroma', name: 'Legacy Chroma', type: 'chroma-local', path: './data/memory' }],
            },
        });

        const registry = makeRegistry(settingsPath);
        const snapshot = registry.getRegistrySnapshot();
        expect(snapshot.assignments.find((a) => a.role === StorageRole.CANONICAL_MEMORY)?.providerId).toBe('postgresql:localhost:5432:tala');
        expect(snapshot.assignmentDecisions?.some((d) => d.reasonCode === StorageAssignmentReasonCode.LEGACY_IMPORT_SKIPPED_EXISTING_REGISTRY)).toBe(true);
    });

    it('derived runtime readiness can coexist with degraded canonical authority', () => {
        const registry = makeRegistry(settingsPath);
        registry.addProvider({
            id: 'postgresql:localhost:5432:tala',
            name: 'Canonical',
            kind: StorageProviderKind.POSTGRESQL,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.MANUAL,
            enabled: true,
            auth: { mode: StorageAuthMode.BASIC, status: StorageAuthStatus.AUTHENTICATED, lastCheckedAt: '2026-04-15T12:30:00.000Z', reason: null },
            health: { status: StorageHealthStatus.HEALTHY, checkedAt: '2026-04-15T12:30:00.000Z', reason: null },
        });
        registry.addProvider({
            id: 'filesystem:derived-storage',
            name: 'Derived Filesystem',
            kind: StorageProviderKind.FILESYSTEM,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.MANUAL,
            enabled: true,
            connection: { path: process.cwd() },
            auth: { mode: StorageAuthMode.NONE, status: StorageAuthStatus.NOT_REQUIRED, lastCheckedAt: '2026-04-15T12:30:00.000Z', reason: null },
            health: { status: StorageHealthStatus.HEALTHY, checkedAt: '2026-04-15T12:30:00.000Z', reason: null },
        });
        registry.assignRole('postgresql:localhost:5432:tala', StorageRole.CANONICAL_MEMORY);
        registry.assignRole('filesystem:derived-storage', StorageRole.BLOB_STORE);
        registry.updateProvider({
            id: 'postgresql:localhost:5432:tala',
            auth: { mode: StorageAuthMode.BASIC, status: StorageAuthStatus.BLOCKED, lastCheckedAt: '2026-04-15T12:30:00.000Z', reason: 'auth_failed' },
            health: { status: StorageHealthStatus.DEGRADED, checkedAt: '2026-04-15T12:30:00.000Z', reason: 'db_error' },
        });

        const snapshot = registry.getRegistrySnapshot();
        const summary = buildStorageAuthoritySummary(snapshot);
        const providers = buildProviderVisibilityModels(snapshot, {});
        expect(summary.authorityState.degraded).toBe(true);
        expect(summary.derivedProviders.some((p) => p.providerId === 'filesystem:derived-storage')).toBe(true);
        expect(providers['filesystem:derived-storage'].status.reachable).toBe('reachable');
        expect(providers['postgresql:localhost:5432:tala'].authorityClass).toBe('canonical');
    });

    it('repair/rebuild signal under degraded authority remains explicit and suggestion-only', () => {
        const registry = makeRegistry(settingsPath);
        registry.addProvider({
            id: 'postgresql:localhost:5432:tala',
            name: 'Canonical',
            kind: StorageProviderKind.POSTGRESQL,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.MANUAL,
            enabled: true,
            auth: { mode: StorageAuthMode.BASIC, status: StorageAuthStatus.AUTHENTICATED, lastCheckedAt: null, reason: null },
            health: { status: StorageHealthStatus.HEALTHY, checkedAt: null, reason: null },
        });
        registry.assignRole('postgresql:localhost:5432:tala', StorageRole.CANONICAL_MEMORY);
        registry.updateProvider({
            id: 'postgresql:localhost:5432:tala',
            auth: { mode: StorageAuthMode.BASIC, status: StorageAuthStatus.BLOCKED, lastCheckedAt: null, reason: 'auth_failed' },
            health: { status: StorageHealthStatus.DEGRADED, checkedAt: null, reason: 'db_error' },
        });

        const snapshot = registry.getRegistrySnapshot();
        const summary = buildStorageAuthoritySummary(snapshot);
        expect(summary.recoveryActions).toContain('fix_canonical_provider_connectivity_or_auth');
        expect(summary.canonicalRuntimeAuthority.providerId).toBe('postgresql:localhost:5432:tala');
        expect(summary.registryHealth.state).toBe('degraded');
    });
});
