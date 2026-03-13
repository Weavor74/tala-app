# Code Roots

This document lists every official code root in the Tala repository along with its language, owner, and canonical purpose.

For the machine-readable version, see [`code_roots.json`](../code_roots.json) at the repo root.

---

## Root Registry

| Root Path | Language | Subsystem ID | Purpose |
|-----------|----------|--------------|---------|
| `src/` | TypeScript / React | `renderer` | Renderer UI (chat, settings, reflection dashboard) |
| `electron/` | TypeScript | `electron-main` | Electron main process, preload, IPC, backend services |
| `mcp-servers/astro-engine/` | Python | `mcp-astro` | Astrological emotional state engine (MCP server) |
| `mcp-servers/tala-core/` | Python | `mcp-tala-core` | Core agent tool surface (MCP server) |
| `mcp-servers/mem0-core/` | Python | `mcp-mem0` | Mem0-backed long-term memory (MCP server) |
| `mcp-servers/tala-memory-graph/` | Python | `mcp-memory-graph` | Graph-structured memory layer (MCP server) |
| `mcp-servers/world-engine/` | Python | `mcp-world-engine` | World-state and context persistence (MCP server) |
| `local-inference/` | Python / Shell | `local-inference` | Local model serving runtime (Ollama / llama.cpp) |
| `tests/` | TypeScript | `tests` | Shared cross-subsystem test suites |
| `electron/__tests__/` | TypeScript | `electron-main` | Electron-specific unit and integration tests |
| `scripts/` | TypeScript / Shell / Python | `scripts` | Developer diagnostics, simulation, and build tooling |
| `tools/` | Python / TypeScript | `tools` | Developer utility scripts |
| `docs/` | Markdown | `docs` | Authoritative project documentation |
| `public/` | HTML / Assets | `renderer` | Static frontend assets served by Vite |
| `test_data/` | JSON / Text | `tests` | Test fixture data (not runtime state) |
| `archive/` | Various | `archive` | Historical reference — frozen, do not extend |

---

## Notes

- `electron/__tests__/` is co-located with `electron/` and is considered part of the `electron-main` subsystem for ownership purposes.
- `mcp-servers/*/tests/` directories are part of their respective MCP server subsystems.
- `archive/` has no active ownership. It is preserved for historical reference only.
- The repo root itself is not a code root. Top-level config files are listed in [`docs/repo_layout.md`](repo_layout.md).
