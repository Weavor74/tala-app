# Service: DocumentationRetriever.ts

**Source**: [electron\services\DocumentationRetriever.ts](../../electron/services/DocumentationRetriever.ts)

## Class: `DocumentationRetriever`

## Overview
RetrievalResult - A scored and ranked document chunk./
export interface RetrievalResult {
    /** The retrieved chunk of documentation. */
    chunk: DocChunk;
    /** Metadata from the parent document. */
    metadata: DocMetadata;
    /** The calculated relevance score. */
    score: number;
}

/** DocumentationRetriever - Search and Relevance Service  Provides a deterministic keyword-based indexing/search layer for TALA's internal docs. scoring is based on term frequency in headings and content, weighted  by the document's authority and priority.

### Methods

#### `search`
Searches for relevant documentation chunks based on a query.  **Strategy:** - Tokenizes the query into keywords (ignoring short stopwords). - Iterates over all indexed `DocChunk`s. - Calculates a score based on heading matches, content matches, and metadata.  @param query - The user or agent query string. @param limit - Maximum number of chunks to return (default: 5)./

**Arguments**: `query: string, limit: number = 5`
**Returns**: `RetrievalResult[]`

---
#### `calculateScore`
Calculates the relevance score for a single chunk.  **Multipliers:** - Heading Match: 3x - Content Match: 1x - Priority (high): 1.5x - Authority: 1.0x to 2.0x/

**Arguments**: `chunk: DocChunk, meta: DocMetadata, keywords: string[]`
**Returns**: `number`

---
