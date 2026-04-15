import path from 'path';
import { APP_ROOT, resolveStoragePath } from '../PathResolver';
import { loadSettings } from '../SettingsManager';
import { getLastDbHealth } from '../db/initMemoryStore';
import { resolveDatabaseConfig } from '../db/resolveDatabaseConfig';
import { getStorageCapabilityProfile } from './storageCapabilityMatrix';
import { StorageAssignmentPolicyService } from './StorageAssignmentPolicyService';
import { STORAGE_CONFIG_VERSION, StorageConfigPersistenceService } from './storageConfigPersistence';
import {
    StorageAssignmentDecision,
    StorageAssignmentDecisionOutcome,
    StorageAssignmentReasonCode,
    StorageAuthMode,
    StorageAuthStatus,
    StorageHealthStatus,
    StorageLocality,
    PersistedStorageConfig,
    StorageOperationErrorCode,
    StorageProviderKind,
    StorageProviderRecord,
    StorageRegistrationMode,
    StorageRegistrySnapshot,
    StorageRole,
    StorageRoleAssignment,
    createStorageOperationError,
} from './storageTypes';

type LegacyStorageProvider = Record<string, unknown>;

interface InferredProviderSeed {
    id: string;
    name: string;
    kind: StorageProviderRecord['kind'];
    locality: StorageProviderRecord['locality'];
    registrationMode: StorageProviderRecord['registrationMode'];
    connection: StorageProviderRecord['connection'];
    auth?: StorageProviderRecord['auth'];
    health?: StorageProviderRecord['health'];
    explicitLegacy?: boolean;
}

const MAX_ASSIGNMENT_DECISIONS = 200;

export interface AddStorageProviderInput {
    id: string;
    name: string;
    kind: StorageProviderRecord['kind'];
    locality: StorageProviderRecord['locality'];
    registrationMode: StorageProviderRecord['registrationMode'];
    supportedRoles?: StorageRole[];
    capabilities?: StorageProviderRecord['capabilities'];
    enabled?: boolean;
    connection?: StorageProviderRecord['connection'];
    auth?: StorageProviderRecord['auth'];
    health?: StorageProviderRecord['health'];
}

export type UpdateStorageProviderInput = Partial<Omit<StorageProviderRecord, 'id' | 'assignedRoles' | 'createdAt'>> & {
    id: string;
};

function cloneSnapshot(snapshot: StorageRegistrySnapshot): StorageRegistrySnapshot {
    return JSON.parse(JSON.stringify(snapshot)) as StorageRegistrySnapshot;
}

