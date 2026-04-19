import type {
    IterationGovernanceActionType,
    IterationGovernanceQueueType,
} from './IterationPolicyGovernanceOperationsTypes';
import type {
    EvidenceFreshnessStatus,
    IterationPolicyOverrideLifecycleState,
    IterationPolicyRecommendationLifecycleState,
} from './IterationPolicyGovernanceTypes';
import type { IterationWorthinessClass, ReplanAllowance } from './IterationPolicyTypes';

export type IterationGovernancePriorityClass = 'critical' | 'high' | 'medium' | 'low';

export interface IterationGovernanceTriageFactors {
    queueAgeDays: number;
    confidence?: 'low' | 'medium' | 'high';
    evidenceSufficiency?: 'insufficient_samples' | 'insufficient_effect_size' | 'mixed_signals' | 'sufficient';
    freshnessStatus?: EvidenceFreshnessStatus;
    doctrineRiskClass: 'low' | 'medium' | 'high';
    runtimeImpact: 'none' | 'potential' | 'active';
    contradictionDetected: boolean;
    staleActiveRisk: boolean;
}

export interface IterationGovernancePriorityScore {
    artifactId: string;
    artifactType: 'recommendation' | 'override';
    queueType: IterationGovernanceQueueType;
    taskClass: IterationWorthinessClass;
    priorityClass: IterationGovernancePriorityClass;
    score: number;
    factors: IterationGovernanceTriageFactors;
    reasonCodes: string[];
}

export type IterationGovernanceSuggestedAction =
    | 'promote_candidate'
    | 'manual_review_required'
    | 'reject_candidate'
    | 'schedule_revalidation'
    | 'retire_or_revalidate'
    | 'disable_override'
    | 'acknowledge_incompatibility'
    | 'no_action_required';

export interface IterationGovernanceExplanation {
    artifactId: string;
    artifactType: 'recommendation' | 'override';
    lifecycleState: IterationPolicyRecommendationLifecycleState | IterationPolicyOverrideLifecycleState | string;
    summary: string;
    reasonCodes: string[];
    factors: string[];
}

export type IterationGovernanceImpactSeverity = 'none' | 'low' | 'medium' | 'high';

export type IterationGovernancePreviewScope = 'single_task_family' | 'multi_task_family' | 'global_policy_surface';

export interface IterationGovernanceSimulationResult {
    taskClass: IterationWorthinessClass;
    currentPolicySource: 'baseline' | 'promoted_override' | 'stale_active_override';
    projectedPolicySource: 'baseline' | 'promoted_override' | 'stale_active_override';
    currentMaxIterations: number;
    projectedMaxIterations: number;
    currentReplanAllowance: ReplanAllowance;
    projectedReplanAllowance: ReplanAllowance;
    changed: boolean;
    safetyCapApplied: boolean;
}

export interface IterationGovernanceImpactPreview {
    previewId: string;
    advisoryOnly: true;
    actionType: IterationGovernanceActionType;
    targetArtifactId: string;
    targetArtifactType: 'recommendation' | 'override';
    scope: IterationGovernancePreviewScope;
    severity: IterationGovernanceImpactSeverity;
    affectedTaskFamilies: IterationWorthinessClass[];
    baselineFallbackCount: number;
    simulationResults: IterationGovernanceSimulationResult[];
    summary: string;
    uncertaintyNotes: string[];
    reasonCodes: string[];
    generatedAt: string;
}

export interface IterationGovernanceDriftSignal {
    signalId: string;
    artifactId: string;
    artifactType: 'recommendation' | 'override';
    taskClass: IterationWorthinessClass;
    severity: IterationGovernancePriorityClass;
    reasonCodes: string[];
    summary: string;
    suggestedAction: IterationGovernanceSuggestedAction;
}

export interface IterationGovernanceContradictionSignal {
    signalId: string;
    taskClass: IterationWorthinessClass;
    relatedArtifactIds: string[];
    severity: IterationGovernancePriorityClass;
    reasonCodes: string[];
    summary: string;
    suggestedAction: IterationGovernanceSuggestedAction;
}

export interface IterationGovernanceReviewRecommendation {
    artifactId: string;
    artifactType: 'recommendation' | 'override';
    taskClass: IterationWorthinessClass;
    priority: IterationGovernancePriorityScore;
    explanation: IterationGovernanceExplanation;
    suggestedAction: IterationGovernanceSuggestedAction;
}

export interface IterationGovernanceAttentionSummary {
    generatedAt: string;
    topReviewRecommendations: IterationGovernanceReviewRecommendation[];
    driftSignals: IterationGovernanceDriftSignal[];
    contradictionSignals: IterationGovernanceContradictionSignal[];
    blockedRecommendationExplanations: IterationGovernanceExplanation[];
}
