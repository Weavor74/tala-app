import { loadSettings, saveSettings } from '../SettingsManager';
import {
    createStorageOperationError,
    PersistedStorageConfig,
    StorageOperationErrorCode,
    StorageProviderRecord,
    StorageRoleAssignment,
} from './storageTypes';

export const STORAGE_CONFIG_VERSION = 1;
const STORAGE_REGISTRY_FIELD = 'storageRegistry';

function nowIso(): string {
    return new Date().toISOString();
}

function createDefaultConfig(): PersistedStorageConfig {
    return {
        version: STORAGE_CONFIG_VERSION,
        providers: [],
        assignments: [],
        updatedAt: nowIso(),
    };
}

function sanitizeProviders(input: unknown): StorageProviderRecord[] {
    if (!Array.isArray(input)) {
        return [];
    }
    return input.filter((item): item is StorageProviderRecord => {
        const candidate = item as Partial<StorageProviderRecord> | null | undefined;
        return !!candidate && typeof candidate.id === 'string' && typeof candidate.kind === 'string';
    });
}

function sanitizeAssignments(input: unknown): StorageRoleAssignment[] {
    if (!Array.isArray(input)) {
        return [];
    }
    return input.filter((item): item is StorageRoleAssignment => {
        const candidate = item as Partial<StorageRoleAssignment> | null | undefined;
        return !!candidate && typeof candidate.providerId === 'string' && typeof candidate.role === 'string';
    });
}

function sanitizePersistedConfig(input: unknown): PersistedStorageConfig {
    if (!input || typeof input !== 'object') {
        return createDefaultConfig();
    }
    const candidate = input as Partial<PersistedStorageConfig>;
    const version = typeof candidate.version === 'number' ? candidate.version : STORAGE_CONFIG_VERSION;
    return {
        version,
        providers: sanitizeProviders(candidate.providers),
        assignments: sanitizeAssignments(candidate.assignments),
        updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : nowIso(),
    };
}

export class StorageConfigPersistenceService {
    constructor(private readonly settingsPath: string) {}

    public getSettingsPath(): string {
        return this.settingsPath;
    }

    public loadConfig(): PersistedStorageConfig {
        try {
            const settings = loadSettings(this.settingsPath, 'StorageConfigPersistence.load');
            return sanitizePersistedConfig(settings[STORAGE_REGISTRY_FIELD]);
        } catch (error) {
            if (error instanceof Error && error.name === 'StorageOperationError') {
                throw error;
            }
            throw createStorageOperationError(
                StorageOperationErrorCode.PERSISTENCE_LOAD_FAILED,
                'Failed to load storage registry config',
                { cause: error instanceof Error ? error.message : String(error) },
            );
        }
    }

    public saveConfig(config: PersistedStorageConfig): void {
        const sanitized = sanitizePersistedConfig(config);
        sanitized.version = STORAGE_CONFIG_VERSION;
        sanitized.updatedAt = nowIso();

        const settings = loadSettings(this.settingsPath, 'StorageConfigPersistence.save');
        settings[STORAGE_REGISTRY_FIELD] = sanitized;

        const ok = saveSettings(this.settingsPath, settings);
        if (!ok) {
            throw createStorageOperationError(
                StorageOperationErrorCode.PERSISTENCE_SAVE_FAILED,
                'Failed to persist storage registry config',
                { settingsPath: this.settingsPath },
            );
        }
    }
}
