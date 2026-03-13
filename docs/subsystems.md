# Subsystems

This document defines the major subsystems of the Tala application, their owners, responsibilities, and cross-boundary interaction rules.
It is intended for both human contributors and AI coding agents.

---

## Subsystem Index

| ID | Name | Root Path | Language |
|----|------|-----------|----------|
| `renderer` | Renderer UI | `src/` | TypeScript / React |
| `electron-main` | Electron Main + Services | `electron/` | TypeScript |
| `mcp-astro` | Astro Engine (MCP) | `mcp-servers/astro-engine/` | Python |
| `mcp-tala-core` | Tala Core (MCP) | `mcp-servers/tala-core/` | Python |
| `mcp-mem0` | Mem0 Core (MCP) | `mcp-servers/mem0-core/` | Python |
| `mcp-memory-graph` | Memory Graph (MCP) | `mcp-servers/tala-memory-graph/` | Python |
| `mcp-world-engine` | World Engine (MCP) | `mcp-servers/world-engine/` | Python |
| `local-inference` | Local Inference Runtime | `local-inference/` | Python / Shell |
| `tests` | Shared Test Suite | `tests/` | TypeScript |
| `scripts` | Developer Scripts | `scripts/` | TypeScript / Shell / Python |
| `tools` | Developer Tools | `tools/` | Python / TypeScript |
| `docs` | Documentation | `docs/` | Markdown |

---

## Subsystem Definitions

### `renderer` — Renderer UI

**Root:** `src/`

**Responsibility:** All user-facing UI running in the Electron renderer process. This includes the chat interface, settings panel, reflection dashboard, and the component library.

**What belongs here:**
- React components (`src/renderer/components/`)
- Page-level views
- Renderer-side TypeScript types
- UI-specific styles and assets (`src/assets/`)
- Frontend settings and profile data schemas

**What must NOT be placed here:**
- Backend service logic
- File system access (must go through IPC)
- LLM inference calls
- Database access
- MCP server code

**Cross-boundary interactions:**
- Communicates with `electron-main` exclusively through Electron IPC channels.
- Does not import from `electron/` directly.

---

### `electron-main` — Electron Main + Services

**Root:** `electron/`

**Responsibility:** The Electron main process, preload bridge, IPC router, and all backend services. This is the orchestration layer of the application.

**Key services:**
| Service | File | Role |
|---------|------|------|
| AgentService | `services/AgentService.ts` | LLM reasoning loop and tool dispatch |
| IpcRouter | `services/IpcRouter.ts` | Routes IPC messages to services |
| HybridMemoryManager | `services/HybridMemoryManager.ts` | Short- and long-term memory coordination |
| AuditLogger | `services/AuditLogger.ts` | Immutable audit trail for all agent decisions |
| SmartRouterService | `services/SmartRouterService.ts` | Mode-aware turn routing |
| TalaContextRouter | `services/router/TalaContextRouter.ts` | Context assembly and capability gating |
| ReflectionService | `services/reflection/ReflectionService.ts` | Self-improvement scheduling and execution |
| SoulService | `services/soul/SoulService.ts` | Persona, ethics, and identity engines |
| OrchestratorService | `services/OrchestratorService.ts` | Multi-agent orchestration |
| GuardrailService | `services/GuardrailService.ts` | Safety enforcement |
| ArtifactRouter | `services/ArtifactRouter.ts` | Artifact-first output routing |

**What belongs here:**
- Electron main process entry (`main.ts`)
- Preload scripts (`preload.ts`, `browser-preload.ts`)
- Backend services (`services/`)
- IPC handler registration
- Brain implementations (`brains/`)
- Electron-specific TypeScript types (`types/`)

**What must NOT be placed here:**
- React components or renderer-side UI
- MCP server implementations (those belong in `mcp-servers/`)
- Inference server code (belongs in `local-inference/`)
- Test fixtures (belong in `test_data/`)

**Cross-boundary interactions:**
- Communicates with `renderer` via IPC only.
- Invokes MCP servers via the MCP protocol through `McpService.ts`.
- Calls `local-inference` via HTTP through `LocalEngineService.ts` / `InferenceService.ts`.

---

### `mcp-astro` — Astro Engine

**Root:** `mcp-servers/astro-engine/`

**Responsibility:** Computes astrological/emotional state profiles and injects emotional bias into agent context. Exposes MCP tools consumed by `AgentService`.

**What belongs here:**
- Ephemeris computation (`astro_emotion_engine/ephemeris/`)
- Emotional aggregation logic (`astro_emotion_engine/aggregation/`)
- MCP tool schemas (`astro_emotion_engine/schemas/`)
- MCP server entry point (`server.py`)

**What must NOT be placed here:**
- Memory persistence (belongs in `mcp-mem0` or `mcp-memory-graph`)
- General agent logic

