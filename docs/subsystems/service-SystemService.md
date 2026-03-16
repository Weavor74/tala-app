# Service: SystemService.ts

**Source**: [electron/services/SystemService.ts](../../electron/services/SystemService.ts)

## Class: `SystemService`

## Overview
Contains comprehensive information about the user's system environment,
 including operating system details, runtime paths and versions,
 virtual environment detection, and merged environment variables.
 
 This information is used throughout the application to:
 - Determine which shell to use (PowerShell vs bash).
 - Resolve Python/Node.js executables for function and MCP server execution.
 - Inject proper environment variables (venv, `.env` file values).
/
export interface SystemInfo {
    /** Operating system type (e.g., `'Windows_NT'`, `'Darwin'`, `'Linux'`). From `os.type()`. */
    os: string;
    /** Platform identifier (e.g., `'win32'`, `'darwin'`, `'linux'`). From `os.platform()`. */
    platform: string;
    /** CPU architecture (e.g., `'x64'`, `'arm64'`). From `os.arch()`. */
    arch: string;
    /** Absolute path to the Node.js executable, or `'Not Found'`. */
    nodePath: string;
    /** Node.js version string (e.g., `'v20.11.0'`). From `process.version`. */
    nodeVersion: string;
    /** Absolute path to the system Python executable, or `'Not Found'`. */
    pythonPath: string;
    /** Python version string (e.g., `'Python 3.11.5'`), may include venv info like `'(Venv: venv)'`. */
    pythonVersion: string;
    /** Absolute path to the Python executable inside a detected virtual environment (e.g., `venv/Scripts/python.exe`). */
    pythonEnvPath?: string;
    /** Absolute path to a `.env` file found in the workspace root, if one exists. */
    workspaceEnvFile?: string;
    /** Merged environment variables from `process.env`, venv activation, and `.env` file. */
    envVariables?: Record<string, string>;
}

/**
 System Environment Detection & Configuration Engine.
 
 The `SystemService` is a foundational utility that probes the host machine 
 to resolve runtime paths, detect virtual environments, and aggregate 
 environment variables. It ensures that the agent has a complete "map" 
 of the execution environment before attempting to run external code.
 
 **Core Responsibilities:**
 - **OS Fingerprinting**: Reports system type, architecture, and platform.
 - **Runtime Resolution**: Locates Node.js and system-level Python executables.
 - **Venv Discovery**: Scans the workspace for virtual environments (`venv`, `.venv`) 
   and resolves their specific Python binaries.
 - **Variable Merging**: Combines `process.env`, `.env` file values, and venv-specific 
   variables into a unified environment map.
 - **Execution Safety**: Performs preflight checks to ensure selected runtimes 
   are functional.

### Methods

#### `detectEnv`
Performs a deep probe of the host system and workspace.
 
 **Detection Phases:**
 1. **OS Metadata**: Captures platform and architecture.
 2. **Executable Paths**: Resolves Node and Python binaries via standard 
    platform utilities (`where`/`which`).
 3. **Workspace Scan**: If `workspaceDir` is provided, performs a deep 
    recursive scan for Python virtual environments.
 4. **Environment Aggregation**: Merges `.env` file contents over system 
    and venv variables, ensuring a correct runtime context.
 
 @param workspaceDir - Optional absolute path to anchor the workspace search.
 @returns A `SystemInfo` snapshot reflecting the current detection state.
/

**Arguments**: `workspaceDir?: string`
**Returns**: `Promise<SystemInfo>`

---
#### `resolveMcpPythonPath`
Resolves the canonical Python executable for MCP servers.
 Always prefers bundled/portable python unless useMcpVenv is explicitly true.
/

**Arguments**: `config?: { useMcpVenv?: boolean }, currentInfo?: SystemInfo`
**Returns**: `string`

---
#### `getMcpEnv`
Constructs a sanitized environment for MCP Python processes.
 Removes PYTHONHOME/PYTHONPATH to prevent conflicts and sets standard flags.
/

**Arguments**: `baseEnv?: Record<string, string>`
**Returns**: `Record<string, string>`

---
#### `preflightCheck`
Performs a mandatory preflight check to ensure the Python interpreter can import stdlib.
 Throws an error on failure.
/

**Arguments**: `pythonPath: string`
**Returns**: `void`

---
