# Service: AgentService.ts

**Source**: [electron/services/AgentService.ts](../../electron/services/AgentService.ts)

## Class: `AgentService`

## Overview
AgentService

 The central orchestrator that governs the "Mind" of Tala. This service
 coordinates all AI capabilities: inference (brain), memory, RAG, emotion
 (astro), tool execution, backup, and browser/terminal interaction.
 
 **Core Responsibilities:**
 - **Session Management**: Manages chat history, branching, and persistence.
 - **Turn Execution**: Orchestrates the multi-turn loop (Thought -> Action -> Observation).
 - **Context Assembly**: Gathers data from RAG, Memory, and System state for prompts.
 - **Tooling**: Registers and executes local and MCP-based tools.
 - **Self-Evolutuon**: Interfaces with ReflectionService for self-improvement goals.

### Methods

#### `setLogViewerService`
**Arguments**: `lvs: LogViewerService`

---
#### `setCodeControl`
**Arguments**: `codeControl: any`

---
#### `registerCodeTools`
**Arguments**: ``

---
#### `setMcpService`
**Arguments**: `mcp: McpServiceLike`

---
#### `setMcpAuthority`
**Arguments**: `authority: McpAuthorityService`
**Returns**: `void`

---
#### `setDiagnosticsAggregator`
Wires the runtime diagnostics aggregator so cognitive contexts can be recorded
 after each turn (Phase 3A: Live Cognitive Path Integration).
/

**Arguments**: `agg: RuntimeDiagnosticsAggregator`
**Returns**: `void`

---
#### `setGitService`
**Arguments**: `git: unknown`

---
#### `setReflectionService`
**Arguments**: `reflection: ReflectionServiceLike`

---
#### `refreshMcpTools`
**Arguments**: ``

---
#### `setMainWindow`
**Arguments**: `window: unknown`

---
#### `generateId`
**Arguments**: ``
**Returns**: `string`

---
#### `migrateLegacyHistory`
**Arguments**: ``

---
#### `listSessions`
**Arguments**: ``
**Returns**: `Array<`

---
#### `loadSessionById`
**Arguments**: `id: string`

---
#### `loadSession`
**Arguments**: `id: string`
**Returns**: `ChatMessage[]`

---
#### `newSession`
**Arguments**: ``
**Returns**: `string`

---
#### `deleteSession`
**Arguments**: `id: string`

---
#### `exportSession`
**Arguments**: `format: 'markdown' | 'json' = 'markdown', sessionId?: string`
**Returns**: `string`

---
#### `exportAgentToPython`
**Arguments**: `profileId: string, outputDir: string`
**Returns**: `Promise<boolean>`

---
#### `saveSession`
**Arguments**: ``

---
#### `branchSession`
**Arguments**: `sourceId: string, messageIndex: number`
**Returns**: `string | null`

---
#### `getChatHistory`
**Arguments**: ``
**Returns**: `Array<`

---
#### `clearChatHistory`
**Arguments**: ``

---
#### `cancelChat`
**Arguments**: ``

---
#### `detectToolIntent`
**Arguments**: `userMessage: string`
**Returns**: `string`

---
#### `getToolTimeout`
**Arguments**: `toolName: string`
**Returns**: `number`

---
#### `estimateTokens`
**Arguments**: `text: string`
**Returns**: `number`

---
#### `truncateHistory`
**Arguments**: `messages: ChatMessage[], maxTokens: number`
**Returns**: `ChatMessage[]`

---
#### `reloadConfig`
**Arguments**: ``

---
#### `setSystemInfo`
**Arguments**: `info: any`

---
#### `setWorkspaceRoot`
**Arguments**: `root: string`

---
#### `loadBrainConfig`
**Arguments**: ``

---
#### `_resolvePreferredProviderFromSettings`
**Arguments**: `inferenceSettings: any, instances: any[]`
**Returns**: ``

---
#### `_mapInstanceToProviderId`
**Arguments**: `instance: any, inferenceSettings: any`
**Returns**: `string | undefined`

---
#### `_resolveEmbeddedModelPath`
**Arguments**: `inferenceSettings: any`
**Returns**: `string | undefined`

---
#### `getActiveInstance`
**Arguments**: ``

---
#### `igniteSoul`
Initializes the "Soul" (Python-based sidecar microservices).
 
 This method:
 1. Resolves the correct Python environment (canonical/sandboxed).
 2. Sanitizes environment variables and injects User Identity.
 3. Orchestrates parallel ignition of MCP servers (Tala Core, Mem0, Astro, World).
 4. Establishes the Memory Graph connection via stdio.
 5. Handles LTMF (Long-Term Memory Format) migrations.
 6. Starts background loops like auto-ingestion and health checks.
 
 @param pythonPath - Path to the local Python binary used for bootstrapping.
