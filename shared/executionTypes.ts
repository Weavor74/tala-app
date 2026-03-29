/**
 * executionTypes.ts — Phase 3 Canonical Execution Contracts
 *
 * P3A: Execution Types & Contracts
 *
 * Canonical shared contracts for the Controlled Execution Layer.
 * Shared between Electron main process and renderer.
 *
 * Design principle: DETERMINISTIC FIRST. MODEL LAST.
 * Execution is gated, bounded, auditable, and rollback-capable.
 *
 * State machine (forward-only):
 *   pending_execution → validating → execution_blocked (terminal)
 *                                  → ready_to_apply → applying
 *                                                     → verifying → succeeded (terminal)
 *                                                                  → failed_verification
 *                                                                    → rollback_pending
 *                                                                      → rolling_back
 *                                                                        → rolled_back (terminal)
 *                                                                        → aborted (terminal)
 *                                                  → rollback_pending (apply failure)
 *   aborted (terminal — any stage)
 */

import type { SafetyClass } from './reflectionPlanTypes';

// ─── Execution Status ─────────────────────────────────────────────────────────

/**
 * Full lifecycle of a controlled execution run.
 *
 * No backwards transitions are permitted.
 * Terminal states: succeeded | rolled_back | aborted | execution_blocked
 */
export type ExecutionStatus =
    | 'pending_execution'
    | 'validating'
    | 'ready_to_apply'
    | 'applying'
    | 'verifying'
    | 'succeeded'
    | 'failed_verification'
    | 'rollback_pending'
    | 'rolling_back'
    | 'rolled_back'
    | 'aborted'
    | 'execution_blocked';

// ─── Execution Authorization ──────────────────────────────────────────────────

/**
 * Explicit authorization record required before execution may begin.
 *
 * Created when a user explicitly authorizes a promoted proposal for execution.
 * Authorization is per-execution-run, not per-proposal, to prevent replay.
 */
export interface ExecutionAuthorization {
    /** ISO timestamp when authorization was granted. */
    authorizedAt: string;
    /** How the authorization was granted. */
    authorizedBy: 'user_explicit';
    /** Proposal status at authorization time — must be 'promoted'. */
    proposalStatus: string;
    /** One-time token issued at authorization time. */
    authorizationToken: string;
    /**
     * Governance decision ID that authorized this execution.
     * Set when a GovernanceDecision with executionAuthorized=true exists for the proposal.
     * Provides a traceable link: ExecutionRun → GovernanceDecision.
     */
    governanceDecisionId?: string;
}

// ─── Eligibility Checks ───────────────────────────────────────────────────────

export type ExecutionEligibilityCheckName =
    | 'proposal_status'        // proposal must be 'promoted'
    | 'proposal_freshness'     // not stale beyond configurable window
    | 'subsystem_lock'         // no active execution for this subsystem
    | 'cooldown'               // subsystem not in post-execution cooldown (5 min success, 15 min failure)
    | 'required_fields'        // targetFiles, changes, verificationRequirements present
    | 'invariant_refs'         // blastRadius invariant references still resolve
    | 'rollback_plan_present'  // rollbackClassification.rollbackSteps non-empty (or no_rollback_needed)
    | 'verification_plan'      // at least one verification requirement present
    | 'authorization'          // valid ExecutionAuthorization exists
    | 'governance_approval';   // governance decision permits execution (P3.5G)

export interface ExecutionEligibilityCheck {
    name: ExecutionEligibilityCheckName;
    passed: boolean;
    detail?: string;
}

/**
 * Result of the pre-execution eligibility gate (P3B).
 *
 * All checks are deterministic — no model calls.
 * A single failed check blocks execution.
 */
export interface ExecutionEligibilityResult {
    eligible: boolean;
    checkedAt: string;
    checks: ExecutionEligibilityCheck[];
    blockedBy?: ExecutionEligibilityCheckName;
    message: string;
}

// ─── Execution Snapshot ───────────────────────────────────────────────────────

export interface FileHashRecord {
    path: string;
    /** SHA-256 hash at planning time (from proposal, may be absent for new files). */
    hashAtPlanningTime?: string;
    /** SHA-256 hash at execution time. */
    hashNow: string;
    /** True when the file has changed since planning. */
    changed: boolean;
}

export interface InvariantSnapshotEntry {
    invariantId: string;
    /** Whether the invariant exists now. */
    presentNow: boolean;
    /** Whether it was present during planning. */
    presentAtPlanningTime: boolean;
}

