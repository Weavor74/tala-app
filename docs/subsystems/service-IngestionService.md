# Service: IngestionService.ts

**Source**: [electron\services\IngestionService.ts](../../electron/services/IngestionService.ts)

## Class: `IngestionService`

## Overview
Automated Knowledge Indexing Service.  The `IngestionService` monitors the workspace `memory/` directory and  coordinates the ingestion of new documents into the RAG vector store.  It ensures that the AI's long-term memory remains synchronized with  local file changes.  **Core Responsibilities:** - **Directory Monitoring**: Scans inbox folders (e.g., `roleplay`, `assistant`)    for new `.md` or `.txt` files. - **Lifecycle Pipe**: Moves processed files to a dedicated `processed/`    directory after successful indexing. - **Background Polling**: Operates a low-priority background loop to    periodically refresh the knowledge base. - **Legacy Cleanup**: Handles archiving of deprecated memory formats.

### Methods

#### `setLogViewerService`
**Arguments**: `service: LogViewerService`
**Returns**: `void`

---
#### `setWorkspaceRoot`
Updates the workspace root and memory directory path./

**Arguments**: `root: string`
**Returns**: `void`

---
#### `setStructuredMode`
Toggles structured LTMF mode. If true, .txt files are ignored during ingestion scans./

**Arguments**: `enabled: boolean`
**Returns**: `void`

---
#### `scanAndIngest`
Executes a full synchronization scan of the memory inbox.  **Workflow:** 1. Verifies RAG baseline readiness. 2. Scans designated folders for untracked documents. 3. Moves each file to a category-specific `processed/` subdirectory. 4. Calls `RagService.ingestFile` to generate embeddings and index the content. 5. Logs performance metrics for ingestion latency.  @returns A summary of processed files and encountered errors./

**Arguments**: ``
**Returns**: `Promise<`

---
#### `startAutoIngest`
Starts a background polling loop for ingestion./

**Arguments**: `intervalMs = 300000`
**Returns**: `void`

---
#### `archiveLegacy`
Moves all legacy .txt files from processed folders to an archive directory. This prevents them from being used for retrieval while preserving the files./

**Arguments**: ``
**Returns**: `Promise<number>`

---
