import { DocumentationIndexer, DocIndex } from './DocumentationIndexer';
import { DocumentationRetriever, RetrievalResult } from './DocumentationRetriever';

/**
 * DocumentationIntelligenceService - Knowledge Orchestrator
 * 
 * This service provides the primary interface for TALA to access project-level documentation.
 * It manages the lifecycle of the documentation index (loading/rebuilding) 
 * and provides high-level context retrieval methods for the agentic loop.
 */
export class DocumentationIntelligenceService {
    private indexer: DocumentationIndexer;
    private retriever: DocumentationRetriever | null = null;

    constructor(baseDir: string) {
        this.indexer = new DocumentationIndexer(baseDir);
    }

    /**
     * Initializes the service by loading or rebuilding the documentation index.
     * 
     * **Flow:**
     * - Attempts to load an existing index from disk (`data/docs_index/docs.json`).
     * - If no index is found, triggers a full rebuild (crawl/classify/chunk).
     * - Instantiates the `DocumentationRetriever` with the loaded index.
     */
    public async ignite(): Promise<void> {
        console.log('[DocIntel] Igniting Documentation Intelligence Service...');
        let index = this.indexer.load();

        if (!index) {
            console.log('[DocIntel] No index found. Performing initial build...');
            index = await this.indexer.rebuild();
        }

        this.retriever = new DocumentationRetriever(index);
        console.log('[DocIntel] Service ready.');
    }

    /**
     * Rebuilds the documentation index on-demand.
     */
    public async refresh(): Promise<void> {
        const index = await this.indexer.rebuild();
        this.retriever = new DocumentationRetriever(index);
    }

    /**
     * Retrieves relevant documentation context formatted for LLM prompts.
     * 
     * **Integration Detail:**
     * - Returns an empty string if no relevant documentation is found.
     * - Prefixes each block with a clear reference header (`[DOCUMENTATION: path]`).
     * - Encapsulates raw content within the structured block template.
     * 
     * @param query - The user query or intent string.
     * @returns A string of documentation context blocks, or an empty string.
     */
    public getRelevantContext(query: string): string {
        if (!this.retriever) {
            console.warn('[DocIntel] Retriever not initialized.');
            return '';
        }

        const results = this.retriever.search(query, 3); // Limit to top 3 for prompt brevity
        if (results.length === 0) return '';

        const contextBlocks = results.map(res => {
            const path = res.chunk.filePath;
            const content = res.chunk.content;
            return `[DOCUMENTATION: ${path}]\n${content}`;
        });

        return `[PROJECT DOCUMENTATION CONTEXT]\n${contextBlocks.join('\n\n')}`;
    }

    /**
     * Diagnostic method to inspect the current index status.
     */
    public getStatus(): { indexedDocs: number; generatedAt?: string } {
        const index = this.indexer.load();
        return {
            indexedDocs: index?.documents.length || 0,
            generatedAt: index?.generatedAt
        };
    }
}
