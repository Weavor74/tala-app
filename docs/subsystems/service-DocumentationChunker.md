# Service: DocumentationChunker.ts

**Source**: [electron\services\DocumentationChunker.ts](../../electron/services/DocumentationChunker.ts)

## Class: `DocumentationChunker`

## Overview
DocChunk - A discrete fragment of documentation.  Chunks are the unit of retrieval for the intelligence layer.  They represent a single section (heading + content) from a markdown file./
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

/** DocumentationChunker - Markdown Decomposition Utility  Splits markdown documentation into structured chunks based on heading levels. Each chunk retains its hierarchy and source coordinates for precise retrieval.

### Methods