/

**Arguments**: `pythonPath: string`

---
#### `shutdown`
Gracefully shuts down all active MCP sidecars and local inference engines.
/

**Arguments**: ``

---
#### `_wireRepairExecutor`
Wires the MemoryRepairExecutionService singleton with live handlers that
 perform real subsystem operations.  Called once at the end of igniteSoul()
 after all dependent services are ready.

 Handler mapping:
  reconnect_canonical — shutdown + re-init canonical PostgreSQL store
  reinit_canonical    — same as reconnect_canonical (full teardown + reinit)
  reconnect_mem0      — shutdown + re-ignite mem0 MCP server
  re_resolve_providers — re-run MemoryProviderResolver and update MemoryService config
  reconnect_graph     — disconnect + reconnect tala-memory-graph via McpService
  reconnect_rag       — shutdown + re-ignite tala-core RAG server

 drain_deferred_work is wired via DeferredMemoryReplayService.drain() which
 replays bounded batches of persisted work items when canonical is healthy.
/

**Arguments**: ``
**Returns**: `void`

---
#### `syncAstroProfiles`
**Arguments**: ``

---
#### `syncUserProfileAstro`
**Arguments**: ``

---
#### `stripPIIFromDebug`
Helper to redact PII from error objects or debug logs.
/

**Arguments**: `obj: any`
**Returns**: `any`

---
#### `parseToolArguments`
**Arguments**: `toolName: string, rawArgs: any`
**Returns**: `any`

---
#### `validateToolArguments`
**Arguments**: `name: string, args: any`

---
#### `extractJsonObjectEnvelope`
extractJsonObjectEnvelope

 Robustly extracts the first JSON object containing a top-level "tool_calls" key
 from a string that may have prose before/after it.

 Algorithm:
  1. Scan the string character-by-character with a brace-depth counter.
  2. At depth-zero, each '{' starts a candidate object. Track its start index.
  3. The matching '}' (depth returns to 0) is the end of that candidate.
  4. Attempt JSON.parse on each candidate. If it has tool_calls -> return it.
  5. If no candidate parses with tool_calls, return null.

 This is tolerant of:
  - Surrounding prose before/after the JSON object
  - Nested JSON objects/arrays inside the tool_calls
  - Multiple JSON objects in the text (picks the one with tool_calls)
  - Strings containing '{' or '}' (we skip inside string literals)
/

**Arguments**: `text: string`
**Returns**: `any | null`

---
#### `getAstroState`
**Arguments**: `settings?: any`
**Returns**: `Promise<string>`

---
#### `scanLocalModels`
**Arguments**: ``
**Returns**: `Promise<any[]>`

---
#### `detectGreetingIntent`
**Arguments**: `text: string`
**Returns**: ``

---
#### `chat`
Primary chat entry point. Orchestrates the turn loop and artifact routing.
/

**Arguments**: `userMessage: string, onToken?: (token: string) => void, onEvent?: (type: string, data: any) => void, images?: string[], capabilitiesOverride?: any`
**Returns**: `Promise<AgentTurnOutput>`

---
#### `createChatExecutionSpineAgent`
**Arguments**: ``
**Returns**: `ChatExecutionSpineAgent`

---
#### `completeToolOnlyTurn`
**Arguments**: `result: ToolResult, turnId: string, intent: string, activeMode: string, toolName: string, args: any, toolStartTime: number, chatStartedAt: number, onToken?: (token: string) => void, onEvent?: (type: string, data: any) => void`
**Returns**: `Promise<AgentTurnOutput>`

---
#### `finalizeAssistantContent`
**Arguments**: `intent: string, raw: string, executedToolCount: number, hasPendingCalls: boolean, mode: string = 'assistant'`
**Returns**: `string`

---
#### `scrubRawToolJson`
**Arguments**: `text: string, mode: string = 'assistant', intent: string = 'conversation'`
**Returns**: `string`

---
#### `normalizeToLegacyToolCalls`
Converts a CanonicalToolCall array into the legacy ToolCall format expected by
 ChatMessage.tool_calls.  This is the sole compatibility boundary between the
 canonical inference layer (CanonicalToolCall, id optional) and the legacy brain
 protocol (ToolCall, id required).

 - Guarantees every entry has a non-empty id.
 - Sets type to 'function'.
 - Stringifies arguments when they are a parsed object.
