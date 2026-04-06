# Component Model

This document describes the Tala system as a collection of interacting components, mapping their logical roles to physical source locations.

## 1. Core Runtime Components

### AgentKernel *(top-level execution shell)*
- **Path**: `electron/services/kernel/AgentKernel.ts`
- **Purpose**: Stable top-level execution shell and primary entrypoint for all Tala runtime turns.
  Coordinates the full lifecycle of each turn through a 5-stage pipeline without replacing any
  downstream subsystem. All substantive work is delegated to `AgentService.chat()`.
- **Pipeline stages**: `normalizeRequest → intake → classifyExecution → runDelegatedFlow → finalizeExecution`
- **Inputs**: `KernelRequest` (`userMessage`, optional `images` and `capabilitiesOverride`).
- **Outputs**: `KernelResult` (extends `AgentTurnOutput` with `meta: KernelExecutionMeta`).
- **Future responsibility boundaries**:
  - `normalizeRequest`: request ACL, payload coercion
  - `intake`: execution budget checks, authority pre-validation
  - `classifyExecution`: mode detection, tool-need prediction, policy gate, context assembly trigger
  - `runDelegatedFlow`: inference orchestration boundary, tool execution coordination, memory write coordination
  - `finalizeExecution`: telemetry emission, outcome learning hooks, audit record writes
- **Initialized by**: `IpcRouter.registerAll()` as `this._kernel = new AgentKernel(agent)`.
- **Invoked by**: `IpcRouter` on every `chat-message` IPC event.

### Electron Main Process
- **Path**: `electron/main.ts`
- **Purpose**: Acts as the host for all backend services and manages the application window.
- **Inputs**: OS events, lifecycle signals.
- **Outputs**: Browser windows, IPC event emission.
- **Lifecycle**: Starts on application launch; terminates all sidecar processes on exit.

### Agent Service
- **Path**: `electron/services/AgentService.ts`
- **Purpose**: The "Reasoning Engine". Coordinates the turn loop, prompt construction, and tool execution.
- **Inputs**: User messages, tool results, memory context.
- **Outputs**: Agent thoughts, tool requests, final responses.
- **Dependencies**: `ToolService`, `OllamaBrain`, `GuardrailService`.

### Tool Service
- **Path**: `electron/services/ToolService.ts`
- **Purpose**: Registry and dispatcher for all executable actions. Handles both native Electron tools and remote MCP tools.
- **Inputs**: Tool names and arguments.
- **Outputs**: Result data or error messages.
- **Dependencies**: MCP Client, local file system modules.
- **P7A Note**: `setMemoryService(memory, getCanonicalId?)` accepts an optional authority callback. When wired (by AgentService), the `mem0_add` tool calls `getCanonicalId` to obtain a `canonical_memory_id` from MemoryAuthorityService before writing to the derived mem0 store.

## 2. Inference Pipeline

### InferenceService
- **Path**: `electron/services/InferenceService.ts`
- **Purpose**: Canonical inference coordinator. Single entry point for all provider detection, selection, and embedded engine lifecycle.
- **Inputs**: Provider registry config, selection requests from AgentService.
- **Outputs**: InferenceSelectionResult (selected provider + fallback chain), provider inventory for UI/IPC.
- **Dependencies**: `InferenceProviderRegistry`, `ProviderSelectionService`, `LocalInferenceManager`, `LocalEngineService`.
- **Note**: Every brain configuration decision in `AgentService` goes through `InferenceService.selectProvider()`.

### InferenceProviderRegistry
- **Path**: `electron/services/inference/InferenceProviderRegistry.ts`
- **Purpose**: Source of truth for all known inference providers and their runtime status. Runs provider probes and maintains the provider inventory.
- **Provider types**: `ollama`, `llamacpp`, `embedded_llamacpp`, `vllm`, `koboldcpp`, `cloud`.
- **Probe behaviour**: Failed probes for one provider never block other providers. All probe events emit structured telemetry.
- **Outputs**: `InferenceProviderInventory` (descriptor list, selected provider ID, last refreshed).

### ProviderSelectionService
- **Path**: `electron/services/inference/ProviderSelectionService.ts`
- **Purpose**: Deterministic provider selection and fallback policy.
- **Selection order**:
  1. User-selected provider if ready
  2. Fallback (with telemetry) if selected provider is unavailable
  3. Best available local provider by priority
  4. Embedded llama.cpp
  5. Cloud provider
  6. Explicit failure — no silent unknown-provider selection
- **Outputs**: `InferenceSelectionResult` (selected provider, reason, fallbackApplied, attemptedProviders).

### LocalInferenceManager
- **Path**: `electron/services/LocalInferenceManager.ts`
- **Purpose**: Hardened lifecycle manager for the embedded llama.cpp engine. Implements state machine, readiness checks, timeout enforcement, bounded retry, and recovery.
- **States**: `disabled → starting → ready → busy → degraded → unavailable → failed`
- **Role in inference path**: Authoritative for embedded provider readiness. `InferenceService.getLocalInferenceManager()` exposes it for IPC handlers.

