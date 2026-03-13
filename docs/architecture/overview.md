# System Architecture Overview

This document provides an automated overview of the repository structure and subsystem boundaries.

## Code Roots

| ID | Path | Purpose |
|---|---|---|
| `renderer` | `src/` | Renderer UI — chat interface, settings panel, reflection dashboard, component library |
| `electron-main` | `electron/` | Electron main process, preload scripts, IPC router, and all backend services |
| `electron-tests` | `electron/__tests__/` | Electron-specific unit and integration tests (owned by electron-main subsystem) |
| `mcp-astro` | `mcp-servers/astro-engine/` | Astrological emotional state engine — MCP server exposing emotional bias tools |
| `mcp-tala-core` | `mcp-servers/tala-core/` | Core Tala tool surface — MCP server providing file I/O and memory primitives |
| `mcp-mem0` | `mcp-servers/mem0-core/` | Mem0-backed long-term memory persistence — MCP server |
| `mcp-memory-graph` | `mcp-servers/tala-memory-graph/` | Graph-structured associative memory layer — MCP server |
| `mcp-world-engine` | `mcp-servers/world-engine/` | World-state and context persistence — MCP server |
| `local-inference` | `local-inference/` | Local model serving runtime configuration and launch scripts (Ollama / llama.cpp) |
| `tests` | `tests/` | Shared cross-subsystem Vitest test suites |
| `test-data` | `test_data/` | Test fixture data used by automated tests — not runtime state |
| `scripts` | `scripts/` | Developer diagnostics, simulation harnesses, build packaging, portable distribution scripts |
| `tools` | `tools/` | Developer utility scripts not part of the main build or test pipeline |
| `docs` | `docs/` | Authoritative project documentation — architecture, features, interfaces, security, traceability |
| `public` | `public/` | Static frontend assets served by Vite (splash, icons, vendor assets) |
| `shared` | `shared/` | Shared pure types, interfaces, enums, and neutral data contracts. NO logic, UI, or side-effects. |
| `archive` | `archive/` | Historical reference material — frozen, do not extend |

## Subsystems

### Renderer UI (`renderer`)

**Root**: `src/`

**Ownership Patterns**:
- `src/**/*.tsx`
- `src/**/*.ts`
- `src/**/*.css`
- `src/assets/**`
- `public/**`

---

### Electron Main + Services (`electron-main`)

**Root**: `electron/`

**Ownership Patterns**:
- `electron/main.ts`
- `electron/preload.ts`
- `electron/browser-preload.ts`
- `electron/bootstrap.ts`
- `electron/services/**`
- `electron/brains/**`
- `electron/types/**`

---

### Astro Engine (MCP) (`mcp-astro`)

**Root**: `mcp-servers/astro-engine/`

**Ownership Patterns**:
- `mcp-servers/astro-engine/**`

---

### Tala Core (MCP) (`mcp-tala-core`)

**Root**: `mcp-servers/tala-core/`

**Ownership Patterns**:
- `mcp-servers/tala-core/**`

---

### Mem0 Core (MCP) (`mcp-mem0`)

**Root**: `mcp-servers/mem0-core/`

**Ownership Patterns**:
- `mcp-servers/mem0-core/**`

---

### Memory Graph (MCP) (`mcp-memory-graph`)

**Root**: `mcp-servers/tala-memory-graph/`

**Ownership Patterns**:
- `mcp-servers/tala-memory-graph/**`

---

### World Engine (MCP) (`mcp-world-engine`)

**Root**: `mcp-servers/world-engine/`

**Ownership Patterns**:
- `mcp-servers/world-engine/**`

---

### Local Inference Runtime (`local-inference`)

**Root**: `local-inference/`

**Ownership Patterns**:
- `local-inference/**`

---

### Shared Test Suite (`tests`)

**Root**: `tests/`

**Ownership Patterns**:
- `tests/**`
- `test_data/**`

---

### Developer Scripts (`scripts`)

**Root**: `scripts/`

**Ownership Patterns**:
- `scripts/**`

---

### Developer Tools (`tools`)

**Root**: `tools/`

**Ownership Patterns**:
- `tools/**`

---

### Documentation (`docs`)

**Root**: `docs/`

**Ownership Patterns**:
- `docs/**`

---

### Shared Type Contracts (`shared`)

**Root**: `shared/`

**Ownership Patterns**:
- `shared/**/*.ts`

---

### Archive (`archive`)

**Root**: `archive/`

**Ownership Patterns**:
- `archive/**`

---

