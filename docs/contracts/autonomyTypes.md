# Contract: autonomyTypes.ts

**Source**: [shared/autonomyTypes.ts](../../shared/autonomyTypes.ts)

## Interfaces

### `GoalPriorityScore`
```typescript
interface GoalPriorityScore {
    /** Composite score 0–100. Higher = more urgent. */
    total: number;
    severityWeight: number;         // 0–30
    recurrenceWeight: number;       // 0–20
    subsystemImportanceWeight: number; // 0–15
    confidenceWeight: number;       // 0–15
    governanceLikelihoodWeight: number; // 0–10
    rollbackConfidenceWeight: number;  // 0–10
    executionCostPenalty: number;   // 0–10 (higher cost = lower score)
    protectedPenalty: number;       // 0..−20 (penalty if protected subsystem)
}
```

### `TelemetryAnomalyContext`
```typescript
interface TelemetryAnomalyContext {
    kind: 'telemetry_anomaly';
    metricName: string;
    observedValue: number;
    threshold: number;
    windowMs: number;
}
```

### `RepeatedExecutionFailureContext`
```typescript
interface RepeatedExecutionFailureContext {
    kind: 'repeated_execution_failure';
    failureCount: number;
    periodMs: number;
    lastExecutionRunId: string;
    failureReason?: string;
}
```

### `GovernanceBlockContext`
```typescript
interface GovernanceBlockContext {
    kind: 'repeated_governance_block';
    blockCount: number;
    lastDecisionId: string;
}
```

### `StaleSubsystemContext`
```typescript
interface StaleSubsystemContext {
    kind: 'stale_subsystem';
    lastModifiedAt?: string;
    staleDays: number;
}
```

### `UserSeededContext`
```typescript
interface UserSeededContext {
    kind: 'user_seeded';
    userNote?: string;
}
```

### `WeakCoverageContext`
```typescript
interface WeakCoverageContext {
    kind: 'weak_coverage_signal';
    testCount: number;
    missingCoverageIndicators: string[];
}
```

### `BacklogGoalContext`
```typescript
interface BacklogGoalContext {
    kind: 'unresolved_backlog_item';
    age: number;             // days since creation
    previousAttempts: number;
}
```

### `RecurringReflectionGoalContext`
```typescript
interface RecurringReflectionGoalContext {
    kind: 'recurring_reflection_goal';
    recurrenceCount: number;
    lastOccurrence: string;  // ISO string of most recent queued instance
}
```

### `GenericGoalSourceContext`
```typescript
interface GenericGoalSourceContext {
    kind: 'generic';
    detail?: string;
}
```

### `GoalCandidate`
```typescript
interface GoalCandidate {
    candidateId: string;
    detectedAt: string;
    source: GoalSource;
    subsystemId: string;
    title: string;
    description: string;
    sourceContext: GoalSourceContext;
    /** Fingerprint for deduplication: sha-based on source + subsystemId + title. */
    dedupFingerprint: string;
    /** Whether a matching active/recent AutonomousGoal already exists. */
    isDuplicate: boolean;
}
```

### `AutonomousGoal`
```typescript
interface AutonomousGoal {
    goalId: string;
    createdAt: string;
    updatedAt: string;
    source: GoalSource;
    subsystemId: string;
    title: string;
    description: string;
    status: GoalStatus;
    priorityTier: GoalPriorityTier;
    priorityScore: GoalPriorityScore;
    /** Whether this goal is eligible to proceed without human initiation. */
    autonomyEligible: boolean;
    /** The policy decision record that determined autonomy eligibility. */
    policyDecisionId?: string;
    /** The planning run ID produced from this goal, if any. */
    planRunId?: string;
    /** The change proposal ID, if any. */
    proposalId?: string;
    /** The governance decision ID, if any. */
    governanceDecisionId?: string;
    /** The execution run ID, if any. */
    executionRunId?: string;
    /** The outcome learning record ID, if any. */
    learningRecordId?: string;
    /** How many autonomous attempts have been made for this goal. */
    attemptCount: number;
    /** Whether this goal is blocked pending human review. */
    humanReviewRequired: boolean;
    /** Source signal details. */
    sourceContext: GoalSourceContext;
    /** Telemetry fingerprint for deduplication. */
    dedupFingerprint: string;
}
```

