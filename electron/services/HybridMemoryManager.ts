import { MemoryService } from './MemoryService';
import { RagService } from './RagService';
import { McpService } from './McpService';

export interface HybridContextOptions {
    limitGraphNodes?: number;
    limitGraphEdges?: number;
    limitMem0?: number;
    limitRag?: number;
    emotion?: string;
    intensity?: number;
}

/**
 * HybridMemoryManager
 * 
 * Orchestrates tiered retrieval from Graph, Mem0, and RAG.
 * Implements the "Tiered Recovery" pattern:
 * 1. Graph (Structural/Relational) - High precision, context-aware.
 * 2. Mem0 (Fuzzy Facts) - Conversational drift and user preferences.
 * 3. RAG (Grounding) - Broad document-based knowledge.
 */
export class HybridMemoryManager {
    constructor(
        private memory: MemoryService,
        private rag: RagService,
        private mcp: McpService
    ) { }

    /**
     * Retrieves an integrated context string from all memory layers.
     */
    async getIntegratedContext(query: string, options: HybridContextOptions = {}): Promise<string> {
        const {
            limitGraphNodes = 5,
            limitGraphEdges = 5,
            limitMem0 = 5,
            limitRag = 8,
            emotion = 'neutral',
            intensity = 0.5
        } = options;

        let context = "";
        const graphPromise = this.getGraphContext(query, limitGraphNodes, limitGraphEdges, emotion, intensity);
        const mem0Promise = this.memory.search(query, limitMem0);
        const ragPromise = this.rag.search(query, { limit: limitRag });

        // Run in parallel for performance
        const [graphText, mem0Results, ragText] = await Promise.all([
            graphPromise,
            mem0Promise.catch(() => []),
            ragPromise.catch(() => "")
        ]);

        // Tier 1: Graph
        if (graphText && !graphText.includes('No relevant memories')) {
            context += `[GRAPH MEMORY]\n${graphText}\n\n`;
        }

        // Tier 2: Mem0
        if (mem0Results.length > 0) {
            context += `[CONVERSATIONAL FACTS]\n${mem0Results.map(m => m.text).join('\n')}\n\n`;
        }

        // Tier 3: RAG
        if (ragText) {
            context += `[LONG TERM NARRATIVE]\n${ragText}\n\n`;
        }

        return context.trim();
    }

    private async getGraphContext(query: string, maxNodes: number, maxEdges: number, emotion: string, intensity: number): Promise<string> {
        try {
            const result = await this.mcp.callTool('tala-memory-graph', 'retrieve_context', {
                query,
                max_nodes: maxNodes,
                max_edges: maxEdges,
                emotion,
                intensity
            });
            if (result?.content) {
                return result.content.map((c: any) => c.text || '').join('\n').trim();
            }
        } catch (e) {
            console.warn('[HybridMemoryManager] Graph query failed:', e);
        }
        return "";
    }
}
