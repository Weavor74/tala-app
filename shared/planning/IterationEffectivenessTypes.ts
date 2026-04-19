import type { ReplanAllowance, IterationWorthinessClass } from './IterationPolicyTypes';
import type {
    IterationGovernedOverrideRecord,
    IterationGovernedRecommendationRecord,
    IterationPolicyGovernanceReasonCode,
    IterationPromotionDecision,
    IterationPolicyOverrideLifecycleState,
    PolicyDoctrineVersion,
} from './IterationPolicyGovernanceTypes';

export type TuningConfidenceLevel = 'low' | 'medium' | 'high';

export type EvidenceSufficiencyStatus =
    | 'insufficient_samples'
    | 'insufficient_effect_size'
    | 'mixed_signals'
    | 'sufficient';

export type IterationTuningReasonCode =
    | 'tuning.insufficient_samples'
    | 'tuning.insufficient_effect_size'
    | 'tuning.mixed_signals'
    | 'tuning.operator_sensitive_no_auto_expand'
    | 'tuning.conversational_non_looping_preserved'
    | 'tuning.recommend_raise_iterations'
    | 'tuning.recommend_lower_iterations'
    | 'tuning.recommend_keep_iterations'
    | 'tuning.recommend_disable_replan'
    | 'tuning.recommend_enable_replan'
    | 'tuning.recommend_keep_replan'
    | 'tuning.strong_second_pass_uplift'
    | 'tuning.high_third_pass_waste'
    | 'tuning.replan_helpful'
    | 'tuning.replan_harmful'
    | 'tuning.policy_source_baseline'
    | 'tuning.policy_source_override'
    | 'tuning.policy_source_capped_by_safety'
    | 'tuning.override_not_applied_recovery_precedence'
    | 'tuning.override_promoted_manual'
    | 'tuning.override_promoted_auto_approved'
    | 'tuning.override_rejected';

export interface IterationDepthSuccessProfile {
    depth: number;
    loopsReachedDepth: number;
    successfulByDepth: number;
    successRate: number;
    marginalGainFromPriorDepth: number;
    wastedRateAtDepth: number;
}

export interface ReplanEffectivenessProfile {
    replanAttempts: number;
    improvedAfterReplan: number;
    worsenedAfterReplan: number;
    unchangedAfterReplan: number;
    improvementRate: number;
    worsenedRate: number;
}

export interface RetryEffectivenessProfile {
    retryAttempts: number;
    improvedAfterRetry: number;
    worsenedAfterRetry: number;
    unchangedAfterRetry: number;
    improvementRate: number;
    worsenedRate: number;
}

export interface IterationWasteProfile {
    nonImprovingIterations: number;
    totalFollowupIterations: number;
    wastedIterationRate: number;
    budgetExhaustionCount: number;
    budgetExhaustionRate: number;
}

export interface IterationTaskFamilyStats {
    taskClass: IterationWorthinessClass;
    sampleCount: number;
    completedCount: number;
    failedCount: number;
    blockedCount: number;
    partialCount: number;
    approvalBlockedCount: number;
    earlyStopCorrectCount: number;
    averageIterationsUsed: number;
    depthProfiles: IterationDepthSuccessProfile[];
    replan: ReplanEffectivenessProfile;
    retry: RetryEffectivenessProfile;
    waste: IterationWasteProfile;
}

export interface IterationDoctrineAnalytics {
    taskClass: IterationWorthinessClass;
    evidenceSufficiency: EvidenceSufficiencyStatus;
    confidence: TuningConfidenceLevel;
    stats: IterationTaskFamilyStats;
    reasonCodes: IterationTuningReasonCode[];
}

export interface IterationEffectivenessSnapshot {
    generatedAt: string;
    totalLoopsObserved: number;
    taskFamilyStats: IterationTaskFamilyStats[];
}

export interface IterationPolicyAdjustment {
    taskClass: IterationWorthinessClass;
    maxIterations?: number;
    replanAllowance?: ReplanAllowance;
    promotedAt: string;
    promotedBy?: string;
    origin: 'manual' | 'approved_auto' | 'maintenance_review';
    reasonCodes: IterationTuningReasonCode[];
}

