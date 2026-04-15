import type {
    StorageAuthStatus,
    StorageHealthStatus,
    StorageProviderRecord,
    StorageRegistrySnapshot,
    StorageRole,
} from './storageTypes';

export const STORAGE_ROLES: StorageRole[] = [
    'canonical_memory',
    'vector_index',
    'blob_store',
    'document_store',
    'backup_target',
    'artifact_store',
];

const ROLE_LABELS: Record<StorageRole, string> = {
    canonical_memory: 'Canonical Memory',
    vector_index: 'Vector Index',
    blob_store: 'Blob Store',
    document_store: 'Document Store',
    backup_target: 'Backup Target',
    artifact_store: 'Artifact Store',
};

export interface StorageRoleRowViewModel {
    role: StorageRole;
    roleLabel: string;
    assignedProviderId: string | null;
    assignedProviderName: string;
    providerKind: string;
    locality: string;
    health: StorageHealthStatus;
    auth: StorageAuthStatus;
    isAssigned: boolean;
}

export interface StorageBadgeViewModel {
    text: string;
    tone: 'neutral' | 'good' | 'warn' | 'bad';
}

function mapHealthTone(status: StorageHealthStatus): StorageBadgeViewModel['tone'] {
    if (status === 'healthy') return 'good';
    if (status === 'degraded' || status === 'unknown') return 'warn';
    return 'bad';
}

function mapAuthTone(status: StorageAuthStatus): StorageBadgeViewModel['tone'] {
    if (status === 'authenticated' || status === 'not_required') return 'good';
    if (status === 'unauthenticated' || status === 'expired') return 'warn';
    return 'bad';
}

export function mapHealthBadge(status: StorageHealthStatus): StorageBadgeViewModel {
    return {
        text: status.replace(/_/g, ' ').toUpperCase(),
        tone: mapHealthTone(status),
    };
}

export function mapAuthBadge(status: StorageAuthStatus): StorageBadgeViewModel {
    return {
        text: status.replace(/_/g, ' ').toUpperCase(),
        tone: mapAuthTone(status),
    };
}

export function mapLocalityBadge(locality: string): StorageBadgeViewModel {
    const text = locality.toUpperCase();
    if (locality === 'local') return { text, tone: 'good' };
    if (locality === 'remote') return { text, tone: 'warn' };
    return { text, tone: 'neutral' };
}

export function mapRegistrationBadge(mode: string): StorageBadgeViewModel {
    if (mode === 'manual') return { text: 'MANUAL', tone: 'neutral' };
    if (mode === 'auto_discovered') return { text: 'DETECTED', tone: 'good' };
    return { text: mode.replace(/_/g, ' ').toUpperCase(), tone: 'neutral' };
}

export function mapEnabledBadge(enabled: boolean): StorageBadgeViewModel {
    return enabled
        ? { text: 'ENABLED', tone: 'good' }
        : { text: 'DISABLED', tone: 'bad' };
}

export function buildRoleRows(snapshot: StorageRegistrySnapshot): StorageRoleRowViewModel[] {
    const providersById = new Map<string, StorageProviderRecord>();
    for (const provider of snapshot.providers) {
        providersById.set(provider.id, provider);
    }

    return STORAGE_ROLES.map((role) => {
        const assignment = snapshot.assignments.find((item) => item.role === role) || null;
        const provider = assignment ? providersById.get(assignment.providerId) || null : null;

        return {
            role,
            roleLabel: ROLE_LABELS[role],
            assignedProviderId: provider?.id || null,
            assignedProviderName: provider?.name || 'Unassigned',
            providerKind: provider?.kind || 'none',
            locality: provider?.locality || 'unknown',
            health: provider?.health.status || 'unknown',
            auth: provider?.auth.status || 'unauthenticated',
            isAssigned: !!provider,
        };
    });
}

export function buildRoleProviderOptions(snapshot: StorageRegistrySnapshot, role: StorageRole): StorageProviderRecord[] {
    return snapshot.providers
        .filter((provider) => provider.supportedRoles.includes(role))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildProviderConnectionLabel(provider: StorageProviderRecord): string {
    const parts = [provider.connection.endpoint, provider.connection.path, provider.connection.database]
        .filter((value): value is string => !!value && value.trim().length > 0);
    if (parts.length === 0) {
        return 'No connection details';
    }
    return parts.join(' | ');
}
