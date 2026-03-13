# Agent Working Rules

This document defines the non-negotiable working rules for AI coding agents operating in the Tala repository.
Read this before making any changes.

---

## Rules

### 1. Inspect before editing

Before modifying any file, read it. Before creating any new file, check whether an existing file already covers the responsibility.

### 2. Prefer editing an existing file over creating a new one

If a service, component, or utility already exists that handles the area you are working on, extend it rather than creating a parallel implementation.

### 3. Do not place files in the repo root unless they are top-level project artifacts

The repo root is reserved for project-level config files (`package.json`, `tsconfig.json`, `vite.config.ts`, etc.) and bootstrap scripts. Nothing else.

If you are tempted to drop a file in the repo root, it almost certainly belongs somewhere else.

### 4. Diagnostics belong in `scripts/`

Diagnostic probes, audit scripts, health checks, and simulation harnesses belong in `scripts/`. Not in `src/`, not in `electron/`, not in the repo root.

### 5. Build helpers belong in `scripts/`

Packaging scripts, portable build helpers, and distribution tooling belong in `scripts/`.

### 6. Tests belong in `tests/` or subsystem-specific test folders

- Cross-subsystem Vitest tests → `tests/`
- Electron-specific tests → `electron/__tests__/`
- Python MCP server tests → `mcp-servers/<server>/tests/`
- Test fixture data → `test_data/`

Do not create test files alongside source files unless that is the established pattern for that subsystem.

### 7. Runtime state, logs, archives, temp data, and generated outputs must not be committed

The following are gitignored and must remain excluded:
- `.db`, `.sqlite` files
- `.log` files
- `memory_audit.jsonl`
- `*_output.txt`, `*_debug*.txt`, `*_verify*.log`
- `.gguf` model files
- `node_modules/`, `venv/`, `dist/`, `build/`

If you find yourself needing to write temporary output, use `/tmp/` or a gitignored `tmp/` directory inside the project.

### 8. Respect subsystem boundaries

- `renderer` (src/) communicates with `electron-main` via IPC only. No direct cross-process imports.
- `electron-main` communicates with MCP servers via MCP protocol only. No inline Python execution.
- `electron-main` communicates with `local-inference` via HTTP only.
- MCP servers do not call each other directly.

### 9. If ownership is unclear, consult the mapping files

- [`code_roots.json`](../code_roots.json) — machine-readable registry of all subsystem root paths
- [`subsystem_mapping.json`](../subsystem_mapping.json) — machine-readable file pattern ownership map
- [`docs/subsystems.md`](subsystems.md) — human-readable subsystem responsibility definitions
- [`docs/contributing/file_placement_rules.md`](contributing/file_placement_rules.md) — decision table for file placement

### 10. Update documentation when behavior changes

If your change affects behavior, architecture, interfaces, memory flow, configuration, logging, or developer workflow, update the relevant documentation in `docs/` in the same task. See [`docs/contributing/file_placement_rules.md`](contributing/file_placement_rules.md) for which docs to update.

### 11. Do not invent architecture

Do not create new subsystems, new top-level directories, or new IPC contracts without human approval. Document what exists; do not architect what does not.

### 12. Do not modify `.gitignore` to include files that should remain excluded

If a file is gitignored, it is excluded for a reason. Do not work around gitignore to commit runtime state, generated output, or temporary files.

### 13. Verify before finalizing

Before completing a task:
- Confirm the changed files compile or are syntactically valid.
- Confirm no new files were accidentally placed in the wrong location.
- Confirm no runtime-generated or gitignored files were staged.
- Confirm relevant documentation has been updated or explicitly note why it was not needed.

---

## Quick Reference: Where Does This File Belong?

| I am creating… | It goes in… |
|----------------|-------------|
| React component | `src/renderer/components/` |
| Backend service | `electron/services/` |
| MCP tool | `mcp-servers/<server>/` |
| Diagnostic script | `scripts/` |
| Build script | `scripts/` |
| Test (TS) | `tests/` or `electron/__tests__/` |
| Test fixture | `test_data/` |
| Architecture doc | `docs/architecture/` |
| Feature spec | `docs/features/` |
| Interface contract | `docs/interfaces/` |
| Anything else | Check `code_roots.json` |
