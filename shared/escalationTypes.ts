/**
 * escalationTypes.ts — Phase 5.1 Canonical Escalation & Decomposition Contracts
 *
 * P5.1A: Model Escalation & Bounded Decomposition Types
 *
 * Canonical shared contracts for the Model Escalation & Bounded Decomposition Layer.
 * Shared between Electron main process and renderer.
 *
 * Design principles:
 * - Deterministic-first: all capability assessment and strategy selection is rule-based
 * - Local-first: escalation to remote is always opt-in, governed, and auditable
 * - Bounded: decomposition depth and step count are hard-capped
 * - Non-bypassing: escalation layer never overrides Phase 5 (adaptive) blocks
 * - Explainable: every decision includes reason codes and thresholds used
 *
 * Relationship to prior phases:
 *   Phase 4   (autonomy)         — goal context and recent failure counts are inputs
 *   Phase 4.3 (recovery packs)  — pack exhaustion is an insufficiency signal
 *   Phase 5   (adaptive)        — adaptive gate result is respected; P5.1 adds HOW decision
 *   Phase 3B  (cognitive)       — modelCapabilityTypes.ts profiles inform context limits
 *
 * Decision model:
 *   IF active_model_can_handle → proceed_local
 *   ELSE IF escalation_allowed → escalate_remote (or escalate_human if approval required)
 *   ELSE IF decomposition_possible → decompose_local
 *   ELSE → defer or escalate_human
 */

// ─── Capability insufficiency signals ────────────────────────────────────────

/**
 * Why the active model was assessed as insufficient for this goal.
 */
export type CapabilityInsufficiencyReason =
    | 'context_size_exceeded'     // estimated task context exceeds model limit
    | 'repeated_local_failures'   // ≥N local planning/execution failures for this goal
    | 'high_complexity_task'      // complexity score exceeds configured threshold
    | 'multi_file_repair_scope'   // repair involves multiple files beyond local scope
    | 'recovery_pack_exhausted'   // all matched recovery packs tried and failed
    | 'low_confidence_output';    // prior attempt produced a low-confidence output

// ─── Task capability assessment (P5.1B output) ───────────────────────────────

/**
 * Result of ModelCapabilityEvaluator assessing whether the active model
 * can handle a goal.
 *
 * canHandle=true → proceed normally (no escalation or decomposition needed).
 * canHandle=false → at least one insufficiency reason was detected.
 */
export interface TaskCapabilityAssessment {
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

// ─── Escalation policy (P5.1C input) ─────────────────────────────────────────

/**
 * Escalation policy kinds.
 *
 * local_only                         — never escalate to remote; decompose or defer only
 * local_preferred_with_request       — prefer local; allow requesting remote via governance
 * auto_escalate_for_allowed_classes  — auto-escalate if task class is in allowedTaskClasses
 * remote_allowed                     — remote escalation is allowed when local is insufficient
 * remote_required_for_high_complexity — always escalate goals with high complexity scores
 */
export type EscalationPolicyKind =
    | 'local_only'
    | 'local_preferred_with_request'
    | 'auto_escalate_for_allowed_classes'
    | 'remote_allowed'
    | 'remote_required_for_high_complexity';

/**
 * Configurable escalation and decomposition policy.
 * Governs when and how escalation and decomposition are applied.
 */
export interface EscalationPolicy {
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

/**
 * Default escalation policy.
 * Conservative, local-first, governed defaults for production use.
 */
export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
    policyKind: 'local_preferred_with_request',
    maxEscalationRequestsPerHour: 3,
    minLocalFailuresBeforeEscalation: 2,
    allowedTaskClasses: [],
    maxDecompositionDepth: 2,
    maxStepsPerDecomposition: 5,
    decompositionCooldownMs: 30 * 60 * 1000,
    requireHumanApprovalForRemote: true,
    highComplexityThreshold: 70,
    contextSizeThresholdRatio: 0.85,
    minFailuresForContextTrigger: 1,
};

// ─── Escalation request/decision (P5.1C outputs) ─────────────────────────────

/**
 * A request to escalate goal execution to a remote model.
 * Created by EscalationPolicyEngine when escalation is appropriate.
 */
export interface EscalationRequest {
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

/**
 * Governance decision on an escalation request.
 */
export interface EscalationDecision {
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

// ─── Decomposition types (P5.1D) ─────────────────────────────────────────────

/**
 * How a decomposition step partitions the original task.
 *
 * file_scope         — process a single file at a time
 * change_type        — split by kind of change (add / modify / delete)
 * verification_stage — apply change, then verify before proceeding to next step
 * partial_fix        — apply a partial/incremental fix scoped to a subset
 */
export type DecompositionStepKind =
    | 'file_scope'
    | 'change_type'
    | 'verification_stage'
    | 'partial_fix';

/**
 * A single bounded step within a decomposition plan.
 * Every step must be independently safe, verifiable, and rollbackable.
 */
export interface DecompositionStep {
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

/**
 * A bounded decomposition plan for a goal that the active model cannot handle in full.
 *
 * Safety invariants:
 *   - steps.length <= maxStepsPerDecomposition
 *   - depth <= maxDecompositionDepth
 *   - bounded is always true
 */
export interface DecompositionPlan {
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

// ─── Execution strategy (P5.1E) ──────────────────────────────────────────────

/**
 * Which execution strategy the ExecutionStrategySelector selected.
 *
 * proceed_local   — model can handle it; proceed with standard execution
 * escalate_remote — escalate to a remote model (requires governance)
 * decompose_local — decompose the task and execute the first step locally
 * defer           — re-queue for next cycle (capability gap may self-resolve)
 * escalate_human  — route to human review (no autonomous resolution possible)
 */
export type EscalationStrategyKind =
    | 'proceed_local'
    | 'escalate_remote'
    | 'decompose_local'
    | 'defer'
    | 'escalate_human';

/**
 * Reason codes for escalation/decomposition strategy selection.
 */
export type EscalationReasonCode =
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

/**
 * The strategy decision produced by ExecutionStrategySelector.
 */
export interface ExecutionStrategyDecision {
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

// ─── Decomposition result tracking (P5.1F) ────────────────────────────────────

/** Outcome of a single decomposition step. */
export type DecompositionStepOutcome = 'succeeded' | 'failed' | 'skipped' | 'rolled_back';

/** Recorded result of executing one decomposition step. */
export interface DecompositionStepResult {
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

/** Overall result of executing a decomposition plan. */
export interface DecompositionResult {
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

// ─── Escalation audit (P5.1F) ────────────────────────────────────────────────

/**
 * Event kinds recorded in the escalation audit trail.
 */
export type EscalationAuditEventKind =
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

/**
 * An immutable audit record for a single escalation or decomposition event.
 * Safe for IPC and UI surfaces.
 */
export interface EscalationAuditRecord {
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

// ─── Dashboard state (P5.1G) ─────────────────────────────────────────────────

/**
 * KPI metrics for the escalation/decomposition dashboard.
 */
export interface EscalationKpis {
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

/**
 * Full Phase 5.1 dashboard state.
 * Surfaced as optional escalationState on AutonomyDashboardState.
 */
export interface EscalationDashboardState {
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
