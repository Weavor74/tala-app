# Tala — Exhaustive File Catalog
**Audit Pass**: 3 (Deep Catalog)
**Generated**: 2026-03-09

## 📋 Catalog Overview
This document provides a detailed mapping of every meaningful authored file in the Tala repository. Unlike the `file_index.md`, this catalog includes behavioral summaries and identifies the specific role of each file within its subsystem.

---

## 🚫 Excluded Roots (Detailed Mapping)
The following directories were deep-scanned but excluded from documentation by policy. They represent vendor, build, or large archive areas.

- **`node_modules/`**: Vendor dependencies (Npm).
- **`venv/` / `.venv/`**: Python virtual environments.
- **`dist/` / `dist-electron/`**: Compiled output for frontend and main process.
- **`bundled-python-runtime/`**: Local Python distributables for portable mode.
- **`.git/`**: Git metadata.
- **`archive/`**: Deprecated or manual-dev tools not part of the active product stream.

---

## 🏗 Subsystem Catalogs

### 1. Orchestration & Mind (Electron Backend)
| File Path | Type | Behavioral Summary | Key Symbols |
| :--- | :--- | :--- | :--- |
| `electron/main.ts` | **ENTRYPOINT** | App lifecycle, window management, and service initialization. | `createWindow`, `initializeServices` |
| `electron/services/AgentService.ts` | **SERVICE** | Central orchestrator; manages multi-turn AI reasoning loops and tool extraction. | `AgentService`, `chat`, `headlessInference` |
| `electron/services/ToolService.ts` | **SERVICE** | Tool registration and execution dispatcher for system/MCP tools. | `ToolService`, `registerCoreTools`, `executeTool` |
| `electron/services/IpcRouter.ts` | **SERVICE** | Routes frontend IPC requests to backend services. | `IpcRouter`, `initialize` |
| `electron/services/WorkflowEngine.ts` | **SERVICE** | Executes complex, multi-step workflow graphs with conditional routing. | `WorkflowEngine`, `executeWorkflow`, `step` |
| `electron/services/GuardrailService.ts` | **SERVICE** | Content safety layer; validates LLM inputs/outputs against rules. | `GuardrailService`, `validate` |

### 2. Brains & Inference
| File Path | Type | Behavioral Summary | Key Symbols |
| :--- | :--- | :--- | :--- |
| `electron/brains/OllamaBrain.ts` | **MODULE** | Comm. driver for local Ollama; includes repetition and phrase-based safety filters. | `OllamaBrain`, `generateResponse`, `streamResponse` |
| `electron/brains/CloudBrain.ts` | **MODULE** | API driver for remote LLM providers (Anthropic, Google, etc). | `CloudBrain`, `streamResponse` |
| `electron/services/InferenceService.ts` | **SERVICE** | Local engine setup and model scanning logic. | `InferenceService`, `setupEngine` |

### 3. Memory & RAG (Python/MCP)
| File Path | Type | Behavioral Summary | Key Symbols |
| :--- | :--- | :--- | :--- |
| `mcp-servers/tala-core/server.py` | **MCP_SERVER** | Numpy-based vector store for semantic memory and RAG. | `TalaCoreServer`, `search_memory`, `ingest` |
| `mcp-servers/mem0-core/server.py` | **MCP_SERVER** | Continuity memory provider for fact/preference tracking. | `Mem0Server`, `add_fact`, `search` |
| `tala_project/memory/graph/store.py` | **MODULE** | SQLite-backed graph store for entity relationships. | `SQLiteGraphBackend`, `upsert_node` |

### 4. UI & Experience (React/Renderer)
| File Path | Type | Behavioral Summary | Key Symbols |
| :--- | :--- | :--- | :--- |
| `src/App.tsx` | **UI_ROOT** | Main layout orchestration and global state management in the renderer. | `App`, `ChatContainer`, `ActivityBar` |
| `src/renderer/components/Terminal.tsx` | **UI_COMPONENT** | Renders the interactive terminal via xterm.js; bridges to Electron PTY. | `Terminal` |
| `src/renderer/components/LogViewerPanel.tsx` | **UI_COMPONENT** | Dashboard for viewing system, audit, and performance logs in real-time. | `LogViewerPanel` |
| `src/renderer/components/WorkflowEditor.tsx` | **UI_COMPONENT** | Visual graph editor for designing and debugging agent workflows. | `WorkflowEditor` |

### 5. Infrastructure & Configuration
| File Path | Type | Behavioral Summary |
| :--- | :--- | :--- |
| `package.json` | **CONFIG** | Project manifest, dependencies, and build scripts. |
| `vite.config.ts` | **CONFIG** | Build pipeline and dev server configuration for React. |
| `scripts/bootstrap.sh` | **SCRIPT** | One-touch environment setup for new developer installs. |
| `agent_profiles.json` | **CONFIG** | Persisted agent definitions (personas, system prompts). |

---

> [!NOTE]
> This catalog is intended to be exhaustive for authored areas. If a file is missing from a primary source directory, it may have been flagged as a generic utility not requiring deep documentation in this pass.
