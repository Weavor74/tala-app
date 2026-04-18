import type { VerificationDepth } from './PlanningMemoryTypes';

export type IterationWorthinessClass =
    | 'conversational_explanation'
    | 'retrieval_summarize'
    | 'retrieval_summarize_verify'
    | 'notebook_synthesis'
    | 'artifact_assembly'
    | 'tool_multistep'
    | 'workflow_execution'
    | 'recovery_repair'
    | 'autonomous_maintenance'
    | 'operator_sensitive'
    | 'general_goal_execution';

export type LoopPermission = 'allowed' | 'blocked_by_policy' | 'blocked_by_approval';

export type ReplanAllowance = 'none' | 'bounded';

export type ApprovalRequirement =
    | 'not_required'
    | 'required_above_iteration_threshold'
    | 'required_for_all_additional_iterations';

export type IterationContinuationRule =
    | 'never'
    | 'if_incomplete'
    | 'if_recoverable'
    | 'if_verification_gap';

export type IterationAction = 'stop' | 'retry_same_plan' | 'replan_then_continue';

export type IterationDecisionReasonCode =
    | 'iteration_policy.default_single_pass'
    | 'iteration_policy.conversational_non_looping'
    | 'iteration_policy.retrieval_summary'
    | 'iteration_policy.retrieval_summary_verify'
    | 'iteration_policy.notebook_synthesis'
    | 'iteration_policy.artifact_assembly'
    | 'iteration_policy.tool_multistep'
    | 'iteration_policy.workflow_execution'
    | 'iteration_policy.recovery_budget_applied'
    | 'iteration_policy.autonomous_maintenance_bounded'
    | 'iteration_policy.operator_sensitive_capped'
    | 'iteration_policy.high_risk_capped'
    | 'iteration_policy.approval_required_for_additional_iterations'
    | 'iteration_policy.replan_allowed'
    | 'iteration_policy.replan_not_allowed'
    | 'iteration_policy.caller_cap_applied'
    | 'iteration_continue.incomplete_with_budget'
    | 'iteration_continue.recoverable_failure'
    | 'iteration_continue.verification_gap'
    | 'iteration_continue.replan_advised'
    | 'iteration_stop.completed'
    | 'iteration_stop.blocked'
    | 'iteration_stop.failed_nonrecoverable'
    | 'iteration_stop.policy_blocked'
    | 'iteration_stop.approval_required'
    | 'iteration_stop.budget_exhausted'
    | 'iteration_improvement_observed'
    | 'iteration_no_material_improvement';

export interface IterationPolicyProfile {
    taskClass: IterationWorthinessClass;
    maxIterations: number;
    replanAllowance: ReplanAllowance;
    continuationRule: IterationContinuationRule;
    loopPermission: LoopPermission;
    approvalRequirement: ApprovalRequirement;
    approvalRequiredAboveIteration?: number;
    verificationDepth?: VerificationDepth;
    recoveryBudgetApplied?: number;
    reasonCodes: IterationDecisionReasonCode[];
}

export interface IterationBudget {
    maxIterations: number;
    iterationsUsed: number;
    remainingIterations: number;
    replansUsed: number;
    replanAllowance: ReplanAllowance;
    approvalRequirement: ApprovalRequirement;
    approvalRequiredAboveIteration?: number;
    approvalGranted?: boolean;
    reasonCodes: IterationDecisionReasonCode[];
}

export interface IterationContinuationDecision {
    continueLoop: boolean;
    action: IterationAction;
    reasonCodes: IterationDecisionReasonCode[];
    improvementExpected: boolean;
    blockedByApproval: boolean;
    blockedByPolicy: boolean;
    budgetExhausted: boolean;
}

export interface IterationImprovementEvaluation {
    improved: boolean;
    meaningful: boolean;
    reasonCodes: IterationDecisionReasonCode[];
}

export interface IterationPolicyResolution {
    profile: IterationPolicyProfile;
    budget: IterationBudget;
}