### `GoalSelectionDecision`
```typescript
interface GoalSelectionDecision {
    decisionId: string;
    decidedAt: string;
    cycleId: string;
    candidatesEvaluated: number;
    selectedGoalId: string | null;
    suppressedGoalIds: string[];
    suppressionReasons: Record<string, string>;
    budgetAvailable: boolean;
    rationale: string;
}
```

### `AutonomyPolicyDecision`
```typescript
interface AutonomyPolicyDecision {
    decisionId: string;
    goalId: string;
    evaluatedAt: string;
    permitted: boolean;
    blockReason?: AutonomyBlockReason;
    /** Which policy category matched. */
    resolvedCategoryPolicy: string;
    cooldownExpiresAt?: string;
    rationale: string;
    /** Whether this should be routed to human review queue. */
    requiresHumanReview: boolean;
}
```

### `AutonomousRunMilestone`
```typescript
interface AutonomousRunMilestone {
    name: AutonomousRunMilestoneName;
    reachedAt: string;
    detail?: string;
}
```

### `AutonomousRun`
```typescript
interface AutonomousRun {
    runId: string;
    goalId: string;
    cycleId: string;
    startedAt: string;
    completedAt?: string;
    status: AutonomousRunStatus;
    subsystemId: string;
    planRunId?: string;
    proposalId?: string;
    governanceDecisionId?: string;
    executionRunId?: string;
    policyDecisionId?: string;
    outcomeId?: string;
    failureReason?: string;
    abortReason?: string;
    milestones: AutonomousRunMilestone[];
    // ── Phase 4.3: Recovery Pack linkage (optional — only set when a pack was used) ──
    /** Recovery pack ID used for this run, if any. */
    recoveryPackId?: string;
    /** Match strength of the recovery pack used, if any. */
    recoveryPackMatchStrength?: 'no_match' | 'weak_match' | 'strong_match';
    // ── Phase 5.1: Escalation & Decomposition linkage (optional) ──
    /** Escalation request ID if escalation was triggered for this run. */
    escalationRequestId?: string;
    /** Decomposition plan ID if the run executed under a decomposition plan. */
    decompositionPlanId?: string;
    /** Step index executed (0-based) when running under a decomposition plan. */
    decompositionStepIndex?: number;
}
```

### `AutonomousAttemptRecord`
```typescript
interface AutonomousAttemptRecord {
    attemptId: string;
    goalId: string;
    runId: string;
    attemptedAt: string;
    outcome: AttemptOutcome;
    failureReason?: string;
    governanceBlockReason?: string;
    executionRunId?: string;
    proposalId?: string;
}
```

### `LearningRecord`
```typescript
interface LearningRecord {
    recordId: string;
    goalId: string;
    subsystemId: string;
    source: GoalSource;
    createdAt: string;
    updatedAt: string;
    successCount: number;
    failureCount: number;
    rollbackCount: number;
    governanceBlockCount: number;
    lastOutcome: AttemptOutcome;
    lastAttemptAt: string;
    /** Confidence modifier applied to future goals of same pattern. 0.0–1.0 */
    confidenceModifier: number;
    /** Aggregate key for dedup and suppression. Derived from source+subsystemId+title hash. */
    patternKey: string;
}
```

### `GoalCooldownRecord`
```typescript
interface GoalCooldownRecord {
    cooldownId: string;
    subsystemId: string;
    patternKey: string;
    reason: CooldownReason;
    startedAt: string;
    expiresAt: string;
    active: boolean;
}
```

### `AutonomyBudget`
```typescript
interface AutonomyBudget {
    /** Maximum autonomous runs allowed per rolling period. Default: 5. */
    maxRunsPerPeriod: number;
    /** Rolling window length in ms. Default: 60 minutes. */
    periodMs: number;
    /** Maximum concurrent active autonomous runs globally. Default: 1. */
    maxConcurrentRuns: number;
    /** Maximum concurrent runs for a single subsystem. Default: 1. */
    maxConcurrentRunsPerSubsystem: number;
    /** Cooldown after failure in ms. Default: 15 min. */
    failureCooldownMs: number;
    /** Cooldown after governance block in ms. Default: 30 min. */
    governanceBlockCooldownMs: number;
    /** Cooldown after rollback in ms. Default: 60 min. */
    rollbackCooldownMs: number;
    /** Max attempts on the same goal pattern before permanent human review routing. Default: 3. */
    maxAttemptsPerPattern: number;
}
```

