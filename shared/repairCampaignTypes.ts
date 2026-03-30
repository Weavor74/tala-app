/**
 * repairCampaignTypes.ts — Phase 5.5 Canonical Repair Campaign Contracts
 *
 * P5.5A: Repair Campaign Types & Contracts
 *
 * Canonical shared contracts for the Multi-Step Repair Campaign Layer.
 * Shared between Electron main process and renderer.
 *
 * Design principles:
 * - Local-first: no network, no cloud state
 * - Deterministic-first: all step sequencing and reassessment is rule-based
 * - Bounded: campaigns have hard caps on steps, reassessments, and age
 * - Auditable: every campaign transition is recorded with timestamp and reason
 * - Non-bypassing: all campaign steps still flow through planning, governance, execution
 * - No recursion: campaigns may not spawn child campaigns
 * - One active campaign per subsystem
 *
 * Relationship to prior phases:
 *   Phase 4   (autonomy)         — AutonomousGoal drives campaign creation
 *   Phase 5.1 (decomposition)    — DecompositionPlan steps can seed campaign steps
 *   Phase 4.3 (recovery packs)   — RecoveryPack multi-step workflows can seed steps
 *   Phase 2   (planning)         — SafeChangePlanner is invoked per step
 *   Phase 3.5 (governance)       — every step requires governance approval
 *   Phase 3   (execution)        — every step requires execution eligibility
 */

// ─── Identity ─────────────────────────────────────────────────────────────────

/** Stable identifier for a repair campaign. Prefixed `campaign-`. */
export type RepairCampaignId = string;

/** Stable identifier for a campaign step. Prefixed `step-`. */
export type CampaignStepId = string;

// ─── Status enumerations ──────────────────────────────────────────────────────

/**
 * Lifecycle status of a repair campaign.
 *
 * Transitions:
 *   draft → active → step_in_progress → awaiting_checkpoint → awaiting_reassessment → active (loop)
 *   awaiting_reassessment → paused | deferred | aborted | rolled_back | succeeded
 *   active → expired (if age exceeded before next step)
 */
export type RepairCampaignStatus =
    | 'draft'                  // plan built, not yet started
    | 'active'                 // running — ready to advance to next step
    | 'step_in_progress'       // a step is being executed
    | 'awaiting_checkpoint'    // step complete; checkpoint evaluation in progress
    | 'awaiting_reassessment'  // checkpoint done; reassessment decision pending
    | 'paused'                 // halted pending human review (scope drift / invariant violation)
    | 'deferred'               // temporarily suspended; may be resumed
    | 'succeeded'              // all required steps completed successfully
    | 'failed'                 // campaign aborted due to unrecoverable step failure
    | 'rolled_back'            // campaign terminated after rollback
    | 'aborted'                // campaign aborted by bounds exceeded or operator action
    | 'expired';               // campaign exceeded maxAgeMs without resolution

/**
 * Lifecycle status of a single campaign step.
 *
 * Valid transitions:
 *   pending → running → awaiting_verification → passed
 *                     → failed
 *                     → rolled_back
 *   pending → skipped  (only via reassessment engine)
 */
export type CampaignStepStatus =
    | 'pending'
    | 'running'
    | 'awaiting_verification'
    | 'passed'
    | 'failed'
    | 'skipped'
    | 'rolled_back';

/**
 * Outcome of a campaign checkpoint evaluation.
 *
 * passed   — all verifications passed, no invariant violations, no scope drift
 * degraded — partial pass or scope drift; execution succeeded but state is uncertain
 * failed   — critical verification failure or invariant violation
 */
export type CampaignCheckpointOutcome = 'passed' | 'degraded' | 'failed';

/**
 * Decision produced by the CampaignReassessmentEngine after a checkpoint.
 *
 * continue      — advance to next step
 * skip_step     — skip the next optional step and continue
 * defer         — suspend campaign; may be resumed later
 * abort         — stop campaign immediately; no rollback triggered
 * rollback      — stop campaign and trigger rollback of prior steps
 * human_review  — route to human; campaign paused until operator action
 */
