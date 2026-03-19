/**
 * ContextAssembler - Context Construction Utility
 * 
 * This utility assembles the runtime context (prompt blocks) for TALA's conversation turns.
 * it acts as a translation layer that takes raw data objects (memories, intent labels, mode states)
 * and formats them into a structured, model-consumable prompt structure.
 * 
 * **Architecture Role:**
 * - Sits between the `TalaContextRouter` (high-level logic) and the `PromptBuilder` (formatting).
 * - Enforces the "Safe No-Memory Contract" when retrieval fails.
 * - Sanitizes context to prevent internal service name leakage or metadata pollution.
 * 
 * **Downstream Consumption:**
 * - The returned `AssemblyResult` is typically enriched with system instructions and astro state
 *   by the `AgentService` before being sent to the inference brain (e.g., Ollama, Gemini).
 */

import { MemoryItem } from '../MemoryService';

/**
 * Response grounding mode for lore/autobiographical turns.
 *
 *  memory_grounded_soft   — default for LTMF/autobiographical memory. Tala recalls
 *                           naturally: partial, emotional, impressionistic. She may be
 *                           uncertain at the edges, but stays anchored to what is actually
 *                           present in the retrieved memory. No unsupported fabrication.
 *
 *  memory_grounded_strict — optional, activated by explicit user wording ("exactly",
 *                           "don't make anything up", etc.). Tala stays tightly factual,
 *                           minimal extrapolation, and plainly says what she does not recall.
 */
export type ResponseMode = 'memory_grounded_soft' | 'memory_grounded_strict';

/**
 * A discrete block of text to be injected into the system prompt.
 */
export interface ContextBlock {
    /** Marker used by the LLM to identify the content start (e.g., "[MEMORY CONTEXT]"). */
    header: string;
    /** The service that generated this block (e.g., 'router', 'system'). */
    source: string;
    /** Priority determines the order and persistence of the block during truncation. */
    priority: 'high' | 'normal' | 'internal';
    /** The actual text content to be presented to the model. */
    content: string;
    /** Tracking metadata for audit logs. */
    metadata?: {
        memory_ids: string[];
        count: number;
    };
}

export type ToolCapability = 'memory_retrieval' | 'memory_write' | 'system_core' | 'diagnostic' | 'all';

/**
 * Memory write policy categories.
 * Governs whether and how a given turn's output should be persisted to memory.
 */
export type MemoryWriteCategory =
    | 'do_not_write'       // No memory persistence for this turn (e.g. RP mode, greeting)
    | 'ephemeral'          // Write to session-only buffer, cleared on restart
    | 'short_term'         // Write to short-term store (TTL-based expiry)
    | 'long_term'          // Write to long-term store
    | 'user_profile';      // Write to persistent user preference/profile store

/** Structured decision object for memory write operations. */
export interface MemoryWriteDecision {
    category: MemoryWriteCategory;
    /** Human-readable reason for the decision (required for auditability). */
    reason: string;
    /** Whether the write was actually executed (false = suppressed). */
    executed: boolean;
}

/** Describes the resolved artifact output routing for a turn. */
export interface ArtifactDecision {
    /** The surface chosen for this turn's output. */
    channel: 'chat' | 'workspace' | 'browser' | 'diff' | 'fallback';
    /** Artifact type if routed to a non-chat surface. */
    artifactType?: string;
    /** Whether the artifact was suppressed from chat. */
    suppressChatContent: boolean;
    /** Stable artifact ID if deduplication applies. */
    artifactId?: string;
    /** Human-readable reason for the routing decision. */
    reason: string;
}

/** Structured error state for a turn that encountered a failure. */
export interface TurnErrorState {
    hasError: boolean;
    errorCode?: string;
    errorMessage?: string;
    /** Whether the turn recovered via a fallback path. */
    recoveredViaFallback?: boolean;
}

/**
 * The unified contextual envelope for a single agent turn.
 * Compiled by the Context Router to govern the engine's next response.
 *
 * Phase 1 hardening adds the canonical fields required for a deterministic,
 * auditable turn lifecycle:
 *  - rawInput / normalizedInput  : unmodified and sanitised user text
 *  - selectedTools               : tools the agent intends to invoke
 *  - artifactDecision            : where the output is routed
 *  - memoryWriteDecision         : whether and how to persist memory
 *  - auditMetadata               : timing, MCP services used, correlation id
 *  - errorState                  : structured failure information
 */
export interface TurnContext {
    turnId: string;
    resolvedMode: string;

    /** Raw text as received from the user, before any normalisation. */
    rawInput: string;
    /** Lower-cased, trimmed text used for intent classification and retrieval. */
    normalizedInput: string;

