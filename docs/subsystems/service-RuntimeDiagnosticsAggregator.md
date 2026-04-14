# Service: RuntimeDiagnosticsAggregator.ts

**Source**: [electron\services\RuntimeDiagnosticsAggregator.ts](../../electron/services/RuntimeDiagnosticsAggregator.ts)

## Class: `RuntimeDiagnosticsAggregator`

### Methods

#### `recordCognitiveContext`
**Arguments**: `context: TalaCognitiveContext`
**Returns**: `void`

---
#### `recordCognitiveMeta`
**Arguments**: `meta: Partial<Omit<CognitiveTurnMeta, 'context'>>`
**Returns**: `void`

---
#### `getSnapshot`
**Arguments**: `sessionId?: string`
**Returns**: `RuntimeDiagnosticsSnapshot`

---
#### `getSystemHealthSnapshot`
**Arguments**: `sessionId?: string`
**Returns**: `SystemHealthSnapshot`

---
#### `getSystemModeSnapshot`
**Arguments**: `sessionId?: string`
**Returns**: ``

---
#### `isCapabilityAllowed`
**Arguments**: `capability: SystemCapability, sessionId?: string,`
**Returns**: ``

---
#### `getOperatorModeOverride`
**Arguments**: ``
**Returns**: ``

---
#### `getInferenceStatus`
**Arguments**: ``
**Returns**: `InferenceDiagnosticsState`

---
#### `getMcpStatus`
**Arguments**: ``
**Returns**: `McpInventoryDiagnostics`

---
#### `_buildCognitiveDiagnostics`
**Arguments**: `now: string`
**Returns**: `CognitiveDiagnosticsSnapshot | undefined`

---
#### `_computeDegradedSubsystems`
**Arguments**: `inference: InferenceDiagnosticsState, mcp: McpInventoryDiagnostics,`
**Returns**: `string[]`

---
#### `_computeRecentFailures`
**Arguments**: `inference: InferenceDiagnosticsState, mcp: McpInventoryDiagnostics,`
**Returns**: `RuntimeFailureSummary`

---
