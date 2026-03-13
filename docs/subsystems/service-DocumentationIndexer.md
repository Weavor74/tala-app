# Service: DocumentationIndexer.ts

**Source**: [electron\services\DocumentationIndexer.ts](../../electron/services/DocumentationIndexer.ts)

## Class: `DocumentationIndexer`

## Overview
IndexedDoc - Result of processing a single documentation file./
export interface IndexedDoc {
    /** The inferred metadata for the document. */
    metadata: DocMetadata;
    /** The array of chunks derived from document content. */
    chunks: DocChunk[];
    /** Original file metadata. */
    fileInfo: {
        path: string;
        mtime: number;
        size: number;
    };
}

/** DocIndex - The complete serialized documentation model./
export interface DocIndex {
    /** Index version for schema migration (e.g., '1.0'). */
    version: string;
    /** Timestamp of the last successful crawl. */
    generatedAt: string;
    /** Comprehensive list of indexed documents. */
    documents: IndexedDoc[];
}

/** DocumentationIndexer - Knowledge Aggregation Service  Responsible for crawling the local filesystem, processing markdown files,  and generating a structured index for the Documentation Retrieval layer.

### Methods

#### `rebuild`
Performs a full crawl and index generation.  **Process:** 1. Initializes the `data/docs_index/` directory. 2. Recursively walks the `docs/` folder for .md files. 3. For each file: Classifies (metadata) -> Read -> Chunk (decomposition). 4. Serializes the combined `DocIndex` to disk./

**Arguments**: ``
**Returns**: `Promise<DocIndex>`

---
#### `load`
Loads the existing index from disk if available./

**Arguments**: ``
**Returns**: `DocIndex | null`

---
#### `walkSync`
**Arguments**: `dir: string, callback: (path: string) => void`

---
