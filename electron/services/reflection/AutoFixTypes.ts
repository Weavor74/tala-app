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
    | 'merged_into_existing'
    | 'superseded'
    | 'skipped_duplicate'
    | 'skipped_cooldown'
    | 'skipped_target_locked'
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

export type AutoFixSkipReason =
    | 'none'
    | 'deduplicated_existing'
    | 'cooldown_active'
    | 'target_locked'
    | 'conflicting_execution'
    | 'material_change_bypass';

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
    dedupeKey?: string;
    firstSeenAt?: string;
    lastSeenAt?: string;
    duplicateCount?: number;
    observationCount?: number;
    cooldownUntil?: string;
    targetLockKey?: string;
    mergedIntoProposalId?: string;
    supersededByProposalId?: string;
    sourceSeverity?: 'low' | 'medium' | 'high' | 'critical' | string;
    lastMaterialChangeReason?: string;
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
    dedupeKey?: string;
    cooldownUntil?: string;
    targetLockKey?: string;
    skipReason?: AutoFixSkipReason;
    lockHolderProposalId?: string;
}

export interface AutoFixCooldownPolicy {
    proposedMinutes: number;
    appliedSuccessMinutes: number;
    failedMinutes: number;
    blockedMinutes: number;
    approvalRequiredMinutes: number;
    rolledBackMinutes: number;
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
    cooldowns: AutoFixCooldownPolicy;
    materialChangeConfidenceDelta: number;
}
