# Contract: governanceTypes.ts

**Source**: [shared\governanceTypes.ts](../../shared/governanceTypes.ts)

## Interfaces

### `ApprovalActor`
```typescript
interface ApprovalActor {
    /** Stable actor identifier. 'local_user' for human; ruleId for policy; 'override' for system. */
    actorId: string;
    kind: ApprovalActorKind;
    label: string;
    timestamp: string;
}
```

### `GovernanceProposalSnapshot`
```typescript
interface GovernanceProposalSnapshot {
    proposalId: string;
    riskScore: number;
    safetyClass: SafetyClass;
    targetSubsystem: string;
    targetFileCount: number;
    hasProtectedFiles: boolean;
    isProtectedSubsystem: boolean;
    hasInvariantSensitivity: boolean;
    rollbackStrategy: RollbackStrategy;
    mutationTypes: PatchUnitChangeType[];
    verificationManualRequired: boolean;
    origin?: string;
}
```

### `ApprovalRecord`
```typescript
interface ApprovalRecord {
    approvalId: string;
    proposalId: string;
    decisionId: string;
    actor: ApprovalActor;
    outcome: 'approved' | 'rejected' | 'deferred' | 'escalated';
    reason?: string;
    timestamp: string;
    proposalSnapshot: GovernanceProposalSnapshot;
}
```

### `ConfirmationRequirement`
```typescript
interface ConfirmationRequirement {
    confirmationId: string;
    proposalId: string;
    kind: ConfirmationKind;
    promptText: string;
    required: boolean;
    satisfied: boolean;
    satisfiedAt?: string;
    satisfiedByActor?: ApprovalActor;
}
```

### `EscalationRequirement`
```typescript
interface EscalationRequirement {
    escalationId: string;
    proposalId: string;
    trigger: EscalationTrigger;
    requiredTierAfterEscalation: AuthorityTier;
    resolved: boolean;
    resolvedAt?: string;
    resolvedByActor?: ApprovalActor;
    notes?: string;
}
```

### `GovernanceRuleCondition`
```typescript
interface GovernanceRuleCondition {
    field: GovernanceRuleConditionField;
    operator: 'eq' | 'neq' | 'gte' | 'lte' | 'gt' | 'lt' | 'in' | 'contains';
    value: string | number | boolean | string[];
}
```

### `GovernanceRule`
```typescript
interface GovernanceRule {
    ruleId: string;
    label: string;
    /** All conditions must match for this rule to fire. */
    conditions: GovernanceRuleCondition[];
    /** The authority tier required when this rule matches. */
    requiredTier: AuthorityTier;
    /** Whether manual confirmation is required even after approval. */
    requiresManualConfirmation: boolean;
    /** Whether escalation is triggered on any verification failure for proposals matching this rule. */
    escalateOnVerificationFailure: boolean;
    /** Human-readable policy rationale. */
    rationale: string;
}
```

### `GovernancePolicy`
```typescript
interface GovernancePolicy {
    policyId: string;
    label: string;
    version: string;
    createdAt: string;
    rules: GovernanceRule[];
    /** Tier applied when no rule matches. Defaults to 'human_review_required'. */
    defaultTier: AuthorityTier;
    /** When true, self-authorization is globally disabled regardless of tier. */
    selfAuthorizationDisabled: boolean;
}
```

### `GovernancePolicyInput`
```typescript
interface GovernancePolicyInput {
    proposalId: string;
    safetyClass: SafetyClass;
    riskScore: number;
    targetSubsystem: string;
    isProtectedSubsystem: boolean;
    targetFiles: string[];
    hasProtectedFile: boolean;
    fileCount: number;
    mutationTypes: PatchUnitChangeType[];
    rollbackStrategy: RollbackStrategy;
    verificationManualRequired: boolean;
    hasInvariantSensitivity: boolean;
}
```

