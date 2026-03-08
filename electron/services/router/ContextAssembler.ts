import { MemoryItem } from '../MemoryService';

export interface ContextBlock {
    header: string;
    source: string;
    priority: 'high' | 'normal' | 'internal';
    content: string;
    metadata?: {
        memory_ids: string[];
        count: number;
    };
}

export type ToolCapability = 'memory_retrieval' | 'memory_write' | 'system_core' | 'diagnostic' | 'all';

export interface TurnContext {
    turnId: string;
    resolvedMode: string;

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
    public static assemble(memories: MemoryItem[], mode: string, intent: string, retrievalSuppressed: boolean): AssemblyResult {
        const blocks: ContextBlock[] = [];

        // 1. Memory Block
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
