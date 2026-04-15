import type {
    StorageAuthStatus,
    StorageHealthStatus,
    StorageIpcErrorPayload,
    StorageProviderRecord,
    StorageProviderValidationResult,
    StorageRegistrationMode,
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

export type StorageRegistryHealthState = 'healthy' | 'degraded' | 'conflict';

export type StorageProviderAuthorityClass = 'canonical' | 'derived';

export type StorageProviderOrigin = 'explicit_registry' | 'bootstrapped_legacy' | 'detected';

export type StorageProviderReachability = 'reachable' | 'degraded' | 'offline' | 'unknown';

export type StorageProviderValidationStatus = 'not_validated' | 'passed' | 'warn' | 'failed';

export type StorageRoleAssignmentType = 'explicit' | 'bootstrap' | 'inferred' | 'unassigned';

export interface StorageAuthorityReference {
    providerId: string | null;
    providerName: string;
}

export interface StorageBootstrapStateViewModel {
    hasBootstrapImports: boolean;
    bootstrappedProviderCount: number;
    detectedProviderCount: number;
    explicitRegistryProviderCount: number;
}

export interface StorageAuthorityDegradationViewModel {
    degraded: boolean;
    conflict: boolean;
    reasons: string[];
}

export interface StorageAuthoritySummaryViewModel {
    canonicalRuntimeAuthority: StorageAuthorityReference;
    derivedProviders: StorageAuthorityReference[];
    registryHealth: {
        state: StorageRegistryHealthState;
        reasons: string[];
    };
    bootstrapState: StorageBootstrapStateViewModel;
    authorityState: StorageAuthorityDegradationViewModel;
}

export interface StorageProviderVisibilityViewModel {
    providerId: string;
    providerName: string;
    providerType: string;
    status: {
        reachable: StorageProviderReachability;
        auth: StorageAuthStatus;
        capable: boolean;
    };
    capabilities: string[];
    assignedRoles: StorageRole[];
    authorityClass: StorageProviderAuthorityClass;
    origin: StorageProviderOrigin;
    validation: {
        status: StorageProviderValidationStatus;
        ok: boolean | null;
        warnings: string[];
        errors: string[];
        checkedAt: string | null;
        dimensions?: StorageProviderValidationResult['layeredValidation']['dimensions'];
        classification?: StorageProviderValidationResult['layeredValidation']['classification'];
    };
}

export interface StorageRoleCandidateBlockerViewModel {
    providerId: string;
    providerName: string;
    reasons: string[];
}

export interface StorageRoleVisibilityViewModel {
    role: StorageRole;
    roleLabel: string;
    assignedProvider: StorageAuthorityReference;
    assignmentType: StorageRoleAssignmentType;
    eligibilityReasoning: string[];
    blockedAlternatives: StorageRoleCandidateBlockerViewModel[];
}

export interface StorageAssignmentExplanationViewModel {
    role: StorageRole;
    provider: StorageAuthorityReference;
    outcome: 'succeeded' | 'failed';
    reasonCode: string;
    reasonSummary: string;
    eligibilityReasoning: string[];
    blockedAlternatives: StorageRoleCandidateBlockerViewModel[];
    nextSteps: string[];
    timestamp: string;
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

function mapOrigin(registrationMode: StorageRegistrationMode): StorageProviderOrigin {
    if (registrationMode === 'manual') return 'explicit_registry';
    if (registrationMode === 'system') return 'bootstrapped_legacy';
    return 'detected';
}

function mapReachability(health: StorageHealthStatus): StorageProviderReachability {
    if (health === 'healthy') return 'reachable';
    if (health === 'degraded') return 'degraded';
    if (health === 'offline' || health === 'unreachable') return 'offline';
    return 'unknown';
}

function mapAssignmentType(registrationMode: StorageRegistrationMode): StorageRoleAssignmentType {
    if (registrationMode === 'manual') return 'explicit';
    if (registrationMode === 'system') return 'bootstrap';
    return 'inferred';
}

function getAssignmentByRole(snapshot: StorageRegistrySnapshot, role: StorageRole) {
    return snapshot.assignments.find((assignment) => assignment.role === role) || null;
}

function getProviderById(snapshot: StorageRegistrySnapshot, providerId: string | null): StorageProviderRecord | null {
    if (!providerId) return null;
    return snapshot.providers.find((provider) => provider.id === providerId) || null;
}

function buildRoleEligibilityReasons(provider: StorageProviderRecord, role: StorageRole): string[] {
    const reasons: string[] = [];
    if (!provider.supportedRoles.includes(role)) {
        reasons.push('role_not_supported');
    }
    if (!provider.enabled) {
        reasons.push('provider_disabled');
    }
    if (provider.health.status === 'offline' || provider.health.status === 'unreachable') {
        reasons.push('provider_unreachable');
    }
    if (provider.auth.status === 'blocked' || provider.auth.status === 'error') {
        reasons.push('auth_blocked');
    }
    if (provider.auth.status === 'unauthenticated' || provider.auth.status === 'expired') {
        reasons.push('auth_not_ready');
    }
    return reasons;
}

function buildAssignmentSuccessReasons(provider: StorageProviderRecord, role: StorageRole): string[] {
    const reasons: string[] = [];
    if (provider.supportedRoles.includes(role)) {
        reasons.push('role_supported');
    }
    if (provider.enabled) {
        reasons.push('provider_enabled');
    }
    if (provider.health.status === 'healthy' || provider.health.status === 'degraded' || provider.health.status === 'unknown') {
        reasons.push('provider_reachable');
    }
    if (provider.auth.status === 'authenticated' || provider.auth.status === 'not_required') {
        reasons.push('auth_ready');
    }
    return reasons;
}

function mapValidationState(
    provider: StorageProviderRecord,
    validationByProviderId: Record<string, StorageProviderValidationResult>,
): StorageProviderVisibilityViewModel['validation'] {
    const result = validationByProviderId[provider.id] || null;
    if (!result) {
        return {
            status: 'not_validated',
            ok: null,
            warnings: [],
            errors: [],
            checkedAt: provider.health.checkedAt || provider.auth.lastCheckedAt || null,
        };
    }

    return {
        status: result.layeredValidation.overallStatus === 'fail'
            ? 'failed'
            : (result.layeredValidation.overallStatus === 'warn' ? 'warn' : 'passed'),
        ok: result.ok,
        warnings: result.warnings,
        errors: result.errors,
        checkedAt: result.health.checkedAt || result.auth.lastCheckedAt || null,
        dimensions: result.layeredValidation.dimensions,
        classification: result.layeredValidation.classification,
    };
}

function buildBlockedAlternatives(snapshot: StorageRegistrySnapshot, role: StorageRole): StorageRoleCandidateBlockerViewModel[] {
    const blocked: StorageRoleCandidateBlockerViewModel[] = [];
    for (const provider of snapshot.providers) {
        const reasons = buildRoleEligibilityReasons(provider, role);
        if (reasons.length > 0) {
            blocked.push({
                providerId: provider.id,
                providerName: provider.name,
                reasons,
            });
        }
    }
    return blocked;
}

function hasAuthorityConflict(snapshot: StorageRegistrySnapshot): boolean {
    const canonicalAssignees = snapshot.assignments.filter((assignment) => assignment.role === 'canonical_memory');
    return canonicalAssignees.length > 1;
}

function hasAuthorityDegradation(snapshot: StorageRegistrySnapshot): boolean {
    const canonicalAssignment = getAssignmentByRole(snapshot, 'canonical_memory');
    if (!canonicalAssignment) return true;
    const provider = getProviderById(snapshot, canonicalAssignment.providerId);
    if (!provider) return true;
    if (!provider.enabled) return true;
    if (provider.health.status === 'offline' || provider.health.status === 'unreachable') return true;
    if (provider.auth.status === 'blocked' || provider.auth.status === 'error') return true;
    return false;
}

export function buildStorageAuthoritySummary(snapshot: StorageRegistrySnapshot): StorageAuthoritySummaryViewModel {
    const canonicalAssignment = getAssignmentByRole(snapshot, 'canonical_memory');
    const canonicalProvider = canonicalAssignment ? getProviderById(snapshot, canonicalAssignment.providerId) : null;
    const canonicalAuthority: StorageAuthorityReference = canonicalProvider
        ? { providerId: canonicalProvider.id, providerName: canonicalProvider.name }
        : { providerId: null, providerName: 'Unassigned' };

    const derivedProviders = snapshot.providers
        .filter((provider) => provider.id !== canonicalAuthority.providerId)
        .map((provider) => ({ providerId: provider.id, providerName: provider.name }));

    const bootstrapState: StorageBootstrapStateViewModel = {
        hasBootstrapImports: snapshot.providers.some((provider) => provider.registrationMode === 'system'),
        bootstrappedProviderCount: snapshot.providers.filter((provider) => provider.registrationMode === 'system').length,
        detectedProviderCount: snapshot.providers.filter((provider) => provider.registrationMode === 'auto_discovered').length,
        explicitRegistryProviderCount: snapshot.providers.filter((provider) => provider.registrationMode === 'manual').length,
    };

    const authorityConflict = hasAuthorityConflict(snapshot);
    const authorityDegraded = hasAuthorityDegradation(snapshot);
    const healthReasons: string[] = [];
    if (!canonicalAuthority.providerId) {
        healthReasons.push('canonical_runtime_authority_unassigned');
    }
    if (authorityConflict) {
        healthReasons.push('canonical_runtime_authority_conflict');
    }
    if (authorityDegraded) {
        healthReasons.push('canonical_runtime_authority_degraded');
    }
    for (const role of STORAGE_ROLES) {
        if (!getAssignmentByRole(snapshot, role)) {
            healthReasons.push(`role_unassigned:${role}`);
        }
    }

    const registryHealthState: StorageRegistryHealthState = authorityConflict
        ? 'conflict'
        : (healthReasons.length > 0 ? 'degraded' : 'healthy');

    return {
        canonicalRuntimeAuthority: canonicalAuthority,
        derivedProviders,
        bootstrapState,
        registryHealth: {
            state: registryHealthState,
            reasons: healthReasons,
        },
        authorityState: {
            degraded: authorityDegraded,
            conflict: authorityConflict,
            reasons: healthReasons.filter((reason) => reason.startsWith('canonical_runtime_authority')),
        },
    };
}

export function buildProviderVisibilityModels(
    snapshot: StorageRegistrySnapshot,
    validationByProviderId: Record<string, StorageProviderValidationResult>,
): Record<string, StorageProviderVisibilityViewModel> {
    const assignedCanonical = getAssignmentByRole(snapshot, 'canonical_memory');
    const models: Record<string, StorageProviderVisibilityViewModel> = {};
    for (const provider of snapshot.providers) {
        const capabilityMatch = provider.capabilities.length > 0;
        models[provider.id] = {
            providerId: provider.id,
            providerName: provider.name,
            providerType: provider.kind,
            status: {
                reachable: mapReachability(provider.health.status),
                auth: provider.auth.status,
                capable: capabilityMatch,
            },
            capabilities: provider.capabilities,
            assignedRoles: provider.assignedRoles,
            authorityClass: assignedCanonical?.providerId === provider.id ? 'canonical' : 'derived',
            origin: mapOrigin(provider.registrationMode),
            validation: mapValidationState(provider, validationByProviderId),
        };
    }
    return models;
}

export function buildRoleVisibilityModels(snapshot: StorageRegistrySnapshot): StorageRoleVisibilityViewModel[] {
    return STORAGE_ROLES.map((role) => {
        const assignment = getAssignmentByRole(snapshot, role);
        const assignedProvider = assignment ? getProviderById(snapshot, assignment.providerId) : null;
        const assignmentType = assignedProvider ? mapAssignmentType(assignedProvider.registrationMode) : 'unassigned';
        const eligibilityReasoning = assignedProvider
            ? buildRoleEligibilityReasons(assignedProvider, role)
            : ['role_unassigned'];

        return {
            role,
            roleLabel: ROLE_LABELS[role],
            assignedProvider: assignedProvider
                ? { providerId: assignedProvider.id, providerName: assignedProvider.name }
                : { providerId: null, providerName: 'Unassigned' },
            assignmentType,
            eligibilityReasoning: eligibilityReasoning.length > 0 ? eligibilityReasoning : ['assignment_eligible'],
            blockedAlternatives: buildBlockedAlternatives(snapshot, role)
                .filter((candidate) => candidate.providerId !== assignedProvider?.id),
        };
    });
}

function buildAssignmentNextSteps(errorCode: string): string[] {
    const steps: Record<string, string[]> = {
        provider_disabled: ['enable_provider', 'reassign_role'],
        provider_offline: ['restore_provider_connectivity', 'run_validation'],
        auth_blocked: ['update_provider_credentials', 'run_validation'],
        role_unsupported: ['select_provider_supporting_role', 'review_supported_roles'],
        role_already_assigned: ['unassign_existing_provider', 'retry_assignment'],
        canonical_role_restricted: ['assign_canonical_role_only_to_canonical_provider'],
        sole_canonical_provider_required: ['keep_single_canonical_runtime_authority', 'assign_alternative_before_removal'],
        provider_not_found: ['refresh_storage_registry', 'retry_assignment'],
    };
    return steps[errorCode] || ['review_assignment_eligibility', 'retry_assignment'];
}

export function buildAssignmentFailureExplanation(
    snapshot: StorageRegistrySnapshot,
    providerId: string,
    role: StorageRole,
    error: StorageIpcErrorPayload,
): StorageAssignmentExplanationViewModel {
    const provider = getProviderById(snapshot, providerId);
    const providerRef: StorageAuthorityReference = provider
        ? { providerId: provider.id, providerName: provider.name }
        : { providerId, providerName: providerId };
    const eligibilityReasoning = provider ? buildRoleEligibilityReasons(provider, role) : ['provider_not_found'];
    return {
        role,
        provider: providerRef,
        outcome: 'failed',
        reasonCode: error.code,
        reasonSummary: error.message,
        eligibilityReasoning: eligibilityReasoning.length > 0 ? eligibilityReasoning : ['assignment_attempt_failed'],
        blockedAlternatives: buildBlockedAlternatives(snapshot, role),
        nextSteps: buildAssignmentNextSteps(error.code),
        timestamp: new Date().toISOString(),
    };
}

export function buildAssignmentSuccessExplanation(
    snapshot: StorageRegistrySnapshot,
    providerId: string,
    role: StorageRole,
): StorageAssignmentExplanationViewModel {
    const provider = getProviderById(snapshot, providerId);
    const providerRef: StorageAuthorityReference = provider
        ? { providerId: provider.id, providerName: provider.name }
        : { providerId, providerName: providerId };
    const reasons = provider ? buildAssignmentSuccessReasons(provider, role) : ['provider_not_found'];
    return {
        role,
        provider: providerRef,
        outcome: 'succeeded',
        reasonCode: 'assignment_applied',
        reasonSummary: 'Role assignment applied in the Storage Registry.',
        eligibilityReasoning: reasons.length > 0 ? reasons : ['assignment_eligible'],
        blockedAlternatives: buildBlockedAlternatives(snapshot, role)
            .filter((candidate) => candidate.providerId !== providerId),
        nextSteps: ['run_validation', 'review_storage_authority_summary'],
        timestamp: new Date().toISOString(),
    };
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
