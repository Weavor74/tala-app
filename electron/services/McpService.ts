import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import { McpServerConfig } from '../../src/renderer/settingsData';
import { auditLogger } from './AuditLogger';

/**
 * Represents an active connection to a single MCP (Model Context Protocol) server.
 * Each connection wraps the MCP SDK `Client` instance along with its transport
 * layer and the original configuration that was used to establish it.
 */
interface Connection {
    /** The MCP SDK client instance used to call tools and list resources. */
    client: Client;
    /** The transport layer — either a stdio pipe to a child process or a WebSocket connection. */
    transport: StdioClientTransport | WebSocketClientTransport;
    /** The child process handle (only present for stdio connections). */
    process?: ChildProcess;
    /** The original configuration object that was used to create this connection. */
    config: McpServerConfig;
}

/**
 * McpService
 * 
 * Manages connections to external Python microservices that communicate via the
 * Model Context Protocol (MCP). Each MCP server exposes a set of "tools" (callable
 * functions) and "resources" (readable data) that the Tala agent can use.
 * 
 * Two transport types are supported:
 * - **stdio**: The MCP server is spawned as a child process. Communication happens
 *   over the process's stdin/stdout pipes. This is the primary mode used for
 *   local Python servers (tala-core, astro-engine, mem0-core).
 * - **websocket**: The MCP server is a remote service accessible via WebSocket URL.
 * 
 * The service maintains a `Map<string, Connection>` keyed by server ID. The `sync()`
 * method reconciles this map with the user's saved configuration, connecting new
 * servers and disconnecting removed ones.
 * 
 * @example
 * ```typescript
 * const mcp = new McpService();
 * await mcp.connect({ id: 'rag', name: 'Tala Core', type: 'stdio', command: 'python', args: ['server.py'] });
 * const caps = await mcp.getCapabilities('rag');
 * console.log(caps.tools); // List of available tools
 * ```
 */
export class McpService {
    /** Map of active connections keyed by the server's unique ID string. */
    private connections: Map<string, Connection> = new Map();
    /** The path to the Python executable, used to replace 'python' in stdio commands. */
    private pythonPath: string | null = null;

    private systemService: any = null;

    constructor(systemService?: any) {
        this.systemService = systemService;
    }

    /** Sets the Python executable path for stdio connections. */
    public setPythonPath(path: string) {
        this.pythonPath = path;
    }

    /**
     * Establishes a connection to an MCP server using the provided configuration.
     * 
     * If a connection with the same `config.id` already exists, this method returns
     * `true` immediately without creating a duplicate connection.
     * 
     * For **stdio** connections:
     * - Requires `config.command` (e.g., `'python'`) and optional `config.args` (e.g., `['server.py']`).
     * - The MCP SDK spawns the process and communicates via stdin/stdout.
     * 
     * For **websocket** connections:
     * - Requires `config.url` (e.g., `'ws://localhost:8080'`).
     * - Creates a WebSocket connection to the remote server.
     * 
     * After creating the transport, an MCP `Client` is instantiated with the name
     * `'tala-mcp-client'` and connected to the transport. The connection is then
     * stored in the internal map.
     * 
     * @param {McpServerConfig} config - The server configuration object containing:
     *   - `id` {string} — Unique identifier for this server.
     *   - `name` {string} — Human-readable display name.
     *   - `type` {'stdio' | 'websocket'} — Transport type.
     *   - `command` {string} — (stdio only) The command to spawn.
     *   - `args` {string[]} — (stdio only) Command arguments.
     *   - `url` {string} — (websocket only) The WebSocket URL.
     *   - `enabled` {boolean} — Whether this server should be active.
     * @returns {Promise<boolean>} `true` if the connection was established successfully,
     *   `false` if an error occurred during connection.
     */
    public async connect(config: McpServerConfig): Promise<boolean> {
        if (this.connections.has(config.id)) {
            // Already connected, maybe reconnect if config changed?
            // For now, assume id persistence means same connection
            return true;
        }

        // Preflight Check for Python stdio servers
        if (config.type === 'stdio' && (config.command === 'python' || config.command === this.pythonPath)) {
            const pyExe = this.getPythonExecutable(config);
            if (this.systemService) {
                this.systemService.preflightCheck(pyExe);
            }
        }

        try {
            console.log(`[McpService] Connecting to ${config.name} (${config.type})...`);
            let transport: any;
            let serverProcess: ChildProcess | undefined;

            if (config.type === 'stdio') {
                if (!config.command) throw new Error('Command required for stdio');

                let command = config.command;
                let env = { ...(config as any).env || process.env };

                if (command === 'python' || command === this.pythonPath) {
                    command = this.getPythonExecutable(config);

                    // Use SystemService for environment sanitization if available
                    if (this.systemService) {
                        env = this.systemService.getMcpEnv(env);
                    } else {
                        delete env.PYTHONHOME;
                        delete env.PYTHONPATH;
                        env.PYTHONNOUSERSITE = '1';
                        env.PYTHONUNBUFFERED = '1';
                    }
                }

                const serverCwd = config.cwd ? path.resolve(process.cwd(), config.cwd) : undefined;

                transport = new StdioClientTransport({
                    command: command,
                    args: config.args || [],
                    env: env as any,
                    cwd: serverCwd
                });

            } else if (config.type === 'websocket') {
                if (!config.url) throw new Error('URL required for websocket');
                transport = new WebSocketClientTransport(new URL(config.url));
            } else {
                throw new Error(`Unknown type: ${config.type}`);
            }

            const client = new Client({
                name: 'tala-mcp-client',
                version: '1.0.0'
            }, {
                capabilities: {}
            });

            await client.connect(transport);

            this.connections.set(config.id, {
                client,
                transport,
                process: serverProcess,
                config
            });

            auditLogger.info('mcp_connect_ok', 'McpService', {
                serverId: config.id,
                name: config.name,
                transport: config.type,
                command: config.command
            });

            console.log(`[McpService] Connected to ${config.name}`);
            return true;

        } catch (e: any) {
            auditLogger.error('mcp_connect_fail', 'McpService', {
                serverId: config.id,
                name: config.name,
                error: e.message
            });
            console.error(`[McpService] Failed to connect to ${config.name}:`, e);
            return false;
        }
    }

