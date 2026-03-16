/**
 * McpService - Protocol / Tool Infrastructure
 * 
 * This service manages the lifecycle and tool connectivity of Model Context Protocol (MCP) servers.
 * It acts as TALA's bridge to external tool servers, enabling the agent to interact with specialized
 * microservices (e.g., Python scripts, remote APIs) via a standardized protocol.
 * 
 * **System Role:**
 * - Orchestrates the connection between TALA's core agentic loop and external capabilities.
 * - Manages the transition from abstract tool calls to concrete protocol requests.
 * - Handles the discovery and normalization of tools/resources for downstream AI consumption.
 * 
 * **Collaboration Architecture:**
 * - Consumed by `AgentService` and `OrchestratorService` to populate tool registries.
 * - Relies on `SystemService` for environment isolation and binary resolution.
 * - Uses `AuditLogger` to track protocol-level transactions and security boundaries.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import type { McpServerConfig } from '../../shared/settings';
import { auditLogger } from './AuditLogger';

/**
 * Enumeration of possible MCP server states within TALA's connection registry.
 *
 * Phase 1 hardening expands the state model to cover the full server lifecycle,
 * enabling the runtime to reason about degraded and failed services deterministically.
 */
export enum ServerState {
    /** The server process is being started and the connection handshake is in progress. */
    STARTING = 'STARTING',
    /** The server is connected, capability-cached, and ready for tool calls. */
    CONNECTED = 'CONNECTED',
    /** Alias for CONNECTED — used in contexts where readiness semantics are important. */
    READY = 'CONNECTED',
    /** The server has failed health checks and is awaiting a backoff-gated retry. */
    DEGRADED = 'DEGRADED',
    /** The server is temporarily unreachable but has not yet entered exponential backoff. */
    UNAVAILABLE = 'UNAVAILABLE',
    /** The server has exhausted all retry attempts and is considered permanently failed. */
    FAILED = 'FAILED',
    /** The server has been explicitly disabled by the user or system policy. */
    DISABLED = 'DISABLED'
}

/** Maximum retry count before a DEGRADED server transitions to FAILED. */
const MAX_RETRY_BEFORE_FAILED = 8;

/**
 * Structured health report for a single MCP server.
 * Used by the runtime to decide whether to invoke a service or degrade gracefully.
 */
export interface McpServiceHealth {
    serverId: string;
    name: string;
    state: ServerState;
    retryCount: number;
    lastRetryTime: number;
    /** Whether the service can currently accept tool invocations. */
    isCallable: boolean;
    /** Human-readable status description for diagnostics. */
    statusMessage: string;
}

/**
 * Represents an active connection to a single MCP (Model Context Protocol) server.
 * Each connection wraps the MCP SDK `Client` instance along with its transport
 * layer and the original configuration that was used to establish it.
 */
interface Connection {
    client: Client;
    transport: StdioClientTransport | WebSocketClientTransport;
    /** The subprocess instance (stdio only). */
    process?: ChildProcess;
    config: McpServerConfig;
    state: ServerState;
    /** Incrementing counter for backoff calculation during DEGRADED states. */
    retryCount: number;
    /** Epoch timestamp of the last connection attempt for backoff gating. */
    lastRetryTime: number;
}

/**
 * Central Service for managing Model Context Protocol (MCP) connections.
 */
export class McpService {
    /** Map of active connections keyed by the server's unique ID string. */
    private connections: Map<string, Connection> = new Map();
    /** The path to the Python executable, used to replace 'python' in stdio commands. */
    private pythonPath: string | null = null;
    private capabilityCache: Map<string, { tools: any[], resources: any[], timestamp: number }> = new Map();
    private static readonly CAPABILITY_CACHE_TTL_MS = 600000; // 10 minutes

    private systemService: any = null;
    private healthInterval: ReturnType<typeof setInterval> | null = null;
    private onRecovery: (() => void) | null = null;

    constructor(systemService?: any) {
        this.systemService = systemService;
    }

    /** Sets the Python executable path for stdio connections. */
    public setPythonPath(path: string) {
        this.pythonPath = path;
    }

