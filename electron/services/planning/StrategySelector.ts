import type {
    GoalAnalysis,
    PlanGoal,
} from '../../../shared/planning/PlanningTypes';
import type {
    PlanningBiasProfile,
    PlanningMemoryReasonCode,
    StrategyFamily,
    StrategySelection,
} from '../../../shared/planning/PlanningMemoryTypes';
import type { PlanningContextRuntimeState } from './PlanningContextBuilder';

function clamp01(value: number): number {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

export interface StrategySelectorInput {
    goal: PlanGoal;
    analysis: GoalAnalysis;
    biasProfile: PlanningBiasProfile;
    runtime: PlanningContextRuntimeState;
}

export class StrategySelector {
    static select(input: StrategySelectorInput): StrategySelection {
        const reasonCodes: PlanningMemoryReasonCode[] = [...input.biasProfile.reasonCodes];

        let strategyFamily = StrategySelector._selectStrategyFamily(input, reasonCodes);
        const verificationDepth =
            input.biasProfile.recommendedVerificationDepth ?? 'standard';
        const retryPosture =
            input.biasProfile.recommendedRetryPosture ?? 'standard';
        const fallbackPosture =
            input.biasProfile.recommendedFallbackPosture ?? 'operator_visible';

        const artifactFirst =
            input.biasProfile.userPreferences.prefersArtifactFirst === true ||
            strategyFamily === 'artifact_first' ||
            input.goal.category === 'release';

        if (
            strategyFamily === 'retrieval_first' &&
            !input.runtime.semanticRetrievalAvailable
        ) {
            strategyFamily = 'deterministic_workflow';
            reasonCodes.push('runtime:semantic_retrieval_degraded');
        }

        const selectedLane = StrategySelector._selectLane(
            input,
            strategyFamily,
        );

        const confidence = clamp01(
            (input.biasProfile.confidence * 0.7) +
                (selectedLane === 'trivial' ? 0.1 : 0.2),
        );

        return {
            selectedLane,
            strategyFamily,
            verificationDepth,
            retryPosture,
            fallbackPosture,
            artifactFirst,
            confidence,
            reasonCodes: Array.from(new Set(reasonCodes)),
        };
    }

    private static _selectStrategyFamily(
        input: StrategySelectorInput,
        reasonCodes: PlanningMemoryReasonCode[],
    ): StrategyFamily {
        const preferred = input.biasProfile.strategyBiases
            .find(b => b.preferred && !b.avoid);
        const avoided = new Set(
            input.biasProfile.strategyBiases
                .filter(b => b.avoid)
                .map(b => b.strategyFamily),
        );

        if (preferred && !avoided.has(preferred.strategyFamily)) {
            reasonCodes.push('memory:similar_task_preferred_strategy');
            return preferred.strategyFamily;
        }

        const repeatedTimeouts = input.biasProfile.knownFailurePatterns.some(
            p => p.includes('timeout'),
        );
        if (repeatedTimeouts) {
            reasonCodes.push('memory:historical_retry_harmful');
            return 'deterministic_workflow';
        }

        switch (input.analysis.executionStyle) {
            case 'workflow':
                return avoided.has('deterministic_workflow')
                    ? 'direct_tool'
                    : 'deterministic_workflow';
            case 'tool_orchestrated':
                return input.biasProfile.userPreferences.prefersDeterministicPathsForTechnicalWork
                    ? 'deterministic_workflow'
                    : 'direct_tool';
            case 'llm_assisted':
            case 'hybrid':
                return avoided.has('agentic_workflow')
                    ? 'deterministic_workflow'
                    : 'agentic_workflow';
            case 'deterministic':
            default:
                if (input.goal.category === 'research') return 'retrieval_first';
                if (input.goal.category === 'release') return 'artifact_first';
                return 'deterministic_workflow';
        }
    }

    private static _selectLane(
        input: StrategySelectorInput,
        strategyFamily: StrategyFamily,
    ): StrategySelection['selectedLane'] {
        if (input.analysis.complexity === 'trivial') return 'trivial';
        if (strategyFamily === 'agentic_workflow') return 'agent';
        if (
            strategyFamily === 'deterministic_workflow' ||
            strategyFamily === 'artifact_first'
        ) {
            return 'workflow';
        }
        return 'planning_loop';
    }
}

