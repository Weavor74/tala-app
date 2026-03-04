# Code Access Policy & Safe Manipulation

This document describes the security policy and endpoints that allow Tala to safely manipulate its own source code for self-maintenance and refactoring.

## Workspace Root
Tala's workspace root is set to the repository root (where `package.json` is located). All file and shell operations resolve paths relative to this root.

## Policy Rules

### Allowed Extensions
Only files with the following extensions can be read or written:
`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.ps1`, `.bat`, `.sh`, `.json`, `.jsonl`, `.md`, `.yml`, `.yaml`, `.toml`, `.ini`, `.sql`, `.txt`

### Denied Paths
Operations are blocked if they touch:
- `node_modules/**`
- `.git/**`
- `bin/**` (Except for read-only access to `bin/python-win/`)
- Binary files: `**/*.exe`, `**/*.dll`, `**/*.pyd`, `**/*.so`, `**/*.db`

### Read Constraints
- **Max Read Size**: 2MB per file.

### Access Mode
- **auto**: All operations within policy are allowed.
- **manual**: Write, Move, Delete, and Shell operations require explicit user approval.

## IPC Endpoints

### File Operations
- `fs:read-text(path)`: Returns `{ ok, content }`.
- `fs:write-text(path, content)`: Returns `{ ok, path }`.
- `fs:list(path)`: Returns `{ ok, entries }`.
- `fs:mkdir(path)`: Returns `{ ok }`.
- `fs:move(src, dst)`: Returns `{ ok }`.
- `fs:delete(path)`: Returns `{ ok }`.
- `fs:search(query)`: Returns `{ ok, results }`.

### Shell Operations
- `shell:run(command, cwd?)`: Returns `{ ok, exitCode, stdout, stderr, duration }`.

## Agent Workflow Guardrails
When Tala modifies code, she must follow this sequence:
1. **Plan**: Describe the intended changes.
2. **Apply**: Use `fs:write-text` to apply minimal patches.
3. **Verify**: Run verification commands (e.g., `npm run lint`, `npm test`).
4. **Summarize**: Report the final outcome.

## Auditing
All code manipulation actions are logged to `userData/logs/audit-log.jsonl` with:
- `action_type`
- `relative_path(s)`
- `result`
- `duration`
- `content_hash` (for writes)
