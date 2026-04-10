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
  - `classifyExecution`: PolicyGate top-level admission check, mode detection, context assembly trigger
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

### ToolExecutionCoordinator
- **Path**: `electron/services/tools/ToolExecutionCoordinator.ts`
- **Purpose**: Primary live seam for all tool execution. Delegates to `ToolService.executeTool()` and owns: (1) PolicyGate pre-execution check when `ctx.enforcePolicy === true`; (2) execution timing (`durationMs`); (3) TelemetryBus event emission; (4) normalized `ToolInvocationResult` output.
- **Inputs**: Tool name, args, optional turn-scoped allowlist (forwarded to ToolService), optional `ToolInvocationContext`.
- **Outputs**: `ToolInvocationResult` — `{ success, toolName, data?, error?, durationMs?, timedOut? }`. `data` carries the raw ToolService return value. Callers that need the raw result access it via `.data`.
- **Policy gate**: When `ctx.enforcePolicy === true`, calls `policyGate.assertSideEffect({ actionKind: 'tool_invoke', ...ctx })` before any telemetry or execution. A `PolicyDeniedError` propagates to the caller unchanged with no telemetry emitted.
- **Execution timing**: `startTime = Date.now()` captured after the policy check; `durationMs = Date.now() - startTime` computed on both success and failure paths.
- **Telemetry**: Emits three `TelemetryBus` events per invocation (subsystem `'tools'`):
  - `tool.requested` — emitted after policy passes, before `ToolService` is called. Payload: `{ toolName, executionType, executionOrigin, executionMode }`.
  - `tool.completed` — emitted on success. Payload adds `durationMs`.
  - `tool.failed` — emitted on error. Payload adds `durationMs` and `error` message. Error is re-thrown after emission.
- **Execution context**: `ToolInvocationContext` carries `executionId`, `executionType`, `executionOrigin`, `executionMode`. The main LLM call site in AgentService sets `executionId=turnId`, `executionType='chat_turn'`, `executionOrigin='ipc'`.
- **Instantiated by**: `AgentService` constructor as `this.coordinator = new ToolExecutionCoordinator(this.tools)`.
- **Live call sites in AgentService**:
  - Fast-path deterministic bypass — accesses `.data` from result; `enforcePolicy` omitted (fast path already guards `activeMode !== 'rp'`)
  - Main LLM tool-call loop — accesses `.data` from result; passes full context with `enforcePolicy: true`
  - Public `AgentService.executeTool()` API — returns `.data` directly; passes minimal context (`executionType='direct_invocation'`, `executionOrigin='api'`); `enforcePolicy` omitted

### WorkflowRegistry
- **Path**: `electron/services/router/WorkflowRegistry.ts`
- **Purpose**: Deterministic MCP-triggered workflow executor. Maintains a registry of named multi-step `WorkflowDefinition`s and executes them sequentially via `ToolService`. Returns a Markdown summary log per run.
- **Inputs**: Workflow ID, optional initial args, optional `executionMode` (defaults to `'system'`).
- **Outputs**: Markdown string summary of the execution.
- **Pre-registered workflows**: `repo_audit` (runs `npm run repo:check` + `npm run code:check` via `shell_run`), `docs_selfheal` (runs `npm run docs:selfheal` via `shell_run`).
- **Policy gate**: `policyGate.assertSideEffect({ actionKind: 'workflow_action', executionMode, targetSubsystem: 'workflow', mutationIntent: 'mcp_node_execute:<tool>' })` is called before every step's `toolDef.execute()`. `PolicyDeniedError` is re-thrown from the per-step catch block so callers receive the denial directly.
- **executionMode default**: Defaults to `'system'` because MCP-triggered workflows run outside any user chat session and have no ambient runtime mode. Callers with a real mode (e.g. from `getActiveMode()`) should pass it explicitly to enable accurate policy evaluation.
- **Failure behaviour**: First step failure halts the loop (subsequent steps are skipped). `PolicyDeniedError` is not treated as a step failure and always propagates.
- **Initialized by**: `AgentService` constructor as `this.workflows = new WorkflowRegistry(this.tools)`.

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
- **Provider policy** (implemented in `provider_resolver.py`):
  1. **ollama** — used when the Python `ollama` library is importable and the Ollama HTTP service is reachable.
  2. **embedded_vllm** — used when Ollama is unavailable; routes LLM and embedder through the vLLM OpenAI-compatible endpoint (default `http://127.0.0.1:8000`, overridable via `TALA_VLLM_ENDPOINT`).
  3. **degraded** — active only when neither Ollama nor embedded vLLM is reachable; server stays alive and returns safe empty/error responses.