/

**Arguments**: `calls: CanonicalToolCall[]`
**Returns**: `ToolCall[]`

---
#### `commitAssistantMessage`
**Arguments**: `transientMessages: ChatMessage[], msg: ChatMessage, intent: string, executedToolCount: number, turnSeenHashes: Set<string>, mode: string = 'assistant'`
**Returns**: `void`

---
#### `scrubSecrets`
**Arguments**: `text: string`
**Returns**: `string`

---
#### `getGroundedExecutionSummary`
**Arguments**: ``
**Returns**: `string`

---
#### `streamWithBrain`
**Arguments**: `brain: IBrain, messages: any[], systemPrompt: string, onChunk: (token: string) => void, signal: AbortSignal | undefined, tools: any[], options: any`

---
#### `recordTokenUsage`
**Arguments**: `tokens: number`

---
#### `waitForBrowserData`
**Arguments**: `type: string, retryEmit?: () => void`
**Returns**: `Promise<string>`

---
#### `provideBrowserData`
**Arguments**: `type: string, data: any`

---
#### `dispatchBrowserCommand`
**Arguments**: `rawResult: string, onEvent: (type: string, data: any) => void`
**Returns**: `Promise<string>`

---
#### `headlessInference`
**Arguments**: `prompt: string, config?: any`
**Returns**: `Promise<string>`

---
#### `executeTool`
Executes a registered tool by name with provided arguments.
 
 **Safety & Security:**
 - Enforces workspace sandboxing for all file system tools.
 - Proxies MCP tool calls to the `McpService` sidecar.
 - Redacts sensitive data in audit logs.
 
 @param name - The tool name.
 @param args - Key-value pair arguments for the tool.
 @returns The stringified result of the tool execution.
/

**Arguments**: `name: string, args: any`
**Returns**: `Promise<any>`

---
#### `performSearch`
**Arguments**: `query: string`
**Returns**: `Promise<any[]>`

---
#### `pruneMemory`
**Arguments**: `ttlDays: number, maxItems: number`

---
#### `ingestFile`
**Arguments**: `p: string`

---
#### `deleteFile`
**Arguments**: `p: string`

---
#### `scanAndIngest`
**Arguments**: ``

---
#### `listIndexedFiles`
**Arguments**: ``

---
#### `getMemoryOperatorReviewModel`
Assemble and return the current MemoryOperatorReviewModel for the
 operator review surface in the Reflection Dashboard.

 Read-only and safe to call repeatedly.  Returns a bounded, advisory-only
 snapshot; no settings or configurations are changed.
/

**Arguments**: ``
**Returns**: `Promise<MemoryOperatorReviewModel>`

---
#### `runMemoryMaintenanceNow`
Trigger an immediate memory maintenance analytics run (manual refresh).

 Equivalent to a human-requested scheduler tick — does not change any
 settings or configurations.  Safe to call from the operator review panel.

 Returns the run result, or null if the scheduler is not available.
/

**Arguments**: ``
**Returns**: `Promise<import('../../shared/memory/MemoryMaintenanceState').MemoryRepairScheduledRunResult | null>`

---
#### `rewindChat`
**Arguments**: `index: number`

---
#### `setActiveNotebookContext`
**Arguments**: `id: string | null, sourcePaths: string[]`

---
#### `getAllTools`
**Arguments**: ``

---
#### `extractToolCallsFromText`
**Arguments**: `text: string`
**Returns**: `any[]`

---
#### `getReflectionSummary`
**Arguments**: ``
**Returns**: `string`

---
#### `getStartupStatus`
**Arguments**: ``

---
#### `getAstroService`
Returns the AstroService instance for use by backend composition roots
 (e.g. IpcRouter context:assemble handler). Returns null if not initialized.
/

**Arguments**: ``
**Returns**: `AstroService | null`

---
#### `getEmotionState`
**Arguments**: ``
**Returns**: `Promise<string>`

---
#### `getActiveMode`
**Arguments**: `settings?: any`
**Returns**: `string`

---
#### `addMemory`
**Arguments**: `text: string`

---
#### `getAllMemories`
**Arguments**: ``

---
#### `deleteMemory`
**Arguments**: `id: string`

---
#### `updateMemory`
Updates a memory item by ID.
/

**Arguments**: `id: string, text: string`

---
#### `getModelStatus`
Returns the current model status and fidelity information.
/

**Arguments**: ``

---
