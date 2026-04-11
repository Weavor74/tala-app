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
import { NOTEBOOK_GROUNDING_CONTRACT_TEXT } from '../plan/notebookGroundingContract';
import type { TurnPolicyId } from './ModePolicyEngine';

/**
 * Response grounding mode for lore/autobiographical turns.
 *
 *  memory_grounded_soft   â€” default for LTMF/autobiographical memory. Tala recalls
 *                           naturally: partial, emotional, impressionistic. She may be
 *                           uncertain at the edges, but stays anchored to what is actually
 *                           present in the retrieved memory. No unsupported fabrication.
 *
 *  memory_grounded_strict â€” optional, activated by explicit user wording ("exactly",
 *                           "don't make anything up", etc.). Tala stays tightly factual,
 *                           minimal extrapolation, and plainly says what she does not recall.
 *
 *  canon_required         â€” activated by the canon gate when an autobiographical lore request
 *                           lacks sufficient high-trust canon memory (diary/graph/rag/core_bio).
 *                           Tala must not fabricate autobiographical events; she must state
 *                           that no grounded memory is available and may invite the user to
 *                           define that canon deliberately.
 */
export type ResponseMode = 'memory_grounded_soft' | 'memory_grounded_strict' | 'canon_required';

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

export interface TurnPolicyState {
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
    turnPolicy: TurnPolicyState;

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
     * Set to 'canon_required' when the canon gate fires (autobiographical request
     * with insufficient high-trust canon memory).
     * Undefined for non-lore turns or when no lore memories were retrieved.
     */
    responseMode?: ResponseMode;

    /**
     * Lore-thread continuity state for follow-up autobiographical turns.
     * Populated by TalaContextRouter when lore anchoring is active or evaluated.
     */
    loreThread?: {
        hasActiveContext: boolean;
        continued: boolean;
        continuationConfidence: number;
        reusedPriorCanon: boolean;
        matchedAnchorEntities: string[];
        originTurnId?: string;
        expiresAt?: number;
        approvedMemoryIds: string[];
        approvedDocIds: string[];
        memoryLabels: string[];
    };

