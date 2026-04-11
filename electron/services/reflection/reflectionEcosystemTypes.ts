/**
 * Reflection Ecosystem Type Definitions
 * 
 * This file contains the complete type system for TALA's self-improvement pipeline.
 * It covers the entire lifecycle of an autonomous engineering task, from issue discovery
 * to validation and promotion.
 * 
 * **State Entities:**
 * - **ReflectionIssue**: A detected problem or opportunity for improvement.
 * - **CandidatePatch**: A staged code change targeting an issue.
 * - **ValidationPlan/Report**: The automated testing protocol and results.
 * - **PromotionRecord**: The final authoritative record of a deployed change.
 * 
 * **Control Entities:**
 * - **SelfImprovementGoal**: A user-defined or system-generated target.
 * - **ReflectionQueueItem**: A task in the agent's work pipeline.
 * - **CapabilityGating**: Access control tokens for critical system operations.
 */
export type ReflectionIssueStatus = 'open' | 'analyzing' | 'hypothesized' | 'staged' | 'validated' | 'promoted' | 'rejected' | 'failed' | 'rolled_back';

export type ToolCapability =
    | "repo_read"
    | "repo_search"
    | "repo_write_staged"
    | "repo_write_docs"
    | "repo_write_tests"
    | "repo_write_protected"
    | "logs_read"
    | "diagnostics_run"
    | "shell_safe"
    | "tests_run"
    | "validation_run"
    | "reflection_read"
    | "reflection_write"
    | "promotion_execute"
    | "rollback_execute"
    | "identity_read"
    | "identity_edit_candidate"
    | "identity_edit_live";

export interface ReflectionIssue {
    issueId: string;
    createdAt: string;
    updatedAt: string;
    title: string;
    trigger: string;
    mode: 'assistant' | 'hybrid' | 'engineering' | string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    confidence: number;
    symptoms: string[];
    reproductionSteps: string[];
    evidenceRefs: string[];
    relatedLogs: string[];
    affectedFiles: string[];
    probableLayer: string;
    rootCauseHypotheses: ReflectionHypothesis[];
    selectedHypothesis?: string;
    status: ReflectionIssueStatus;
    requestedBy: string;
    source: string;
    issueClusterKey?: string;
    issueFamily?: string;
    issueEventCount?: number;
    issueFirstSeenAt?: string;
    issueLastSeenAt?: string;
    issueEscalationReasons?: string[];
    issuePriorRunCount?: number;
}

export interface ReflectionHypothesis {
    hypothesisId: string;
    summary: string;
    rationale: string;
    confidence: number;
    affectedFiles: string[];
    dependencies: string[];
    risks: string[];
    disconfirmingEvidence: string[];
}

export interface CandidatePatch {
    patchId: string;
    createdAt: string;
    issueId: string;
    title: string;
    summary: string;
    filesCreated: string[];
    filesModified: string[];
    filesProtectedTouched: string[];
    stagingPath: string;
    diffPath: string;
    author: string;
    status: 'staged' | 'validating' | 'validation_failed' | 'validation_passed' | 'promoted' | 'rejected';
    riskLevel: 'low' | 'medium' | 'high';
    rollbackPlan: string;
    validationPlanId?: string;
    promotionDecision?: string;
    notes: string;
}

export interface ValidationPlan {
    validationPlanId: string;
    issueId: string;
    patchId: string;
    buildRequired: boolean;
    typecheckRequired: boolean;
    lintRequired: boolean;
    testsRequired: string[];
    smokeChecks: string[];
    behaviorProbes: string[];
    manualReviewRequired: boolean;
    successCriteria: string[];
}

export interface ValidationReport {
    reportId: string;
    issueId: string;
    patchId: string;
    executedAt: string;
    commandResults: Array<{ command: string; exitCode: number; stdout: string; stderr: string }>;
    testsPassed: string[];
    testsFailed: string[];
    smokeResults: any[];
    probeResults: any[];
    overallResult: 'pass' | 'fail' | 'error';
    blockers: string[];
    warnings: string[];
    summary: string;
}

export interface PromotionRecord {
    promotionId: string;
    patchId: string;
    promotedAt: string;
    archiveManifestPath: string;
    filesPromoted: string[];
    filesArchived: string[];
    filesRejected: string[];
    promotedBy: string;
    reason: string;
    rollbackPointer: string;
    outcome: 'success' | 'failure';
}

export interface RollbackRecord {
    rollbackId: string;
    promotionId: string;
    executedAt: string;
    restoredFiles: string[];
    archiveSource: string;
    reason: string;
    outcome: 'success' | 'failure';
}

