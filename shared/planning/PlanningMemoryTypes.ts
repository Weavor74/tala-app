/**
 * PlanningMemoryTypes.ts
 *
 * Typed planning-memory contracts for deterministic strategy selection.
 * These contracts are shared across planning services, telemetry, and diagnostics.
 */

export type PlanningEpisodeId = string;

export type StrategyFamily =
    | 'direct_tool'
    | 'deterministic_workflow'
    | 'agentic_workflow'
    | 'retrieval_first'
    | 'artifact_first'
    | 'verification_heavy'
    | 'degraded_fallback';

export type VerificationDepth = 'minimal' | 'standard' | 'elevated' | 'strict';
export type RetryPosture = 'none' | 'light' | 'standard' | 'conservative';
export type FallbackPosture = 'none' | 'reroute' | 'degrade' | 'operator_visible';

export type PlanningOutcome =
    | 'succeeded'
    | 'partially_succeeded'
    | 'failed'
    | 'abandoned'
    | 'blocked';

export interface PlanningSimilarityFeatures {
    goalClass: string;
    requestCategory?: string;
    userIntentClass?: string;
    requiresRetrieval?: boolean;
    requiresArtifacts?: boolean;
    requiresCodeChange?: boolean;
    requiresVerification?: boolean;
    requiresExternalIO?: boolean;
    toolingDomain?: string[];
    riskLevel?: 'low' | 'medium' | 'high';
}

export interface PlanningEpisode {
    id: PlanningEpisodeId;
    createdAt: string;
    goalClass: string;
    requestCategory?: string;
    userIntentClass?: string;
    executionLane?: 'trivial' | 'planning_loop' | 'workflow' | 'agent';
    strategyFamily?: StrategyFamily;
    verificationDepth?: VerificationDepth;
    retryPosture?: RetryPosture;
    fallbackPosture?: FallbackPosture;
    toolIds: string[];
    workflowIds: string[];
    runtimeConditions: {
        inferenceAvailable?: boolean;
        postgresAvailable?: boolean;
        semanticRetrievalAvailable?: boolean;
        networkAvailable?: boolean;
        degradedSubsystems?: string[];
    };
    similarityFeatures: PlanningSimilarityFeatures;
    outcome: PlanningOutcome;
    failureClass?: string;
    recoveryAction?: string;
    userAccepted?: boolean;
    requiredCorrection?: boolean;
    durationMs?: number;
    notes?: string[];
}

export interface ToolReliabilityBias {
    toolId: string;
    preferred: boolean;
    avoid: boolean;
    reasonCodes: string[];
    successRate?: number;
    failurePatterns?: string[];
}

export interface StrategyPatternBias {
    strategyFamily: StrategyFamily;
    preferred: boolean;
    avoid: boolean;
    reasonCodes: string[];
    supportingEpisodeCount: number;
    successRate?: number;
}

export interface UserPlanningPreferenceProfile {
    prefersCompleteImplementation?: boolean;
    prefersArtifactFirst?: boolean;
    prefersLocalFirst?: boolean;
    prefersVerificationBeforeMutation?: boolean;
    prefersDeterministicPathsForTechnicalWork?: boolean;
    depthPreference?: 'concise' | 'standard' | 'deep';
}

export type PlanningMemoryReasonCode =
    | 'memory:similar_task_preferred_strategy'
    | 'memory:similar_task_avoid_strategy'
    | 'memory:tool_success_pattern'
    | 'memory:tool_failure_pattern'
    | 'memory:user_prefers_complete_implementation'
    | 'memory:user_prefers_artifact_first'
    | 'memory:user_prefers_local_first'
    | 'memory:user_prefers_verification_before_mutation'
    | 'memory:historical_retry_helpful'
    | 'memory:historical_retry_harmful'
    | 'memory:repeated_failure_pattern_detected'
    | 'memory:recovery_pattern_detected'
    | 'runtime:postgres_degraded'
    | 'runtime:semantic_retrieval_degraded'
    | 'runtime:inference_degraded'
    | 'runtime:network_unavailable'
    | 'policy:verification_required'
    | 'policy:artifact_preferred'
    | 'policy:deterministic_path_preferred';

export interface PlanningBiasProfile {
    generatedAt: string;
    userPreferences: UserPlanningPreferenceProfile;
    similarEpisodes: PlanningEpisode[];
    strategyBiases: StrategyPatternBias[];
    toolBiases: ToolReliabilityBias[];
    knownFailurePatterns: string[];
    knownRecoveryPatterns: string[];
    runtimeBiases: string[];
    recommendedVerificationDepth?: VerificationDepth;
    recommendedRetryPosture?: RetryPosture;
    recommendedFallbackPosture?: FallbackPosture;
    confidence: number;
    reasonCodes: PlanningMemoryReasonCode[];
}

export interface StrategySelection {
    selectedLane: 'trivial' | 'planning_loop' | 'workflow' | 'agent';
    strategyFamily: StrategyFamily;
    verificationDepth: VerificationDepth;
    retryPosture: RetryPosture;
    fallbackPosture: FallbackPosture;
    artifactFirst: boolean;
    confidence: number;
    reasonCodes: PlanningMemoryReasonCode[];
}

