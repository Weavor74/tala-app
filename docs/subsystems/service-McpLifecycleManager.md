# Service: McpLifecycleManager.ts

**Source**: [electron\services\McpLifecycleManager.ts](../../electron/services/McpLifecycleManager.ts)

## Class: `McpLifecycleManager`

### Methods

#### `registerService`
Registers a service for lifecycle tracking. Called when the MCP service inventory is initialized or synced./

**Arguments**: `serviceId: string, displayName: string, kind: 'stdio' | 'websocket' | 'http', enabled: boolean,`
**Returns**: `void`

---
#### `onServiceStarting`
Called when a service connection attempt starts./

**Arguments**: `serviceId: string`
**Returns**: `void`

---
#### `onServiceReady`
Called when a service connection succeeds and becomes ready./

**Arguments**: `serviceId: string`
**Returns**: `void`

---
#### `onServiceDegraded`
Called when a service fails a health check and enters degraded state./

**Arguments**: `serviceId: string, reason?: string`
**Returns**: `void`

---
#### `onServiceUnavailable`
Called when a service becomes unavailable (temporarily unreachable)./

**Arguments**: `serviceId: string, reason?: string`
**Returns**: `void`

---
#### `onServiceFailed`
Called when a service has exhausted retries and entered FAILED state./

**Arguments**: `serviceId: string, reason?: string, restartCount?: number`
**Returns**: `void`

---
#### `onServiceRecovering`
Called when a reconnect attempt begins for a degraded service./

**Arguments**: `serviceId: string`
**Returns**: `void`

---
#### `onHealthCheckCompleted`
Records a completed health check result./

**Arguments**: `serviceId: string, healthy: boolean, durationMs?: number`
**Returns**: `void`

---
#### `onInventoryRefreshed`
Emits an inventory snapshot telemetry event. Called after sync() or after any significant inventory change./

**Arguments**: ``
**Returns**: `void`

---
#### `syncFromService`
Synchronizes lifecycle metadata from current McpService health reports. Auto-registers any services present in McpService but not yet tracked. Call this after mcpService.sync() or at regular intervals./

**Arguments**: ``
**Returns**: `void`

---
#### `getDiagnosticsInventory`
Returns the normalized diagnostics inventory for all registered services. Auto-includes any services present in McpService that are not yet in serviceMeta./

**Arguments**: ``
**Returns**: `McpInventoryDiagnostics`

---
#### `getServiceDiagnostics`
Returns diagnostics for a single service by ID./

**Arguments**: `serviceId: string`
**Returns**: `McpServiceDiagnostics | null`

---
#### `_transition`
**Arguments**: `serviceId: string, newState: ServerState, reason: string`
**Returns**: `void`

---
#### `_applyTransitionFromHealth`
**Arguments**: `health: McpServiceHealth, prevState: ServerState`
**Returns**: `void`

---
#### `_checkInstabilitySignal`
**Arguments**: `serviceId: string`
**Returns**: `void`

---