### `GovernanceEvaluationResult`
```typescript
interface GovernanceEvaluationResult {
    evaluatedAt: string;
    proposalId: string;
    policyId: string;
    policyVersion: string;
    resolvedTier: AuthorityTier;
    matchedRules: Array<{ ruleId: string; label: string; rationale: string }
```

### `GovernanceDecision`
```typescript
interface GovernanceDecision {
    decisionId: string;
    proposalId: string;
    createdAt: string;
    updatedAt: string;
    status: GovernanceDecisionStatus;
    /** The resolved authority tier from policy evaluation. */
    requiredTier: AuthorityTier;
    /** The policy that produced this decision. */
    evaluatedPolicyId: string;
    evaluatedPolicyVersion: string;
    /** The specific rules that fired during evaluation. */
    matchedRuleIds: string[];
    /** Why this tier was chosen. */
    tierRationale: string;
    /** Whether self-authorization was applied. */
    selfAuthorized: boolean;
    /** Approval records collected so far. */
    approvals: ApprovalRecord[];
    /** Number of distinct approvals required. */
    approvalsRequired: number;
    /** Confirmation requirements derived from policy evaluation. */
    confirmations: ConfirmationRequirement[];
    /** Escalation records. */
    escalations: EscalationRequirement[];
    /** Human-readable reason when status is 'blocked' or 'rejected'. */
    blockReason?: string;
    /** Whether execution is currently authorized. */
    executionAuthorized: boolean;
    /** When execution authorization was granted. */
    executionAuthorizedAt?: string;
    /** Which approval or policy rule granted authorization. */
    executionAuthorizedBy?: ApprovalActor;
    /** Snapshot of proposal metadata at evaluation time. */
    proposalSnapshot: GovernanceProposalSnapshot;
}
```

### `ExecutionAuthorizationDecision`
```typescript
interface ExecutionAuthorizationDecision {
    authorized: boolean;
    proposalId: string;
    decisionId?: string;
    tier?: AuthorityTier;
    authorizedBy?: ApprovalActor;
    blockReason?: GovernanceBlockReason;
    reason: string;
    evaluatedAt: string;
}
```

### `GovernanceAuditRecord`
```typescript
interface GovernanceAuditRecord {
    auditId: string;
    proposalId: string;
    decisionId: string;
    timestamp: string;
    event: GovernanceAuditEventType;
    actor: ApprovalActor | null;
    detail: string;
    data?: Record<string, unknown>;
}
```

### `ApprovalQueueItem`
```typescript
interface ApprovalQueueItem {
    decisionId: string;
    proposalId: string;
    proposalTitle: string;
    requiredTier: AuthorityTier;
    approvalsRequired: number;
    approvalsReceived: number;
    pendingConfirmations: ConfirmationRequirement[];
    createdAt: string;
    proposalSnapshot: GovernanceProposalSnapshot;
}
```

### `GovernanceDashboardKpis`
```typescript
interface GovernanceDashboardKpis {
    totalDecisions: number;
    selfAuthorized: number;
    humanApproved: number;
    rejected: number;
    pending: number;
    blocked: number;
    escalated: number;
    expired: number;
}
```

### `GovernanceDashboardState`
```typescript
interface GovernanceDashboardState {
    kpis: GovernanceDashboardKpis;
    pendingQueue: ApprovalQueueItem[];
    recentDecisions: GovernanceDecision[];
    activePolicyId: string;
    activePolicyLabel: string;
    selfAuthorizationEnabled: boolean;
    lastUpdatedAt: string;
}
```

### `GovernanceApproveRequest`
```typescript
interface GovernanceApproveRequest {
    proposalId: string;
    reason?: string;
}
```

### `GovernanceRejectRequest`
```typescript
interface GovernanceRejectRequest {
    proposalId: string;
    reason: string;
}
```

### `GovernanceDeferRequest`
```typescript
interface GovernanceDeferRequest {
    proposalId: string;
    reason?: string;
}
```

