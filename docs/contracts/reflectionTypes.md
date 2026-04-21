# Contract: reflectionTypes.ts

**Source**: [shared\reflectionTypes.ts](../../shared/reflectionTypes.ts)

## Interfaces

### `ChangeProposal`
```typescript
interface ChangeProposal {
    /** Unique identifier for this proposal. */
    proposalId: string;
    /** The planning run that produced this proposal. */
    runId: string;
    /** ISO timestamp when the proposal was created. */
    createdAt: string;
    /** Short human-readable title. */
    title: string;
    /** Full description of what is proposed and why. */
    description: string;
    /** How the planning run was initiated. */
    origin: ProposalOrigin;
    /** Which planning mode produced this proposal. */
    planningMode: import('./reflectionPlanTypes').PlanningMode;
    /** The primary subsystem this proposal targets. */
    targetSubsystem: string;
    /** Files this proposal intends to modify. */
    targetFiles: string[];
    /** The concrete file-level changes. */
    changes: import('./reflectionPlanTypes').ProposalChange[];
    /** Normalised 0–100 risk score. */
    riskScore: number;
    /** Consolidated risk level derived from blast radius + safety class. */
    riskLevel: ProposalRiskLevel;
    /** Current lifecycle status. */
    status: ProposalStatus;
    /** Whether the proposal may be auto-promoted without human review. */
    promotionEligible: boolean;
    /** Human-readable reasoning for the proposal. */
    reasoning: string;
    /** Whether a model call contributed to the reasoning. */
    modelAssisted: boolean;
    /** Full blast radius assessment (from the planning engine). */
    blastRadius: import('./reflectionPlanTypes').BlastRadiusResult;
    /** Verification steps required before promotion. */
    verificationRequirements: import('./reflectionPlanTypes').VerificationRequirements;
    /** Rollback strategy and safety classification. */
    rollbackPlan: RollbackPlan;
}
```

### `ReflectionRun`
```typescript
interface ReflectionRun {
    runId: string;
    createdAt: string;
    updatedAt: string;
    /** Subsystem that initiated this run. */
    subsystemId: string;
    /** Normalised trigger fingerprint. */
    trigger: import('./reflectionPlanTypes').TriggerFingerprint;
    /** Lifecycle status. */
    status: import('./reflectionPlanTypes').PlanRunStatus;
    /** Planning mode used. */
    planningMode: import('./reflectionPlanTypes').PlanningMode;
    /** Budget limits for this run. */
    budget: ReflectionBudget;
    /** Actual resource consumption. */
    usage: import('./reflectionPlanTypes').BudgetUsage;
    /** ID of the snapshot captured at run start. */
    snapshotId?: string;
    /** Proposals produced by this run. */
    proposals: ChangeProposal[];
    /** Reason this run was stopped, if status is 'failed' or 'budget_exhausted'. */
    failureReason?: string;
    /** Ordered list of milestones reached during this run. */
    milestones: import('./reflectionPlanTypes').PlanRunMilestone[];
}
```

### `ReflectionBudget`
```typescript
interface ReflectionBudget {
    maxModelCalls: number;
    maxSelfModelQueries: number;
    maxAnalysisPasses: number;
    maxRetriesPerStage: number;
    maxDashboardUpdates: number;
}
```

### `Snapshot`
```typescript
interface Snapshot {
    snapshotId: string;
    runId: string;
    capturedAt: string;
    /** Subsystem ownership records from the self-model. */
    subsystemOwnership: import('./reflectionPlanTypes').SubsystemOwnershipRecord[];
    /** Active invariants at the time of capture. */
    invariants: import('./selfModelTypes').SelfModelInvariant[];
    /** Capability list at the time of capture. */
    capabilities: import('./selfModelTypes').SelfModelCapability[];
    /** Component inventory at the time of capture. */
    components: import('./selfModelTypes').SelfModelComponent[];
    /** Initial blast radius computed from snapshot data. */
    blastRadiusInitial: import('./reflectionPlanTypes').BlastRadiusResult;
    /** Test inventory derived from the component list. */
    tests: import('./reflectionPlanTypes').TestInventory;
}
```

### `VerificationRequirement`
```typescript
interface VerificationRequirement {
    /** Unique key for this requirement within the run. */
    requirementId: string;
    /** Category of the check. */
    kind: 'build' | 'typecheck' | 'lint' | 'test' | 'smoke';
    /** Human-readable description of what must pass. */
    description: string;
    /**
     * Command or test path to execute.
     * May be a glob pattern for test requirements.
     */
    target: string;
    /** Whether this requirement blocks promotion if it fails. */
    isBlocking: boolean;
    /** Estimated duration in milliseconds. */
    estimatedMs: number;
}
```