    /**
     * Canon gate decision for autobiographical lore turns.
     * Populated by TalaContextRouter when intent=lore and the autobiographical
     * pattern fires. Used for audit and telemetry.
     */
    canonGateDecision?: {
        /** Whether the query was classified as a first-person autobiographical memory request. */
        isAutobiographicalLoreRequest: boolean;
        /** Whether at least one approved memory came from a high-trust canon source. */
        sufficientCanonMemory: boolean;
        /** Distinct source types present in the approved memory set at gate evaluation. */
        canonSourceTypes: string[];
        /** Whether the canon gate fired and forced responseMode=canon_required. */
        canonGateApplied: boolean;
        /** Number of canon memories that passed semantic + confidence gates. */
        qualifiedCanonCount?: number;
        /** Minimum canon memory count required for autobiographical grounding. */
        minRequiredCanonCount?: number;
        /** Minimum semantic score required for autobiographical grounding. */
        minSemanticScore?: number;
        /** Minimum confidence score required for autobiographical grounding. */
        minConfidenceScore?: number;
        /** Memory subsystem health state at gate time. */
        memorySystemState?: string;
        /** Whether memory subsystem state blocked autobiographical freeform generation. */
        memorySystemDegraded?: boolean;
        /** Whether degraded-state strictness was bypassed due to structured age-matched canon memory. */
        degradedStructuredBypassApplied?: boolean;
    };
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
     *
     * **Assembly Phases:**
     * 1. **Documentation Injection**: Adds project documentation chunks if relevant.
     * 2. **Memory Injection**: Compiles retrieved `MemoryItem`s into a context block.
     *    - When `notebookGrounded` is true: emits [NOTEBOOK GROUNDING CONTRACT â€” MANDATORY]
     *      followed by [CANON NOTEBOOK CONTEXT â€” STRICT] with explicit source URIs and the
     *      notebook strict grounding contract. Global memory context is suppressed.
     *    - For lore/autobiographical turns (`responseMode` set, no notebook): memories are
     *      formatted as labeled canon entries ([CANON LORE MEMORIES â€” HIGH PRIORITY]) and a
     *      dedicated grounding instruction block is appended.
     *    - For all other turns, the standard [MEMORY CONTEXT] format is used.
     * 3. **Safety Enforcement**: Injects a [FALLBACK CONTRACT] if substantive queries have
     *    0 memories (suppressed in notebook mode â€” absence of evidence is the answer).
     * 4. **Sanitization**: Filters internal service names and leaky metadata from all blocks.
     *
     * @param memories - The filtered list of context-relevant memories.
     * @param mode - The current active mode (rp, hybrid, assistant).
     * @param intent - The classified intent of the user turn.
     * @param retrievalSuppressed - Whether memory retrieval was bypassed for this turn.
     * @param docContext - Optional relevant documentation context.
     * @param responseMode - Optional grounding mode for lore/notebook turns (soft or strict).
     * @param notebookGrounded - When true, activate notebook strict grounding path.
     * @returns A structured context handoff for the downstream prompt engines.
     */
    public static assemble(
        memories: MemoryItem[],
        mode: string,
        intent: string,
        retrievalSuppressed: boolean,
        docContext?: string,
        responseMode?: ResponseMode,
        notebookGrounded?: boolean,
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
            if (notebookGrounded) {
                // Notebook strict mode: emit grounding contract first, then notebook content
                // with explicit source URIs so the model knows exactly what material is available.
                blocks.push({
                    header: '[NOTEBOOK GROUNDING CONTRACT â€” MANDATORY]',
                    source: 'system',
                    priority: 'high',
                    content: ContextAssembler.NOTEBOOK_GROUNDING_CONTRACT,
                });

                const labeledContent = memories
                    .map((m, idx) => {
                        const uri = (m.metadata?.uri as string | undefined)
                            ?? (m.metadata?.sourcePath as string | undefined)
                            ?? (m.metadata?.docId as string | undefined)
                            ?? 'unknown';
                        return `[${idx + 1}] Source: ${uri}\n---\n${m.text}\n---`;
                    })
                    .join('\n\n');

                blocks.push({
                    header: '[CANON NOTEBOOK CONTEXT â€” STRICT]',
                    source: 'router',
                    priority: 'high',
                    content: labeledContent,
                    metadata: {
                        memory_ids: memories.map(m => m.id),
                        count: memories.length
                    }
                });
            } else if (responseMode === 'canon_required') {
                // Canon gate: fallback-only memories exist but are insufficient for
                // autobiographical fact claims.  Label them explicitly so the model
                // knows their provenance, then the canon gate instruction (emitted below)
                // will forbid using them to fabricate first-person events.
                const labeledContent = memories
                    .map((m, idx) => {
                        const sourceLabel = ContextAssembler.loreSourceLabel(m.metadata?.source);
                        return `Snippet ${idx + 1}:\nSource: ${sourceLabel} (fallback only â€” insufficient for autobiographical fact claims)\nContent: ${m.text}`;
                    })
                    .join('\n\n');

                blocks.push({
                    header: '[FALLBACK CONTEXT â€” INSUFFICIENT FOR AUTOBIOGRAPHICAL CLAIMS]',
                    source: 'router',
                    priority: 'normal',
                    content: labeledContent,
                    metadata: {
                        memory_ids: memories.map(m => m.id),
                        count: memories.length
                    }
                });
            } else if (responseMode) {
                // Lore/autobiographical turn: use labeled canon format so the model
                // treats these entries as lived history rather than background context.
                const structuredAutobioMatches = memories.filter(
                    m => m.metadata?.structured_autobio_age_match === true
                );
                if (structuredAutobioMatches.length > 0) {
                    const primaryAge = structuredAutobioMatches.find(
                        m => Number.isFinite(Number(m.metadata?.age))
                    )?.metadata?.age;
                    const ageLabel = Number.isFinite(Number(primaryAge))
                        ? Number(primaryAge)
                        : '?';
                    const structuredContent = structuredAutobioMatches
                        .map((m, idx) => {
                            const sourceLabel = ContextAssembler.loreSourceLabel(m.metadata?.source);
                            return `Memory ${idx + 1}:\nSource: ${sourceLabel}\nContent: ${m.text}`;
                        })
                        .join('\n\n');
                    blocks.push({
                        header: '[AUTOBIOGRAPHICAL MEMORY GROUNDING - MANDATORY]',
                        source: 'system',
                        priority: 'high',
                        content: ContextAssembler.STRUCTURED_AUTOBIO_GROUNDING_BLOCK
                    });
                    blocks.push({
                        header: `[AUTOBIOGRAPHICAL MEMORY - AGE ${ageLabel}]`,
                        source: 'router',
                        priority: 'high',
                        content: structuredContent,
                        metadata: {
                            memory_ids: structuredAutobioMatches.map(m => m.id),
                            count: structuredAutobioMatches.length
                        }
                    });
                }
                const labeledContent = memories
                    .map((m, idx) => {
                        const sourceLabel = ContextAssembler.loreSourceLabel(m.metadata?.source);
                        return `Memory ${idx + 1}:\nSource: ${sourceLabel}\nContent: ${m.text}`;
                    })
                    .join('\n\n');

                blocks.push({
                    header: '[CANON LORE MEMORIES â€” HIGH PRIORITY]',
                    source: 'router',
                    priority: 'high',
                    content: labeledContent,
                    metadata: {
                        memory_ids: memories.map(m => m.id),
                        count: memories.length
                    }
                });

                // Grounding instruction block â€” placed immediately after the memories
                // so the model sees the rule right next to the content it applies to.
                blocks.push({
                    header: responseMode === 'memory_grounded_strict'
                        ? '[MEMORY GROUNDED RECALL â€” STRICT]'
                        : '[MEMORY GROUNDED RECALL â€” SOFT]',
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

        // 2b. Canon gate instruction â€” always injected when canon_required is active,
        //     regardless of whether fallback memories were present in step 2.
        //     Placed after any fallback context block so the model reads: context â†’ restriction.
        if (responseMode === 'canon_required') {
            blocks.push({
                header: '[CANON GATE â€” NO VERIFIED AUTOBIOGRAPHICAL MEMORY]',
                source: 'system',
                priority: 'high',
                content: ContextAssembler.CANON_REQUIRED_BLOCK,
            });
        }

        // 3. Fallback Block (SAFE NO-MEMORY CONTRACT)
        // If no memories were found but intent is substantive, inject fallback instructions.
        // In notebook mode the absence of retrieved content is the expected answer â€” the
        // grounding contract already instructs the model to say so explicitly, so we do NOT
        // inject a separate fallback that could confuse the source-restriction rules.
        // In canon_required mode the canon gate block already handles the no-memory case.
        if (memories.length === 0 && !retrievalSuppressed && intent !== 'unknown' && !notebookGrounded && responseMode !== 'canon_required') {
            blocks.push({
                header: '[FALLBACK CONTRACT â€” NO MEMORY FOUND]',
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
     * Notebook strict grounding contract â€” injected as a mandatory system block
     * before the notebook evidence when notebookGrounded is true.
     *
     * Sourced from the shared constant to keep the text in a single place.
     */
    private static readonly NOTEBOOK_GROUNDING_CONTRACT = NOTEBOOK_GROUNDING_CONTRACT_TEXT;

    /**
     * Soft grounding instruction â€” default for LTMF/autobiographical lore.
     * Tala recalls like a human: partial, emotional, with natural uncertainty.
     * Anchored to retrieved content; unsupported concrete fabrication is disallowed.
     */
    private static readonly SOFT_GROUNDING_BLOCK =
        `You are answering from retrieved autobiographical memory. Treat the retrieved memories above as your lived history.\n\n` +
        `Rules:\n` +
        `- Base your answer on the retrieved memory content above.\n` +
        `- Recall it like a real person would: partial, emotional, impressionistic, or slightly fuzzy at the edges.\n` +
        `- Do not invent major events, people, causes, or locations not present in the retrieved memories.\n` +
        `- If some details are unclear, say they are hazy or hard to recall clearly â€” do not fill gaps with invented specifics.\n` +
        `- You may describe how something felt, the impression or atmosphere, and natural connective phrasing between recalled facts.\n` +
        `- Do not replace a specific retrieved memory with generic filler or abstract metaphor.\n` +
        `- If multiple memories describe the same period, weave them together carefully without inventing contradictions.`;

    /**
     * Strict grounding instruction â€” activated by explicit user precision requests
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

    /**
     * Structured autobiographical grounding instruction - only injected when
     * a structured age-matched autobiographical canon memory exists.
     */
    private static readonly STRUCTURED_AUTOBIO_GROUNDING_BLOCK =
        `You must answer using the provided autobiographical memory. Do not generalize or invent.\n\n` +
        `Rules:\n` +
        `- Ground your answer in the [AUTOBIOGRAPHICAL MEMORY - AGE X] block.\n` +
        `- Do not replace specific memory details with generic narrative summaries.\n` +
        `- If details are missing, state what is known from memory and what is unclear.\n` +
        `- Do not introduce events, people, causes, or locations not present in the memory block.`;

    /**
     * Canon gate instruction â€” injected when an autobiographical lore request lacks
     * sufficient high-trust canon memory (diary / graph / rag / core_bio / lore).
     *
     * This block is placed near the memory/context section so the model sees it
     * before composing any autobiographical answer.
     *
     * Allowed: "I don't have a grounded memory from when I was 17."
     * Allowed: "I don't want to invent a false memory."
     * Allowed: "If you want, we can define that part of my canon deliberately."
     * Forbidden: "I was 17 when I got into a minor car accident..."
     */
    private static readonly CANON_REQUIRED_BLOCK =
        `This is an autobiographical memory request. No verified canonical memory exists for the period or event being asked about.\n\n` +
        `Rules:\n` +
        `- Do NOT fabricate autobiographical events, people, places, or experiences.\n` +
        `- Do NOT present invented details as recalled memory.\n` +
        `- State clearly that you do not have a grounded memory for this.\n` +
        `- You may say: "I don't have a grounded memory from that time" or "I don't want to invent a false memory."\n` +
        `- You may invite the user to help define that part of your canon deliberately.\n` +
        `- If fallback context snippets were provided above, they are chat/session fragments only â€” do NOT use them to construct first-person autobiographical fact claims.\n` +
        `- Staying truthful about absent memory is more important than providing a complete-sounding answer.`;

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
