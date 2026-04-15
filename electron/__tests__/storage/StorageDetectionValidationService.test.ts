import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { refreshSettingsFromDisk } from '../../services/SettingsManager';
import { StorageDetectionService } from '../../services/storage/StorageDetectionService';
import { StorageProviderRegistryService } from '../../services/storage/StorageProviderRegistryService';
import { StorageValidationService } from '../../services/storage/StorageValidationService';
import { StorageConfigPersistenceService } from '../../services/storage/storageConfigPersistence';
import {
    StorageAuthMode,
    StorageAuthStatus,
    StorageHealthStatus,
    StorageLocality,
    StorageProviderKind,
    StorageRegistrationMode,
} from '../../services/storage/storageTypes';

function makeSettingsPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-storage-detect-'));
    return path.join(dir, 'app_settings.json');
}

function makeRegistry(settingsPath: string): StorageProviderRegistryService {
    const persistence = new StorageConfigPersistenceService(settingsPath);
    return new StorageProviderRegistryService(persistence);
}

describe('StorageDetectionService and StorageValidationService', () => {
    let settingsPath: string;

    beforeEach(() => {
        settingsPath = makeSettingsPath();
        refreshSettingsFromDisk(settingsPath, 'StorageDetectionValidationService.beforeEach');
    });

    it('detection returns stable merged results', () => {
        const registry = makeRegistry(settingsPath);
        const detection = new StorageDetectionService(registry, () => settingsPath);

        const first = detection.detectAndMergeProviders();
        const second = detection.detectAndMergeProviders();

        const firstIds = first.mergedSnapshot.providers.map((provider) => provider.id).sort();
        const secondIds = second.mergedSnapshot.providers.map((provider) => provider.id).sort();

        expect(firstIds).toEqual(secondIds);
        expect(second.mergedSnapshot.providers.length).toBe(first.mergedSnapshot.providers.length);
    });

    it('existing manual providers survive detection pass', () => {
        const registry = makeRegistry(settingsPath);
        registry.addProvider({
            id: 'manual-supabase',
            name: 'Manual Supabase',
            kind: StorageProviderKind.SUPABASE,
            locality: StorageLocality.REMOTE,
            registrationMode: StorageRegistrationMode.MANUAL,
            auth: {
                mode: StorageAuthMode.API_KEY,
                status: StorageAuthStatus.UNAUTHENTICATED,
                lastCheckedAt: null,
                reason: 'manual',
            },
            health: {
                status: StorageHealthStatus.UNKNOWN,
                checkedAt: null,
                reason: null,
            },
        });

        const detection = new StorageDetectionService(registry, () => settingsPath);
        const { mergedSnapshot } = detection.detectAndMergeProviders();
        const manual = mergedSnapshot.providers.find((provider) => provider.id === 'manual-supabase');

        expect(manual).toBeTruthy();
        expect(manual?.registrationMode).toBe(StorageRegistrationMode.MANUAL);
    });

    it('validation updates health/auth status', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-storage-fs-'));
        const registry = makeRegistry(settingsPath);
        registry.addProvider({
            id: 'filesystem:test',
            name: 'Filesystem Test',
            kind: StorageProviderKind.FILESYSTEM,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.MANUAL,
            connection: { path: tempDir },
            auth: {
                mode: StorageAuthMode.API_KEY,
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
        const { result } = await validation.validateProvider('filesystem:test');
        const updated = registry.getProviderById('filesystem:test');

        expect(result.ok).toBe(true);
        expect(result.health.status).toBe(StorageHealthStatus.HEALTHY);
        expect(result.auth.status).toBe(StorageAuthStatus.NOT_REQUIRED);
        expect(updated?.health.status).toBe(StorageHealthStatus.HEALTHY);
        expect(updated?.auth.status).toBe(StorageAuthStatus.NOT_REQUIRED);
    });
});
