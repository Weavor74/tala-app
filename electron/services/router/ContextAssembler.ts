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
}

interface AssemblyResult {
    mode: string;
    intent: string;
    blocks: ContextBlock[];
    retrievalSuppressed: boolean;
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
     * 2. **Memory Injection**: Compiles retrieved `MemoryItem`s into a `[MEMORY CONTEXT]` block.
     * 3. **Safety Enforcement**: Injects a `[FALLBACK CONTRACT]` if substantive queries have 0 memories.
     * 4. **Sanitization**: Filters internal service names and leaky metadata from all blocks.
     * 
     * @param memories - The filtered list of context-relevant memories.
     * @param mode - The current active mode (rp, hybrid, assistant).
     * @param intent - The classified intent of the user turn.
     * @param retrievalSuppressed - Whether memory retrieval was bypassed for this turn.
     * @param docContext - Optional relevant documentation context.
     * @returns A structured context handoff for the downstream prompt engines.
     */
    public static assemble(memories: MemoryItem[], mode: string, intent: string, retrievalSuppressed: boolean, docContext?: string): AssemblyResult {
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
            retrievalSuppressed
        };

        return handoff;
    }

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
