# Contract: repairCampaignTypes.ts

**Source**: [shared/repairCampaignTypes.ts](../../shared/repairCampaignTypes.ts)

## Interfaces

### `CampaignBounds`
```typescript
interface CampaignBounds {
    /** Maximum number of steps allowed in the campaign. Hard cap. */
    maxSteps: number;
    /** Maximum number of reassessment decisions allowed per campaign. */
    maxReassessments: number;
    /** Maximum campaign age in milliseconds before it is expired. */
    maxAgeMs: number;
    /** Per-step execution timeout in milliseconds. */
    stepTimeoutMs: number;
    /** Cooldown in milliseconds after a campaign fails or rolls back. */
    cooldownAfterFailureMs: number;
}
```

### `CampaignStep`
```typescript
interface CampaignStep {
    /** Stable unique ID for this step. */
    readonly stepId: CampaignStepId;
    /** Parent campaign ID. */
    readonly campaignId: RepairCampaignId;
    /** 0-based index within the campaign. Immutable after plan creation. */
    readonly order: number;
    /** Human-readable label for this step. */
    readonly label: string;
    /** Target subsystem for this step. */
    readonly targetSubsystem: string;
    /** Scope hint for planning (file paths, module IDs, or a subsystem name). */
    readonly scopeHint: string;
    /** Where this step originated. */
    readonly source: CampaignStepSource;
    /**
     * Optional strategy hint for the planning phase.
     * E.g. a recovery pack ID, a decomposition step kind, or a template key.
     */
    readonly strategyHint?: string;
    /** Whether verification is required after this step. Default: true. */
    readonly verificationRequired: boolean;
    /** Whether this step is expected to be rollback-safe. */
    readonly rollbackExpected: boolean;
    /** If true, a failure in this step triggers skip rather than abort. */
    readonly isOptional: boolean;
    /** Step IDs that must be in 'passed' status before this step can run. */
    readonly prerequisites: readonly CampaignStepId[];

    // ── Mutable state (updated during execution) ──────────────────────────────
    status: CampaignStepStatus;
    startedAt?: string;         // ISO-8601
    completedAt?: string;       // ISO-8601
    /** Phase 3 execution run ID linked to this step's execution, if any. */
    executionRunId?: string;
    /** Checkpoint ID produced after this step completed, if any. */
    checkpointId?: string;
    /** Reason this step was skipped or failed, if applicable. */
    skipReason?: string;
    failureReason?: string;
}
```

### `CampaignCheckpointCheckResult`
```typescript
interface CampaignCheckpointCheckResult {
    /** Human-readable check name. */
    checkName: string;
    passed: boolean;
    detail?: string;
}
```

### `CampaignCheckpoint`
```typescript
interface CampaignCheckpoint {
    /** Stable unique ID for this checkpoint. */
    readonly checkpointId: string;
    readonly campaignId: RepairCampaignId;
    readonly stepId: CampaignStepId;
    readonly evaluatedAt: string;   // ISO-8601
    /** Overall outcome of this checkpoint. */
    readonly outcome: CampaignCheckpointOutcome;
    /** Whether the underlying execution run succeeded. */
    readonly executionSucceeded: boolean;
    /** Individual check results. */
    readonly checks: readonly CampaignCheckpointCheckResult[];
    /** Any invariant violations detected during the checkpoint. */
    readonly invariantViolations: readonly string[];
    /** Whether file mutations occurred outside the step's declared scopeHint. */
    readonly scopeDriftDetected: boolean;
    readonly scopeDriftDetails?: string;
    /** Whether proceeding to the next step is recommended. */
    readonly continueRecommended: boolean;
    /** Human-readable summary of the checkpoint outcome. */
    readonly summary: string;
}
```

### `CampaignReassessmentRecord`
```typescript
interface CampaignReassessmentRecord {
    readonly reassessmentId: string;
    readonly campaignId: RepairCampaignId;
    readonly stepId: CampaignStepId;
    readonly checkpointId: string;
    readonly evaluatedAt: string;         // ISO-8601
    readonly decision: CampaignReassessmentDecision;
    /** Human-readable, non-vague rationale for the decision. */
    readonly rationale: string;
    /** Number of steps remaining at the time of this decision. */
    readonly remainingStepsAtDecision: number;
    /** 0-based index of this reassessment within the campaign. */
    readonly reassessmentIndex: number;
    /** The rule code that triggered this decision. */
    readonly triggerRule: string;
}
```

### `RepairCampaign`
```typescript
interface RepairCampaign {
    readonly campaignId: RepairCampaignId;
    /** Goal ID this campaign was created to address. */
    readonly goalId: string;
    /** Where this campaign was sourced from. */
    readonly originType: CampaignOrigin;
    /** ID of the source artifact (e.g. decomposition plan ID, recovery pack ID). */
    readonly originRef?: string;
    /** Human-readable label for the campaign. */
    readonly label: string;
    /** Target subsystem for this campaign. */
    readonly subsystem: string;
    readonly createdAt: string;     // ISO-8601
    readonly expiresAt: string;     // createdAt + bounds.maxAgeMs
    readonly bounds: CampaignBounds;

    // ── Mutable campaign state ─────────────────────────────────────────────────
    status: RepairCampaignStatus;
    updatedAt: string;              // ISO-8601
    /** Ordered steps. Order is immutable after creation; status fields are mutable. */
    steps: CampaignStep[];
    /** 0-based index of the step currently executing or next to execute. */
    currentStepIndex: number;
    /** Total reassessment decisions made for this campaign so far. */
    reassessmentCount: number;
    /** Checkpoints produced, in order. */
    checkpoints: CampaignCheckpoint[];
    /** Reassessment records, in order. */
    reassessmentRecords: CampaignReassessmentRecord[];
    /** Reason the campaign is in its current terminal or halted state, if applicable. */
    haltReason?: string;
}
```

