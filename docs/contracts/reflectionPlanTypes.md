# Contract: reflectionPlanTypes.ts

**Source**: [shared/reflectionPlanTypes.ts](../../shared/reflectionPlanTypes.ts)

## Interfaces

### `PlanRunBudget`
```typescript
interface PlanRunBudget {
    /** Maximum LLM model calls for the entire run. Default: 1. */
    maxModelCalls: number;
    /** Maximum reads from the self-model service. Default: 6. */
    maxSelfModelQueries: number;
    /** Maximum analysis passes over snapshot data. Default: 1. */
    maxAnalysisPasses: number;
    /** Maximum retries per pipeline stage on transient error. Default: 1. */
    maxRetriesPerStage: number;
    /**
     * Maximum dashboard push events for this run.
     * Updates are only emitted at defined milestones; internal steps
     * NEVER trigger a push.  Default: 5 (one per milestone).
     */
    maxDashboardUpdates: number;
}
```

### `BudgetUsage`
```typescript
interface BudgetUsage {
    modelCallsUsed: number;
    selfModelQueriesUsed: number;
    analysisPassesUsed: number;
    retriesUsed: number;
    dashboardUpdatesUsed: number;
}
```

### `BudgetCheckResult`
```typescript
interface BudgetCheckResult {
    allowed: boolean;
    /** Which limit would be exceeded if the operation proceeds. */
    blockedBy?: keyof BudgetUsage;
    remaining: Partial<Record<keyof BudgetUsage, number>>;
}
```

### `PlanTriggerInput`
```typescript
interface PlanTriggerInput {
    /** Subsystem that produced the trigger (e.g. "inference", "memory"). */
    subsystemId: string;
    /** Structured issue category (e.g. "repeated_timeout", "mcp_instability"). */
    issueType: string;
    /** Specific resource, file, or component affected. */
    normalizedTarget: string;
    /**
     * Severity of the triggering event.
     * Critical severity overrides cooldown and deduplication guards.
     */
    severity: 'low' | 'medium' | 'high' | 'critical';
    /** Free-text context carried from the telemetry signal or user request. */
    description?: string;
    /** Planning mode override; defaults to 'standard'. */
    planningMode?: PlanningMode;
    /** ID of the queued goal or reflection issue that originated this trigger. */
    sourceGoalId?: string;
    sourceIssueId?: string;
    /** Whether the trigger was explicitly requested by a user. */
    isManual?: boolean;
}
```

### `TriggerFingerprint`
```typescript
interface TriggerFingerprint {
    subsystemId: string;
    issueType: string;
    normalizedTarget: string;
    /**
     * Time bucket (ISO date truncated to the hour) — prevents "same problem
     * from 5 minutes ago" from being counted as a different fingerprint
     * while still allowing re-analysis after a full cooldown window.
     */
    timeBucket: string;
    /** Pre-computed hex string for fast equality checks. */
    hash: string;
}
```

### `DedupCheckResult`
```typescript
interface DedupCheckResult {
    isDuplicate: boolean;
    /** Run that already covers this fingerprint, if any. */
    existingRunId?: string;
    existingRunStatus?: PlanRunStatus;
}
```

### `SubsystemCooldownState`
```typescript
interface SubsystemCooldownState {
    subsystemId: string;
    /** Unix timestamp (ms) when the cooldown expires. */
    expiresAt: number;
    /** Why the cooldown was imposed. */
    reason: string;
}
```

### `SubsystemOwnershipRecord`
```typescript
interface SubsystemOwnershipRecord {
    subsystemId: string;
    primaryFiles: string[];
    secondaryFiles: string[];
    layer: string;
    owner?: string;
}
```

### `TestInventory`
```typescript
interface TestInventory {
    totalTests: number;
    testFiles: string[];
    coverageSubsystems: string[];
}
```

