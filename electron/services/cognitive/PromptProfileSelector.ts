/**
 * Prompt Profile Selector — Phase 3B: Small-Model Cognitive Compaction
 *
 * Determines the active prompt profile and cognitive budget for the selected
 * provider/model combination. Emits telemetry on every profile selection.
 *
 * Inputs:
 *   - Selected provider descriptor
 *   - Selected model name
 *   - Optional mode override
 *
 * Outputs:
 *   - Active ModelCapabilityProfile
 *   - Cognitive budget limits
 *   - Compaction policy
 *
 * Profile selection is deterministic. Every decision is logged to telemetry.
 */

import type { ModelCapabilityProfile } from '../../../shared/modelCapabilityTypes';
import type { InferenceProviderDescriptor } from '../../../shared/inferenceProviderTypes';
import { classifyModelCapability } from './ModelCapabilityClassifier';
import { telemetry } from '../TelemetryService';

// ─── Selector ─────────────────────────────────────────────────────────────────

export class PromptProfileSelector {
    /**
     * Selects a ModelCapabilityProfile for the given provider/model.
     * Emits a `prompt_profile_selected` telemetry event.
     *
     * @param provider - The selected inference provider descriptor.
     * @param modelName - The resolved model name string.
     * @param turnId - Turn identifier for telemetry correlation.
     * @param agentMode - Active agent mode for telemetry context.
     * @returns ModelCapabilityProfile with budget and compaction policy.
     */
    public select(
        provider: Pick<InferenceProviderDescriptor, 'providerId' | 'providerType' | 'displayName'>,
        modelName: string,
        turnId = 'global',
        agentMode = 'unknown',
    ): ModelCapabilityProfile {
        const profile = classifyModelCapability(provider, modelName);

        telemetry.operational(
            'cognitive',
            'prompt_profile_selected',
            'info',
            'PromptProfileSelector',
            `Profile selected: ${profile.promptProfileClass} for model "${modelName}" (${profile.parameterClass}) — compaction: ${profile.compactionPolicy}`,
            'success',
            {
                payload: {
                    profileId: profile.profileId,
                    modelName: profile.modelName,
                    providerType: profile.providerType,
                    parameterClass: profile.parameterClass,
                    promptProfileClass: profile.promptProfileClass,
                    compactionPolicy: profile.compactionPolicy,
                    classInferred: profile.classInferred,
                    classificationRationale: profile.classificationRationale,
                    agentMode,
                    turnId,
                },
            },
        );

        return profile;
    }
}

/** Module singleton for prompt profile selection. */
export const promptProfileSelector = new PromptProfileSelector();