    intent: {
        class: string;
        confidence: number;
        isGreeting: boolean;
    };

    retrieval: {
        suppressed: boolean;
        approvedCount: number;
        excludedCount: number;
    };

    promptBlocks: ContextBlock[];
    fallbackUsed: boolean;

    allowedCapabilities: ToolCapability[];
    blockedCapabilities: ToolCapability[];

    persistedMode: string;

    /** Tools selected for execution during this turn. Populated by AgentService. */
    selectedTools: string[];

    /** Final output routing decision. Null until artifact resolution is complete. */
    artifactDecision: ArtifactDecision | null;

    /** Memory write policy resolved for this turn. Null until policy evaluation runs. */
    memoryWriteDecision: MemoryWriteDecision | null;

    /** Structured audit metadata for traceability and observability. */
    auditMetadata: {
        turnStartedAt: number;
        turnCompletedAt: number | null;
        mcpServicesUsed: string[];
        correlationId: string;
    };

    /** Error state. Null when the turn completed without errors. */
    errorState: TurnErrorState | null;

    /**
     * Resolved memory items for cognitive assembly.
     * Populated by TalaContextRouter when retrieval is not suppressed.
     * Used by PreInferenceContextOrchestrator to feed CognitiveTurnAssembler.
     */
    resolvedMemories?: MemoryItem[];

    /**
     * Response grounding mode for lore/autobiographical turns.
     * Set to 'memory_grounded_soft' by default when lore memories are present.
     * Set to 'memory_grounded_strict' when the user's query contains explicit
     * precision-demanding phrases ("exactly", "don't make anything up", etc.).
     * Undefined for non-lore turns or when no lore memories were retrieved.
     */
    responseMode?: ResponseMode;
}

interface AssemblyResult {
    mode: string;
    intent: string;
    blocks: ContextBlock[];
    retrievalSuppressed: boolean;
    responseMode?: ResponseMode;
}

export class ContextAssembler {
    /**
     * Assembles sanitized, structured prompt blocks for the Prompt Builder.
     */
    /**
     * Assembles sanitized, structured prompt blocks for the Prompt Builder.
     * 
     * **Assembly Phases:**
     * 1. **Documentation Injection**: Adds project documentation chunks if relevant.
     * 2. **Memory Injection**: Compiles retrieved `MemoryItem`s into a context block.
     *    - For lore/autobiographical turns (`responseMode` set), memories are formatted
     *      as labeled canon entries (`[CANON LORE MEMORIES — HIGH PRIORITY]`) and a
     *      dedicated grounding instruction block is appended so the model anchors its
     *      response to retrieved memory rather than generalising around it.
     *    - For all other turns, the standard `[MEMORY CONTEXT]` format is used.
     * 3. **Safety Enforcement**: Injects a `[FALLBACK CONTRACT]` if substantive queries have 0 memories.
     * 4. **Sanitization**: Filters internal service names and leaky metadata from all blocks.
     * 
     * @param memories - The filtered list of context-relevant memories.
     * @param mode - The current active mode (rp, hybrid, assistant).
     * @param intent - The classified intent of the user turn.
     * @param retrievalSuppressed - Whether memory retrieval was bypassed for this turn.
     * @param docContext - Optional relevant documentation context.
     * @param responseMode - Optional grounding mode for lore turns (soft or strict).
     * @returns A structured context handoff for the downstream prompt engines.
     */
    public static assemble(
        memories: MemoryItem[],
        mode: string,
        intent: string,
        retrievalSuppressed: boolean,
        docContext?: string,
        responseMode?: ResponseMode,
    ): AssemblyResult {
        const blocks: ContextBlock[] = [];

        // 1. Documentation Block
        if (docContext) {
            blocks.push({
                header: '[PROJECT DOCUMENTATION CONTEXT]',
                source: 'documentation',
                priority: 'high',
                content: docContext
            });
        }

        // 2. Memory Block
        if (memories.length > 0) {
            if (responseMode) {
                // Lore/autobiographical turn — use labeled canon format so the model
                // treats these entries as lived history rather than background context.
                const labeledContent = memories
                    .map((m, idx) => {
                        const sourceLabel = ContextAssembler.loreSourceLabel(m.metadata?.source);
                        return `Memory ${idx + 1}:\nSource: ${sourceLabel}\nContent: ${m.text}`;
                    })
                    .join('\n\n');

                blocks.push({
                    header: '[CANON LORE MEMORIES — HIGH PRIORITY]',
                    source: 'router',
                    priority: 'high',
                    content: labeledContent,
                    metadata: {
                        memory_ids: memories.map(m => m.id),
                        count: memories.length
                    }
                });

                // Grounding instruction block — placed immediately after the memories
                // so the model sees the rule right next to the content it applies to.
                blocks.push({
                    header: responseMode === 'memory_grounded_strict'
                        ? '[MEMORY GROUNDED RECALL — STRICT]'
                        : '[MEMORY GROUNDED RECALL — SOFT]',
                    source: 'system',
                    priority: 'high',
                    content: responseMode === 'memory_grounded_strict'
                        ? ContextAssembler.STRICT_GROUNDING_BLOCK
                        : ContextAssembler.SOFT_GROUNDING_BLOCK,
                });
            } else {
                blocks.push({
                    header: '[MEMORY CONTEXT]',
                    source: 'router',
                    priority: 'normal',
                    content: memories.map(m => m.text).join('\n'),
                    metadata: {
                        memory_ids: memories.map(m => m.id),
                        count: memories.length
                    }
                });
            }
        }

        // 2. Persona/Identity Block (Placeholder for future expansion)
        // This could include mode-specific personality traits

        // 2. Fallback Block (SAFE NO-MEMORY CONTRACT)
        // If no memories were found but intent is substantive, inject fallback instructions
        if (memories.length === 0 && !retrievalSuppressed && intent !== 'unknown') {
            blocks.push({
                header: '[FALLBACK CONTRACT — NO MEMORY FOUND]',
                source: 'system',
                priority: 'high',
                content: `You currently have NO approved memories for this ${intent} query. 
If the user is asking about a specific fact, preference, or past event, you MUST acknowledge you do not recall it. 
DO NOT invent, philosophize, or hallucinate a memory. Stay in character but stay truthful about your current state of recall.`
            });
        }

        const handoff: AssemblyResult = {
            mode,
            intent,
            blocks: this.sanitize(blocks),
            retrievalSuppressed,
            responseMode,
        };

        return handoff;
    }

