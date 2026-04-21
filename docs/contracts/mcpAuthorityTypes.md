# Contract: mcpAuthorityTypes.ts

**Source**: [shared\mcpAuthorityTypes.ts](../../shared/mcpAuthorityTypes.ts)

## Interfaces

### `McpProviderDiagnosticsMetadata`
```typescript
interface McpProviderDiagnosticsMetadata {
    owner: 'mcp_authority_service';
    redactEnvKeys?: string[];
    redactHeaderKeys?: string[];
    tags?: string[];
}
```

### `McpProviderProtocolExpectation`
```typescript
interface McpProviderProtocolExpectation {
    minProtocolVersion?: string;
    maxProtocolVersion?: string;
    expectedCapabilityClass?: string[];
}
```

### `McpProviderCapabilityPolicy`
```typescript
interface McpProviderCapabilityPolicy {
    allowedFeatureIds?: string[];
    trustPolicyTier?: 'local' | 'trusted' | 'restricted';
}
```

### `McpStdioTransportConfig`
```typescript
interface McpStdioTransportConfig {
    transportType: 'stdio';
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd?: string;
    startupTimeoutMs?: number;
}
```

### `McpWebsocketTransportConfig`
```typescript
interface McpWebsocketTransportConfig {
    transportType: 'websocket';
    url: string;
    timeoutMs?: number;
    expectedProtocolVersion?: string;
}
```

### `McpHttpTransportConfig`
```typescript
interface McpHttpTransportConfig {
    transportType: 'http';
    baseUrl: string;
    timeoutMs?: number;
    healthEndpoint?: string;
    expectedProtocolVersion?: string;
    headers?: Record<string, string>;
}
```

### `McpProviderTemplateContract`
```typescript
interface McpProviderTemplateContract {
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
```

### `McpProviderRegistrationInput`
```typescript
interface McpProviderRegistrationInput {
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
```

### `McpProviderRecord`
```typescript
interface McpProviderRecord {
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
```

### `McpProviderActivationRequest`
```typescript
interface McpProviderActivationRequest {
    providerId: string;
    requestedAt: string;
    requestedBy: 'startup_sync' | 'operator' | 'api';
}
```

### `McpOnboardingPhaseOutcome`
```typescript
interface McpOnboardingPhaseOutcome {
    phase: McpOnboardingPhase;
    status: 'succeeded' | 'failed' | 'skipped';
    reasonCode?: McpAuthorityReasonCode;
    detail?: string;
    timestamp: string;
}
```

### `McpQuarantinedCapability`
```typescript
interface McpQuarantinedCapability {
    kind: 'tool' | 'resource' | 'prompt';
    reasonCode: McpAuthorityReasonCode;
    detail: string;
    index?: number;
    name?: string;
}
```

### `McpApprovedCapabilityExposure`
```typescript
interface McpApprovedCapabilityExposure {
    providerId: string;
    tools: any[];
    resources: any[];
    prompts: any[];
    quarantined: McpQuarantinedCapability[];
    approvedCounts: {
        tools: number;
        resources: number;
        prompts: number;
    }
```

### `McpServerClassification`
```typescript
interface McpServerClassification {
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
```

### `McpRegistrationResult`
```typescript
interface McpRegistrationResult {
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
    }
```

### `McpAuthorityServerSnapshot`
```typescript
interface McpAuthorityServerSnapshot {
    config: McpServerConfig;
    classification: McpServerClassification;
    activationState: McpActivationState;
    providerRecord?: McpProviderRecord;
    approvedCapabilityExposure?: McpApprovedCapabilityExposure;
}
```

### `McpAuthoritySnapshot`
```typescript
interface McpAuthoritySnapshot {
    servers: McpAuthorityServerSnapshot[];
    updatedAt: string;
}
```

### `McpAuthorityReasonCode`
```typescript
type McpAuthorityReasonCode = 
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
```

### `McpProviderTransportType`
```typescript
type McpProviderTransportType =  'stdio' | 'websocket' | 'http';
```

### `McpProviderKind`
```typescript
type McpProviderKind =  'external_mcp_server';
```

### `McpProviderTemplateKind`
```typescript
type McpProviderTemplateKind =  'stdio' | 'websocket' | 'http';
```

### `McpProviderIdStrategy`
```typescript
type McpProviderIdStrategy =  'explicit' | 'derived_deterministic';
```

### `McpProviderAuthMode`
```typescript
type McpProviderAuthMode =  'none' | 'token' | 'header';
```

### `McpProviderActivationStrategy`
```typescript
type McpProviderActivationStrategy =  'manual' | 'startup_auto';
```

### `McpProviderHealthCheckStrategy`
```typescript
type McpProviderHealthCheckStrategy = 
    | 'protocol_handshake'
    | 'capability_refresh'
    | 'transport_probe'
    | 'none';
```

### `McpProviderTransportConfig`
```typescript
type McpProviderTransportConfig = 
    | McpStdioTransportConfig
    | McpWebsocketTransportConfig
    | McpHttpTransportConfig;
```

### `McpOnboardingPhase`
```typescript
type McpOnboardingPhase = 
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
```

### `McpActivationState`
```typescript
type McpActivationState = 
    | 'registered'
    | 'rejected'
    | 'pending_activation'
    | 'active'
    | 'degraded'
    | 'blocked_by_policy';
```

### `McpRegistrationRequest`
```typescript
type McpRegistrationRequest =  McpProviderRegistrationInput;
```

