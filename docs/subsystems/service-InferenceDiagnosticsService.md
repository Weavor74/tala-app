# Service: InferenceDiagnosticsService.ts

**Source**: [electron\services\InferenceDiagnosticsService.ts](../../electron/services/InferenceDiagnosticsService.ts)

## Class: `InferenceDiagnosticsService`

### Methods

#### `recordProviderSelected`
Records that a provider was selected (from selectProvider()). Called before stream execution begins./

**Arguments**: `provider: InferenceProviderDescriptor`
**Returns**: `void`

---
#### `recordStreamStart`
Records that a stream execution has started. Called at the entry of InferenceService.executeStream()./

**Arguments**: `providerId: string, attemptedProviders: string[]`
**Returns**: `void`

---
#### `recordStreamActive`
Records that an active stream is flowing (first token received)./

**Arguments**: ``
**Returns**: `void`

---
#### `recordStreamResult`
Records the result of a completed (success or failure) stream execution. Called at the end of InferenceService.executeStream()./

**Arguments**: `result: StreamInferenceResult`
**Returns**: `void`

---
#### `updateFromInventory`
Updates the provider inventory summary from a refreshed inventory. Called after InferenceService.refreshProviders() completes./

**Arguments**: `inventory: InferenceProviderInventory`
**Returns**: `void`

---
#### `getState`
Returns the current normalized inference diagnostics state. The returned object is a shallow copy — callers must not mutate it./

**Arguments**: ``
**Returns**: `InferenceDiagnosticsState`

---
#### `reset`
Resets state to default (useful for testing)./

**Arguments**: ``
**Returns**: `void`

---
#### `_mapStreamStatus`
**Arguments**: `raw: string`
**Returns**: `StreamDiagnosticsStatus`

---
#### `_buildInventorySummary`
**Arguments**: `inventory: InferenceProviderInventory`
**Returns**: `ProviderInventorySummary`

---