export interface IterationTuningRecommendation {
    recommendationId: string;
    createdAt: string;
    taskClass: IterationWorthinessClass;
    currentMaxIterations: number;
    recommendedMaxIterations: number;
    currentReplanAllowance: ReplanAllowance;
    recommendedReplanAllowance: ReplanAllowance;
    confidence: TuningConfidenceLevel;
    evidenceSufficiency: EvidenceSufficiencyStatus;
    reasonCodes: IterationTuningReasonCode[];
    sampleCount: number;
    secondPassUplift: number;
    thirdPassUplift: number;
    thirdPassWasteRate: number;
    replanImprovementRate: number;
    replanWorsenedRate: number;
    status: 'pending' | 'promoted' | 'rejected';
}

export interface IterationPolicyPromotionRecord {
    recommendationId: string;
    taskClass: IterationWorthinessClass;
    promotedAt: string;
    promotedBy?: string;
    origin: 'manual' | 'approved_auto' | 'maintenance_review';
    appliedAdjustment: IterationPolicyAdjustment;
}

export interface IterationPolicyRejectionRecord {
    recommendationId: string;
    taskClass: IterationWorthinessClass;
    rejectedAt: string;
    rejectedBy?: string;
    rejectionReason: string;
}

export interface IterationPolicyTuningState {
    doctrineVersion: PolicyDoctrineVersion;
    appliedOverrides: Partial<Record<IterationWorthinessClass, IterationPolicyAdjustment>>;
    pendingRecommendations: IterationGovernedRecommendationRecord[];
    promotedRecommendations: IterationPolicyPromotionRecord[];
    rejectedRecommendations: IterationPolicyRejectionRecord[];
    expiredRecommendations: IterationGovernedRecommendationRecord[];
    supersededRecommendations: IterationGovernedRecommendationRecord[];
    activeOverrides: IterationGovernedOverrideRecord[];
    staleOverrides: IterationGovernedOverrideRecord[];
    retiredOverrides: IterationGovernedOverrideRecord[];
    supersededOverrides: IterationGovernedOverrideRecord[];
    promotionDecisions: IterationPromotionDecision[];
    overrideSupersessionRecords: Array<{
        priorOverrideId: string;
        supersededByOverrideId: string;
        supersededAt: string;
        taskClass: IterationWorthinessClass;
        reasonCodes: IterationPolicyGovernanceReasonCode[];
    }>;
    lastAnalyticsSnapshot?: IterationEffectivenessSnapshot;
    lastRecommendationRunAt?: string;
}

export interface IterationPolicyTuningDiagnosticsSnapshot {
    tuningOverridesActive: boolean;
    appliedOverrideCount: number;
    recommendationCount: number;
    pendingRecommendationCount: number;
    promotedRecommendationCount: number;
    rejectedRecommendationCount: number;
    expiredRecommendationCount: number;
    supersededRecommendationCount: number;
    staleActiveOverrideCount: number;
    retiredOverrideCount: number;
    supersededOverrideCount: number;
    staleRequiresRevalidationCount: number;
    autoPromotionEligibleCount: number;
    autoPromotionIneligibleCount: number;
    doctrineIncompatibilityWarningCount: number;
    topPendingRecommendations: Array<{
        recommendationId: string;
        taskClass: IterationWorthinessClass;
        confidence: TuningConfidenceLevel;
        evidenceSufficiency: EvidenceSufficiencyStatus;
        expiresAt: string;
    }>;
    activePolicySourceByTaskFamily: Array<{
        taskClass: IterationWorthinessClass;
        source: 'baseline' | 'promoted_override' | 'stale_active_override';
        overrideLifecycleState?: IterationPolicyOverrideLifecycleState;
    }>;
    topHelpfulTaskFamilies: Array<{
        taskClass: IterationWorthinessClass;
        secondPassUplift: number;
        replanImprovementRate: number;
    }>;
    topWastefulTaskFamilies: Array<{
        taskClass: IterationWorthinessClass;
        thirdPassWasteRate: number;
        wastedIterationRate: number;
    }>;
    evidenceSufficiencyByTaskFamily: Array<{
        taskClass: IterationWorthinessClass;
        status: EvidenceSufficiencyStatus;
        confidence: TuningConfidenceLevel;
    }>;
    policySourceByTaskFamily: Array<{
        taskClass: IterationWorthinessClass;
        source: 'baseline' | 'override';
    }>;
    lastUpdated: string;
}