## 3. Inference Adapters (Brains)

### Ollama Brain
- **Path**: `electron/brains/OllamaBrain.ts`
- **Purpose**: Adapter for local Ollama instances.
- **Inputs**: Chat history, system instructions.
- **Outputs**: Text/JSON streams from the local LLM.

### Cloud Brain
- **Path**: `electron/brains/CloudBrain.ts`
- **Purpose**: Interface for external LLM providers (e.g., Anthropic, OpenAI).

## 3. MCP Service Layer (Sidecars)

### Tala Core (RAG)
- **Path**: `mcp-servers/tala-core/`
- **Purpose**: Primary Retrieval Augmented Generation (RAG) engine.
- **Inputs**: Document ingestion requests, search queries.
- **Outputs**: Context chunks, document metadata.
- **Technologies**: Python, Sentence-Transformers, ChromaDB/SQLite.

### Astro Engine
- **Path**: `mcp-servers/astro-engine/`
- **Purpose**: Calculates the agent's astrological "emotional state" based on real-time ephemeris data.
- **Logic**: Injects emotional vectors into the agent's system prompt to influence personality.

### Mem0 Core
- **Path**: `mcp-servers/mem0-core/`
- **Purpose**: Long-term fact and preference storage.
- **Inputs**: Interaction text.
- **Outputs**: Retrieved facts for personalization.

## 4. Frontend (Renderer)

### React Application
- **Path**: `src/`
- **Purpose**: User interaction and visualization layer.
- **Components**:
    - `Terminal.tsx`: Live command execution view.
    - `WorkflowEditor.tsx`: Graph-based workflow management.
    - `ChatContainer.tsx`: Central message handling.
- **Dependencies**: Electron Preload (IPC Bridge).

## 5. Policy and Enforcement Layer

### PolicyGate
- **Path**: `electron/services/policy/PolicyGate.ts`
- **Purpose**: Lightweight runtime enforcement stub that provides a single, consistent place to check whether an action should be allowed before any side effects occur. Returns a `PolicyDecision` (`allowed`, `reason`, `code`, optional `metadata`).
- **Design**: Stateless and deterministic. Currently implements a permissive allow-all stub so wiring the gate into call sites produces no behavioural change. Rules are added here incrementally; existing callers automatically gain enforcement once rules are present.
- **Public API**:
  - `evaluate(context: PolicyContext): PolicyDecision` — full decision with reason and code.
  - `isAllowed(context: PolicyContext): boolean` — convenience boolean wrapper.
  - `assertAllowed(context: PolicyContext): void` — throws `PolicyDeniedError` on deny.
- **Singleton**: `policyGate` (module-level export, stateless so sharing is safe).
- **Error type**: `PolicyDeniedError` — extends `Error`, carries the originating `PolicyDecision`.
- **Extension path**: Add named rule methods (e.g. `checkMemoryWrite`, `checkToolInvocation`) that delegate to `evaluate()` as the policy system matures. Domain-specific gates (`AutonomyPolicyGate`, `AdaptivePolicyGate`) remain separate.

## 6. Storage Layer

### Local Filesystem
- **Path**: `data/`
- **Purpose**: Storage for `agent_profiles.json`, user settings, and application logs.

### Memory Store
- **Path**: `memory/` (Logical)
- **Purpose**: Hosts SQLite databases for the knowledge graph and vector stores for RAG.

## 7. Memory Authority Layer (P7A)

### MemoryAuthorityService
- **Path**: `electron/services/memory/MemoryAuthorityService.ts`
- **Purpose**: The only write gateway for all canonical persistent memory. Enforces PostgreSQL as the single source of truth. Provides duplicate detection, lineage tracking, integrity validation, and rebuild orchestration.
- **Inputs**: `ProposedMemoryInput` from any caller.
- **Outputs**: `canonical_memory_id` (UUID), `IntegrityReport`, `RebuildReport`.
- **Dependencies**: PostgreSQL pool (`memory_records`, `memory_lineage`, `memory_projections`, `memory_integrity_issues`).

### derivedWriteGuards
- **Path**: `electron/services/memory/derivedWriteGuards.ts`
- **Purpose**: Enforcement utilities that prevent derived systems (mem0, graph, vector, local JSON) from persisting durable memory without a canonical anchor.
- **Key functions**:
  - `assertDerivedMemoryAnchor(anchor, source)` — throws in strict mode, warns in production when `canonical_memory_id` is absent.
  - `rankMemoryByAuthority(candidates[])` — deterministic 4-tier priority: `canonical > verified_derived > transient > speculative`.
  - `resolveMemoryAuthorityConflict(canonical, derived, source)` — canonical always wins; conflict logged for diagnostics.
- **Integration**: Called by `MemoryService.add()` and by any new derived write site.
