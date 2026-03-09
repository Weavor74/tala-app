/**
 * DocChunk - A discrete fragment of documentation.
 * 
 * Chunks are the unit of retrieval for the intelligence layer. 
 * They represent a single section (heading + content) from a markdown file.
 */
export interface DocChunk {
    /** Unique identifier for the chunk (e.g., 'path_to_file#heading'). */
    id: string;
    /** The actual text content of the section. */
    content: string;
    /** The title of the specific heading. */
    heading: string;
    /** The level of the heading (1 for #, 2 for ##, etc.). */
    level: number;
    /** Relative path to the source document. */
    filePath: string;
    /** Character-level start and end positions in the source file. */
    range: { start: number; end: number };
}

/**
 * DocumentationChunker - Markdown Decomposition Utility
 * 
 * Splits markdown documentation into structured chunks based on heading levels.
 * Each chunk retains its hierarchy and source coordinates for precise retrieval.
 */
export class DocumentationChunker {
    /**
     * Splits a markdown string into Documentation Chunks.
     * 
     * **Strategy:**
     * - Searches for markdown heading patterns (`#`, `##`, `###`).
     * - Treats everything between headings as the content of the preceding heading.
     * - Includes the heading text itself in the chunk content for vector/search relevance.
     */
    public static chunk(content: string, filePath: string): DocChunk[] {
        const chunks: DocChunk[] = [];
        const lines = content.split('\n');

        let currentHeading = 'Overview';
        let currentLevel = 0;
        let currentLines: string[] = [];
        let startLine = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

            if (headingMatch) {
                // Save previous chunk
                if (currentLines.length > 0) {
                    chunks.push({
                        id: `${filePath}#${this.slugify(currentHeading)}`,
                        heading: currentHeading,
                        level: currentLevel,
                        content: currentLines.join('\n').trim(),
                        filePath,
                        range: { start: startLine, end: i }
                    });
                }

                // Start new chunk
                currentHeading = headingMatch[2].trim();
                currentLevel = headingMatch[1].length;
                currentLines = [line]; // Include heading in content
                startLine = i;
            } else {
                currentLines.push(line);
            }
        }

        // Final chunk
        if (currentLines.length > 0) {
            chunks.push({
                id: `${filePath}#${this.slugify(currentHeading)}`,
                heading: currentHeading,
                level: currentLevel,
                content: currentLines.join('\n').trim(),
                filePath,
                range: { start: startLine, end: lines.length }
            });
        }

        return chunks;
    }

    /** Helper to create URL-friendly identifiers from headings. */
    private static slugify(text: string): string {
        return text.toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
    }
}