### `PlanningRunSnapshot`
```typescript
interface PlanningRunSnapshot {
    snapshotId: string;
    runId: string;
    capturedAt: string;
    subsystemOwnership: SubsystemOwnershipRecord[];
    invariants: import('./selfModelTypes').SelfModelInvariant[];
    capabilities: import('./selfModelTypes').SelfModelCapability[];
    components: import('./selfModelTypes').SelfModelComponent[];
    blastRadiusInitial: BlastRadiusResult;
    tests: TestInventory;
}
```

### `BlastRadiusResult`
```typescript
interface BlastRadiusResult {
    /** Subsystems whose files overlap with the target change. */
    affectedSubsystems: string[];
    /** Individual files that would be touched directly or transitively. */
    affectedFiles: string[];
    /** Invariants that are at risk from the proposed change. */
    threatenedInvariantIds: string[];
    /**
     * Aggregate risk tier based on the number of affected subsystems
     * and the presence of critical invariants.
     */
    invariantRisk: 'none' | 'low' | 'medium' | 'high' | 'critical';
    /** Normalised 0–100 impact score derived from affected surface area. */
    estimatedImpactScore: number;
    /**
     * Invariant IDs that strictly block this change from being auto-approved.
     * A non-empty list forces `safetyClass` to at least 'safe_with_review'.
     */
    blockedBy: string[];
}
```

### `VerificationRequirements`
```typescript
interface VerificationRequirements {
    requiresBuild: boolean;
    requiresTypecheck: boolean;
    requiresLint: boolean;
    /** Names or path patterns of tests that MUST pass. */
    requiredTests: string[];
    /** Quick smoke-check commands to run in order. */
    smokeChecks: string[];
    /**
     * Whether a human must review before promotion.
     * Always true when safetyClass is 'high_risk' or 'blocked'.
     */
    manualReviewRequired: boolean;
    /** Estimated total verification time in milliseconds. */
    estimatedDurationMs: number;
}
```

### `RollbackClassification`
```typescript
interface RollbackClassification {
    strategy: RollbackStrategy;
    safetyClass: SafetyClass;
    /** Ordered list of concrete rollback steps. */
    rollbackSteps: string[];
    requiresApproval: boolean;
    estimatedRollbackMs: number;
    /** Reasoning that determined the safety class. */
    classificationReasoning: string;
}
```

### `ProposalChange`
```typescript
interface ProposalChange {
    type: 'modify' | 'create' | 'delete' | 'patch';
    path: string;
    /** For 'patch': the exact string to find. */
    search?: string;
    /** For 'patch': the replacement string. */
    replace?: string;
    /** For 'create' / 'modify': full file content. */
    content?: string;
    reasoning?: string;
}
```

### `SafeChangeProposal`
```typescript
interface SafeChangeProposal {
    proposalId: string;
    runId: string;
    createdAt: string;
    title: string;
    description: string;
    planningMode: PlanningMode;
    targetSubsystem: string;
    targetFiles: string[];
    changes: ProposalChange[];
    blastRadius: BlastRadiusResult;
    verificationRequirements: VerificationRequirements;
    rollbackClassification: RollbackClassification;
    status: 'draft' | 'classified' | 'approved' | 'rejected' | 'promoted' | 'rolled_back';
    /** Normalised 0–100 risk score. */
    riskScore: number;
    /** Whether the proposal is eligible for auto-promotion. */
    promotionEligible: boolean;
    /** Human-readable justification for the proposal. */
    reasoning: string;
    /** Whether a model call contributed to this proposal's content. */
    modelAssisted: boolean;
}
```

### `ProposalPromotionResult`
```typescript
interface ProposalPromotionResult {
    proposalId: string;
    runId: string;
    promotedAt: string;
    outcome: 'promoted' | 'rejected' | 'deferred' | 'failed';
    reason: string;
    verificationPassed: boolean;
    rollbackPointer?: string;
}
```

### `PlanRunMilestone`
```typescript
interface PlanRunMilestone {
    name:
        | 'run_started'
        | 'snapshot_ready'
        | 'proposal_created'
        | 'proposal_classified'
        | 'run_complete'
        | 'run_failed';
    timestamp: string;
    notes?: string;
}
```

