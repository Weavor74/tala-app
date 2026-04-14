# Contract: runtimeDiagnosticsTypes.ts

**Source**: [shared\runtimeDiagnosticsTypes.ts](../../shared/runtimeDiagnosticsTypes.ts)

## Interfaces

### `RuntimeTransitionRecord`
```typescript
interface RuntimeTransitionRecord {
    /** ISO 8601 timestamp of the transition. */
    timestamp: string;
    /** Status before the transition. */
    fromStatus: RuntimeStatus;
    /** Status after the transition. */
    toStatus: RuntimeStatus;
    /** Human-readable reason for the transition. */
    reason?: string;
}
```

### `RuntimeFailureSummary`
```typescript
interface RuntimeFailureSummary {
    /** Total failure count in the current session/window. */
    count: number;
    /** ISO timestamp of the most recent failure. */
    lastFailureTime?: string;
    /** Human-readable reason for the most recent failure. */
    lastFailureReason?: string;
    /** IDs of services/providers that have failed. */
    failedEntityIds: string[];
}
```

### `ProviderInventorySummary`
```typescript
interface ProviderInventorySummary {
    /** Total providers in the registry. */
    total: number;
    /** Providers currently in ready state. */
    ready: number;
    /** Providers currently unavailable (not_running or unreachable). */
    unavailable: number;
    /** Providers in degraded state (responding with errors). */
    degraded: number;
}
```

### `InferenceDiagnosticsState`
```typescript
interface InferenceDiagnosticsState {
    /** ID of the currently selected inference provider (if any). */
    selectedProviderId?: string;
    /** Display name of the currently selected provider. */
    selectedProviderName?: string;
    /** Type of the currently selected provider (ollama, llamacpp, etc.). */
    selectedProviderType?: string;
    /** Whether the selected provider is currently ready. */
    selectedProviderReady: boolean;
    /** ID of the provider actually used on the last execution. */
    lastUsedProviderId?: string;
    /** Providers attempted during the last execution (in order). */
    attemptedProviders: string[];
    /** Whether fallback was applied during the last execution. */
    fallbackApplied: boolean;
    /** Current stream status. */
    streamStatus: StreamDiagnosticsStatus;
    /** Status of the most recently completed stream (if any). */
    lastStreamStatus?: StreamDiagnosticsStatus;
    /** Reason for the last failure (if any). */
    lastFailureReason?: string;
    /** ISO timestamp of the last failure (if any). */
    lastFailureTime?: string;
    /** ISO timestamp of the last stream timeout (if any). */
    lastTimeoutTime?: string;
    /** Compact summary of the current provider inventory. */
    providerInventorySummary: ProviderInventorySummary;
    /** ISO timestamp of the last state update. */
    lastUpdated: string;
}
```

### `McpServiceDiagnostics`
```typescript
interface McpServiceDiagnostics {
    /** Stable unique identifier for this service. */
    serviceId: string;
    /** Human-readable display name. */
    displayName: string;
    /** Transport kind (stdio process or websocket). */
    kind: 'stdio' | 'websocket';
    /** Whether this service is configured and enabled. */
    enabled: boolean;
    /** Current normalized lifecycle status. */
    status: RuntimeStatus;
    /** Whether the service is currently in a degraded (partial) state. */
    degraded: boolean;
    /** Whether the service is currently accepting requests. */
    ready: boolean;
    /** ISO timestamp of the last health check (if any). */
    lastHealthCheck?: string;
    /** ISO timestamp of the last lifecycle state transition. */
    lastTransitionTime?: string;
    /** Reason for the last failure or degradation (if any). */
    lastFailureReason?: string;
    /** Number of reconnect/restart attempts in the current session. */
    restartCount: number;
    /** Additional service-specific metadata. */
    metadata?: Record<string, unknown>;
}
```

### `McpInventoryDiagnostics`
```typescript
interface McpInventoryDiagnostics {
    /** Diagnostics for all configured MCP services. */
    services: McpServiceDiagnostics[];
    /** Total number of configured services. */
    totalConfigured: number;
    /** Number of services currently in ready state. */
    totalReady: number;
    /** Number of services currently degraded. */
    totalDegraded: number;
    /** Number of services unavailable or failed. */
    totalUnavailable: number;
    /** True if any service marked as critical is unavailable. */
    criticalUnavailable: boolean;
    /** ISO timestamp of the last inventory update. */
    lastUpdated: string;
}
```

### `OperatorActionRecord`
```typescript
interface OperatorActionRecord {
    /** ISO timestamp of the action. */
    timestamp: string;
    /** Type of action performed. */
    action:
        | 'provider_restart'
        | 'provider_disable'
        | 'provider_enable'
        | 'provider_force_select'
        | 'provider_probe'
        | 'mcp_restart'
        | 'mcp_disable'
        | 'mcp_enable'
        | 'mcp_probe';
    /** ID of the entity the action was applied to. */
    entityId: string;
    /** Entity type for display. */
    entityType: 'provider' | 'mcp_service';
    /** State before the action. */
    priorState?: string;
    /** State after the action. */
    newState?: string;
    /** Human-readable reason or trigger. */
    reason?: string;
    /** Optional correlation ID for multi-step operations. */
    correlationId?: string;
}
```

