# Service: RuntimeControlService.ts

**Source**: [electron\services\RuntimeControlService.ts](../../electron/services/RuntimeControlService.ts)

## Class: `RuntimeControlService`

### Methods

#### `restartProvider`
Re-probes and refreshes the given provider. Emits provider_restart_requested/completed telemetry./

**Arguments**: `providerId: string`
**Returns**: `Promise<ControlActionResult>`

---
#### `probeProviders`
Re-probes all providers. Debounced to prevent probe storms./

**Arguments**: ``
**Returns**: `Promise<ControlActionResult>`

---
#### `disableProvider`
Suppresses a provider from auto-selection (session-scoped disable). Does not permanently remove the provider./

**Arguments**: `providerId: string, reason?: string`
**Returns**: `ControlActionResult`

---
#### `enableProvider`
Re-enables a previously suppressed provider./

**Arguments**: `providerId: string, reason?: string`
**Returns**: `ControlActionResult`

---
#### `forceProviderSelection`
Forces selection of a specific provider for the current session./

**Arguments**: `providerId: string, reason?: string`
**Returns**: `ControlActionResult`

---
#### `restartMcpService`
Restarts an MCP service by disconnecting and reconnecting./

**Arguments**: `serviceId: string, mcpConfigs: McpServerConfig[]`
**Returns**: `Promise<ControlActionResult>`

---
#### `disableMcpService`
Disables an MCP service (prevents invocation, disconnects it)./

**Arguments**: `serviceId: string`
**Returns**: `Promise<ControlActionResult>`

---
#### `enableMcpService`
Re-enables a previously disabled MCP service./

**Arguments**: `serviceId: string, mcpConfigs: McpServerConfig[]`
**Returns**: `Promise<ControlActionResult>`

---
#### `probeMcpServices`
Triggers a health check / re-probe of all MCP services. Debounced to prevent probe storms./

**Arguments**: ``
**Returns**: `ControlActionResult`

---
#### `getOperatorActions`
**Arguments**: ``
**Returns**: `OperatorActionRecord[]`

---
#### `getRecentProviderRecoveries`
**Arguments**: ``
**Returns**: `Array<`

---
#### `getRecentMcpRestarts`
**Arguments**: ``
**Returns**: `Array<`

---
#### `_trackMcpRestart`
**Arguments**: `serviceId: string`
**Returns**: `void`

---
#### `guardModeCapability`
Central mode contract guard for runtime control actions. Returns a deterministic denied action result instead of throwing so existing IPC callers retain their success/error contract shape./

**Arguments**: `capability: SystemCapability, action: OperatorActionRecord['action'], entityId: string,`
**Returns**: `ControlActionResult | null`

---
