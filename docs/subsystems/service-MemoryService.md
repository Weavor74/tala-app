# Service: MemoryService.ts

**Source**: [electron\services\MemoryService.ts](../../electron/services/MemoryService.ts)

## Class: `MemoryService`

## Overview
Association Represents a link between two memory items./
export interface MemoryAssociation {
    target_id: string;
    type: 'related_to' | 'contradicts' | 'supersedes';
    weight: number;
}

/** Represents a single memory entry stored locally or retrieved from the MCP server. Memories are short-term conversational context pieces (facts, preferences, decisions) that the agent can recall during interactions./
export interface MemoryItem {
    /** Unique identifier — timestamp string for local items, 'remote' for MCP-sourced items. */
    id: string;
    /** The text content of the memory (e.g., "User prefers dark themes"). */
    text: string;
    /** Optional metadata attached to the memory (e.g., source, category, tags). */
    metadata?: any;
    /** Relevance score from search operations (0–N where higher = more relevant). */
    score?: number;
    /** Final composite score after reranking. */
    compositeScore?: number;
    /** Unix timestamp (ms) of when the memory was created. */
    timestamp: number;

    // --- ENRICHED METADATA (PHASE 1) ---
    salience: number;           // 0.0 - 1.0 (importance)
    confidence: number;         // 0.0 - 1.0 (trustworthiness)
    created_at: number;         // Unix timestamp
    last_accessed_at: number | null;
    last_reinforced_at: number | null;
    access_count: number;
    associations: MemoryAssociation[];
    status: 'active' | 'contested' | 'superseded' | 'archived';
}

