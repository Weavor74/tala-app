import { getStorageCapabilityProfile } from './storageCapabilityMatrix';
import {
    StorageCapability,
    StorageAuthMode,
    StorageAuthStatus,
    StorageHealthStatus,
    StorageOperationError,
    StorageOperationErrorCode,
    StorageProviderRecord,
    StorageRegistrySnapshot,
    StorageRole,
    createStorageOperationError,
} from './storageTypes';

export interface StoragePolicyValidationResult {
    ok: boolean;
    code?: StorageOperationErrorCode;
    message?: string;
    details?: Record<string, unknown>;
}

function success(): StoragePolicyValidationResult {
    return { ok: true };
}

function failure(
    code: StorageOperationErrorCode,
    message: string,
    details?: Record<string, unknown>,
): StoragePolicyValidationResult {
    return { ok: false, code, message, details };
}

function toError(result: StoragePolicyValidationResult): StorageOperationError {
    if (result.ok || !result.code || !result.message) {
        return createStorageOperationError(StorageOperationErrorCode.INVALID_PROVIDER_ROLE_SET, 'Unexpected policy error state');
    }
    return createStorageOperationError(result.code, result.message, result.details);
}

function findProvider(snapshot: StorageRegistrySnapshot, providerId: string): StorageProviderRecord | undefined {
    return snapshot.providers.find((provider) => provider.id === providerId);
}

function getCanonicalAssignments(snapshot: StorageRegistrySnapshot): Array<{ providerId: string }> {
    return snapshot.assignments
        .filter((assignment) => assignment.role === StorageRole.CANONICAL_MEMORY)
        .filter((assignment) => {
            const provider = findProvider(snapshot, assignment.providerId);
            return !!provider && provider.enabled;
        })
        .map((assignment) => ({ providerId: assignment.providerId }));
}

export class StorageAssignmentPolicyService {
    public validateRoleAssignmentEligibility(
        snapshot: StorageRegistrySnapshot,
        providerId: string,
        role: StorageRole,
    ): StoragePolicyValidationResult {
        const provider = findProvider(snapshot, providerId);
        if (!provider) {
            return failure(StorageOperationErrorCode.PROVIDER_NOT_FOUND, 'Provider not found', { providerId });
        }

        const profile = getStorageCapabilityProfile(provider.kind);
        if (!profile.allowedLocality.includes(provider.locality)) {
            return failure(StorageOperationErrorCode.INVALID_PROVIDER_LOCALITY, 'Provider locality is not allowed for its kind', {
                providerId,
                kind: provider.kind,
                locality: provider.locality,
            });
        }

        if (!provider.enabled) {
            return failure(StorageOperationErrorCode.PROVIDER_DISABLED, 'Cannot assign role to disabled provider', { providerId, role });
        }

        if (role === StorageRole.CANONICAL_MEMORY && !profile.canonicalEligible) {
            return failure(StorageOperationErrorCode.CANONICAL_ROLE_RESTRICTED, 'Provider kind is not eligible for canonical memory', {
                providerId,
                kind: provider.kind,
            });
        }
        if (role === StorageRole.CANONICAL_MEMORY && !provider.capabilities.includes(StorageCapability.STRUCTURED_RECORDS)) {
            return failure(StorageOperationErrorCode.CANONICAL_ROLE_RESTRICTED, 'Canonical memory requires structured storage capability', {
                providerId,
                kind: provider.kind,
            });
        }

        if (!profile.supportedRoles.includes(role) || !provider.supportedRoles.includes(role)) {
            return failure(StorageOperationErrorCode.ROLE_UNSUPPORTED, 'Provider does not support requested role', { providerId, role });
        }

        if (provider.health.status === StorageHealthStatus.OFFLINE || provider.health.status === StorageHealthStatus.UNREACHABLE) {
            return failure(StorageOperationErrorCode.PROVIDER_OFFLINE, 'Provider is offline or unreachable', {
                providerId,
                health: provider.health.status,
            });
        }

        const requiresAuth = provider.auth.mode !== StorageAuthMode.NONE;
        const authReady = provider.auth.status === StorageAuthStatus.AUTHENTICATED || provider.auth.status === StorageAuthStatus.NOT_REQUIRED;
        if (requiresAuth && !authReady) {
            return failure(StorageOperationErrorCode.AUTH_BLOCKED, 'Provider auth state does not allow assignment', {
                providerId,
                authMode: provider.auth.mode,
                authStatus: provider.auth.status,
            });
        }

        const existing = snapshot.assignments.find((assignment) => assignment.role === role);
        if (existing && existing.providerId !== providerId) {
            return failure(StorageOperationErrorCode.ROLE_ALREADY_ASSIGNED, 'Role is already assigned to another provider', {
                role,
                assignedProviderId: existing.providerId,
                requestedProviderId: providerId,
            });
        }

        return success();
    }

