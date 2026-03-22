# Service: LocalInferenceManager.ts

**Source**: [electron/services/LocalInferenceManager.ts](../../electron/services/LocalInferenceManager.ts)

## Class: `LocalInferenceManager`

### Methods

#### `transition`
**Arguments**: `next: LocalInferenceState, reason: string`
**Returns**: `void`

---
#### `probeReadiness`
Probes the llama.cpp /health endpoint.
 Returns true when the server reports it is ready.
/

**Arguments**: ``
**Returns**: `Promise<boolean>`

---
#### `stop`
**Arguments**: ``
**Returns**: `void`

---
#### `request`
Sends a completion request to the local inference server.

 Enforces:
 - Readiness check before invocation.
 - Configurable request timeout.
 - Bounded retry with linear delay.
 - Structured success/failure telemetry on every attempt.
/

**Arguments**: `prompt: string, modelName: string, turnId = 'global', mode = 'unknown'`
**Returns**: `Promise<InferenceRequestResult>`

---
#### `recover`
Attempts to recover from a 'failed' or 'degraded' state.
 Probes the server and, if responsive, transitions back to 'ready'.
 If not responsive, transitions to 'unavailable'.
/

**Arguments**: `turnId = 'global', mode = 'unknown'`
**Returns**: `Promise<boolean>`

---
#### `getStatus`
Returns a structured status summary for diagnostics.
/

**Arguments**: ``
**Returns**: ``

---
#### `invokeWithTimeout`
**Arguments**: `prompt: string, modelName: string`
**Returns**: `Promise<string>`

---
#### `delay`
**Arguments**: `ms: number`
**Returns**: `Promise<void>`

---