### `RollbackPlan`
```typescript
interface RollbackPlan {
    /**
     * The mechanism used to undo this change.
     *
     * file_restore       — restore individual files from pre-change backup.
     * git_revert         — git revert the promotion commit.
     * config_rollback    — restore configuration keys.
     * no_rollback_needed — additive-only change; no undo required.
     * manual_only        — human must perform rollback; no automated path.
     */
    strategy: import('./reflectionPlanTypes').RollbackStrategy;
    /**
     * Promotion safety tier.
     *
     * safe_auto        — auto-promotable.
     * safe_with_review — allowed after human review.
     * high_risk        — requires explicit approval.
     * blocked          — must not be auto-promoted.
     */
    safetyClass: import('./reflectionPlanTypes').SafetyClass;
    /** Ordered human-readable rollback steps. */
    steps: string[];
    /** Whether human approval is required before promotion. */
    requiresApproval: boolean;
    /** Estimated rollback duration in milliseconds. */
    estimatedRollbackMs: number;
    /** Reasoning that determined the safety class. */
    reasoning: string;
}
```

### `PromotionDecision`
```typescript
interface PromotionDecision {
    proposalId: string;
    runId: string;
    decidedAt: string;
    /** The decision taken. */
    decision: 'promoted' | 'rejected' | 'deferred' | 'failed';
    /** Human-readable reason. */
    reason: string;
    /** Whether all required verifications passed. */
    verificationPassed: boolean;
    /**
     * Pointer to the pre-change backup used for rollback.
     * Only set when decision === 'promoted'.
     */
    rollbackPointer?: string;
    /** Whether this promotion was performed automatically. */
    wasAutomatic: boolean;
}
```

### `PipelineStateSnapshot`
```typescript
interface PipelineStateSnapshot {
    /** Whether a planning run is currently executing. */
    isActive: boolean;
    /** The currently-executing run, if any. */
    currentRunId?: string;
    /** The pipeline stage currently executing. */
    currentStage?: import('./reflectionPlanTypes').PlanPipelineStage;
    /** The subsystem being planned for. */
    currentSubsystem?: string;
    /** ISO timestamp of when the current run started. */
    startedAt?: string;
    /** Elapsed time since run start (ms). */
    elapsedMs?: number;
    /** The most recent milestone reached. */
    lastMilestone?: string;
    /** ISO timestamp of the most recent milestone. */
    lastMilestoneAt?: string;
    /** Number of proposals in 'draft' or 'classified' status. */
    pendingProposals: number;
    /**
     * Summary of recent runs for dashboard list display.
     * Includes at most 10 most recent runs.
     */
    recentRuns: Array<{
        runId: string;
        status: import('./reflectionPlanTypes').PlanRunStatus;
        subsystemId: string;
        completedAt?: string;
    }
```

### `TelemetryEvent`
```typescript
interface TelemetryEvent {
    /** Unique identifier for this event. */
    eventId: string;
    /** The planning run this event belongs to. */
    runId: string;
    /** ISO timestamp. */
    timestamp: string;
    /** Pipeline stage that produced this event. */
    stage: import('./reflectionPlanTypes').PlanPipelineStage | 'system';
    /**
     * Event category for structured filtering.
     *
     * budget      — resource consumption and exhaustion.
     * dedup       — deduplication and cooldown decisions.
     * snapshot    — self-model capture events.
     * blast_radius — blast radius computation results.
     * verification — verification requirement decisions.
     * rollback    — rollback strategy decisions.
     * proposal    — proposal creation and classification.
     * promotion   — promotion decisions.
     * dashboard   — dashboard update events.
     * error       — unexpected errors.
     */
    category:
        | 'budget'
        | 'dedup'
        | 'snapshot'
        | 'blast_radius'
        | 'verification'
        | 'rollback'
        | 'proposal'
        | 'promotion'
        | 'dashboard'
        | 'error';
    /** Human-readable description of the event. */
    message: string;
    /** Optional structured data. */
    data?: Record<string, unknown>;
}
```

### `TriggerIntakeResult`
```typescript
interface TriggerIntakeResult {
    /** Whether a new run was created (true) or the trigger was suppressed. */
    accepted: boolean;
    /** The planning run ID — new if accepted, existing if deduped. */
    runId: string;
    /** Final disposition of this trigger. */
    status: import('./reflectionPlanTypes').PlanRunStatus | 'accepted';
    /** Human-readable explanation of the decision. */
    message: string;
    /**
     * If deduped, the ID of the run this trigger was attached to.
     * If cooldown_blocked, undefined.
     */
    attachedToRunId?: string;
}
```

### `ProposalStatus`
```typescript
type ProposalStatus = 
    | 'draft'
    | 'classified'
    | 'approved'
    | 'rejected'
    | 'promoted'
    | 'rolled_back'
    | 'deferred';
```

### `ProposalRiskLevel`
```typescript
type ProposalRiskLevel =  'safe' | 'low' | 'medium' | 'high' | 'critical';
```

### `ProposalOrigin`
```typescript
type ProposalOrigin =  'auto' | 'scheduled' | 'manual' | 'goal' | 'autonomous';
```

