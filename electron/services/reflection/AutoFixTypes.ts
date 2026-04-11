export type AutoFixProposalCategory =
    | 'policy'
    | 'config'
    | 'runtime_state'
    | 'storage_maintenance'
    | 'provider_suppression'
    | 'code_patch_plan';

export type AutoFixActionType =
    | 'update_policy_value'
    | 'update_config_value'
    | 'rotate_log'
    | 'prune_logs'
    | 'suppress_provider'
    | 'clear_runtime_cache'
    | 'emit_patch_plan';

export type AutoFixRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type AutoFixProposalStatus =
    | 'proposed'
    | 'gated_blocked'
    | 'gated_requires_approval'
    | 'executing'
    | 'verification_passed'
    | 'verification_failed'
    | 'rolled_back'
    | 'completed'
    | 'failed';

export type AutoFixGateDecision =
    | 'auto_apply_allowed'
    | 'approval_required'
    | 'blocked_unsafe'
    | 'blocked_low_confidence'
    | 'blocked_out_of_scope'
    | 'blocked_external_path'
    | 'blocked_missing_rollback'
    | 'blocked_missing_verification';

export type AutoFixVerificationResult = 'passed' | 'failed' | 'partial' | 'skipped_with_reason';

export interface AutoFixProposal {
    proposalId: string;
    sourceRunId: string;
    category: AutoFixProposalCategory;
    issueType: string;
    targetType: 'path' | 'config_key' | 'provider' | 'runtime_state' | 'artifact';
    targetPath?: string;
    targetKey?: string;
    actionType: AutoFixActionType;
    description: string;
    rationale: string;
    evidenceSummary: string;
    riskLevel: AutoFixRiskLevel;
    confidence: number;
    autoApplicable: boolean;
    requiresApproval: boolean;
    rollbackPlan: string;
    verificationPlan: string;
    status: AutoFixProposalStatus;
    createdAt: string;
    updatedAt: string;
    proposedValue?: unknown;
}

export interface AutoFixExecutionStep {
    stepId: string;
    action: string;
    target: string;
    beforeValue?: unknown;
    afterValue?: unknown;
}

export interface AutoFixExecutionPlan {
    proposalId: string;
    dryRun: boolean;
    steps: AutoFixExecutionStep[];
    rollbackSteps: string[];
    verificationSteps: string[];
}

export interface AutoFixGateResult {
    proposalId: string;
    decision: AutoFixGateDecision;
    reason: string;
}

export interface AutoFixOutcome {
    outcomeId: string;
    proposalId: string;
    status: AutoFixProposalStatus;
    gateDecision: AutoFixGateDecision;
    verificationResult: AutoFixVerificationResult;
    rolledBack: boolean;
    details: string;
    createdAt: string;
    updatedAt: string;
}

export interface AutoFixPolicy {
    maxRiskAllowedForAutoApply: AutoFixRiskLevel;
    minConfidence: number;
    allowedCategories: AutoFixProposalCategory[];
    allowedActions: AutoFixActionType[];
    requireAppRootContainment: boolean;
    requireRollback: boolean;
    irreversibleAllowedActions: AutoFixActionType[];
    allowlistedConfigKeys: string[];
}