### `GovernanceSatisfyConfirmationRequest`
```typescript
interface GovernanceSatisfyConfirmationRequest {
    proposalId: string;
    confirmationId: string;
}
```

### `GovernanceEvaluateRequest`
```typescript
interface GovernanceEvaluateRequest {
    proposalId: string;
}
```

### `GovernanceApproveResponse`
```typescript
interface GovernanceApproveResponse {
    success: boolean;
    decision: GovernanceDecision | null;
    record: ApprovalRecord | null;
    error?: string;
}
```

### `AuthorityTier`
```typescript
type AuthorityTier = 
    | 'tala_self_low_risk'
    | 'tala_self_standard'
    | 'protected_subsystem'
    | 'human_review_required'
    | 'human_dual_approval'
    | 'emergency_manual_only'
    | 'blocked';
```

### `GovernanceDecisionStatus`
```typescript
type GovernanceDecisionStatus = 
    | 'pending'
    | 'approved'
    | 'self_authorized'
    | 'rejected'
    | 'deferred'
    | 'escalated'
    | 'blocked'
    | 'expired';
```

### `GovernanceBlockReason`
```typescript
type GovernanceBlockReason = 
    | 'policy_blocked'              // safetyClass === 'blocked' or policy hard-block rule
    | 'awaiting_approval'           // pending human approval
    | 'awaiting_dual_approval'      // pending second human approval
    | 'unmet_confirmation'          // required confirmation not yet satisfied
    | 'unresolved_escalation'       // escalation triggered and not resolved
    | 'rejected_by_human'           // human rejected the proposal
    | 'deferred'                    // proposal deferred for replan
    | 'expired'                     // governance window expired
    | 'no_decision_exists'          // governance has not been evaluated yet
    | 'emergency_manual_only'       // requires emergency manual override only
    | 'self_authorization_disabled';
```

### `ApprovalActorKind`
```typescript
type ApprovalActorKind = 
    | 'human_user'      // human operator approved via UI
    | 'tala_policy'     // Tala self-authorized per explicit policy rule
    | 'system_override';
```

### `ConfirmationKind`
```typescript
type ConfirmationKind = 
    | 'pre_execution_manual'   // explicit manual review before execution
    | 'protected_file_ack'     // acknowledge target files are protected
    | 'dual_approval_ack'      // acknowledge dual approval requirement
    | 'escalation_ack';
```

### `EscalationTrigger`
```typescript
type EscalationTrigger = 
    | 'verification_failure'  // escalation triggered after verification failure
    | 'critical_subsystem'    // target is a critical/protected subsystem
    | 'protected_file'        // one or more protected files targeted
    | 'policy_escalation'     // policy rule explicitly requires escalation
    | 'override_attempted';
```

### `GovernanceRuleConditionField`
```typescript
type GovernanceRuleConditionField = 
    | 'safetyClass'            // SafetyClass value
    | 'riskScore'              // proposal riskScore (0-100)
    | 'targetSubsystem'        // subsystem string match
    | 'isProtectedSubsystem'   // boolean
    | 'hasProtectedFile'       // boolean (any target file is protected)
    | 'fileCount'              // number of target files
    | 'mutationType'           // PatchUnitChangeType value
    | 'rollbackStrategy'       // RollbackStrategy value
    | 'verificationManualRequired' // boolean
    | 'hasInvariantSensitivity';
```

### `GovernanceAuditEventType`
```typescript
type GovernanceAuditEventType = 
    | 'policy_evaluated'
    | 'decision_created'
    | 'approval_recorded'
    | 'rejection_recorded'
    | 'deferral_recorded'
    | 'escalation_triggered'
    | 'escalation_resolved'
    | 'self_authorization_applied'
    | 'confirmation_required'
    | 'confirmation_satisfied'
    | 'execution_authorized'
    | 'execution_authorization_revoked'
    | 'execution_blocked'
    | 'decision_expired';
```

