import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { refreshSettingsFromDisk } from '../../services/SettingsManager';
import { StorageAssignmentPolicyService } from '../../services/storage/StorageAssignmentPolicyService';
import { StorageConfigPersistenceService } from '../../services/storage/storageConfigPersistence';
import { StorageProviderRegistryService } from '../../services/storage/StorageProviderRegistryService';
import {
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

    it('invalid role rejection', () => {
        const registry = makeRegistry(settingsPath);
        registry.addProvider({
            id: 'fs-local',
            name: 'Filesystem',
            kind: StorageProviderKind.FILESYSTEM,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.MANUAL,
        });

        expect(() => registry.assignRole('fs-local', StorageRole.VECTOR_INDEX)).toThrowError(/does not support requested role/);
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

        expect(() => registry.assignRole('s3-archive', StorageRole.CANONICAL_MEMORY)).toThrowError(/not eligible for canonical memory/);
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
    });
});
