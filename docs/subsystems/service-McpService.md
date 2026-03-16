# Service: McpService.ts

**Source**: [electron/services/McpService.ts](../../electron/services/McpService.ts)

## Class: `McpService`

## Overview

Central service for managing Model Context Protocol (MCP) server lifecycle and tool connectivity.
`McpService` acts as TALA's bridge to external tool servers, enabling the agent to interact with
specialized microservices (e.g., Python scripts, remote APIs) via a standardized protocol.

**System Role:**
- Orchestrates the connection between TALA's core agentic loop and external capabilities.
- Manages the full server lifecycle: startup → readiness → health → reconnect/retry → shutdown.
- Exposes structured service health to the runtime for deterministic capability gating.
- Uses `AuditLogger` to track protocol-level transactions and security boundaries.

**Collaboration Architecture:**
- Consumed by `AgentService` and `OrchestratorService` to populate tool registries.
- Relies on `SystemService` for environment isolation and binary resolution.

## Server State Model (Phase 1 Hardened)

Each registered server progresses through a defined state machine.
The runtime checks `isServiceCallable(serverId)` before invoking MCP-backed tools.

| State | Value | Callable | Description |
|-------|-------|----------|-------------|
| `STARTING` | `'STARTING'` | No | Connection handshake in progress |
| `CONNECTED` / `READY` | `'CONNECTED'` | Yes | Ready for tool calls |
| `UNAVAILABLE` | `'UNAVAILABLE'` | No | Temporarily unreachable |
| `DEGRADED` | `'DEGRADED'` | No | Failed health check; exponential backoff active |
| `FAILED` | `'FAILED'` | No | Exhausted retries (>8); manual intervention required |
| `DISABLED` | `'DISABLED'` | No | Explicitly disabled by user or system policy |

`READY` is a semantic alias for `CONNECTED` — both map to the same enum value.

## Service Health API (Phase 1 Hardened)

### `getServiceHealth(serverId): McpServiceHealth | null`
Returns a structured health report for a specific server, including state, retryCount,
and whether the service is currently callable. Returns `null` if the server is unknown.

### `getAllServiceHealth(): McpServiceHealth[]`
Returns health reports for all registered servers. Used by `AgentService` to assess
which MCP capabilities are available before assembling the tool registry.

### `isServiceCallable(serverId): boolean`
Returns `true` only if the server is in `CONNECTED` state. Used as a preflight check
before any MCP tool invocation.

## Graceful Degradation

When a service is not callable, the agent degrades without crashing:
- **Astro unavailable**: Turn continues without emotional modulation.
- **Memory graph unavailable**: Falls back to local `MemoryService` store.
- **Non-critical service**: Turn continues; `TurnContext.auditMetadata.mcpServicesUsed` records the gap.

## Health Loop

`startHealthLoop()` runs every 10 seconds:
1. **CONNECTED**: Pings the server (or checks process state). On failure → transitions to DEGRADED.
2. **DEGRADED**: Applies exponential backoff (30s, 60s, 120s, … up to 30m). On success → CONNECTED; if retries exceed 8 → FAILED.
3. **FAILED / DISABLED**: Skipped entirely.

When a server transitions to FAILED, the following occurs:
- `console.warn('[McpService] Server <name> FAILED after <n> retries. Manual intervention required.')` is logged.
- An `mcp_server_failed` JSONL audit event is emitted (including serverId, name, retryCount).
- The server is excluded from all subsequent health checks.
- Manual intervention (reconfiguring or restarting the server) is required to recover.

## Key Methods

| Method | Description |
|--------|-------------|
| `connect(config)` | Establishes stdio or WebSocket connection; transitions to CONNECTED or DEGRADED |
| `disconnect(id)` | Closes transport and removes from registry |
| `getCapabilities(id, reason)` | Returns tool/resource definitions; uses 10-minute capability cache |
| `callTool(serverId, toolName, args)` | Invokes a tool on a connected server |
| `syncConnections(configs)` | Reconciles live connections with user settings |
| `startHealthLoop()` | Starts the 10-second health monitor |
| `stopHealthLoop()` | Stops the health monitor |
| `shutdown()` | Disconnects all servers and stops health loop |

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
 Central Service for managing Model Context Protocol (MCP) connections.