    /**
     * Disconnects from an MCP server and removes it from the active connections map.
     * 
     * Calls `client.close()` on the MCP SDK client, which in turn closes the
     * transport. For stdio connections, closing the transport terminates the
     * child process. For WebSocket connections, the socket is closed.
     * 
     * If the given ID is not found in the connections map, this method is a no-op.
     * Errors during disconnection are caught and logged but do not throw.
     * 
     * @param {string} id - The unique identifier of the MCP server to disconnect.
     * @returns {Promise<void>}
     */
    public async disconnect(id: string) {
        const conn = this.connections.get(id);
        if (conn) {
            try {
                await conn.client.close();
                // transport close usually kills stdio process
                this.connections.delete(id);
                console.log(`[McpService] Disconnected ${conn.config.name}`);
            } catch (e) {
                console.error(`[McpService] Error disconnecting ${id}:`, e);
            }
        }
    }

    /**
     * Retrieves the list of tools and resources exposed by a connected MCP server.
     * 
     * Calls the MCP SDK's `listTools()` and `listResources()` methods on the
     * connected client. These are standard MCP protocol operations that ask the
     * server to enumerate its available capabilities.
     * 
     * If the server is not connected (ID not found), returns empty arrays.
     * If the query fails (e.g., server process crashed), returns empty arrays
     * with an `error` string describing the failure.
     * 
     * @param {string} id - The unique identifier of the MCP server to query.
     * @returns {Promise<{ tools: any[], resources: any[], error?: string }>}
     *   An object containing:
     *   - `tools` — Array of tool definitions the server provides.
     *   - `resources` — Array of resource definitions the server provides.
     *   - `error` — (optional) Error message if the query failed.
     */
    public async getCapabilities(id: string) {
        const conn = this.connections.get(id);
        if (!conn) return { tools: [], resources: [] };

        const result: { tools: any[], resources: any[], error?: string } = { tools: [], resources: [] };

        try {
            const tools = await conn.client.listTools();
            result.tools = tools.tools;
        } catch (e: any) {
            console.error(`[McpService] Error fetching tools for ${id}:`, e);
            result.error = String(e);
        }

        try {
            const resources = await conn.client.listResources();
            result.resources = resources.resources;
        } catch (e: any) {
            // Silence "Method not found" for resources as many servers don't support it
            if (e.code !== -32601) {
                console.error(`[McpService] Error fetching resources for ${id}:`, e);
            }
        }

        return result;
    }

