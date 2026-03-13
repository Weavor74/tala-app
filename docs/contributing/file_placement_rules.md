# File Placement Rules

This document defines the rules for where new files must be placed in the Tala repository.
These rules apply to all contributors and AI coding agents.

---

## Core Principle

Every file must be placed in the subsystem that owns its responsibility.
When ownership is unclear, consult [`code_roots.json`](../../code_roots.json) and [`subsystem_mapping.json`](../../subsystem_mapping.json).

---

## Rules by File Type

### TypeScript / React source files

| What you are creating | Where it goes |
|-----------------------|--------------|
| React UI component | `src/renderer/components/` |
| React page / view | `src/renderer/` |
| Renderer-side type definitions | `src/renderer/` or alongside the component |
| Electron main process code | `electron/` |
| Backend service | `electron/services/` |
| IPC handler | `electron/services/IpcRouter.ts` or a dedicated service under `electron/services/` |
| Brain implementation | `electron/brains/` |
| Electron type definitions | `electron/types/` |
| Router / context assembly logic | `electron/services/router/` |
| Reflection engine logic | `electron/services/reflection/` |
| Soul / persona / ethics logic | `electron/services/soul/` |
| Planning / strategy logic | `electron/services/plan/` |

### Python source files

| What you are creating | Where it goes |
|-----------------------|--------------|
| New MCP tool | Inside the appropriate MCP server under `mcp-servers/` |
| New MCP server | New directory under `mcp-servers/` |
| Inference runtime helper | `local-inference/` |
| Developer diagnostic script | `scripts/` |
| Developer utility | `tools/` |
| Memory validator | `tools/` |

### Test files

| What you are creating | Where it goes |
|-----------------------|--------------|
| Cross-subsystem Vitest test | `tests/` |
| Electron-specific Vitest test | `electron/__tests__/` |
| MCP server Python test | `mcp-servers/<server>/tests/` |
| Test fixture data | `test_data/` |
| Test mock | `tests/__mocks__/` |

### Scripts and utilities

| What you are creating | Where it goes |
|-----------------------|--------------|
| Diagnostic / audit script | `scripts/` |
| Agent simulation harness | `scripts/` |
| Build / packaging script | `scripts/` |
| Inference launch helper | `scripts/` |
| Health probe | `scripts/` |
| Developer utility (not a script) | `tools/dev/` |

### Documentation

| What you are creating | Where it goes |
|-----------------------|--------------|
| Architecture document | `docs/architecture/` |
| Feature behavioral spec | `docs/features/` |
| Interface / IPC contract | `docs/interfaces/` |
| Security policy | `docs/security/` |
| Requirements document | `docs/requirements/` |
| Traceability document | `docs/traceability/` |
| Contributor guideline | `docs/contributing/` |
| Lifecycle or compliance record | `docs/lifecycle/` or `docs/compliance/` |
| Audit record | `docs/audit/` |

### Configuration files

| What you are creating | Where it goes |
|-----------------------|--------------|
| Top-level project config | Repo root (only if it is a recognized project-level config) |
| MCP server config | Inside the relevant `mcp-servers/<server>/` directory |
| Subsystem-local config | Co-located with the subsystem |

---

## What Must NOT Be Placed Anywhere

The following must never be committed to the repository under any circumstances:

- Runtime databases (`.db`, `.sqlite`)
- Log files (`.log`)
- Memory audit files (`memory_audit.jsonl`)
- Temporary output files (`*_output.txt`, `*_debug*.txt`)
- Session state (`.agent_response_marker`)
- Model weight files (`.gguf`)
- Node modules (`node_modules/`)
- Python virtual environments (`venv/`, `.venv/`)
- Build artifacts (`dist/`, `build/`, `dist-electron/`)
- Scratch notes or session-generated documentation directories

These are excluded in `.gitignore`. Do not work around these exclusions.

---

## What Must NOT Be Placed in the Repo Root

The repo root is reserved for top-level project artifacts listed in [`docs/repo_layout.md`](../repo_layout.md).

Do not place any of the following in the repo root:

- Scratch scripts or one-off utilities
- Diagnostic output files
- Experimental code
- Session notes or temporary markdown files
- Any file that does not belong to the canonical top-level file list

---

## Adding a New Subsystem

If you need to add a new top-level directory (new subsystem):

1. Get explicit approval from a human maintainer.
2. Add an entry to `code_roots.json` at the repo root.
3. Add an entry to `subsystem_mapping.json` at the repo root.
4. Add a row to the root registry table in `docs/code_roots.md`.
5. Add a section to `docs/subsystems.md`.
6. Add the directory to the layout table in `docs/repo_layout.md`.

---

## Ambiguous Cases

If you are unsure where a file belongs:

1. Check `code_roots.json` for the closest matching root path.
2. Check `subsystem_mapping.json` for the file pattern or keyword.
3. Read `docs/subsystems.md` for the subsystem responsibility description.
4. If still unclear, default to placing the file inside the most specific existing subsystem directory and document why.
5. Flag the ambiguity in your PR description for human review.