/**
 * Fresh execution-time snapshot captured just before apply begins (P3C).
 *
 * Answers: "Is this still the same state the proposal was planned against?"
 *
 * If incompatible, execution is blocked and a replan is recommended.
 */
export interface ExecutionSnapshot {
    snapshotId: string;
    executionId: string;
    capturedAt: string;
    /** File hashes for each targetFile at execution time. */
    fileHashes: FileHashRecord[];
    /** True when any targetFile changed since planning. */
    hasFileChanges: boolean;
    /** True when invariant set has drifted since planning. */
    hasInvariantDrift: boolean;
    invariantSnapshot: InvariantSnapshotEntry[];
    /** Overall compatibility verdict. */
    compatible: boolean;
    incompatibilityReasons: string[];
}

// ─── File Mutation Target ─────────────────────────────────────────────────────

/**
 * Explicit declaration of which file a patch unit will mutate.
 *
 * Resolved to an absolute path before apply begins.
 * Relative paths are always forward-slash normalized.
 */
export interface FileMutationTarget {
    /** Repo-relative path, forward-slash normalized. */
    relativePath: string;
    /** Absolute path resolved at patch-plan build time. */
    absolutePath: string;
    /** Expected file size sanity-check before mutation. 0 = skip check. */
    expectedSizeBytes?: number;
    /** SHA-256 of file content before patch (from execution snapshot). */
    expectedHashBefore?: string;
    /** Whether this file is listed in ProtectedFileRegistry. */
    isProtected: boolean;
}

// ─── Patch Unit ───────────────────────────────────────────────────────────────

export type PatchUnitChangeType = 'patch' | 'overwrite' | 'create';
export type PatchUnitApplyStatus = 'pending' | 'applied' | 'skipped' | 'failed';

/**
 * The smallest addressable unit of a patch plan (P3D).
 *
 * Each unit targets exactly one file.
 * No unit may span files.
 * Scope enforcement: only files listed in proposal.targetFiles may have units.
 */
export interface PatchUnit {
    unitId: string;
    patchPlanId: string;
    /** Apply order (1-based). Units are applied in ascending sequence order. */
    sequenceNumber: number;
    target: FileMutationTarget;
    changeType: PatchUnitChangeType;
    /** For 'patch': exact search string (must appear exactly once). */
    search?: string;
    /** For 'patch': replacement string. */
    replace?: string;
    /** For 'create' | 'overwrite': full file content. */
    content?: string;
    reasoning?: string;
    appliedAt?: string;
    applyStatus: PatchUnitApplyStatus;
    applyError?: string;
}

// ─── File Mutation Result ─────────────────────────────────────────────────────

/** Result of applying a single PatchUnit. */
export interface FileMutationResult {
    unitId: string;
    relativePath: string;
    changeType: PatchUnitChangeType;
    success: boolean;
    backupPath?: string;
    hashBefore?: string;
    hashAfter?: string;
    error?: string;
}

// ─── Dry Run ──────────────────────────────────────────────────────────────────

export type DryRunIssueType =
    | 'file_missing'
    | 'search_not_found'
    | 'search_found_multiple'
    | 'file_already_exists'
    | 'protected_file_blocked';

export interface DryRunIssue {
    unitId: string;
    issueType: DryRunIssueType;
    detail: string;
}

export interface DryRunResult {
    simulatedAt: string;
    allUnitsApplicable: boolean;
    issues: DryRunIssue[];
}

// ─── Patch Plan ───────────────────────────────────────────────────────────────

/**
 * Executable, file-bounded patch plan derived from a SafeChangeProposal (P3D).
 *
 * Fully explicit and inspectable before any apply begins.
 * Immutable once built for a run.
 */
export interface PatchPlan {
    patchPlanId: string;
    executionId: string;
    proposalId: string;
    createdAt: string;
    units: PatchUnit[];
    totalUnitCount: number;
    /** Sorted, deduplicated list of all files that will be mutated. */
    affectedFiles: string[];
    dryRunResult?: DryRunResult;
}

// ─── Apply Result ─────────────────────────────────────────────────────────────

export interface ApplyResult {
    executionId: string;
    patchPlanId: string;
    startedAt: string;
    completedAt: string;
    dryRun: boolean;
    unitResults: FileMutationResult[];
    allUnitsApplied: boolean;
    firstFailureUnitId?: string;
    filesChanged: string[];
    backupPaths: string[];
}

// ─── Verification Execution Plan ──────────────────────────────────────────────

/**
 * Concrete verification steps to run after apply (P3F).
 * Built from proposal.verificationRequirements plus execution-time context.
 */
