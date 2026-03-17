# Tala System Overview

## 1. System Purpose
Tala is a "government-grade" autonomous agent platform designed for secure, local-first artificial intelligence interactions. It provides a robust, multi-process environment where LLMs can interact with tools, memory systems, and external services via a structured protocol (MCP).

## 2. Key Operational Capabilities
- **Autonomous Reasoning**: Multi-turn loops for goal decomposition and execution.
- **Local-First Inference**: Support for local LLM execution via Ollama and llama-cpp-python, ensuring privacy and offline capability.
- **Hybrid Brain Architecture**: Flexible switching between local and cloud inference engines.
- **Extensible Tooling**: Built on the Model Context Protocol (MCP), allowing for modular integration of specialized services.
- **Long-Term Memory**: Multi-layered memory system including semantic retrieval (RAG), graph-based relationship mapping, and fact storage (Mem0).

## 3. Major Subsystems
- **The Shell (Electron Main)**: Orchestrates application lifecycle, native security, and service management.
- **The Interface (React Renderer)**: Provides a dynamic, high-fidelity chat and monitoring interface.
- **The Brain (Agent Service)**: Central reasoning engine that coordinates LLM calls, tool usage, and memory.
- **MCP Service Layer**: A collection of isolated processes providing specialized capabilities like astrological emotional state calculation and persistent memory.

## 4. User Interaction Model
Users interact with Tala through a conversational React-based UI. The system supports direct chat, complex workflow editing, and real-time monitoring of agent reasoning and terminal activity.

## 5. Functional Architecture Walkthrough
```mermaid
graph TD
    User([User]) <--> UI[React Renderer UI]
    UI <--> IPC[IPC Bridge / Preload]
    IPC <--> Main[Electron Main Process]
    Main <--> AS[Agent Service]
    AS <--> Brains{Inference Drivers}
    Brains <--> Ollama[Local Ollama]
    Brains <--> Cloud[Cloud LLM APIs]
    AS <--> TS[Tool Service]
    TS <--> MCP[MCP Service Layer]
    MCP <--> Astro[Astro Engine]
    MCP <--> Mem0[Mem0 Continuity]
    MCP <--> TC[Tala Core RAG]
    AS <--> GS[Guardrail Service]
    TC <--> Storage[(SQLite / Vector / File System)]
```

## 6. External Dependencies
- **Ollama**: Required for local inference execution.
- **Node.js**: Underlying runtime for the desktop shell.
- **Python 3.10+**: Runtime for MCP services and vector libraries.
- **SQLite**: Primary persistent storage for structured memory.

## 7. World Model Layer (Phase 4A)

Phase 4A adds a structured world model that gives Tala a canonical view of her operating environment before inference. The `WorldModelAssembler` (in `electron/services/world/`) produces a `TalaWorldModel` from:

- `WorkspaceStateBuilder` — workspace root, directories, classification.
- `RepoStateBuilder` — git branch, dirty/clean, project type.
- `RuntimeWorldStateProjector` — projects `RuntimeDiagnosticsSnapshot` into cognition-friendly state.
- `UserGoalStateBuilder` — immediate task, project focus, stable direction.

The world model is integrated into `PreInferenceContextOrchestrator` as a selective context source (contributed only when the turn intent is technical/coding/task/workspace/repo). The full model is never dumped into prompts — only a compact summary.

IPC: `diagnostics:getWorldModel` returns `WorldModelDiagnosticsSummary` (read-only, renderer-safe).

See [`docs/architecture/phase4a_world_model.md`](./phase4a_world_model.md) for full details.


## 8. Self-Maintenance Layer (Phase 4B)

Phase 4B adds a bounded self-maintenance foundation that lets Tala detect unhealthy operational state and take safe, policy-driven recovery actions.

The self-maintenance layer sits on top of the World Model and Runtime Diagnostics systems. Key components:

- **`MaintenanceIssueDetector`** — detects issues from `RuntimeDiagnosticsSnapshot` and `TalaWorldModel` (provider health, MCP flapping, world model degradation)
- **`MaintenancePolicyEngine`** — single canonical policy engine that classifies each issue into: `monitor`, `recommend_action`, `request_user_approval`, `auto_execute`, or `suppress_temporarily`
- **`MaintenanceActionExecutor`** — wraps `RuntimeControlService` with safety gates, structured result objects, and telemetry
- **`MaintenanceLoopService`** — bounded maintenance state manager; supports `observation_only`, `recommend_only`, and `safe_auto_recovery` modes

Maintenance state is exposed via:
- `diagnostics:getMaintenanceState` — IPC read model
- `diagnostics:runMaintenanceCheck` — trigger manual cycle
- `diagnostics:setMaintenanceMode` — change operational mode
- `PreInferenceContextOrchestrator` — compact maintenance summary injected selectively on troubleshooting/technical turns

See [`docs/architecture/phase4b_self_maintenance_foundation.md`](./phase4b_self_maintenance_foundation.md) for full details.
