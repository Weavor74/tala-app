# Contract: system-health-types.ts

**Source**: [shared\system-health-types.ts](../../shared/system-health-types.ts)

## Interfaces

### `SystemModeContract`
```typescript
interface SystemModeContract {
    mode: SystemOperatingMode;
    entry_conditions: string[];
    exit_conditions: string[];
    allowed_capabilities: SystemCapability[];
    blocked_capabilities: SystemCapability[];
    fallback_behavior: string[];
    user_facing_behavior_changes: string[];
    telemetry_expectations: string[];
    operator_actions_allowed: string[];
    autonomy_allowed: boolean;
    writes_allowed: boolean;
    operator_approval_required_for: string[];
}
```

### `SystemModeTransition`
```typescript
interface SystemModeTransition {
    from_mode: SystemOperatingMode;
    to_mode: SystemOperatingMode;
    transitioned_at: string;
    reason_codes: string[];
}
```

### `SystemCapabilityAvailability`
```typescript
interface SystemCapabilityAvailability {
    capability: string;
    status: SystemCapabilityAvailabilityStatus;
    reason: string;
    approval_required: boolean;
    impacted_by: string[];
}
```

### `SystemHealthIncidentEntry`
```typescript
interface SystemHealthIncidentEntry {
    incident_id: string;
    title: string;
    severity: SystemIncidentSeverity;
    start_time: string;
    dedup_family: string;
    current_state: string;
    evidence_links: string[];
    automated_actions_attempted: string[];
    recommended_operator_actions: string[];
}
```

### `SystemTrustExplanation`
```typescript
interface SystemTrustExplanation {
    telemetry_freshness: {
        inference_age_ms: number;
        mcp_age_ms: number;
        expected_max_age_ms: number;
    }
```

### `SystemHealthSubsystemSnapshot`
```typescript
interface SystemHealthSubsystemSnapshot {
    name: string;
    status: SystemHealthOverallStatus;
    severity: SystemHealthSubsystemSeverity;
    last_checked_at: string;
    last_changed_at: string;
    reason_codes: string[];
    evidence: string[];
    operator_impact: string;
    auto_action_state: SystemHealthAutoActionState;
    recommended_actions: string[];
}
```

### `SystemHealthSnapshot`
```typescript
interface SystemHealthSnapshot {
    timestamp: string;
    overall_status: SystemHealthOverallStatus;
    subsystem_entries: SystemHealthSubsystemSnapshot[];
    trust_score: number;
    degraded_capabilities: string[];
    blocked_capabilities: string[];
    active_fallbacks: string[];
    active_incidents: string[];
    pending_repairs: string[];
    current_mode: string;
    effective_mode: SystemOperatingMode;
    active_degradation_flags: SystemDegradationFlag[];
    mode_contract: SystemModeContract;
    recent_mode_transitions: SystemModeTransition[];
    capability_matrix: SystemCapabilityAvailability[];
    active_incident_entries: SystemHealthIncidentEntry[];
    trust_explanation: SystemTrustExplanation;
    operator_attention_required: boolean;
}
```

### `SystemHealthOverallStatus`
```typescript
type SystemHealthOverallStatus = 
    | 'healthy'
    | 'degraded'
    | 'impaired'
    | 'recovery'
    | 'maintenance'
    | 'failed';
```

### `SystemOperatingMode`
```typescript
type SystemOperatingMode = 
    | 'NORMAL'
    | 'DEGRADED_INFERENCE'
    | 'DEGRADED_MEMORY'
    | 'DEGRADED_TOOLS'
    | 'DEGRADED_AUTONOMY'
    | 'SAFE_MODE'
    | 'READ_ONLY'
    | 'RECOVERY'
    | 'MAINTENANCE';
```

### `SystemDegradationFlag`
```typescript
type SystemDegradationFlag =  Exclude<SystemOperatingMode, 'NORMAL'>;
```

### `SystemCapability`
```typescript
type SystemCapability = 
    | 'chat_inference'
    | 'workflow_execute'
    | 'tool_execute_read'
    | 'tool_execute_write'
    | 'tool_execute_diagnostic'
    | 'memory_canonical_read'
    | 'memory_canonical_write'
    | 'memory_promotion'
    | 'autonomy_execute'
    | 'repair_execute'
    | 'repair_promotion'
    | 'self_modify';
```

### `SystemHealthSubsystemSeverity`
```typescript
type SystemHealthSubsystemSeverity =  'info' | 'warning' | 'error' | 'critical';
```

### `SystemHealthAutoActionState`
```typescript
type SystemHealthAutoActionState = 
    | 'none'
    | 'monitoring'
    | 'fallback_active'
    | 'repair_pending'
    | 'repair_active'
    | 'blocked';
```

### `SystemCapabilityAvailabilityStatus`
```typescript
type SystemCapabilityAvailabilityStatus = 
    | 'available'
    | 'degraded'
    | 'blocked'
    | 'approval_required';
```

### `SystemIncidentSeverity`
```typescript
type SystemIncidentSeverity =  'info' | 'warning' | 'error' | 'critical';
```

