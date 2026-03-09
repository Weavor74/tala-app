# Tala Application Entrypoints

This document maps the primary entrypoints for starting, building, and maintaining the Tala application.

## 1. Development Entrypoints

| Command | Entrypoint File | Description |
| :--- | :--- | :--- |
| `npm run dev` | `package.json` | Orchestrates the full development environment (Frontend, Main Process, Inference). |
| `npm run dev:vite` | `vite.config.ts` | Starts the Vite dev server for the React frontend. |
| `npm run dev:electron` | `electron/main.ts` | Compiles and launches the Electron main process. |
| `npm run dev:inference` | `scripts/launch-inference.bat` | Starts the local LLM inference background service. |

## 2. Production Entrypoints

| Context | Entrypoint File | Description |
| :--- | :--- | :--- |
| Main Process | `dist-electron/electron/main.js` | The compiled JavaScript entry for the Electron application. |
| Renderer Process | `dist/index.html` | The entry HTML file for the React application. |
| Portable Launch | `start.bat` / `start.sh` | Top-level scripts for launching the portable distribution. |

## 3. Tooling & Maintenance Entrypoints

| Tool | Entrypoint File | Description |
| :--- | :--- | :--- |
| Environment Setup | `bootstrap.ps1` / `.sh` | Initializes the development environment and installations. |
| Python Audit | `scripts/generate_python_dependency_audit.py` | Generates a comprehensive audit of Python dependencies. |
| Testing | `vitest.config.ts` | Entrypoint for the Vitest testing suite. |

## 4. MCP Server Entrypoints

| Server | Entrypoint File | Description |
| :--- | :--- | :--- |
| Tala Core | `mcp-servers/tala-core/server.py` | Entry script for the primary RAG/Agent MCP server. |
| Astro Engine | `mcp-servers/astro-engine/server.py` | Entry script for the astrological emotion server. |
| Mem0 Core | `mcp-servers/mem0-core/server.py` | Entry script for the Mem0 continuity server. |
| Memory Graph | `mcp-servers/tala-memory-graph/src/memory/server.py` | Entry script for the graph memory server. |