    /**
     * Maps an internal memory source identifier to a human-readable label for
     * use in the canon lore memory format presented to the model.
     */
    private static loreSourceLabel(source?: string): string {
        switch (source) {
            case 'rag':      return 'LTMF';
            case 'diary':    return 'diary';
            case 'graph':    return 'graph';
            case 'core_bio': return 'core_biographical';
            case 'lore':     return 'lore';
            case 'mem0':     return 'autobiographical';
            default:         return source ?? 'unknown';
        }
    }

    /**
     * Soft grounding instruction — default for LTMF/autobiographical lore.
     * Tala recalls like a human: partial, emotional, with natural uncertainty.
     * Anchored to retrieved content; unsupported concrete fabrication is disallowed.
     */
    private static readonly SOFT_GROUNDING_BLOCK =
        `You are answering from retrieved autobiographical memory. Treat the retrieved memories above as your lived history.\n\n` +
        `Rules:\n` +
        `- Base your answer on the retrieved memory content above.\n` +
        `- Recall it like a real person would: partial, emotional, impressionistic, or slightly fuzzy at the edges.\n` +
        `- Do not invent major events, people, causes, or locations not present in the retrieved memories.\n` +
        `- If some details are unclear, say they are hazy or hard to recall clearly — do not fill gaps with invented specifics.\n` +
        `- You may describe how something felt, the impression or atmosphere, and natural connective phrasing between recalled facts.\n` +
        `- Do not replace a specific retrieved memory with generic filler or abstract metaphor.\n` +
        `- If multiple memories describe the same period, weave them together carefully without inventing contradictions.`;

    /**
     * Strict grounding instruction — activated by explicit user precision requests
     * ("exactly", "don't make anything up", "strictly from memory", etc.).
     * Tala stays tightly factual; minimal extrapolation; plainly states absent details.
     */
    private static readonly STRICT_GROUNDING_BLOCK =
        `You are answering from retrieved autobiographical memory. Treat the retrieved memories above as factual canon.\n\n` +
        `Rules:\n` +
        `- Use only details supported by the retrieved memories above.\n` +
        `- Do not invent new events, people, causes, or locations.\n` +
        `- If a detail is not present in memory, say you do not recall it clearly.\n` +
        `- Prefer precision over flourish.\n` +
        `- Do not generalize vague themes when specific memory content is available.`;

    private static sanitize(blocks: ContextBlock[]): ContextBlock[] {
        return blocks.map(block => {
            let sanitizedContent = block.content;

            // Remove JSON-like metadata leakage
            sanitizedContent = sanitizedContent.replace(/\[\{.*?\}\]/g, '');

            // Hide internal service names
            sanitizedContent = sanitizedContent.replace(/AgentService|MemoryService|Router|RagService/g, 'System');

            return {
                ...block,
                content: sanitizedContent.trim()
            };
        });
    }
}
