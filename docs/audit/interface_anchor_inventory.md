# Tala — Interface Anchor Inventory
**Audit Mode**: Government-Grade Baseline
**Generated**: 2026-03-09

## 📋 Inventory Summary
This document identifies the "Interface Anchors"—the critical files that define architectural boundaries, API contracts, and security perimeters within the Tala ecosystem.

---

## ⚓ Interface Anchor Inventory

| Path | Type | Boundary Description | Upstream | Downstream |
| :--- | :--- | :--- | :--- | :--- |
| `electron/preload.ts` | **IPC Bridge** | Secure IPC exposure to React frontend. | Frontend | IpcRouter.ts |
| `electron/services/IpcRouter.ts` | **Dispatcher** | Main process IPC handler and router. | preload.ts | Backend Services |
| `electron/services/ToolService.ts` | **Tool Registry** | Registration/Contract boundary for AI tools. | AgentService | Tool Drivers |
| `mcp-servers/tala-core/server.py` | **MCP Server** | Semantic memory boundary (MCP standard). | ToolService | Vector DB |
| `electron/services/AgentService.ts` | **Reasoning Core** | Autonomous turn orchestration boundary. | IpcRouter | Brains / Tools |
| `electron/brains/OllamaBrain.ts` | **Adapter** | Inference service boundary (Local Ollama). | AgentService | Ollama API |
| `electron/services/GuardrailService.ts`| **Safety Gate** | Content validation and filtering boundary. | AgentService | UI / Logs |
| `tala_project/memory/graph/store.py` | **Data Anchor** | Relational/Graph memory store interface. | MCP Server | SQLite |

---

## 🏛 Boundary Mapping
- **Frontend-Backend Boundary**: Mediated by `preload.ts` and `IpcRouter.ts`.
- **Reasoning-execution Boundary**: Mediated by `ToolService.ts`.
- **AI-Data Boundary**: Mediated by the MCP servers and Memory stores.
- **Safety Boundary**: Mediated by `GuardrailService.ts`.
