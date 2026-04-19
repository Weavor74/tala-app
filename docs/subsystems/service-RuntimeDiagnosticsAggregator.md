# Service: RuntimeDiagnosticsAggregator.ts

**Source**: [electron/services/RuntimeDiagnosticsAggregator.ts](../../electron/services/RuntimeDiagnosticsAggregator.ts)

## Class: `RuntimeDiagnosticsAggregator`

### Methods

#### `dispose`
Stops the internal TelemetryBus subscription.
 Call during teardown if the aggregator instance is being discarded.
/

**Arguments**: ``
**Returns**: `void`

---
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
#### `_buildHandoffDiagnostics`
**Arguments**: `now: string`
**Returns**: `HandoffDiagnosticsSnapshot | undefined`

---
#### `_buildPlanningMemoryDiagnostics`
**Arguments**: `now: string`
**Returns**: `PlanningMemoryDiagnosticsSnapshot | undefined`

---
#### `_buildKernelTurnDiagnostics`
**Arguments**: `now: string`
**Returns**: `KernelTurnDiagnosticsView | undefined`

---
#### `_buildMemoryAuthorityDiagnostics`
**Arguments**: `now: string`
**Returns**: `RuntimeMemoryAuthorityDiagnosticsView | undefined`

---
#### `_buildPlanExecutionDiagnostics`
**Arguments**: `now: string`
**Returns**: `PlanExecutionDiagnosticsSnapshot | undefined`

---
#### `_buildRecoveryDiagnostics`
**Arguments**: `now: string`
**Returns**: `RecoveryDiagnosticsSnapshot | undefined`

---
#### `_buildIterationTuningDiagnostics`
**Arguments**: `now: string`
**Returns**: `IterationPolicyTuningDiagnosticsSnapshot | undefined`

---
#### `_handleIterationTuningEvent`
**Arguments**: `event: string, payload?: Record<string, unknown>`
**Returns**: `void`

---
#### `_handlePlanExecutionEvent`
**Arguments**: `event: string, payload?: Record<string, unknown>`
**Returns**: `void`

---
#### `_handlePlanningMemoryEvent`
**Arguments**: `event: string, payload?: Record<string, unknown>`
**Returns**: `void`

---
#### `_handleKernelTurnEvent`
**Arguments**: `event: string, payload?: Record<string, unknown>`
**Returns**: `void`

---
#### `_handleMemoryAuthorityEvent`
**Arguments**: `event: string, payload?: Record<string, unknown>`
**Returns**: `void`

---
#### `_handleRecoveryEvent`
**Arguments**: `event: string, executionId: string, payload?: Record<string, unknown>,`
**Returns**: `void`

---
#### `_handleHandoffEvent`
**Arguments**: `event: string, payload?: Record<string, unknown>`
**Returns**: `void`

---
#### `_buildAuthorityLaneDiagnostics`
**Arguments**: `now: string`
**Returns**: `AuthorityLaneDiagnosticsSnapshot | undefined`

---
#### `_computeDegradedSubsystems`
**Arguments**: `inference: InferenceDiagnosticsState, mcp: McpInventoryDiagnostics,`
**Returns**: `string[]`

---
#### `_computeRecentFailures`
**Arguments**: `inference: InferenceDiagnosticsState, mcp: McpInventoryDiagnostics,`
**Returns**: `RuntimeFailureSummary`

---
