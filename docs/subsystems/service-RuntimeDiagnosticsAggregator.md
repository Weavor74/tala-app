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
#### `_buildSystemHealthSnapshot`
**Arguments**: `now: string, inference: InferenceDiagnosticsState, mcp: McpInventoryDiagnostics, recentFailures: RuntimeFailureSummary, suppressedProviders: string[],`
**Returns**: `SystemHealthSnapshot`

---
#### `_reduceOverallStatus`
**Arguments**: `entries: SystemHealthSubsystemSnapshot[]`
**Returns**: `SystemHealthOverallStatus`

---
#### `_computeTrustScore`
**Arguments**: `nowIso: string, inference: InferenceDiagnosticsState, mcp: McpInventoryDiagnostics, dbObserved: boolean, hasTelemetry: boolean,`
**Returns**: `number`

---
#### `_computeDegradedSubsystems`
**Arguments**: `inference: InferenceDiagnosticsState, mcp: McpInventoryDiagnostics,`
**Returns**: `string[]`

---
#### `_computeRecentFailures`
**Arguments**: `inference: InferenceDiagnosticsState, mcp: McpInventoryDiagnostics,`
**Returns**: `RuntimeFailureSummary`

---
