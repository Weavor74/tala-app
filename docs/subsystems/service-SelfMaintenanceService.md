# Service: SelfMaintenanceService.ts

**Source**: [electron\services\SelfMaintenanceService.ts](../../electron/services/SelfMaintenanceService.ts)

## Class: `SelfMaintenanceService`

### Methods

#### `executeCommand`
Executes an npm command natively, aggregating output securely.
/

**Arguments**: `cmd: string, args: string[]`
**Returns**: `Promise<CliResult>`

---
#### `emitReflection`
**Arguments**: `event: MaintenanceReflectionEvent`

---
#### `hasProtectedMemoryWarning`
**Arguments**: `stdout: string | undefined`
**Returns**: `boolean`

---
#### `runDocsMaintenance`
**Arguments**: ``

---
#### `runCodeAudit`
**Arguments**: ``

---
#### `runMemoryAudit`
**Arguments**: ``

---
#### `runMemoryHeal`
**Arguments**: ``

---
