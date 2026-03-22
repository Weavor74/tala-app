# Service: RuntimeDiagnosticsAggregator.ts

**Source**: [electron/services/RuntimeDiagnosticsAggregator.ts](../../electron/services/RuntimeDiagnosticsAggregator.ts)

## Class: `RuntimeDiagnosticsAggregator`

### Methods

#### `recordCognitiveContext`
Records the most recent cognitive context for inclusion in diagnostics snapshots.
 Called by CognitiveTurnAssembler (or AgentService) after assembling each turn.
/

**Arguments**: `context: TalaCognitiveContext`
**Returns**: `void`

---
#### `recordCognitiveMeta`
Records extended cognitive metadata for Phase 3C diagnostics.
 Call after compaction, orchestration, and assembly to capture performance data.
/

**Arguments**: `meta: Partial<Omit<CognitiveTurnMeta, 'context'>>`
**Returns**: `void`

---
#### `getSnapshot`
Returns the current normalized runtime diagnostics snapshot.
 Safe to call from IPC handlers.

 @param sessionId - Optional session ID to include in the snapshot.
/

**Arguments**: `sessionId?: string`
**Returns**: `RuntimeDiagnosticsSnapshot`

---
#### `getInferenceStatus`
Returns only the normalized inference diagnostics state.
 Used by the diagnostics:getInferenceStatus IPC handler.
/

**Arguments**: ``
**Returns**: `InferenceDiagnosticsState`

---
#### `getMcpStatus`
Returns only the normalized MCP inventory diagnostics.
 Used by the diagnostics:getMcpStatus IPC handler.
/

**Arguments**: ``
**Returns**: `McpInventoryDiagnostics`

---
#### `_buildCognitiveDiagnostics`
Builds a normalized cognitive diagnostics snapshot from the last recorded
 cognitive context. Returns undefined if no cognitive context has been recorded.
/

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
