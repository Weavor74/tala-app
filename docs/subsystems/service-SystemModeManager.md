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
#### `getOperatorModeOverride`
**Arguments**: ``
**Returns**: ``

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
**Arguments**: `now: string, nextMode: SystemOperatingMode, flags: SystemDegradationFlag[], input: ModeInput,`
**Returns**: `SystemModeTransition | null`

---
#### `deriveTransitionReasonCodes`
Deterministic transition reason-code derivation.
 Invariant: identical input + prior mode always yields identical reason_codes.
/

**Arguments**: `nextMode: SystemOperatingMode, flags: SystemDegradationFlag[], input: ModeInput,`
**Returns**: `string[]`

---
