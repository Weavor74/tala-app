# Tala — Autonomous Local Agent

Tala is a secure, local-first autonomous AI assistant built on Electron, React, and the Model Context Protocol (MCP). It provides a conversational interface backed by a multi-process architecture: a TypeScript/React desktop shell, multiple Python microservices, and support for both local (Ollama / llama.cpp) and cloud LLM inference.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  React Renderer (src/)     Chat UI, Settings, Reflection    │
│  ──────────────────────────────────────────────────────     │
│  Electron Main (electron/) AgentService, IpcRouter,         │
│                             HybridMemoryManager, AuditLog   │
│  ──────────────────────────────────────────────────────     │
│  MCP Servers (mcp-servers/)                                 │
│    astro-engine  ·  tala-core  ·  mem0-core                 │
│  ──────────────────────────────────────────────────────     │
│  Local Inference (local-inference/)  Ollama / llama.cpp     │
└─────────────────────────────────────────────────────────────┘
```

Key subsystems:

| Subsystem | Location | Purpose |
|-----------|----------|---------|
| Shell | `electron/` | App lifecycle, IPC bridge, service orchestration |
| UI | `src/` | React chat interface, settings, reflection dashboard |
| Agent | `electron/services/AgentService.ts` | LLM reasoning loop, tool dispatch |
| Memory | `electron/services/HybridMemoryManager.ts` | Short + long-term memory (Mem0/RAG) |
| Astro Engine | `mcp-servers/astro-engine/` | Emotional state / persona modulation |
| Router | `electron/services/router/` | Mode-aware context assembly |
| Audit | `electron/services/AuditLogger.ts` | Immutable decision trail |

Detailed technical documentation lives in [`docs/`](docs/TDP_INDEX.md).

---

## Quick Start

### Prerequisites

- **Node.js** 20+
- **Python** 3.10+ (for MCP servers)
- **Ollama** or **llama.cpp** (for local inference — optional, cloud fallback available)

### Bootstrap (first run)

**Windows:**
```powershell
.\bootstrap.ps1
```

**Linux / macOS:**
```bash
./bootstrap.sh
```

The bootstrap script installs Node dependencies, creates Python virtual environments for each MCP server, and optionally downloads the default model.

### Run in development

```bash
npm run dev
```

This starts the Vite dev server, Electron window, and local inference server concurrently.

---

## Available Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start full dev environment (Vite + Electron + Inference) |
| `npm run build` | TypeScript compile + Vite production build |
| `npm run dist` | Package distributable with electron-builder |
| `npm run lint` | ESLint validation |
| `npm run test` | Run unit tests (Vitest) |
| `npm run test:watch` | Watch mode for tests |

---

## Project Layout

```
tala-app/
├── src/                  # React frontend (TypeScript)
│   └── renderer/         # Components: Chat, Settings, Terminal, Memory, etc.
├── electron/             # Electron main process (Node.js)
│   ├── main.ts           # App entry point
│   ├── preload.ts        # Secure IPC bridge
│   ├── services/         # AgentService, FileService, AuditLogger, etc.
│   └── services/router/  # Mode-aware context router
├── mcp-servers/          # Python MCP microservices
│   ├── astro-engine/     # Emotional state engine
│   ├── tala-core/        # Core memory / RAG
│   └── mem0-core/        # Mem0 persistent memory
├── local-inference/      # llama.cpp / Ollama setup
├── scripts/              # Build, packaging, and utility scripts
├── tests/                # Vitest unit tests
├── docs/                 # Technical documentation (architecture, interfaces, security)
└── patches/              # patch-package patches
```

---

## Modes

Tala supports three operating modes selectable at runtime:

- **RP (Roleplay)** — Full persona engagement; memory retrieval suppressed for pure immersion
- **Assistant** — Tool-enabled assistant mode; full memory and capability access
- **Hybrid** — Contextual blend; mode switched automatically based on conversation intent

---

## Testing

```bash
npm run test
```

Tests live in `tests/` and `electron/__tests__/`. They use **Vitest** and cover the routing layer, reflection pipeline, memory identity, and safety guards.

---

## Documentation

Full technical documentation is in [`docs/`](docs/TDP_INDEX.md):

- [System Overview](docs/architecture/system_overview.md)
- [Component Model](docs/architecture/component_model.md)
- [Runtime Flow](docs/architecture/runtime_flow.md)
- [Interface Matrix](docs/interfaces/interface_matrix.md)
- [Security Overview](docs/security/security_overview.md)
- [Requirements Trace Matrix](docs/traceability/requirements_trace_matrix.md)

