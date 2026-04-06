# Interface Matrix — Tala System

**Document ID**: TALA-ICD-006  
**Version**: 1.0.0  
**Status**: Formal  
**Owner**: Architecture / Security  

## 1. Overview
This matrix provides a comprehensive mapping of all data and command flows between the major components of the Tala system.

## 2. Interaction Matrix

| Source Component | Target Component | Interface Type | Description | Data Sensitivity |
|:---|:---|:---|:---|:---|
| **Renderer UI** | **Main Process** | Electron IPC | User commands, settings updates, chat input. | High (User PII) |
| **Main Process** | **Renderer UI** | Electron IPC | Streamed chat tokens, status updates, tool results. | Medium |
| **AgentService** | **Brain (Ollama/Cloud)** | IBrain API | Inference requests and system prompt injection. | High (Context) |
| **AgentService** | **ToolService** | Internal API | Execution of system capabilities (FS, Shell, Browser). `setMemoryService(memory, getCanonicalId?)` signature — P7A authority callback wires canonical anchoring through `mem0_add`. | Critical (Control) |
| **ToolService** | **MCP Servers** | JSON-RPC (stdio) | Delegated tool execution (RAG, Astro, Mem0). | Medium-High |
| **MCP Servers** | **Local Filesystem** | File System API | Accessing vector DBs, memory graphs, and RAG indexes. | Medium |
| **AgentService** | **MemoryService** | Internal API | Relational and vector semantic search. | High (History) |
| **AgentService** | **MemoryAuthorityService** | Internal API | Canonical memory write — all persistent writes must flow here before derived systems. Returns `canonical_memory_id`. | High (History) |
| **MemoryAuthorityService** | **PostgresMemoryRepository** | Internal API (Pool) | Writes to `memory_records`, `memory_lineage`, `memory_projections`. Canonical source of truth. | High (History) |
| **MemoryAuthorityService** | **memory_projections** | SQL | Inserts pending projection events for mem0, graph, vector after every canonical commit. | Medium |
| **derivedWriteGuards** | **All Derived Stores** | In-process guard | `assertDerivedMemoryAnchor(anchor, source)` — enforces `canonical_memory_id` on every durable derived write. Throws in strict mode (`TALA_STRICT_MEMORY=1`), warns in production. `DerivedWriteAnchor` is the required metadata interface for all derived writes. | High (Authority) |
| **SettingsManager** | **app_settings.json** | Atomic File I/O | Persistence of system configuration. | Critical (Security) |
| **GuardrailService** | **AgentService** | Internal API | Post-inference verification and redaction. | High |

| **AutonomousRunOrchestrator** | **ModelCapabilityEvaluator (P5.1B)** | Internal API | `evaluate(goal, recentFailures, policy, modelContextLimit?, recoveryPacksExhausted?)` → `TaskCapabilityAssessment`. Deterministic insufficiency assessment. | Low |
| **AutonomousRunOrchestrator** | **EscalationPolicyEngine (P5.1C)** | Internal API | `evaluate(assessment, policy, recentEscalationCount, cooldownActive)` → `{ decision: EscalationDecision, request: EscalationRequest | null }`. Policy-gated escalation decision. | Low |
| **AutonomousRunOrchestrator** | **DecompositionEngine (P5.1D)** | Internal API | `decompose(goal, assessment, policy, depth)` → `DecompositionPlan | null`. Returns null when depth ≥ maxDecompositionDepth or no decomposition possible. | Low |
| **AutonomousRunOrchestrator** | **ExecutionStrategySelector (P5.1E)** | Internal API | `select(assessment, escalationDecision, decompositionPlan, policy)` → `ExecutionStrategyDecision`. Deterministic strategy selection. | Low |
| **AutonomousRunOrchestrator** | **EscalationAuditTracker (P5.1F)** | Internal API | `record(goalId, eventKind, detail, runId?, data?)` — immutable audit append. `getRecentEscalationCount(windowMs)` — spam guard query. | Low |
| **AutonomousRunOrchestrator** | **DecompositionOutcomeTracker (P5.1F)** | Internal API | `startPlan/recordStep/finalizePlan` lifecycle. `isCooldownActive(subsystemId)` — cooldown guard. | Low |
| **Renderer UI** | **AutonomousRunOrchestrator** | Electron IPC | `autonomy:getDashboardState` now returns `AutonomyDashboardState` with optional `escalationState: EscalationDashboardState` when escalation services are injected. | Medium |
| **Renderer UI** | **TelemetryBus** | Electron IPC (read-only) | `telemetry:getRecentEvents` — returns a snapshot of the TelemetryBus ring buffer (≤ 200 events). Exposed as `window.tala.telemetry.getRecentEvents()`. Read-only; no mutation, clearing, or streaming. Covers both chat (AgentKernel) and autonomy (AutonomousRunOrchestrator) lifecycle events. Schema: `RuntimeEvent[]` (id, timestamp, executionId, correlationId?, subsystem, event, phase?, payload?). | Low |

## 3. Boundary Definitions

### 3.1. Trusted Boundary
The **Main Process** is the root of trust. It manages secret keys, filesystem access, and process execution.

### 3.2. Sandboxed Boundary
The **Renderer Process** and **BrowserView** are isolated. They cannot perform filesystem or network operations directly; all actions must be requested via the IPC bridge.

### 3.3. Decoupled Boundary
**MCP Servers** run as sidecar processes. They provide specialized data processing but do not have access to the Main Process memory or IPC bus.

---
*Generated by Tala Autopilot*