export interface VerificationExecutionPlan {
    planId: string;
    executionId: string;
    requiresBuild: boolean;
    requiresTypecheck: boolean;
    requiresLint: boolean;
    requiredTestPatterns: string[];
    /** Allowlisted commands via SafeCommandService. */
    smokeChecks: string[];
    manualCheckRequired: boolean;
    /** Total allowed wall-clock time in ms. */
    budgetMs: number;
}

export interface VerificationStepResult {
    stepId: string;
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    passed: boolean;
    /** True when this step failing immediately terminates verification. */
    isCritical: boolean;
}

/**
 * Result of running the verification execution plan (P3F).
 */
export interface VerificationExecutionResult {
    planId: string;
    executionId: string;
    startedAt: string;
    completedAt: string;
    stepResults: VerificationStepResult[];
    overallPassed: boolean;
    failedSteps: string[];
    blockers: string[];
    timeoutOccurred: boolean;
    manualCheckRequired: boolean;
    manualCheckRecorded: boolean;
}

// ─── Rollback Execution Plan ──────────────────────────────────────────────────

export type RollbackStepType = 'restore_file' | 'delete_created_file' | 'manual_instruction';

export interface RollbackStep {
    stepId: string;
    /** Execute in ascending sequence order. */
    sequenceNumber: number;
    type: RollbackStepType;
    /** Absolute path of the file to restore/delete. */
    targetPath?: string;
    /** Absolute path to the backup file created during apply. */
    backupPath?: string;
    /** For manual_instruction: human-readable instruction. */
    instruction?: string;
}

export type RollbackTrigger =
    | 'apply_failure'
    | 'verification_failure'
    | 'invariant_failure'
    | 'user_abort'
    | 'timeout_abort';

/**
 * Explicit rollback plan built at patch-plan time — before apply begins (P3G).
 * Must be fully computable without executing anything.
 */
export interface RollbackExecutionPlan {
    planId: string;
    executionId: string;
    /** From RollbackClassification in proposal. */
    strategy: string;
    steps: RollbackStep[];
    estimatedMs: number;
    createdAt: string;
}

export interface RollbackStepResult {
    stepId: string;
    success: boolean;
    detail: string;
}

/**
 * Result of executing a rollback plan (P3G).
 */
export interface RollbackExecutionResult {
    planId: string;
    executionId: string;
    startedAt: string;
    completedAt: string;
    trigger: RollbackTrigger;
    stepResults: RollbackStepResult[];
    overallSuccess: boolean;
    filesRestored: string[];
    filesNotRestored: string[];
}

// ─── Execution Audit ──────────────────────────────────────────────────────────

export type ExecutionAuditStage =
    | 'authorization'
    | 'eligibility'
    | 'snapshot'
    | 'patch_plan'
    | 'dry_run'
    | 'apply'
    | 'verification'
    | 'rollback'
    | 'outcome'
    | 'system';

export type ExecutionAuditEventType =
    | 'run_created'
    | 'gate_passed'
    | 'gate_blocked'
    | 'snapshot_captured'
    | 'snapshot_stale'
    | 'patch_plan_built'
    | 'dry_run_passed'
    | 'dry_run_failed'
    | 'apply_started'
    | 'unit_applied'
    | 'unit_failed'
    | 'apply_complete'
    | 'verification_started'
    | 'step_passed'
    | 'step_failed'
    | 'verification_complete'
    | 'rollback_triggered'
    | 'rollback_step_done'
    | 'rollback_complete'
    | 'outcome_recorded'
    | 'aborted'
    | 'budget_exhausted';

/**
 * A single immutable audit event within an execution run (P3H).
 *
 * Appended to a per-run JSONL file — never mutated after write.
 */
export interface ExecutionAuditRecord {
    auditId: string;
    executionId: string;
    proposalId: string;
    timestamp: string;
    stage: ExecutionAuditStage;
    event: ExecutionAuditEventType;
    actor: 'system' | 'user';
    detail: string;
    data?: Record<string, unknown>;
}

// ─── Execution Outcome ────────────────────────────────────────────────────────

export type ExecutionOutcomeType =
    | 'succeeded'
    | 'failed_verification'
    | 'rolled_back'
    | 'aborted'
    | 'execution_blocked';

/**
 * Final outcome record for an execution run.
 */
export interface ExecutionOutcome {
    executionId: string;
    proposalId: string;
    outcomeType: ExecutionOutcomeType;
    recordedAt: string;
    filesChanged: string[];
    filesRestored: string[];
    verificationPassed: boolean;
    rollbackPerformed: boolean;
    summary: string;
}

