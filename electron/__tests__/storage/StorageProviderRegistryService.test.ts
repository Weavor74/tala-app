import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { refreshSettingsFromDisk, saveSettings } from '../../services/SettingsManager';
import { StorageAssignmentPolicyService } from '../../services/storage/StorageAssignmentPolicyService';
import { StorageConfigPersistenceService } from '../../services/storage/storageConfigPersistence';
import { StorageProviderRegistryService } from '../../services/storage/StorageProviderRegistryService';
import {
    StorageAssignmentReasonCode,
    StorageAuthMode,
    StorageAuthStatus,
    StorageHealthStatus,
    StorageLocality,
    StorageOperationErrorCode,
    StorageProviderKind,
    StorageRegistrationMode,
    StorageRole,
} from '../../services/storage/storageTypes';

function makeSettingsPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-storage-registry-'));
    return path.join(dir, 'app_settings.json');
}

function makeRegistry(settingsPath: string): StorageProviderRegistryService {
    const persistence = new StorageConfigPersistenceService(settingsPath);
    return new StorageProviderRegistryService(persistence, new StorageAssignmentPolicyService(), () => '2026-04-14T12:00:00.000Z');
}

describe('StorageProviderRegistryService', () => {
    let settingsPath: string;

    beforeEach(() => {
        settingsPath = makeSettingsPath();
        refreshSettingsFromDisk(settingsPath, 'StorageProviderRegistryService.test.beforeEach');
    });

    it('registry empty-load case', () => {
        const registry = makeRegistry(settingsPath);
        const snapshot = registry.getRegistrySnapshot();

        expect(snapshot.version).toBe(1);
        expect(snapshot.providers).toEqual([]);
        expect(snapshot.assignments).toEqual([]);
    });

    it('add/update/remove provider', () => {
        const registry = makeRegistry(settingsPath);

        registry.addProvider({
            id: 'pg-main',
            name: 'Postgres Main',
            kind: StorageProviderKind.POSTGRESQL,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.MANUAL,
            enabled: true,
        });

        let snapshot = registry.getRegistrySnapshot();
        expect(snapshot.providers).toHaveLength(1);
        expect(snapshot.providers[0].name).toBe('Postgres Main');

        registry.updateProvider({
            id: 'pg-main',
            name: 'Postgres Primary',
            auth: {
                mode: StorageAuthMode.NONE,
                status: StorageAuthStatus.NOT_REQUIRED,
                lastCheckedAt: null,
                reason: null,
            },
            health: {
                status: StorageHealthStatus.HEALTHY,
                checkedAt: '2026-04-14T12:00:00.000Z',
                reason: null,
            },
        });
        snapshot = registry.getRegistrySnapshot();
        expect(snapshot.providers[0].name).toBe('Postgres Primary');
        expect(snapshot.providers[0].health.status).toBe(StorageHealthStatus.HEALTHY);

        registry.removeProvider('pg-main');
        snapshot = registry.getRegistrySnapshot();
        expect(snapshot.providers).toEqual([]);
    });

    it('duplicate id rejection', () => {
        const registry = makeRegistry(settingsPath);
        registry.addProvider({
            id: 'dup-provider',
            name: 'One',
            kind: StorageProviderKind.SQLITE,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.MANUAL,
        });

        expect(() =>
            registry.addProvider({
                id: 'dup-provider',
                name: 'Two',
                kind: StorageProviderKind.POSTGRESQL,
                locality: StorageLocality.LOCAL,
                registrationMode: StorageRegistrationMode.MANUAL,
            }),
        ).toThrowError(/Provider ID already exists/);
    });

    it('provider-not-registered assignment emits deterministic reason code', () => {
        const registry = makeRegistry(settingsPath);
        try {
            registry.assignRole('missing-provider', StorageRole.BLOB_STORE);
            throw new Error('expected assignment to throw');
        } catch (error) {
            const opError = error as { details?: Record<string, unknown> };
            expect(opError.details?.assignmentReasonCode).toBe(StorageAssignmentReasonCode.PROVIDER_NOT_REGISTERED);
        }
    });

    it('invalid role rejection', () => {
        const registry = makeRegistry(settingsPath);
        registry.addProvider({
            id: 'fs-local',
            name: 'Filesystem',
            kind: StorageProviderKind.FILESYSTEM,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.MANUAL,
        });

        try {
            registry.assignRole('fs-local', StorageRole.VECTOR_INDEX);
            throw new Error('expected assignment to throw');
        } catch (error) {
            const opError = error as { details?: Record<string, unknown> };
            expect(opError.details?.assignmentReasonCode).toBe(StorageAssignmentReasonCode.BLOCKED_CAPABILITY_MISMATCH);
        }
    });

    it('canonical ineligible provider rejection', () => {
        const registry = makeRegistry(settingsPath);
        registry.addProvider({
            id: 's3-archive',
            name: 'S3 Archive',
            kind: StorageProviderKind.S3,
            locality: StorageLocality.REMOTE,
            registrationMode: StorageRegistrationMode.MANUAL,
            auth: {
                mode: StorageAuthMode.API_KEY,
                status: StorageAuthStatus.AUTHENTICATED,
                lastCheckedAt: '2026-04-14T12:00:00.000Z',
                reason: null,
            },
            health: {
                status: StorageHealthStatus.HEALTHY,
                checkedAt: '2026-04-14T12:00:00.000Z',
                reason: null,
            },
        });

        try {
            registry.assignRole('s3-archive', StorageRole.CANONICAL_MEMORY);
            throw new Error('expected assignment to throw');
        } catch (error) {
            const opError = error as { details?: Record<string, unknown> };
            expect(opError.details?.assignmentReasonCode).toBe(StorageAssignmentReasonCode.BLOCKED_CAPABILITY_MISMATCH);
        }
    });

    it('blocked removal of sole canonical provider', () => {
        const registry = makeRegistry(settingsPath);
        registry.addProvider({
            id: 'pg-canonical',
            name: 'Canonical DB',
            kind: StorageProviderKind.POSTGRESQL,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.MANUAL,
            health: {
                status: StorageHealthStatus.HEALTHY,
                checkedAt: null,
                reason: null,
            },
        });
        registry.assignRole('pg-canonical', StorageRole.CANONICAL_MEMORY);

        try {
            registry.removeProvider('pg-canonical');
            throw new Error('expected removal to throw');
        } catch (error) {
            const opError = error as { code?: StorageOperationErrorCode };
            expect(opError.code).toBe(StorageOperationErrorCode.SOLE_CANONICAL_PROVIDER_REQUIRED);
        }
    });

    it('blocked disable of sole canonical provider', () => {
        const registry = makeRegistry(settingsPath);
        registry.addProvider({
            id: 'sqlite-canonical',
            name: 'Canonical SQLite',
            kind: StorageProviderKind.SQLITE,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.MANUAL,
            health: {
                status: StorageHealthStatus.HEALTHY,
                checkedAt: null,
                reason: null,
            },
        });
        registry.assignRole('sqlite-canonical', StorageRole.CANONICAL_MEMORY);

        try {
            registry.setProviderEnabled('sqlite-canonical', false);
            throw new Error('expected disable to throw');
        } catch (error) {
            const opError = error as { code?: StorageOperationErrorCode };
            expect(opError.code).toBe(StorageOperationErrorCode.SOLE_CANONICAL_PROVIDER_REQUIRED);
        }
    });

    it('persisted snapshot roundtrip', () => {
        const registry = makeRegistry(settingsPath);
        registry.addProvider({
            id: 'pg-roundtrip',
            name: 'Roundtrip PG',
            kind: StorageProviderKind.POSTGRESQL,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.MANUAL,
            health: {
                status: StorageHealthStatus.HEALTHY,
                checkedAt: null,
                reason: null,
            },
        });
        registry.assignRole('pg-roundtrip', StorageRole.CANONICAL_MEMORY);
        registry.assignRole('pg-roundtrip', StorageRole.DOCUMENT_STORE);

        const reloaded = makeRegistry(settingsPath);
        const snapshot = reloaded.getRegistrySnapshot();
        expect(snapshot.providers).toHaveLength(1);
        expect(snapshot.assignments.map((item) => item.role).sort()).toEqual([
            StorageRole.CANONICAL_MEMORY,
            StorageRole.DOCUMENT_STORE,
        ]);
        expect(snapshot.providers[0].assignedRoles.sort()).toEqual([
            StorageRole.CANONICAL_MEMORY,
            StorageRole.DOCUMENT_STORE,
        ]);
        expect(snapshot.assignmentDecisions?.some(
            (decision) => decision.reasonCode === StorageAssignmentReasonCode.EXPLICIT_ASSIGNMENT_PRESERVED,
        )).toBe(true);
    });

    it('normalization preserves invalid role assignment and emits deterministic blocked reason code', () => {
        const ok = saveSettings(settingsPath, {
            storageRegistry: {
                version: 1,
                updatedAt: '2026-04-14T12:00:00.000Z',
                providers: [
                    {
                        id: 'filesystem:storage',
                        name: 'Filesystem',
                        kind: StorageProviderKind.FILESYSTEM,
                        locality: StorageLocality.LOCAL,
                        registrationMode: StorageRegistrationMode.MANUAL,
                        supportedRoles: [StorageRole.BLOB_STORE],
                        capabilities: ['blob_storage'],
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
                        assignedRoles: [],
                        createdAt: '2026-04-14T12:00:00.000Z',
                        updatedAt: '2026-04-14T12:00:00.000Z',
                    },
                ],
                assignments: [
                    {
                        role: StorageRole.VECTOR_INDEX,
                        providerId: 'filesystem:storage',
                        assignedAt: '2026-04-14T12:00:00.000Z',
                    },
                ],
            },
        });
        expect(ok).toBe(true);
        refreshSettingsFromDisk(settingsPath, 'StorageProviderRegistryService.test.invalid_assignment_preserved');

        const registry = makeRegistry(settingsPath);
        const snapshot = registry.getRegistrySnapshot();
        expect(snapshot.assignments.find((assignment) => assignment.role === StorageRole.VECTOR_INDEX)?.providerId).toBe('filesystem:storage');
        expect(snapshot.assignmentDecisions?.some(
            (decision) => decision.role === StorageRole.VECTOR_INDEX
                && decision.reasonCode === StorageAssignmentReasonCode.BLOCKED_CAPABILITY_MISMATCH,
        )).toBe(true);
    });
});
