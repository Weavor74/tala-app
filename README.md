# TALA — The Autonomous Local Agent

TALA is a local-first, privacy-preserving autonomous AI agent platform built on Electron, React, and the Model Context Protocol (MCP). It provides a secure desktop environment for multi-turn reasoning, long-term memory, tool execution, and self-improvement — all running on your own hardware.

---

## Overview

| Capability | Details |
|---|---|
| **Inference** | Local (Ollama / llama-cpp-python) and Cloud (OpenAI, Anthropic) |
| **Memory** | Semantic RAG, vector knowledge graph, Mem0 long-term facts, chat history |
| **Tools** | MCP-based modular tool ecosystem (file, shell, browser, git, and more) |
| **Self-Improvement** | 6-phase autonomous reflection pipeline (observe → reflect → patch → validate → promote → journal) |
| **Modes** | Assistant, Hybrid, and RP (Roleplay) with capability gating |
| **Platform** | Windows, macOS, Linux via Electron |

---

## Prerequisites

- **Node.js** v18 or higher
- **Python** 3.10 or higher (added to PATH)
- **Ollama** (optional, for local inference)

---

## Installation

### Step 1: Bootstrap the environment

Run the setup script for your operating system from the repository root:

**Windows (PowerShell):**
```powershell
.\bootstrap.ps1
```

**macOS / Linux:**
```bash
chmod +x bootstrap.sh
./bootstrap.sh
```

The bootstrap script:
1. Validates Node.js and Python installations.
2. Creates required directory structures (`models/`, `data/`, `memory/`).
3. Downloads a quantized Llama 3 model (~2 GB) into `models/`.
4. Runs `npm install` for frontend and Electron dependencies.
5. Creates isolated Python virtual environments for each MCP microservice.

### Step 2: Start TALA

```bash
npm run dev
```

Or double-click `start.bat` on Windows. This starts Vite, launches the Electron window, and spins up the local inference server and MCP sidecars.

---

## Architecture

TALA uses a four-layer stack:

```
┌─────────────────────────────────────────────┐
│  React UI  (src/)                           │  ← User interaction
│  Chat, Workflow Editor, Terminal, Memory    │
├─────────────────────────────────────────────┤
│  Electron Main Process  (electron/main.ts)  │  ← Orchestration & IPC
│  Service registry, preload security bridge  │
├─────────────────────────────────────────────┤
│  Backend Services  (electron/services/)     │  ← Business logic
│  AgentService, ToolService, MemoryService   │
│  GuardrailService, ReflectionService        │
├─────────────────────────────────────────────┤
│  MCP Sidecars  (mcp-servers/)               │  ← Specialized functions
│  tala-core (RAG), astro-engine (emotion)    │
│  mem0-core (facts), tala-memory-graph       │
├─────────────────────────────────────────────┤
│  Inference Layer                            │
│  Ollama (local) / Cloud APIs (remote)       │
└─────────────────────────────────────────────┘
```

All IPC between the renderer and main process is mediated by `electron/preload.ts` using Electron's `contextBridge`. The renderer cannot access the filesystem or network directly.

### Key Services

| Service | Path | Role |
|---|---|---|
| `AgentService` | `electron/services/AgentService.ts` | Reasoning engine: turn loop, prompt construction, tool coordination |
| `ToolService` | `electron/services/ToolService.ts` | Tool registry and execution dispatcher |
| `MemoryService` | `electron/services/MemoryService.ts` | Memory retrieval, scoring, and association |
| `ReflectionService` | `electron/services/reflection/ReflectionService.ts` | 6-phase self-improvement pipeline orchestrator |
| `GuardrailService` | `electron/services/GuardrailService.ts` | Output safety, PII redaction, capability gating |
| `IpcRouter` | `electron/services/IpcRouter.ts` | Central IPC message dispatcher |

---

## Agent Modes

TALA operates in three modes controlled via **Settings → Agent Mode**:

| Mode | Description |
|---|---|
| **Assistant** | Standard conversational mode. RAG and tools are available based on user prompts. |
| **Hybrid** | Expands tool usage, enables documentation writing and test generation. |
| **RP (Roleplay)** | Applies persona grounding from `user_profile.json`. Full emotional modulation via the Astro Engine. |

Mode state is the authoritative property of `SettingsManager.getActiveMode()`. It persists in `%USERDATA%/app_settings.json`.

---

## Memory System

TALA maintains several memory layers that are assembled on every agent turn:

- **RAG (Retrieval-Augmented Generation)**: ChromaDB-backed semantic search via `tala-core` MCP sidecar.
- **Memory Graph**: SQLite-backed entity relationship graph via `tala-memory-graph` sidecar.
- **Long-term Facts (Mem0)**: Structured user facts via `mem0-core` MCP sidecar.
- **Chat History**: Persistent session logs stored in `data/`.