### `PlanRun`
```typescript
interface PlanRun {
    runId: string;
    createdAt: string;
    updatedAt: string;
    subsystemId: string;
    trigger: TriggerFingerprint;
    status: PlanRunStatus;
    planningMode: PlanningMode;
    budget: PlanRunBudget;
    usage: BudgetUsage;
    snapshotId?: string;
    proposals: SafeChangeProposal[];
    /** Set when status === 'failed' or 'budget_exhausted'. */
    failureReason?: string;
    /** Ordered list of milestones reached. Used for dashboard throttling. */
    milestones: PlanRunMilestone[];
}
```

### `PlanningDashboardKpis`
```typescript
interface PlanningDashboardKpis {
    totalRuns: number;
    totalProposals: number;
    promotedProposals: number;
    successRate: number;
    activeRuns: number;
    proposalsReady: number;
    budgetExhaustedRuns: number;
    dedupedRuns: number;
    cooldownBlockedRuns: number;
}
```

### `PlanningPipelineState`
```typescript
interface PlanningPipelineState {
    isActive: boolean;
    currentRunId?: string;
    currentStage?: PlanPipelineStage;
    currentSubsystem?: string;
    startedAt?: string;
    elapsedMs?: number;
    lastMilestone?: string;
    lastMilestoneAt?: string;
    pendingProposals: number;
    recentRuns: Array<{ runId: string; status: PlanRunStatus; subsystemId: string; completedAt?: string }
```

### `PlanningDashboardState`
```typescript
interface PlanningDashboardState {
    kpis: PlanningDashboardKpis;
    pipeline: PlanningPipelineState;
    recentProposals: SafeChangeProposal[];
    lastUpdatedAt: string;
}
```

### `PlanningTelemetryEvent`
```typescript
interface PlanningTelemetryEvent {
    eventId: string;
    runId: string;
    timestamp: string;
    stage: PlanPipelineStage | 'system';
    category: 'budget' | 'dedup' | 'snapshot' | 'blast_radius' | 'verification' | 'rollback' | 'proposal' | 'promotion' | 'dashboard' | 'error';
    message: string;
    data?: Record<string, unknown>;
}
```

### `PlanningTriggerRequest`
```typescript
interface PlanningTriggerRequest {
    trigger: PlanTriggerInput;
}
```

### `PlanningTriggerResponse`
```typescript
interface PlanningTriggerResponse {
    runId: string;
    status: PlanRunStatus;
    message: string;
    /** If deduplicated, the ID of the existing run being reused. */
    attachedToRunId?: string;
}
```

### `PlanningRunStatusResponse`
```typescript
interface PlanningRunStatusResponse {
    run: PlanRun | null;
    found: boolean;
}
```

### `PlanningListProposalsResponse`
```typescript
interface PlanningListProposalsResponse {
    proposals: SafeChangeProposal[];
    total: number;
}
```

### `PlanningMode`
```typescript
type PlanningMode =  'light' | 'standard' | 'deep';
```

### `PlanRunStatus`
```typescript
type PlanRunStatus = 
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'budget_exhausted'
    | 'deduped'
    | 'cooldown_blocked';
```

### `RollbackStrategy`
```typescript
type RollbackStrategy = 
    | 'file_restore'
    | 'git_revert'
    | 'config_rollback'
    | 'no_rollback_needed'
    | 'manual_only';
```

### `SafetyClass`
```typescript
type SafetyClass =  'safe_auto' | 'safe_with_review' | 'high_risk' | 'blocked';
```

### `PlanPipelineStage`
```typescript
type PlanPipelineStage = 
    | 'intake'
    | 'dedup_check'
    | 'budget_init'
    | 'snapshot'
    | 'blast_radius'
    | 'verification'
    | 'rollback_classify'
    | 'proposal_generate'
    | 'proposal_classify'
    | 'done';
```

