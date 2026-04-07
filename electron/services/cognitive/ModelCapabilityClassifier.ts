/**
 * Model Capability Classifier — Phase 3B: Small-Model Cognitive Compaction
 *
 * Classifies provider/model combinations into capability profiles that drive
 * prompt profile selection and cognitive budget allocation.
 *
 * Classification strategy:
 *   1. Extract numeric parameter count from model name (e.g. "qwen2.5:3b" → 3B).
 *   2. Map count to ModelParameterClass: tiny ≤ 4B, small ≤ 8B, medium ≤ 20B, large > 20B.
 *   3. If no count can be extracted, apply provider-based heuristics.
 *   4. If still unknown, return deterministic "unknown" class with fallback profile.
 *
 * Budget profiles by class:
 *   tiny   : identity=2, task=3, continuity=2, pref=0, docs=0-1, reflection=1
 *   small  : identity=3, task=4, continuity=3, pref=1, docs=1, reflection=2
 *   medium : identity=4, task=6, continuity=4, pref=2, docs=2, reflection=3
 *   large  : identity=5, task=8, continuity=5, pref=3, docs=3, reflection=4
 *   unknown: falls back to small budget (conservative)
 */

import type {
    ModelCapabilityProfile,
    ModelParameterClass,
    PromptProfileClass,
    CognitiveBudgetProfile,
    CompactionPolicy,
} from '../../../shared/modelCapabilityTypes';
import type { InferenceProviderDescriptor } from '../../../shared/inferenceProviderTypes';

// ─── Budget profiles by class ─────────────────────────────────────────────────

const BUDGET_PROFILES: Record<PromptProfileClass, CognitiveBudgetProfile> = {
    tiny_profile: {
        identityMemoryCap: 2,
        taskMemoryCap: 3,
        continuityMemoryCap: 2,
        preferenceMemoryCap: 0,
        docChunkCap: 1,
        reflectionNoteCap: 1,
        emotionalDimensionCap: 2,
        toolDescriptionCap: 0,
        allowFullToolSchemas: false,
        allowFullIdentityProse: false,
        suppressDocsUnlessHighlyRelevant: true,
        allowRawAstroData: false,
    },
    small_profile: {
        identityMemoryCap: 3,
        taskMemoryCap: 4,
        continuityMemoryCap: 3,
        preferenceMemoryCap: 1,
        docChunkCap: 1,
        reflectionNoteCap: 2,
        emotionalDimensionCap: 3,
        toolDescriptionCap: 2,
        allowFullToolSchemas: false,
        allowFullIdentityProse: false,
        suppressDocsUnlessHighlyRelevant: true,
        allowRawAstroData: false,
    },
    medium_profile: {
        identityMemoryCap: 4,
        taskMemoryCap: 6,
        continuityMemoryCap: 4,
        preferenceMemoryCap: 2,
        docChunkCap: 2,
        reflectionNoteCap: 3,
        emotionalDimensionCap: 4,
        toolDescriptionCap: 5,
        allowFullToolSchemas: false,
        allowFullIdentityProse: true,
        suppressDocsUnlessHighlyRelevant: false,
        allowRawAstroData: false,
    },
    large_profile: {
        identityMemoryCap: 5,
        taskMemoryCap: 8,
        continuityMemoryCap: 5,
        preferenceMemoryCap: 3,
        docChunkCap: 3,
        reflectionNoteCap: 4,
        emotionalDimensionCap: 5,
        toolDescriptionCap: 10,
        allowFullToolSchemas: true,
        allowFullIdentityProse: true,
        suppressDocsUnlessHighlyRelevant: false,
        allowRawAstroData: false,
    },
};

const COMPACTION_POLICY_BY_CLASS: Record<ModelParameterClass, CompactionPolicy> = {
    tiny: 'aggressive',
    small: 'moderate',
    medium: 'standard',
    large: 'full',
    unknown: 'moderate', // conservative fallback
};

// ─── Known cloud provider heuristics ─────────────────────────────────────────

/**
 * Cloud providers default to large profile unless model name suggests otherwise.
 */
