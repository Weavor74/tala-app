# Service: SystemModeManager.ts

**Source**: [electron\services\SystemModeManager.ts](../../electron/services/SystemModeManager.ts)

## Class: `SystemModeManager`

### Methods

#### `evaluate`
**Arguments**: `input: ModeInput`
**Returns**: `SystemModeSnapshot`

---
#### `isCapabilityAllowed`
**Arguments**: `capability: SystemCapability, snapshot: SystemModeSnapshot`
**Returns**: `boolean`

---
#### `deriveFlags`
**Arguments**: `input: ModeInput`
**Returns**: `SystemDegradationFlag[]`

---
#### `resolveEffectiveMode`
**Arguments**: `input: ModeInput, flags: SystemDegradationFlag[]`
**Returns**: `SystemOperatingMode`

---
#### `getContract`
**Arguments**: `mode: SystemOperatingMode`
**Returns**: `SystemModeContract`

---
#### `recordTransitionIfNeeded`
**Arguments**: `now: string, nextMode: SystemOperatingMode, flags: SystemDegradationFlag[],`
**Returns**: `SystemModeTransition | null`

---
