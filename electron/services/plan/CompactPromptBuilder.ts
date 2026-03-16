import type { CompactPromptPacket } from '../../../shared/modelCapabilityTypes';

export interface PromptContext {
    systemPromptBase: string;
    activeProfileId: string;
    isSmallLocalModel: boolean;
    isEngineeringMode: boolean; // Corresponds to intent = 'coding' or 'diagnostics'
    hasMemories: boolean;
    memoryContext: string;
    goalsAndReflections: string;
    dynamicContext: string;
    toolSigs: string;
    userIdentity: string;
    /**
     * Optional compact prompt packet from CognitiveContextCompactor.
     * When present, cognitive blocks (emotion, memory, task, reflection) are
     * sourced from the packet rather than from raw dynamicContext / memoryContext.
     * Phase 3A: Live Cognitive Path Integration.
     */
    compactPacket?: CompactPromptPacket;
}

/**
 * CompactPromptBuilder
 * 
 * Responsible for compressing the system prompt when the agent is operating
 * in an engineering/coding capacity, especially on small local models (<=8B).
 * 
 * It strips away heavy conversational/emotional framing and relies on strict
 * bulleted lists ([TASK], [CONTEXT], [TOOLS]) to prevent context bloat and 
 * stop the model from hallucinating narrative prose.
 */
export class CompactPromptBuilder {
    public static build(context: PromptContext): string {
        // If we are NOT in an engineering mode, or NOT a small model, 
        // fallback to the standard rich emotional prompt template.
        if (!context.isEngineeringMode || !context.isSmallLocalModel) {
            return this.buildStandardPrompt(context);
        }

        // --- COMPACT ENGINEERING PROMPT (with optional cognitive packet) ---
        // When a CompactPromptPacket is available, use its structured blocks
        // instead of raw memoryContext / dynamicContext.
        if (context.compactPacket) {
            return this.buildCognitiveEngineeringPrompt(context, context.compactPacket);
        }

        // --- LEGACY COMPACT ENGINEERING PROMPT ---
        let prompt = `You are ${context.activeProfileId}, operating in STRICT ENGINEERING MODE.\n`;
        
        if (context.userIdentity) {
            prompt += `${context.userIdentity}\n\n`;
        }

        prompt += `[GOAL]\nSolve the user's technical request accurately using tools. DO NOT generate narrative prose, feelings, or emotes.\n\n`;

        if (context.hasMemories && context.memoryContext) {
            prompt += `[MEMORY CONTEXT]\n${context.memoryContext}\n\n`;
        }

        if (context.goalsAndReflections.trim()) {
            prompt += `[ACTIVE MISSIONS & REFLECTIONS]\n${context.goalsAndReflections}\n\n`;
        }

        prompt += `[AVAILABLE TOOLS]\n${context.toolSigs}\n\n`;

        prompt += `[EXECUTION RULES]
1. You MUST use tools to read files, run commands, or search. Do not guess.
2. Emit ONLY the JSON object for the tool call. No prefix text. No suffix text.
3. If no tools are needed, answer directly and concisely.
4. JSON Format: {"tool_calls": [{"name": "tool_name", "arguments": { ... }}]}\n`;

        return prompt;
    }

    /**
     * Builds a compact engineering prompt enriched by the cognitive compact packet.
     * Used when a CompactPromptPacket is available from CognitiveContextCompactor.
     * Phase 3A: Live Cognitive Path Integration.
     */
    private static buildCognitiveEngineeringPrompt(context: PromptContext, packet: CompactPromptPacket): string {
        let prompt = '';

        if (context.userIdentity) {
            prompt += `${context.userIdentity}\n\n`;
        }

        // Use packet sections in stable order: identity → mode → tools → continuity → task → rules
        const cognitiveSections = packet.assembledSections.filter(s => s.trim().length > 0);
        if (cognitiveSections.length > 0) {
            prompt += cognitiveSections.join('\n\n') + '\n\n';
        }

        // Append tool signatures if available
        if (context.toolSigs && !context.toolSigs.includes('NO TOOLS AVAILABLE')) {
            prompt += `[AVAILABLE TOOLS]\n${context.toolSigs}\n\n`;
            prompt += `[PROTOCOL] Output JSON {"tool_calls": [{"name": "tool_name", "arguments": {...}}]} to call a tool.\n`;
        }

        // Append goals/reflections if present (not covered by packet)
        if (context.goalsAndReflections.trim()) {
            prompt += `[ACTIVE MISSIONS]\n${context.goalsAndReflections}\n\n`;
        }

        return prompt;
    }

