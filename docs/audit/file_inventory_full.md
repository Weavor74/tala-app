# Tala — Full File Inventory
**Audit Mode**: Government-Grade Baseline
**Generated**: 2026-03-09

## 📋 Inventory Summary
This document provides an exhaustive mapping of every authored file in the Tala repository, including size, architectural role, and purpose.

---

## 🏗 Authored File Inventory

| Path | Ext | Role | Subsystem | Size | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `electron/main.ts` | .ts | **ENTRY** | Infrastructure | 12K | App startup and lifecycle management. |
| `electron/services/AgentService.ts` | .ts | **SERVICE** | Orchestration | 132K | Central AI reasoning core. |
| `electron/services/ToolService.ts` | .ts | **SERVICE** | Orchestration | 73K | Tool registry and dispatcher. |
| `electron/services/IpcRouter.ts` | .ts | **SERVICE** | Connectivity | 73K | Frontend-Backend bridge. |
| `electron/services/WorkflowEngine.ts` | .ts | **SERVICE** | Automation | 46K | Multi-step agent workflow executor. |
| `src/App.tsx` | .tsx | **UI_ROOT** | Frontend | 45K | React root and layout composition. |
| `src/main.tsx` | .tsx | **ENTRY** | Frontend | 2K | React renderer entrypoint. |
| `mcp-servers/tala-core/server.py` | .py | **MCP** | Memory/RAG | 12K | Semantic memory server. |
| `package.json` | .json | **CONFIG** | Infra | 3K | Npm manifest and build scripts. |
| `vite.config.ts` | .ts | **CONFIG** | Infra | <1K | Vite build configuration. |
| `tsconfig.json` | .json | **CONFIG** | Infra | <1K | TypeScript compiler configuration. |
| `scripts/bootstrap.sh` | .sh | **SCRIPT** | Ops | 5K | Environment setup script. |

> [!NOTE]
> This table is a representation of the 542 authored assets captured in the [full JSON inventory](file:///d:/src/client1/tala-app/docs/audit/file_inventory_full.json). Every authored file has an entry in the primary system record.

---

## 🏛 Config Inventory Summary
Configs that define runtime behavior and security boundaries:
- `package.json`: Main manifest.
- `package-lock.json`: Dependency integrity.
- `agent_profiles.json`: Persona and security policy definitions.
- `tsconfig.json`: Build safety.
- `vite.config.ts`: Frontend isolation.
