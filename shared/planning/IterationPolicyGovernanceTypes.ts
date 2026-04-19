import type {
    EvidenceSufficiencyStatus,
    IterationPolicyAdjustment,
    IterationTuningRecommendation,
    TuningConfidenceLevel,
} from './IterationEffectivenessTypes';
import type { IterationWorthinessClass } from './IterationPolicyTypes';

export type PolicyDoctrineVersion = `iteration-doctrine-v${number}`;

export type IterationPolicyRecommendationLifecycleState =
    | 'pending_review'
    | 'promoted'
    | 'rejected'
    | 'expired'
    | 'superseded';

export type IterationPolicyOverrideLifecycleState =
    | 'active'
    | 'active_stale'
    | 'stale_requires_revalidation'
    | 'scheduled_for_retirement'
    | 'superseded'
    | 'retired'
    | 'disabled_by_operator'
    | 'blocked_by_doctrine';

export type PromotionDecisionOrigin =
    | 'manual_operator_review'
    | 'approved_auto_promotion'
    | 'maintenance_review_promotion';

export type PromotionEligibilityStatus =
    | 'eligible'
    | 'blocked_insufficient_evidence'
    | 'blocked_low_confidence'
    | 'blocked_stale_evidence'
    | 'blocked_task_family_policy'
    | 'blocked_doctrine_version_mismatch'
    | 'blocked_safety_class';

export type RecommendationExpiryReason =
    | 'stale_evidence_window_elapsed'
    | 'superseded_by_newer_recommendation'
    | 'invalidated_by_new_telemetry'
    | 'doctrine_version_changed';

export type OverrideRetirementReason =
    | 'stale_evidence_retirement'
    | 'superseded_by_new_override'
    | 'rolled_back_to_baseline'
    | 'operator_disabled'
    | 'doctrine_incompatibility'
    | 'revalidation_failed';

export type OverrideStalenessStatus =
    | 'fresh'
    | 'aging'
    | 'stale_requires_revalidation'
    | 'incompatible';

export type EvidenceFreshnessStatus = 'fresh' | 'aging' | 'stale' | 'expired';

export type RevalidationRequirement = 'not_required' | 'required' | 'required_before_use';

export type IterationPolicyGovernanceReasonCode =
    | 'governance.eligible_for_promotion'
    | 'governance.blocked_insufficient_samples'
    | 'governance.blocked_low_confidence'
    | 'governance.blocked_stale_evidence'
    | 'governance.blocked_task_family_restriction'
    | 'governance.blocked_doctrine_version_mismatch'
    | 'governance.blocked_safety_class'
    | 'governance.promotion_recorded'
    | 'governance.recommendation_rejected'
    | 'governance.recommendation_expired'
    | 'governance.recommendation_superseded'
    | 'governance.override_active'
    | 'governance.override_marked_stale'
    | 'governance.override_revalidated'
    | 'governance.override_retired'
    | 'governance.override_superseded'
    | 'governance.override_disabled_by_operator'
    | 'governance.override_blocked_by_doctrine';

export interface IterationGovernedRecommendationRecord {
    recommendation: IterationTuningRecommendation;
    lifecycleState: IterationPolicyRecommendationLifecycleState;
    doctrineVersion: PolicyDoctrineVersion;
    evidenceSnapshotId: string;
    evidenceGeneratedAt: string;
    expiresAt: string;
    freshnessStatus: EvidenceFreshnessStatus;
    confidenceAtDecision?: TuningConfidenceLevel;
    evidenceSufficiencyAtDecision?: EvidenceSufficiencyStatus;
    promotedAt?: string;
    promotedBy?: string;
    rejectedAt?: string;
    rejectedBy?: string;
    rejectionReason?: string;
    expiredAt?: string;
    expiryReason?: RecommendationExpiryReason;
    supersededByRecommendationId?: string;
    reasonCodes: IterationPolicyGovernanceReasonCode[];
}

export interface IterationGovernedOverrideRecord {
    overrideId: string;
    recommendationId?: string;
    taskClass: IterationWorthinessClass;
    adjustment: IterationPolicyAdjustment;
    lifecycleState: IterationPolicyOverrideLifecycleState;
    doctrineVersion: PolicyDoctrineVersion;
    promotedAt: string;
    promotedBy?: string;
    promotionOrigin: PromotionDecisionOrigin;
    evidenceSnapshotId: string;
    evidenceGeneratedAt: string;
    stalenessStatus: OverrideStalenessStatus;
    staleSince?: string;
    expiresAt?: string;
    requiresRevalidation: RevalidationRequirement;
    supersededByOverrideId?: string;
    retiredAt?: string;
    retirementReason?: OverrideRetirementReason;
    disabledAt?: string;
    reasonCodes: IterationPolicyGovernanceReasonCode[];
}

export interface IterationPromotionEligibilityResult {
    recommendationId: string;
    taskClass: IterationWorthinessClass;
    status: PromotionEligibilityStatus;
    evidenceFreshness: EvidenceFreshnessStatus;
    autoPromotionEligible: boolean;
    confidence: TuningConfidenceLevel;
    evidenceSufficiency: EvidenceSufficiencyStatus;
    doctrineVersion: PolicyDoctrineVersion;
    reasonCodes: IterationPolicyGovernanceReasonCode[];
}

export interface IterationPromotionDecision {
    decisionId: string;
    recommendationId: string;
    taskClass: IterationWorthinessClass;
    origin: PromotionDecisionOrigin;
    approved: boolean;
    decidedAt: string;
    decidedBy?: string;
    doctrineVersion: PolicyDoctrineVersion;
    evidenceSnapshotId: string;
    confidenceAtDecision: TuningConfidenceLevel;
    evidenceSufficiencyAtDecision: EvidenceSufficiencyStatus;
    resultingOverride?: IterationPolicyAdjustment;
    reasonCodes: IterationPolicyGovernanceReasonCode[];
}
