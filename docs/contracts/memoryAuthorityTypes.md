# Contract: memoryAuthorityTypes.ts

**Source**: [shared\memoryAuthorityTypes.ts](../../shared/memoryAuthorityTypes.ts)

## Interfaces

### `MemoryWriteRequest`
```typescript
interface MemoryWriteRequest {
    writeId: string;
    category: MemoryWriteCategory;
    source: MemoryWriteSource;
    turnId?: string;
    conversationId?: string;
    goalId?: string;
    episodeType?: string;
    payload: Record<string, unknown>;
}
```

### `MemoryAuthorityContext`
```typescript
interface MemoryAuthorityContext {
    turnId?: string;
    conversationId?: string;
    goalId?: string;
    turnMode?: TurnMode;
    memoryWriteMode?: MemoryWriteMode;
    authorityEnvelope?: TurnAuthorityEnvelope;
    systemAuthority?: boolean;
}
```

### `MemoryAuthorityDecision`
```typescript
interface MemoryAuthorityDecision {
    requestId: string;
    decision: MemoryWriteAuthorityDecision;
    category: MemoryWriteCategory;
    reasonCodes: MemoryAuthorityReasonCode[];
    requiresGoalId: boolean;
    requiresTurnContext: boolean;
    requiresDurableStateAuthority: boolean;
    normalizedWriteMode?: MemoryWriteMode;
}
```

### `MemoryAuthorityDiagnosticsView`
```typescript
interface MemoryAuthorityDiagnosticsView {
    lastDecision?: MemoryAuthorityDecision;
    lastDeniedCategory?: MemoryWriteCategory;
    lastDeniedReasonCodes: MemoryAuthorityReasonCode[];
    allowCount: number;
    denyCount: number;
    countsByCategory: Partial<Record<MemoryWriteCategory, number>>;
    countsByWriteMode: Partial<Record<MemoryWriteMode | 'unknown', number>>;
    lastUpdated: string;
}
```

### `MemoryWriteCategory`
```typescript
type MemoryWriteCategory = 
    | 'conversation_summary'
    | 'conversation_memory'
    | 'episodic_memory'
    | 'planning_episode'
    | 'execution_episode'
    | 'recovery_episode'
    | 'goal_state';
```

### `MemoryWriteAuthorityDecision`
```typescript
type MemoryWriteAuthorityDecision =  'allow' | 'deny';
```

### `MemoryAuthorityReasonCode`
```typescript
type MemoryAuthorityReasonCode = 
    | 'missing_turn_context'
    | 'missing_authority_envelope'
    | 'missing_memory_write_mode'
    | 'invalid_category_for_write_mode'
    | 'durable_state_not_permitted'
    | 'goal_linkage_required'
    | 'goal_execution_mode_required'
    | 'hybrid_goal_write_not_permitted'
    | 'authority_level_insufficient'
    | 'source_not_allowed'
    | 'policy_blocked'
    | 'system_authority_required';
```

### `MemoryWriteSource`
```typescript
type MemoryWriteSource = 
    | 'agent_kernel'
    | 'planning_service'
    | 'planning_loop'
    | 'tool_execution'
    | 'workflow_handoff'
    | 'agent_handoff'
    | 'memory_service'
    | 'reflection_service'
    | 'system';
```

