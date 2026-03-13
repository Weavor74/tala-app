# Service: CodeAccessPolicy.ts

**Source**: [electron\services\CodeAccessPolicy.ts](../../electron/services/CodeAccessPolicy.ts)

## Class: `CodeAccessPolicy`

## Overview
Security Enforcement & Sandboxing Engine.  The `CodeAccessPolicy` is the primary safety gate for all filesystem and  shell operations. It defines the boundaries within which the agent is  allowed to operate, preventing both accidental and malicious escapes.  **Core Responsibilities:** - **Path Validation**: Ensures all file operations (read/write/delete) are    anchored to the workspace root and respect extension/denylist filters. - **Command Safety**: Validates shell commands against a prefix allowlist    and strictly blocks chaining operators (&&, |, ;) and destructive patterns. - **Mode Management**: Supports `auto` vs `manual` modes for governing    permission prompts in the UI. - **Size Constraints**: Enforces maximum read sizes to prevent memory    exhaustion from large file reads.

### Methods

#### `getMode`
**Arguments**: ``

---
#### `setMode`
**Arguments**: `mode: 'auto' | 'manual'`

---
#### `getWorkspaceRoot`
**Arguments**: ``

---
#### `validatePath`
Resolves and validates a relative path against the security policy.  **Security Logic:** 1. **Anchor Check**: Resolves path to absolute and ensures it starts     with `workspaceRoot`. 2. **Extension Check**: Blocks non-text or dangerous extensions     (e.g., .exe, .db). 3. **Denylist Check**: Uses `minimatch` to block `node_modules`, `.git`,     and other protected paths. 4. **Exception Handling**: Allows read-only access to specific bundled     binaries even if in a denied folder.  @param relPath - The path relative to the workspace root. @param operation - The type of filesystem operation being attempted. @returns Validation result with the resolved `fullPath`./

**Arguments**: `relPath: string, operation: 'read' | 'write' | 'delete' = 'read'`
**Returns**: ``

---
#### `normalizeCommand`
Normalizes a shell command string by trimming, collapsing whitespace, and stripping wrapping quotes./

**Arguments**: `command: string`
**Returns**: `string`

---
#### `validateCommand`
Validates a shell command for safe execution.  **Safety Gates:** 1. **Chaining Prevention**: Categorically blocks shell operators (`&`, `|`,     `;`, `<`, `>`) to prevent injection or uncontrolled redirection. 2. **Destructive Patterns**: Blocks known dangerous commands like     `rm -rf /` or `format`. 3. **Whitelist Check**: Ensures the command starts with an approved     utility (e.g., `npm`, `git`, `python`).  @param command - The normalized command string to validate. @returns Validation result with an error message on failure./

**Arguments**: `command: string`
**Returns**: ``

---
#### `checkReadSize`
**Arguments**: `size: number`
**Returns**: `boolean`

---