**Cross-boundary interactions:**
- Invoked by `electron-main` via MCP protocol.
- Does not call other MCP servers directly.

---

### `mcp-tala-core` — Tala Core

**Root:** `mcp-servers/tala-core/`

**Responsibility:** Core Tala tool surface. Provides file I/O, memory primitives, and fundamental agent tools as MCP capabilities.

**What belongs here:**
- Core tool implementations (`server.py`)

**Cross-boundary interactions:**
- Invoked by `electron-main` via MCP protocol.

---

### `mcp-mem0` — Mem0 Core

**Root:** `mcp-servers/mem0-core/`

**Responsibility:** Long-term memory persistence via the Mem0 library. Stores, retrieves, and manages episodic memory.

**What belongs here:**
- Mem0 integration and server (`server.py`)

**Cross-boundary interactions:**
- Invoked by `electron-main` via MCP protocol through `MemoryService.ts`.

---

### `mcp-memory-graph` — Memory Graph

**Root:** `mcp-servers/tala-memory-graph/`

**Responsibility:** Graph-structured memory layer. Provides associative memory retrieval and relationship mapping.

**What belongs here:**
- Graph memory implementation (`src/memory_graph/`)
- Memory schema definitions
- Server entry point (`main.py`)

**Cross-boundary interactions:**
- Invoked by `electron-main` via MCP protocol.

---

### `mcp-world-engine` — World Engine

**Root:** `mcp-servers/world-engine/`

**Responsibility:** World-state and context persistence. Maintains persistent context about the environment and user.

**Cross-boundary interactions:**
- Invoked by `electron-main` via MCP protocol.

---

### `local-inference` — Local Inference Runtime

**Root:** `local-inference/`

**Responsibility:** Configuration and scripts for running local inference (Ollama / llama.cpp). Not application logic.

**What belongs here:**
- Python requirements for inference dependencies
- Launch configuration

**What must NOT be placed here:**
- Application services
- MCP server code

**Cross-boundary interactions:**
- Called by `electron-main` via HTTP (managed by `LocalEngineService.ts` and `InferenceService.ts`).

---

### `tests` — Shared Test Suite

**Root:** `tests/`

**Responsibility:** Cross-subsystem and integration-level Vitest test suites.

**What belongs here:**
- Integration tests that span multiple subsystems
- Test mocks (`tests/__mocks__/`)
- Reflection system tests (`tests/reflection/`)
- Logging and identity verification tests

**What must NOT be placed here:**
- Test fixture data files (use `test_data/`)
- Production source code

**Cross-boundary interactions:**
- May import from `electron/` and `src/` for testing purposes only.

---

### `scripts` — Developer Scripts

**Root:** `scripts/`

**Responsibility:** Diagnostics, simulation, build packaging, and portable distribution tooling. These are developer and CI utilities, not application code.

**What belongs here:**
- Diagnostic probes (`diagnose_*.ts`, `audit_*.ts`)
- Agent simulation scripts (`simulate_*.ts`)
- Build and packaging scripts (`make_portable*`, `assemble_universal*`)
- Inference launch helpers (`launch-inference.*`)
- Health check scripts (`health_probe.*`)

**What must NOT be placed here:**
- Production application code
- Runtime state or output files

---

### `tools` — Developer Tools

**Root:** `tools/`

**Responsibility:** Developer utility scripts not part of the main build or test pipeline.

**What belongs here:**
- Memory validator (`memory_validator.py`)
- Dev helper utilities (`tools/dev/`)

---

### `docs` — Documentation

**Root:** `docs/`

**Responsibility:** Authoritative project documentation. All architecture, feature, interface, security, and traceability documents live here.

**What belongs here:**
- Architecture documents (`docs/architecture/`)
- Feature behavioral specs (`docs/features/`)
- Interface and IPC contracts (`docs/interfaces/`)
- Security and operational policy (`docs/security/`)
- Requirements and traceability (`docs/traceability/`, `docs/requirements/`)
- Contributor guidelines (`docs/contributing/`)
- Lifecycle and compliance records (`docs/lifecycle/`, `docs/compliance/`)

**What must NOT be placed here:**
- Application source code
- Generated runtime outputs
- Scratch or session-generated content

---

## Cross-Boundary Interaction Rules

1. `renderer` ↔ `electron-main`: IPC only. No direct imports across the process boundary.
2. `electron-main` → MCP servers: MCP protocol only (via `McpService.ts`). No direct Python imports.
3. `electron-main` → `local-inference`: HTTP only (via `LocalEngineService.ts` / `InferenceService.ts`).
4. MCP servers are independent processes. They do not call each other directly.
5. `tests/` may import from both `electron/` and `src/` for test purposes. It must not import from `mcp-servers/` directly.
6. `scripts/` must not import from application code in a way that creates a build dependency.
