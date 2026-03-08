"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModePolicyEngine = void 0;
var ModePolicyEngine = /** @class */ (function () {
    function ModePolicyEngine() {
    }
    ModePolicyEngine.getPolicy = function (mode) {
        return this.POLICIES[mode] || this.POLICIES.assistant;
    };
    ModePolicyEngine.getAllowedSources = function (mode) {
        return this.getPolicy(mode).allowedSources;
    };
    ModePolicyEngine.isSourceAllowed = function (mode, source) {
        var allowed = this.getAllowedSources(mode);
        return allowed.includes('any') || allowed.includes(source);
    };
    ModePolicyEngine.POLICIES = {
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
            allowedSources: ['mem0', 'graph', 'astro', 'diary'],
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
    return ModePolicyEngine;
}());
exports.ModePolicyEngine = ModePolicyEngine;