- **Invariants**: Ollama is optional. Missing Ollama never causes an interactive prompt or `sys.exit`. No llama.cpp embedded-backend assumption remains; the embedded local target is vLLM.

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

## 8. Memory Integrity and Repair Layer

### MemoryIntegrityPolicy
- **Path**: `electron/services/memory/MemoryIntegrityPolicy.ts`
- **Purpose**: Pure, stateless evaluator that classifies overall memory subsystem health from capability flags. Produces `MemoryHealthStatus` with state, capability flags, failure reasons, and enforcement directives (`hardDisabled`, `shouldTriggerRepair`).
- **Inputs**: `canonicalReady`, `mem0Ready`, `resolvedMode`, `extractionEnabled`, `embeddingsEnabled`, `graphAvailable`, `ragAvailable`, `integrityMode`.
- **Outputs**: `MemoryHealthStatus` — serialisable, deterministic, used by `MemoryService.getHealthStatus()`.

### MemoryRepairTriggerService
- **Path**: `electron/services/memory/MemoryRepairTriggerService.ts`
- **Purpose**: Lightweight signal emitter. Emits `memory.repair_trigger` events via `TelemetryBus` when `MemoryHealthStatus.shouldTriggerRepair = true`. Maintains a 30s de-duplication window per failure reason to prevent event flooding.
- **Called by**: `MemoryService.getHealthStatus()` after each evaluation.
- **Emits**: `memory.repair_trigger` (payload: `MemoryRepairTrigger`).

### MemoryRepairExecutionService
- **Path**: `electron/services/memory/MemoryRepairExecutionService.ts`
- **Purpose**: Bounded repair executor that consumes `memory.repair_trigger` events and attempts deterministic, serially-executed recovery actions. Stops when health is acceptable (`healthy` or `reduced`). Deferred work is drained only when canonical memory is confirmed healthy.
- **Inputs**: Injected health status provider (`setHealthStatusProvider`), registered `RepairActionHandler` callbacks per action kind, optional deferred-work drain callback.
- **Repair action kinds**: `reconnect_canonical`, `reinit_canonical`, `reconnect_mem0`, `re_resolve_providers`, `reconnect_graph`, `reconnect_rag`, `drain_deferred_work`, `re_evaluate_health`.
- **Invariants**:
  - Maximum 3 attempts per action across all cycles (attempt cap).
  - Minimum 30s cooldown between cycles for the same failure reason.
  - Maximum 10 repair cycles per rolling hour (storm prevention).
  - Strict-mode hard-disable: if `hardDisabled = true` and `state = disabled` from a non-canonical reason, the cycle returns `failed` immediately rather than partially recovering.
- **Emits**: `memory.repair_started`, `memory.repair_action_started`, `memory.repair_action_completed`, `memory.repair_completed` via `TelemetryBus`.
- **Singleton**: `MemoryRepairExecutionService.getInstance()` with `reset()` for tests.
- **Deferred work drain**: `setDeferredWorkDrainCallback(cb: () => Promise<void> | void)` accepts an async callback; the callback is awaited so telemetry from the drain is captured before the cycle completes.

### DeferredMemoryWorkRepository
- **Path**: `electron/services/db/DeferredMemoryWorkRepository.ts`
- **Purpose**: Data-access layer for the `deferred_memory_work` Postgres table (migration 012). Provides `enqueue`, `claimBatch` (atomic UPDATE…RETURNING with FOR UPDATE SKIP LOCKED), `markCompleted`, `markFailed` (with exponential backoff and dead-letter promotion), `getStats`, and `countPending`.
- **Work kinds**: `extraction`, `embedding`, `graph_projection`.
- **Work statuses**: `pending`, `in_progress`, `completed`, `failed`, `dead_letter`.
- **Constructed with**: shared `Pool` (same pool used by PostgresMemoryRepository and other DB repositories).

