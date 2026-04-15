export enum StorageRole {
    CANONICAL_MEMORY = 'canonical_memory',
    VECTOR_INDEX = 'vector_index',
    BLOB_STORE = 'blob_store',
    DOCUMENT_STORE = 'document_store',
    BACKUP_TARGET = 'backup_target',
    ARTIFACT_STORE = 'artifact_store',
}

export enum StorageAssignmentReasonCode {
    EXPLICIT_ASSIGNMENT_PRESERVED = 'explicit_assignment_preserved',
    FILLED_MISSING_ROLE_FROM_BOOTSTRAP = 'filled_missing_role_from_bootstrap',
    BLOCKED_CAPABILITY_MISMATCH = 'blocked_capability_mismatch',
    BLOCKED_AUTH_INVALID = 'blocked_auth_invalid',
    BLOCKED_POLICY_CONFLICT = 'blocked_policy_conflict',
    BLOCKED_CANONICAL_CONFLICT = 'blocked_canonical_conflict',
    PROVIDER_UNREACHABLE = 'provider_unreachable',
    PROVIDER_NOT_REGISTERED = 'provider_not_registered',
    LEGACY_IMPORT_SKIPPED_EXISTING_REGISTRY = 'legacy_import_skipped_existing_registry',
    RECOVERY_SUGGESTION_ONLY = 'recovery_suggestion_only',
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
    VECTOR_SEARCH = 'vector_search',
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
    assignmentReasonCode?: StorageAssignmentReasonCode;
}

export type StorageAssignmentDecisionSource = 'explicit_registry' | 'bootstrap' | 'policy' | 'recovery';

export type StorageAssignmentDecisionOutcome = 'applied' | 'preserved' | 'blocked' | 'skipped' | 'suggestion';

export interface StorageAssignmentDecision {
    role: StorageRole;
    providerId: string | null;
    source: StorageAssignmentDecisionSource;
    outcome: StorageAssignmentDecisionOutcome;
    reasonCode: StorageAssignmentReasonCode;
    timestamp: string;
    details?: Record<string, unknown>;
}

export interface StorageRegistrySnapshot {
    version: number;
    providers: StorageProviderRecord[];
    assignments: StorageRoleAssignment[];
    assignmentDecisions?: StorageAssignmentDecision[];
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
    layeredValidation: StorageLayeredValidationResult;
}

export enum StorageValidationDimensionStatus {
    PASS = 'pass',
    FAIL = 'fail',
    WARN = 'warn',
}

export enum StorageValidationDimension {
    CONFIG_SCHEMA = 'config_schema',
    AUTHENTICATION = 'authentication',
    REACHABILITY = 'reachability',
    CAPABILITY_COMPATIBILITY = 'capability_compatibility',
    ROLE_ELIGIBILITY = 'role_eligibility',
    POLICY_COMPLIANCE = 'policy_compliance',
    AUTHORITY_CONFLICTS = 'authority_conflicts',
    BOOTSTRAP_MIGRATION_CONSISTENCY = 'bootstrap_migration_consistency',
    RECOVERABILITY = 'recoverability',
}

export interface StorageValidationDimensionResult {
    status: StorageValidationDimensionStatus;
    reasonCode: string;
    remediationHint?: string;
    details?: Record<string, unknown>;
}

export interface StorageValidationClassification {
    validButNotEligible: boolean;
    reachableButUnauthorized: boolean;
    configuredButPolicyBlocked: boolean;
    canonicalConflictState: boolean;
}

export interface StorageLayeredValidationResult {
    overallStatus: StorageValidationDimensionStatus;
    dimensions: Record<StorageValidationDimension, StorageValidationDimensionResult>;
    classification: StorageValidationClassification;
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
