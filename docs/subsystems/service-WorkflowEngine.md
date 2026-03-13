# Service: WorkflowEngine.ts

**Source**: [electron\services\WorkflowEngine.ts](../../electron/services/WorkflowEngine.ts)

## Class: `WorkflowEngine`

## Overview
Represents a single node in the visual workflow graph.  Each node has a type that determines its behavior when executed. Supported types include: `start`, `input`, `manual`, `agent`, `function`, `tool`, `http`, `email_read`, `if`, `split`, `merge`, `wait`, `guardrail`, `subworkflow`, `credential`, `memory_read`, `memory_write`, `edit_fields`, `ai_model`, and `model_config`./
interface WorkflowNode {
    /** Unique identifier for this node within the workflow graph. */
    id: string;
    /** Node type that determines execution behavior (e.g., `'agent'`, `'function'`, `'http'`). */
    type: string;
    /** Type-specific configuration data (e.g., prompt text for `agent`, URL for `http`). */
    data: any;
    /** Optional XY position for rendering in the visual editor (used by ReactFlow). */
    position?: any;
}

/** Represents a directed edge connecting two nodes in the workflow graph.  Edges define the execution flow. Source and target handles allow conditional routing (e.g., `'true'`/`'false'` handles from an `if` node, or `'item'`/`'done'` handles from a `split` node)./
interface WorkflowEdge {
    /** Unique identifier for this edge. */
    id: string;
    /** ID of the source (upstream) node. */
    source: string;
    /** ID of the target (downstream) node. */
    target: string;
    /** Optional handle name on the source node (e.g., `'true'`, `'false'`, `'done'`). */
    sourceHandle?: string;
    /** Optional handle name on the target node. */
    targetHandle?: string;
}

/** Runtime context that persists across the workflow execution.  Tracks execution history (input/output per node) and global variables that can be shared between nodes./
interface WorkflowContext {
    /** Data currently flowing through the workflow. */
    data: any;
    /** Ordered log of each node's execution with its input, output, and timestamp. */
    history: any[];
    /** Key-value store for global variables shared across nodes. */
    variables: Record<string, any>;
}

/** WorkflowEngine  Executes visual node-based workflows that are designed in the WorkflowEditor UI component. Workflows consist of nodes (actions) connected by edges (data/control flow), forming a directed acyclic graph (DAG).  **Execution model:** Uses BFS (breadth-first) queue traversal starting from identified trigger nodes. Each node is executed in order, with its output passed as input to downstream nodes via edges. Special node types (`if`, `split`, `guardrail`) support conditional routing through source handles.  **Supported node types:**  | Type | Description | |------|-------------| | `start` / `input` / `manual` | Trigger nodes — pass initial data | | `agent` | Sends a prompt to the AI brain via headless inference | | `function` | Executes a local Python/JS function via FunctionService | | `tool` | Executes an MCP tool via AgentService | | `http` | Makes an HTTP request (GET, POST, etc.) | | `email_read` | Reads emails via IMAP (ImapFlow) | | `if` | Conditional branching (evaluates a JS expression) | | `split` | Fans out an array into per-item executions | | `merge` | Converges multiple paths (pass-through) | | `wait` | Pauses execution for a specified duration | | `guardrail` | Content safety check via AI inference | | `subworkflow` | Recursively executes another workflow file | | `credential` | Reads a secret from the app settings vault | | `memory_read` | Searches long-term memory via mem0 | | `memory_write` | Stores data into long-term memory | | `edit_fields` | Merges extra fields into the flowing data | | `ai_model` | Passes model configuration downstream |  **Safety:** Execution is capped at 100 steps to prevent infinite loops.  @example ```typescript const engine = new WorkflowEngine(functionService, agentService); const result = await engine.executeWorkflow({ nodes, edges }); console.log(result.logs); ```

### Methods

#### `setDebugCallback`
**Arguments**: `cb: (workflowId: string, event: string, data: any) => void`

---
#### `startDebug`
Initializes a new debug session for a workflow.  Resets the execution context and populates the queue with the  identified start nodes. Subsequent steps can be triggered using `step()`.  @param workflow - The full workflow definition to debug. @param initialInput - Data to pass to the first node(s)./

**Arguments**: `workflow: any, initialInput: any = {}`

---
#### `step`
Executes the next node in the debug queue.  **Workflow:** 1. Pops the next node-input pair from the session queue. 2. Executes the node using `executeNode()`. 3. Logs the output and updates the session history. 4. Identifies and pushes downstream nodes into the queue. 5. Emits events for UI synchronization.  @param workflowId - The ID of the workflow in debug mode. @throws Error if no active debug session is found./

**Arguments**: `workflowId: string`

---
#### `stopDebug`
**Arguments**: `workflowId: string`

---
#### `emitDebugUpdate`
**Arguments**: `id: string, event: string, data: any`

---
#### `executeWorkflow`
Executes a complete workflow from start to finish.  **Algorithm:** 1. Builds an adjacency list from edges. 2. Identifies start/trigger nodes (by type or by having no incoming edges). 3. Processes nodes in BFS order via a queue. 4. For each node, calls `executeNode()` and routes the output to    downstream nodes based on edge connections and active handles. 5. Special `split` nodes fan out array items to per-item executions,    with a separate `'done'` handle for the aggregate result.  Execution halts on errors (thrown from individual nodes) or after exceeding 100 steps (safety limit against infinite loops).  @param {{ nodes: WorkflowNode[], edges: WorkflowEdge[] }} workflow - The workflow definition. @param {string} [startNodeId] - Optional specific node ID to start from.   If omitted, auto-detects trigger nodes. @returns {Promise<{ success: boolean, logs: string[], context?: WorkflowContext, error?: string }>}   Execution result with timestamped logs, context history, and optional error./

**Arguments**: `workflow: { nodes: WorkflowNode[], edges: WorkflowEdge[] }, startNodeId?: string, initialInput: any = {}`

---
#### `getCredential`
Reads a credential value from the application settings vault.  Looks up the key in `app_settings.json` under `auth.keys[keyName]`, with special handling for `'cloudToken'` which is stored at `auth.cloudToken`.  @private @param {string} keyName - The credential key to look up (e.g., `'github'`, `'cloudToken'`). @returns {any} The credential value, or `null` if not found./

**Arguments**: `keyName: string`
**Returns**: `any`

---
#### `executeNode`
Executes a single workflow node and returns its output.  This is the core dispatch method that handles all node types via a `switch` statement. Each case is responsible for: - Reading configuration from `node.data` - Processing the `input` from upstream nodes - Returning `{ output: any }` (with optional `activeHandle` for routing)  **Conditional nodes** (`if`, `guardrail`) return an `activeHandle` string (e.g., `'true'`/`'false'`, `'pass'`/`'fail'`) that `executeWorkflow()` uses to decide which downstream edges to follow.  @private @param {WorkflowNode} node - The node to execute. @param {any} input - Data from the upstream node's output. @param {(msg: string) => void} log - Logging callback for execution tracing. @returns {Promise<any>} The node's output, typically `{ output: any, activeHandle?: string }`. @throws {Error} If the node encounters an unrecoverable error./

**Arguments**: `node: WorkflowNode, input: any, log: (msg: string) => void`
**Returns**: `Promise<any>`

---
