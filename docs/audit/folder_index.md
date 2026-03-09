# Tala Repository Folder Index

This document provides functional descriptions for the primary directories in the Tala repository.

## Root Directories

| Folder | Description |
| :--- | :--- |
| `.agent/` | Agent-specific configuration, functions, and workflows. |
| `.tala/` | Application-level settings and metadata. |
| `archive/` | Historical or manual test databases and development tools. |
| `bin/` | Executable binaries (llama.cpp) and bundled Python distributions. |
| `data/` | User data, app settings, and shared storage. |
| `docs/` | Project documentation and audit reports. |
| `electron/` | Electron main process source code, services, and tests. |
| `local-inference/` | Backend service for local model execution (Python). |
| `mcp-servers/` | Collection of Model Context Protocol (MCP) server implementations. |
| `memory/` | Roleplay data and memory-related artifacts. |
| `models/` | Storage for Large Language Model (LLM) weights. |
| `public/` | Static assets for the React renderer. |
| `REFLECTION_SYSTEM/` | (Legacy or Specialized) Source files for the reflection engine logic. |
| `scripts/` | Deployment, build, and maintenance scripts. |
| `src/` | Frontend React application (renderer process). |
| `tests/` | Integrated and unit tests for various project components. |
| `tools/` | Internal development utilities. |

## Sub-Component Breakdown

### `electron/`
- `main.ts`: Entry point for the Electron main process.
- `services/`: Core backend services (Reflection, Identity, Rag, etc.).
- `__tests__/`: Unit tests for the main process logic.

### `mcp-servers/`
- `astro-engine/`: MCP server for astrological emotional state calculation.
- `mem0-core/`: Core Mem0 interaction server.
- `tala-core/`: Central RAG and metadata service and core agent logic.
- `tala-memory-graph/`: Graph-based memory storage and retrieval server.

### `src/`
- `renderer/`: Shared types and logic for the React app.
- `components/`: UI components (ReflectionDashboard, Chat, etc.).
- `context/`: React context providers for state management.
