import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { FunctionService } from './FunctionService';
import { AgentService } from './AgentService';
import { PolicyDeniedError } from './policy/PolicyGate';
import { enforceSideEffectWithGuardrails } from './policy/PolicyEnforcement';
import { resolveStoragePath } from './PathResolver';
const { ImapFlow } = require('imapflow');

/**
 * Represents a single node in the visual workflow graph.
 * 
 * Each node has a type that determines its behavior when executed.
 * Supported types include: `start`, `input`, `manual`, `agent`, `function`,
 * `tool`, `http`, `email_read`, `if`, `split`, `merge`, `wait`,
 * `guardrail`, `subworkflow`, `credential`, `memory_read`, `memory_write`,
 * `edit_fields`, `ai_model`, and `model_config`.
 */
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

/**
 * Represents a directed edge connecting two nodes in the workflow graph.
 * 
 * Edges define the execution flow. Source and target handles allow
 * conditional routing (e.g., `'true'`/`'false'` handles from an `if` node,
 * or `'item'`/`'done'` handles from a `split` node).
 */
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

/**
 * Runtime context that persists across the workflow execution.
 * 
 * Tracks execution history (input/output per node) and global variables
 * that can be shared between nodes.
 */
interface WorkflowContext {
    /** Data currently flowing through the workflow. */
    data: any;
    /** Ordered log of each node's execution with its input, output, and timestamp. */
    history: any[];
    /** Key-value store for global variables shared across nodes. */
    variables: Record<string, any>;
}

/**
 * WorkflowEngine
 * 
 * Executes visual node-based workflows that are designed in the WorkflowEditor
 * UI component. Workflows consist of nodes (actions) connected by edges
 * (data/control flow), forming a directed acyclic graph (DAG).
 * 
 * **Execution model:**
 * Uses BFS (breadth-first) queue traversal starting from identified trigger
 * nodes. Each node is executed in order, with its output passed as input to
 * downstream nodes via edges. Special node types (`if`, `split`, `guardrail`)
 * support conditional routing through source handles.
 * 
 * **Supported node types:**
 * 
 * | Type | Description |
 * |------|-------------|
 * | `start` / `input` / `manual` | Trigger nodes — pass initial data |
 * | `agent` | Sends a prompt to the AI brain via headless inference |
 * | `function` | Executes a local Python/JS function via FunctionService |
 * | `tool` | Executes an MCP tool via AgentService |
 * | `http` | Makes an HTTP request (GET, POST, etc.) |
 * | `email_read` | Reads emails via IMAP (ImapFlow) |
 * | `if` | Conditional branching (evaluates a JS expression) |
 * | `split` | Fans out an array into per-item executions |
 * | `merge` | Converges multiple paths (pass-through) |
 * | `wait` | Pauses execution for a specified duration |
 * | `guardrail` | Content safety check via AI inference |
 * | `subworkflow` | Recursively executes another workflow file |
 * | `credential` | Reads a secret from the app settings vault |
 * | `memory_read` | Searches long-term memory via mem0 |
 * | `memory_write` | Stores data into long-term memory |
 * | `edit_fields` | Merges extra fields into the flowing data |
 * | `ai_model` | Passes model configuration downstream |
 * 
 * **Safety:** Execution is capped at 100 steps to prevent infinite loops.
 * 
 * @example
 * ```typescript
 * const engine = new WorkflowEngine(functionService, agentService);
 * const result = await engine.executeWorkflow({ nodes, edges });
 * console.log(result.logs);
 * ```
 */
export class WorkflowEngine {
    /** Reference to the FunctionService for executing local function nodes. */
    private functionService: FunctionService;
    /** Reference to the AgentService for AI inference, tool execution, and memory operations. */
    private agentService: AgentService;

    /**
     * Creates a new WorkflowEngine with the required service dependencies.
     * 
     * @param {FunctionService} functionService - For executing local `function` nodes.
     * @param {AgentService} agentService - For `agent`, `tool`, `memory_read`, `memory_write`,
     *   and `guardrail` nodes that require AI inference or tool execution.
     */
    constructor(functionService: FunctionService, agentService: AgentService) {
        this.functionService = functionService;
        this.agentService = agentService;
    }

    private debugSessions = new Map<string, {
        queue: { node: WorkflowNode, input: any }[],
        context: WorkflowContext,
        adj: Map<string, { target: string, sourceHandle?: string }[]>,
        workflow: { nodes: WorkflowNode[], edges: WorkflowNode[] }, // typing is actually WorkflowEdge[] but using any for safety
        logs: string[],
        steps: number
    }>();

    private onDebugUpdate?: (workflowId: string, event: string, data: any) => void;

    public setDebugCallback(cb: (workflowId: string, event: string, data: any) => void) {
        this.onDebugUpdate = cb;
    }

