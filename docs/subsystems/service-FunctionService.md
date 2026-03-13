# Service: FunctionService.ts

**Source**: [electron\services\FunctionService.ts](../../electron/services/FunctionService.ts)

## Class: `FunctionService`

## Overview
Represents a custom agent function (script) stored in the `.agent/functions/` directory. Functions are invocable by the AI agent using a `$keyword` syntax in chat, where the keyword corresponds to the filename without extension./
export interface AgentFunction {
    /** The function keyword (filename without extension). Used as `$keyword` in agent commands. */
    name: string;
    /** The full source code content of the script file. */
    content: string;
    /** The scripting language of the function — determines the runtime used for execution. */
    type: 'python' | 'javascript';
    /** Absolute path to the script file on disk. */
    path: string;
}

/** FunctionService  Manages custom agent functions — user-created Python and JavaScript scripts that the AI agent can execute on demand. Functions are stored as individual script files in the `.agent/functions/` directory within the workspace.  **How it works:** 1. The user (or agent) creates a script and saves it via `saveFunction()`. 2. During chat, the agent can call `$keyword` to invoke `executeFunction(keyword)`. 3. The service detects the script language (`.py` or `.js`), resolves the    runtime path (Python or Node.js from `SystemService`), and spawns a child process. 4. The script's stdout is captured and returned as the function result.  **File storage:** ``` <workspace>/.agent/functions/   ├── fetch_weather.py     → invoked as $fetch_weather   ├── parse_data.js        → invoked as $parse_data   └── summarize.py         → invoked as $summarize ```  @example ```typescript const funcService = new FunctionService(systemService, '/workspace'); funcService.saveFunction('greet', 'print("Hello!")', 'python'); const output = await funcService.executeFunction('greet', []); console.log(output); // "Hello!" ```

### Methods

#### `setRoot`
Updates the workspace root and recalculates the functions directory path. Also ensures the new functions directory exists on disk.  @param {string} newRoot - The new absolute path to the workspace root. @returns {void}/

**Arguments**: `newRoot: string`

---
#### `ensureDir`
Ensures the `.agent/functions/` directory exists on disk. Creates it recursively (including the `.agent/` parent) if it doesn't exist. Called internally before read/write operations.  @private @returns {void}/

**Arguments**: ``

---
#### `listFunctions`
Lists all custom agent functions by scanning the functions directory.  Reads all `.py` and `.js` files from the functions directory, loading each file's full source code content into memory. Non-script files (e.g., `.txt`, `.md`, directories) are ignored.  @returns {AgentFunction[]} Array of function definitions with name, content,   type, and file path. Returns an empty array if the directory is empty   or an error occurs during scanning./

**Arguments**: ``
**Returns**: `AgentFunction[]`

---
#### `saveFunction`
Saves a custom agent function to disk as a script file.  The function name is sanitized to remove any characters that are not alphanumeric, hyphens, or underscores, preventing filesystem issues and path traversal attacks. The file extension is determined by the script type (`.py` for Python, `.js` for JavaScript).  If a file with the same name and type already exists, it is overwritten.  @param {string} name - The function keyword name (e.g., `'fetch_weather'`). @param {string} content - The full source code content of the script. @param {'python' | 'javascript'} type - The scripting language. @returns {boolean} `true` if saved successfully, `false` on error./

**Arguments**: `name: string, content: string, type: 'python' | 'javascript'`
**Returns**: `boolean`

---
#### `deleteFunction`
Deletes a custom agent function's script file from disk.  @param {string} name - The function keyword name to delete. @param {'python' | 'javascript'} type - The script type (determines file extension). @returns {boolean} `true` if the file was found and deleted, `false` if   the file didn't exist or an error occurred./

**Arguments**: `name: string, type: 'python' | 'javascript'`
**Returns**: `boolean`

---
#### `exists`
Checks whether a function with the given keyword exists on disk.  Looks for both `.py` and `.js` variants of the keyword. Returns `true` if either exists. This is used by the agent to validate `$keyword` function calls before attempting execution.  @param {string} keyword - The function keyword to check (e.g., `'summarize'`). @returns {boolean} `true` if a Python or JavaScript script with this keyword exists./

**Arguments**: `keyword: string`
**Returns**: `boolean`

---
#### `executeFunction`
Executes a custom agent function by spawning a child process.  Resolution order: 1. Looks for `<keyword>.py` first (Python preferred). 2. If not found, looks for `<keyword>.js` (JavaScript fallback). 3. If neither exists, throws an `Error`.  Execution details: - Uses `SystemService.detectEnv()` to resolve the correct Python/Node.js   executable path, respecting virtual environments and workspace config. - The child process inherits the detected environment variables (including   venv activation, `.env` file values, etc.). - The working directory is set to the workspace root. - Both `stdout` and `stderr` are captured. - On exit code 0: returns trimmed stdout. - On non-zero exit: returns formatted error message with stderr and stdout.  @param {string} keyword - The function keyword to execute (e.g., `'fetch_weather'`). @param {string[]} args - Array of command-line arguments to pass to the script. @returns {Promise<string>} The trimmed stdout output on success, or a formatted   error string (including exit code and stderr) on failure. @throws {Error} If the function file doesn't exist or the child process   fails to spawn entirely./

**Arguments**: `keyword: string, args: string[]`
**Returns**: `Promise<string>`

---
