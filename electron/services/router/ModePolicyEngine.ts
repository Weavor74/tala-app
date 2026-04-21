export type Mode = 'assistant' | 'rp' | 'hybrid';
export type TurnPolicyId =
    | 'greeting'
    | 'technical_execution'
    | 'factual_query'
    | 'normal_hybrid_conversation'
    | 'immersive_roleplay';

export interface TurnPolicyProfile {
    policyId: TurnPolicyId;
    memoryReadPolicy: 'blocked' | 'relevant_only' | 'light' | 'lore_allowed';
    memoryWritePolicy: 'do_not_write' | 'short_term' | 'long_term';
    personalityLevel: 'minimal' | 'reduced' | 'normal' | 'full';
    astroLevel: 'off' | 'light' | 'full';
    reflectionLevel: 'off' | 'light' | 'full';
    toolExposureProfile: 'none' | 'technical_strict' | 'factual_narrow' | 'balanced' | 'immersive_controlled';
    responseStyle: 'brief_direct' | 'concise_technical' | 'neutral_informative' | 'warm_hybrid' | 'immersive_expressive';
    docRetrievalPolicy: 'enabled' | 'suppressed';
    worldStatePolicy: 'enabled' | 'suppressed';
    maintenancePolicy: 'enabled' | 'suppressed';
    mcpPreInferencePolicy: 'enabled' | 'suppressed';
}

export interface ModePolicy {
    allowedSources: string[];
    preferredTypes: string[];
    exclusionTypes: string[];
    astroWeight: number;
    personaInfluence: 'low' | 'medium' | 'high';
    outputFormat: 'natural_language' | 'in_character_dialogue';
    forbiddenPatterns: string[];
}

/**
 * Cognitive mode policy — governs how memory, docs, tools, and emotional
 * expression are handled for a given mode. Consumed by CognitiveTurnAssembler.
 */
export interface CognitiveModeRules {
    /** Memory retrieval policy: full retrieval, suppressed, or filtered to mode-safe memories. */
    memoryRetrievalPolicy: 'full' | 'suppressed' | 'filtered';
    /** Memory write policy for turns in this mode. */
    memoryWritePolicy: 'do_not_write' | 'ephemeral' | 'short_term' | 'long_term' | 'user_profile';
    /** Tool use policy: all tools, task-only tools, or none. */
    toolUsePolicy: 'all' | 'task_only' | 'none';
    /** Documentation retrieval policy: enabled or suppressed. */
    docRetrievalPolicy: 'enabled' | 'suppressed';
    /** Emotional expression bounds: how strongly emotion may influence output. */
    emotionalExpressionBounds: 'low' | 'medium' | 'high';
}

export class ModePolicyEngine {
    private static readonly POLICIES: Record<Mode, ModePolicy> = {
        assistant: {
            allowedSources: ['mem0', 'rag', 'system', 'tool_result'],
            preferredTypes: ['technical', 'factual', 'user_preference', 'task_state'],
            exclusionTypes: ['roleplay_scene', 'diary', 'lore'],
            astroWeight: 0.1,
            personaInfluence: 'low',
            outputFormat: 'natural_language',
            forbiddenPatterns: ['json_protocols', 'system_internal_ids']
        },
        rp: {
            allowedSources: ['mem0', 'rag', 'graph', 'astro', 'diary', 'explicit'],
            preferredTypes: ['lore', 'roleplay_scene', 'relationship', 'emotional'],
            exclusionTypes: ['technical_debug', 'system_logs', 'task_memory'],
            astroWeight: 0.8,
            personaInfluence: 'high',
            outputFormat: 'in_character_dialogue',
            forbiddenPatterns: ['breaking_character', 'technical_jargon']
        },
        hybrid: {
            allowedSources: ['any'],
            preferredTypes: ['conversation_continuity', 'factual', 'technical'],
            exclusionTypes: ['raw_debug_dumps', 'lengthy_roleplay_narratives'],
            astroWeight: 0.4,
            personaInfluence: 'medium',
            outputFormat: 'natural_language',
            forbiddenPatterns: ['json_serialization_leakage']
        }
    };

    /**
     * Cognitive rules per mode — single source of truth for how mode affects cognition.
     * Used by CognitiveTurnAssembler to populate CognitiveModePolicy.
     */
    private static readonly COGNITIVE_RULES: Record<Mode, CognitiveModeRules> = {
        assistant: {
            memoryRetrievalPolicy: 'full',
            memoryWritePolicy: 'long_term',
            toolUsePolicy: 'all',
            docRetrievalPolicy: 'enabled',
            emotionalExpressionBounds: 'low',
        },
        rp: {
            memoryRetrievalPolicy: 'filtered',
            memoryWritePolicy: 'do_not_write',
            toolUsePolicy: 'none',
            docRetrievalPolicy: 'suppressed',
            emotionalExpressionBounds: 'high',
        },
        hybrid: {
            memoryRetrievalPolicy: 'filtered',
            memoryWritePolicy: 'short_term',
            toolUsePolicy: 'task_only',
            docRetrievalPolicy: 'enabled',
            emotionalExpressionBounds: 'medium',
        },
    };

