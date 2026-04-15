export enum StorageRole {
    CANONICAL_MEMORY = 'canonical_memory',
    VECTOR_INDEX = 'vector_index',
    BLOB_STORE = 'blob_store',
    DOCUMENT_STORE = 'document_store',
    BACKUP_TARGET = 'backup_target',
    ARTIFACT_STORE = 'artifact_store',
}

export enum StorageProviderKind {
    FILESYSTEM = 'filesystem',
    POSTGRESQL = 'postgresql',
    SUPABASE = 'supabase',
    CHROMADB = 'chromadb',
    S3 = 's3',
    GOOGLE_DRIVE = 'google_drive',
    SHAREPOINT = 'sharepoint',
    GIST = 'gist',
    SQLITE = 'sqlite',
    UNKNOWN = 'unknown',
}

export enum StorageLocality {
    LOCAL = 'local',
    REMOTE = 'remote',
    HYBRID = 'hybrid',
    UNKNOWN = 'unknown',
}

export enum StorageRegistrationMode {
    MANUAL = 'manual',
    AUTO_DISCOVERED = 'auto_discovered',
    SYSTEM = 'system',
}

export enum StorageHealthStatus {
    UNKNOWN = 'unknown',
    HEALTHY = 'healthy',
    DEGRADED = 'degraded',
    OFFLINE = 'offline',
    UNREACHABLE = 'unreachable',
}

export enum StorageAuthMode {
    NONE = 'none',
    API_KEY = 'api_key',
    OAUTH = 'oauth',
    BASIC = 'basic',
}

export enum StorageAuthStatus {
    NOT_REQUIRED = 'not_required',
    AUTHENTICATED = 'authenticated',
    UNAUTHENTICATED = 'unauthenticated',
    EXPIRED = 'expired',
    BLOCKED = 'blocked',
    ERROR = 'error',
}

export enum StorageCapability {
    STRUCTURED_RECORDS = 'structured_records',
    VECTOR_INDEXING = 'vector_indexing',
    BLOB_STORAGE = 'blob_storage',
    DOCUMENT_STORAGE = 'document_storage',
    BACKUP_TARGET = 'backup_target',
    ARTIFACT_STORAGE = 'artifact_storage',
    HEALTH_CHECKS = 'health_checks',
    LOCAL_PATH = 'local_path',
}

export interface StorageProviderConnection {
    endpoint?: string;
    path?: string;
    database?: string;
    bucket?: string;
    collection?: string;
    workspaceRelativePath?: string;
}

export interface StorageProviderAuthState {
    mode: StorageAuthMode;
    status: StorageAuthStatus;
    lastCheckedAt?: string | null;
    reason?: string | null;
}

export interface StorageProviderHealthState {
    status: StorageHealthStatus;
    checkedAt?: string | null;
    reason?: string | null;
}

export interface StorageProviderRecord {
    id: string;
    name: string;
    kind: StorageProviderKind;
    locality: StorageLocality;
    registrationMode: StorageRegistrationMode;
    supportedRoles: StorageRole[];
    capabilities: StorageCapability[];
    enabled: boolean;
    connection: StorageProviderConnection;
    auth: StorageProviderAuthState;
    health: StorageProviderHealthState;
    assignedRoles: StorageRole[];
    createdAt: string;
    updatedAt: string;
}

export interface StorageRoleAssignment {
    role: StorageRole;
    providerId: string;
    assignedAt: string;
}

export interface StorageRegistrySnapshot {
    version: number;
    providers: StorageProviderRecord[];
    assignments: StorageRoleAssignment[];
    updatedAt: string;
}

export interface PersistedStorageConfig extends StorageRegistrySnapshot {}

export enum StorageOperationErrorCode {
    PROVIDER_ALREADY_EXISTS = 'provider_already_exists',
    PROVIDER_NOT_FOUND = 'provider_not_found',
    ROLE_UNSUPPORTED = 'role_unsupported',
    ROLE_ALREADY_ASSIGNED = 'role_already_assigned',
    ASSIGNMENT_NOT_FOUND = 'assignment_not_found',
    CANONICAL_ROLE_RESTRICTED = 'canonical_role_restricted',
    SOLE_CANONICAL_PROVIDER_REQUIRED = 'sole_canonical_provider_required',
    PROVIDER_DISABLED = 'provider_disabled',
    PROVIDER_OFFLINE = 'provider_offline',
    AUTH_BLOCKED = 'auth_blocked',
    INVALID_PROVIDER_LOCALITY = 'invalid_provider_locality',
    INVALID_PROVIDER_ROLE_SET = 'invalid_provider_role_set',
    PERSISTENCE_LOAD_FAILED = 'persistence_load_failed',
    PERSISTENCE_SAVE_FAILED = 'persistence_save_failed',
}

