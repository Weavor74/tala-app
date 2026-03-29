/**
 * governanceTypes.ts — Phase 3.5 Canonical Governance Contracts
 *
 * P3.5A: Governance Types & Contracts
 *
 * Canonical shared contracts for the Human-in-the-Loop Governance Layer.
 * Shared between Electron main process and renderer.
 *
 * Design principles:
 * - Deterministic policy evaluation: same input → same result
 * - No hidden approval bypass paths
 * - All decisions are auditable and locally persisted
 * - Execution may not proceed without satisfying governance requirements
 * - Tala may only self-authorize when policy explicitly permits it
 *
 * Authority tier hierarchy (most restrictive → least restrictive):
 *   blocked > emergency_manual_only > human_dual_approval > human_review_required
 *     > protected_subsystem > tala_self_standard > tala_self_low_risk
 */

import type { SafetyClass, RollbackStrategy } from './reflectionPlanTypes';
import type { PatchUnitChangeType } from './executionTypes';

// ─── Authority Tier ───────────────────────────────────────────────────────────

/**
 * Explicit authority tier required to authorize execution of a proposal.
 *
 * Ordered from least restrictive to most restrictive:
 *   tala_self_low_risk        — Tala may self-authorize; minimal risk, policy allowlisted
 *   tala_self_standard        — Tala may self-authorize; standard risk, policy allowlisted
 *   protected_subsystem       — Human review required; proposal touches protected subsystem
 *   human_review_required     — One human approval required
 *   human_dual_approval       — Two distinct human approvals required
 *   emergency_manual_only     — Manual-only override path; no automated execution
 *   blocked                   — No execution permitted regardless of approvals
 */
export type AuthorityTier =
    | 'tala_self_low_risk'
    | 'tala_self_standard'
    | 'protected_subsystem'
    | 'human_review_required'
    | 'human_dual_approval'
    | 'emergency_manual_only'
    | 'blocked';

// ─── Governance Decision Status ───────────────────────────────────────────────

/**
 * Lifecycle status of a single governance decision.
 *
 * pending         — awaiting required approvals or confirmations
 * approved        — all required approvals satisfied; execution may proceed
 * self_authorized — Tala self-authorized per explicit policy; execution may proceed
 * rejected        — at least one rejection recorded; execution permanently blocked for this proposal
 * deferred        — postponed; may be re-evaluated after replan
 * escalated       — escalated to higher authority tier
 * blocked         — policy hard-blocks; no approval path exists for this proposal
 * expired         — approval window elapsed without resolution; replan required
 */
export type GovernanceDecisionStatus =
    | 'pending'
    | 'approved'
    | 'self_authorized'
    | 'rejected'
    | 'deferred'
    | 'escalated'
    | 'blocked'
    | 'expired';

// ─── Governance Block Reason ──────────────────────────────────────────────────

/** Machine-readable reason why a governance decision is blocking execution. */
export type GovernanceBlockReason =
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
    | 'self_authorization_disabled'; // policy disables self-authorization globally

// ─── Approval Actor ───────────────────────────────────────────────────────────

export type ApprovalActorKind =
    | 'human_user'      // human operator approved via UI
    | 'tala_policy'     // Tala self-authorized per explicit policy rule
    | 'system_override'; // emergency override with full audit trail

export interface ApprovalActor {
    /** Stable actor identifier. 'local_user' for human; ruleId for policy; 'override' for system. */
    actorId: string;
    kind: ApprovalActorKind;
    label: string;
    timestamp: string;
}

// ─── Governance Proposal Snapshot ────────────────────────────────────────────

/**
 * Lightweight snapshot of proposal metadata captured at decision evaluation time.
 * Ensures audit records are self-contained and not dependent on live proposal state.
 */