    public setOnRecovery(callback: () => void) {
        this.onRecovery = callback;
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
    /**
     * Establishes a connection to an MCP server using the provided configuration.
     * 
     * **Lifecycle Action:**
     * - Checks if server is already connected (id-based de-duplication).
     * - Performs preflight checks for local Python servers (e.g., venv validation).
     * - Instantiates the appropriate transport (Stdio or WebSocket).
     * - Negotiates capabilities with the server via the MCP SDK client.
     * - Transitions the server state to `CONNECTED` on success, or `DEGRADED` on failure.
     * 
     * @param config - The server configuration from user settings.
     * @returns `true` if connection established and handshake completed.
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
                config,
                state: ServerState.CONNECTED,
                retryCount: 0,
                lastRetryTime: Date.now()
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

            // Maintain entry in DEGRADED state for backoff logic
            const existing = this.connections.get(config.id);
            this.connections.set(config.id, {
                client: existing?.client || ({} as any),
                transport: existing?.transport || ({} as any),
                process: existing?.process,
                config,
                state: ServerState.DEGRADED,
                retryCount: (existing?.retryCount || 0) + 1,
                lastRetryTime: Date.now()
            });

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
    /**
     * Disconnects from an MCP server and removes it from the active registry.
     * 
     * **Side Effects:**
     * - Closes the transport layer.
     * - For `stdio` servers, terminates the associated child process.
     * - Removes the connection from the internal map.
     * 
     * @param id - The unique identifier of the MCP server.
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
    /**
     * Retrieves the tool and resource definitions from a connected server.
     * 
     * **Discovery Flow:**
     * - Checks internal `capabilityCache` for existing results within TTL.
     * - Triggers `listTools()` and `listResources()` protocol calls if cache is stale.
     * - Returns empty arrays if the server is `DEGRADED` or disconnected.
     * 
     * @param id - The id of the server to query.
     * @param reason - Context for the query ('manual', 'periodic', 'connect').
     */
    public async getCapabilities(id: string, reason: string = 'manual') {
        const conn = this.connections.get(id);
        if (!conn || conn.state === ServerState.DEGRADED) return { tools: [], resources: [] };

        const now = Date.now();
        const cached = this.capabilityCache.get(id);

        // Cache hit: must be within TTL AND not a refresh reason (connect/recovery/manual_refresh)
        if (reason === 'periodic' && cached && (now - cached.timestamp) < McpService.CAPABILITY_CACHE_TTL_MS) {
            return cached;
        }

        console.log(`[McpService] list_tools reason=${reason} server=${id}`);
        const result: { tools: any[], resources: any[], timestamp: number, error?: string } = {
            tools: [],
            resources: [],
            timestamp: now
        };

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
            if (e.code !== -32601) {
                console.error(`[McpService] Error fetching resources for ${id}:`, e);
            }
        }

        if (!result.error) {
            this.capabilityCache.set(id, result);
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

    /**
     * Starts the health monitoring and recovery loop.
     * 
     * **Health Logic:**
     * - Runs every 10 seconds.
     * - **CONNECTED Servers**: Performs a lightweight ping or capability query to verify responsiveness.
     * - **DEGRADED Servers**: Evaluates exponential backoff (30s, 60s, ..., up to 30m). If the 
     *   backoff window has passed, attempts to re-establish the connection.
     * 
     * If a server recovers, the optional `onRecovery` callback is triggered to notify 
     * the agent to refresh its tool registry.
     */
    /**
     * Starts the health monitoring and recovery loop.
     * 
     * **Resiliency Logic:**
     * - Runs every 10 seconds.
     * - **CONNECTED Servers**: Probes for responsiveness (process status or light ping).
     * - **DEGRADED Servers**: Implements exponential backoff (starting at 30s, up to 30m).
     * - **Recovery**: On successful reconnect, triggers `onRecovery` to refresh tool registries.
     */
    public startHealthLoop() {
        if (this.healthInterval) return;
        console.log('[McpService] Starting health check loop with backoff management.');

        this.healthInterval = setInterval(async () => {
            const now = Date.now();
            for (const [id, conn] of this.connections) {
                // Exponential Backoff Logic: 30s, 60s, 120s... up to 1800s (30m)
                if (conn.state === ServerState.DEGRADED) {
                    // Transition to FAILED after exhausting all retry attempts
                    if (conn.retryCount >= MAX_RETRY_BEFORE_FAILED) {
                        if (conn.state !== ServerState.FAILED) {
                            conn.state = ServerState.FAILED;
                            auditLogger.warn('mcp_server_failed', 'McpService', {
                                serverId: id,
                                name: conn.config.name,
                                retryCount: conn.retryCount
                            });
                            console.warn(`[McpService] Server ${conn.config.name} FAILED after ${conn.retryCount} retries. Manual intervention required.`);
                        }
                        continue;
                    }
                    const delaySeconds = Math.min(30 * Math.pow(2, Math.min(conn.retryCount - 1, 6)), 1800);
                    if (now < conn.lastRetryTime + (delaySeconds * 1000)) {
                        continue; // Skip until backoff expires
                    }
                    console.log(`[McpService] Backoff expired for ${conn.config.name}, retrying (attempt ${conn.retryCount})...`);
                    const ok = await this.connect(conn.config);
                    if (ok) {
                        console.log(`[McpService] Server ${id} RECOVERED.`);
                        if (this.onRecovery) this.onRecovery();
                    }
                    continue;
                }

                if (conn.state === ServerState.DISABLED || conn.state === ServerState.FAILED) continue;

                // Health check for CONNECTED servers
                try {
                    // Use a minimal request as a ping. listTools is removed from periodic health loop.
                    // We check if the transport is still responsive.
                    // If the client has a ping method (some SDK versions) we use it, otherwise a dummy request.
                    if ((conn.client as any).ping) {
                        await (conn.client as any).ping();
                    } else {
                        // Fallback: check process/transport state or a very lightweight call
                        if (conn.config.type === 'stdio' && conn.process?.exitCode !== null && conn.process?.exitCode !== undefined) {
                            throw new Error('Process exited');
                        }
                        // We avoid listTools() here to prevent spam. 
                        // If we must send a request, we'll check the cache timestamp and only refresh if > TTL.
                        const cached = this.capabilityCache.get(id);
                        if (!cached || (now - cached.timestamp) > McpService.CAPABILITY_CACHE_TTL_MS) {
                            await this.getCapabilities(id, 'periodic');
                        }
                    }
                } catch (e) {
                    console.warn(`[McpService] Health check failed for ${conn.config.name}. Setting to DEGRADED.`);
                    conn.state = ServerState.DEGRADED;
                    conn.lastRetryTime = now;
                    conn.retryCount = 1;
                    this.capabilityCache.delete(id); // Clear cache on failure

                    try {
                        await conn.client.close().catch(() => { });
                    } catch (_) { }
                }
            }
        }, 10_000); // Check loop runs every 10s to evaluate backoff timers
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
        return Array.from(this.connections.entries())
            .filter(([_, conn]) => conn.state === ServerState.CONNECTED)
            .map(([id, _]) => id);
    }

    /**
     * Returns a structured health report for a specific MCP server.
     *
     * Used by the agent runtime to check service readiness before invoking
     * dependent tools and to decide whether to degrade gracefully.
     */
    public getServiceHealth(serverId: string): McpServiceHealth | null {
        const conn = this.connections.get(serverId);
        if (!conn) return null;

        const isCallable = conn.state === ServerState.CONNECTED;

        let statusMessage: string;
        switch (conn.state) {
            case ServerState.CONNECTED:
                statusMessage = 'Service is ready and accepting tool calls.';
                break;
            case ServerState.STARTING:
                statusMessage = 'Service is starting up — connection handshake in progress.';
                break;
            case ServerState.DEGRADED:
                statusMessage = `Service degraded after ${conn.retryCount} failure(s). Backoff retry in progress.`;
                break;
            case ServerState.UNAVAILABLE:
                statusMessage = 'Service is temporarily unreachable.';
                break;
            case ServerState.FAILED:
                statusMessage = `Service failed after ${conn.retryCount} retry attempt(s). Manual intervention required.`;
                break;
            case ServerState.DISABLED:
                statusMessage = 'Service is disabled by user or system policy.';
                break;
            default:
                statusMessage = 'Service state unknown.';
        }

        return {
            serverId,
            name: conn.config.name,
            state: conn.state,
            retryCount: conn.retryCount,
            lastRetryTime: conn.lastRetryTime,
            isCallable,
            statusMessage
        };
    }

    /**
     * Returns health reports for all registered MCP servers.
     *
     * Callers can use this snapshot to determine which services are callable,
     * which are degraded, and which should trigger a fallback path.
     */
    public getAllServiceHealth(): McpServiceHealth[] {
        return Array.from(this.connections.keys())
            .map(id => this.getServiceHealth(id))
            .filter((h): h is McpServiceHealth => h !== null);
    }

    /**
     * Returns true if the given server is in a callable state.
     *
     * Convenience wrapper used by AgentService before invoking MCP-backed tools.
     */
    public isServiceCallable(serverId: string): boolean {
        return this.getServiceHealth(serverId)?.isCallable ?? false;
    }

    /**
     * Invokes a specific tool on a connected MCP server.
     * 
     * @param serverId - The unique ID of the target MCP server.
     * @param toolName - The name of the tool to execute.
     * @param args - Arguments to pass to the tool (JSON Schema compliant).
     * @returns The raw result from the MCP tool execution.
     * @throws Error if the server is not connected or the tool call fails.
     */
    /**
     * Invokes a specific tool on a connected MCP server.
     * 
     * **Execution Path:**
     * - Proxies the request from the orchestrator logic to the MCP transport.
     * - Wraps protocol-level errors into a localized `MCP Tool Error`.
     * - Logs failures to the system console and audit logger.
     * 
     * @param serverId - The target server ID.
     * @param toolName - The name of the tool to execute.
     * @param args - Validated arguments for the tool.
     * @returns The server's response payload.
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
