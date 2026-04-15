export type StorageRole =
    | 'canonical_memory'
    | 'vector_index'
    | 'blob_store'
    | 'document_store'
    | 'backup_target'
    | 'artifact_store';

export type StorageProviderKind =
    | 'filesystem'
    | 'postgresql'
    | 'supabase'
    | 'chromadb'
    | 's3'
    | 'google_drive'
    | 'sharepoint'
    | 'gist'
    | 'sqlite'
    | 'unknown';

export type StorageLocality = 'local' | 'remote' | 'hybrid' | 'unknown';

export type StorageRegistrationMode = 'manual' | 'auto_discovered' | 'system';

export type StorageHealthStatus = 'unknown' | 'healthy' | 'degraded' | 'offline' | 'unreachable';

export type StorageAuthMode = 'none' | 'api_key' | 'oauth' | 'basic';

export type StorageAuthStatus =
    | 'not_required'
    | 'authenticated'
    | 'unauthenticated'
    | 'expired'
    | 'blocked'
    | 'error';

export type StorageCapability =
    | 'structured_records'
    | 'vector_indexing'
    | 'blob_storage'
    | 'document_storage'
    | 'backup_target'
    | 'artifact_storage'
    | 'health_checks'
    | 'local_path';

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

export type StorageOperationErrorCode =
    | 'provider_already_exists'
    | 'provider_not_found'
    | 'role_unsupported'
    | 'role_already_assigned'
    | 'assignment_not_found'
    | 'canonical_role_restricted'
    | 'sole_canonical_provider_required'
    | 'provider_disabled'
    | 'provider_offline'
    | 'auth_blocked'
    | 'invalid_provider_locality'
    | 'invalid_provider_role_set'
    | 'persistence_load_failed'
    | 'persistence_save_failed';

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

export type StorageValidationDimensionStatus = 'pass' | 'fail' | 'warn';

export type StorageValidationDimension =
    | 'config_schema'
    | 'authentication'
    | 'reachability'
    | 'capability_compatibility'
    | 'role_eligibility'
    | 'policy_compliance'
    | 'authority_conflicts'
    | 'bootstrap_migration_consistency'
    | 'recoverability';

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

export interface StorageBridge {
    getSnapshot: () => Promise<StorageRegistrySnapshot>;
    detectProviders: () => Promise<StorageDetectProvidersResponse>;
    addProvider: (request: StorageAddProviderRequest) => Promise<StorageAddProviderResponse>;
    updateProvider: (request: StorageUpdateProviderRequest) => Promise<StorageUpdateProviderResponse>;
    removeProvider: (request: StorageRemoveProviderRequest) => Promise<StorageRemoveProviderResponse>;
    validateProvider: (request: StorageValidateProviderRequest) => Promise<StorageValidateProviderResponse>;
    assignRole: (request: StorageAssignRoleRequest) => Promise<StorageAssignRoleResponse>;
    unassignRole: (request: StorageUnassignRoleRequest) => Promise<StorageUnassignRoleResponse>;
    setProviderEnabled: (request: StorageSetProviderEnabledRequest) => Promise<StorageSetProviderEnabledResponse>;
}

export interface StorageWizardDraft {
    id: string;
    name: string;
    kind: StorageProviderKind;
    locality: StorageLocality;
    registrationMode: StorageRegistrationMode;
    connection: StorageProviderConnection;
    authMode: StorageAuthMode;
    assignRoles: StorageRole[];
    enabled: boolean;
}
