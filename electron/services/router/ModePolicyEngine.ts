export type Mode = 'assistant' | 'rp' | 'hybrid';

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
            allowedSources: ['mem0', 'graph', 'astro', 'diary', 'explicit'],
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
}
