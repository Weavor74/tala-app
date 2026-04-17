# Service: LocalEngineService.ts

**Source**: [electron\services\LocalEngineService.ts](../../electron/services/LocalEngineService.ts)

## Class: `LocalEngineService`

## Overview
Local LLM Engine Service  Manages the lifecycle and orchestration of the built-in llama.cpp server. This service enables TALA's "Offline Mode" by running GGUF models locally, and provides facilities for automatic model and binary downloads.  **Security & Portability:** - Operates entirely offline (no telemetry to external AI providers). - Manages portable Python and binary runtimes for zero-install execution. - Enforces context window constraints and GPU acceleration settings.

### Methods

#### `findBinary`
Attempts to locate the llama-server binary across common locations and extensions./

**Arguments**: ``
**Returns**: `string`

---
#### `ignite`
Spawns the llama.cpp server with the specified model and options./

**Arguments**: `modelPath: string, options: { port?: number; contextSize?: number; gpus?: number } = {}`
**Returns**: `Promise<void>`

---
#### `extinguish`
Shuts down the local engine./

**Arguments**: ``
**Returns**: `void`

---
#### `downloadBinary`
Downloads the appropriate llama-server binary for the current platform./

**Arguments**: `onProgress: (progress: number) => void`
**Returns**: `Promise<string>`

---
#### `downloadModel`
Downloads a default GGUF model./

**Arguments**: `onProgress: (progress: number) => void`
**Returns**: `Promise<string>`

---
#### `downloadPython`
Downloads a portable Python runtime for the current platform./

**Arguments**: `onProgress: (progress: number) => void`
**Returns**: `Promise<string>`

---
#### `downloadFile`
**Arguments**: `url: string, dest: string, onProgress: (progress: number) => void`
**Returns**: `Promise<void>`

---
#### `getStatus`
**Arguments**: ``

---
#### `ensureReady`
**Arguments**: ``
**Returns**: `Promise<boolean>`

---
