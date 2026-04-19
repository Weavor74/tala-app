# Service: RagService.ts

**Source**: [electron\services\RagService.ts](../../electron/services/RagService.ts)

## Class: `RagService`

## Overview
Long-Term Narrative Memory Engine (RAG).  The `RagService` manages the connection to the Tala Core RAG MCP server,  providing a high-capacity vector store for document-based retrieval.  It is responsible for bridging the Electron main process with the Python-based  ChromaDB backend.  **How it differs from MemoryService:** - **RagService**: Large-scale, document-based narrative memory (ChromaDB).    Ideal for codebases, books, and logs. - **MemoryService**: High-precision, fact-based conversational memory (Mem0).    Ideal for user preferences, names, and recent decisions.  **Core Responsibilities:** - **MCP Orchestration**: Spawns and manages the `tala-core` Python process. - **Vector Retrieval**: Provides semantic search capabilities for agent grounding. - **Lifecycle Management**: Handles startup (`ignite`), search, and cleanup (`shutdown`).

### Methods

#### `runIgnitionAttempt`
**Arguments**: `pythonPath: string, scriptPath: string, envVars: Record<string, string>, startupTimeoutMs: number, slowStartGraceMs: number,`
**Returns**: `Promise<RagStartupResult>`

---
#### `establishConnection`
**Arguments**: `pythonPath: string, scriptPath: string, envVars: Record<string, string>,`
**Returns**: `Promise<Client>`

---
#### `delay`
**Arguments**: `ms: number`
**Returns**: `Promise<void>`

---
#### `updateStartupState`
**Arguments**: `state: ServiceStartupState, reason?: string`
**Returns**: `void`

---
#### `setLogViewerService`
**Arguments**: `lvs: LogViewerService`

---
#### `search`
Searches the long-term narrative memory for content relevant to the query.  Calls the `search_memory` MCP tool on the RAG server.  @param {string} query - The search query. @param {Record<string, string>} [filter] - Optional metadata filter (e.g. { category: 'roleplay' }). @returns {Promise<string>} The retrieved text content./

**Arguments**: `query: string, options?: { limit?: number, filter?: Record<string, string> }`
**Returns**: `Promise<string>`

---
#### `getReadyStatus`
Returns the current readiness status of the RAG service. @returns {boolean} True if the MCP client is connected and ready./

**Arguments**: ``
**Returns**: `boolean`

---
#### `getStartupState`
**Arguments**: ``
**Returns**: `ServiceStartupState`

---
#### `getLastStartupResult`
**Arguments**: ``
**Returns**: `RagStartupResult | null`

---
#### `logInteraction`
Logs a conversation turn to the RAG server for continuity tracking.  Sends both the user's input and the agent's response to the `log_interaction` MCP tool. The server may use this for building conversational context, extracting facts, or updating the continuity log.  Failures are silently caught — interaction logging is non-critical.  @param {string} userText - The user's input message. @param {string} agentText - The agent's response message. @returns {Promise<void>}/

**Arguments**: `userText: string, agentText: string`
**Returns**: `Promise<void>`

---
#### `ingestFile`
Ingests a single file into the RAG vector database.  @param {string} filePath - Absolute path to the file. @param {string} category - Category tag (e.g. 'roleplay', 'assistant'). Defaults to 'general'. @returns {Promise<string>} Confirmation text./

**Arguments**: `filePath: string, category: string = 'general'`
**Returns**: `Promise<string>`

---
#### `deleteFile`
Deletes a previously ingested file's chunks from the RAG vector database.  Calls the `delete_file_memory` MCP tool, which removes all vector embeddings associated with the given file path from ChromaDB.  @param {string} filePath - Absolute path of the file whose embeddings should be removed. @returns {Promise<string>} Confirmation text from the server, or an error message./

**Arguments**: `filePath: string`
**Returns**: `Promise<string>`

---
#### `waitForReady`
Waits for the RAG service to become ready, up to a specified timeout./

**Arguments**: `timeoutMs: number = 10000`
**Returns**: `Promise<boolean>`

---
#### `listIndexedFiles`
Lists all files currently indexed in the RAG vector database.  Calls the `list_indexed_files` MCP tool. Handles both single JSON-string responses (legacy) and multi-block responses (FastMCP list[str]).  @returns {Promise<string[]>} Array of absolute file paths that have been ingested./

**Arguments**: ``
**Returns**: `Promise<string[]>`

---
#### `normalizePath`
Unifies file path formatting for consistent comparison across platforms. Force Windows paths to be consistent: Upper Case Drive, Backslashes.  @param p The raw path string to normalize./

**Arguments**: `p: string`
**Returns**: `string`

---
#### `shutdown`
Shuts down the RAG service by closing the MCP client. This ensures the underlying Python process is terminated./

**Arguments**: ``
**Returns**: `Promise<void>`

---