    /**
     * Synchronizes the active connections with the user's saved configuration.
     * 
     * This method performs a two-phase reconciliation:
     * 
     * **Phase 1 — Remove stale connections:**
     * Iterates over all currently active connections. If a connection's ID is not
     * found in the provided configs array, or if its config has `enabled: false`,
     * the connection is disconnected and removed.
     * 
     * **Phase 2 — Add new connections:**
     * Iterates over the provided configs array. For each config that has
     * `enabled: true` and is not already connected, calls `connect()` to
     * establish the connection.
     * 
     * This method is typically called:
     * - At application startup (via `igniteSoul()` in AgentService).
     * - When the user saves changes in the Settings panel.
     * 
     * @param {McpServerConfig[]} configs - The complete list of MCP server
     *   configurations from the user's saved settings.
     * @returns {Promise<void>}
     */
    public async sync(configs: McpServerConfig[]) {
        // Remove removed
        for (const [id, conn] of this.connections) {
            if (!configs.find(c => c.id === id && c.enabled)) {
                await this.disconnect(id);
            }
        }

        // Add new / Connect enabled
        for (const cfg of configs) {
            if (cfg.enabled && !this.connections.has(cfg.id)) {
                await this.connect(cfg);
            }
        }
    }

    // ─── Auto-Restart / Health Check ──────────────────────────────

    /** Interval handle for the health check loop. */
    private healthInterval: ReturnType<typeof setInterval> | null = null;

    /**
     * Starts a periodic health check loop (every 30s).
     * For each active connection, attempts a lightweight `listTools()` call.
     * If the call fails, the connection is torn down and re-established
     * using the stored config.
     */
    public startHealthLoop() {
        if (this.healthInterval) return; // Already running
        console.log('[McpService] Starting health check loop (30s interval).');

        this.healthInterval = setInterval(async () => {
            for (const [id, conn] of this.connections) {
                try {
                    await conn.client.listTools(); // lightweight ping
                } catch (e) {
                    console.warn(`[McpService] Health check failed for ${conn.config.name}, reconnecting...`);
                    try {
                        await conn.client.close().catch(() => { });
                    } catch (_) { }
                    this.connections.delete(id);

                    // Auto-reconnect
                    auditLogger.info('mcp_reconnect', 'McpService', { serverId: id });
                    const ok = await this.connect(conn.config);
                    if (ok) {
                        console.log(`[McpService] Successfully reconnected ${conn.config.name}.`);
                    } else {
                        console.error(`[McpService] Failed to reconnect ${conn.config.name}.`);
                    }
                }
            }
        }, 30_000);
    }

    /** Stops the health check loop. */
    public stopHealthLoop() {
        if (this.healthInterval) {
            clearInterval(this.healthInterval);
            this.healthInterval = null;
        }
    }

    /**
     * Returns a list of all active connection IDs.
     */
    public getActiveConnections(): string[] {
        return Array.from(this.connections.keys());
    }

    /**
     * Calls a tool on a connected MCP server.
     * 
     * @param {string} serverId - The ID of the server to call.
     * @param {string} toolName - The name of the tool to invoke.
     * @param {any} args - Arguments to pass to the tool.
     * @returns {Promise<any>} The result from the tool execution.
     */
    public async callTool(serverId: string, toolName: string, args: any): Promise<any> {
        const conn = this.connections.get(serverId);
        if (!conn) throw new Error(`MCP server ${serverId} not connected.`);

        try {
            const result = await conn.client.callTool({
                name: toolName,
                arguments: args
            });
            return result;
        } catch (e: any) {
            console.error(`[McpService] Tool call failed (${toolName} on ${serverId}):`, e);
            throw new Error(`MCP Tool Error: ${e.message}`);
        }
    }

    /**
     * Resolves the Python executable based on config and system settings.
     * Prefers canonical bundled python unless useMcpVenv is explicit.
     */
    private getPythonExecutable(config: McpServerConfig): string {
        if (this.systemService && typeof this.systemService.resolveMcpPythonPath === 'function') {
            // We pass a dummy SystemInfo with pythonPath set to this.pythonPath to bridge legacy usage
            return this.systemService.resolveMcpPythonPath({ useMcpVenv: config.useMcpVenv }, { pythonPath: this.pythonPath });
        }
        if (config.useMcpVenv && (config as any).pythonEnvPath) {
            return (config as any).pythonEnvPath;
        }
        return this.pythonPath || 'python';
    }


    /**
     * Shuts down the MCP service by disconnecting all active servers
     * and stopping the health check loop.
     */
    public async shutdown(): Promise<void> {
        this.stopHealthLoop();
        console.log('[McpService] Shutting down all connections...');
        for (const [id, conn] of this.connections) {
            try {
                // transport close usually kills stdio process if client closes
                await conn.client.close();
                if (conn.process) conn.process.kill();
            } catch (e) {
                console.error(`[McpService] Error closing ${id}:`, e);
            }
        }
        this.connections.clear();
    }
}