    public assertRoleAssignmentEligibility(
        snapshot: StorageRegistrySnapshot,
        providerId: string,
        role: StorageRole,
    ): void {
        const result = this.validateRoleAssignmentEligibility(snapshot, providerId, role);
        if (!result.ok) {
            throw toError(result);
        }
    }

    public validateProviderDisable(snapshot: StorageRegistrySnapshot, providerId: string): StoragePolicyValidationResult {
        const provider = findProvider(snapshot, providerId);
        if (!provider) {
            return failure(StorageOperationErrorCode.PROVIDER_NOT_FOUND, 'Provider not found', { providerId });
        }

        if (!provider.enabled) {
            return success();
        }

        const hasCanonical = snapshot.assignments.some(
            (assignment) => assignment.role === StorageRole.CANONICAL_MEMORY && assignment.providerId === providerId,
        );
        if (!hasCanonical) {
            return success();
        }

        const activeCanonicalAssignments = getCanonicalAssignments(snapshot);
        if (activeCanonicalAssignments.length <= 1) {
            return failure(
                StorageOperationErrorCode.SOLE_CANONICAL_PROVIDER_REQUIRED,
                'Cannot disable the sole active canonical_memory provider',
                { providerId },
            );
        }

        return success();
    }

    public assertProviderDisable(snapshot: StorageRegistrySnapshot, providerId: string): void {
        const result = this.validateProviderDisable(snapshot, providerId);
        if (!result.ok) {
            throw toError(result);
        }
    }

    public validateProviderRemoval(snapshot: StorageRegistrySnapshot, providerId: string): StoragePolicyValidationResult {
        const provider = findProvider(snapshot, providerId);
        if (!provider) {
            return failure(StorageOperationErrorCode.PROVIDER_NOT_FOUND, 'Provider not found', { providerId });
        }

        const hasCanonical = snapshot.assignments.some(
            (assignment) => assignment.role === StorageRole.CANONICAL_MEMORY && assignment.providerId === providerId,
        );
        if (!hasCanonical) {
            return success();
        }

        const activeCanonicalAssignments = getCanonicalAssignments(snapshot);
        if (activeCanonicalAssignments.length <= 1) {
            return failure(
                StorageOperationErrorCode.SOLE_CANONICAL_PROVIDER_REQUIRED,
                'Cannot remove the sole active canonical_memory provider',
                { providerId },
            );
        }

        return success();
    }

    public assertProviderRemoval(snapshot: StorageRegistrySnapshot, providerId: string): void {
        const result = this.validateProviderRemoval(snapshot, providerId);
        if (!result.ok) {
            throw toError(result);
        }
    }

    public validateRoleUnassignment(snapshot: StorageRegistrySnapshot, role: StorageRole): StoragePolicyValidationResult {
        const assignment = snapshot.assignments.find((item) => item.role === role);
        if (!assignment) {
            return failure(StorageOperationErrorCode.ASSIGNMENT_NOT_FOUND, 'Role assignment not found', { role });
        }

        if (role !== StorageRole.CANONICAL_MEMORY) {
            return success();
        }

        const activeCanonicalAssignments = getCanonicalAssignments(snapshot);
        if (activeCanonicalAssignments.length <= 1) {
            return failure(
                StorageOperationErrorCode.SOLE_CANONICAL_PROVIDER_REQUIRED,
                'Cannot unassign the sole active canonical_memory provider',
                { providerId: assignment.providerId },
            );
        }

        return success();
    }

    public assertRoleUnassignment(snapshot: StorageRegistrySnapshot, role: StorageRole): void {
        const result = this.validateRoleUnassignment(snapshot, role);
        if (!result.ok) {
            throw toError(result);
        }
    }
}
