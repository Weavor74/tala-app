import type { McpServerConfig } from './settings';
import type { RuntimeStatus } from './runtimeDiagnosticsTypes';

export type McpAuthorityReasonCode =
    | 'mcp_not_configured'
    | 'mcp_disabled'
    | 'mcp_unreachable'
    | 'mcp_auth_failed'
    | 'mcp_protocol_mismatch'
    | 'mcp_capability_invalid'
    | 'mcp_server_unhealthy'
    | 'mcp_policy_blocked'
    | 'mcp_request_timed_out'
    | 'mcp_stdio_stream_corrupted'
    | 'mcp_registration_invalid'
    | 'mcp_activation_denied'
    | 'mcp_registration_conflict'
    | 'mcp_transport_invalid'
    | 'mcp_capability_quarantined'
    | 'mcp_transport_not_supported';

export type McpProviderTransportType = 'stdio' | 'websocket' | 'http';

export type McpProviderKind = 'external_mcp_server';

export type McpProviderTemplateKind = 'stdio' | 'websocket' | 'http';

export type McpProviderIdStrategy = 'explicit' | 'derived_deterministic';

export type McpProviderAuthMode = 'none' | 'token' | 'header';

export type McpProviderActivationStrategy = 'manual' | 'startup_auto';

export type McpProviderHealthCheckStrategy =
    | 'protocol_handshake'
    | 'capability_refresh'
    | 'transport_probe'
    | 'none';

export interface McpProviderDiagnosticsMetadata {
    owner: 'mcp_authority_service';
    redactEnvKeys?: string[];
    redactHeaderKeys?: string[];
    tags?: string[];
}

export interface McpProviderProtocolExpectation {
    minProtocolVersion?: string;
    maxProtocolVersion?: string;
    expectedCapabilityClass?: string[];
}

export interface McpProviderCapabilityPolicy {
    allowedFeatureIds?: string[];
    trustPolicyTier?: 'local' | 'trusted' | 'restricted';
}

export interface McpStdioTransportConfig {
    transportType: 'stdio';
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd?: string;
    startupTimeoutMs?: number;
}

export interface McpWebsocketTransportConfig {
    transportType: 'websocket';
    url: string;
    timeoutMs?: number;
    expectedProtocolVersion?: string;
}

export interface McpHttpTransportConfig {
    transportType: 'http';
    baseUrl: string;
    timeoutMs?: number;
    healthEndpoint?: string;
    expectedProtocolVersion?: string;
    headers?: Record<string, string>;
}

export type McpProviderTransportConfig =
    | McpStdioTransportConfig
    | McpWebsocketTransportConfig
    | McpHttpTransportConfig;

export interface McpProviderTemplateContract {
    providerKind: McpProviderKind;
    templateKind: McpProviderTemplateKind;
    idStrategy: McpProviderIdStrategy;
    displayName: string;
    transportType: McpProviderTransportType;
    transportConfig: McpProviderTransportConfig;
    authMode: McpProviderAuthMode;
    capabilityPolicy: McpProviderCapabilityPolicy;
    activationStrategy: McpProviderActivationStrategy;
    healthCheckStrategy: McpProviderHealthCheckStrategy;
    diagnostics: McpProviderDiagnosticsMetadata;
    protocolExpectation?: McpProviderProtocolExpectation;
    tags?: string[];
}

export interface McpProviderRegistrationInput {
    id?: string;
    displayName: string;
    providerKind?: McpProviderKind;
    templateKind?: McpProviderTemplateKind;
    transportType: McpProviderTransportType;
    transportConfig: Partial<McpProviderTransportConfig>;
    authMode?: McpProviderAuthMode;
    capabilityPolicy?: McpProviderCapabilityPolicy;
    activationStrategy?: McpProviderActivationStrategy;
    healthCheckStrategy?: McpProviderHealthCheckStrategy;
    diagnostics?: Partial<McpProviderDiagnosticsMetadata>;
    protocolExpectation?: McpProviderProtocolExpectation;
    tags?: string[];
    enabled: boolean;
}

export interface McpProviderRecord {
    id: string;
    displayName: string;
    providerKind: McpProviderKind;
    templateKind: McpProviderTemplateKind;
    transportType: McpProviderTransportType;
    transportConfig: McpProviderTransportConfig;
    authMode: McpProviderAuthMode;
    capabilityPolicy: McpProviderCapabilityPolicy;
    activationStrategy: McpProviderActivationStrategy;
    healthCheckStrategy: McpProviderHealthCheckStrategy;
    diagnostics: McpProviderDiagnosticsMetadata;
    protocolExpectation?: McpProviderProtocolExpectation;
    tags: string[];
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface McpProviderActivationRequest {
    providerId: string;
    requestedAt: string;
    requestedBy: 'startup_sync' | 'operator' | 'api';
}

export type McpOnboardingPhase =
    | 'registration_submission'
    | 'registration_validation'
    | 'normalization'
    | 'persistence'
    | 'activation_attempt'
    | 'handshake_classification'
    | 'capability_validation'
    | 'policy_approval'
    | 'capability_exposure'
    | 'steady_state_health_updates';

export interface McpOnboardingPhaseOutcome {
    phase: McpOnboardingPhase;
    status: 'succeeded' | 'failed' | 'skipped';
    reasonCode?: McpAuthorityReasonCode;
    detail?: string;
    timestamp: string;
}

export interface McpQuarantinedCapability {
    kind: 'tool' | 'resource' | 'prompt';
    reasonCode: McpAuthorityReasonCode;
    detail: string;
    index?: number;
    name?: string;
}

export interface McpApprovedCapabilityExposure {
    providerId: string;
    tools: any[];
    resources: any[];
    prompts: any[];
    quarantined: McpQuarantinedCapability[];
    approvedCounts: {
        tools: number;
        resources: number;
        prompts: number;
    };
    quarantinedCounts: {
        tools: number;
        resources: number;
        prompts: number;
    };
    generatedAt: string;
}

export type McpActivationState =
    | 'registered'
    | 'rejected'
    | 'pending_activation'
    | 'active'
    | 'degraded'
    | 'blocked_by_policy';

export interface McpServerClassification {
    configured: boolean;
    reachable: boolean;
    authenticated: boolean;
    protocolCompatible: boolean;
    capabilityValid: boolean;
    healthy: boolean;
    policyApproved: boolean;
    active: boolean;
    degraded: boolean;
    disabled: boolean;
    reasonCodes: McpAuthorityReasonCode[];
    status: RuntimeStatus;
    lastEvaluatedAt: string;
}

export interface McpRegistrationResult {
    ok: boolean;
    state: McpActivationState;
    serverId: string;
    phases?: McpOnboardingPhaseOutcome[];
    activation?: {
        registrationAccepted: boolean;
        activationAttempted: boolean;
        transportConnected: boolean;
        authSatisfied: boolean;
        protocolCompatible: boolean;
        capabilityDeclarationsValid: boolean;
        policyApproved: boolean;
        active: boolean;
        degraded: boolean;
        blocked: boolean;
    };
    reasonCode?: McpAuthorityReasonCode;
    reason?: string;
}

export type McpRegistrationRequest = McpProviderRegistrationInput;

export interface McpAuthorityServerSnapshot {
    config: McpServerConfig;
    classification: McpServerClassification;
    activationState: McpActivationState;
    providerRecord?: McpProviderRecord;
    approvedCapabilityExposure?: McpApprovedCapabilityExposure;
}

export interface McpAuthoritySnapshot {
    servers: McpAuthorityServerSnapshot[];
    updatedAt: string;
}
