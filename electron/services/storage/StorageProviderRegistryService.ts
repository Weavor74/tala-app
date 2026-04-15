import { getStorageCapabilityProfile } from './storageCapabilityMatrix';
import { StorageAssignmentPolicyService } from './StorageAssignmentPolicyService';
import { STORAGE_CONFIG_VERSION, StorageConfigPersistenceService } from './storageConfigPersistence';
import {
    StorageAuthMode,
    StorageAuthStatus,
    StorageHealthStatus,
    PersistedStorageConfig,
    StorageOperationErrorCode,
    StorageProviderRecord,
    StorageRegistrySnapshot,
    StorageRole,
    StorageRoleAssignment,
    createStorageOperationError,
} from './storageTypes';

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

export class StorageProviderRegistryService {
    private snapshot: StorageRegistrySnapshot;

    constructor(
        private readonly persistence: StorageConfigPersistenceService,
        private readonly policy = new StorageAssignmentPolicyService(),
        private readonly now = () => new Date().toISOString(),
    ) {
        this.snapshot = this.normalizeSnapshot(this.persistence.loadConfig());
    }

    public loadPersistedProviderConfig(): StorageRegistrySnapshot {
        this.snapshot = this.normalizeSnapshot(this.persistence.loadConfig());
        return this.getRegistrySnapshot();
    }

    public saveProviderConfig(): StorageRegistrySnapshot {
        this.persist();
        return this.getRegistrySnapshot();
    }

    public getRegistrySnapshot(): StorageRegistrySnapshot {
        return cloneSnapshot(this.snapshot);
    }

    public getProviderById(providerId: string): StorageProviderRecord | null {
        const provider = this.snapshot.providers.find((item) => item.id === providerId);
        if (!provider) {
            return null;
        }
        return JSON.parse(JSON.stringify(provider)) as StorageProviderRecord;
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
        this.policy.assertRoleAssignmentEligibility(this.snapshot, providerId, role);

        const existing = this.snapshot.assignments.find((assignment) => assignment.role === role);
        if (existing && existing.providerId === providerId) {
            return this.getRegistrySnapshot();
        }

        this.snapshot.assignments = this.snapshot.assignments.filter((assignment) => assignment.role !== role);
        this.snapshot.assignments.push({
            role,
            providerId,
            assignedAt: this.now(),
        });

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

    private persist(): void {
        this.snapshot = this.normalizeSnapshot(this.snapshot);
        this.snapshot.updatedAt = this.now();
        const payload: PersistedStorageConfig = {
            version: STORAGE_CONFIG_VERSION,
            providers: this.snapshot.providers,
            assignments: this.snapshot.assignments,
            updatedAt: this.snapshot.updatedAt,
        };
        this.persistence.saveConfig(payload);
    }

    private normalizeSnapshot(input: PersistedStorageConfig): StorageRegistrySnapshot {
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

        return {
            version: typeof input.version === 'number' ? input.version : STORAGE_CONFIG_VERSION,
            providers,
            assignments,
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
