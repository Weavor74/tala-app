/**
 * reflectionPlanTypes.ts — Phase 2 Safe Change Planning Contracts
 *
 * Phase 2: Safe Change Planning with strict rate-limit control
 * and deterministic-first architecture.
 *
 * Design principle: DETERMINISTIC FIRST. MODEL LAST.
 *
 * These types define the full contract surface for:
 * - P2A  Change Proposal Types & Contracts
 * - P2B  Reflection Trigger Intake
 * - P2B.5 Budgeting, Deduplication & Run Control
 * - P2C  Snapshot-Based Planning Engine
 * - P2D  Invariant Impact & Blast Radius Evaluation
 * - P2E  Verification Requirements Engine
 * - P2F  Rollback & Safety Classification
 * - P2G  Proposal Promotion Pipeline
 * - P2H  Reflection Dashboard Integration (Throttled)
 * - P2I  Telemetry, Persistence, and Refresh
 *
 * Shared between the Electron main process and the renderer.
 */

// ─── Planning Modes ───────────────────────────────────────────────────────────

/**
 * Controls how much reasoning the planner performs.
 *
 * light    — deterministic analysis only, no model calls.
 * standard — deterministic + optional single synthesis model call.
 * deep     — limited extended reasoning (explicit override only).
 */
export type PlanningMode = 'light' | 'standard' | 'deep';

// ─── Run Status ───────────────────────────────────────────────────────────────

/**
 * Lifecycle status of a planning run.
 *
 * budget_exhausted — run stopped because a budget limit was reached;
 *                    partial results are persisted.
 * deduped          — run was not started because a matching active/recent
 *                    run already exists; the caller was attached to it.
 * cooldown_blocked — subsystem is within its cooldown window; run rejected.
 */
export type PlanRunStatus =
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'budget_exhausted'
    | 'deduped'
    | 'cooldown_blocked';

// ─── P2B.5 Budget System ──────────────────────────────────────────────────────

/**
 * Hard limits for a single reflection planning run.
 *
 * All fields are per-run limits; the planner stops and marks the run
 * `budget_exhausted` if any limit is exceeded.
 */
