# Service: TerminalService.ts

**Source**: [electron\services\TerminalService.ts](../../electron/services/TerminalService.ts)

## Class: `TerminalService`

## Overview
Interactive Shell & PTY Service.  The `TerminalService` manages low-level pseudo-terminal (PTY) sessions using `node-pty`. It provides a bridged shell environment for both the user (via `xterm.js`) and  the agent (via `ToolService`).  **Core Responsibilities:** - **PTY Orchestration**: Spawns and manages lifecycle for `powershell.exe` (Windows)    or `bash` (Unix). - **IPC Bridge**: Relays stdin/stdout data between the OS process and the UI. - **Context Buffering**: Maintains a rolling buffer of output used by the agent    to observe the results of its commands. - **Isolation**: Confines shell processes to the `workspaceRoot`. - **Terminal State**: Handles interactive resizing (cols/rows) and exit signals.

### Methods

#### `setWindow`
Sets the Electron BrowserWindow reference used to send terminal output./

**Arguments**: `win: BrowserWindow`

---
#### `setSettingsPath`
Sets the path to the app settings file for firewall checks./

**Arguments**: `path: string`

---
#### `setRoot`
Sets the working directory for the shell process./

**Arguments**: `path: string`

---
#### `setPolicy`
**Arguments**: `policy: CodeAccessPolicy`

---
#### `setCustomEnv`
Sets custom environment variables./

**Arguments**: `env: Record<string, string>`

---
#### `getRecentOutput`
Returns the most recent terminal output and clears the internal buffer./

**Arguments**: ``
**Returns**: `string`

---
#### `createTerminal`
Initializes a new PTY session.  Spawns the default system shell with a custom environment and listeners for incoming data and process exit. The terminal output is automatically  buffered and relayed to the renderer.  @param id - Optional unique identifier for the terminal. If omitted, a random    ID is generated. @returns The terminal session ID./

**Arguments**: `id?: string`
**Returns**: `string`

---
#### `write`
Writes raw data to the shell's standard input (PTY stdin relay). IMPORTANT: This method is a pure pass-through for PTY stdin data. It does NOT validate or policy-check the data — that is the responsibility of CodeControlService.shellRun() when executing agent-initiated commands. ESC sequences, arrow keys, control characters, and empty strings must all pass through without interference./

**Arguments**: `id: string, data: string`

---
#### `resize`
Resizes the terminal dimensions./

**Arguments**: `id: string, cols: number, rows: number`

---
#### `kill`
Forcefully terminates the running shell process./

**Arguments**: `id: string`

---