### Methods

#### `setPythonPath`
**Arguments**: `path: string`

---
#### `setOnRecovery`
**Arguments**: `callback: () => void`

---
#### `connect`
Establishes a connection to an MCP server using the provided configuration.
 
 **Lifecycle Action:**
 - Checks if server is already connected (id-based de-duplication).
 - Performs preflight checks for local Python servers (e.g., venv validation).
 - Instantiates the appropriate transport (Stdio or WebSocket).
 - Negotiates capabilities with the server via the MCP SDK client.
 - Transitions the server state to `CONNECTED` on success, or `DEGRADED` on failure.
 
 @param config - The server configuration from user settings.
 @returns `true` if connection established and handshake completed.
/

**Arguments**: `config: McpServerConfig`
**Returns**: `Promise<boolean>`

---
#### `disconnect`
Disconnects from an MCP server and removes it from the active registry.
 
 **Side Effects:**
 - Closes the transport layer.
 - For `stdio` servers, terminates the associated child process.
 - Removes the connection from the internal map.
 
 @param id - The unique identifier of the MCP server.
/

**Arguments**: `id: string`

---
#### `getCapabilities`
Retrieves the tool and resource definitions from a connected server.
 
 **Discovery Flow:**
 - Checks internal `capabilityCache` for existing results within TTL.
 - Triggers `listTools()` and `listResources()` protocol calls if cache is stale.
 - Returns empty arrays if the server is `DEGRADED` or disconnected.
 
 @param id - The id of the server to query.
 @param reason - Context for the query ('manual', 'periodic', 'connect').
/

**Arguments**: `id: string, reason: string = 'manual'`

---
#### `sync`
Synchronizes the active connections with the user's saved configuration.
 
 This method performs a two-phase reconciliation:
 
 **Phase 1 — Remove stale connections:**
 Iterates over all currently active connections. If a connection's ID is not
 found in the provided configs array, or if its config has `enabled: false`,
 the connection is disconnected and removed.
 
 **Phase 2 — Add new connections:**
 Iterates over the provided configs array. For each config that has
 `enabled: true` and is not already connected, calls `connect()` to
 establish the connection.
 
 This method is typically called:
 - At application startup (via `igniteSoul()` in AgentService).
 - When the user saves changes in the Settings panel.
 
 @param {McpServerConfig[]} configs - The complete list of MCP server
   configurations from the user's saved settings.
 @returns {Promise<void>}
/

**Arguments**: `configs: McpServerConfig[]`

---
#### `startHealthLoop`
Starts the health monitoring and recovery loop.
 
 **Resiliency Logic:**
 - Runs every 10 seconds.
 - **CONNECTED Servers**: Probes for responsiveness (process status or light ping).
 - **DEGRADED Servers**: Implements exponential backoff (starting at 30s, up to 30m).
 - **Recovery**: On successful reconnect, triggers `onRecovery` to refresh tool registries.
/

**Arguments**: ``

---
#### `stopHealthLoop`
**Arguments**: ``

---
#### `getActiveConnections`
Returns a list of all active connection IDs.
/

**Arguments**: ``
**Returns**: `string[]`

---
#### `callTool`
Invokes a specific tool on a connected MCP server.
 
 **Execution Path:**
 - Proxies the request from the orchestrator logic to the MCP transport.
 - Wraps protocol-level errors into a localized `MCP Tool Error`.
 - Logs failures to the system console and audit logger.
 
 @param serverId - The target server ID.
 @param toolName - The name of the tool to execute.
 @param args - Validated arguments for the tool.
 @returns The server's response payload.
/

**Arguments**: `serverId: string, toolName: string, args: any`
**Returns**: `Promise<any>`

---
#### `getPythonExecutable`
Resolves the Python executable based on config and system settings.
 Prefers canonical bundled python unless useMcpVenv is explicit.
/

**Arguments**: `config: McpServerConfig`
**Returns**: `string`

---
#### `shutdown`
Shuts down the MCP service by disconnecting all active servers
 and stopping the health check loop.
/

**Arguments**: ``
**Returns**: `Promise<void>`

---