function normalizePathSlashes(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function toAppRootRelativePath(targetPath: string): string {
    const absolute = path.resolve(targetPath);
    const rel = path.relative(APP_ROOT, absolute);
    if (!rel || rel.startsWith('..')) {
        return normalizePathSlashes(absolute);
    }
    return normalizePathSlashes(rel);
}

function normalizeLocalEndpoint(endpoint: string): string {
    return endpoint.trim().toLowerCase();
}

function isLocalHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export class StorageProviderRegistryService {
    private snapshot: StorageRegistrySnapshot;
    private bootstrapApplied = false;
    private assignmentDecisions: StorageAssignmentDecision[] = [];

    constructor(
        private readonly persistence: StorageConfigPersistenceService,
        private readonly policy = new StorageAssignmentPolicyService(),
        private readonly now = () => new Date().toISOString(),
    ) {
        this.snapshot = this.normalizeSnapshot(this.persistence.loadConfig());
        this.assignmentDecisions = this.snapshot.assignmentDecisions ? this.snapshot.assignmentDecisions.slice() : [];
        this.bootstrapFromLegacyConfigIfNeeded();
    }

    public loadPersistedProviderConfig(): StorageRegistrySnapshot {
        this.snapshot = this.normalizeSnapshot(this.persistence.loadConfig());
        this.assignmentDecisions = this.snapshot.assignmentDecisions ? this.snapshot.assignmentDecisions.slice() : [];
        this.bootstrapApplied = false;
        this.bootstrapFromLegacyConfigIfNeeded();
        return this.getRegistrySnapshot();
    }

    public saveProviderConfig(): StorageRegistrySnapshot {
        this.persist();
        return this.getRegistrySnapshot();
    }

    public getRegistrySnapshot(): StorageRegistrySnapshot {
        this.bootstrapFromLegacyConfigIfNeeded();
        return cloneSnapshot({
            ...this.snapshot,
            assignmentDecisions: this.assignmentDecisions.slice(),
        });
    }

    public getProviderById(providerId: string): StorageProviderRecord | null {
        const provider = this.snapshot.providers.find((item) => item.id === providerId);
        if (!provider) {
            return null;
        }
        return JSON.parse(JSON.stringify(provider)) as StorageProviderRecord;
    }

    private pushAssignmentDecision(
        role: StorageRole,
        providerId: string | null,
        source: StorageAssignmentDecision['source'],
        outcome: StorageAssignmentDecisionOutcome,
        reasonCode: StorageAssignmentReasonCode,
        details?: Record<string, unknown>,
    ): void {
        this.assignmentDecisions.push({
            role,
            providerId,
            source,
            outcome,
            reasonCode,
            timestamp: this.now(),
            details,
        });
        if (this.assignmentDecisions.length > MAX_ASSIGNMENT_DECISIONS) {
            this.assignmentDecisions.splice(0, this.assignmentDecisions.length - MAX_ASSIGNMENT_DECISIONS);
        }
    }

    public addProvider(input: AddStorageProviderInput): StorageRegistrySnapshot {
        if (this.snapshot.providers.some((provider) => provider.id === input.id)) {
            throw createStorageOperationError(StorageOperationErrorCode.PROVIDER_ALREADY_EXISTS, 'Provider ID already exists', { providerId: input.id });
        }

        const profile = getStorageCapabilityProfile(input.kind);
        const supportedRoles = [...new Set(input.supportedRoles ?? profile.supportedRoles)];
        const capabilities = [...new Set(input.capabilities ?? profile.defaultCapabilities)];
        const createdAt = this.now();
        const provider: StorageProviderRecord = {
            id: input.id,
            name: input.name,
            kind: input.kind,
            locality: input.locality,
            registrationMode: input.registrationMode,
            supportedRoles,
            capabilities,
            enabled: input.enabled ?? true,
            connection: input.connection ?? {},
            auth: input.auth ?? {
                mode: StorageAuthMode.NONE,
                status: StorageAuthStatus.NOT_REQUIRED,
                lastCheckedAt: null,
                reason: null,
            },
            health: input.health ?? {
                status: StorageHealthStatus.UNKNOWN,
                checkedAt: null,
                reason: null,
            },
            assignedRoles: [],
            createdAt,
            updatedAt: createdAt,
        };

        this.snapshot.providers.push(provider);
        this.assertProviderRoleSet(provider);
        this.persist();
        return this.getRegistrySnapshot();
    }

    public updateProvider(update: UpdateStorageProviderInput): StorageRegistrySnapshot {
        const provider = this.snapshot.providers.find((item) => item.id === update.id);
        if (!provider) {
            throw createStorageOperationError(StorageOperationErrorCode.PROVIDER_NOT_FOUND, 'Provider not found', { providerId: update.id });
        }

        if (update.name !== undefined) provider.name = update.name;
        if (update.kind !== undefined) provider.kind = update.kind;
        if (update.locality !== undefined) provider.locality = update.locality;
        if (update.registrationMode !== undefined) provider.registrationMode = update.registrationMode;
        if (update.supportedRoles !== undefined) provider.supportedRoles = [...new Set(update.supportedRoles)];
        if (update.capabilities !== undefined) provider.capabilities = [...new Set(update.capabilities)];
        if (update.enabled !== undefined && provider.enabled !== update.enabled) {
            if (!update.enabled) {
                this.policy.assertProviderDisable(this.snapshot, provider.id);
            }
            provider.enabled = update.enabled;
        }
        if (update.connection !== undefined) provider.connection = update.connection;
        if (update.auth !== undefined) provider.auth = update.auth;
        if (update.health !== undefined) provider.health = update.health;
        provider.updatedAt = this.now();

        this.assertProviderRoleSet(provider);
        this.persist();
        return this.getRegistrySnapshot();
    }

    public removeProvider(providerId: string): StorageRegistrySnapshot {
        this.policy.assertProviderRemoval(this.snapshot, providerId);

        const nextProviders = this.snapshot.providers.filter((provider) => provider.id !== providerId);
        if (nextProviders.length === this.snapshot.providers.length) {
            throw createStorageOperationError(StorageOperationErrorCode.PROVIDER_NOT_FOUND, 'Provider not found', { providerId });
        }
        this.snapshot.providers = nextProviders;
        this.snapshot.assignments = this.snapshot.assignments.filter((assignment) => assignment.providerId !== providerId);
        this.persist();
        return this.getRegistrySnapshot();
    }

    public setProviderEnabled(providerId: string, enabled: boolean): StorageRegistrySnapshot {
        const provider = this.snapshot.providers.find((item) => item.id === providerId);
        if (!provider) {
            throw createStorageOperationError(StorageOperationErrorCode.PROVIDER_NOT_FOUND, 'Provider not found', { providerId });
        }
        if (!enabled) {
            this.policy.assertProviderDisable(this.snapshot, providerId);
        }
        provider.enabled = enabled;
        provider.updatedAt = this.now();
        this.persist();
        return this.getRegistrySnapshot();
    }

    public assignRole(providerId: string, role: StorageRole): StorageRegistrySnapshot {
        const policyResult = this.policy.validateRoleAssignmentEligibility(this.snapshot, providerId, role);
        if (!policyResult.ok) {
            this.pushAssignmentDecision(
                role,
                providerId,
                'policy',
                'blocked',
                policyResult.assignmentReasonCode,
                policyResult.details,
            );
            this.policy.assertRoleAssignmentEligibility(this.snapshot, providerId, role);
        }

        const existing = this.snapshot.assignments.find((assignment) => assignment.role === role);
        if (existing && existing.providerId === providerId) {
            this.pushAssignmentDecision(
                role,
                providerId,
                'explicit_registry',
                'preserved',
                StorageAssignmentReasonCode.EXPLICIT_ASSIGNMENT_PRESERVED,
            );
            return this.getRegistrySnapshot();
        }

        this.snapshot.assignments = this.snapshot.assignments.filter((assignment) => assignment.role !== role);
        this.snapshot.assignments.push({
            role,
            providerId,
            assignedAt: this.now(),
            assignmentReasonCode: StorageAssignmentReasonCode.EXPLICIT_ASSIGNMENT_PRESERVED,
        });
        this.pushAssignmentDecision(
            role,
            providerId,
            'explicit_registry',
            'applied',
            StorageAssignmentReasonCode.EXPLICIT_ASSIGNMENT_PRESERVED,
        );

        const provider = this.snapshot.providers.find((item) => item.id === providerId);
        if (provider) {
            provider.updatedAt = this.now();
        }

        this.persist();
        return this.getRegistrySnapshot();
    }

    public unassignRole(role: StorageRole): StorageRegistrySnapshot {
        this.policy.assertRoleUnassignment(this.snapshot, role);
        const before = this.snapshot.assignments.length;
        this.snapshot.assignments = this.snapshot.assignments.filter((assignment) => assignment.role !== role);
        if (before === this.snapshot.assignments.length) {
            throw createStorageOperationError(StorageOperationErrorCode.ASSIGNMENT_NOT_FOUND, 'Role assignment not found', { role });
        }
        this.persist();
        return this.getRegistrySnapshot();
    }

    private bootstrapFromLegacyConfigIfNeeded(): void {
        if (this.bootstrapApplied) {
            return;
        }

        const settingsPath = this.persistence.getSettingsPath();
        const settings = loadSettings(settingsPath, 'StorageProviderRegistryService.bootstrapLegacy');
        const bootstrapDecision = this.shouldRunLegacyBootstrap(settings);
        if (!bootstrapDecision.shouldRun) {
            if (bootstrapDecision.skippedExistingExplicitRegistry) {
                this.pushAssignmentDecision(
                    StorageRole.CANONICAL_MEMORY,
                    null,
                    'bootstrap',
                    'skipped',
                    StorageAssignmentReasonCode.LEGACY_IMPORT_SKIPPED_EXISTING_REGISTRY,
                );
            }
            this.bootstrapApplied = true;
            return;
        }

        let changed = false;

        const inferredProviders = this.inferLegacyProviderSeeds(settings);
        for (const seed of inferredProviders.values()) {
            changed = this.ensureProviderFromBootstrap(seed) || changed;
        }

        changed = this.fillDeterministicRoleGaps(inferredProviders, settings) || changed;

        if (changed) {
            this.snapshot = this.normalizeSnapshot(this.snapshot);
            this.snapshot.updatedAt = this.now();
            const payload: PersistedStorageConfig = {
                version: STORAGE_CONFIG_VERSION,
                providers: this.snapshot.providers,
                assignments: this.snapshot.assignments,
                assignmentDecisions: this.assignmentDecisions.slice(),
                updatedAt: this.snapshot.updatedAt,
            };
            this.persistence.saveConfig(payload);
        }

        this.bootstrapApplied = true;
    }

    private shouldRunLegacyBootstrap(settings: Record<string, unknown>): {
        shouldRun: boolean;
        skippedExistingExplicitRegistry: boolean;
    } {
        const hasMissingRequiredRoles = this.snapshot.assignments.length < 6;
        const hasExplicitRegistryContent = this.snapshot.providers.length > 0 || this.snapshot.assignments.length > 0;
        const hasLegacySignal = this.hasLegacyBootstrapSignal(settings);
        if (!hasLegacySignal) {
            return { shouldRun: false, skippedExistingExplicitRegistry: false };
        }
        if (hasExplicitRegistryContent) {
            return {
                shouldRun: hasMissingRequiredRoles,
                skippedExistingExplicitRegistry: !hasMissingRequiredRoles,
            };
        }
        return { shouldRun: true, skippedExistingExplicitRegistry: false };
    }

    private hasLegacyBootstrapSignal(settings: Record<string, unknown>): boolean {
        const legacyStorage = settings.storage as Record<string, unknown> | undefined;
        const legacyProviders = Array.isArray(legacyStorage?.providers) ? legacyStorage.providers : [];
        if (legacyProviders.length > 0) {
            return true;
        }

        const backupPathRaw = (settings.backup as Record<string, unknown> | undefined)?.localPath;
        if (typeof backupPathRaw === 'string' && backupPathRaw.trim().length > 0) {
            return true;
        }

        const settingsDatabase = settings.database as Record<string, unknown> | undefined;
        if (settingsDatabase && typeof settingsDatabase.host === 'string' && settingsDatabase.host.trim().length > 0) {
            return true;
        }

        if (process.env.TALA_DB_CONNECTION_STRING || process.env.TALA_DB_HOST || process.env.TALA_DB_NAME) {
            return true;
        }

        return false;
    }

    private inferLegacyProviderSeeds(settings: Record<string, unknown>): Map<string, InferredProviderSeed> {
        const seeds = new Map<string, InferredProviderSeed>();
        const legacyStorage = settings.storage as Record<string, unknown> | undefined;
        const legacyProviders = Array.isArray(legacyStorage?.providers)
            ? legacyStorage.providers.filter((provider): provider is LegacyStorageProvider => !!provider && typeof provider === 'object')
            : [];

        const filesystemStoragePath = resolveStoragePath('storage');
        const filesystemStorageRelativePath = toAppRootRelativePath(filesystemStoragePath);
        seeds.set(`filesystem:${filesystemStorageRelativePath}`, {
            id: `filesystem:${filesystemStorageRelativePath}`,
            name: 'Filesystem Storage',
            kind: StorageProviderKind.FILESYSTEM,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.SYSTEM,
            connection: {
                path: filesystemStoragePath,
                workspaceRelativePath: filesystemStorageRelativePath,
            },
            auth: {
                mode: StorageAuthMode.NONE,
                status: StorageAuthStatus.NOT_REQUIRED,
                lastCheckedAt: null,
                reason: null,
            },
            health: {
                status: StorageHealthStatus.UNKNOWN,
                checkedAt: null,
                reason: null,
            },
            explicitLegacy: true,
        });

        const backupPathRaw = (settings.backup as Record<string, unknown> | undefined)?.localPath;
        if (typeof backupPathRaw === 'string' && backupPathRaw.trim().length > 0) {
            const absoluteBackupPath = path.isAbsolute(backupPathRaw)
                ? backupPathRaw
                : path.resolve(APP_ROOT, backupPathRaw);
            const relativeBackupPath = toAppRootRelativePath(absoluteBackupPath);
            seeds.set(`filesystem:${relativeBackupPath}`, {
                id: `filesystem:${relativeBackupPath}`,
                name: 'Backup Filesystem',
                kind: StorageProviderKind.FILESYSTEM,
                locality: StorageLocality.LOCAL,
                registrationMode: StorageRegistrationMode.MANUAL,
                connection: {
                    path: absoluteBackupPath,
                    workspaceRelativePath: relativeBackupPath,
                },
                explicitLegacy: true,
            });
        }

        const artifactPath = resolveStoragePath(path.join('reflection', 'artifacts'));
        const artifactRelativePath = toAppRootRelativePath(artifactPath);
        seeds.set(`filesystem:${artifactRelativePath}`, {
            id: `filesystem:${artifactRelativePath}`,
            name: 'Artifact Filesystem',
            kind: StorageProviderKind.FILESYSTEM,
            locality: StorageLocality.LOCAL,
            registrationMode: StorageRegistrationMode.SYSTEM,
            connection: {
                path: artifactPath,
                workspaceRelativePath: artifactRelativePath,
            },
            explicitLegacy: true,
        });

        const databaseConfig = resolveDatabaseConfig();
        if (databaseConfig.host && databaseConfig.database) {
            const host = databaseConfig.host.toLowerCase();
            const providerId = `postgresql:${host}:${databaseConfig.port}:${databaseConfig.database}`;
            const dbHealth = getLastDbHealth();
            const healthStatus = dbHealth
                ? (dbHealth.reachable ? StorageHealthStatus.HEALTHY : StorageHealthStatus.OFFLINE)
                : StorageHealthStatus.UNKNOWN;
            const authStatus = dbHealth
                ? (dbHealth.authenticated ? StorageAuthStatus.AUTHENTICATED : StorageAuthStatus.UNAUTHENTICATED)
                : StorageAuthStatus.UNAUTHENTICATED;
            seeds.set(providerId, {
                id: providerId,
                name: isLocalHost(host) ? 'PostgreSQL (Local)' : 'PostgreSQL',
                kind: StorageProviderKind.POSTGRESQL,
                locality: isLocalHost(host) ? StorageLocality.LOCAL : StorageLocality.REMOTE,
                registrationMode: StorageRegistrationMode.SYSTEM,
                connection: {
                    endpoint: `${host}:${databaseConfig.port}`,
                    database: databaseConfig.database,
                },
                auth: {
                    mode: StorageAuthMode.BASIC,
                    status: authStatus,
                    lastCheckedAt: null,
                    reason: dbHealth?.error ?? null,
                },
                health: {
                    status: healthStatus,
                    checkedAt: null,
                    reason: dbHealth?.error ?? null,
                },
                explicitLegacy: true,
            });
        }

        for (const provider of legacyProviders) {
            const legacyType = String(provider.type ?? '').toLowerCase();
            const rawName = String(provider.name ?? '').trim();
            const name = rawName.length > 0 ? rawName : 'Legacy Storage Provider';
            const rawPath = typeof provider.path === 'string' ? provider.path.trim() : '';
            const rawEndpoint = typeof provider.endpoint === 'string' ? provider.endpoint.trim() : '';

            if (legacyType === 'chroma-local' || legacyType === 'chroma-remote') {
                const endpoint = rawEndpoint.length > 0
                    ? rawEndpoint
                    : (legacyType === 'chroma-local' ? 'http://127.0.0.1:8000' : '');
                if (endpoint.length > 0) {
                    const normalizedEndpoint = normalizeLocalEndpoint(endpoint);
                    const id = `chromadb:${normalizedEndpoint}`;
                    seeds.set(id, {
                        id,
                        name,
                        kind: StorageProviderKind.CHROMADB,
                        locality: normalizedEndpoint.includes('127.0.0.1') ? StorageLocality.LOCAL : StorageLocality.REMOTE,
                        registrationMode: StorageRegistrationMode.MANUAL,
                        connection: {
                            endpoint,
                        },
                        explicitLegacy: true,
                    });
                    continue;
                }
                if (rawPath.length > 0) {
                    const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(APP_ROOT, rawPath);
                    const relativePath = toAppRootRelativePath(absolutePath);
                    const id = `chromadb:${relativePath}`;
                    seeds.set(id, {
                        id,
                        name,
                        kind: StorageProviderKind.CHROMADB,
                        locality: StorageLocality.LOCAL,
                        registrationMode: StorageRegistrationMode.MANUAL,
                        connection: {
                            path: absolutePath,
                            workspaceRelativePath: relativePath,
                        },
                        explicitLegacy: true,
                    });
                }
                continue;
            }

            if (legacyType === 'supabase') {
                const endpoint = rawEndpoint;
                if (endpoint.length > 0) {
                    const id = `supabase:${normalizeLocalEndpoint(endpoint)}`;
                    seeds.set(id, {
                        id,
                        name,
                        kind: StorageProviderKind.SUPABASE,
                        locality: StorageLocality.REMOTE,
                        registrationMode: StorageRegistrationMode.MANUAL,
                        connection: {
                            endpoint,
                            bucket: typeof provider.bucket === 'string' ? provider.bucket : undefined,
                        },
                        auth: {
                            mode: StorageAuthMode.API_KEY,
                            status: StorageAuthStatus.UNAUTHENTICATED,
                            lastCheckedAt: null,
                            reason: 'legacy_import',
                        },
                        health: {
                            status: StorageHealthStatus.UNKNOWN,
                            checkedAt: null,
                            reason: 'legacy_import',
                        },
                        explicitLegacy: true,
                    });
                }
                continue;
            }

            if (legacyType === 's3') {
                const bucket = typeof provider.bucket === 'string' ? provider.bucket.trim() : '';
                const region = typeof provider.region === 'string' ? provider.region.trim() : '';
                const endpoint = rawEndpoint;
                const key = [bucket, region, endpoint].filter((part) => part.length > 0).join(':');
                if (key.length > 0) {
                    const id = `s3:${normalizeLocalEndpoint(key)}`;
                    seeds.set(id, {
                        id,
                        name,
                        kind: StorageProviderKind.S3,
                        locality: StorageLocality.REMOTE,
                        registrationMode: StorageRegistrationMode.MANUAL,
                        connection: {
                            endpoint: endpoint || undefined,
                            bucket: bucket || undefined,
                        },
                        auth: {
                            mode: StorageAuthMode.API_KEY,
                            status: StorageAuthStatus.UNAUTHENTICATED,
                            lastCheckedAt: null,
                            reason: 'legacy_import',
                        },
                        health: {
                            status: StorageHealthStatus.UNKNOWN,
                            checkedAt: null,
                            reason: 'legacy_import',
                        },
                        explicitLegacy: true,
                    });
                }
                continue;
            }

            if (legacyType.includes('sqlite') || rawPath.toLowerCase().endsWith('.db')) {
                if (!rawPath) {
                    continue;
                }
                const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(APP_ROOT, rawPath);
                const relativePath = toAppRootRelativePath(absolutePath);
                const id = `sqlite:${relativePath}`;
                seeds.set(id, {
                    id,
                    name: rawName.length > 0 ? rawName : 'SQLite (Legacy)',
                    kind: StorageProviderKind.SQLITE,
                    locality: StorageLocality.LOCAL,
                    registrationMode: StorageRegistrationMode.MANUAL,
                    connection: {
                        path: absolutePath,
                        workspaceRelativePath: relativePath,
                        database: path.basename(absolutePath),
                    },
                    explicitLegacy: true,
                });
            }
        }

        return seeds;
    }

    private ensureProviderFromBootstrap(seed: InferredProviderSeed): boolean {
        const existing = this.snapshot.providers.find((provider) => provider.id === seed.id);
        const profile = getStorageCapabilityProfile(seed.kind);
        if (existing) {
            let changed = false;
            if (!existing.connection.path && seed.connection.path) {
                existing.connection.path = seed.connection.path;
                changed = true;
            }
            if (!existing.connection.workspaceRelativePath && seed.connection.workspaceRelativePath) {
                existing.connection.workspaceRelativePath = seed.connection.workspaceRelativePath;
                changed = true;
            }
            if (!existing.connection.endpoint && seed.connection.endpoint) {
                existing.connection.endpoint = seed.connection.endpoint;
                changed = true;
            }
            if (!existing.connection.database && seed.connection.database) {
                existing.connection.database = seed.connection.database;
                changed = true;
            }
            if (existing.supportedRoles.length === 0) {
                existing.supportedRoles = profile.supportedRoles.slice();
                changed = true;
            }
            if (existing.capabilities.length === 0) {
                existing.capabilities = profile.defaultCapabilities.slice();
                changed = true;
            }
            if (changed) {
                existing.updatedAt = this.now();
            }
            return changed;
        }

        const createdAt = this.now();
        const provider: StorageProviderRecord = {
            id: seed.id,
            name: seed.name,
            kind: seed.kind,
            locality: seed.locality,
            registrationMode: seed.registrationMode,
            supportedRoles: profile.supportedRoles.slice(),
            capabilities: profile.defaultCapabilities.slice(),
            enabled: true,
            connection: seed.connection,
            auth: seed.auth ?? {
                mode: StorageAuthMode.NONE,
                status: StorageAuthStatus.NOT_REQUIRED,
                lastCheckedAt: null,
                reason: null,
            },
            health: seed.health ?? {
                status: StorageHealthStatus.UNKNOWN,
                checkedAt: null,
                reason: null,
            },
            assignedRoles: [],
            createdAt,
            updatedAt: createdAt,
        };
        this.snapshot.providers.push(provider);
        return true;
    }

    private fillDeterministicRoleGaps(
        inferredProviders: Map<string, InferredProviderSeed>,
        settings: Record<string, unknown>,
    ): boolean {
        const assignmentByRole = new Map<StorageRole, StorageRoleAssignment>();
        for (const assignment of this.snapshot.assignments) {
            assignmentByRole.set(assignment.role, assignment);
        }

        let changed = false;
        const legacyStorage = settings.storage as Record<string, unknown> | undefined;
        const legacyProviders = Array.isArray(legacyStorage?.providers)
            ? legacyStorage.providers.filter((provider): provider is LegacyStorageProvider => !!provider && typeof provider === 'object')
            : [];
        const legacyActiveProviderId = typeof legacyStorage?.activeProviderId === 'string' ? legacyStorage.activeProviderId : '';

        const baseFilesystemProviderId = `filesystem:${toAppRootRelativePath(resolveStoragePath('storage'))}`;
        const artifactFilesystemProviderId = `filesystem:${toAppRootRelativePath(resolveStoragePath(path.join('reflection', 'artifacts')))}`;

        const backupPathRaw = (settings.backup as Record<string, unknown> | undefined)?.localPath;
        const backupFilesystemProviderId = typeof backupPathRaw === 'string' && backupPathRaw.trim().length > 0
            ? `filesystem:${toAppRootRelativePath(path.isAbsolute(backupPathRaw) ? backupPathRaw : path.resolve(APP_ROOT, backupPathRaw))}`
            : baseFilesystemProviderId;

        const postgresProvider = this.snapshot.providers.find((provider) => provider.kind === StorageProviderKind.POSTGRESQL && provider.enabled);
        const explicitSqliteProviders = this.snapshot.providers.filter((provider) => {
            const seed = inferredProviders.get(provider.id);
            return provider.kind === StorageProviderKind.SQLITE && !!seed?.explicitLegacy;
        });
        const dbHealth = getLastDbHealth();
        const hasPgVector = dbHealth?.pgvectorInstalled === true;

        const activeLegacyProvider = legacyProviders.find((provider) => String(provider.id ?? '') === legacyActiveProviderId);
        const activeLegacyProviderType = String(activeLegacyProvider?.type ?? '').toLowerCase();
        let preferredVectorProviderId: string | null = null;
        if (activeLegacyProviderType === 'chroma-local' || activeLegacyProviderType === 'chroma-remote') {
            const endpoint = typeof activeLegacyProvider?.endpoint === 'string' ? activeLegacyProvider.endpoint.trim() : '';
            if (endpoint.length > 0) {
                preferredVectorProviderId = `chromadb:${normalizeLocalEndpoint(endpoint)}`;
            } else {
                const rawPath = typeof activeLegacyProvider?.path === 'string' ? activeLegacyProvider.path.trim() : '';
                if (rawPath.length > 0) {
                    preferredVectorProviderId = `chromadb:${toAppRootRelativePath(path.isAbsolute(rawPath) ? rawPath : path.resolve(APP_ROOT, rawPath))}`;
                } else {
                    preferredVectorProviderId = 'chromadb:http://127.0.0.1:8000';
                }
            }
        } else if (activeLegacyProviderType === 'supabase') {
            const endpoint = typeof activeLegacyProvider?.endpoint === 'string' ? activeLegacyProvider.endpoint.trim() : '';
            if (endpoint.length > 0) {
                preferredVectorProviderId = `supabase:${normalizeLocalEndpoint(endpoint)}`;
            }
        }

        const assignRoleIfMissing = (role: StorageRole, providerId: string | null): void => {
            const existing = assignmentByRole.get(role);
            if (existing) {
                this.pushAssignmentDecision(
                    role,
                    existing.providerId,
                    'bootstrap',
                    'preserved',
                    StorageAssignmentReasonCode.EXPLICIT_ASSIGNMENT_PRESERVED,
                    { bootstrapAttemptedProviderId: providerId },
                );
                return;
            }
            if (!providerId) {
                this.pushAssignmentDecision(
                    role,
                    null,
                    'recovery',
                    'suggestion',
                    StorageAssignmentReasonCode.RECOVERY_SUGGESTION_ONLY,
                    { reason: 'no_eligible_provider_found_for_missing_role' },
                );
                return;
            }
            const provider = this.snapshot.providers.find((item) => item.id === providerId);
            if (!provider || !provider.enabled || !provider.supportedRoles.includes(role)) {
                const decisionReason = !provider
                    ? StorageAssignmentReasonCode.PROVIDER_NOT_REGISTERED
                    : (!provider.enabled ? StorageAssignmentReasonCode.BLOCKED_POLICY_CONFLICT : StorageAssignmentReasonCode.BLOCKED_CAPABILITY_MISMATCH);
                this.pushAssignmentDecision(
                    role,
                    providerId,
                    'bootstrap',
                    'blocked',
                    decisionReason,
                );
                return;
            }
            const eligibility = this.policy.validateRoleAssignmentEligibility(this.snapshot, providerId, role);
            if (!eligibility.ok) {
                this.pushAssignmentDecision(
                    role,
                    providerId,
                    'policy',
                    'blocked',
                    eligibility.assignmentReasonCode,
                    eligibility.details,
                );
                return;
            }
            this.snapshot.assignments.push({
                role,
                providerId,
                assignedAt: this.now(),
                assignmentReasonCode: StorageAssignmentReasonCode.FILLED_MISSING_ROLE_FROM_BOOTSTRAP,
            });
            assignmentByRole.set(role, this.snapshot.assignments[this.snapshot.assignments.length - 1]);
            this.pushAssignmentDecision(
                role,
                providerId,
                'bootstrap',
                'applied',
                StorageAssignmentReasonCode.FILLED_MISSING_ROLE_FROM_BOOTSTRAP,
            );
            changed = true;
        };

        const enabledExplicitProviders = this.snapshot.providers.filter(
            (provider) => provider.enabled && provider.registrationMode === StorageRegistrationMode.MANUAL,
        );
        const enabledBootstrapProviders = this.snapshot.providers.filter(
            (provider) => provider.enabled && provider.registrationMode !== StorageRegistrationMode.MANUAL,
        );
        const pickFirstEligibleProviderId = (role: StorageRole, candidateProviderIds: Array<string | null | undefined>): string | null => {
            for (const candidate of candidateProviderIds) {
                if (!candidate) continue;
                const provider = this.snapshot.providers.find((item) => item.id === candidate);
                if (!provider || !provider.enabled || !provider.supportedRoles.includes(role)) continue;
                const policyCheck = this.policy.validateRoleAssignmentEligibility(this.snapshot, provider.id, role);
                if (policyCheck.ok) return provider.id;
                this.pushAssignmentDecision(
                    role,
                    provider.id,
                    'policy',
                    'blocked',
                    policyCheck.assignmentReasonCode,
                    policyCheck.details,
                );
            }
            return null;
        };

        const explicitCanonicalCandidate = enabledExplicitProviders.find(
            (provider) => provider.supportedRoles.includes(StorageRole.CANONICAL_MEMORY),
        )?.id;
        const canonicalCandidateId = pickFirstEligibleProviderId(StorageRole.CANONICAL_MEMORY, [
            explicitCanonicalCandidate,
            explicitSqliteProviders[0]?.id,
            postgresProvider?.id,
        ]);
        assignRoleIfMissing(StorageRole.CANONICAL_MEMORY, canonicalCandidateId);

        let vectorCandidateId: string | null = preferredVectorProviderId;
        if (!vectorCandidateId || !this.snapshot.providers.some((provider) => provider.id === vectorCandidateId)) {
            vectorCandidateId = null;
            if (postgresProvider && hasPgVector) {
                vectorCandidateId = postgresProvider.id;
            } else {
                const chromaCandidate = this.snapshot.providers.find((provider) => provider.kind === StorageProviderKind.CHROMADB);
                if (chromaCandidate) {
                    vectorCandidateId = chromaCandidate.id;
                }
            }
        }
        const explicitVectorCandidate = enabledExplicitProviders.find(
            (provider) => provider.supportedRoles.includes(StorageRole.VECTOR_INDEX),
        )?.id;
        assignRoleIfMissing(
            StorageRole.VECTOR_INDEX,
            pickFirstEligibleProviderId(StorageRole.VECTOR_INDEX, [explicitVectorCandidate, vectorCandidateId]),
        );

        const explicitBlobCandidate = enabledExplicitProviders.find((provider) => provider.supportedRoles.includes(StorageRole.BLOB_STORE))?.id;
        const explicitDocumentCandidate = enabledExplicitProviders.find((provider) => provider.supportedRoles.includes(StorageRole.DOCUMENT_STORE))?.id;
        const explicitBackupCandidate = enabledExplicitProviders.find((provider) => provider.supportedRoles.includes(StorageRole.BACKUP_TARGET))?.id;
        const explicitArtifactCandidate = enabledExplicitProviders.find((provider) => provider.supportedRoles.includes(StorageRole.ARTIFACT_STORE))?.id;

        const bootstrapBlobCandidate = enabledBootstrapProviders.find((provider) => provider.id === baseFilesystemProviderId)?.id ?? baseFilesystemProviderId;
        const bootstrapDocCandidate = bootstrapBlobCandidate;
        const bootstrapBackupCandidate = enabledBootstrapProviders.find((provider) => provider.id === backupFilesystemProviderId)?.id ?? backupFilesystemProviderId;
        const bootstrapArtifactCandidate = enabledBootstrapProviders.find((provider) => provider.id === artifactFilesystemProviderId)?.id ?? artifactFilesystemProviderId;

        assignRoleIfMissing(StorageRole.BLOB_STORE, pickFirstEligibleProviderId(StorageRole.BLOB_STORE, [explicitBlobCandidate, bootstrapBlobCandidate]));
        assignRoleIfMissing(StorageRole.DOCUMENT_STORE, pickFirstEligibleProviderId(StorageRole.DOCUMENT_STORE, [explicitDocumentCandidate, bootstrapDocCandidate]));
        assignRoleIfMissing(StorageRole.BACKUP_TARGET, pickFirstEligibleProviderId(StorageRole.BACKUP_TARGET, [explicitBackupCandidate, bootstrapBackupCandidate]));
        assignRoleIfMissing(StorageRole.ARTIFACT_STORE, pickFirstEligibleProviderId(StorageRole.ARTIFACT_STORE, [explicitArtifactCandidate, bootstrapArtifactCandidate]));

        return changed;
    }

    private persist(): void {
        this.snapshot = this.normalizeSnapshot(this.snapshot);
        this.snapshot.updatedAt = this.now();
        const payload: PersistedStorageConfig = {
            version: STORAGE_CONFIG_VERSION,
            providers: this.snapshot.providers,
            assignments: this.snapshot.assignments,
            assignmentDecisions: this.assignmentDecisions.slice(),
            updatedAt: this.snapshot.updatedAt,
        };
        this.persistence.saveConfig(payload);
    }

    private normalizeSnapshot(input: PersistedStorageConfig): StorageRegistrySnapshot {
        const normalizationDecisions: StorageAssignmentDecision[] = [];
        const providersById = new Map<string, StorageProviderRecord>();
        for (const provider of input.providers) {
            if (!provider.id || providersById.has(provider.id)) {
                continue;
            }
            providersById.set(provider.id, {
                ...provider,
                supportedRoles: [...new Set(provider.supportedRoles ?? [])],
                capabilities: [...new Set(provider.capabilities ?? [])],
                enabled: provider.enabled ?? true,
                connection: provider.connection ?? {},
                auth: provider.auth ?? {
                    mode: StorageAuthMode.NONE,
                    status: StorageAuthStatus.NOT_REQUIRED,
                    lastCheckedAt: null,
                    reason: null,
                },
                health: provider.health ?? {
                    status: StorageHealthStatus.UNKNOWN,
                    checkedAt: null,
                    reason: null,
                },
                assignedRoles: [],
                createdAt: provider.createdAt || this.now(),
                updatedAt: provider.updatedAt || this.now(),
            });
        }

        const assignments: StorageRoleAssignment[] = [];
        const seenRoles = new Set<StorageRole>();
        for (const assignment of input.assignments) {
            if (seenRoles.has(assignment.role)) {
                if (assignment.role === StorageRole.CANONICAL_MEMORY) {
                    normalizationDecisions.push({
                        role: assignment.role,
                        providerId: assignment.providerId,
                        source: 'recovery',
                        outcome: 'suggestion',
                        reasonCode: StorageAssignmentReasonCode.BLOCKED_CANONICAL_CONFLICT,
                        timestamp: this.now(),
                        details: { conflict: 'duplicate_assignment_detected_during_normalization' },
                    });
                    normalizationDecisions.push({
                        role: assignment.role,
                        providerId: assignment.providerId,
                        source: 'recovery',
                        outcome: 'suggestion',
                        reasonCode: StorageAssignmentReasonCode.RECOVERY_SUGGESTION_ONLY,
                        timestamp: this.now(),
                        details: { suggestion: 'resolve_canonical_conflict_manually' },
                    });
                }
                continue;
            }
            const provider = providersById.get(assignment.providerId);
            if (!provider) {
                continue;
            }
            const profile = getStorageCapabilityProfile(provider.kind);
            if (!profile.supportedRoles.includes(assignment.role) || !provider.supportedRoles.includes(assignment.role)) {
                continue;
            }
            seenRoles.add(assignment.role);
            assignments.push({
                role: assignment.role,
                providerId: assignment.providerId,
                assignedAt: assignment.assignedAt || this.now(),
                assignmentReasonCode: assignment.assignmentReasonCode,
            });
        }

        const roleByProviderId = new Map<string, Set<StorageRole>>();
        for (const assignment of assignments) {
            if (!roleByProviderId.has(assignment.providerId)) {
                roleByProviderId.set(assignment.providerId, new Set<StorageRole>());
            }
            roleByProviderId.get(assignment.providerId)!.add(assignment.role);
        }

        const providers = Array.from(providersById.values()).map((provider) => {
            const roles = roleByProviderId.get(provider.id);
            provider.assignedRoles = roles ? Array.from(roles.values()).sort() : [];
            return provider;
        });

        providers.sort((a, b) => a.id.localeCompare(b.id));
        assignments.sort((a, b) => a.role.localeCompare(b.role));

        const mergedDecisions = [
            ...((input as StorageRegistrySnapshot).assignmentDecisions ?? []),
            ...normalizationDecisions,
        ].slice(-MAX_ASSIGNMENT_DECISIONS);

        return {
            version: typeof input.version === 'number' ? input.version : STORAGE_CONFIG_VERSION,
            providers,
            assignments,
            assignmentDecisions: mergedDecisions,
            updatedAt: input.updatedAt || this.now(),
        };
    }

    private assertProviderRoleSet(provider: StorageProviderRecord): void {
        const profile = getStorageCapabilityProfile(provider.kind);
        if (!profile.allowedLocality.includes(provider.locality)) {
            throw createStorageOperationError(
                StorageOperationErrorCode.INVALID_PROVIDER_LOCALITY,
                'Provider locality is not allowed for provider kind',
                { providerId: provider.id, kind: provider.kind, locality: provider.locality },
            );
        }

        for (const role of provider.supportedRoles) {
            if (!profile.supportedRoles.includes(role)) {
                throw createStorageOperationError(
                    StorageOperationErrorCode.INVALID_PROVIDER_ROLE_SET,
                    'Provider declares unsupported role for its kind',
                    { providerId: provider.id, role, kind: provider.kind },
                );
            }
        }

        for (const assignment of this.snapshot.assignments) {
            if (assignment.providerId !== provider.id) {
                continue;
            }
            if (!provider.supportedRoles.includes(assignment.role)) {
                throw createStorageOperationError(
                    StorageOperationErrorCode.ROLE_UNSUPPORTED,
                    'Existing role assignment is not supported by provider after update',
                    { providerId: provider.id, role: assignment.role },
                );
            }
        }
    }
}
