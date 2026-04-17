# Service: ToolService.ts

**Source**: [electron\services\ToolService.ts](../../electron/services/ToolService.ts)

## Class: `ToolService`

## Overview
Standardized execution result for all tools. Supports deterministic execution bypassing the LLM./
export interface ToolResult {
    /** The actual text content or data returned by the tool. */
    result: string;
    /** If false, the agent should NOT feed this output back to the LLM and should just render it to the user. */
    requires_llm: boolean;
    /** Optional images for vision-capable tools */
    images?: string[];
    /** Whether the operation was a success or failure */
    success?: boolean;
}

/** Defines the shape of a tool that can be registered with the ToolService.  Tools are exposed to the AI brain as callable functions. Each tool has a name, description, JSON Schema parameters, and an async execute function./
export interface ToolDefinition {
    /** Unique tool name used by the AI to invoke it (e.g., `'write_file'`, `'browse'`). */
    name: string;
    /** Human-readable description injected into the system prompt to help the AI decide when to use this tool. */
    description: string;
    /** JSON Schema object describing the expected input arguments. */
    parameters: any;
    /** The async function that executes the tool's logic. Returns a standardized ToolResult. */
    execute: (args: any) => Promise<ToolResult | string>;
}

/** Tool Registry Service  This service manages the lifecycle of all AI-executable tools. It handles: - **Core Tools**: File I/O, Browser automation, Terminal interaction. - **Service Tools**: Memory graph, Astro emotion engine, RAG search. - **MCP Tools**: Dynamic tool discovery from external MCP servers.  Each tool follows the OpenAI `function` schema format.

### Methods

#### `getToolDefinition`
**Arguments**: `name: string`
**Returns**: `ToolDefinition | undefined`

---
#### `setSystemInfo`
Injects the system environment info (detected by `SystemService`) so tools like `execute_script` can locate the correct Python/Node executables.  @param {any} info - SystemInfo object with `pythonPath`, `pythonEnvPath`, `nodePath`, etc./

**Arguments**: `info: any`

---
#### `setGoalManager`
Injects the GoalManager dependency for planning and roadmap tools./

**Arguments**: `goalManager: any`

---
#### `setReflectionService`
Injects the ReflectionService dependency and registers the `reflection_clean` tool.  @param {any} reflection - The ReflectionService instance./

**Arguments**: `reflection: any`

---
#### `getWorkspaceDir`
Returns the current workspace root directory./

**Arguments**: ``
**Returns**: `string`

---
#### `setRoot`
Updates the workspace root for file I/O tools.  Called when the user changes their active workspace directory. All file operations are sandboxed within this directory.  @param {string} newRoot - New absolute path to the workspace root./

**Arguments**: `newRoot: string`

---
#### `setMemoryService`
Injects the MemoryService dependency and registers memory + desktop tools.  Registers five tools: - `mem0_search` — Searches long-term memory (semantic or keyword). - `mem0_add` — Stores a new fact/memory. - `mem0_get_recent` — Retrieves the N most recent memories. - `desktop_screenshot` — Captures a screenshot of the primary display. - `desktop_input` — Controls mouse/keyboard via PowerShell.  @param {any} memory - The MemoryService instance. @param {Function} [getCanonicalId] - Optional P7A authority callback.   Called before every durable mem0_add write to obtain a canonical_memory_id   from MemoryAuthorityService. When provided, derived writes will be anchored.   When absent, writes proceed but are flagged by the MemoryService P7A guard./

**Arguments**: `memory: any, getCanonicalId?: (text: string, sourceKind: string) => Promise<string | null>,`

---
#### `registerCoreTools`
Registers the foundational toolset for the agent.  **Tool Categories:** - **FileSystem**: `fs_read_text`, `fs_write_text`, `fs_list`. - **Browser**: `browser_open`, `browser_action`. - **Terminal**: `shell_run`, `shell_interactive`. - **RAG**: `rag_search`./

**Arguments**: ``

---
#### `register`
Registers a new tool, making it available to the AI agent.  If a tool with the same name is already registered, it is overwritten.  @param {ToolDefinition} tool - The tool definition to register./

**Arguments**: `tool: ToolDefinition`

---
#### `setGitService`
Injects the GitService dependency./

**Arguments**: `git: any`

---
#### `setMcpService`
Injects the McpService dependency./

**Arguments**: `mcp: any`

---
#### `setMcpAuthority`
Injects the MCP authority service. When present, MCP capability exposure is sourced only from approved authority snapshots./

**Arguments**: `authority: McpAuthorityService`

---
#### `refreshMcpTools`
Refreshes the list of available MCP tools from all connected servers. This should be called whenever MCP connections change./

**Arguments**: ``

---
#### `getRegistryVersion`
**Arguments**: ``
**Returns**: `number`

---
#### `invalidateCache`
**Arguments**: ``

---
#### `getToolSchemas`
Generates a formatted string describing all registered tools and their JSON Schema parameters. This string is injected into the system prompt so the AI knows what tools are available.  @returns {string} Multi-line string with tool names, descriptions, and parameter schemas./

**Arguments**: ``
**Returns**: `string`

---
#### `getToolSignatures`
**Arguments**: ``
**Returns**: `string`

---
#### `hasTool`
Checks if a tool with the given name is registered.  @param {string} name - The tool name to check. @returns {boolean} `true` if the tool exists./

**Arguments**: `name: string`
**Returns**: `boolean`

---
#### `makeStrictSchema`
Recursively rewrites a JSON schema to comply with OpenAI's Strict Structured Outputs (GBNF). Enforces `additionalProperties: false` on all objects and explicitly lists all properties in `required`.  @param schema - The raw JSON Schema to transform. @param seen - Recursion guard for cyclic structures. @returns A strict, compatible JSON Schema./

**Arguments**: `schema: any, seen = new WeakSet()`
**Returns**: `any`

---
#### `getToolDefinitions`
Returns tool definitions in the format expected by OpenAI/Ollama APIs. Supports grouping based on TurnContext allowedCapabilities array. @param {string[]} [allowedCapabilities] - Optional list: ['memory_retrieval', 'memory_write', 'system_core', 'diagnostic', 'all'] @returns {Array<{ type: 'function', function: { name: string, description: string, parameters: any, strict?: boolean } }>}/

**Arguments**: `allowedCapabilities?: string[], mode: string = 'assistant'`

---
#### `getAllTools`
Returns a simple list of all tool names and descriptions. Used by the UI for tool selection dropdowns. @returns {Array<{ name: string, description: string, source: string }>}/

**Arguments**: ``

---
#### `executeTool`
@param name - The tool name as identified by the Brain. @param args - The arguments parsed from the Brain's response. @param allowedNames - Optional runtime allowlist from AgentService./

**Arguments**: `name: string, args: any, allowedNames?: ReadonlySet<string>`
**Returns**: `Promise<any>`

---