---

## Self-Improvement Pipeline

The reflection system (`electron/services/reflection/`) enables TALA to autonomously detect errors, propose code patches, validate them, and promote them to production:

1. **OBSERVE** (`SelfImprovementService`) — Monitors logs for anomalies.
2. **REFLECT** (`ReflectionEngine`) — Formulates root-cause hypotheses.
3. **PATCH** (`PatchStagingService`) — Stages file changes in an isolated subdirectory without touching live files.
4. **VALIDATE** (`ValidationService`) — Runs `tsc`, lint, and tests against staged patches.
5. **PROMOTE** (`ApplyEngine`) — Archives the original files and applies the validated patch.
6. **JOURNAL** (`ReflectionJournalService`) — Writes a structured JSONL audit record.

All promotions are reversible via `RollbackEngine` using the generated archive manifests.

---

## MCP Microservices

| Service | Path | Technology | Purpose |
|---|---|---|---|
| `tala-core` | `mcp-servers/tala-core/` | Python, ChromaDB | RAG and vector search |
| `astro-engine` | `mcp-servers/astro-engine/` | Python, Swiss Ephemeris | Astrological emotional state |
| `mem0-core` | `mcp-servers/mem0-core/` | Python, Mem0AI | Long-term fact storage |
| `world-engine` | `mcp-servers/world-engine/` | Python | Context enrichment |
| `tala-memory-graph` | `mcp-servers/tala-memory-graph/` | Python, SQLite | Graph-based memory |

Each sidecar runs as an isolated child process. Communication uses JSON-RPC over stdin/stdout (MCP protocol).

---

## Project Structure

```
tala-app/
├── src/                        # React UI (TypeScript, Vite)
│   └── renderer/components/    # UI components (Chat, Terminal, Workflow, etc.)
├── electron/                   # Electron main process and backend services
│   ├── main.ts                 # Application entry point
│   ├── preload.ts              # Secure IPC bridge
│   ├── brains/                 # LLM adapters (OllamaBrain, CloudBrain)
│   ├── services/               # All backend services
│   │   ├── reflection/         # Self-improvement pipeline
│   │   ├── soul/               # Identity and ethics engines
│   │   └── router/             # Context routing and intent classification
│   └── IpcRouter.ts            # IPC message dispatcher
├── mcp-servers/                # Python MCP microservices
├── docs/                       # Technical Data Package (architecture, security, etc.)
├── tests/                      # Test suites
├── scripts/                    # Build and startup scripts
└── bootstrap.sh / bootstrap.ps1
```

---

## Documentation

Full technical documentation is in the `docs/` directory:

| Area | Key Documents |
|---|---|
| Architecture | `docs/architecture/system_overview.md`, `component_model.md`, `runtime_flow.md` |
| Interfaces | `docs/interfaces/interface_matrix.md`, `ipc_interface_control.md`, `mcp_interface_control.md` |
| Security | `docs/security/threat_model.md`, `trust_boundaries.md`, `security_overview.md` |
| Requirements | `docs/requirements/system_requirements.md`, `nonfunctional_requirements.md` |
| Traceability | `docs/traceability/requirements_trace_matrix.md`, `test_trace_matrix.md` |
| Compliance | `docs/compliance/sbom.md`, `dependency_license_inventory.md` |
| Lifecycle | `docs/lifecycle/system_lifecycle_plan.md`, `maintenance_strategy.md` |

The master navigation index is at [`docs/TDP_INDEX.md`](docs/TDP_INDEX.md).

---

## Development

```bash
# Install dependencies
npm install

# Start in development mode (Vite + Electron)
npm run dev

# Run tests
npm test

# Lint
npm run lint
```

Python MCP services each have their own virtual environment created by `bootstrap.sh`. To manually start a sidecar for debugging:

```bash
cd mcp-servers/tala-core
source .venv/bin/activate   # or .venv\Scripts\activate on Windows
python server.py
```

---

## Security

- All IPC is mediated by `electron/preload.ts` with `contextIsolation: true`.
- The renderer process has no direct filesystem or network access.
- Sensitive fields (API keys, PII) are redacted from logs by `GuardrailService`.
- User identity is UUID-based throughout; PII never enters LLM prompts directly.
- See [`docs/security/`](docs/security/) for the full threat model and trust boundary definitions.

---

## License

See [`docs/compliance/dependency_license_inventory.md`](docs/compliance/dependency_license_inventory.md) for the full open-source component inventory.