// ─── Execution Budget ─────────────────────────────────────────────────────────

/**
 * Hard per-run execution budget (P3J).
 *
 * Any exhausted limit aborts the run.
 * Dimensions with limit = 0 are disabled (never trigger exhaustion).
 */
export interface ExecutionBudget {
    /** Max patch units (file mutations). Default: 10. */
    maxPatchUnits: number;
    /** Max distinct files that may be written. Default: 5. */
    maxFileMutations: number;
    /** Max verification commands. Default: 20. */
    maxVerificationSteps: number;
    /** Total verification wall-clock budget in ms. Default: 120000. */
    maxVerificationMs: number;
    /** Max rollback operations. Default: 10. */
    maxRollbackSteps: number;
    /** Total apply wall-clock budget in ms. Default: 30000. */
    maxApplyMs: number;
    /** Dashboard push budget per run. Default: 8. */
    maxDashboardUpdates: number;
}

export interface ExecutionBudgetUsage {
    patchUnitsUsed: number;
    fileMutationsUsed: number;
    verificationStepsUsed: number;
    verificationMsUsed: number;
    rollbackStepsUsed: number;
    applyMsUsed: number;
    dashboardUpdatesUsed: number;
}

// ─── Execution Milestone ──────────────────────────────────────────────────────

export type ExecutionMilestoneName =
    | 'execution_created'
    | 'eligibility_passed'
    | 'snapshot_ready'
    | 'patch_plan_ready'
    | 'dry_run_complete'
    | 'apply_complete'
    | 'verification_complete'
    | 'rollback_complete'
    | 'outcome_recorded';

export interface ExecutionMilestone {
    name: ExecutionMilestoneName;
    timestamp: string;
    notes?: string;
}

// ─── Execution Telemetry Event ────────────────────────────────────────────────

export interface ExecutionTelemetryEvent {
    eventId: string;
    executionId: string;
    timestamp: string;
    stage: ExecutionAuditStage | 'system';
    category:
        | 'gate'
        | 'snapshot'
        | 'patch'
        | 'apply'
        | 'verification'
        | 'rollback'
        | 'outcome'
        | 'budget'
        | 'error';
    message: string;
    data?: Record<string, unknown>;
}

// ─── Execution Run ────────────────────────────────────────────────────────────

/**
 * Authoritative record of a single controlled execution run.
 *
 * Persisted at every status transition so partial results survive crashes.
 */
export interface ExecutionRun {
    executionId: string;
    proposalId: string;
    planRunId: string;
    subsystemId: string;
    targetFiles: string[];
    createdAt: string;
    updatedAt: string;
    status: ExecutionStatus;
    authorization: ExecutionAuthorization;
    eligibilityResult?: ExecutionEligibilityResult;
    snapshot?: ExecutionSnapshot;
    patchPlan?: PatchPlan;
    applyResult?: ApplyResult;
    verificationResult?: VerificationExecutionResult;
    rollbackPlan?: RollbackExecutionPlan;
    rollbackResult?: RollbackExecutionResult;
    outcome?: ExecutionOutcome;
    /** Path to audit JSONL file for this run. */
    auditPointer: string;
    budget: ExecutionBudget;
    usage: ExecutionBudgetUsage;
    abortReason?: string;
    milestones: ExecutionMilestone[];
    dryRun: boolean;
}

// ─── Dashboard State ──────────────────────────────────────────────────────────

export interface ExecutionDashboardKpis {
    totalExecutions: number;
    succeeded: number;
    failedVerification: number;
    rolledBack: number;
    aborted: number;
    activeExecutions: number;
    successRate: number;
}

export interface ExecutionDashboardState {
    kpis: ExecutionDashboardKpis;
    activeRun?: ExecutionRun;
    recentRuns: ExecutionRun[];
    promotedProposalsReady: number;
    lastUpdatedAt: string;
}

// ─── IPC Contract Types ───────────────────────────────────────────────────────

export interface ExecutionStartRequest {
    proposalId: string;
    authorizedBy: 'user_explicit';
    dryRun?: boolean;
}

export interface ExecutionStartResponse {
    executionId: string;
    status: ExecutionStatus;
    message: string;
    eligibilityResult?: ExecutionEligibilityResult;
    blocked: boolean;
}

export interface ExecutionStatusResponse {
    execution: ExecutionRun | null;
    found: boolean;
}

export interface ExecutionListResponse {
    executions: ExecutionRun[];
    total: number;
}

export interface ExecutionAbortRequest {
    executionId: string;
    reason: string;
}
