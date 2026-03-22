# Service: InferenceService.ts

**Source**: [electron/services/InferenceService.ts](../../electron/services/InferenceService.ts)

## Class: `InferenceService`

## Overview
Represents a local AI inference provider detected during a port scan.
 @deprecated Use InferenceProviderDescriptor from shared/inferenceProviderTypes.ts.
   The registry-based InferenceService.refreshProviders() path supersedes scanLocal().
/
export interface ScannedProvider {
    engine: 'ollama' | 'llamacpp' | 'vllm';
    endpoint: string;
    models: string[];
}

/**
 InferenceService — Canonical Inference Coordinator

 Acts as the single authoritative gate for all inference operations in TALA.

 Responsibilities:
 - Provider registry management (via InferenceProviderRegistry)
 - Deterministic provider selection and fallback (via ProviderSelectionService)
 - Lifecycle management of the embedded llama.cpp engine (via LocalInferenceManager)
 - Legacy provider scan API for backward compatibility
 - Installer flows for external providers (Ollama)

 Every inference request that touches a local provider must call
 `selectProvider()` to obtain a validated InferenceSelectionResult before
 executing. AgentService should never directly probe or switch providers.

### Methods

#### `getProviderInventory`
Returns the current provider inventory.
 Safe to call at any time; does not run probes.
/

**Arguments**: ``
**Returns**: `InferenceProviderInventory`

---
#### `refreshProviders`
Runs provider probes and refreshes the registry.
 Should be called at startup and when settings change.
/

**Arguments**: `turnId?: string, agentMode?: string`
**Returns**: `Promise<InferenceProviderInventory>`

---
#### `selectProvider`
Selects the best available provider according to the deterministic policy.
 Use this before every real inference request.
/

**Arguments**: `req: InferenceSelectionRequest = {}`
**Returns**: `InferenceSelectionResult`

---
#### `setSelectedProvider`
Sets the user-selected provider ID in the registry.
 Validated on the next selectProvider() call.
/

**Arguments**: `providerId: string | undefined`
**Returns**: `void`

---
#### `reconfigureRegistry`
Reconfigures the provider registry (e.g., when settings change).
/

**Arguments**: `config: ProviderRegistryConfig`
**Returns**: `void`

---
#### `executeStream`
Executes a streaming inference request through the canonical path.

 This is the authoritative streaming entry point for all TALA streaming requests.
 AgentService must use this method instead of calling brain.streamResponse() directly.

 Responsibilities:
 - Emits stream lifecycle telemetry (stream_opened, stream_completed, stream_aborted)
 - Emits inference lifecycle telemetry (inference_started, inference_completed, inference_failed)
 - Reports ReflectionEngine signals for failures and timeouts
 - Implements bounded fallback if stream-open fails and fallback is allowed

 @param brain - The configured brain instance (IBrain) to use for streaming.
 @param messages - Conversation messages.
 @param systemPrompt - System prompt string.
 @param onToken - Callback invoked for each streamed token.
 @param req - Stream request metadata (provider, turnId, fallback config, etc.).
 @param tools - Optional tools array.
 @param options - Optional brain options.
 @returns StreamInferenceResult with full lifecycle metadata.
/

**Arguments**: `brain: IBrain, messages: any[], systemPrompt: string, onToken: (chunk: string) => void, req: StreamInferenceRequest, tools?: any[], options?: any`
**Returns**: `Promise<StreamInferenceResult>`

---
#### `getLocalInferenceManager`
Returns the LocalInferenceManager for the embedded llama.cpp engine.
 IPC handlers and AgentService use this for embedded engine lifecycle.
/

**Arguments**: ``
**Returns**: `LocalInferenceManager`

---
#### `getLocalEngine`
Returns the legacy LocalEngineService.
 @deprecated Prefer getLocalInferenceManager() for state-managed access.
/

**Arguments**: ``
**Returns**: `LocalEngineService`

---
#### `resolveLocalInferencePython`
Resolves the best available Python executable for running the embedded
 llama_cpp.server. Prioritises the project-local inference venv, then
 falls back to bundled binaries or a system Python.

 @param repoRoot - Repository root directory (defaults to process.cwd()).
/

**Arguments**: `repoRoot?: string`
**Returns**: `string | undefined`

---
#### `killEmbedded`
Terminates the embedded llama.cpp child process if it is running.
 Safe to call multiple times; a no-op if no process was spawned.
/

**Arguments**: ``
**Returns**: `void`

---
#### `scanLocal`
Scans the host machine for active AI inference providers.

 @deprecated Use refreshProviders() + getProviderInventory() for the
   registry-based path. This method is retained for backward-compatibility
   with existing IPC handler callers.

 @returns A list of detected providers and their supported models.
/

**Arguments**: ``
**Returns**: `Promise<ScannedProvider[]>`

---
#### `installEngine`
Triggers an automated installation flow for an inference engine.
 Currently supports Ollama on Windows.
/

**Arguments**: `engineId: string, webContents?: WebContents`
**Returns**: `Promise<`

---
#### `_checkPort`
**Arguments**: `port: number`
**Returns**: `Promise<boolean>`

---
#### `_fetchOllamaModels`
**Arguments**: `endpoint: string`
**Returns**: `Promise<string[]>`

---
#### `_fetchOpenAIModels`
**Arguments**: `endpoint: string`
**Returns**: `Promise<string[]>`

---
#### `_downloadFile`
**Arguments**: `url: string, dest: string, onProgress: (progress: number) => void`
**Returns**: `Promise<void>`

---
