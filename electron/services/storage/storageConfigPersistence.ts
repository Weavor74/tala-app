import { loadSettings, saveSettings } from '../SettingsManager';
import {
    StorageAssignmentDecision,
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

function sanitizeAssignmentDecisions(input: unknown): StorageAssignmentDecision[] {
    if (!Array.isArray(input)) {
        return [];
    }
    return input.filter((item): item is StorageAssignmentDecision => {
        const candidate = item as Partial<StorageAssignmentDecision> | null | undefined;
        return !!candidate
            && typeof candidate.role === 'string'
            && (typeof candidate.providerId === 'string' || candidate.providerId === null)
            && typeof candidate.source === 'string'
            && typeof candidate.outcome === 'string'
            && typeof candidate.reasonCode === 'string'
            && typeof candidate.timestamp === 'string';
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
        assignmentDecisions: sanitizeAssignmentDecisions((candidate as any).assignmentDecisions),
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
                'Failed to load Storage Registry canonical configuration',
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
                'Failed to persist Storage Registry canonical configuration',
                { settingsPath: this.settingsPath },
            );
        }
    }
}
