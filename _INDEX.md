# tala-app/ — Project Root

Tala is an Electron + React AI agent desktop application with Python microservice backends.

---

## Folders

| Folder | Description |
|---|---|
| `electron/` | Main process code — services, brains, preload scripts, and the Electron entry point. |
| `src/` | Renderer process code — React UI components, styles, and frontend logic. |
| `mcp-servers/` | Python microservices communicating via the Model Context Protocol (MCP). |
| `memory/` | Long-term memory files (LTMF) — 418 narrative text files used for Tala's character lore and persona. |
| `public/` | Static assets served by Vite (SVGs, images). |
| `models/` | Placeholder directory for local AI model weights (currently contains only a README). |
| `data/` | Runtime data directory (ChromaDB vector databases, etc.). |
| `dist/` | Vite build output (compiled renderer). _Generated — do not edit._ |
| `dist-electron/` | Compiled Electron main process JS + source maps. _Generated — do not edit._ |
| `node_modules/` | NPM dependencies. _Generated — do not edit._ |
| `vllm_engine/` | Experimental vLLM inference engine (not active in current build). |
| `.agent/` | Agent workspace config (workflows, functions). |

---

## Files

| File | Description |
|---|---|
| `package.json` | NPM manifest — defines dependencies, scripts (`dev`, `build`, `preview`), and Electron entry point. |
| `package-lock.json` | Locked dependency tree for reproducible installs. |
| `tsconfig.json` | Root TypeScript config — references `tsconfig.app.json` and `tsconfig.node.json`. |
| `tsconfig.app.json` | TypeScript config for the renderer (React/Vite) — targets ESNext, includes `src/`. |
| `tsconfig.node.json` | TypeScript config for the main process (Electron/Node) — targets ESNext, includes `electron/`. |
| `vite.config.ts` | Vite bundler config — enables React plugin and Electron integration via `vite-plugin-electron`. |
| `eslint.config.js` | ESLint configuration for code linting. |
| `index.html` | HTML entry point — Vite injects the React bundle here. |
| `.gitignore` | Git ignore rules (node_modules, dist, venv, etc.). |
| `README.md` | Project overview and getting-started instructions. |
| `TALA_CAPABILITIES.md` | Documents Tala's feature set and agent capabilities. |
| `TALA_CONFIGURATION.md` | Configuration reference for `app_settings.json`. |
| `TALA_TECH_STACK.md` | Technology stack breakdown (Electron, React, Python, ChromaDB, etc.). |
| `MASTER_NODE_LIST.txt` | Reference list of workflow node types available in the WorkflowEngine. |
| `MASTER_PYTHON_REQUIREMENTS.txt` | Aggregated Python dependency list across all MCP servers. |
| `TASK.MD` | Current top-level task notes. |
| `agent_profiles.json` | Astrological agent profile data (birth dates, etc.). |
| `Hello.py` | Test Python script. |
| `test.txt` / `test2.txt` / `test3.txt` | Development test files. |
| `test_split.js` / `test_split.ts` | Test scripts for text splitting/chunking logic. |
| `inspect_db_debug.py` | Debug script to inspect ChromaDB contents. |
| `inspect_sources.py` | Debug script to inspect indexed sources. |
| `response.txt` | Temporary response output file. |
| `git_debug_log.txt` | Git debug output. |
| `.agent_response_marker` | Internal marker file used by the agent system. |
