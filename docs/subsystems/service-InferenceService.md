# Service: InferenceService.ts

**Source**: [electron\services\InferenceService.ts](../../electron/services/InferenceService.ts)

## Class: `InferenceService`

## Overview
Represents a local AI inference provider detected during a port scan./
export interface ScannedProvider {
    engine: 'ollama' | 'llamacpp' | 'vllm';
    endpoint: string;
    models: string[];
}

/** Local AI Inference Orchestrator.  The `InferenceService` is responsible for detecting and managing local  LLM runners on the user's host machine. It acts as a discovery layer  that allows Tala to use various backends (Ollama, Llama.cpp, vLLM)  without manual configuration.  **Core Responsibilities:** - **Provider Discovery**: Scans standard ports (11434, 8080, 1234) to    identify active inference engines and their available models. - **Built-in Management**: Controls the lifecycle of the internal    `LocalEngineService` (bundled Llama.cpp). - **Streamlined Installation**: Provides automated download and launch    flows for external runners like Ollama. - **Audit Integration**: Logs detection results for system transparency.

### Methods

#### `checkPort`
**Arguments**: `port: number`
**Returns**: `Promise<boolean>`

---
#### `fetchOllamaModels`
**Arguments**: `endpoint: string`
**Returns**: `Promise<string[]>`

---
#### `fetchOpenAIModels`
**Arguments**: `endpoint: string`
**Returns**: `Promise<string[]>`

---
#### `getLocalEngine`
**Arguments**: ``
**Returns**: `LocalEngineService`

---
#### `scanLocal`
Scans the host machine for active AI inference providers.  **Probing Sequence:** 1. **Built-in**: Checks the internal `llamacpp` engine status. 2. **Ollama**: Probes port 11434 and fetches available tags. 3. **Llama.cpp/LocalAI**: Probes port 8080 for OpenAI-compatible endpoints. 4. **LM Studio/vLLM**: Probes port 1234 for OpenAI-compatible endpoints.  All results are aggregated into `ScannedProvider` objects and logged  to the `AuditLogger`.  @returns A list of detected providers and their supported models./

**Arguments**: ``
**Returns**: `Promise<ScannedProvider[]>`

---
#### `installEngine`
Triggers an automated installation flow for an inference engine.  Currently supports **Ollama** on Windows.  **Workflow:** 1. Downloads the installer to the system temp directory. 2. Emits `install-progress` events to the UI. 3. Spawns the installer process in detached mode.  @param engineId - The ID of the engine to install (e.g., 'ollama'). @param webContents - Optional Electron window for sending progress updates./

**Arguments**: `engineId: string, webContents?: WebContents`
**Returns**: `Promise<`

---
#### `downloadFile`
**Arguments**: `url: string, dest: string, onProgress: (progress: number) => void`
**Returns**: `Promise<void>`

---
