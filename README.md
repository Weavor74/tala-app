# Tala - Autonomous Local Agent

Tala is a secure, local-first autonomous AI assistant built on Electron, React, and the Model Context Protocol (MCP). It provides a conversational interface backed by a multi-process architecture: a TypeScript/React desktop shell, Python MCP services, and deterministic provider selection for inference.

---

## Architecture Overview

```text
+-------------------------------------------------------------+
|  React Renderer (src/)     Chat UI, Settings, Reflection    |
|  ---------------------------------------------------------  |
|  Electron Main (electron/) AgentService, IpcRouter,         |
|                             MemoryAuthorityService, Storage  |
|  ---------------------------------------------------------  |
|  MCP Servers (mcp-servers/)                                 |
|    astro-engine  |  tala-core  |  mem0-core                 |
|  ---------------------------------------------------------  |
|  Local Inference + Provider Registry                        |
+-------------------------------------------------------------+
```

Runtime truth model:

- Postgres is Tala's canonical durable memory authority.
- `MemoryAuthorityService` is the required write boundary for canonical memory commits.
- mem0, graph, vector, summaries, caches, and retrieval artifacts are derived layers only.
- Derived layers must anchor to canonical Postgres-backed IDs and are rebuildable from canonical state.
- pgvector provides vector indexing/search capability inside Postgres when installed.
- If pgvector is unavailable, canonical memory is still available and only vector capability degrades.
- Storage providers are managed through a registry with explicit role assignments (`canonical_memory`, `vector_index`, `blob_store`, `document_store`, `backup_target`, `artifact_store`).
- Inference selection is deterministic and local-first using the current waterfall:
  - `ollama -> vllm -> llamacpp -> koboldcpp -> embedded_vllm -> embedded_llamacpp -> cloud`

Key subsystems:

| Subsystem | Location | Purpose |
|---|---|---|
| Shell | `electron/` | App lifecycle, IPC bridge, service orchestration |
| UI | `src/` | React chat interface, settings, reflection dashboard |
| Agent | `electron/services/AgentService.ts` | LLM reasoning loop, tool dispatch |
| Memory | `electron/services/memory/MemoryAuthorityService.ts` | Canonical durable memory authority (PostgreSQL-backed IDs) |
| Storage | `electron/services/storage/` | Registry-based provider and role assignment management |
| Inference | `electron/services/inference/` | Provider registry, probing, deterministic selection/fallback |

Detailed technical documentation lives in [`docs/`](docs/TDP_INDEX.md).

---

## Quick Start

### Prerequisites

- **Node.js** 20+
- **Python** 3.10+ (for MCP servers)
- At least one inference provider:
  - Preferred local provider: **Ollama**
  - Other local/embedded providers: vLLM, llama.cpp, KoboldCpp, embedded runtimes
  - Optional cloud provider (only when configured)

### Bootstrap (first run)

**Windows:**
```powershell
.\bootstrap.ps1
```

**Linux / macOS:**
```bash
./bootstrap.sh
```

### Run in development

```bash
npm run dev
```

---

## Available Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start full dev environment (Vite + Electron + local inference path) |
| `npm run build` | TypeScript compile + Vite production build |
| `npm run dist` | Package distributable with electron-builder |
| `npm run package:smoke` | Run release packaging smoke gate (non-publish dir package) |
| `npm run artifacts:validate` | Validate packaged artifact structure/content expectations |
| `npm run release:check` | Local release readiness pass (build + tests + phase-c + package smoke + artifact validation) |
| `npm run lint` | ESLint validation |
| `npm run test` | Run unit tests (Vitest) |
| `npm run docs:regen` | Deterministically regenerate architecture/contracts/index docs |
| `npm run docs:heal` | Heal deterministic doclock impact output |
| `npm run docs:validate` | Validate doc drift + naming contract + doclock checks |
| `npm run docs:heal-and-validate` | Canonical docs completion gate for qualifying changes |

---

## Project Layout

```text
tala-app/
|-- src/                  # React frontend (TypeScript)
|-- electron/             # Electron main process and services
|-- mcp-servers/          # Python MCP microservices
|-- local-inference/      # Local inference runtime scripts/config
|-- memory/               # Non-canonical memory assets and archives
|-- scripts/              # Build, packaging, and utility scripts
|-- tests/                # Vitest unit/integration tests
|-- docs/                 # Technical documentation
|-- shared/               # Shared contracts/types
`-- patches/              # patch-package patches
```

---

## Testing

```bash
npm run test
```

Tests live in `tests/` and `electron/__tests__/` and cover routing, reflection, canonical memory authority enforcement, inference fallback behavior, and runtime safety guards.

---

## Documentation

Full technical documentation is in [`docs/`](docs/TDP_INDEX.md):

- [System Overview](docs/architecture/system_overview.md)
- [Repository Overview](docs/architecture/repository_overview.md)
- [Memory Authority Invariant](docs/architecture/memory-authority-invariant.md)
- [Runtime Flow](docs/architecture/runtime_flow.md)
- [Interface Matrix](docs/interfaces/interface_matrix.md)
- [Security Overview](docs/security/security_overview.md)