### DeferredMemoryReplayService
- **Path**: `electron/services/memory/DeferredMemoryReplayService.ts`
- **Purpose**: Bounded, policy-gated replay executor for deferred memory work. Drains pending items from the persistent queue in batches, respecting capability availability from `MemoryHealthStatus`.
- **Inputs**: Injected `DeferredMemoryWorkRepository` (`setRepository`), health status provider (`setHealthStatusProvider`), per-kind `DeferredWorkHandler` callbacks (`registerHandler`).
- **drain() invariants**:
  - No replay when `canonical` capability is false.
  - Only `extraction` items replayed when `health.capabilities.extraction = true`.
  - Only `embedding` items replayed when `health.capabilities.embeddings = true`.
  - Only `graph_projection` items replayed when `health.capabilities.graphProjection = true`.
  - Default batch size: 25 items. Concurrent drain calls are no-ops (guarded by `_draining` flag).
  - Items with no registered handler are failed with `no_handler_registered` error.
  - Handler errors are caught; failed items are retried with exponential backoff (30s × 2^attempt, capped at 1 hour) up to `maxAttempts` (default 3), then dead-lettered.
- **Wiring** (AgentService._wireRepairExecutor):
  - `executor.setDeferredWorkDrainCallback(() => DeferredMemoryReplayService.getInstance().drain())`.
- **Enqueue** (AgentService.storeMemories suppressed write paths):
  - `extraction` enqueued when `!memHealth.capabilities.extraction` during mem0 write suppression.
  - `embedding` enqueued when `!memHealth.capabilities.embeddings` after a successful canonical write.
  - `graph_projection` enqueued when `!allowGraphWrite` during graph write suppression.
- **Emits**: `memory.deferred_work_enqueued`, `memory.deferred_work_drain_started`, `memory.deferred_work_item_completed`, `memory.deferred_work_item_failed`, `memory.deferred_work_drain_completed` via `TelemetryBus`.
- **Singleton**: `DeferredMemoryReplayService.getInstance()` with `reset()` for tests.

---

## Repair Learning Layer (Phase 9+)

The repair learning layer sits above the existing repair execution stack and accumulates structured history of all repair events, detects recurring failure patterns, and synthesises actionable recommendations for reflection and self-maintenance systems.

### MemoryRepairOutcomeRepository
- **Path**: `electron/services/db/MemoryRepairOutcomeRepository.ts`
- **Purpose**: Data-access layer for the `memory_repair_outcomes` Postgres table (migration 013). Persists all significant repair-related lifecycle events. Provides read methods for analytics queries.
- **Event types stored**: `repair_trigger`, `repair_cycle`, `repair_action`, `health_transition`, `deferred_replay`, `dead_letter`.
- **Write path**: `append(input)` — fire-and-forget, returns `null` on DB error so callers in the repair hot-path are never blocked.
- **Read methods**:
  - `countTriggers` / `countCycles` — aggregate counts within a time window.
  - `getReasonCounts` — recurring failure reason aggregates.
  - `getActionOutcomeCounts` — per-action outcome counts for effectiveness analysis.
  - `getCycleOutcomeCounts` — cycle outcome distribution.
  - `getReplayCounts` — deferred-replay success/failure counts.
  - `getDeadLetterHalves` — dead-letter counts split by early/late half of window (growth detection).
  - `getHealthTransitions` — ordered health-state transition rows.
  - `countFailedCycles`, `getDegradedHours`, `getEscalationCandidateReasons` — escalation inputs.
- **Constructed with**: shared `Pool`.
- **Wiring** (`AgentService._wireRepairExecutor`): constructed alongside `DeferredMemoryWorkRepository` when a pool is available; injected into both `MemoryRepairExecutionService.setOutcomeRepository()` and `MemoryRepairTriggerService.setOutcomeRepository()`. Additionally, a single `TelemetryBus` subscriber is registered in `_wireRepairExecutor` to persist the remaining event types centrally: `memory.health_transition` → `health_transition`, `memory.deferred_work_drain_started` / `memory.deferred_work_drain_completed` / `memory.deferred_work_item_failed` → `deferred_replay`, and `memory.deferred_dead_lettered` → `dead_letter`. All subscriber appends are fire-and-forget so persistence failures never block repair or chat execution.

### MemoryRepairAnalyticsService
- **Path**: `electron/services/memory/MemoryRepairAnalyticsService.ts`
- **Purpose**: Reads from `MemoryRepairOutcomeRepository` and produces a `MemoryRepairInsightSummary` describing patterns in the given time window. Deterministic: same data + window = same output.
- **Inputs**: `MemoryRepairOutcomeRepository` (injected), optional `AnalyticsThresholds` override.
- **Output**: `MemoryRepairInsightSummary` — includes `recurrentFailures`, `actionEffectiveness`, `queueBehavior`, `escalationCandidates`, `trajectories`.
- **Invariants**:
  - Read-only — does not write to DB or emit telemetry.
  - All queries bounded by time window (default 24 hours).
  - Thresholds are constants with safe defaults (`recurringFailureMinCount = 2`, `escalationReasonThreshold = 3`, `escalationFailedCyclesThreshold = 3`, `escalationDegradedHoursThreshold = 1h`).

