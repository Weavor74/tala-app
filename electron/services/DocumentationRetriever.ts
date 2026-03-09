import { DocIndex, IndexedDoc } from './DocumentationIndexer';
import { DocChunk } from './DocumentationChunker';
import { DocMetadata } from './DocumentationClassifier';

/**
 * RetrievalResult - A scored and ranked document chunk.
 */
export interface RetrievalResult {
    /** The retrieved chunk of documentation. */
    chunk: DocChunk;
    /** Metadata from the parent document. */
    metadata: DocMetadata;
    /** The calculated relevance score. */
    score: number;
}

/**
 * DocumentationRetriever - Search and Relevance Service
 * 
 * Provides a deterministic keyword-based indexing/search layer for TALA's internal docs.
 * scoring is based on term frequency in headings and content, weighted 
 * by the document's authority and priority.
 */
export class DocumentationRetriever {
    private index: DocIndex;

    constructor(index: DocIndex) {
        this.index = index;
    }

    /**
     * Searches for relevant documentation chunks based on a query.
     * 
     * **Strategy:**
     * - Tokenizes the query into keywords (ignoring short stopwords).
     * - Iterates over all indexed `DocChunk`s.
     * - Calculates a score based on heading matches, content matches, and metadata.
     * 
     * @param query - The user or agent query string.
     * @param limit - Maximum number of chunks to return (default: 5).
     */
    public search(query: string, limit: number = 5): RetrievalResult[] {
        const keywords = query.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter(k => k.length > 2); // Filter short words

        if (keywords.length === 0) return [];

        const results: RetrievalResult[] = [];

        for (const doc of this.index.documents) {
            for (const chunk of doc.chunks) {
                const score = this.calculateScore(chunk, doc.metadata, keywords);
                if (score > 0) {
                    results.push({
                        chunk,
                        metadata: doc.metadata,
                        score
                    });
                }
            }
        }

        // Sort by score descending and take top N
        return results.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    /**
     * Calculates the relevance score for a single chunk.
     * 
     * **Multipliers:**
     * - Heading Match: 3x
     * - Content Match: 1x
     * - Priority (high): 1.5x
     * - Authority: 1.0x to 2.0x
     */
    private calculateScore(chunk: DocChunk, meta: DocMetadata, keywords: string[]): number {
        let score = 0;
        const heading = chunk.heading.toLowerCase();
        const content = chunk.content.toLowerCase();

        for (const word of keywords) {
            // Check heading
            if (heading.includes(word)) {
                score += 30;
            }
            // Check content
            if (content.includes(word)) {
                // Approximate term frequency
                const count = (content.split(word).length - 1);
                score += Math.min(count * 2, 20); // Cap content matches to avoid spam
            }
        }

        if (score === 0) return 0;

        // Apply metadata multipliers
        const priorityMult = meta.priority === 'high' ? 1.5 : (meta.priority === 'low' ? 0.7 : 1.0);
        const authorityMult = 1.0 + (meta.authority * 1.0); // 1.0 to 2.0

        return score * priorityMult * authorityMult;
    }
}
