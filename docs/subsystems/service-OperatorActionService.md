# Service: OperatorActionService.ts

**Source**: [electron\services\OperatorActionService.ts](../../electron/services/OperatorActionService.ts)

## Class: `OperatorActionService`

### Methods

#### `executeAction`
**Arguments**: `request: OperatorActionRequest`
**Returns**: `Promise<OperatorActionResultContract>`

---
#### `getActionHistory`
**Arguments**: ``
**Returns**: `OperatorActionResultContract[]`

---
#### `getAutoRepairHistory`
**Arguments**: ``
**Returns**: `OperatorActionResultContract[]`

---
#### `executeAutoAction`
**Arguments**: `action: OperatorActionId, params?: Record<string, unknown>, requestedBy: string = 'system_auto_repair',`
**Returns**: `Promise<OperatorActionResultContract>`

---
#### `getVisibilityState`
**Arguments**: ``
**Returns**: ``

---
#### `getAvailableActions`
Returns backend-evaluated operator action availability for the dashboard. Invariant: computed from canonical health/mode/policy state only./

**Arguments**: ``
**Returns**: `OperatorActionAvailability[]`

---
#### `_buildDeniedResult`
**Arguments**: `action: OperatorActionId, requestedBy: string, executedAt: string, before: SystemHealthSnapshot, reason: string, affectedSubsystems: string[], actionExecutionId: string = uuidv4(), source: OperatorActionSource = 'operator',`
**Returns**: `OperatorActionResultContract`

---
#### `_buildAllowedResult`
**Arguments**: `action: OperatorActionId, requestedBy: string, executedAt: string, before: SystemHealthSnapshot, after: SystemHealthSnapshot, reason: string, affectedSubsystems: string[], rollback: RollbackAvailability, details?: Record<string, unknown>, actionExecutionId: string = uuidv4(), source: OperatorActionSource = 'operator',`
**Returns**: `OperatorActionResultContract`

---
#### `_retryHealthFor`
**Arguments**: `target: string`
**Returns**: `Promise<string[]>`

---
#### `_retryToolConnectorInitialization`
**Arguments**: ``
**Returns**: `Promise<Record<string, unknown>>`

---
#### `_flushStalledQueues`
**Arguments**: ``
**Returns**: `Promise<Record<string, unknown>>`

---
#### `_openEvidenceTrail`
**Arguments**: `params?: Record<string, unknown>`
**Returns**: `Promise<Record<string, unknown>>`

---
#### `_isSelfImprovementAction`
**Arguments**: `action: OperatorActionId`
**Returns**: `boolean`

---
#### `_emitAuditRecord`
**Arguments**: `result: OperatorActionResultContract`
**Returns**: `void`

---
#### `_recordActionResult`
**Arguments**: `result: OperatorActionResultContract`
**Returns**: `void`

---
#### `_checkModeAllowance`
**Arguments**: `action: OperatorActionId, health: SystemHealthSnapshot,`
**Returns**: ``

---