export interface PlanRunBudget {
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

/** Tracks actual resource consumption for a running or completed run. */
export interface BudgetUsage {
    modelCallsUsed: number;
    selfModelQueriesUsed: number;
    analysisPassesUsed: number;
    retriesUsed: number;
    dashboardUpdatesUsed: number;
}

/** Result of a budget check before consuming a resource. */
export interface BudgetCheckResult {
    allowed: boolean;
    /** Which limit would be exceeded if the operation proceeds. */
    blockedBy?: keyof BudgetUsage;
    remaining: Partial<Record<keyof BudgetUsage, number>>;
}

// ─── P2B Trigger Intake ───────────────────────────────────────────────────────

/** Raw input that initiates a planning run. */
export interface PlanTriggerInput {
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

// ─── P2B.5 Deduplication & Fingerprinting ────────────────────────────────────

/**
 * A normalised key that uniquely identifies a category of planning work.
 *
 * Two triggers with the same fingerprint refer to the same logical problem
 * and should share a single run rather than spawning duplicates.
 */
export interface TriggerFingerprint {
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

/** Result of a deduplication check. */
export interface DedupCheckResult {
    isDuplicate: boolean;
    /** Run that already covers this fingerprint, if any. */
    existingRunId?: string;
    existingRunStatus?: PlanRunStatus;
}

// ─── P2B.5 Cooldown ───────────────────────────────────────────────────────────

/** Current cooldown state for a subsystem. */
export interface SubsystemCooldownState {
    subsystemId: string;
    /** Unix timestamp (ms) when the cooldown expires. */
    expiresAt: number;
    /** Why the cooldown was imposed. */
    reason: string;
}

// ─── P2C Snapshot ─────────────────────────────────────────────────────────────

/** Ownership record for a single subsystem, captured at run start. */
export interface SubsystemOwnershipRecord {
    subsystemId: string;
    primaryFiles: string[];
    secondaryFiles: string[];
    layer: string;
    owner?: string;
}

/** Lightweight test inventory captured at run start. */
export interface TestInventory {
    totalTests: number;
    testFiles: string[];
    coverageSubsystems: string[];
}

/**
 * Immutable snapshot of self-model data captured once at the start of each run.
 *
 * All pipeline stages MUST read from this snapshot.
 * No service is permitted to re-query the self-model independently during a run.
 */
export interface PlanningRunSnapshot {
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

// ─── P2D Blast Radius ─────────────────────────────────────────────────────────

/**
 * The estimated scope of impact if a proposed change is applied.
 *
 * Computed deterministically from the snapshot; no model calls.
 */
export interface BlastRadiusResult {
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

// ─── P2E Verification Requirements ───────────────────────────────────────────

/**
 * The minimum verification steps required before a proposal can be promoted.
 *
 * Derived deterministically from blast radius and invariants.
 */
export interface VerificationRequirements {
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

// ─── P2F Rollback & Safety Classification ────────────────────────────────────

/**
 * How to undo a promoted change if it causes a regression.
 *
 * file_restore     — restore affected files from pre-change backup.
 * git_revert       — git revert the promotion commit.
 * config_rollback  — restore configuration values to prior state.
 * no_rollback_needed — change is additive-only or fully reversible.
 * manual_only      — human must perform rollback; no automated path.
 */
export type RollbackStrategy =
    | 'file_restore'
    | 'git_revert'
    | 'config_rollback'
    | 'no_rollback_needed'
    | 'manual_only';

/**
 * Safety tier that governs promotion gating.
 *
 * safe_auto        — can be promoted without human approval.
 * safe_with_review — promotion allowed after human review.
 * high_risk        — requires explicit approval + elevated verification.
 * blocked          — change MUST NOT be auto-promoted under any circumstances.
 */
export type SafetyClass = 'safe_auto' | 'safe_with_review' | 'high_risk' | 'blocked';

/** Full rollback and safety profile for a proposal. */
export interface RollbackClassification {
    strategy: RollbackStrategy;
    safetyClass: SafetyClass;
    /** Ordered list of concrete rollback steps. */
    rollbackSteps: string[];
    requiresApproval: boolean;
    estimatedRollbackMs: number;
    /** Reasoning that determined the safety class. */
    classificationReasoning: string;
}

// ─── P2A Change Proposal Contracts ───────────────────────────────────────────

/** A single file-level modification described in a proposal. */
export interface ProposalChange {
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

/**
 * A fully-qualified safe change proposal produced by the Phase 2 planner.
 *
 * The proposal carries all the information needed for promotion, verification,
 * rollback, and dashboard display without requiring any re-analysis.
 */
export interface SafeChangeProposal {
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

// ─── P2G Promotion ────────────────────────────────────────────────────────────

/** Result of promoting a proposal through the pipeline. */
export interface ProposalPromotionResult {
    proposalId: string;
    runId: string;
    promotedAt: string;
    outcome: 'promoted' | 'rejected' | 'deferred' | 'failed';
    reason: string;
    verificationPassed: boolean;
    rollbackPointer?: string;
}

// ─── Plan Run (full lifecycle record) ────────────────────────────────────────

/** A single planning run milestone event. */
export interface PlanRunMilestone {
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

/**
 * The authoritative record of one safe-change planning run.
 *
 * Persisted to disk at each milestone so that partial results survive crashes.
 */
export interface PlanRun {
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

// ─── P2H Dashboard Integration ────────────────────────────────────────────────

/**
 * Dashboard KPI tile data for the planning subsystem.
 * Emitted only at milestone boundaries — never on internal steps.
 */
export interface PlanningDashboardKpis {
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

/** Live execution state of the planning pipeline for dashboard display. */
export interface PlanningPipelineState {
    isActive: boolean;
    currentRunId?: string;
    currentStage?: PlanPipelineStage;
    currentSubsystem?: string;
    startedAt?: string;
    elapsedMs?: number;
    lastMilestone?: string;
    lastMilestoneAt?: string;
    pendingProposals: number;
    recentRuns: Array<{ runId: string; status: PlanRunStatus; subsystemId: string; completedAt?: string }>;
}

/**
 * Full dashboard state emitted to the renderer at each milestone.
 */
export interface PlanningDashboardState {
    kpis: PlanningDashboardKpis;
    pipeline: PlanningPipelineState;
    recentProposals: SafeChangeProposal[];
    lastUpdatedAt: string;
}

// ─── P2I Telemetry ────────────────────────────────────────────────────────────

/**
 * A single telemetry event emitted by the planning pipeline.
 * Events are batched and flushed periodically — not sent immediately.
 */
export interface PlanningTelemetryEvent {
    eventId: string;
    runId: string;
    timestamp: string;
    stage: PlanPipelineStage | 'system';
    category: 'budget' | 'dedup' | 'snapshot' | 'blast_radius' | 'verification' | 'rollback' | 'proposal' | 'promotion' | 'dashboard' | 'error';
    message: string;
    data?: Record<string, unknown>;
}

// ─── Pipeline Stage Enum ──────────────────────────────────────────────────────

/**
 * Strict linear stage identifiers for the planning pipeline.
 *
 * Pipeline order: intake → dedup → snapshot → blast_radius →
 *                 verification → rollback → proposal → done
 *
 * No stage may loop back to a prior stage.
 */
export type PlanPipelineStage =
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

// ─── IPC contract types ───────────────────────────────────────────────────────

/** Payload for `planning:triggerRun` IPC call. */
export interface PlanningTriggerRequest {
    trigger: PlanTriggerInput;
}

/** Response from `planning:triggerRun`. */
export interface PlanningTriggerResponse {
    runId: string;
    status: PlanRunStatus;
    message: string;
    /** If deduplicated, the ID of the existing run being reused. */
    attachedToRunId?: string;
}

/** Payload for `planning:getRunStatus`. */
export interface PlanningRunStatusResponse {
    run: PlanRun | null;
    found: boolean;
}

/** Payload for `planning:listProposals`. */
export interface PlanningListProposalsResponse {
    proposals: SafeChangeProposal[];
    total: number;
}
