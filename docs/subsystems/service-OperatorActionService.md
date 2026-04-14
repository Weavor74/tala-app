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
#### `getVisibilityState`
**Arguments**: ``
**Returns**: ``

---
#### `_buildDeniedResult`
**Arguments**: `action: OperatorActionId, requestedBy: string, executedAt: string, before: SystemHealthSnapshot, reason: string, affectedSubsystems: string[],`
**Returns**: `OperatorActionResultContract`

---
#### `_buildAllowedResult`
**Arguments**: `action: OperatorActionId, requestedBy: string, executedAt: string, before: SystemHealthSnapshot, after: SystemHealthSnapshot, reason: string, affectedSubsystems: string[], rollback: RollbackAvailability, details?: Record<string, unknown>,`
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
#### `_checkModeAllowance`
**Arguments**: `action: OperatorActionId, health: SystemHealthSnapshot,`
**Returns**: ``

---