### `AutonomyTelemetryEvent`
```typescript
interface AutonomyTelemetryEvent {
    eventId: string;
    timestamp: string;
    type: AutonomyTelemetryEventType;
    goalId?: string;
    runId?: string;
    subsystemId?: string;
    detail: string;
    data?: Record<string, unknown>;
}
```

### `AutonomyCategoryPolicy`
```typescript
interface AutonomyCategoryPolicy {
    /** Matches a GoalSource value. */
    categoryId: string;
    label: string;
    autonomyEnabled: boolean;
    /** Max risk score (0–100) allowed for autonomous action. Goals above are human-routed. */
    maxRiskScore: number;
    /** Max files allowed in the resulting proposal. */
    maxFileScope: number;
    /** Whether protected subsystems are allowed under this category. */
    allowProtectedSubsystems: boolean;
}
```

### `AutonomyPolicy`
```typescript
interface AutonomyPolicy {
    policyId: string;
    label: string;
    version: string;
    /** When false, the entire autonomy layer is disabled. Default: false (safe default). */
    globalAutonomyEnabled: boolean;
    budget: AutonomyBudget;
    categoryPolicies: AutonomyCategoryPolicy[];
    /** Subsystem IDs that are hard-blocked from any autonomous action. */
    hardBlockedSubsystems: string[];
}
```

### `AutonomyDashboardKpis`
```typescript
interface AutonomyDashboardKpis {
    totalGoalsDetected: number;
    totalRunsStarted: number;
    totalRunsSucceeded: number;
    totalRunsFailed: number;
    totalRunsRolledBack: number;
    totalPolicyBlocked: number;
    totalGovernanceBlocked: number;
    totalSuppressed: number;
    activeRuns: number;
    pendingGoals: number;
}
```

### `AutonomyDashboardState`
```typescript
interface AutonomyDashboardState {
    kpis: AutonomyDashboardKpis;
    activeRuns: AutonomousRun[];
    pendingGoals: AutonomousGoal[];
    blockedGoals: AutonomousGoal[];
    recentRuns: AutonomousRun[];
    recentTelemetry: AutonomyTelemetryEvent[];
    learningRecords: LearningRecord[];
    budget: AutonomyBudget;
    budgetUsedThisPeriod: number;
    globalAutonomyEnabled: boolean;
    lastUpdatedAt: string;
    // ── Phase 4.3: Recovery Pack summaries (optional — present when pack layer is active) ──
    recoveryPackSummaries?: import('./recoveryPackTypes').RecoveryPackOutcomeSummary[];
    // ── Phase 5: Adaptive Intelligence Layer state (optional — present when adaptive layer is active) ──
    adaptiveState?: import('./adaptiveTypes').AdaptiveDashboardState;
    // ── Phase 5.1: Escalation & Decomposition state (optional — present when escalation layer is active) ──
    escalationState?: import('./escalationTypes').EscalationDashboardState;
    // ── Phase 5.5: Repair Campaign state (optional — present when campaign layer is active) ──
    campaignState?: import('./repairCampaignTypes').CampaignDashboardState;
}
```

### `GoalSource`
```typescript
type GoalSource = 
    | 'telemetry_anomaly'           // sustained degraded metric from TelemetryService
    | 'repeated_execution_failure'  // ≥N failures on same subsystem in period
    | 'repeated_governance_block'   // repeated governance blocks for same area
    | 'stale_subsystem'             // subsystem not touched in threshold window
    | 'failed_verification'         // verification failure in ExecutionRun
    | 'recurring_reflection_goal'   // goal already in GoalService that recurs
    | 'weak_coverage_signal'        // low test coverage signal from self-model
    | 'unresolved_backlog_item'     // old, unactioned improvement in backlog
    | 'user_seeded';
```

### `GoalPriorityTier`
```typescript
type GoalPriorityTier = 
    | 'critical'    // immediate action warranted;
```

