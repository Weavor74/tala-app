import type {
    IterationPolicyGovernanceReasonCode,
    IterationPolicyOverrideLifecycleState,
    IterationPolicyRecommendationLifecycleState,
    PromotionDecisionOrigin,
} from './IterationPolicyGovernanceTypes';
import type { IterationWorthinessClass } from './IterationPolicyTypes';

export type GovernanceActionOrigin =
    | 'operator'
    | 'maintenance'
    | 'auto_policy_governance';

export type IterationGovernanceActionType =
    | 'promote_recommendation'
    | 'reject_recommendation'
    | 'expire_recommendation'
    | 'revalidate_override'
    | 'retire_override'
    | 'disable_override'
    | 'reenable_override'
    | 'supersede_override'
    | 'acknowledge_incompatibility'
    | 'run_governance_sweep';

export type IterationGovernanceActionStatus =
    | 'completed'
    | 'blocked'
    | 'not_found'
    | 'invalid_transition'
    | 'failed';

export type IterationGovernanceQueueType =
    | 'pending_review'
    | 'eligible_for_promotion'
    | 'blocked_recommendations'
    | 'stale_overrides'
    | 'incompatible_overrides'
    | 'active_overrides'
    | 'history';

export type IterationGovernanceSweepType =
    | 'review_pending_recommendations'
    | 'expire_stale_recommendations'
    | 'revalidate_active_overrides'
    | 'retire_invalid_or_stale_overrides'
    | 'detect_doctrine_incompatibilities'
    | 'build_governance_summary'
    | 'full_maintenance';

export type GovernanceActionReasonCode =
    | 'governance_action.promoted'
    | 'governance_action.rejected'
    | 'governance_action.expired'
    | 'governance_action.revalidated'
    | 'governance_action.retired'
    | 'governance_action.disabled'
    | 'governance_action.reenabled'
    | 'governance_action.superseded'
    | 'governance_action.acknowledged'
    | 'governance_action.blocked_not_eligible'
    | 'governance_action.blocked_not_found'
    | 'governance_action.blocked_invalid_transition'
    | 'governance_action.blocked_doctrine_incompatible'
    | 'governance_action.sweep_completed'
    | 'governance_action.sweep_partial';

export interface IterationGovernanceActionRequest {
    actionType: IterationGovernanceActionType;
    targetArtifactId?: string;
    targetArtifactType?: 'recommendation' | 'override' | 'system';
    origin: GovernanceActionOrigin;
    actorId?: string;
    note?: string;
    nowIso?: string;
    metadata?: Record<string, unknown>;
}

export interface IterationGovernanceActionResult {
    actionId: string;
    actionType: IterationGovernanceActionType;
    status: IterationGovernanceActionStatus;
    origin: GovernanceActionOrigin;
    actorId?: string;
    targetArtifactId?: string;
    targetArtifactType?: 'recommendation' | 'override' | 'system';
    priorRecommendationState?: IterationPolicyRecommendationLifecycleState;
    resultingRecommendationState?: IterationPolicyRecommendationLifecycleState;
    priorOverrideState?: IterationPolicyOverrideLifecycleState;
    resultingOverrideState?: IterationPolicyOverrideLifecycleState;
    createdOverrideId?: string;
    blockedReasonCodes: (IterationPolicyGovernanceReasonCode | GovernanceActionReasonCode)[];
    reasonCodes: (IterationPolicyGovernanceReasonCode | GovernanceActionReasonCode)[];
    completedAt: string;
}

export interface IterationGovernanceQueueItem {
    queueType: IterationGovernanceQueueType;
    artifactId: string;
    artifactType: 'recommendation' | 'override';
    taskClass: IterationWorthinessClass;
    lifecycleState: string;
    reasonCodes: string[];
    confidence?: 'low' | 'medium' | 'high';
    evidenceSufficiency?: 'insufficient_samples' | 'insufficient_effect_size' | 'mixed_signals' | 'sufficient';
    createdAt: string;
    updatedAt: string;
    expiresAt?: string;
    note?: string;
}

export interface IterationGovernanceReviewSummary {
    pendingRecommendationCount: number;
    eligibleRecommendationCount: number;
    blockedRecommendationCount: number;
    staleOverrideCount: number;
    incompatibleOverrideCount: number;
    activeOverrideCount: number;
    recentActionCount: number;
}

export interface IterationGovernanceHistoryEntry {
    historyId: string;
    actionId: string;
    actionType: IterationGovernanceActionType;
    actionStatus: IterationGovernanceActionStatus;
    origin: GovernanceActionOrigin;
    actorId?: string;
    targetArtifactId?: string;
    targetArtifactType?: 'recommendation' | 'override' | 'system';
    priorLifecycleState?: string;
    resultingLifecycleState?: string;
    recommendationId?: string;
    overrideId?: string;
    promotionOrigin?: PromotionDecisionOrigin;
    note?: string;
    reasonCodes: string[];
    blockedReasonCodes: string[];
    timestamp: string;
}

export interface IterationGovernanceSweepResult {
    sweepType: IterationGovernanceSweepType;
    startedAt: string;
    completedAt: string;
    status: 'completed' | 'partial' | 'failed';
    expiredRecommendationCount: number;
    promotedRecommendationCount: number;
    rejectedRecommendationCount: number;
    staleOverrideCount: number;
    retiredOverrideCount: number;
    incompatibleOverrideCount: number;
    actionIds: string[];
    reasonCodes: (IterationPolicyGovernanceReasonCode | GovernanceActionReasonCode)[];
}

export interface IterationGovernanceMaintenanceReport {
    reportId: string;
    generatedAt: string;
    sweepResults: IterationGovernanceSweepResult[];
    summary: IterationGovernanceReviewSummary;
    recommendationQueueCounts: Record<'pending' | 'eligible' | 'blocked' | 'expired', number>;
    overrideQueueCounts: Record<'active' | 'stale' | 'incompatible' | 'retired', number>;
    unresolvedIncompatibleOverrideIds: string[];
}