/** Fact-Based Conversational Memory Engine.  The `MemoryService` provides episodic and semantic memory for the agent,  specializing in short-term facts, preferences, and state. It implements  a high-reliability dual-storage strategy.  **Architecture:** - **Primary (Remote)**: Mem0 MCP server (`mem0-core/server.py`) for AI-powered    extraction and graph-based relationships. - **Fallback (Local)**: Synchronous JSON persistence at `tala_memory.json`    for instant recovery and redundancy.  **Key Features:** - **Composite Scoring**: Reranks memories using semantic similarity,    salience, recency, and confidence. - **Contradiction Detection**: Automatically marks old facts as contested    or superseded when new information conflicts. - **Association Expansion**: Performs one-hop graph walks to retrieve    contextually related memories.

### Methods

#### `getReadyStatus`
Returns true when the MCP client is connected to the mem0-core server. Used by AgentService.getStartupStatus() to surface real mem0 readiness./

**Arguments**: ``
**Returns**: `boolean`

---
#### `setResolvedMemoryConfig`
Updates the resolved memory runtime configuration used by getHealthStatus() to evaluate extraction and embeddings provider availability. Call this from a repair handler after re-running MemoryProviderResolver so that the health evaluation reflects the freshly resolved provider state. Automatically invalidates the health cache./

**Arguments**: `config: MemoryRuntimeResolution`
**Returns**: `void`

---
#### `getHealthStatus`
Returns a structured MemoryHealthStatus by evaluating all memory subsystem components via MemoryIntegrityPolicy. Results are cached for HEALTH_STATUS_TTL_MS to avoid redundant recomputation on every turn.  The cache is automatically invalidated whenever subsystem availability, integrity mode, or resolved config changes. This is the single source of truth for memory runtime health. AgentService must call this before gating memory retrieval or writes./

**Arguments**: ``
**Returns**: `MemoryHealthStatus`

---
#### `resetDeferredWork`
Resets the deferred-work backlog counters (e.g. when the subsystem recovers and deferred work has been processed)./

**Arguments**: `opts: { extraction?: boolean; embedding?: boolean; projection?: boolean } = {}`
**Returns**: `void`

---
#### `getDeferredWorkCounts`
**Arguments**: ``
**Returns**: ``

---
#### `_invalidateHealthCache`
**Arguments**: `reason: string`
**Returns**: `void`

---
#### `_trackTransition`
**Arguments**: `status: MemoryHealthStatus`
**Returns**: `void`

---
#### `_checkBacklogThresholds`
**Arguments**: ``
**Returns**: `void`

---
#### `loadLocal`
Loads the local memory store from the JSON file on disk into the `localMemories` array.  If the file doesn't exist (first launch) or contains invalid JSON, the array is initialized to empty. This method is called once during construction and is not expected to be called again.  @private @returns {void}/

**Arguments**: ``

---
#### `normalizeMemory`
Normalizes a memory item to ensure it has all required metadata fields. This handles migration of legacy memories./

**Arguments**: `m: any`
**Returns**: `MemoryItem`

---
#### `saveLocal`
Persists the current in-memory `localMemories` array to the JSON file on disk.  Called after every `add()` operation to ensure local persistence. The file is written with pretty-printed JSON (2-space indentation) for debuggability. Write errors are caught and logged but do not throw — memory persistence failures are non-fatal.  @private @returns {void}/

**Arguments**: ``

---
#### `ignite`
Starts the embedded Mem0 MCP server and connects to it.  This is the preferred connection method, used during the application's "igniteSoul" startup sequence. It spawns the Mem0 Python server as a child process via stdio transport and establishes a bidirectional MCP connection.  If the Python executable or script file doesn't exist on disk, the method exits silently and the service falls back to local-only memory storage. If the MCP connection fails, the client is nullified and the service continues operating with local storage only.  @param {string} pythonPath - Absolute path to the Python executable   (e.g., from the project's virtual environment: `venv/Scripts/python.exe`). @param {string} scriptPath - Absolute path to the Mem0 MCP server script   (e.g., `mcp-servers/mem0-core/server.py`). @param {Record<string, string>} envVars - Additional environment variables. @param {MemoryRuntimeResolution} [resolvedConfig] - Pre-resolved memory runtime   configuration from MemoryProviderResolver.  When provided, this is serialised   to a temp file and injected into mem0-core via TALA_MEMORY_RUNTIME_CONFIG_PATH,   replacing mem0-core's own startup probing logic. @returns {Promise<void>}/

**Arguments**: `pythonPath: string, scriptPath: string, envVars: Record<string, string> = {}, resolvedConfig?: MemoryRuntimeResolution`

---
#### `connect`
Connects to an externally managed MCP memory server using a generic command.  Unlike `ignite()`, this method does not validate file paths or provide special error handling. It's a lower-level connection method for cases where the server is managed externally or uses non-standard arguments.  @param {string} command - The command to spawn (e.g., `'python'`, `'node'`). @param {string[]} args - Array of command arguments (e.g., `['server.py']`). @returns {Promise<void>}/

**Arguments**: `command: string, args: string[]`

---
#### `search`
Searches for memories relevant to the given query.  Implements a cascading search strategy:  **1. Remote Search (Preferred):** If the MCP client is connected, calls the `mem0_search` tool on the remote Mem0 server. The remote server uses semantic/vector search for high-quality results. Results are mapped to `MemoryItem` objects with `id: 'remote'`.  **2. Local Fallback:** If the remote search fails or the MCP client is not connected, falls back to a simple keyword-based search over the local memory array: - Splits the query into terms (words with length > 3 characters). - If no valid terms, returns the N most recent memories. - Otherwise, scores each memory by counting how many query terms appear in   its text (case-insensitive). - Returns the top N results sorted by score descending.  @param {string} query - The search query string (e.g., "What is the user's name?"). @param {number} [limit=5] - Maximum number of results to return. @returns {Promise<MemoryItem[]>} Array of matching memories, ordered by relevance.   Returns an empty array if no memories exist and no matches are found./

**Arguments**: `query: string, limit = 5, mode: string = 'assistant'`
**Returns**: `Promise<MemoryItem[]>`

---
#### `expandAssociations`
Expands a set of memories by one-hop associations./

**Arguments**: `seeds: MemoryItem[]`
**Returns**: ``

---
#### `calculateCompositeScore`
**Arguments**: `item: MemoryItem, semanticSimilarity: number, associationBoost: number = 0`

---
#### `calculateRecencyScore`
Calculates recency score using exponential decay./

**Arguments**: `item: MemoryItem`
**Returns**: `number`

---
#### `add`
Adds a new memory to both the local store and the remote MCP server.  The memory is always saved to the local JSON file first (for redundancy), then an attempt is made to push it to the remote Mem0 server if connected. If the remote write fails, the memory still persists locally.  A unique ID is generated using the current Unix timestamp in milliseconds.  @param {string} text - The memory text content to store   (e.g., "User prefers dark mode", "Steve's birthday is March 15"). @param {any} [metadata] - Optional metadata to attach to the memory.   Common fields include `source`, `category`, `user_id`, etc.   When sent to the remote server, metadata properties are spread into   the tool arguments alongside the text. @returns {Promise<boolean>} Always returns `true` (local write never fails fatally)./

**Arguments**: `text: string, metadata: any = {}, mode: string = 'assistant'`
**Returns**: `Promise<boolean>`

---
#### `getAll`
Retrieves all locally stored memories. @returns {Promise<MemoryItem[]>} Array of all local memory items./

**Arguments**: ``
**Returns**: `Promise<MemoryItem[]>`

---
#### `delete`
Deletes a memory item by ID. @param {string} id - The ID of the memory to delete. @returns {Promise<boolean>} True if found and deleted, false otherwise./

**Arguments**: `id: string`
**Returns**: `Promise<boolean>`

---
#### `update`
Updates the text of a memory item. @param {string} id - The ID of the memory to update. @param {string} text - The new text content. @returns {Promise<boolean>} True if found and updated, false otherwise./

**Arguments**: `id: string, text: string`
**Returns**: `Promise<boolean>`

---
#### `prune`
Prunes old memories based on TTL and max count. @param ttlDays Age in days to expire. @param maxItems Maximum number of items to keep. @returns Number of items removed./

**Arguments**: `ttlDays: number, maxItems: number`
**Returns**: `Promise<number>`

---
#### `shutdown`
Shuts down the Memory service by closing the MCP client and transport. This ensures the underlying Python process is terminated./

**Arguments**: ``
**Returns**: `Promise<void>`

---
#### `handleContradiction`
Detects and handles contradictions when a new memory is added./

**Arguments**: `newItem: MemoryItem`

---