### `GoalStatus`
```typescript
type GoalStatus = 
    | 'candidate'           // detected, not yet scored
    | 'scored'              // prioritized, not yet selected
    | 'selected'            // chosen for this cycle
    | 'policy_gate_pending' // awaiting autonomy policy evaluation
    | 'policy_approved'     // autonomy gate passed;
```

### `GoalSourceContext`
```typescript
type GoalSourceContext = 
    | TelemetryAnomalyContext
    | RepeatedExecutionFailureContext
    | GovernanceBlockContext
    | StaleSubsystemContext
    | WeakCoverageContext
    | BacklogGoalContext
    | RecurringReflectionGoalContext
    | UserSeededContext
    | GenericGoalSourceContext;
```

### `AutonomyBlockReason`
```typescript
type AutonomyBlockReason = 
    | 'policy_category_disabled'     // this goal category is not autonomous
    | 'protected_subsystem'          // subsystem requires human gating
    | 'risk_class_blocked'           // risk too high for autonomous action
    | 'file_scope_exceeded'          // too many files;
```

### `AutonomousRunStatus`
```typescript
type AutonomousRunStatus = 
    | 'pending'
    | 'running'
    | 'planning'
    | 'governance_pending'
    | 'executing'
    | 'succeeded'
    | 'failed'
    | 'rolled_back'
    | 'policy_blocked'
    | 'governance_blocked'
    | 'aborted'
    | 'budget_exhausted';
```

### `AutonomousRunMilestoneName`
```typescript
type AutonomousRunMilestoneName = 
    | 'run_started'
    | 'policy_evaluated'
    | 'planning_started'
    | 'proposal_created'
    | 'governance_submitted'
    | 'governance_resolved'
    | 'execution_started'
    | 'execution_completed'
    | 'outcome_recorded'
    | 'run_completed'
    | 'run_failed'
    | 'run_aborted';
```

### `AttemptOutcome`
```typescript
type AttemptOutcome = 
    | 'succeeded'
    | 'failed'
    | 'policy_blocked'
    | 'governance_blocked'
    | 'rolled_back'
    | 'aborted';
```

### `CooldownReason`
```typescript
type CooldownReason = 
    | 'execution_failure'
    | 'rollback'
    | 'governance_block'
    | 'verification_failure'
    | 'budget_exhausted';
```

### `AutonomyTelemetryEventType`
```typescript
type AutonomyTelemetryEventType = 
    | 'goal_detected'
    | 'goal_scored'
    | 'goal_selected'
    | 'goal_suppressed'
    | 'goal_deduplicated'
    | 'policy_evaluated'
    | 'policy_approved'
    | 'policy_blocked'
    | 'run_started'
    | 'planning_started'
    | 'proposal_created'
    | 'governance_submitted'
    | 'governance_approved'
    | 'governance_blocked'
    | 'execution_started'
    | 'execution_succeeded'
    | 'execution_failed'
    | 'execution_rolled_back'
    | 'outcome_learned'
    | 'cooldown_applied'
    | 'budget_exhausted'
    | 'loop_suppressed'
    | 'detection_cycle_started'
    | 'detection_cycle_completed'
    | 'detection_source_error'
    // ── Phase 4.3: Recovery Pack telemetry events ──────────────────────────
    | 'recovery_pack_match_attempted'
    | 'recovery_pack_matched'
    | 'recovery_pack_rejected'
    | 'recovery_pack_used'
    | 'recovery_pack_fallback'
    | 'recovery_pack_outcome_recorded'
    | 'recovery_pack_confidence_adjusted'
    // ── Phase 5.5: Repair Campaign telemetry events ─────────────────────────
    | 'campaign_created'
    | 'campaign_step_started'
    | 'campaign_step_completed'
    | 'campaign_step_skipped'
    | 'campaign_step_failed'
    | 'campaign_step_rolled_back'
    | 'campaign_checkpoint_completed'
    | 'campaign_reassessment_decided'
    | 'campaign_halted'
    | 'campaign_deferred'
    | 'campaign_aborted'
    | 'campaign_rolled_back'
    | 'campaign_completed'
    | 'campaign_resumed'
    | 'campaign_expired'
    | 'campaign_safety_bound_triggered';
```

