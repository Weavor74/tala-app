import type {
    GoalAnalysis,
    PlanGoal,
} from '../../../shared/planning/PlanningTypes';
import type {
    PlanningBiasProfile,
    PlanningMemoryReasonCode,
    PlanningSimilarityFeatures,
    RetryPosture,
    FallbackPosture,
    UserPlanningPreferenceProfile,
    VerificationDepth,
} from '../../../shared/planning/PlanningMemoryTypes';
import { PlanningEpisodeRepository } from './PlanningEpisodeRepository';

export interface PlanningContextRuntimeState {
    inferenceAvailable: boolean;
    postgresAvailable: boolean;
    semanticRetrievalAvailable: boolean;
    networkAvailable: boolean;
    degradedSubsystems?: string[];
}

export interface BuildPlanningContextInput {
    goal: PlanGoal;
    analysis: GoalAnalysis;
    runtime: PlanningContextRuntimeState;
}

function clamp01(value: number): number {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

export class PlanningContextBuilder {
    constructor(private readonly _episodes: PlanningEpisodeRepository) {}

    build(input: BuildPlanningContextInput): {
        similarityFeatures: PlanningSimilarityFeatures;
        biasProfile: PlanningBiasProfile;
    } {
        const features = this._deriveSimilarityFeatures(input.goal, input.analysis);
        const similarEpisodes = this._episodes.querySimilarEpisodes(features, { limit: 12, minSimilarity: 0.4 });
        const strategyBiases = this._episodes.summarizeStrategyPatterns(similarEpisodes);
        const toolBiases = this._episodes.summarizeToolPatterns(similarEpisodes);
        const knownFailurePatterns = this._episodes.summarizeFailurePatterns(similarEpisodes);
        const knownRecoveryPatterns = this._episodes.summarizeRecoveryPatterns(similarEpisodes);
        const userPreferences = this._resolveUserPreferences(input.goal);

        const reasonCodes: PlanningMemoryReasonCode[] = [];
        const runtimeBiases: string[] = [];
        const degradedSubsystems = input.runtime.degradedSubsystems ?? [];

        if (!input.runtime.postgresAvailable || degradedSubsystems.includes('memory')) {
            reasonCodes.push('runtime:postgres_degraded');
            runtimeBiases.push('postgres_degraded');
        }
        if (!input.runtime.semanticRetrievalAvailable || degradedSubsystems.includes('retrieval')) {
            reasonCodes.push('runtime:semantic_retrieval_degraded');
            runtimeBiases.push('semantic_retrieval_degraded');
        }
        if (!input.runtime.inferenceAvailable || degradedSubsystems.includes('inference')) {
            reasonCodes.push('runtime:inference_degraded');
            runtimeBiases.push('inference_degraded');
        }
        if (!input.runtime.networkAvailable || degradedSubsystems.includes('network')) {
            reasonCodes.push('runtime:network_unavailable');
            runtimeBiases.push('network_unavailable');
        }

        if (userPreferences.prefersArtifactFirst) {
            reasonCodes.push('memory:user_prefers_artifact_first');
        }
        if (userPreferences.prefersLocalFirst) {
            reasonCodes.push('memory:user_prefers_local_first');
        }
        if (userPreferences.prefersVerificationBeforeMutation) {
            reasonCodes.push('memory:user_prefers_verification_before_mutation');
        }
        if (userPreferences.prefersCompleteImplementation) {
            reasonCodes.push('memory:user_prefers_complete_implementation');
        }
        if (input.goal.category === 'release' || input.goal.category === 'maintenance') {
            reasonCodes.push('policy:verification_required');
            reasonCodes.push('policy:deterministic_path_preferred');
        }
        if (features.requiresArtifacts) {
            reasonCodes.push('policy:artifact_preferred');
        }
        if (knownFailurePatterns.length > 0) {
            reasonCodes.push('memory:repeated_failure_pattern_detected');
        }
        if (knownRecoveryPatterns.length > 0) {
            reasonCodes.push('memory:recovery_pattern_detected');
        }

        const recommendedVerificationDepth = this._recommendVerificationDepth(
            input,
            knownFailurePatterns,
            userPreferences,
        );
        const recommendedRetryPosture = this._recommendRetryPosture(knownFailurePatterns);
        const recommendedFallbackPosture = this._recommendFallbackPosture(input.runtime);
        const confidence = clamp01(
            similarEpisodes.length >= 6
                ? 0.85
                : similarEpisodes.length >= 3
                    ? 0.7
                    : similarEpisodes.length > 0
                        ? 0.55
                        : 0.35,
        );

        const biasProfile: PlanningBiasProfile = {
            generatedAt: new Date().toISOString(),
            userPreferences,
            similarEpisodes,
            strategyBiases,
            toolBiases,
            knownFailurePatterns,
            knownRecoveryPatterns,
            runtimeBiases,
            recommendedVerificationDepth,
            recommendedRetryPosture,
            recommendedFallbackPosture,
            confidence,
            reasonCodes: Array.from(new Set(reasonCodes)),
        };

        return {
            similarityFeatures: features,
            biasProfile,
        };
    }

    private _deriveSimilarityFeatures(
        goal: PlanGoal,
        analysis: GoalAnalysis,
    ): PlanningSimilarityFeatures {
        const description = goal.description.toLowerCase();
        const title = goal.title.toLowerCase();
        const text = `${title} ${description}`;
        const requiresRetrieval = goal.category === 'research' || text.includes('retrieve') || text.includes('search');
        const requiresArtifacts = goal.category === 'release' || text.includes('artifact') || text.includes('file');
        const requiresCodeChange = text.includes('code') || text.includes('fix') || text.includes('refactor');
        const requiresVerification = goal.priority === 'critical' || text.includes('verify') || text.includes('validate');
        const requiresExternalIO = text.includes('api') || text.includes('network') || text.includes('external');
        const toolingDomain: string[] = [];
        if (requiresCodeChange) toolingDomain.push('code');
        if (requiresRetrieval) toolingDomain.push('retrieval');
        if (requiresArtifacts) toolingDomain.push('artifact');
        if (goal.category === 'maintenance') toolingDomain.push('maintenance');

        return {
            goalClass: goal.category,
            requestCategory: goal.category,
            userIntentClass: goal.source,
            requiresRetrieval,
            requiresArtifacts,
            requiresCodeChange,
            requiresVerification,
            requiresExternalIO,
            toolingDomain,
            riskLevel: analysis.risk === 'critical' || analysis.risk === 'high'
                ? 'high'
                : analysis.risk === 'medium'
                    ? 'medium'
                    : 'low',
        };
    }

    private _resolveUserPreferences(goal: PlanGoal): UserPlanningPreferenceProfile {
        const metadata = (goal.metadata ?? {}) as Record<string, unknown>;
        const rawPrefs = metadata.userPlanningPreferences as
            | UserPlanningPreferenceProfile
            | undefined;
        if (rawPrefs) return rawPrefs;

        // Stable defaults aligned with Tala doctrine.
        return {
            prefersCompleteImplementation: true,
            prefersArtifactFirst: goal.category === 'release' || goal.category === 'workflow',
            prefersLocalFirst: true,
            prefersVerificationBeforeMutation: goal.category !== 'conversation',
            prefersDeterministicPathsForTechnicalWork: true,
            depthPreference: 'standard',
        };
    }

    private _recommendVerificationDepth(
        input: BuildPlanningContextInput,
        knownFailurePatterns: string[],
        prefs: UserPlanningPreferenceProfile,
    ): VerificationDepth {
        if (input.analysis.risk === 'critical') return 'strict';
        if (prefs.prefersVerificationBeforeMutation && input.analysis.risk !== 'low') return 'elevated';
        if (knownFailurePatterns.some(code => code.includes('timeout') || code.includes('invariant'))) return 'elevated';
        if (input.goal.category === 'conversation') return 'minimal';
        return 'standard';
    }

    private _recommendRetryPosture(knownFailurePatterns: string[]): RetryPosture {
        if (knownFailurePatterns.some(code => code.includes('timeout'))) return 'light';
        if (knownFailurePatterns.some(code => code.includes('rate'))) return 'conservative';
        if (knownFailurePatterns.some(code => code.includes('policy') || code.includes('permission'))) return 'none';
        return 'standard';
    }

    private _recommendFallbackPosture(runtime: PlanningContextRuntimeState): FallbackPosture {
        if (!runtime.networkAvailable || !runtime.inferenceAvailable) return 'degrade';
        if (!runtime.semanticRetrievalAvailable) return 'reroute';
        return 'operator_visible';
    }
}

