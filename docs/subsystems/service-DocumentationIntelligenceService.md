# Service: DocumentationIntelligenceService.ts

**Source**: [electron/services/DocumentationIntelligenceService.ts](../../electron/services/DocumentationIntelligenceService.ts)

## Class: `DocumentationIntelligenceService`

## Overview
DocumentationIntelligenceService - Knowledge Orchestrator
 
 This service provides the primary interface for TALA to access project-level documentation.
 It manages the lifecycle of the documentation index (loading/rebuilding) 
 and provides high-level context retrieval methods for the agentic loop.

### Methods

#### `ignite`
Initializes the service by loading or rebuilding the documentation index.
 
 **Flow:**
 - Attempts to load an existing index from disk (`data/docs_index/docs.json`).
 - If no index is found, triggers a full rebuild (crawl/classify/chunk).
 - Instantiates the `DocumentationRetriever` with the loaded index.
/

**Arguments**: ``
**Returns**: `Promise<void>`

---
#### `refresh`
Rebuilds the documentation index on-demand.
/

**Arguments**: ``
**Returns**: `Promise<void>`

---
#### `getRelevantContext`
Retrieves relevant documentation context formatted for LLM prompts.
 
 **Integration Detail:**
 - Returns an empty string if no relevant documentation is found.
 - Prefixes each block with a clear reference header (`[DOCUMENTATION: path]`).
 - Encapsulates raw content within the structured block template.
 
 @param query - The user query or intent string.
 @returns A string of documentation context blocks, or an empty string.
/

**Arguments**: `query: string`
**Returns**: `string`

---
#### `getStatus`
Diagnostic method to inspect the current index status.
/

**Arguments**: ``
**Returns**: ``

---