export interface ReflectionJournalEntry {
    entryId: string;
    timestamp: string;
    issueId: string;
    patchId?: string;
    eventType: 'issue_opened' | 'hypothesis_selected' | 'patch_staged' | 'validation_passed' | 'validation_failed' | 'promotion_accepted' | 'promotion_rejected' | 'rollback_executed';
    summary: string;
    evidence: any;
    decision?: string;
    tests?: any;
    risks?: any;
    nextSteps?: string;
    tags: string[];
    confidence: number;
}

export interface ProtectedFileRule {
    ruleId: string;
    pathPattern: string; // glob or regex string
    category: 'core_routing' | 'mode_persistence' | 'prompt_assembly' | 'identity_definitions' | 'memory_pipeline' | 'tool_service' | 'config' | 'other';
    protectionLevel: 'normal' | 'staged_only' | 'promotion_required' | 'identity_sensitive' | 'immutable';
    allowStagedEdit: boolean;
    allowDirectPromotion: boolean;
    extraValidationRequired: string[];
    notes: string;
}

export interface ImmutableIdentityRule {
    ruleId: string;
    scope: string;
    description: string;
    pathPattern: string;
    forbiddenOperations: ('read' | 'write_staged' | 'write_live' | 'delete')[];
    reviewRequired: boolean;
    notes: string;
}

export type GoalCategory = 'stability' | 'memory' | 'routing' | 'identity' | 'performance' | 'tooling' | 'ui' | 'testing' | 'documentation';
export type GoalPriority = 'low' | 'medium' | 'high' | 'critical';
export type GoalStatus = 'queued' | 'scheduled' | 'active' | 'analyzing' | 'blocked' | 'proposal_ready' | 'validating' | 'awaiting_review' | 'completed' | 'rejected' | 'failed';
export type GoalSource = 'user' | 'system' | 'reflection' | 'operator';

export interface SelfImprovementGoal {
    goalId: string;
    createdAt: string;
    updatedAt: string;
    title: string;
    description: string;
    category: GoalCategory;
    priority: GoalPriority;
    status: GoalStatus;
    source: GoalSource;
    linkedIssueIds: string[];
    linkedPatchIds: string[];
    successCriteria: string[];
    notes: string;
}

export interface ReflectionDashboardState {
    totalReflections: number;
    totalProposals: number;
    appliedChanges: number;
    successRate: number;
    activeIssues: number;
    queuedGoals: number;
    activeGoals: number;
    proposalsReady: number;
    validationFailures: number;
    recentJournalEntries: number;
    recentPromotions: number;
    recentRollbacks: number;
    capabilityState: string | null;
    currentMode: string;
    pipelineActivity?: ReflectionPipelineActivity;
    schedulerState?: ReflectionSchedulerState;
}

export type ReflectionQueueItemType = 'goal' | 'manual_scan' | 'manual_goal_execution' | 'scheduled_scan' | 'scheduled_audit' | 'validation_retry' | 'promotion_followup';
export type ReflectionQueueItemSource = 'user' | 'operator' | 'system' | 'scheduler' | 'reflection';
export type ReflectionQueueItemStatus = 'queued' | 'locked' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked';

export interface ReflectionQueueItem {
    queueItemId: string;
    createdAt: string;
    updatedAt: string;
    type: ReflectionQueueItemType;
    source: ReflectionQueueItemSource;
    priority: GoalPriority;
    status: ReflectionQueueItemStatus;
    goalId?: string;
    issueId?: string;
    triggerMode?: string;
    requestedBy?: string;
    payload?: any;
    lastError?: string;
    attemptCount: number;
    startedAt?: string;
    completedAt?: string;
    lockedBy?: string;
    lockExpiresAt?: number;
    resultSummary?: string;
}

export interface ReflectionSchedulerState {
    enabled: boolean;
    lastTickAt?: string;
    nextTickAt?: string;
    isRunning: boolean;
    activeQueueItemId?: string;
    activeRunType?: string;
    queueDepth: number;
    queuedGoals: number;
    lastRunSummary?: string;
    lastError?: string;
    consecutiveFailures: number;
    maxConcurrentJobs: number;
}

export type ReflectionPipelinePhase = 'idle' | 'queueing' | 'observing' | 'reflecting' | 'patching' | 'validating' | 'promoting' | 'journaling' | 'rolling_back' | 'failed' | 'completed';

export interface ReflectionPipelineActivity {
    isActive: boolean;
    currentPhase: ReflectionPipelinePhase;
    currentQueueItemId?: string;
    currentGoalId?: string;
    currentIssueId?: string;
    currentPatchId?: string;
    currentValidationReportId?: string;
    startedAt?: string;
    elapsedMs?: number;
    lastCompletedAt?: string;
    lastOutcome?: string;
    lastSummary?: string;
    lastError?: string;
    queueDepth: number;
    queuedGoalCount: number;
    activeGoalCount: number;
    proposalsReadyCount: number;
    validationsRunningCount: number;
    promotionsPendingCount: number;
}
