# Contract: escalationTypes.ts

**Source**: [shared\escalationTypes.ts](../../shared/escalationTypes.ts)

## Interfaces

### `TaskCapabilityAssessment`
```typescript
interface TaskCapabilityAssessment {
    /** ID of the goal being assessed. */
    goalId: string;
    /** ISO timestamp when the assessment was made. */
    assessedAt: string;
    /** Whether the active model is assessed as capable of handling this goal. */
    canHandle: boolean;
    /** All insufficiency reasons detected. Empty when canHandle=true. */
    insufficiencyReasons: CapabilityInsufficiencyReason[];
    /** Estimated context tokens required for this task. */
    estimatedContextTokens: number;
    /** Active model's context window limit (tokens). 0 = unknown. */
    modelContextLimit: number;
    /** Number of recent local failures for this goal/subsystem. */
    recentLocalFailures: number;
    /** Complexity score, 0–100. Higher = more complex. */
    complexityScore: number;
    /** Human-readable rationale for the assessment decision. */
    rationale: string;
}
```

### `EscalationPolicy`
```typescript
interface EscalationPolicy {
    /** Which escalation policy is active. */
    policyKind: EscalationPolicyKind;
    /**
     * Maximum escalation requests allowed per hour (anti-spam guard).
     * Default: 3
     */
    maxEscalationRequestsPerHour: number;
    /**
     * Minimum local failure count before escalation is considered.
     * Default: 2
     */
    minLocalFailuresBeforeEscalation: number;
    /**
     * Task classes allowed for auto-escalation (only used when
     * policyKind === 'auto_escalate_for_allowed_classes').
     */
    allowedTaskClasses: string[];
    /**
     * Maximum decomposition depth allowed. Prevents infinite recursion.
     * Default: 2
     */
    maxDecompositionDepth: number;
    /**
     * Maximum steps allowed per decomposition plan.
     * Default: 5
     */
    maxStepsPerDecomposition: number;
    /**
     * Cooldown after a failed decomposition attempt (ms).
     * Default: 30 minutes
     */
    decompositionCooldownMs: number;
    /**
     * Whether remote escalation always requires human approval.
     * Default: true (local-first: no silent remote escalation)
     */
    requireHumanApprovalForRemote: boolean;
    /**
     * Complexity threshold above which a task is considered high-complexity.
     * Default: 70 (out of 100)
     */
    highComplexityThreshold: number;
    /**
     * Context size utilization ratio above which context_size_exceeded fires.
     * E.g. 0.85 = 85% of model's context limit.
     * Default: 0.85
     */
    contextSizeThresholdRatio: number;
    /**
     * Minimum local failures before context_exceeded or high_complexity
     * alone triggers an insufficiency assessment.
     * Default: 1
     */
    minFailuresForContextTrigger: number;
}
```

### `EscalationRequest`
```typescript
interface EscalationRequest {
    /** Stable unique ID for this request. */
    requestId: string;
    /** Goal ID this request is for. */
    goalId: string;
    /** ISO timestamp when the request was created. */
    requestedAt: string;
    /** Insufficiency reasons that triggered the request. */
    insufficiencyReasons: CapabilityInsufficiencyReason[];
    /** Suggested target model identifier, if known. */
    suggestedTargetModel?: string;
    /** Human-readable rationale for the escalation request. */
    rationale: string;
}
```

### `EscalationDecision`
```typescript
interface EscalationDecision {
    /** ID of the escalation request being decided. */
    requestId: string;
    /** Goal ID this decision applies to. */
    goalId: string;
    /** ISO timestamp when the decision was made. */
    decidedAt: string;
    /** Whether escalation to remote is allowed under current policy. */
    escalationAllowed: boolean;
    /** Why escalation was denied (only set when escalationAllowed=false). */
    denialReason?: string;
    /** Whether human approval is required before executing the escalation. */
    requiresHumanApproval: boolean;
    /** Target model for escalation (only set when escalationAllowed=true). */
    targetModel?: string;
    /** Human-readable rationale for this decision. */
    rationale: string;
}
```

