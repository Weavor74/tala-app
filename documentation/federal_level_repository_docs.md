# TALA Repository — Function and Module Reference

This document provides a concrete reference for the key functions, variables, and inter-file connections in the TALA repository. It supplements the architectural documentation in `docs/` with implementation-level detail.

---

## Table of Contents

- [Electron Backend Services](#electron-backend-services)
  - [AgentService](#agentservice)
  - [ToolService](#toolservice)
  - [MemoryService](#memoryservice)
  - [GuardrailService](#guardrailservice)
  - [IpcRouter](#ipcrouter)
  - [InferenceService](#inferenceservice)
  - [SettingsManager](#settingsmanager)
  - [UserProfileService](#userprofileservice)
  - [HybridMemoryManager](#hybridmemorymanager)
  - [ReflectionService](#reflectionservice)
- [Inference Adapters (Brains)](#inference-adapters-brains)
  - [OllamaBrain](#ollamabrain)
  - [CloudBrain](#cloudbrain)
- [React Frontend (Renderer)](#react-frontend-renderer)
  - [App.tsx](#apptsx)
  - [Key Components](#key-components)
- [IPC Bridge (Preload)](#ipc-bridge-preload)
- [MCP Microservices](#mcp-microservices)
- [Shared Types](#shared-types)

---

## Electron Backend Services

### AgentService

**File**: `electron/services/AgentService.ts`

The central reasoning engine. Manages the agent turn loop, constructs prompts, dispatches tool calls, and streams responses to the renderer.

| Function / Variable | Type | Description |
|---|---|---|
| `chat(message, sessionId)` | `async` | Entry point for a user message. Assembles context from memory/RAG/astro, calls the active brain, handles tool loops, and emits streaming tokens via IPC. |
| `getModelStatus()` | `public` | Returns the active model ID, engine, source, and low-fidelity flag (`isLowFidelity`). Used by `IpcRouter` to handle `get-model-status` calls. |
| `getActiveInstance()` | `private` | Returns the current `AgentInstance` from the internal session registry. |
| `activeMode` | `string` | Mirrors `SettingsManager.getActiveMode()`. Controls capability gating on each turn. |

**Connections:**
- Reads mode from `SettingsManager`.
- Calls `ToolService.executeTool()` for tool invocations.
- Calls `MemoryService.retrieve()` for memory context.
- Calls `GuardrailService.validate()` before streaming final response.
- Emits `agent:chat:stream` IPC events to the renderer.

---

### ToolService

**File**: `electron/services/ToolService.ts`

Registry and dispatcher for all executable actions. Manages both native Electron tools (file system, terminal, git) and remote MCP tools.

| Function / Variable | Type | Description |
|---|---|---|
| `executeTool(name, args)` | `async` | Looks up the tool by name and dispatches to either a native handler or a JSON-RPC call to the appropriate MCP sidecar. |
| `listTools()` | `public` | Returns the full schema of all registered tools. Used by `IpcRouter` to handle `mcp:tools:list`. |
| `registerNativeTool(name, handler)` | `public` | Registers a built-in tool implementation. |
| `mcpClients` | `Map<string, McpClient>` | Active JSON-RPC client connections keyed by server ID. |

**Connections:**
- Receives tool dispatch requests from `AgentService`.
- Manages `McpService` connections for sidecar processes.
- Returns results to `AgentService` for re-injection into the reasoning loop.

---

### MemoryService

**File**: `electron/services/MemoryService.ts`

Handles all memory retrieval operations. Coordinates queries across the relational memory graph, vector RAG index, and Mem0 long-term fact store.

| Function / Variable | Type | Description |
|---|---|---|
| `retrieve(query, userId)` | `async` | Combines results from the vector search and memory graph. Returns a ranked context array. |
| `store(content, userId)` | `async` | Persists a memory chunk to the vector store and optionally the knowledge graph. |
| `score(chunk)` | `private` | Assigns a salience score to a memory chunk based on recency, access frequency, and semantic relevance. |

**Connections:**
- Called by `AgentService` during context assembly.
- Delegates to `RagService` for vector search and to `tala-memory-graph` MCP sidecar for graph queries.
- Also see `HybridMemoryManager` which merges relational and vector memory reads.

---

### GuardrailService

**File**: `electron/services/GuardrailService.ts`

Post-inference safety layer. Validates agent output before it reaches the renderer.

| Function / Variable | Type | Description |
|---|---|---|
| `validate(output, mode)` | `async` | Checks the output against PII patterns, API key leakage, and mode-specific capability constraints. Returns a sanitized or blocked result. |
| `redact(text)` | `public` | Applies the `firewall` regex patterns to scrub sensitive data from a string. |

**Connections:**
- Called by `AgentService` after every inference step.
- Reads mode policy from `SettingsManager`.
- Uses patterns from `CodeAccessPolicy.ts` for code write restrictions.

---

### IpcRouter

**File**: `electron/services/IpcRouter.ts`

Centralized IPC message dispatcher. All `ipcMain.handle` and `ipcMain.on` registrations live here.

| IPC Channel | Handler | Description |
|---|---|---|
| `agent:chat` | `AgentService.chat()` | Routes user messages to the reasoning engine. |
| `get-model-status` | `AgentService.getModelStatus()` | Returns current model metadata. |
| `settings:get` | `SettingsManager.getAll()` | Retrieves the full settings object. |
| `settings:set` | `SettingsManager.set()` | Applies a partial settings update. |
| `settings:mode:set` | `SettingsManager.setActiveMode()` | Switches the active agent mode. |
| `mcp:tools:list` | `ToolService.listTools()` | Returns all registered tool schemas. |
| `terminal:run` | `TerminalService.exec()` | Executes a shell command (guarded by capability gating). |
| `get-functions` | `FunctionService.listFunctions()` | Lists custom user-defined functions. |
| `save-function` | `FunctionService.saveFunction()` | Persists a custom function file. |

**Connections:**
- Receives all messages from the renderer via `preload.ts`.
- Dispatches to specific services based on channel name.
- Returns results as resolved Promises.

---

### InferenceService

**File**: `electron/services/InferenceService.ts`

Manages the lifecycle of inference engines (Ollama, local llama-cpp). Emits `model-status` events when the active model changes.

| Function / Variable | Type | Description |
|---|---|---|
| `start()` | `async` | Launches the local Ollama process or verifies its availability. |
| `getActiveBrain()` | `public` | Returns the currently active `IBrain` implementation. |
| `emitModelStatus()` | `private` | Emits a `model-status` IPC event to the renderer with current model metadata. |

**Connections:**
- Managed by `electron/main.ts` at startup.
- Returns `IBrain` instances consumed by `AgentService`.
- Emits `model-status` events consumed by `App.tsx`.

---

### SettingsManager

**File**: `electron/services/SettingsManager.ts`

Single source of truth for system configuration. Reads and writes `%USERDATA%/app_settings.json` atomically.

| Function / Variable | Type | Description |
|---|---|---|
| `getAll()` | `public` | Returns the full `AppSettings` object. |
| `set(patch)` | `public` | Deep-merges the patch into current settings and persists. |
| `getActiveMode()` | `public` | Returns the current mode: `'rp' \| 'hybrid' \| 'assistant'`. |
| `setActiveMode(mode)` | `public` | Updates `agentModes.activeMode` and persists. |
| `CACHE_TTL` | `number` (2000 ms) | Identical reads within this window are served from memory. |

**Connections:**
- Read by `AgentService`, `GuardrailService`, `IpcRouter`, and the reflection pipeline.
- Write-guarded: only `setActiveMode` and `set()` mutate the config while the app is running.

---

### UserProfileService

**File**: `electron/services/UserProfileService.ts`

Manages `%USERDATA%/data/user_profile.json`. Enforces UUID-based identity, auto-generates a UUID on first boot, and extracts a PII-safe identity context for LLM use.

| Function / Variable | Type | Description |
|---|---|---|
| `load()` | `async` | Reads and validates `user_profile.json`. Generates a UUID if `userId` is absent or malformed. |
| `save(profile)` | `public` | Validates UUID format and atomically writes the profile. |
| `getFullProfile()` | `public` | Returns the complete `FullUserProfilePII` object. Never forwarded to LLMs. |
| `getUserIdentityContext()` | `public` | Returns `UserIdentityContext` (UUID + displayName + aliases). Safe for LLM prompt injection. |
| `profilePath` | `string` | Absolute path to `user_profile.json` on the local filesystem. |

**Connections:**
- Called by `AgentService` (`getUserIdentityContext`) before every turn.
- Called by `AstroService` (via `getFullProfile`) to supply DOB for ephemeris calculation.
- Profile UI at `src/renderer/components/` writes via `IpcRouter` → `UserProfileService.save()`.

---

### HybridMemoryManager

**File**: `electron/services/HybridMemoryManager.ts`

Merges query results from the relational memory graph (`tala-memory-graph`) and the vector store (`RagService`) into a unified, ranked context array.

| Function / Variable | Type | Description |
|---|---|---|
| `query(text, userId)` | `async` | Issues parallel queries to both the graph and vector layers, deduplicates overlapping results, and returns a merged ranked list. |
| `graphWeight` | `number` | Weighting factor (0–1) applied to graph results during merge scoring. |
| `vectorWeight` | `number` | Weighting factor (0–1) applied to vector results during merge scoring. |

**Connections:**
- Called by `MemoryService` as part of the context retrieval pipeline.
- Connects to `RagService` (vector) and the `tala-memory-graph` MCP sidecar (graph).
- Result is injected into the agent prompt by `AgentService`.

---

### ReflectionService

**File**: `electron/services/reflection/ReflectionService.ts`

Orchestrator for the 6-phase self-improvement pipeline. Manages the sequence from anomaly detection through patch validation to promotion and journal recording.

| Function / Variable | Type | Description |
|---|---|---|
| `runCycle()` | `async` | Executes one full reflection cycle across all 6 phases. |
| `currentPhase` | `string` | Tracks the active pipeline phase for telemetry and UI display. |
| `abortIfRisky(issue)` | `private` | Halts the cycle if `RiskEngine` scores the patch above the configured threshold. |

**Sub-services:**

| Phase | Service | File |
|---|---|---|
| 1 — OBSERVE | `SelfImprovementService` | `reflection/SelfImprovementService.ts` |
| 2 — REFLECT | `ReflectionEngine` | `reflection/ReflectionEngine.ts` |
| 3 — PATCH | `PatchStagingService` | `reflection/PatchStagingService.ts` |
| 4 — VALIDATE | `ValidationService` | `reflection/ValidationService.ts` |
| 5 — PROMOTE | `ApplyEngine` | `reflection/ApplyEngine.ts` |
| 6 — JOURNAL | `ReflectionJournalService` | `reflection/ReflectionJournalService.ts` |

**Connections:**
- Triggered by `SelfImprovementService` on log anomaly detection.
- Uses `CapabilityGating` to enforce mode-based access before any file write.
- Archives originals via `PromotionService` before applying patches.
- `RollbackEngine` can reverse any promoted patch using the generated archive manifest.

---

## Inference Adapters (Brains)

### OllamaBrain

**File**: `electron/brains/OllamaBrain.ts`

Implements `IBrain` for local Ollama inference.

| Function | Description |
|---|---|
| `chat(messages, options)` | Sends the assembled prompt to the Ollama HTTP API and streams tokens back. |
| `isAvailable()` | Checks that the Ollama daemon is reachable at its configured endpoint. |

**Connections:**
- Returned by `InferenceService.getActiveBrain()` when the active engine is `'ollama'`.
- Consumed exclusively by `AgentService`.

---

### CloudBrain

**File**: `electron/brains/CloudBrain.ts`

Implements `IBrain` for remote cloud LLM providers (OpenAI, Anthropic, etc.).

| Function | Description |
|---|---|
| `chat(messages, options)` | Forwards the prompt to the configured cloud API endpoint using the stored API key. |
| `provider` | `string` — Active cloud provider identifier (e.g., `'openai'`, `'anthropic'`). |

**Connections:**
- Activated when `SettingsManager` reports a cloud engine is selected.
- API keys are stored in `app_settings.json` under `inference` and are redacted from logs by `GuardrailService`.

---

## React Frontend (Renderer)

### App.tsx

**File**: `src/App.tsx`

Root React component. Owns top-level state, listens for IPC events from the main process, and renders the active workspace panel.

| State / Handler | Description |
|---|---|
| `activeMode` | Local state mirror of the backend mode setting. Updated on `settings:mode:set` IPC responses. |
| `modelStatus` | Local state populated by listening to the `model-status` IPC event. Drives the low-fidelity warning banner. |
| `handleModelStatus(status)` | Listener callback bound to the `model-status` event on mount; unbound on unmount. |
| `activeSession` | Currently open chat session ID. |

**Connections:**
- Communicates with the main process exclusively via `window.electronAPI` (defined by `electron/preload.ts`).
- Renders child components from `src/renderer/components/`.
- Receives `agent:chat:stream` events for token-by-token streaming into the chat view.

---

### Key Components

**Directory**: `src/renderer/components/`

| File | Purpose |
|---|---|
| `ChatSessions.tsx` | Chat session list, message rendering, input bar. Replaces the legacy `ChatContainer.tsx` reference. |
| `Terminal.tsx` | xterm.js-based terminal emulator. Dispatches `terminal:run` IPC calls. |
| `WorkflowEditor.tsx` | ReactFlow-based graph editor for composing and executing agent workflows. |
| `MemoryViewer.tsx` | Displays memory graph nodes and vector search results. |
| `ReflectionPanel.tsx` | Dashboard showing the reflection pipeline phase, proposed patches, and journal entries. |
| `LogViewerPanel.tsx` | Real-time log aggregation view from `LogViewerService`. |
| `AgentModeConfigPanel.tsx` | Mode selector (Assistant / Hybrid / RP). Dispatches `settings:mode:set`. |
| `EmotionDisplay.tsx` | Visual indicator for the Astro Engine's current emotional state vector. |
| `FileExplorer.tsx` | Browsable filesystem view using `FileService`. |
| `GitView.tsx` | Simplified Git status and diff viewer using `GitService`. |

---

## IPC Bridge (Preload)

**File**: `electron/preload.ts`

Exposes a controlled API surface on `window.electronAPI` using Electron's `contextBridge`. The renderer cannot access Node.js or Electron APIs directly.

Key exposed methods:

| Method | IPC Channel | Description |
|---|---|---|
| `chat(message)` | `agent:chat` | Sends a user message to `AgentService`. |
| `getModelStatus()` | `get-model-status` | Fetches current model metadata. |
| `getSettings()` | `settings:get` | Retrieves the full `AppSettings` object. |
| `setSettings(patch)` | `settings:set` | Applies a settings patch. |
| `setMode(mode)` | `settings:mode:set` | Changes the active agent mode. |
| `listTools()` | `mcp:tools:list` | Returns all registered tool schemas. |
| `on(event, handler)` | (listener) | Subscribes to push events from the main process (e.g., `agent:chat:stream`, `model-status`). |
| `off(event, handler)` | (listener) | Unsubscribes a push event listener. |

---

## MCP Microservices

Each service runs as an isolated child process communicating over JSON-RPC (stdio).

| Service | Entry Point | Key Functions |
|---|---|---|
| `tala-core` | `mcp-servers/tala-core/server.py` | `ingest(document)`, `search(query)` — RAG ingestion and retrieval via ChromaDB. |
| `astro-engine` | `mcp-servers/astro-engine/` | `get_emotional_state(userId, dob)` — Returns the real-time astrological emotional vector. |
| `mem0-core` | `mcp-servers/mem0-core/server.py` | `add(text, userId)`, `search(query, userId)` — Long-term fact storage and retrieval via Mem0AI. |
| `world-engine` | `mcp-servers/world-engine/server.py` | `get_context()` — Provides world-state enrichment (date, time, environment) for agent prompts. |
| `tala-memory-graph` | `mcp-servers/tala-memory-graph/main.py` | `add_node(entity)`, `query(text, userId)` — SQLite-backed entity relationship graph. |

---

## Shared Types

**File**: `electron/services/userProfileTypes.ts`

Defines the canonical user identity contracts:
- `FullUserProfilePII` — Complete PII profile stored in `user_profile.json`.
- `UserIdentityContext` — Prompt-safe subset (UUID, displayName, aliases).
- `Address`, `Job`, `School`, `Contact` — Nested profile record types.

**File**: `electron/types/artifacts.ts`

Defines the artifact routing types consumed by `ArtifactRouter.ts` for workspace tab management.
