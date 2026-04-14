# Contract: systemHealthTypes.ts

**Source**: [shared\systemHealthTypes.ts](../../shared/systemHealthTypes.ts)

## Interfaces

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