### `DecompositionStep`
```typescript
interface DecompositionStep {
    /** Stable unique ID for this step. */
    stepId: string;
    /** Parent plan ID. */
    planId: string;
    /** 0-based index within the plan. */
    stepIndex: number;
    /** How this step partitions the original task. */
    kind: DecompositionStepKind;
    /** Human-readable description of this step. */
    description: string;
    /**
     * Scope hint for this step (e.g. filename, subsystem ID, change class).
     * Used to guide the planning phase for this step's execution.
     */
    scopeHint: string;
    /** Whether this step is independently safe to execute in isolation. */
    independent: boolean;
    /** Whether this step can be verified in isolation before proceeding. */
    verifiable: boolean;
    /** Whether this step can be rolled back if it fails. */
    rollbackable: boolean;
    /** Estimated context tokens required for this step. */
    estimatedTokens: number;
}
```

### `DecompositionPlan`
```typescript
interface DecompositionPlan {
    /** Stable unique ID for this plan. */
    planId: string;
    /** Goal ID this plan is for. */
    goalId: string;
    /** ISO timestamp when the plan was created. */
    createdAt: string;
    /** Ordered list of bounded steps. */
    steps: DecompositionStep[];
    /** Number of steps (convenience accessor). */
    totalSteps: number;
    /** Decomposition depth (1-based). Max determined by policy.maxDecompositionDepth. */
    depth: number;
    /** Human-readable rationale for how the task was decomposed. */
    rationale: string;
    /**
     * Whether the plan is bounded by policy constraints.
     * Always true — this is a safety invariant.
     */
    bounded: true;
}
```

### `ExecutionStrategyDecision`
```typescript
interface ExecutionStrategyDecision {
    /** Goal ID this decision applies to. */
    goalId: string;
    /** ISO timestamp when the decision was made. */
    decidedAt: string;
    /** Selected execution strategy. */
    strategy: EscalationStrategyKind;
    /** Human-readable reason for the strategy choice. */
    reason: string;
    /** Machine-readable reason codes. */
    reasonCodes: EscalationReasonCode[];
    /**
     * Decomposition plan ID when strategy === 'decompose_local'.
     * Used to track the plan in the audit tracker.
     */
    decompositionPlanId?: string;
    /**
     * Escalation request ID when strategy === 'escalate_remote'.
     */
    escalationRequestId?: string;
}
```

### `DecompositionStepResult`
```typescript
interface DecompositionStepResult {
    /** Step ID from the plan. */
    stepId: string;
    /** 0-based step index. */
    stepIndex: number;
    /** Outcome of this step's execution. */
    outcome: DecompositionStepOutcome;
    /** Execution run ID if this step went through the execution pipeline. */
    executionRunId?: string;
    /** Failure reason when outcome === 'failed' or 'rolled_back'. */
    failureReason?: string;
    /** ISO timestamp when this step completed. */
    completedAt: string;
}
```

### `DecompositionResult`
```typescript
interface DecompositionResult {
    /** Plan ID from the decomposition plan. */
    planId: string;
    /** Goal ID. */
    goalId: string;
    /** ISO timestamp when all steps completed. */
    completedAt: string;
    /**
     * Overall outcome:
     *   succeeded — all steps succeeded
     *   partial   — some steps succeeded, some failed
     *   failed    — all steps failed or the first step failed
     */
    overallOutcome: 'succeeded' | 'partial' | 'failed';
    /** Total step count from the plan. */
    stepsTotal: number;
    /** Number of steps that succeeded. */
    stepsSucceeded: number;
    /** Number of steps that failed or were rolled back. */
    stepsFailed: number;
    /** Per-step results. */
    stepResults: DecompositionStepResult[];
    /** Human-readable summary of the decomposition result. */
    rationale: string;
}
```

### `EscalationAuditRecord`
```typescript
interface EscalationAuditRecord {
    /** Unique record ID. */
    recordId: string;
    /** Goal ID this record belongs to. */
    goalId: string;
    /** Run ID if this event occurred during a run (optional). */
    runId?: string;
    /** What happened. */
    eventKind: EscalationAuditEventKind;
    /** ISO timestamp. */
    recordedAt: string;
    /** Human-readable description of the event. */
    detail: string;
    /** Optional structured data (serializable). */
    data?: Record<string, unknown>;
}
```