    /**
     * Initializes a new debug session for a workflow.
     * 
     * Resets the execution context and populates the queue with the 
     * identified start nodes. Subsequent steps can be triggered using `step()`.
     * 
     * @param workflow - The full workflow definition to debug.
     * @param initialInput - Data to pass to the first node(s).
     */
    public startDebug(workflow: any, initialInput: any = {}) {
        const consoleLog: string[] = [];
        const log = (msg: string) => consoleLog.push(`[${new Date().toISOString()}] ${msg}`);
        log('Starting Debug Session...');

        // Build Adjacency List
        const adj = new Map<string, { target: string, sourceHandle?: string }[]>();
        workflow.edges.forEach((edge: any) => {
            if (!adj.has(edge.source)) adj.set(edge.source, []);
            adj.get(edge.source)?.push({ target: edge.target, sourceHandle: edge.sourceHandle });
        });

        // Find Start Nodes (same logic as executeWorkflow)
        let startNodes: WorkflowNode[] = [];
        startNodes = workflow.nodes.filter((n: any) => n.type === 'start' || n.type === 'input' || (n.type === 'manual' || (n.data && n.data.triggerType === 'manual')));
        if (startNodes.length === 0) {
            const targets = new Set(workflow.edges.map((e: any) => e.target));
            startNodes = workflow.nodes.filter((n: any) => !targets.has(n.id));
        }

        const queue: { node: WorkflowNode, input: any }[] = startNodes.map((n: any) => ({ node: n, input: initialInput }));
        const context: WorkflowContext = { data: {}, history: [], variables: {} };

        this.debugSessions.set(workflow.id, {
            queue,
            context,
            adj,
            workflow,
            logs: consoleLog,
            steps: 0
        });

        this.emitDebugUpdate(workflow.id, 'started', { queueLength: queue.length });

        // Peek next node
        if (queue.length > 0) {
            this.emitDebugUpdate(workflow.id, 'next-node', { nodeId: queue[0].node.id, input: queue[0].input });
        } else {
            this.emitDebugUpdate(workflow.id, 'completed', { context, logs: consoleLog });
        }
    }

    /**
     * Executes the next node in the debug queue.
     * 
     * **Workflow:**
     * 1. Pops the next node-input pair from the session queue.
     * 2. Executes the node using `executeNode()`.
     * 3. Logs the output and updates the session history.
     * 4. Identifies and pushes downstream nodes into the queue.
     * 5. Emits events for UI synchronization.
     * 
     * @param workflowId - The ID of the workflow in debug mode.
     * @throws Error if no active debug session is found.
     */
    public async step(workflowId: string) {
        const session = this.debugSessions.get(workflowId);
        if (!session) throw new Error('No active debug session found');

        if (session.queue.length === 0) {
            this.emitDebugUpdate(workflowId, 'completed', { context: session.context, logs: session.logs });
            return;
        }

        const { node, input } = session.queue.shift()!;
        const log = (msg: string) => session.logs.push(`[${new Date().toISOString()}] ${msg}`);

        log(`DEBUG STEP: Executing ${node.type} (${node.id})`);

        try {
            let output: any = null;
            let activeOutputHandle: string | null = null;

            // Execute (reuse existing logic if possible, but executeNode is private)
            // We can call executeNode directly
            const result = await this.executeNode(node, input, log);

            if (result && typeof result === 'object' && 'output' in result) {
                output = result.output;
                if (result.activeHandle) activeOutputHandle = result.activeHandle;
            } else {
                output = result;
            }

            session.context.history.push({ nodeId: node.id, input, output, timestamp: Date.now() });

            // Next Nodes Logic (Copy-Paste from executeWorkflow mostly, or refactor)
            // Simplified for now:
            const connectedEdges = session.adj.get(node.id) || [];

            if (node.type === 'split') {
                let array = output;
                if (typeof output === 'string') {
                    try { array = JSON.parse(output); } catch (e) { }
                }
                if (!Array.isArray(array)) array = [array];

                // Done path
                connectedEdges.filter(e => e.sourceHandle === 'done').forEach(edge => {
                    const next = session.workflow.nodes.find(n => n.id === edge.target);
                    if (next) session.queue.push({ node: next, input: output });
                });

                // Item path
                const itemEdges = connectedEdges.filter(e => !e.sourceHandle || e.sourceHandle === 'default' || e.sourceHandle === 'item');
                array.forEach((item: any) => {
                    itemEdges.forEach(edge => {
                        const next = session.workflow.nodes.find(n => n.id === edge.target);
                        if (next) session.queue.push({ node: next, input: item });
                    });
                });
            } else {
                for (const edge of connectedEdges) {
                    if (activeOutputHandle && edge.sourceHandle && edge.sourceHandle !== activeOutputHandle) continue;
                    const next = session.workflow.nodes.find(n => n.id === edge.target);
                    if (next) session.queue.push({ node: next, input: output });
                }
            }

            this.emitDebugUpdate(workflowId, 'step-completed', {
                nodeId: node.id,
                output,
                logs: session.logs
            });

            // Peek next
            if (session.queue.length > 0) {
                this.emitDebugUpdate(workflowId, 'next-node', { nodeId: session.queue[0].node.id, input: session.queue[0].input });
            } else {
                this.emitDebugUpdate(workflowId, 'completed', { context: session.context, logs: session.logs });
                this.debugSessions.delete(workflowId);
            }

        } catch (e: any) {
            log(`DEBUG ERROR: ${e.message}`);
            this.emitDebugUpdate(workflowId, 'error', { error: e.message });
        }
    }