### `CampaignExecutionRecord`
```typescript
interface CampaignExecutionRecord {
    readonly recordId: string;
    readonly campaignId: RepairCampaignId;
    readonly goalId: string;
    readonly subsystem: string;
    readonly originType: CampaignOrigin;
    readonly startedAt: string;     // ISO-8601
    readonly endedAt: string;       // ISO-8601
    readonly finalStatus: RepairCampaignStatus;
    readonly stepsTotal: number;
    readonly stepsAttempted: number;
    readonly stepsPassed: number;
    readonly stepsFailed: number;
    readonly stepsSkipped: number;
    readonly stepsRolledBack: number;
    readonly totalReassessments: number;
    readonly haltedAtStepId?: CampaignStepId;
    readonly haltReason?: string;
    /** Whether Phase 3 rollback was triggered for any step. */
    readonly rollbackTriggered: boolean;
    /** Ratio: stepsRolledBack / max(1, stepsAttempted). */
    readonly rollbackFrequency: number;
}
```

### `CampaignOutcomeSummary`
```typescript
interface CampaignOutcomeSummary {
    readonly campaignId: RepairCampaignId;
    readonly goalId: string;
    readonly label: string;
    readonly subsystem: string;
    readonly originType: CampaignOrigin;
    readonly finalStatus: RepairCampaignStatus;
    readonly succeeded: boolean;
    readonly rolledBack: boolean;
    readonly deferred: boolean;
    readonly stepCount: number;
    readonly rollbackFrequency: number;
    readonly completedAt: string;   // ISO-8601
    readonly durationMs: number;
    /** Human-readable notes derived from step/checkpoint/reassessment data. */
    readonly learningNotes: readonly string[];
}
```

### `CampaignDashboardKpis`
```typescript
interface CampaignDashboardKpis {
    readonly totalLaunched: number;
    readonly totalSucceeded: number;
    readonly totalFailed: number;
    readonly totalRolledBack: number;
    readonly totalDeferred: number;
    readonly totalAborted: number;
    readonly activeCampaigns: number;
    readonly avgStepsPerCampaign: number;
    readonly avgRollbackFrequency: number;
}
```

### `CampaignDashboardState`
```typescript
interface CampaignDashboardState {
    /** ISO timestamp when this state was computed. */
    readonly computedAt: string;
    /** KPI summary. */
    readonly kpis: CampaignDashboardKpis;
    /** Currently active (non-terminal) campaigns. */
    readonly activeCampaigns: RepairCampaign[];
    /** Deferred or paused campaigns that can be resumed. */
    readonly deferredCampaigns: RepairCampaign[];
    /** Recent completed campaign outcomes (newest first, capped at 20). */
    readonly recentOutcomes: CampaignOutcomeSummary[];
}
```

### `RepairCampaignId`
```typescript
type RepairCampaignId =  string;
```

### `CampaignStepId`
```typescript
type CampaignStepId =  string;
```

### `RepairCampaignStatus`
```typescript
type RepairCampaignStatus = 
    | 'draft'                  // plan built, not yet started
    | 'active'                 // running — ready to advance to next step
    | 'step_in_progress'       // a step is being executed
    | 'awaiting_checkpoint'    // step complete;
```

### `CampaignStepStatus`
```typescript
type CampaignStepStatus = 
    | 'pending'
    | 'running'
    | 'awaiting_verification'
    | 'passed'
    | 'failed'
    | 'skipped'
    | 'rolled_back';
```

### `CampaignCheckpointOutcome`
```typescript
type CampaignCheckpointOutcome =  'passed' | 'degraded' | 'failed';
```

### `CampaignReassessmentDecision`
```typescript
type CampaignReassessmentDecision = 
    | 'continue'
    | 'skip_step'
    | 'defer'
    | 'abort'
    | 'rollback'
    | 'human_review';
```

### `CampaignStepSource`
```typescript
type CampaignStepSource = 
    | 'decomposition_step'   // from a DecompositionPlan step (Phase 5.1)
    | 'recovery_pack_action' // from a RecoveryPack action template (Phase 4.3)
    | 'repair_template'      // from a built-in campaign template
    | 'manual';
```

### `CampaignOrigin`
```typescript
type CampaignOrigin = 
    | 'decomposition'            // from a DecompositionPlan (Phase 5.1)
    | 'recovery_pack'            // from a RecoveryPack multi-step workflow (Phase 4.3)
    | 'repair_template'          // from a built-in campaign template
    | 'manual';
```