### MemoryRepairReflectionService
- **Path**: `electron/services/memory/MemoryRepairReflectionService.ts`
- **Purpose**: Synthesises a `MemoryRepairReflectionReport` from a `MemoryRepairInsightSummary`. Converts analytics findings into prioritised, evidence-backed `MemoryRepairRecommendation` objects for consumption by reflection dashboards and self-maintenance systems.
- **Input**: `MemoryRepairInsightSummary` (from `MemoryRepairAnalyticsService.generateSummary()`).
- **Output**: `MemoryRepairReflectionReport` — includes ordered `recommendations[]` and `hasCriticalFindings`.
- **Recommendation codes**: `investigate_subsystem`, `review_repair_action`, `drain_dead_letter_queue`, `extend_analysis_window`, `escalate_to_maintenance`, `monitor_trajectory`.
- **Invariants**:
  - Synchronous and pure — does not query DB directly.
  - Deterministic: same summary → same report.
  - Max recommendations per report is configurable (default 10).
  - Does not modify settings, provider config, or trigger repair actions. This layer observes and recommends only.
- **Emits**: `memory.repair_reflection_generated` via `TelemetryBus`.

### Shared types: MemoryRepairInsights.ts
- **Path**: `shared/memory/MemoryRepairInsights.ts`
- **Exports**: `MemoryRepairOutcomeRecord`, `MemoryRepairOutcomeEventType`, `MemoryRepairInsightSummary`, `MemoryRepairReflectionReport`, `MemoryRepairRecommendation`, `RecurringFailure`, `ActionEffectivenessEntry`, `QueueBehaviorSummary`, `EscalationCandidate`, `RepairTrajectory`.
- **Lives in `shared/`** so the renderer (e.g. reflection dashboard) can import insight types without depending on Node.js-only data layer.

### Persistence integration
- **`MemoryRepairExecutionService`**: calls `_persistCycleOutcome` in `_finalizeCycle()` and `_persistActionOutcome` after each real action via `setOutcomeRepository()`. Fire-and-forget; errors are caught and logged.
- **`MemoryRepairTriggerService`**: calls `_persistTrigger` inside `_recordTrigger()` via `setOutcomeRepository()`. Fire-and-forget; errors are caught and logged.
- **Runtime wiring**: `AgentService._wireRepairExecutor()` constructs `MemoryRepairOutcomeRepository(pool)` when a pool is available and injects it into both services via `setOutcomeRepository()`.
- **New telemetry events**: `memory.repair_outcome_persisted`, `memory.repair_reflection_generated` added to `RuntimeEventType` in `shared/runtimeEventTypes.ts`.

---

## Scheduled Memory Repair Loop

The scheduled loop consumes the repair learning output on a fixed cadence and takes bounded, threshold-driven maintenance actions.  See `docs/architecture/memory_repair_scheduler.md` for full details.

### MemorySelfMaintenanceService
- **Path**: `electron/services/memory/MemorySelfMaintenanceService.ts`
- **Purpose**: Pure, synchronous decision layer.  Consumes `MemoryRepairInsightSummary` and `MemoryRepairReflectionReport` and returns a `MemoryMaintenanceDecision` describing what actions, if any, should be taken.
- **Inputs**: `MemoryRepairInsightSummary`, `MemoryRepairReflectionReport`, optional `SelfMaintenanceThresholds`.
- **Output**: `MemoryMaintenanceDecision` — includes `posture`, boolean flags, and an ordered `actions[]` list.
- **Posture levels**: `stable` → `watch` → `unstable` → `critical`.
- **Invariants**:
  - No side effects — does not emit telemetry, modify DB, or trigger repairs itself.
  - Deterministic: same inputs + thresholds = same decision.
  - Threshold-gated: no action on isolated single events unless posture is already critical.
  - Does not change provider settings, integrity mode, or user config.