export interface StorageOperationError extends Error {
    code: StorageOperationErrorCode;
    details?: Record<string, unknown>;
}

export function createStorageOperationError(
    code: StorageOperationErrorCode,
    message: string,
    details?: Record<string, unknown>,
): StorageOperationError {
    const error = new Error(message) as StorageOperationError;
    error.name = 'StorageOperationError';
    error.code = code;
    error.details = details;
    return error;
}

export function checkStorageOperationError(error: unknown): error is StorageOperationError {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const candidate = error as Partial<StorageOperationError>;
    return typeof candidate.code === 'string' && candidate.name === 'StorageOperationError';
}

export interface StorageProviderValidationResult {
    providerId: string;
    ok: boolean;
    health: StorageProviderHealthState;
    auth: StorageProviderAuthState;
    detectedRolesSupported: StorageRole[];
    detectedCapabilities: StorageCapability[];
    warnings: string[];
    errors: string[];
}

export interface StorageDetectionResult {
    detectedProviders: StorageProviderRecord[];
    mergedSnapshot: StorageRegistrySnapshot;
}

export interface StorageIpcErrorPayload {
    code: StorageOperationErrorCode;
    message: string;
    details?: Record<string, unknown>;
}

export interface StorageMutationSuccess<T> {
    ok: true;
    snapshot: StorageRegistrySnapshot;
    changed: T;
}

export interface StorageMutationFailure {
    ok: false;
    error: StorageIpcErrorPayload;
}

export type StorageMutationResponse<T> = StorageMutationSuccess<T> | StorageMutationFailure;

export interface StorageGetSnapshotRequest {}
export type StorageGetSnapshotResponse = StorageRegistrySnapshot;

export interface StorageDetectProvidersRequest {}
export interface StorageDetectProvidersResponse {
    ok: true;
    detectedProviders: StorageProviderRecord[];
    snapshot: StorageRegistrySnapshot;
}

export interface StorageAddProviderRequest {
    id: string;
    name: string;
    kind: StorageProviderKind;
    locality: StorageLocality;
    registrationMode: StorageRegistrationMode;
    supportedRoles?: StorageRole[];
    capabilities?: StorageCapability[];
    enabled?: boolean;
    connection?: StorageProviderConnection;
    auth?: StorageProviderAuthState;
    health?: StorageProviderHealthState;
}
export type StorageAddProviderResponse = StorageMutationResponse<StorageProviderRecord>;

export interface StorageUpdateProviderRequest {
    id: string;
    patch: Partial<Omit<StorageProviderRecord, 'id' | 'createdAt' | 'assignedRoles'>>;
}
export type StorageUpdateProviderResponse = StorageMutationResponse<StorageProviderRecord>;

export interface StorageRemoveProviderRequest {
    providerId: string;
}
export type StorageRemoveProviderResponse = StorageMutationResponse<{ providerId: string }>;

export interface StorageValidateProviderRequest {
    providerId: string;
}
export type StorageValidateProviderResponse =
    | { ok: true; result: StorageProviderValidationResult; snapshot: StorageRegistrySnapshot }
    | StorageMutationFailure;

export interface StorageAssignRoleRequest {
    providerId: string;
    role: StorageRole;
}
export type StorageAssignRoleResponse = StorageMutationResponse<StorageRoleAssignment>;

export interface StorageUnassignRoleRequest {
    role: StorageRole;
}
export type StorageUnassignRoleResponse = StorageMutationResponse<{ role: StorageRole }>;

export interface StorageSetProviderEnabledRequest {
    providerId: string;
    enabled: boolean;
}
export type StorageSetProviderEnabledResponse = StorageMutationResponse<{ providerId: string; enabled: boolean }>;
