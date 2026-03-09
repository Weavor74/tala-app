# Exhaustive Folder Catalog - Tala Repository

This document provides a detailed breakdown of every meaningful folder in the Tala repository, categorizing their status, purpose, and structural significance.

## 1. Managed Project Areas

| Path | Status | Purpose Summary | Scanned? | Confidence |
| :--- | :--- | :--- | :--- | :--- |
| `/` | CONFIG | Repository root containing build configs, launchers, and environment manifests. | Yes | HIGH |
| `.agent/` | ACTIVE | Agent-specific configuration, functions, and workflows. | Yes | HIGH |
| `.tala/` | ACTIVE | Application-level operational settings and persistent session metadata. | Yes | MEDIUM |
| `data/` | DATA | User-specific persistent data (chat sessions, logs, workspace, etc.). | Yes | HIGH |
| `docs/` | DOCS | Central hub for project documentation and audit reports. | Yes | HIGH |
| `electron/` | ACTIVE | Electron main process source, services, and backend logic. | Yes | HIGH |
| `local-inference/` | ACTIVE | Backend service for local model execution via llama-cpp-python. | Yes | HIGH |
| `mcp-servers/` | ACTIVE | Model Context Protocol (MCP) server implementations. | Yes | HIGH |
| `memory/` | DATA | Long-term persona data and roleplay memory files. | Yes | HIGH |
| `REFLECTION_SYSTEM/` | ACTIVE | Source files for the automated reflection and identity anchoring logic. | Yes | HIGH |
| `scripts/` | SCRIPT | Automation, build, and maintenance scripts. | Yes | HIGH |
| `src/` | ACTIVE | Frontend React (Vite) renderer source and UI components. | Yes | HIGH |
| `tala_project/` | ACTIVE | Specialized Python modules for memory graph management and extraction. | Yes | HIGH |
| `tests/` | TEST | Integrated and unit test suites for the entire application. | Yes | HIGH |
| `tools/` | ACTIVE | Internal development utilities and diagnostic scripts. | Yes | HIGH |

## 2. Directory Deep-Dive

### `electron/`
Primary backend logic for the application shell.
- **Immediate Children**: `brains/`, `services/`, `__tests__`, `main.ts`, `preload.ts`.
- **Classification Evidence**: Logic found in `main.ts` and API handling in `services/`.

### `mcp-servers/`
Specialized tool providers for the agent.
- **Immediate Children**: `astro-engine/`, `mem0-core/`, `tala-core/`, `tala-memory-graph/`.
- **Classification Evidence**: Sub-projects contain `server.py` files following the MCP specification.

### `data/`
Persistent storage layer.
- **Immediate Children**: `chat_sessions/`, `logs/`, `memory/`, `soul/`, `workspace/`.
- **Classification Evidence**: Contains SQLite databases, JSON logs, and configuration overrides.

## 3. Excluded Roots
The following directories are identified but excluded from deep-scanning to avoid documenting external dependencies or transient outputs.

| Path | Reason |
| :--- | :--- |
| `node_modules/` | Third-party Node.js dependencies. |
| `.git/` | Version control metadata. |
| `dist/` | Production build output for the renderer process. |
| `dist-electron/` | Production build output for the main process. |
| `venv/` / `.venv/` | Python virtual environments. |
| `__pycache__/` | Compiled Python bytecode. |
| `archive/` | Historical dependency dumps and legacy data. |
| `bin/python*` | Bundled Python runtimes for portability. |

## 4. Metadata
- **Generated At**: 2026-03-09T08:42:00Z
- **Audit Pass**: 3 (Exhaustive Catalog)