const CLOUD_PROVIDER_TYPES = new Set(['cloud', 'openai', 'anthropic', 'mistral', 'cohere']);

// ─── Parameter extraction ─────────────────────────────────────────────────────

/**
 * Attempts to extract a parameter count (in billions) from a model name string.
 * Recognizes patterns like "3b", "7B", "13b", "70b", "0.5b", "1.5b", "2.7b".
 *
 * Returns null if no pattern is found.
 */
export function extractParameterBillions(modelName: string): number | null {
    const normalized = modelName.toLowerCase();
    // Match patterns: 3b, 7b, 13b, 70b, 0.5b, 1.5b, 2.7b, 3.8b, etc.
    const match = normalized.match(/(\d+(?:\.\d+)?)\s*b(?:\b|:|-|_)/);
    if (match) {
        return parseFloat(match[1]);
    }
    return null;
}

/**
 * Classifies a parameter count (in billions) into a ModelParameterClass.
 */
export function classifyParameterCount(billions: number): ModelParameterClass {
    if (billions <= 4) return 'tiny';
    if (billions <= 8) return 'small';
    if (billions <= 20) return 'medium';
    return 'large';
}

/**
 * Derives a PromptProfileClass from a ModelParameterClass.
 */
export function promptProfileFromClass(cls: ModelParameterClass): PromptProfileClass {
    switch (cls) {
        case 'tiny': return 'tiny_profile';
        case 'small': return 'small_profile';
        case 'medium': return 'medium_profile';
        case 'large': return 'large_profile';
        case 'unknown': return 'small_profile'; // conservative fallback
    }
}

// ─── Classifier ───────────────────────────────────────────────────────────────

/**
 * Classifies a provider/model into a full ModelCapabilityProfile.
 *
 * @param providerDescriptor - The selected inference provider.
 * @param modelName - The model name string (e.g. "qwen2.5:3b", "llama3.1:8b").
 * @returns ModelCapabilityProfile with deterministic classification and rationale.
 */
export function classifyModelCapability(
    providerDescriptor: Pick<InferenceProviderDescriptor, 'providerId' | 'providerType' | 'displayName'>,
    modelName: string,
): ModelCapabilityProfile {
    const profileId = `${providerDescriptor.providerId}/${modelName}`;
    let parameterClass: ModelParameterClass;
    let classInferred = false;
    let rationale: string;

    // Step 1: Try to extract parameter count from model name
    const billions = extractParameterBillions(modelName);
    if (billions !== null) {
        parameterClass = classifyParameterCount(billions);
        rationale = `Extracted ${billions}B parameter count from model name "${modelName}" → ${parameterClass}`;
    } else {
        // Step 2: Provider-based heuristics
        classInferred = true;
        const provType = providerDescriptor.providerType.toLowerCase();
        if (CLOUD_PROVIDER_TYPES.has(provType)) {
            parameterClass = 'large';
            rationale = `Cloud provider "${provType}" — defaulting to large profile. Model name "${modelName}" did not contain parameter count.`;
        } else if (provType === 'embedded_llamacpp' || provType === 'embedded_vllm') {
            // Embedded providers typically run 3B-7B models on modest hardware
            parameterClass = 'small';
            rationale = `Embedded ${provType} provider — conservative small classification. Model name "${modelName}" did not contain parameter count.`;
        } else {
            // Unknown local provider — use unknown class with conservative profile
            parameterClass = 'unknown';
            rationale = `Provider type "${provType}" with model "${modelName}" — parameter count not determinable. Using conservative unknown/small fallback.`;
        }
    }

    const promptProfileClass = promptProfileFromClass(parameterClass);
    const budgetProfile = BUDGET_PROFILES[promptProfileClass];
    const compactionPolicy = COMPACTION_POLICY_BY_CLASS[parameterClass];

    return {
        profileId,
        modelName,
        providerType: providerDescriptor.providerType,
        parameterClass,
        promptProfileClass,
        budgetProfile,
        compactionPolicy,
        classInferred,
        classificationRationale: rationale,
    };
}