export type CampaignReassessmentDecision =
    | 'continue'
    | 'skip_step'
    | 'defer'
    | 'abort'
    | 'rollback'
    | 'human_review';

// ─── Bounds ───────────────────────────────────────────────────────────────────

/**
 * Hard limits for a repair campaign.
 * All limits are enforced by CampaignSafetyGuard before each step advance.
 */
export interface CampaignBounds {
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

/**
 * Default campaign bounds — conservative safe defaults.
 */
export const DEFAULT_CAMPAIGN_BOUNDS: CampaignBounds = {
    maxSteps: 8,
    maxReassessments: 4,
    maxAgeMs: 8 * 60 * 60 * 1000,         // 8 hours
    stepTimeoutMs: 20 * 60 * 1000,         // 20 minutes
    cooldownAfterFailureMs: 30 * 60 * 1000, // 30 minutes
};

// ─── Campaign Step ────────────────────────────────────────────────────────────

/**
 * Where a campaign step was sourced from.
 */
export type CampaignStepSource =
    | 'decomposition_step'   // from a DecompositionPlan step (Phase 5.1)
    | 'recovery_pack_action' // from a RecoveryPack action template (Phase 4.3)
    | 'repair_template'      // from a built-in campaign template
    | 'manual';              // operator-created step

/**
 * A single bounded step within a repair campaign.
 *
 * Each step corresponds to exactly one invocation of the
 * planning → governance → execution pipeline.
 *
 * Safety invariants:
 * - Steps execute one at a time; no parallel step execution
 * - A step may not mutate files outside targetScope
 * - Each step requires verification (unless verificationRequired=false)
 * - Steps are immutable once the campaign is created, except for status fields
 */
export interface CampaignStep {
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

// ─── Campaign Checkpoint ──────────────────────────────────────────────────────

/**
 * Verification result from a single check item within a checkpoint.
 */
export interface CampaignCheckpointCheckResult {
    /** Human-readable check name. */
    checkName: string;
    passed: boolean;
    detail?: string;
}

/**
 * Result of running checkpoint evaluation after a campaign step completes.
 * Produced by CampaignCheckpointEngine. Immutable after creation.
 */
export interface CampaignCheckpoint {
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

// ─── Reassessment Record ──────────────────────────────────────────────────────

/**
 * Immutable record of a reassessment decision made after a checkpoint.
 * Produced by CampaignReassessmentEngine.
 */
export interface CampaignReassessmentRecord {
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

// ─── Campaign ─────────────────────────────────────────────────────────────────

/**
 * What originated this campaign.
 */
export type CampaignOrigin =
    | 'decomposition'            // from a DecompositionPlan (Phase 5.1)
    | 'recovery_pack'            // from a RecoveryPack multi-step workflow (Phase 4.3)
    | 'repair_template'          // from a built-in campaign template
    | 'manual';                  // operator-created

/**
 * Canonical definition of a repair campaign.
 *
 * Safety invariants enforced throughout the campaign lifecycle:
 * - steps.length <= bounds.maxSteps
 * - reassessmentCount <= bounds.maxReassessments
 * - campaign must not be older than bounds.maxAgeMs
 * - only one active campaign per subsystem
 * - no recursive campaign spawning
 * - all step executions go through planning → governance → execution
 */
export interface RepairCampaign {
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

// ─── Execution Record ─────────────────────────────────────────────────────────

/**
 * Immutable execution summary for a campaign that reached a terminal state.
 * Written by CampaignOutcomeTracker. Never mutated after creation.
 */
export interface CampaignExecutionRecord {
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

// ─── Outcome Summary ──────────────────────────────────────────────────────────

/**
 * Aggregate summary for display and learning purposes.
 */
export interface CampaignOutcomeSummary {
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

// ─── Dashboard State ──────────────────────────────────────────────────────────

/**
 * KPI metrics for the campaign dashboard.
 */
export interface CampaignDashboardKpis {
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

/**
 * Full campaign dashboard state for the Reflection Dashboard integration.
 * Surfaced as optional campaignState on AutonomyDashboardState.
 */
export interface CampaignDashboardState {
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
