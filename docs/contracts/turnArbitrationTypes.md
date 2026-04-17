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
    memoryWriteMode: 'conversation_only' | 'episodic' | 'goal_episode';
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

