# Contract: turnArbitrationTypes.ts

**Source**: [shared\turnArbitrationTypes.ts](../../shared/turnArbitrationTypes.ts)

## Interfaces

### `AgentTurnRequest`
```typescript
interface AgentTurnRequest {
    turnId: string;
    conversationId: string;
    userText: string;
    attachments?: unknown[];
    workspaceContext?: Record<string, unknown>;
    activeGoalId?: string;
    operatorMode?: 'chat' | 'goal' | 'auto';
    requestedSurface?: string;
}
```

### `TurnIntentProfile`
```typescript
interface TurnIntentProfile {
    conversationalWeight: number;
    hybridWeight: number;
    goalExecutionWeight: number;
    hasExplicitGoalLanguage: boolean;
    hasExecutionVerb: boolean;
    referencesActiveWork: boolean;
    likelyNeedsMultiStepExecution: boolean;
    likelyNeedsOnlyExplanation: boolean;
    containsDirectQuestion: boolean;
    containsBuildOrFixRequest: boolean;
    selfInspectionDetected?: boolean;
    selfInspectionOperation?: 'read' | 'edit' | 'search' | 'list' | 'unknown';
    selfInspectionRequestedPaths?: string[];
    selfInspectionReasonCodes?: string[];
    selfKnowledgeDetected?: boolean;
    selfKnowledgeRequestedAspects?: Array<
        | 'identity'
        | 'capabilities'
        | 'tools'
        | 'architecture'
        | 'systems'
        | 'memory'
        | 'filesystem'
        | 'permissions'
        | 'runtime_mode'
        | 'limits'
        | 'invariants'
        | 'unknown'
    >;
    selfKnowledgeScope?: 'broad' | 'specific';
    selfKnowledgeReasonCodes?: string[];
    isOperationalSystemRequest?: boolean;
    isImmersiveRelationalRequest?: boolean;
    rpIdentityOntologyDetected?: boolean;
    reasonCodes: string[];
}
```

### `TurnArbitrationDecision`
```typescript
interface TurnArbitrationDecision {
    turnId: string;
    mode: TurnMode;
    source: TurnArbitrationSource;
    confidence: number;
    reasonCodes: string[];
    goalIntent: TurnIntentStrength;
    shouldCreateGoal: boolean;
    shouldResumeGoal: boolean;
    activeGoalId?: string;
    requiresPlan: boolean;
    requiresExecutionLoop: boolean;
    authorityLevel: TurnAuthorityLevel;
    memoryWriteMode: MemoryWriteMode;
    selfInspectionRequest?: boolean;
    selfInspectionOperation?: 'read' | 'edit' | 'search' | 'list' | 'unknown';
    selfInspectionRequestedPaths?: string[];
    selfKnowledgeDetected?: boolean;
    selfKnowledgeRequestedAspects?: Array<
        | 'identity'
        | 'capabilities'
        | 'tools'
        | 'architecture'
        | 'systems'
        | 'memory'
        | 'filesystem'
        | 'permissions'
        | 'runtime_mode'
        | 'limits'
        | 'invariants'
        | 'unknown'
    >;
    selfKnowledgeRouted?: boolean;
    selfKnowledgeSourceTruths?: string[];
    selfKnowledgeBypassedFallback?: boolean;
    personaIdentityProtection?: boolean;
    isOperationalSystemRequest?: boolean;
    isImmersiveRelationalRequest?: boolean;
    rpIdentityOntologyDetected?: boolean;
}
```

### `TurnAuthorityEnvelope`
```typescript
interface TurnAuthorityEnvelope {
    turnId: string;
    mode: TurnMode;
    authorityLevel: TurnAuthorityLevel;
    workflowAuthority: boolean;
    canCreateDurableState: boolean;
    canReplan: boolean;
}
```

### `KernelTurnDiagnosticsView`
```typescript
interface KernelTurnDiagnosticsView {
    turnId: string;
    mode: TurnMode;
    arbitrationSource: TurnArbitrationSource;
    confidence: number;
    reasonCodes: string[];
    planningInvoked: boolean;
    executionInvoked: boolean;
    authorityLevel: TurnAuthorityLevel;
    activeGoalId?: string;
    createdGoalId?: string;
    selfInspectionRequest?: boolean;
    selfInspectionOperation?: 'read' | 'edit' | 'search' | 'list' | 'unknown';
    selfInspectionRequestedPaths?: string[];
    selfKnowledgeDetected?: boolean;
    selfKnowledgeRequestedAspects?: string[];
    selfKnowledgeRouted?: boolean;
    selfKnowledgeSourceTruths?: string[];
    selfKnowledgeBypassedFallback?: boolean;
    personaIdentityProtection?: boolean;
    rpIdentityOntologyDetected?: boolean;
    updatedAt: string;
}
```

### `TurnMode`
```typescript
type TurnMode = 
    | 'conversational'
    | 'hybrid'
    | 'goal_execution';
```

### `TurnIntentStrength`
```typescript
type TurnIntentStrength =  'none' | 'weak' | 'strong';
```

### `TurnAuthorityLevel`
```typescript
type TurnAuthorityLevel = 
    | 'none'
    | 'lightweight'
    | 'full_authority';
```

### `TurnArbitrationSource`
```typescript
type TurnArbitrationSource = 
    | 'operator_override'
    | 'continuity'
    | 'rule_based'
    | 'policy';
```

### `MemoryWriteMode`
```typescript
type MemoryWriteMode = 
    | 'conversation_only'
    | 'episodic'
    | 'goal_episode';
```