### `OperatorActionRequest`
```typescript
interface OperatorActionRequest {
    action: OperatorActionId;
    requested_by: string;
    source?: OperatorActionSource;
    params?: Record<string, unknown>;
}
```

### `OperatorActionResultContract`
```typescript
interface OperatorActionResultContract {
    /** Stable action execution instance ID (UUID). */
    action_id: string;
    /** Canonical action identifier requested/executed. */
    action: OperatorActionId;
    requested_by: string;
    executed_at: string;
    allowed: boolean;
    reason: string;
    affected_subsystems: string[];
    resulting_mode_change: {
        from_mode: string;
        to_mode: string;
    }
```

### `ProviderHealthScore`
```typescript
interface ProviderHealthScore {
    /** Provider ID. */
    providerId: string;
    /** Consecutive failure count. */
    failureStreak: number;
    /** Total timeout count in the current session. */
    timeoutCount: number;
    /** Total fallback count in the current session. */
    fallbackCount: number;
    /** ISO timestamp of the last successful inference. */
    lastSuccess?: string;
    /** ISO timestamp of the last failure. */
    lastFailure?: string;
    /** Whether the provider has been administratively suppressed from auto-selection. */
    suppressed: boolean;
    /** ISO timestamp when suppression expires (if time-bounded). */
    suppressedUntil?: string;
    /** Current effective selection priority (may differ from base priority during demotion). */
    effectivePriority: number;
}
```

### `RuntimeDiagnosticsSnapshot`
```typescript
interface RuntimeDiagnosticsSnapshot {
    /** ISO 8601 timestamp when this snapshot was assembled. */
    timestamp: string;
    /** Session ID (if known). */
    sessionId?: string;
    /** Normalized inference subsystem state. */
    inference: InferenceDiagnosticsState;
    /** Normalized MCP inventory state. */
    mcp: McpInventoryDiagnostics;
    /** Names of subsystems currently in degraded or failed state. */
    degradedSubsystems: string[];
    /** Recent failure summary across all subsystems. */
    recentFailures: RuntimeFailureSummary;
    /** Last-updated timestamp per subsystem (keyed by subsystem name). */
    lastUpdatedPerSubsystem: Record<string, string>;
    // ─── Phase 2B extensions ───────────────────────────────────────────────────
    /** Recent operator-triggered runtime control actions. */
    operatorActions: OperatorActionRecord[];
    /** Health scores and suppression state per provider. */
    providerHealthScores: ProviderHealthScore[];
    /** IDs of providers currently suppressed from auto-selection. */
    suppressedProviders: string[];
    /** Recent provider auto-recovery events (ISO timestamps + providerId). */
    recentProviderRecoveries: Array<{ providerId: string; timestamp: string; reason: string }
```

### `CognitiveDiagnosticsSnapshot`
```typescript
interface CognitiveDiagnosticsSnapshot {
    /** ISO timestamp of this snapshot. */
    timestamp: string;
    /** Active cognitive mode. */
    activeMode: 'assistant' | 'rp' | 'hybrid';
    /** Summary of memory contributions in the last cognitive turn. */
    memoryContributionSummary: {
        totalApplied: number;
        byCategory: Partial<Record<MemoryContributionCategory, number>>;
        retrievalSuppressed: boolean;
    }
```

### `RuntimeStatus`
```typescript
type RuntimeStatus = 
    | 'unknown'       // Status has not yet been determined
    | 'disabled'      // Administratively disabled
    | 'starting'      // Startup/connection handshake in progress
    | 'ready'         // Fully operational and accepting requests
    | 'busy'          // Currently processing a request
    | 'degraded'      // Partially operational;
```

### `StreamDiagnosticsStatus`
```typescript
type StreamDiagnosticsStatus = 
    | 'idle'         // No stream in progress or recently completed
    | 'pending'      // Stream requested, not yet opened
    | 'opening'      // Transport connecting, awaiting first token
    | 'streaming'    // Tokens actively flowing
    | 'completed'    // Stream finished successfully
    | 'aborted'      // Stream cancelled (abort signal or user action)
    | 'timed_out'    // Stream open or completion timed out
    | 'failed';
```

### `OperatorActionId`
```typescript
type OperatorActionId = 
    | 'pause_autonomy'
    | 'resume_autonomy'
    | 'enter_safe_mode'
    | 'exit_safe_mode'
    | 'enter_maintenance_mode'
    | 'clear_maintenance_mode'
    | 'retry_subsystem_health_check'
    | 'retry_inference_probe'
    | 'restart_inference_adapter'
    | 'rerun_db_health_validation'
    | 'revalidate_memory_authority'
    | 'rerun_derived_rebuild'
    | 'flush_or_restart_stalled_queues'
    | 'retry_tool_connector_initialization'
    | 'approve_repair_proposal'
    | 'reject_repair_proposal'
    | 'defer_proposal'
    | 'lock_self_improvement'
    | 'unlock_self_improvement'
    | 'require_human_approval_high_risk'
    | 'acknowledge_incident'
    | 'mute_duplicate_alerts'
    | 'pin_active_issue'
    | 'open_evidence_log_trail'
    | 'export_health_snapshot';
```

### `OperatorActionSource`
```typescript
type OperatorActionSource =  'operator' | 'auto_repair';
```