### MemoryRepairSchedulerService
- **Path**: `electron/services/memory/MemoryRepairSchedulerService.ts`
- **Purpose**: Drives the periodic analytics → reflection → decision loop.  Acts on the decision by delegating to `MemoryRepairTriggerService`, `DeferredMemoryReplayService`, and `TelemetryBus`.
- **Public API**: `start()`, `stop()`, `runNow(reason?)`, `getLastRun()`, `getRecentRuns()`, `getLatestInsightSummary()`, `getLatestReflectionReport()`, `getLatestAdaptivePlan()`, `getLatestSuggestionReport()`.
- **Default cadence**: every 10 minutes; analysis window 24 hours.
- **Concurrency guard**: only one run at a time; overlapping `runNow()` calls return a skipped result immediately.
- **Caching** (added for operator review surface): latest `MemoryRepairInsightSummary`, `MemoryRepairReflectionReport`, `MemoryAdaptivePlan`, `MemoryOptimizationSuggestionReport`, and a ring buffer of the last 5 run results are cached after each successful run.
- **Actions taken** (threshold-based only):
  - `emit_escalation` → `TelemetryBus.emit('memory.maintenance_escalation', …)`
  - `trigger_repair` → `MemoryRepairTriggerService.emitDirect(…)`
  - `prioritize_replay` → `DeferredMemoryReplayService.drain()`
  - `publish_report` → `TelemetryBus.emit('memory.maintenance_decision', …)` (always)
- **Emits**: `memory.maintenance_run_started`, `memory.maintenance_run_completed`, `memory.maintenance_run_skipped`, `memory.maintenance_decision`, `memory.maintenance_escalation`.
- **Wiring** (`AgentService._wireRepairExecutor`): constructed when `MemoryRepairOutcomeRepository` is available; started after all repair handlers are registered; stopped in `AgentService.shutdown()`.

### Shared types: MemoryMaintenanceState.ts
- **Path**: `shared/memory/MemoryMaintenanceState.ts`
- **Exports**: `MemoryMaintenancePosture`, `MemoryRepairScheduledRunResult`, `MemoryMaintenanceDecision`, `MemoryMaintenanceAction`.
- **Lives in `shared/`** so the renderer (e.g. Reflection Dashboard) can import posture and run-result types without depending on Node.js-only services.

---

## Memory Operator Review Surface

The operator review surface provides a unified read-focused view of the full memory maintenance intelligence stack for human operators.  See `docs/architecture/memory_operator_review_surface.md` for full details.

### MemoryOperatorReviewService
- **Path**: `electron/services/memory/MemoryOperatorReviewService.ts`
- **Purpose**: Aggregates cached outputs from `MemoryRepairSchedulerService` and current state from `MemoryService` into a single `MemoryOperatorReviewModel`.
- **Inputs**: `MemoryService` (health status, deferred work counts), `MemoryRepairSchedulerService | null` (latest analytics, plan, suggestions, recent runs).
- **Output**: `MemoryOperatorReviewModel` — bounded, serialisable, advisory-only payload.
- **Public API**: `getModel(): Promise<MemoryOperatorReviewModel>`.
- **Invariants**: Read-only; no re-computation of analytics; safe to call repeatedly; degrades gracefully when no scheduler run has completed.
- **Wiring**: Constructed in `AgentService._wireRepairExecutor()` alongside `MemoryRepairSchedulerService`.  Falls back to null scheduler when the DB pool is unavailable.

### Shared types: MemoryOperatorReviewModel.ts
- **Path**: `shared/memory/MemoryOperatorReviewModel.ts`
- **Exports**: `MemoryOperatorReviewModel`, `OperatorReviewPosture`, `OperatorReviewHealth`, `OperatorReviewSummary`, `OperatorReviewAdaptivePlan`, `OperatorReviewOptimizationSuggestions`, `OperatorReviewQueues`, `OperatorReviewRecentRepair`, `OperatorReviewRecentCycle`, `OperatorReviewActionEffectiveness`.
- **Lives in `shared/`** so the renderer can import types without depending on Node.js-only services.

### IPC Surface
- `memory:getOperatorReviewModel` — read-only; returns the current `MemoryOperatorReviewModel`.
- `memory:runMaintenanceNow` — human-gated trigger for an immediate analytics run; returns the run result.

### MemoryOperatorReviewPanel
- **Path**: `src/renderer/components/MemoryOperatorReviewPanel.tsx`
- **Purpose**: Operator-facing UI panel with 7 sections: Current Posture, Key Findings, Adaptive Plan, Optimization Suggestions (advisory), Queue / Deferred Work, Recent Repair Activity, Notes.
- **Access**: Engineering sub-tab **🧠 Memory Health** in the Reflection Dashboard.
- **Controls**: Manual refresh button; "Run Analysis Now" button (human-triggered, maps to `memory:runMaintenanceNow`).
- **Invariants**: No auto-apply controls; suggestions clearly labeled advisory; no settings changed.

