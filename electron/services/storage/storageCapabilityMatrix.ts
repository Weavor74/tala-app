import {
    StorageCapability,
    StorageLocality,
    StorageProviderKind,
    StorageRole,
} from './storageTypes';

export interface StorageProviderCapabilityProfile {
    allowedLocality: StorageLocality[];
    supportedRoles: StorageRole[];
    defaultCapabilities: StorageCapability[];
    canonicalEligible: boolean;
}

export const STORAGE_CAPABILITY_MATRIX: Record<StorageProviderKind, StorageProviderCapabilityProfile> = {
    [StorageProviderKind.FILESYSTEM]: {
        allowedLocality: [StorageLocality.LOCAL],
        supportedRoles: [StorageRole.BLOB_STORE, StorageRole.DOCUMENT_STORE, StorageRole.BACKUP_TARGET, StorageRole.ARTIFACT_STORE],
        defaultCapabilities: [StorageCapability.BLOB_STORAGE, StorageCapability.DOCUMENT_STORAGE, StorageCapability.BACKUP_TARGET, StorageCapability.ARTIFACT_STORAGE, StorageCapability.LOCAL_PATH, StorageCapability.HEALTH_CHECKS],
        canonicalEligible: false,
    },
    [StorageProviderKind.POSTGRESQL]: {
        allowedLocality: [StorageLocality.LOCAL, StorageLocality.REMOTE],
        supportedRoles: [StorageRole.CANONICAL_MEMORY, StorageRole.DOCUMENT_STORE, StorageRole.BACKUP_TARGET, StorageRole.VECTOR_INDEX],
        defaultCapabilities: [StorageCapability.STRUCTURED_RECORDS, StorageCapability.DOCUMENT_STORAGE, StorageCapability.BACKUP_TARGET, StorageCapability.VECTOR_INDEXING, StorageCapability.HEALTH_CHECKS],
        canonicalEligible: true,
    },
    [StorageProviderKind.SUPABASE]: {
        allowedLocality: [StorageLocality.REMOTE],
        supportedRoles: [StorageRole.CANONICAL_MEMORY, StorageRole.DOCUMENT_STORE, StorageRole.BLOB_STORE, StorageRole.VECTOR_INDEX, StorageRole.BACKUP_TARGET],
        defaultCapabilities: [StorageCapability.STRUCTURED_RECORDS, StorageCapability.DOCUMENT_STORAGE, StorageCapability.BLOB_STORAGE, StorageCapability.VECTOR_INDEXING, StorageCapability.BACKUP_TARGET, StorageCapability.HEALTH_CHECKS],
        canonicalEligible: true,
    },
    [StorageProviderKind.CHROMADB]: {
        allowedLocality: [StorageLocality.LOCAL, StorageLocality.REMOTE],
        supportedRoles: [StorageRole.VECTOR_INDEX, StorageRole.DOCUMENT_STORE],
        defaultCapabilities: [StorageCapability.VECTOR_INDEXING, StorageCapability.DOCUMENT_STORAGE, StorageCapability.HEALTH_CHECKS],
        canonicalEligible: false,
    },
    [StorageProviderKind.S3]: {
        allowedLocality: [StorageLocality.REMOTE],
        supportedRoles: [StorageRole.BLOB_STORE, StorageRole.BACKUP_TARGET, StorageRole.ARTIFACT_STORE],
        defaultCapabilities: [StorageCapability.BLOB_STORAGE, StorageCapability.BACKUP_TARGET, StorageCapability.ARTIFACT_STORAGE, StorageCapability.HEALTH_CHECKS],
        canonicalEligible: false,
    },
    [StorageProviderKind.GOOGLE_DRIVE]: {
        allowedLocality: [StorageLocality.REMOTE],
        supportedRoles: [StorageRole.DOCUMENT_STORE, StorageRole.BLOB_STORE, StorageRole.BACKUP_TARGET, StorageRole.ARTIFACT_STORE],
        defaultCapabilities: [StorageCapability.DOCUMENT_STORAGE, StorageCapability.BLOB_STORAGE, StorageCapability.BACKUP_TARGET, StorageCapability.ARTIFACT_STORAGE, StorageCapability.HEALTH_CHECKS],
        canonicalEligible: false,
    },
    [StorageProviderKind.SHAREPOINT]: {
        allowedLocality: [StorageLocality.REMOTE],
        supportedRoles: [StorageRole.DOCUMENT_STORE, StorageRole.BLOB_STORE, StorageRole.BACKUP_TARGET, StorageRole.ARTIFACT_STORE],
        defaultCapabilities: [StorageCapability.DOCUMENT_STORAGE, StorageCapability.BLOB_STORAGE, StorageCapability.BACKUP_TARGET, StorageCapability.ARTIFACT_STORAGE, StorageCapability.HEALTH_CHECKS],
        canonicalEligible: false,
    },
    [StorageProviderKind.GIST]: {
        allowedLocality: [StorageLocality.REMOTE],
        supportedRoles: [StorageRole.DOCUMENT_STORE, StorageRole.BACKUP_TARGET, StorageRole.ARTIFACT_STORE],
        defaultCapabilities: [StorageCapability.DOCUMENT_STORAGE, StorageCapability.BACKUP_TARGET, StorageCapability.ARTIFACT_STORAGE, StorageCapability.HEALTH_CHECKS],
        canonicalEligible: false,
    },
    [StorageProviderKind.SQLITE]: {
        allowedLocality: [StorageLocality.LOCAL],
        supportedRoles: [StorageRole.CANONICAL_MEMORY, StorageRole.DOCUMENT_STORE, StorageRole.BACKUP_TARGET],
        defaultCapabilities: [StorageCapability.STRUCTURED_RECORDS, StorageCapability.DOCUMENT_STORAGE, StorageCapability.BACKUP_TARGET, StorageCapability.LOCAL_PATH, StorageCapability.HEALTH_CHECKS],
        canonicalEligible: true,
    },
    [StorageProviderKind.UNKNOWN]: {
        allowedLocality: [StorageLocality.UNKNOWN, StorageLocality.LOCAL, StorageLocality.REMOTE, StorageLocality.HYBRID],
        supportedRoles: [],
        defaultCapabilities: [],
        canonicalEligible: false,
    },
};

export function getStorageCapabilityProfile(kind: StorageProviderKind): StorageProviderCapabilityProfile {
    return STORAGE_CAPABILITY_MATRIX[kind] ?? STORAGE_CAPABILITY_MATRIX[StorageProviderKind.UNKNOWN];
}
