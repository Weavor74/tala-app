# Repository Layout

This document is the authoritative reference for the Tala repository directory structure.
It is intended for both human contributors and AI coding agents.

---

## Core Application

| Path | Purpose |
|------|---------|
| `src/` | React renderer UI — chat interface, settings panel, reflection dashboard, component library |
| `electron/` | Electron main process, preload scripts, IPC router, and all backend services |
| `shared/` | Shared pure types, interfaces, and enums — neutral contracts between renderer and electron |
| `public/` | Static frontend assets served by Vite (splash screen, icons, vendor assets) |

---

## Runtime / Tooling

| Path | Purpose |
|------|---------|
| `local-inference/` | Local model serving runtime (Ollama / llama.cpp integration, launch scripts) |
| `mcp-servers/` | MCP capability servers — Python microservices exposing tools to the agent |

### MCP server inventory

| Server | Path | Responsibility |
|--------|------|---------------|
| `astro-engine` | `mcp-servers/astro-engine/` | Emotional state computation and persona modulation |
| `tala-core` | `mcp-servers/tala-core/` | Core Tala tool surface (file I/O, memory primitives) |
| `mem0-core` | `mcp-servers/mem0-core/` | Mem0-backed long-term memory persistence |
| `tala-memory-graph` | `mcp-servers/tala-memory-graph/` | Graph-structured memory layer |
| `world-engine` | `mcp-servers/world-engine/` | World-state and context persistence |

---

## Validation

| Path | Purpose |
|------|---------|
| `tests/` | Shared Vitest test suites (cross-subsystem, integration-level) |
| `electron/__tests__/` | Electron-specific unit and integration tests |
| `mcp-servers/*/tests/` | Per-server Python test suites |
| `test_data/` | Fixture data used by tests — not runtime state |

---

## Developer Utilities

| Path | Purpose |
|------|---------|
| `scripts/` | Diagnostics, build packaging, portable distribution helpers, simulation scripts |
| `tools/` | Developer utilities (memory validator, dev helpers) |

### Scripts inventory

| Pattern | What lives here |
|---------|----------------|
| `scripts/diagnose_*.ts` | System diagnostics and audit probes |
| `scripts/simulate_*.ts` | Agent simulation harnesses |
| `scripts/make_portable*` | Portable distribution build scripts |
| `scripts/launch-inference*` | Inference server launch helpers |
| `scripts/health_probe.*` | Health check runners |

---

## Documentation

| Path | Purpose |
|------|---------|
| `docs/` | Authoritative project documentation (architecture, features, interfaces, security, traceability) |
| `docs/architecture/` | System design, component model, runtime flow, data flow |
| `docs/features/` | Per-feature behavioral documentation |
| `docs/interfaces/` | IPC contracts, MCP tool contracts, API shapes |
| `docs/security/` | Security policy, write controls, audit behavior |
| `docs/traceability/` | Requirements-to-implementation and test trace matrices |
| `docs/contributing/` | Contributor guidelines and file placement rules |

---

## Historical / Reference

| Path | Purpose |
|------|---------|
| `archive/` | Historical reference material. Not active code. Do not extend. |
| `patches/` | Applied patch files for dependency overrides |

---

## Top-Level Config Files

The following files are the only items that belong at the repo root:

| File | Purpose |
|------|---------|
| `package.json` | Node project manifest and scripts |
| `package-lock.json` | Locked dependency tree |
| `tsconfig*.json` | TypeScript compiler configuration |
| `vite.config.ts` | Vite bundler configuration |
| `vitest.config.ts` | Vitest test runner configuration |
| `eslint.config.js` | ESLint linting rules |
| `index.html` | Vite HTML entry point |
| `README.md` | Project overview |
| `AGENTS.md` | Agent instruction file |
| `MASTER_PYTHON_REQUIREMENTS.txt` | Consolidated Python dependency list |
| `bootstrap.sh` / `bootstrap.ps1` | One-shot environment setup scripts |
| `start.sh` / `start.bat` | Quick-launch scripts |
| `.gitignore` | Git exclusion rules |
| `code_roots.json` | Machine-readable subsystem root registry |
| `subsystem_mapping.json` | Machine-readable subsystem ownership map |

---

## Rules

1. **Do not place scratch files in the repo root.** Use `tmp/` (gitignored) for ephemeral work.
2. **Do not commit runtime databases, logs, temp data, or generated output.** These are excluded by `.gitignore`.
3. **New files must be placed in the subsystem that owns their responsibility.** Consult `code_roots.json` and `subsystem_mapping.json` when ownership is unclear.
4. **Do not add new top-level directories** without updating `docs/repo_layout.md`, `code_roots.json`, and `subsystem_mapping.json`.
5. **The `shared/` directory is a neutral contract zone.** It must not contain UI logic, React components, Electron service logic, or any side-effectful runtime code.
6. **The `archive/` directory is frozen.** Do not add files to it.
7. **Diagnostics and simulation scripts belong in `scripts/`.** Do not place them in `src/`, `electron/`, or the repo root.