    public stopDebug(workflowId: string) {
        this.debugSessions.delete(workflowId);
    }

    private emitDebugUpdate(id: string, event: string, data: any) {
        if (this.onDebugUpdate) this.onDebugUpdate(id, event, data);
    }

    /**
     * Executes a complete workflow from start to finish.
     * 
     * **Algorithm:**
     * 1. Builds an adjacency list from edges.
     * 2. Identifies start/trigger nodes (by type or by having no incoming edges).
     * 3. Processes nodes in BFS order via a queue.
     * 4. For each node, calls `executeNode()` and routes the output to
     *    downstream nodes based on edge connections and active handles.
     * 5. Special `split` nodes fan out array items to per-item executions,
     *    with a separate `'done'` handle for the aggregate result.
     * 
     * Execution halts on errors (thrown from individual nodes) or after
     * exceeding 100 steps (safety limit against infinite loops).
     * 
     * @param {{ nodes: WorkflowNode[], edges: WorkflowEdge[] }} workflow - The workflow definition.
     * @param {string} [startNodeId] - Optional specific node ID to start from.
     *   If omitted, auto-detects trigger nodes.
     * @returns {Promise<{ success: boolean, logs: string[], context?: WorkflowContext, error?: string }>}
     *   Execution result with timestamped logs, context history, and optional error.
     */
    public async executeWorkflow(workflow: { nodes: WorkflowNode[], edges: WorkflowEdge[] }, startNodeId?: string, initialInput: any = {}, executionMode?: string) {
        const consoleLog: string[] = [];
        const log = (msg: string) => consoleLog.push(`[${new Date().toISOString()}] ${msg}`);

        log('Starting workflow execution...');

        // Build Adjacency List (Source Node -> List of Edges/Targets)
        const adj = new Map<string, { target: string, sourceHandle?: string }[]>();
        workflow.edges.forEach(edge => {
            if (!adj.has(edge.source)) adj.set(edge.source, []);
            adj.get(edge.source)?.push({ target: edge.target, sourceHandle: edge.sourceHandle });
        });

        // Find Start Node (Trigger)
        let startNodes: WorkflowNode[] = [];
        if (startNodeId) {
            const found = workflow.nodes.find(n => n.id === startNodeId);
            if (found) startNodes.push(found);
        } else {
            // Find nodes with type 'start' or 'trigger'
            startNodes = workflow.nodes.filter(n => n.type === 'start' || n.type === 'input' || (n.type === 'manual' || (n.data && n.data.triggerType === 'manual')));
            // Fallback: nodes with no incoming edges
            if (startNodes.length === 0) {
                const targets = new Set(workflow.edges.map(e => e.target));
                startNodes = workflow.nodes.filter(n => !targets.has(n.id));
            }
        }

        if (startNodes.length === 0) {
            log('Error: No start node found.');
            return { success: false, logs: consoleLog };
        }

        // BFS / Queue execution
        const queue: { node: WorkflowNode, input: any }[] = startNodes.map(n => ({ node: n, input: initialInput }));
        const context: WorkflowContext = { data: {}, history: [], variables: {} };

        try {
            // Safety break
            let steps = 0;
            const MAX_STEPS = 100;

            while (queue.length > 0) {
                if (steps++ > MAX_STEPS) {
                    log('Error: Maximum workflow steps exceeded (Loop detected?).');
                    break;
                }

                const { node, input } = queue.shift()!;

                // --- POLICY GATE: workflow step pre-check ---
                // Fires before each node is executed.
                // PolicyDeniedError propagates out of the BFS loop and is surfaced as an error.
                await enforceSideEffectWithGuardrails(
                    'workflow',
                    {
                        actionKind: 'workflow_action',
                        executionMode,
                        targetSubsystem: 'workflow',
                        mutationIntent: `node_execute:${node.type}`,
                    },
                    {
                        nodeId: node.id,
                        nodeType: node.type,
                        phase: 'pre',
                    },
                );

                // execute node
                log(`Executing node: ${node.type} (${node.id})`);
                let output: any = null;
                let activeOutputHandle: string | null = null; // null means "all handles" or "default"

                try {
                    const result = await this.executeNode(node, input, log, executionMode);
                    // Standardize result
                    if (result && typeof result === 'object' && 'output' in result) {
                        output = result.output;
                        if (result.activeHandle) activeOutputHandle = result.activeHandle;
                    } else {
                        output = result;
                    }

                    context.history.push({ nodeId: node.id, input, output, timestamp: Date.now() });

                    await enforceSideEffectWithGuardrails(
                        'workflow',
                        {
                            actionKind: 'workflow_action',
                            executionMode,
                            targetSubsystem: 'workflow',
                            mutationIntent: `node_execute:${node.type}:post`,
                        },
                        {
                            nodeId: node.id,
                            nodeType: node.type,
                            phase: 'post',
                            outputPreview: typeof output === 'string' ? output.slice(0, 512) : '[non-string]',
                        },
                    );
                } catch (e: any) {
                    log(`Error in node ${node.id}: ${e.message}`);
                    throw e; // Stop execution on error
                }

                if (node.type === 'split') {
                    // SPLIT LOGIC
                    let array = output;

                    // If output is string (e.g. from Function node), try to parse it
                    if (typeof output === 'string') {
                        try {
                            const parsed = JSON.parse(output);
                            if (Array.isArray(parsed)) array = parsed;
                        } catch (e) {
                            // Not JSON array, treat as single item array [string]
                        }
                    }

                    if (!Array.isArray(array)) array = [array];

                    log(`Split Node: Processing ${array.length} items...`);

                    const connectedEdges = adj.get(node.id) || [];

                    // Routes
                    // 'done' handle -> fires once with full array
                    // 'default'/'item' handle -> fires N times with items

                    // 1. Handle "Done" path first (single execution)
                    connectedEdges.filter(e => e.sourceHandle === 'done').forEach(edge => {
                        const nextNode = workflow.nodes.find(n => n.id === edge.target);
                        if (nextNode) {
                            queue.push({ node: nextNode, input: output }); // Pass original array
                        }
                    });

                    // 2. Handle "Item" path (N executions)
                    const itemEdges = connectedEdges.filter(e => !e.sourceHandle || e.sourceHandle === 'default' || e.sourceHandle === 'item');

                    array.forEach((item: any, index: number) => {
                        itemEdges.forEach(edge => {
                            const nextNode = workflow.nodes.find(n => n.id === edge.target);
                            if (nextNode) {
                                queue.push({ node: nextNode, input: item });
                            }
                        });
                    });

                } else {
                    // STANDARD LOGIC
                    // Find next
                    const connectedEdges = adj.get(node.id) || [];
                    for (const edge of connectedEdges) {
                        // Logic: If activeOutputHandle is set (e.g. "true" or "false"), only follow edges starting from that handle.
                        // If activeOutputHandle is null, follow all edges.

                        if (activeOutputHandle && edge.sourceHandle && edge.sourceHandle !== activeOutputHandle) {
                            continue; // Skip edges from other handles
                        }

                        const nextNode = workflow.nodes.find(n => n.id === edge.target);
                        if (nextNode) {
                            queue.push({ node: nextNode, input: output });
                        }
                    }
                }
            }
            log('Workflow execution completed.');
            return { success: true, logs: consoleLog, context };

        } catch (e: any) {
            // PolicyDeniedError is not a workflow error — re-throw so callers
            // know the workflow was blocked by policy rather than by a node failure.
            if (e instanceof PolicyDeniedError) throw e;
            log(`Workflow execution failed: ${e.message}`);
            return { success: false, logs: consoleLog, error: e.message };
        }
    }

