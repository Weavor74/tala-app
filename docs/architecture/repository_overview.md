# Repository Overview: Tala

Tala is a high-fidelity, autonomous agentic platform designed for secure, local-first artificial intelligence operations. It combines the power of modern LLMs with a structured desktop shell (Electron) and a modular service architecture (MCP).

## Root Architecture

The repository is organized following a clear concern-separation pattern:

| Directory | Responsibility |
|---|---|
| `electron/` | **Main Process**: System orchestration, native services, IPC routing, and application lifecycle. |
| `src/renderer/` | **Renderer Process**: High-fidelity React UI, workspace surfaces, and user interaction layer. |
| `shared/` | **Contract Layer**: Bit-identical TypeScript types, interfaces, and constants shared between Main and Renderer. |
| `docs/` | **Knowledge Base**: Architectural specs, interface matrices, and feature documentation. |
| `scripts/` | **Tooling & Maintenance**: DevOps, diagnostics, self-healing, and documentation automation. |
| `mcp-servers/` | **Capability Layer**: Isolated MCP service implementations (Python/JS). |
| `tests/` | **Verification**: End-to-end and integration test suites. |

## Key Technologies

- **Core Runtime**: Electron (Node.js + Chromium), TypeScript.
- **UI Stack**: React, ReactFlow (for graph visualization), Tailwind CSS.
- **Persistence**: PostgreSQL with `pgvector` (RAG), SQLite (metadata), and local file system.
- **Inference**: Deterministic provider selection with local-first fallback (`ollama` -> `vllm` -> `llamacpp` -> `koboldcpp` -> `embedded_vllm` -> `embedded_llamacpp` -> `cloud`) via `InferenceService` + `ProviderSelectionService`.
- **Extensibility**: Model Context Protocol (MCP) for tool and service abstraction.

## Cognitive & Memory Systems (P7B/P7D)

Tala implements a sophisticated cognitive flow:
1.  **Retrieval Orchestration**: Multi-source retrieval (RAG, Conversation, Graph).
2.  **Context Assembly**: Deterministic ranking and greedy selection based on authority, recency, and semantic score.
3.  **Authority Enforcement**: Canonical-vs-derived conflict resolution (Feed 4).
4.  **Affective Modulation**: Mood-based weighting (Astro/Emotion) integrated into scoring.
5.  **Explainability**: Full diagnostics traceability (Feed 5).

## Developer Navigation

- **Adding a Service**: Place in `electron/services/` and register in `electron/services/IpcRouter.ts`.
- **Defining Types**: Use `shared/` for any type crossing the IPC boundary.
- **Modifying the UI**: Focus on `src/renderer/` and `A2UIWorkspaceSurface.tsx` for structured surfaces.
- **Running Diagnostics**: Use `npm run repo:fullcheck` for full repository checks and `npm run docs:heal-and-validate` for documentation enforcement.

## Documentation Enforcement (Current Lifecycle)

- Deterministic regeneration: `npm run docs:regen`
- Deterministic doclock healing: `npm run docs:heal`
- Full validation gate: `npm run docs:validate`
- Canonical completion gate: `npm run docs:heal-and-validate`
- Compatibility alias: `npm run docs:selfheal` (runs regen, then canonical completion gate)

---
*This document is maintained by the documentation self-healing script (`scripts/diagnostics/maintenance/docs_maintenance.ts`).*