    private static readonly TURN_POLICY_PROFILES: Record<TurnPolicyId, TurnPolicyProfile> = {
        greeting: {
            policyId: 'greeting',
            memoryReadPolicy: 'blocked',
            memoryWritePolicy: 'do_not_write',
            personalityLevel: 'minimal',
            astroLevel: 'off',
            reflectionLevel: 'off',
            toolExposureProfile: 'none',
            responseStyle: 'brief_direct',
            docRetrievalPolicy: 'suppressed',
            worldStatePolicy: 'suppressed',
            maintenancePolicy: 'suppressed',
            mcpPreInferencePolicy: 'suppressed',
        },
        technical_execution: {
            policyId: 'technical_execution',
            memoryReadPolicy: 'relevant_only',
            memoryWritePolicy: 'long_term',
            personalityLevel: 'reduced',
            astroLevel: 'off',
            reflectionLevel: 'off',
            toolExposureProfile: 'technical_strict',
            responseStyle: 'concise_technical',
            docRetrievalPolicy: 'enabled',
            worldStatePolicy: 'enabled',
            maintenancePolicy: 'enabled',
            mcpPreInferencePolicy: 'enabled',
        },
        factual_query: {
            policyId: 'factual_query',
            memoryReadPolicy: 'relevant_only',
            memoryWritePolicy: 'short_term',
            personalityLevel: 'reduced',
            astroLevel: 'off',
            reflectionLevel: 'off',
            toolExposureProfile: 'factual_narrow',
            responseStyle: 'neutral_informative',
            docRetrievalPolicy: 'enabled',
            worldStatePolicy: 'suppressed',
            maintenancePolicy: 'suppressed',
            mcpPreInferencePolicy: 'suppressed',
        },
        normal_hybrid_conversation: {
            policyId: 'normal_hybrid_conversation',
            memoryReadPolicy: 'light',
            memoryWritePolicy: 'short_term',
            personalityLevel: 'normal',
            astroLevel: 'light',
            reflectionLevel: 'light',
            toolExposureProfile: 'balanced',
            responseStyle: 'warm_hybrid',
            docRetrievalPolicy: 'enabled',
            worldStatePolicy: 'suppressed',
            maintenancePolicy: 'suppressed',
            mcpPreInferencePolicy: 'suppressed',
        },
        immersive_roleplay: {
            policyId: 'immersive_roleplay',
            memoryReadPolicy: 'lore_allowed',
            memoryWritePolicy: 'do_not_write',
            personalityLevel: 'full',
            astroLevel: 'full',
            reflectionLevel: 'off',
            toolExposureProfile: 'immersive_controlled',
            responseStyle: 'immersive_expressive',
            docRetrievalPolicy: 'suppressed',
            worldStatePolicy: 'suppressed',
            maintenancePolicy: 'suppressed',
            mcpPreInferencePolicy: 'suppressed',
        },
    };

    public static getPolicy(mode: Mode): ModePolicy {
        return this.POLICIES[mode] || this.POLICIES.assistant;
    }

    public static getAllowedSources(mode: Mode): string[] {
        return this.getPolicy(mode).allowedSources;
    }

    public static isSourceAllowed(mode: Mode, source: string): boolean {
        const allowed = this.getAllowedSources(mode);
        return allowed.includes('any') || allowed.includes(source);
    }

    /**
     * Returns the cognitive rules for the given mode.
     * These govern memory, docs, tools, and emotional expression at the cognitive layer.
     */
    public static getCognitiveRules(mode: Mode): CognitiveModeRules {
        return this.COGNITIVE_RULES[mode] || this.COGNITIVE_RULES.assistant;
    }

    public static getTurnPolicy(policyId: TurnPolicyId): TurnPolicyProfile {
        return this.TURN_POLICY_PROFILES[policyId];
    }

    public static resolveTurnPolicyId(
        mode: Mode,
        intentClass: string,
        isGreeting: boolean,
    ): TurnPolicyId {
        if (mode === 'rp') return 'immersive_roleplay';
        if (isGreeting || intentClass === 'greeting') return 'greeting';
        if (intentClass === 'lore' || intentClass === 'narrative') return 'immersive_roleplay';
        if (['coding', 'technical', 'action', 'browser'].includes(intentClass)) return 'technical_execution';
        if (intentClass === 'social') return 'normal_hybrid_conversation';
        return 'normal_hybrid_conversation';
    }
}
