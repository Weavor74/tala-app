# Tala Repository File Index

This index provides functional descriptions for key source code and configuration files.

## Electron (Main Process)

| File | Description |
| :--- | :--- |
| `electron/main.ts` | Main process entry point. Manages application lifecycle, window creation, and IPC registration. |
| `electron/preload.ts` | Preload script for the renderer process. Uses `contextBridge` to expose secure APIs to the frontend. |
| `electron/services/` | Directory containing backend service implementations (e.g., `ReflectionService.ts`, `IdentityService.ts`). |
| `electron/bootstrap.ts` | Initialization logic for the main process environment. |

## React Renderer (Frontend)

| File | Description |
| :--- | :--- |
| `src/main.tsx` | Entry point for the React application. Renders the `App` component into the DOM. |
| `src/App.tsx` | Root UI component. Handles routing, layout, and global state (via Context). |
| `src/renderer/` | Shared TypeScript types, constants, and utilities for the frontend. |
| `src/components/` | Individual React components for various features (Reflection, Chat, Terminal). |

## MCP Servers (Python)

| File | Description |
| :--- | :--- |
| `mcp-servers/tala-core/server.py` | Main MCP server for Tala. Implements RAG and core agent capabilities. |
| `mcp-servers/astro-engine/server.py` | (Implicit via launch) Service for astrological emotional vector calculations. |
| `mcp-servers/mem0-core/server.py` | Implementation of the Mem0 memory interaction server. |
| `mcp-servers/tala-memory-graph/src/memory/server.py` | Graph-based memory retrieval server. |

## Configuration & Manifests

| File | Description |
| :--- | :--- |
| `package.json` | Node.js project configuration, scripts, and dependencies. |
| `MASTER_PYTHON_REQUIREMENTS.txt` | Consolidated list of Python dependencies for the entire project. |
| `tsconfig.json` | Global TypeScript compiler configuration. |
| `vite.config.ts` | Build and development configuration for Vite. |
| `vitest.config.ts` | Test configuration for the Vitest framework. |
| `eslint.config.js` | Linting rules for the codebase. |

## Miscellaneous

| File | Description |
| :--- | :--- |
| `launch-inference.bat` | Script to start the local model inference backend. |
| `bootstrap.ps1` / `.sh` | Environment setup and installation scripts. |
| `README.md` | Primary project overview and setup guide. |