    /**
     * Reads a credential value from the application settings vault.
     * 
     * Looks up the key in `app_settings.json` under `auth.keys[keyName]`,
     * with special handling for `'cloudToken'` which is stored at `auth.cloudToken`.
     * 
     * @private
     * @param {string} keyName - The credential key to look up (e.g., `'github'`, `'cloudToken'`).
     * @returns {any} The credential value, or `null` if not found.
     */
    private getCredential(keyName: string): any {
        try {
            const settingsPath = resolveStoragePath('app_settings.json');
            if (!fs.existsSync(settingsPath)) return null;

            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            let value = null;

            // Check top-level special keys first
            if (keyName === 'cloudToken') {
                value = settings.auth?.cloudToken;
            } else if (settings.auth?.keys) {
                value = settings.auth.keys[keyName];
            }
            return value;
        } catch (e: any) {
            console.error(`Credential Access Failed: ${e.message}`);
            return null;
        }
    }

    /**
     * Executes a single workflow node and returns its output.
     * 
     * This is the core dispatch method that handles all node types via a
     * `switch` statement. Each case is responsible for:
     * - Reading configuration from `node.data`
     * - Processing the `input` from upstream nodes
     * - Returning `{ output: any }` (with optional `activeHandle` for routing)
     * 
     * **Conditional nodes** (`if`, `guardrail`) return an `activeHandle` string
     * (e.g., `'true'`/`'false'`, `'pass'`/`'fail'`) that `executeWorkflow()`
     * uses to decide which downstream edges to follow.
     * 
     * @private
     * @param {WorkflowNode} node - The node to execute.
     * @param {any} input - Data from the upstream node's output.
     * @param {(msg: string) => void} log - Logging callback for execution tracing.
     * @returns {Promise<any>} The node's output, typically `{ output: any, activeHandle?: string }`.
     * @throws {Error} If the node encounters an unrecoverable error.
     */
    private async executeNode(node: WorkflowNode, input: any, log: (msg: string) => void, executionMode?: string): Promise<any> {
        // Global Variable / Context Injection if we had it. 
        // For now, input flows.

        switch (node.type) {
            case 'start':
            case 'input':
            case 'manual':
                return { ...input, ...node.data }; // Pass through + initial data

            case 'model_config': // Backwards compat
            case 'ai_model':
                return { output: node.data }; // Pass config downstream

            case 'merge':
                // Simple pass-through. 
                // In a real graph, this node would have multiple inputs physically. 
                // In our execution model, it just runs whenever an input hits it.
                // We return input to continue the chain.
                return { output: input };

            case 'edit_fields':
                // Set fields on input
                const fields = node.data.fields || {}; // e.g. { "topic": "AI" }
                // If fields is string (JSON), parse it
                let parsedFields = fields;
                if (typeof fields === 'string') {
                    try { parsedFields = JSON.parse(fields); } catch (e) { }
                }
                // Merge into input
                // If input is text, we can't merge. Convert to object?
                let base = typeof input === 'object' ? input : { input };
                return { ...base, ...parsedFields };

            case 'agent':
                // Ask Agent
                const inputStr = typeof input === 'string' ? input : (input.output ? (typeof input.output === 'string' ? input.output : JSON.stringify(input.output)) : JSON.stringify(input));
                const userPrompt = node.data.prompt || '';
                const finalPrompt = userPrompt ? `${userPrompt}\n\nData:\n${inputStr}` : inputStr;

                // Check if input contains config
                let modelConfig = node.data.modelConfig || null;
                // Or if input IS config (from ai_model node)
                if (input && input.output && input.output.provider) modelConfig = input.output;
                else if (input && input.provider) modelConfig = input;

                // If node has specific model override in data (not just prompt), we could use it. 
                // But for now relying on upstream config.

                log(`Agent Prompt: ${finalPrompt.substring(0, 100)}...`);

                try {
                    const response = await this.agentService.headlessInference(finalPrompt, modelConfig);
                    return { output: response };
                } catch (e: any) {
                    log(`Agent Error: ${e.message}`);
                    throw e;
                }

            case 'email_read':
                const host = node.data.host || 'imap.gmail.com';
                const port = node.data.port || 993;
                const secure = node.data.secure !== false;
                const mailbox = node.data.mailbox || 'INBOX';
                const limit = parseInt(node.data.limit) || 5;
                const credentialKey = node.data.credentialKey;

                let auth: any = { user: node.data.user, pass: node.data.pass };

                if (credentialKey) {
                    const cred = this.getCredential(credentialKey);
                    if (cred) {
                        // Support string JSON or object
                        auth = typeof cred === 'string' ? JSON.parse(cred) : cred;
                    } else {
                        throw new Error(`Credential '${credentialKey}' not found.`);
                    }
                }

                if (!auth.user || !auth.pass) throw new Error("Email credentials missing");

                log(`Connecting to IMAP ${host}:${port} (${auth.user})...`);

                const client = new ImapFlow({
                    host,
                    port,
                    secure,
                    auth,
                    logger: false
                });

                await client.connect();

                const messages: any[] = [];
                const lock = await client.getMailboxLock(mailbox);
                try {
                    // Fetch recent messages
                    // ImapFlow doesn't support "last 5" easily without knowing count.
                    // We can use status first.
                    const status = await client.status(mailbox, { messages: true });
                    const total = status.messages;
                    const startSeq = Math.max(1, total - limit + 1);

                    if (total > 0) {
                        for await (const message of client.fetch(`${startSeq}:*`, { envelope: true, source: true })) {
                            messages.push({
                                subject: message.envelope.subject,
                                from: message.envelope.from[0]?.address,
                                date: message.envelope.date,
                                body: message.source.toString()
                            });
                        }
                    }
                } finally {
                    lock.release();
                }

                await client.logout();

                // Return newest first
                messages.reverse();
                return { output: messages };

            case 'function':
                // Execute local function
                const funcName = node.data.functionName;
                if (!funcName) throw new Error('No function name specified');
                log(`Calling local function: ${funcName}`);
                // executeFunction returns string output
                const inputPayload = typeof input === 'string' ? input : JSON.stringify(input);
                const res = await this.functionService.executeFunction(funcName, [inputPayload]);
                log(`Function Output: ${res.substring(0, 50)}...`);
                return { output: res };

            case 'tool':
                // Execute MCP Tool
                const toolName = node.data.toolName;
                const argsStr = node.data.args || '{}';

                if (!toolName) throw new Error('No tool name specified');

                let args = {};
                try {
                    args = JSON.parse(argsStr);
                } catch (e) {
                    throw new Error(`Invalid JSON Arguments for tool ${toolName}`);
                }

                log(`Executing tool: ${toolName}`);
                try {
                    const toolResult = await this.agentService.executeTool(toolName, args);
                    // Extract result if simple object
                    const safeResult = toolResult && toolResult.result ? toolResult.result : JSON.stringify(toolResult);
                    return { output: safeResult };
                } catch (e: any) {
                    log(`Tool Execution Failed: ${e.message}`);
                    throw e;
                }

            case 'credential':
                const keyName = node.data.credentialKey;
                if (!keyName) throw new Error('No credential key specified');

                log(`Fetching Credential: ${keyName}`);
                const value = this.getCredential(keyName);
                if (!value) throw new Error(`Credential '${keyName}' not found in Vault.`);
                return { output: value, key: keyName };

            case 'memory_read':
                const memQuery = node.data.query || input;
                const memLimit = parseInt(node.data.limit) || 5;

                log(`Memory Read: "${memQuery}" (Limit: ${memLimit})`);

                try {
                    // Use agent tool 'mem0_search'
                    const searchResult = await this.agentService.executeTool('mem0_search', { query: memQuery, limit: memLimit });
                    // Wrapper usually returns { result: ... } or raw
                    const memories = searchResult && searchResult.result ? searchResult.result : searchResult;
                    return { output: memories };
                } catch (e: any) {
                    log(`Memory Read Failed: ${e.message}`);
                    throw e;
                }

            case 'memory_write':
                const content = node.data.content || (typeof input === 'string' ? input : JSON.stringify(input));
                const userId = node.data.user_id || 'user'; // Default to generic user if not specified

                log(`Memory Write: Saving to long-term memory...`);

                try {
                    // Use agent tool 'mem0_add'
                    // mem0_add expects: { messages: [{ role: 'user', content: ... }], user_id: ... }
                    // Or check ToolService definition.
                    // Checking ToolService.ts (from memory):
                    // execute: async (args) => memory.add(args.messages, args.user_id, args.agent_id)

                    const addResult = await this.agentService.executeTool('mem0_add', {
                        messages: [{ role: 'user', content }],
                        user_id: userId
                    });

                    return { output: addResult };
                } catch (e: any) {
                    log(`Memory Write Failed: ${e.message}`);
                    throw e;
                }

            case 'http':
                const method = node.data.method || 'GET';
                const url = node.data.url;
                if (!url) throw new Error('No URL specified');

                log(`HTTP ${method} ${url}`);

                const headers = JSON.parse(node.data.headers || '{}');
                const body = method !== 'GET' && method !== 'HEAD' ? node.data.body : undefined;

                try {
                    const response = await fetch(url, {
                        method,
                        headers,
                        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
                    });

                    const text = await response.text();
                    let json;
                    try { json = JSON.parse(text); } catch (e) { }

                    return { output: json || text, status: response.status, ok: response.ok };
                } catch (e: any) {
                    log(`HTTP Failed: ${e.message}`);
                    throw e;
                }

            case 'wait':
                const duration = parseInt(node.data.duration) || 1000;
                log(`Waiting ${duration}ms...`);
                await new Promise(resolve => setTimeout(resolve, duration));
                return { output: input }; // Pass input through after wait

            case 'if':
                // logic: if (eval(expression)) -> activeHandle = 'true', else 'false'
                const expression = node.data.expression;
                log(`Evaluating: ${expression}`);

                // Safe-ish eval using Function constructor with limited scope
                // We provide 'input' to the function scope
                try {
                    const func = new Function('input', `return ${expression}`);
                    const result = func(input);

                    log(`Condition result: ${result}`);

                    return {
                        output: input,
                        activeHandle: result ? 'true' : 'false' // Requires edge sourceHandle to match 'true' or 'false'
                    };
                } catch (e: any) {
                    log(`Condition Error: ${e.message}`);
                    throw e;
                }

            case 'split':
                // Pass input array through as output
                return { output: input };

            case 'guardrail':
                const contentToCheck = node.data.content || (typeof input === 'string' ? input : JSON.stringify(input));
                const rules = node.data.rules || 'Content must be safe.';
                const model = node.data.model || 'fast'; // fast vs smart

                log(`Guardrail Check: "${rules}"`);

                const guardPrompt = `
You are a content safety guardrail.
Rules:
${rules}

Content to Check:
${contentToCheck}

Task:
Evaluate if the content violates the rules.
Return JSON ONLY: { "passed": boolean, "reasoning": "string" }
Do not output markdown.
`;

                try {
                    // Use headless inference
                    // If model is 'fast', maybe use a smaller model if available, but for now standard agent.
                    let config = null;
                    if (model === 'fast') {
                        // potential optimization: use a configured 'fast' model instance
                    }

                    const response = await this.agentService.headlessInference(guardPrompt, config);

                    // Parse JSON
                    let result = { passed: false, reasoning: "Failed to parse guardrail response." };
                    try {
                        const jsonStr = response.replace(/```json/g, '').replace(/```/g, '').trim();
                        result = JSON.parse(jsonStr);
                    } catch (e) {
                        log(`Guardrail Parse Error: ${response}`);
                    }

                    log(`Guardrail Result: ${result.passed ? 'PASS' : 'FAIL'} (${result.reasoning})`);

                    return {
                        output: { ...input, guardrail: result },
                        activeHandle: result.passed ? 'pass' : 'fail'
                    };

                } catch (e: any) {
                    log(`Guardrail Error: ${e.message}`);
                    throw e;
                }


            case 'subworkflow':
                const workflowPath = node.data.workflowPath;
                if (!workflowPath) {
                    log('Error: No workflow path specified for sub-workflow node.');
                    return { output: input };
                }

                // Resolve workflow path
                const workflowsDir = resolveStoragePath('workflows');
                const fullWorkflowPath = path.join(workflowsDir, workflowPath);

                if (!fs.existsSync(fullWorkflowPath)) {
                    log(`Error: Sub-workflow not found: ${workflowPath}`);
                    throw new Error(`Sub-workflow not found: ${workflowPath}`);
                }

                log(`Loading sub-workflow: ${workflowPath}`);

                try {
                    const subWorkflowData = JSON.parse(fs.readFileSync(fullWorkflowPath, 'utf-8'));

                    // Validate structure
                    if (!subWorkflowData.nodes || !subWorkflowData.edges) {
                        throw new Error('Invalid workflow format: missing nodes or edges');
                    }

                    log(`Executing sub-workflow with ${subWorkflowData.nodes.length} nodes...`);

                    // Recursively execute sub-workflow
                    const subResult = await this.executeWorkflow(subWorkflowData, undefined, undefined, executionMode);

                    if (!subResult.success) {
                        log(`Sub-workflow failed: ${subResult.error}`);
                        throw new Error(`Sub-workflow failed: ${subResult.error}`);
                    }

                    log(`Sub-workflow completed successfully.`);

                    // Return the last output from sub-workflow context, or pass input through
                    const history = subResult.context?.history || [];
                    const subOutput = history.length > 0
                        ? history[history.length - 1].output
                        : input;

                    return { output: subOutput };

                } catch (e: any) {
                    log(`Sub-workflow Error: ${e.message}`);
                    throw e;
                }


            case 'browser': {
                // Browser automation: navigate, get DOM, screenshot, interact
                const bAction = node.data.action || 'navigate';
                const bUrl = node.data.url || '';
                const bSelector = node.data.selector || '';
                const bValue = node.data.value || '';

                log(`Browser [${bAction}]: ${bUrl || bSelector}`);

                if (bAction === 'navigate') {
                    if (!bUrl) throw new Error('browser node: no URL specified');
                    await this.agentService.executeTool('browser_navigate', { url: bUrl });
                    // After nav, get the DOM as output
                    const domResult = await this.agentService.executeTool('browser_get_dom', {});
                    const dom = domResult?.result ?? domResult;
                    return { output: { url: bUrl, dom } };

                } else if (bAction === 'get_dom') {
                    const domResult = await this.agentService.executeTool('browser_get_dom', {});
                    return { output: domResult?.result ?? domResult };

                } else if (bAction === 'screenshot') {
                    const ssResult = await this.agentService.executeTool('browser_screenshot', {});
                    return { output: ssResult?.result ?? ssResult };

                } else if (bAction === 'click') {
                    if (!bSelector) throw new Error('browser click: no selector specified');
                    await this.agentService.executeTool('browser_click', { selector: bSelector });
                    return { output: input };

                } else if (bAction === 'type') {
                    if (!bSelector) throw new Error('browser type: no selector specified');
                    await this.agentService.executeTool('browser_type', { selector: bSelector, text: bValue });
                    return { output: input };

                } else if (bAction === 'extract') {
                    // Use agent to extract structured data from current DOM
                    const domResult = await this.agentService.executeTool('browser_get_dom', {});
                    const dom = domResult?.result ?? String(domResult);
                    const extractPrompt = node.data.extractPrompt || 'Extract all useful data from this HTML as JSON.';
                    const extracted = await this.agentService.headlessInference(
                        `${extractPrompt}\n\nHTML:\n${dom.substring(0, 4000)}`
                    );
                    return { output: extracted };
                }

                log(`Unknown browser action: ${bAction}`);
                return { output: input };
            }

            case 'email_send': {
                // Send email via SMTP — credential must be JSON: { host, port, secure, user, pass }
                const sendCredKey = node.data.credentialKey;
                let smtpConfig: any = {
                    host: node.data.smtpHost || 'smtp.gmail.com',
                    port: parseInt(node.data.smtpPort || '465'),
                    secure: node.data.secure !== false,
                    auth: { user: node.data.user, pass: node.data.pass }
                };

                if (sendCredKey) {
                    const cred = this.getCredential(sendCredKey);
                    if (!cred) throw new Error(`Credential '${sendCredKey}' not found.`);
                    const parsed = typeof cred === 'string' ? JSON.parse(cred) : cred;
                    smtpConfig = { ...smtpConfig, ...parsed, auth: parsed.auth || { user: parsed.user, pass: parsed.pass } };
                }

                const toRaw = node.data.to || (typeof input === 'string' ? input : input?.to || '');
                const subject = node.data.subject || 'Tala Workflow Message';
                const bodyText = node.data.body || (typeof input === 'string' ? input : JSON.stringify(input, null, 2));

                // Support comma-separated or array of recipients
                const recipients: string[] = Array.isArray(toRaw)
                    ? toRaw
                    : String(toRaw).split(',').map((s: string) => s.trim()).filter(Boolean);

                if (recipients.length === 0) throw new Error('email_send: no recipients specified');

                log(`Email Send: ${recipients.length} recipient(s) — "${subject}"`);

                // Use nodemailer dynamically (bundled in electron context)
                const nodemailer = require('nodemailer');
                const transporter = nodemailer.createTransport(smtpConfig);

                const sent: any[] = [];
                for (const to of recipients) {
                    const info = await transporter.sendMail({
                        from: smtpConfig.auth.user,
                        to,
                        subject,
                        text: bodyText
                    });
                    log(`Sent to ${to}: messageId=${info.messageId}`);
                    sent.push({ to, messageId: info.messageId });
                }

                return { output: { sent, count: sent.length } };
            }

            case 'swarm': {
                // Parallel fan-out: run the same prompt against multiple agent profiles
                // node.data.profiles: array of profile IDs, or 'all'
                // node.data.prompt: override prompt (else uses input as prompt)
                const swarmPrompt: string = node.data.prompt ||
                    (typeof input === 'string' ? input : JSON.stringify(input));

                const profileIds: string[] = node.data.profiles || [];
                const parallel: boolean = node.data.parallel !== false; // default true
                const settingsPath = resolveStoragePath('app_settings.json');
                let allProfiles: any[] = [];

                try {
                    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
                    allProfiles = settings.agent?.profiles || [];
                } catch (_e) { /* no profiles */ }

                const targetProfiles = profileIds.length > 0 && profileIds[0] !== 'all'
                    ? allProfiles.filter((p: any) => profileIds.includes(p.id))
                    : allProfiles;

                if (targetProfiles.length === 0) {
                    log('Swarm: No profiles selected — running with default agent.');
                    const result = await this.agentService.headlessInference(swarmPrompt);
                    return { output: [{ profile: 'default', response: result }] };
                }

                log(`Swarm: Dispatching to ${targetProfiles.length} agent(s) (parallel=${parallel})...`);

                const runProfile = async (profile: any) => {
                    log(`Swarm: Running ${profile.name || profile.id}...`);
                    try {
                        // Build profile-aware prompt including system prompt + rules
                        const sysPrompt = [profile.systemPrompt, profile.rules]
                            .filter(Boolean).join('\n\n');
                        const fullPrompt = sysPrompt
                            ? `[System]\n${sysPrompt}\n\n[Task]\n${swarmPrompt}`
                            : swarmPrompt;
                        const response = await this.agentService.headlessInference(fullPrompt);
                        return { profile: profile.name || profile.id, profileId: profile.id, response };
                    } catch (e: any) {
                        return { profile: profile.name || profile.id, profileId: profile.id, error: e.message };
                    }
                };

                let results: any[];
                if (parallel) {
                    results = await Promise.all(targetProfiles.map(runProfile));
                } else {
                    results = [];
                    for (const p of targetProfiles) {
                        results.push(await runProfile(p));
                    }
                }

                log(`Swarm: Completed. ${results.filter(r => !r.error).length}/${results.length} succeeded.`);
                return { output: results };
            }

            default:
                log(`Unknown node type: ${node.type}, passing input through.`);
                return input;
        }
    }
}