export interface GovernanceProposalSnapshot {
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

// ─── Approval Record ──────────────────────────────────────────────────────────

export interface ApprovalRecord {
    approvalId: string;
    proposalId: string;
    decisionId: string;
    actor: ApprovalActor;
    outcome: 'approved' | 'rejected' | 'deferred' | 'escalated';
    reason?: string;
    timestamp: string;
    proposalSnapshot: GovernanceProposalSnapshot;
}

// ─── Confirmation Requirement ─────────────────────────────────────────────────

export type ConfirmationKind =
    | 'pre_execution_manual'   // explicit manual review before execution
    | 'protected_file_ack'     // acknowledge target files are protected
    | 'dual_approval_ack'      // acknowledge dual approval requirement
    | 'escalation_ack';        // acknowledge an outstanding escalation

export interface ConfirmationRequirement {
    confirmationId: string;
    proposalId: string;
    kind: ConfirmationKind;
    promptText: string;
    required: boolean;
    satisfied: boolean;
    satisfiedAt?: string;
    satisfiedByActor?: ApprovalActor;
}

// ─── Escalation Requirement ───────────────────────────────────────────────────

export type EscalationTrigger =
    | 'verification_failure'  // escalation triggered after verification failure
    | 'critical_subsystem'    // target is a critical/protected subsystem
    | 'protected_file'        // one or more protected files targeted
    | 'policy_escalation'     // policy rule explicitly requires escalation
    | 'override_attempted';   // manual override attempted on a blocked decision

export interface EscalationRequirement {
    escalationId: string;
    proposalId: string;
    trigger: EscalationTrigger;
    requiredTierAfterEscalation: AuthorityTier;
    resolved: boolean;
    resolvedAt?: string;
    resolvedByActor?: ApprovalActor;
    notes?: string;
}

// ─── Governance Rule Condition ────────────────────────────────────────────────

export type GovernanceRuleConditionField =
    | 'safetyClass'            // SafetyClass value
    | 'riskScore'              // proposal riskScore (0-100)
    | 'targetSubsystem'        // subsystem string match
    | 'isProtectedSubsystem'   // boolean
    | 'hasProtectedFile'       // boolean (any target file is protected)
    | 'fileCount'              // number of target files
    | 'mutationType'           // PatchUnitChangeType value
    | 'rollbackStrategy'       // RollbackStrategy value
    | 'verificationManualRequired' // boolean
    | 'hasInvariantSensitivity'; // boolean

export interface GovernanceRuleCondition {
    field: GovernanceRuleConditionField;
    operator: 'eq' | 'neq' | 'gte' | 'lte' | 'gt' | 'lt' | 'in' | 'contains';
    value: string | number | boolean | string[];
}

// ─── Governance Rule ──────────────────────────────────────────────────────────

/**
 * A single deterministic governance rule.
 *
 * All conditions within a rule are AND-ed.
 * Multiple matching rules produce the most-restrictive authority tier.
 */
export interface GovernanceRule {
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

// ─── Governance Policy ────────────────────────────────────────────────────────

/**
 * Named, versioned collection of governance rules.
 *
 * Rules are evaluated in order; all matching rules contribute.
 * Most-restrictive tier across all matching rules is the resolved tier.
 * When no rule matches, `defaultTier` applies.
 */
export interface GovernancePolicy {
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

// ─── Governance Evaluation Input ─────────────────────────────────────────────

/**
 * Input to the policy engine evaluation function.
 * Built deterministically from a SafeChangeProposal + context.
 */
export interface GovernancePolicyInput {
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

// ─── Governance Evaluation Result ────────────────────────────────────────────

/**
 * Output of a single policy engine evaluation pass.
 * Deterministic: same input always yields the same result.
 */
export interface GovernanceEvaluationResult {
    evaluatedAt: string;
    proposalId: string;
    policyId: string;
    policyVersion: string;
    resolvedTier: AuthorityTier;
    matchedRules: Array<{ ruleId: string; label: string; rationale: string }>;
    requiresManualConfirmation: boolean;
    escalateOnVerificationFailure: boolean;
    selfAuthorizationPermitted: boolean;
    blockedByPolicy: boolean;
    blockReason?: GovernanceBlockReason;
    approvalsRequired: number;
    contributingConditions: string[];
}

// ─── Governance Decision ──────────────────────────────────────────────────────

/**
 * The authoritative governance decision record for a single proposal.
 * Persisted as <dataDir>/governance/decisions/<proposalId>.json.
 *
 * Immutable fields: decisionId, proposalId, createdAt.
 * Mutable fields: status, approvals, confirmations, escalations, updatedAt.
 */
export interface GovernanceDecision {
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

// ─── Execution Authorization Decision ────────────────────────────────────────

/**
 * The final go/no-go record from ExecutionAuthorizationGate.canExecute().
 * This record is what ExecutionEligibilityGate checks (check 10).
 */
export interface ExecutionAuthorizationDecision {
    authorized: boolean;
    proposalId: string;
    decisionId?: string;
    tier?: AuthorityTier;
    authorizedBy?: ApprovalActor;
    blockReason?: GovernanceBlockReason;
    reason: string;
    evaluatedAt: string;
}

// ─── Governance Audit Record ──────────────────────────────────────────────────

export type GovernanceAuditEventType =
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

export interface GovernanceAuditRecord {
    auditId: string;
    proposalId: string;
    decisionId: string;
    timestamp: string;
    event: GovernanceAuditEventType;
    actor: ApprovalActor | null;
    detail: string;
    data?: Record<string, unknown>;
}

// ─── Approval Queue Item ──────────────────────────────────────────────────────

/**
 * A pending governance decision surfaced to the UI approval queue.
 */
export interface ApprovalQueueItem {
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

// ─── Governance Dashboard State ───────────────────────────────────────────────

export interface GovernanceDashboardKpis {
    totalDecisions: number;
    selfAuthorized: number;
    humanApproved: number;
    rejected: number;
    pending: number;
    blocked: number;
    escalated: number;
    expired: number;
}

export interface GovernanceDashboardState {
    kpis: GovernanceDashboardKpis;
    pendingQueue: ApprovalQueueItem[];
    recentDecisions: GovernanceDecision[];
    activePolicyId: string;
    activePolicyLabel: string;
    selfAuthorizationEnabled: boolean;
    lastUpdatedAt: string;
}

// ─── IPC Contract Types ───────────────────────────────────────────────────────

export interface GovernanceApproveRequest {
    proposalId: string;
    reason?: string;
}

export interface GovernanceRejectRequest {
    proposalId: string;
    reason: string;
}

export interface GovernanceDeferRequest {
    proposalId: string;
    reason?: string;
}

export interface GovernanceSatisfyConfirmationRequest {
    proposalId: string;
    confirmationId: string;
}

export interface GovernanceEvaluateRequest {
    proposalId: string;
}

export interface GovernanceApproveResponse {
    success: boolean;
    decision: GovernanceDecision | null;
    record: ApprovalRecord | null;
    error?: string;
}