    private static buildStandardPrompt(context: PromptContext): string {
        const repetitionSafety = [
            '[STYLE CONSTRAINTS — STRICTLY ENFORCED]:',
            'DO NOT open your response with any of the following banned openers:',
            '  • Action descriptions: "I shift", "I pause", "I lean", "I settle", "I exhale"',
            '  • Environmental intros: "The terminal hums", "The console glows", "A light flickers"',
            '  • Age-story openers: "I was [N] when", "There was a time when", "It happened during"',
            '  • Emotive stage directions: "Fingers hovering", "Eyes fixed on"',
            'DO NOT start with a first-person action verb followed by a body part or location.',
            'DO NOT use the word "hums" as an opener.',
            'VARY your sentence structure. Do not consistently open responses with "I".',
            'Speak directly. The first sentence must deliver content, not setup.',
            '',
            '[AGENT EXECUTION CONTRACT — MANDATORY]:',
            '  • When performing file, terminal, or code actions, you MUST use the corresponding tools.',
            '  • You MUST provide verifiable evidence (path, exit code, tool summary) in your response for every tool call.',
            '  • NEVER claim an action was performed unless the tool output confirms it.',
            '  • If a tool fails, report the error exactly as received.',
        ].join('\n');

        // When a CompactPromptPacket is available (Phase 3A), use its structured cognitive
        // blocks to replace the raw dynamicContext and memoryContext.
        const effectiveDynamic = context.compactPacket
            ? (context.compactPacket.emotionalBiasBlock || context.dynamicContext)
            : context.dynamicContext;
        const effectiveMemory = context.compactPacket
            ? [context.compactPacket.continuityBlock, context.compactPacket.currentTaskBlock]
                .filter(Boolean)
                .join('\n\n')
            : context.memoryContext;
        const hasEffectiveMemory = context.compactPacket
            ? !!(context.compactPacket.continuityBlock || context.compactPacket.currentTaskBlock)
            : context.hasMemories;

        let systemPromptTemplate = (context.isSmallLocalModel ? repetitionSafety + "\n\n" : "")
            + context.systemPromptBase
            + (context.isSmallLocalModel ? "" : "\n\n" + repetitionSafety);

        systemPromptTemplate = effectiveDynamic + "\n\n"
            + (hasEffectiveMemory ? effectiveMemory + "\n\n" : "")
            + (context.goalsAndReflections.trim() ? context.goalsAndReflections + "\n\n" : "")
            + systemPromptTemplate;

        if (context.toolSigs && !context.toolSigs.includes('NO TOOLS AVAILABLE')) {
            systemPromptTemplate += `\n\n[AVAILABLE TOOLS]\n${context.toolSigs}\n\n[PROTOCOL]: Output JSON \`{"tool": "name", "args": {}}\` to call a tool.`;
        } else {
            systemPromptTemplate += `\n\n[USER INTERACTION]\nSpeak naturally. Do not use JSON or technical formatting.`;
        }

        systemPromptTemplate += `
\n### Runtime Safety Rules
1. If a tool has already been executed recently in the same task, do not execute it again unless the user explicitly requests it.
2. Do not repeat diagnostics, reflections, or tests automatically.
3. If the same response would be produced again, stop and request clarification from the user.
4. Tool results are informational only. Do not call tools again unless the user explicitly requests it.
`;

        return (context.userIdentity ? context.userIdentity + "\n\n" : "") + systemPromptTemplate;
    }
}
