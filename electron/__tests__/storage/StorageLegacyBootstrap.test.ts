import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { refreshSettingsFromDisk, saveSettings } from '../../services/SettingsManager';
import { StorageConfigPersistenceService } from '../../services/storage/storageConfigPersistence';
import { StorageProviderRegistryService } from '../../services/storage/StorageProviderRegistryService';
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
} from '../../services/storage/storageTypes';

function makeSettingsPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-storage-bootstrap-'));
    return path.join(dir, 'app_settings.json');
}

function makeRegistry(settingsPath: string): StorageProviderRegistryService {
    const persistence = new StorageConfigPersistenceService(settingsPath);
    return new StorageProviderRegistryService(persistence, undefined, () => '2026-04-14T12:00:00.000Z');
}

function writeSettings(settingsPath: string, patch: Record<string, unknown>): void {
    const ok = saveSettings(settingsPath, patch);
    if (!ok) {
        throw new Error('Failed to write settings for test');
    }
    refreshSettingsFromDisk(settingsPath, 'StorageLegacyBootstrap.test.writeSettings');
}

describe('Storage legacy bootstrap hydration', () => {
    let settingsPath: string;

    beforeEach(() => {
        settingsPath = makeSettingsPath();
        refreshSettingsFromDisk(settingsPath, 'StorageLegacyBootstrap.test.beforeEach');
    });

    it('empty new registry + existing PostgreSQL config -> provider imported and canonical assignment is blocked with deterministic reason', () => {
        writeSettings(settingsPath, {
            database: {
                host: 'localhost',
                port: 5432,
                database: 'tala',
            },
            storage: {
                activeProviderId: 'legacy-none',
                providers: [],
            },
        });

        const registry = makeRegistry(settingsPath);
        const snapshot = registry.getRegistrySnapshot();

        const postgres = snapshot.providers.find((provider) => provider.kind === StorageProviderKind.POSTGRESQL);
        expect(postgres).toBeTruthy();
        expect(snapshot.assignments.find((assignment) => assignment.role === StorageRole.CANONICAL_MEMORY)?.providerId).toBeUndefined();
        expect(snapshot.assignmentDecisions?.some(
            (decision) => decision.role === StorageRole.CANONICAL_MEMORY
                && decision.reasonCode === StorageAssignmentReasonCode.BLOCKED_AUTH_INVALID,
        )).toBe(true);
    });

    it('empty new registry + filesystem paths -> filesystem provider imported and blob/document/backup/artifact assigned', () => {
        writeSettings(settingsPath, {
            backup: {
                localPath: './custom-backups',
            },
            storage: {
                activeProviderId: 'legacy-none',
                providers: [],
            },
        });

        const registry = makeRegistry(settingsPath);
        const snapshot = registry.getRegistrySnapshot();

        const blobAssignment = snapshot.assignments.find((assignment) => assignment.role === StorageRole.BLOB_STORE);
        const docAssignment = snapshot.assignments.find((assignment) => assignment.role === StorageRole.DOCUMENT_STORE);
        const backupAssignment = snapshot.assignments.find((assignment) => assignment.role === StorageRole.BACKUP_TARGET);
        const artifactAssignment = snapshot.assignments.find((assignment) => assignment.role === StorageRole.ARTIFACT_STORE);

        expect(blobAssignment?.providerId.startsWith('filesystem:')).toBe(true);
        expect(docAssignment?.providerId.startsWith('filesystem:')).toBe(true);
        expect(backupAssignment?.providerId.startsWith('filesystem:')).toBe(true);
        expect(artifactAssignment?.providerId.startsWith('filesystem:')).toBe(true);
    });

    it('empty new registry + existing vector config -> vector_index assigned deterministically', () => {
        writeSettings(settingsPath, {
            database: {
                host: 'localhost',
                port: 5432,
                database: 'tala',
            },
            storage: {
                activeProviderId: 'legacy-chroma',
                providers: [
                    {
                        id: 'legacy-chroma',
                        name: 'Legacy Chroma',
                        type: 'chroma-local',
                        path: './data/memory',
                    },
                ],
            },
        });

        const registry = makeRegistry(settingsPath);
        const snapshot = registry.getRegistrySnapshot();

        const vectorAssignment = snapshot.assignments.find((assignment) => assignment.role === StorageRole.VECTOR_INDEX);
        expect(vectorAssignment).toBeTruthy();
        expect(vectorAssignment?.providerId.startsWith('chromadb:')).toBe(true);
    });

    it('idempotent bootstrap does not duplicate providers', () => {
        writeSettings(settingsPath, {
            storage: {
                activeProviderId: 'legacy-chroma',
                providers: [
                    {
                        id: 'legacy-chroma',
                        name: 'Legacy Chroma',
                        type: 'chroma-local',
                        path: './data/memory',
                    },
                ],
            },
        });

        const registryOne = makeRegistry(settingsPath);
        const snapshotOne = registryOne.getRegistrySnapshot();
        const providerIdsOne = snapshotOne.providers.map((provider) => provider.id).sort();

        const registryTwo = makeRegistry(settingsPath);
        const snapshotTwo = registryTwo.getRegistrySnapshot();
        const providerIdsTwo = snapshotTwo.providers.map((provider) => provider.id).sort();

        expect(providerIdsTwo).toEqual(providerIdsOne);
    });

    it('bootstrap completion state is persisted and idempotent across reruns', () => {
        writeSettings(settingsPath, {
            storage: {
                activeProviderId: 'legacy-chroma',
                providers: [
                    {
                        id: 'legacy-chroma',
                        name: 'Legacy Chroma',
                        type: 'chroma-local',
                        path: './data/memory',
                    },
                ],
            },
        });

        const firstRegistry = makeRegistry(settingsPath);
        const firstSnapshot = firstRegistry.getRegistrySnapshot();
        expect(firstSnapshot.legacyBootstrap?.completed).toBe(true);
        expect(firstSnapshot.legacyBootstrap?.lastOutcome).toMatch(/completed/);
        const runCountAfterFirstBootstrap = firstSnapshot.legacyBootstrap?.runCount ?? 0;
        expect(runCountAfterFirstBootstrap).toBeGreaterThan(0);

        const secondRegistry = makeRegistry(settingsPath);
        const secondSnapshot = secondRegistry.getRegistrySnapshot();
        expect(secondSnapshot.legacyBootstrap?.completed).toBe(true);
        expect(secondSnapshot.legacyBootstrap?.runCount).toBe(runCountAfterFirstBootstrap);
    });

    it('bootstrap does not duplicate imported PostgreSQL provider across reloads', () => {
        writeSettings(settingsPath, {
            database: {
                host: 'localhost',
                port: 5432,
                database: 'tala',
            },
            storage: {
                activeProviderId: 'legacy-none',
                providers: [],
            },
        });

        const firstRegistry = makeRegistry(settingsPath);
        const firstSnapshot = firstRegistry.getRegistrySnapshot();
        const firstPgProviders = firstSnapshot.providers.filter((provider) => provider.kind === StorageProviderKind.POSTGRESQL);
        expect(firstPgProviders).toHaveLength(1);

        const secondRegistry = makeRegistry(settingsPath);
        const secondSnapshot = secondRegistry.getRegistrySnapshot();
        const secondPgProviders = secondSnapshot.providers.filter((provider) => provider.kind === StorageProviderKind.POSTGRESQL);
        expect(secondPgProviders).toHaveLength(1);
        expect(secondPgProviders[0].id).toBe(firstPgProviders[0].id);
    });

    it('existing explicit registry assignments are preserved', () => {
        writeSettings(settingsPath, {
            storage: {
                activeProviderId: 'legacy-chroma',
                providers: [
                    {
                        id: 'legacy-chroma',
                        name: 'Legacy Chroma',
                        type: 'chroma-local',
                        path: './data/memory',
                    },
                ],
            },
            storageRegistry: {
                version: 1,
                updatedAt: '2026-04-14T12:00:00.000Z',
                providers: [
                    {
                        id: 'sqlite:legacy-canonical.db',
                        name: 'Explicit SQLite Canonical',
                        kind: StorageProviderKind.SQLITE,
                        locality: StorageLocality.LOCAL,
                        registrationMode: StorageRegistrationMode.MANUAL,
                        supportedRoles: [StorageRole.CANONICAL_MEMORY, StorageRole.DOCUMENT_STORE, StorageRole.BACKUP_TARGET],
                        capabilities: [
                            StorageCapability.STRUCTURED_RECORDS,
                            StorageCapability.DOCUMENT_STORAGE,
                            StorageCapability.BACKUP_TARGET,
                        ],
                        enabled: true,
                        connection: {
                            path: 'legacy-canonical.db',
                        },
                        auth: {
                            mode: StorageAuthMode.NONE,
                            status: StorageAuthStatus.NOT_REQUIRED,
                            lastCheckedAt: null,
                            reason: null,
                        },
                        health: {
                            status: StorageHealthStatus.HEALTHY,
                            checkedAt: null,
                            reason: null,
                        },
                        assignedRoles: [StorageRole.CANONICAL_MEMORY],
                        createdAt: '2026-04-14T12:00:00.000Z',
                        updatedAt: '2026-04-14T12:00:00.000Z',
                    },
                ],
                assignments: [
                    {
                        role: StorageRole.CANONICAL_MEMORY,
                        providerId: 'sqlite:legacy-canonical.db',
                        assignedAt: '2026-04-14T12:00:00.000Z',
                    },
                ],
            },
        });

        const registry = makeRegistry(settingsPath);
        const snapshot = registry.getRegistrySnapshot();

        const canonicalAssignment = snapshot.assignments.find((assignment) => assignment.role === StorageRole.CANONICAL_MEMORY);
        expect(canonicalAssignment?.providerId).toBe('sqlite:legacy-canonical.db');
        expect(snapshot.assignmentDecisions?.some(
            (decision) => decision.role === StorageRole.CANONICAL_MEMORY
                && decision.reasonCode === StorageAssignmentReasonCode.EXPLICIT_ASSIGNMENT_PRESERVED,
        )).toBe(true);
    });

    it('partial registry with missing roles only fills safe deterministic gaps', () => {
        writeSettings(settingsPath, {
            storageRegistry: {
                version: 1,
                updatedAt: '2026-04-14T12:00:00.000Z',
                providers: [
                    {
                        id: 'chromadb:http://127.0.0.1:8000',
                        name: 'Existing Chroma',
                        kind: StorageProviderKind.CHROMADB,
                        locality: StorageLocality.LOCAL,
                        registrationMode: StorageRegistrationMode.MANUAL,
                        supportedRoles: [StorageRole.VECTOR_INDEX, StorageRole.DOCUMENT_STORE],
                        capabilities: [StorageCapability.VECTOR_INDEXING, StorageCapability.DOCUMENT_STORAGE],
                        enabled: true,
                        connection: {
                            endpoint: 'http://127.0.0.1:8000',
                        },
                        auth: {
                            mode: StorageAuthMode.NONE,
                            status: StorageAuthStatus.NOT_REQUIRED,
                            lastCheckedAt: null,
                            reason: null,
                        },
                        health: {
                            status: StorageHealthStatus.HEALTHY,
                            checkedAt: null,
                            reason: null,
                        },
                        assignedRoles: [StorageRole.VECTOR_INDEX],
                        createdAt: '2026-04-14T12:00:00.000Z',
                        updatedAt: '2026-04-14T12:00:00.000Z',
                    },
                ],
                assignments: [
                    {
                        role: StorageRole.VECTOR_INDEX,
                        providerId: 'chromadb:http://127.0.0.1:8000',
                        assignedAt: '2026-04-14T12:00:00.000Z',
                    },
                ],
            },
        });

        const previousDbHost = process.env.TALA_DB_HOST;
        process.env.TALA_DB_HOST = 'localhost';
        try {
            const registry = makeRegistry(settingsPath);
            const snapshot = registry.getRegistrySnapshot();

            const vectorAssignment = snapshot.assignments.find((assignment) => assignment.role === StorageRole.VECTOR_INDEX);
            expect(vectorAssignment?.providerId).toBe('chromadb:http://127.0.0.1:8000');
            expect(snapshot.assignments.length).toBeGreaterThan(1);
            expect(snapshot.assignmentDecisions?.some(
                (decision) => decision.reasonCode === StorageAssignmentReasonCode.FILLED_MISSING_ROLE_FROM_BOOTSTRAP,
            )).toBe(true);
        } finally {
            if (previousDbHost === undefined) {
                delete process.env.TALA_DB_HOST;
            } else {
                process.env.TALA_DB_HOST = previousDbHost;
            }
        }
    });

    it('snapshot after bootstrap reports deterministic blocked reason codes for missing canonical role', () => {
        writeSettings(settingsPath, {
            backup: {
                localPath: './custom-backups',
            },
            storage: {
                activeProviderId: 'legacy-chroma',
                providers: [
                    {
                        id: 'legacy-chroma',
                        name: 'Legacy Chroma',
                        type: 'chroma-local',
                        path: './data/memory',
                    },
                ],
            },
        });

        const registry = makeRegistry(settingsPath);
        const snapshot = registry.getRegistrySnapshot();

        const assignedRoles = new Set(snapshot.assignments.map((assignment) => assignment.role));
        expect(assignedRoles.has(StorageRole.CANONICAL_MEMORY)).toBe(false);
        expect(assignedRoles.has(StorageRole.VECTOR_INDEX)).toBe(true);
        expect(assignedRoles.has(StorageRole.BLOB_STORE)).toBe(true);
        expect(assignedRoles.has(StorageRole.DOCUMENT_STORE)).toBe(true);
        expect(assignedRoles.has(StorageRole.BACKUP_TARGET)).toBe(true);
        expect(assignedRoles.has(StorageRole.ARTIFACT_STORE)).toBe(true);
        expect(snapshot.assignmentDecisions?.some(
            (decision) => decision.role === StorageRole.CANONICAL_MEMORY
                && decision.reasonCode === StorageAssignmentReasonCode.BLOCKED_AUTH_INVALID,
        )).toBe(true);
    });

    it('explicit providers override bootstrap candidates for missing role gaps', () => {
        writeSettings(settingsPath, {
            storageRegistry: {
                version: 1,
                updatedAt: '2026-04-14T12:00:00.000Z',
                providers: [
                    {
                        id: 'sqlite:manual-canonical.db',
                        name: 'Manual SQLite Canonical',
                        kind: StorageProviderKind.SQLITE,
                        locality: StorageLocality.LOCAL,
                        registrationMode: StorageRegistrationMode.MANUAL,
                        supportedRoles: [StorageRole.CANONICAL_MEMORY, StorageRole.DOCUMENT_STORE],
                        capabilities: [StorageCapability.STRUCTURED_RECORDS, StorageCapability.DOCUMENT_STORAGE],
                        enabled: true,
                        connection: { path: 'manual-canonical.db' },
                        auth: {
                            mode: StorageAuthMode.NONE,
                            status: StorageAuthStatus.NOT_REQUIRED,
                            lastCheckedAt: null,
                            reason: null,
                        },
                        health: {
                            status: StorageHealthStatus.HEALTHY,
                            checkedAt: null,
                            reason: null,
                        },
                        assignedRoles: [],
                        createdAt: '2026-04-14T12:00:00.000Z',
                        updatedAt: '2026-04-14T12:00:00.000Z',
                    },
                ],
                assignments: [],
            },
            database: {
                host: 'localhost',
                port: 5432,
                database: 'tala',
            },
        });

        const registry = makeRegistry(settingsPath);
        const snapshot = registry.getRegistrySnapshot();
        const canonicalAssignment = snapshot.assignments.find((assignment) => assignment.role === StorageRole.CANONICAL_MEMORY);
        expect(canonicalAssignment?.providerId).toBe('sqlite:manual-canonical.db');
        expect(canonicalAssignment?.assignmentReasonCode).toBe(StorageAssignmentReasonCode.FILLED_MISSING_ROLE_FROM_BOOTSTRAP);
    });

    it('partial/broken legacy input imports valid providers and blocks invalid providers from assignment', () => {
        writeSettings(settingsPath, {
            storage: {
                activeProviderId: 'legacy-chroma',
                providers: [
                    {
                        id: 'legacy-chroma',
                        name: 'Legacy Chroma',
                        type: 'chroma-local',
                        path: './data/memory',
                    },
                    {
                        id: 'legacy-invalid',
                        name: 'Invalid Legacy Provider',
                        type: 'supabase',
                    },
                    {
                        id: 'legacy-unknown',
                        name: 'Unknown Legacy Provider',
                        type: 'mystery-backend',
                    },
                ],
            },
        });

        const registry = makeRegistry(settingsPath);
        const snapshot = registry.getRegistrySnapshot();
        const blockedLegacy = snapshot.providers.filter((provider) => provider.id.startsWith('legacy-invalid:'));
        expect(blockedLegacy.length).toBeGreaterThan(0);
        expect(blockedLegacy.every((provider) => provider.enabled === false)).toBe(true);
        expect(blockedLegacy.every((provider) => provider.auth.status === StorageAuthStatus.BLOCKED)).toBe(true);
        expect(snapshot.assignments.some((assignment) => blockedLegacy.some((provider) => provider.id === assignment.providerId))).toBe(false);
    });

    it('legacy bootstrap skip emits explicit registry skip reason code', () => {
        writeSettings(settingsPath, {
            storageRegistry: {
                version: 1,
                updatedAt: '2026-04-14T12:00:00.000Z',
                providers: [
                    {
                        id: 'sqlite:canonical.db',
                        name: 'Canonical SQLite',
                        kind: StorageProviderKind.SQLITE,
                        locality: StorageLocality.LOCAL,
                        registrationMode: StorageRegistrationMode.MANUAL,
                        supportedRoles: [StorageRole.CANONICAL_MEMORY, StorageRole.DOCUMENT_STORE, StorageRole.BACKUP_TARGET],
                        capabilities: [StorageCapability.STRUCTURED_RECORDS, StorageCapability.DOCUMENT_STORAGE, StorageCapability.BACKUP_TARGET],
                        enabled: true,
                        connection: { path: 'canonical.db' },
                        auth: {
                            mode: StorageAuthMode.NONE,
                            status: StorageAuthStatus.NOT_REQUIRED,
                            lastCheckedAt: null,
                            reason: null,
                        },
                        health: {
                            status: StorageHealthStatus.HEALTHY,
                            checkedAt: null,
                            reason: null,
                        },
                        assignedRoles: [StorageRole.CANONICAL_MEMORY, StorageRole.DOCUMENT_STORE, StorageRole.BACKUP_TARGET],
                        createdAt: '2026-04-14T12:00:00.000Z',
                        updatedAt: '2026-04-14T12:00:00.000Z',
                    },
                    {
                        id: 'chromadb:http://127.0.0.1:8000',
                        name: 'Chroma',
                        kind: StorageProviderKind.CHROMADB,
                        locality: StorageLocality.LOCAL,
                        registrationMode: StorageRegistrationMode.MANUAL,
                        supportedRoles: [StorageRole.VECTOR_INDEX],
                        capabilities: [StorageCapability.VECTOR_INDEXING],
                        enabled: true,
                        connection: { endpoint: 'http://127.0.0.1:8000' },
                        auth: {
                            mode: StorageAuthMode.NONE,
                            status: StorageAuthStatus.NOT_REQUIRED,
                            lastCheckedAt: null,
                            reason: null,
                        },
                        health: {
                            status: StorageHealthStatus.HEALTHY,
                            checkedAt: null,
                            reason: null,
                        },
                        assignedRoles: [StorageRole.VECTOR_INDEX],
                        createdAt: '2026-04-14T12:00:00.000Z',
                        updatedAt: '2026-04-14T12:00:00.000Z',
                    },
                    {
                        id: 'filesystem:storage',
                        name: 'FS',
                        kind: StorageProviderKind.FILESYSTEM,
                        locality: StorageLocality.LOCAL,
                        registrationMode: StorageRegistrationMode.MANUAL,
                        supportedRoles: [StorageRole.BLOB_STORE, StorageRole.ARTIFACT_STORE],
                        capabilities: [StorageCapability.BLOB_STORAGE, StorageCapability.ARTIFACT_STORAGE],
                        enabled: true,
                        connection: { path: 'storage' },
                        auth: {
                            mode: StorageAuthMode.NONE,
                            status: StorageAuthStatus.NOT_REQUIRED,
                            lastCheckedAt: null,
                            reason: null,
                        },
                        health: {
                            status: StorageHealthStatus.HEALTHY,
                            checkedAt: null,
                            reason: null,
                        },
                        assignedRoles: [StorageRole.BLOB_STORE, StorageRole.ARTIFACT_STORE],
                        createdAt: '2026-04-14T12:00:00.000Z',
                        updatedAt: '2026-04-14T12:00:00.000Z',
                    },
                ],
                assignments: [
                    { role: StorageRole.CANONICAL_MEMORY, providerId: 'sqlite:canonical.db', assignedAt: '2026-04-14T12:00:00.000Z' },
                    { role: StorageRole.VECTOR_INDEX, providerId: 'chromadb:http://127.0.0.1:8000', assignedAt: '2026-04-14T12:00:00.000Z' },
                    { role: StorageRole.BLOB_STORE, providerId: 'filesystem:storage', assignedAt: '2026-04-14T12:00:00.000Z' },
                    { role: StorageRole.DOCUMENT_STORE, providerId: 'sqlite:canonical.db', assignedAt: '2026-04-14T12:00:00.000Z' },
                    { role: StorageRole.BACKUP_TARGET, providerId: 'sqlite:canonical.db', assignedAt: '2026-04-14T12:00:00.000Z' },
                    { role: StorageRole.ARTIFACT_STORE, providerId: 'filesystem:storage', assignedAt: '2026-04-14T12:00:00.000Z' },
                ],
            },
            storage: {
                activeProviderId: 'legacy-chroma',
                providers: [{ id: 'legacy-chroma', name: 'Legacy Chroma', type: 'chroma-local', path: './data/memory' }],
            },
        });

        const registry = makeRegistry(settingsPath);
        const snapshot = registry.getRegistrySnapshot();
        expect(snapshot.assignmentDecisions?.some(
            (decision) => decision.reasonCode === StorageAssignmentReasonCode.LEGACY_IMPORT_SKIPPED_EXISTING_REGISTRY,
        )).toBe(true);
    });

    it('explicit legacy re-import is available and does not overwrite explicit assignment', () => {
        writeSettings(settingsPath, {
            storageRegistry: {
                version: 1,
                updatedAt: '2026-04-14T12:00:00.000Z',
                providers: [
                    {
                        id: 'sqlite:explicit-canonical.db',
                        name: 'Explicit Canonical SQLite',
                        kind: StorageProviderKind.SQLITE,
                        locality: StorageLocality.LOCAL,
                        registrationMode: StorageRegistrationMode.MANUAL,
                        supportedRoles: [StorageRole.CANONICAL_MEMORY, StorageRole.DOCUMENT_STORE, StorageRole.BACKUP_TARGET],
                        capabilities: [StorageCapability.STRUCTURED_RECORDS, StorageCapability.DOCUMENT_STORAGE, StorageCapability.BACKUP_TARGET],
                        enabled: true,
                        connection: { path: 'explicit-canonical.db' },
                        auth: {
                            mode: StorageAuthMode.NONE,
                            status: StorageAuthStatus.NOT_REQUIRED,
                            lastCheckedAt: null,
                            reason: null,
                        },
                        health: {
                            status: StorageHealthStatus.HEALTHY,
                            checkedAt: null,
                            reason: null,
                        },
                        assignedRoles: [StorageRole.CANONICAL_MEMORY],
                        createdAt: '2026-04-14T12:00:00.000Z',
                        updatedAt: '2026-04-14T12:00:00.000Z',
                    },
                ],
                assignments: [
                    {
                        role: StorageRole.CANONICAL_MEMORY,
                        providerId: 'sqlite:explicit-canonical.db',
                        assignedAt: '2026-04-14T12:00:00.000Z',
                    },
                ],
            },
            storage: {
                activeProviderId: 'legacy-chroma',
                providers: [
                    {
                        id: 'legacy-chroma',
                        name: 'Legacy Chroma',
                        type: 'chroma-local',
                        path: './data/memory',
                    },
                ],
            },
        });

        const registry = makeRegistry(settingsPath);
        const reimported = registry.reimportLegacyConfig(true);
        const canonicalAssignment = reimported.assignments.find((assignment) => assignment.role === StorageRole.CANONICAL_MEMORY);
        expect(canonicalAssignment?.providerId).toBe('sqlite:explicit-canonical.db');
        expect(reimported.legacyBootstrap?.lastOutcome).toBe('explicit_reimport_completed');
    });
});