### `EscalationKpis`
```typescript
interface EscalationKpis {
    /** Total task capability assessments performed. */
    totalAssessments: number;
    /** Assessments where canHandle=true. */
    totalCapableAssessments: number;
    /** Assessments where canHandle=false. */
    totalIncapableAssessments: number;
    /** Total escalation requests generated. */
    totalEscalationRequests: number;
    /** Escalation requests that were allowed by policy. */
    totalEscalationsAllowed: number;
    /** Escalation requests that were denied by policy. */
    totalEscalationsDenied: number;
    /** Total decomposition plans created. */
    totalDecompositions: number;
    /** Decompositions that succeeded (all or partial). */
    totalDecompositionsSucceeded: number;
    /** Decompositions that fully failed. */
    totalDecompositionsFailed: number;
    /** Goals deferred due to escalation/capability constraints. */
    totalDeferredByEscalation: number;
    /** Goals escalated to human review by this layer. */
    totalHumanEscalations: number;
}
```

### `EscalationDashboardState`
```typescript
interface EscalationDashboardState {
    /** ISO timestamp when this state was computed. */
    computedAt: string;
    /** KPI summary. */
    kpis: EscalationKpis;
    /** Recent capability assessments (capped at 20, newest first). */
    recentAssessments: TaskCapabilityAssessment[];
    /** Recent strategy decisions (capped at 20, newest first). */
    recentStrategyDecisions: ExecutionStrategyDecision[];
    /** Recent decomposition plans created (capped at 20, newest first). */
    recentDecompositionPlans: DecompositionPlan[];
    /** Recent decomposition results (capped at 20, newest first). */
    recentDecompositionResults: DecompositionResult[];
    /** Recent audit records (capped at 50, newest first). */
    recentAuditRecords: EscalationAuditRecord[];
    /** Number of decomposition plans currently active (in-progress). */
    activeDecompositions: number;
    /** Active escalation policy. */
    policy: EscalationPolicy;
}
```

### `CapabilityInsufficiencyReason`
```typescript
type CapabilityInsufficiencyReason = 
    | 'context_size_exceeded'     // estimated task context exceeds model limit
    | 'repeated_local_failures'   // ≥N local planning/execution failures for this goal
    | 'high_complexity_task'      // complexity score exceeds configured threshold
    | 'multi_file_repair_scope'   // repair involves multiple files beyond local scope
    | 'recovery_pack_exhausted'   // all matched recovery packs tried and failed
    | 'low_confidence_output';
```

### `EscalationPolicyKind`
```typescript
type EscalationPolicyKind = 
    | 'local_only'
    | 'local_preferred_with_request'
    | 'auto_escalate_for_allowed_classes'
    | 'remote_allowed'
    | 'remote_required_for_high_complexity';
```

### `DecompositionStepKind`
```typescript
type DecompositionStepKind = 
    | 'file_scope'
    | 'change_type'
    | 'verification_stage'
    | 'partial_fix';
```

### `EscalationStrategyKind`
```typescript
type EscalationStrategyKind = 
    | 'proceed_local'
    | 'escalate_remote'
    | 'decompose_local'
    | 'defer'
    | 'escalate_human';
```

### `EscalationReasonCode`
```typescript
type EscalationReasonCode = 
    | 'model_can_handle'
    | 'context_within_limit'
    | 'no_recent_failures'
    | 'context_exceeded'
    | 'repeated_failures'
    | 'high_complexity'
    | 'multi_file_scope'
    | 'pack_exhausted'
    | 'low_confidence'
    | 'escalation_policy_local_only'
    | 'escalation_allowed_by_policy'
    | 'escalation_requires_approval'
    | 'escalation_spam_guard'
    | 'escalation_insufficient_failures'
    | 'decomposition_possible'
    | 'decomposition_not_possible'
    | 'decomposition_depth_exceeded'
    | 'decomposition_cooldown_active'
    | 'no_viable_strategy';
```

### `DecompositionStepOutcome`
```typescript
type DecompositionStepOutcome =  'succeeded' | 'failed' | 'skipped' | 'rolled_back';
```

### `EscalationAuditEventKind`
```typescript
type EscalationAuditEventKind = 
    | 'capability_assessed'
    | 'escalation_requested'
    | 'escalation_allowed'
    | 'escalation_denied'
    | 'escalation_approved_by_human'
    | 'decomposition_planned'
    | 'decomposition_started'
    | 'decomposition_step_completed'
    | 'decomposition_completed'
    | 'decomposition_failed'
    | 'strategy_selected'
    | 'fallback_applied';
```

