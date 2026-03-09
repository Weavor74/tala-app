# Tala — Full Folder Inventory
**Audit Mode**: Government-Grade Baseline
**Generated**: 2026-03-09

## 📋 Inventory Summary
This document provides an exhaustive listing of all authored folders in the Tala repository. It serves as a baseline for engineering security and procurement reviews.

---

## 🏗 Authored Folder Inventory

| Path | Status | Parent | Child Count | Purpose | Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `electron` | **ACTIVE** | root | 98 | Main background process and service orchestration. | Contains `main.ts` and core services. |
| `electron/brains` | **ACTIVE** | electron | 5 | LLM inference drivers (Ollama, Cloud). | Implements brain-specific API logic. |
| `electron/services` | **ACTIVE** | electron | 37 | Core business logic and agent tools. | Contains `AgentService.ts` and `ToolService.ts`. |
| `src` | **ACTIVE** | root | 38 | React frontend source (Renderer process). | Contains `App.tsx` and UI sub-folders. |
| `src/renderer/components` | **ACTIVE** | src/renderer | 22 | UI widgets and feature-specific panels. | High-fidelity React components (Terminal, logs). |
| `mcp-servers` | **ACTIVE** | root | 94 | Context servers for Tool execution (RAG, etc). | Python/Node MCP standard servers. |
| `scripts` | **ACTIVE** | root | 66 | Launchers, DevOps, and build automation. | Shell/PS1 setup and run scripts. |
| `tala_project` | **ACTIVE** | root | 1 | Core internal Python package logic. | Python memory/graph store modules. |
| `data` | **ACTIVE** | root | 5 | Application state and profile definitions. | Persisted JSON configs (User/Agent profiles). |
| `docs` | **ACTIVE** | root | 51 | Technical and audit documentation. | Project specifications and audit logs. |
| `tests` | **ACTIVE** | root | 9 | Unit and integration test suites. | Vitest and Python test files. |
| `local-inference` | **ACTIVE** | root | 1 | Local LLM binaries/configs (Llama.cpp). | Inference engine configuration files. |
| `archive` | **ARCHIVE** | root | 26 | Deprecated dev-tools and legacy code. | Non-production diagnostic scripts. |

---

## 🚫 Excluded Directories (Inventory Boundary)
The following directories are explicitly excluded from the inventory baseline as they represent non-authored vendor or build artifacts:
- `node_modules/` (Vendor Npm packages)
- `venv/` / `.venv/` / `site-packages/` (Python environments)
- `dist/` / `dist-electron/` (Compiled binaries)
- `.git/` (VCS metadata)
- `bundled-python-runtime/` (Portable distribution)
