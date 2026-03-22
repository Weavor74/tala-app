# Service: McpService.ts

**Source**: [electron/services/McpService.ts](../../electron/services/McpService.ts)

## Class: `McpService`

## Overview
McpService - Protocol / Tool Infrastructure
 
 This service manages the lifecycle and tool connectivity of Model Context Protocol (MCP) servers.
 It acts as TALA's bridge to external tool servers, enabling the agent to interact with specialized
 microservices (e.g., Python scripts, remote APIs) via a standardized protocol.
 
 **System Role:**
 - Orchestrates the connection between TALA's core agentic loop and external capabilities.
 - Manages the transition from abstract tool calls to concrete protocol requests.
 - Handles the discovery and normalization of tools/resources for downstream AI consumption.
 
 **Collaboration Architecture:**
 - Consumed by `AgentService` and `OrchestratorService` to populate tool registries.
 - Relies on `SystemService` for environment isolation and binary resolution.
 - Uses `AuditLogger` to track protocol-level transactions and security boundaries.
/

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import type { McpServerConfig } from '../../shared/settings';
import { auditLogger } from './AuditLogger';

/**
 Enumeration of possible MCP server states within TALA's connection registry.

 Phase 1 hardening expands the state model to cover the full server lifecycle,
 enabling the runtime to reason about degraded and failed services deterministically.
/
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
 Structured health report for a single MCP server.
 Used by the runtime to decide whether to invoke a service or degrade gracefully.
/
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
 Represents an active connection to a single MCP (Model Context Protocol) server.
 Each connection wraps the MCP SDK `Client` instance along with its transport
 layer and the original configuration that was used to establish it.
/
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
#### `getServiceHealth`
Returns a structured health report for a specific MCP server.

 Used by the agent runtime to check service readiness before invoking
 dependent tools and to decide whether to degrade gracefully.
/

**Arguments**: `serverId: string`
**Returns**: `McpServiceHealth | null`

---
#### `getAllServiceHealth`
Returns health reports for all registered MCP servers.

 Callers can use this snapshot to determine which services are callable,
 which are degraded, and which should trigger a fallback path.
/

**Arguments**: ``
**Returns**: `McpServiceHealth[]`

---
#### `isServiceCallable`
Returns true if the given server is in a callable state.

 Convenience wrapper used by AgentService before invoking MCP-backed tools.
/

**Arguments**: `serverId: string`
**Returns**: `boolean`

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
