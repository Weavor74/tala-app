import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { spawn } from 'child_process';
import { SystemService } from './SystemService';

/**
 * Represents a custom agent function (script) stored in the `.agent/functions/` directory.
 * Functions are invocable by the AI agent using a `$keyword` syntax in chat,
 * where the keyword corresponds to the filename without extension.
 */
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

/**
 * FunctionService
 * 
 * Manages custom agent functions — user-created Python and JavaScript scripts
 * that the AI agent can execute on demand. Functions are stored as individual
 * script files in the `.agent/functions/` directory within the workspace.
 * 
 * **How it works:**
 * 1. The user (or agent) creates a script and saves it via `saveFunction()`.
 * 2. During chat, the agent can call `$keyword` to invoke `executeFunction(keyword)`.
 * 3. The service detects the script language (`.py` or `.js`), resolves the
 *    runtime path (Python or Node.js from `SystemService`), and spawns a child process.
 * 4. The script's stdout is captured and returned as the function result.
 * 
 * **File storage:**
 * ```
 * <workspace>/.agent/functions/
 *   ├── fetch_weather.py     → invoked as $fetch_weather
 *   ├── parse_data.js        → invoked as $parse_data
 *   └── summarize.py         → invoked as $summarize
 * ```
 * 
 * @example
 * ```typescript
 * const funcService = new FunctionService(systemService, '/workspace');
 * funcService.saveFunction('greet', 'print("Hello!")', 'python');
 * const output = await funcService.executeFunction('greet', []);
 * console.log(output); // "Hello!"
 * ```
 */
export class FunctionService {
    /** The root workspace directory path. */
    private workspaceDir: string;
    /** Computed path to the `.agent/functions/` directory. */
    private functionsDir: string;
    /** Reference to SystemService for detecting Python/Node.js runtime paths. */
    private systemService: SystemService;

    /**
     * Creates a new FunctionService instance.
     * 
     * @param {SystemService} systemService - The system detection service used to
     *   resolve Python and Node.js executable paths for script execution.
     * @param {string} initialRoot - Absolute path to the workspace root directory.
     *   Functions will be stored in `<initialRoot>/.agent/functions/`.
     */
    constructor(systemService: SystemService, initialRoot: string) {
        this.systemService = systemService;
        this.workspaceDir = initialRoot;
        this.functionsDir = path.join(this.workspaceDir, '.agent', 'functions');
    }

    /**
     * Updates the workspace root and recalculates the functions directory path.
     * Also ensures the new functions directory exists on disk.
     * 
     * @param {string} newRoot - The new absolute path to the workspace root.
     * @returns {void}
     */
    public setRoot(newRoot: string) {
        this.workspaceDir = newRoot;
        this.functionsDir = path.join(this.workspaceDir, '.agent', 'functions');
        this.ensureDir();
    }

    /**
     * Ensures the `.agent/functions/` directory exists on disk.
     * Creates it recursively (including the `.agent/` parent) if it doesn't exist.
     * Called internally before read/write operations.
     * 
     * @private
     * @returns {void}
     */
    private ensureDir() {
        if (!fs.existsSync(this.functionsDir)) {
            fs.mkdirSync(this.functionsDir, { recursive: true });
        }
    }

    /**
     * Lists all custom agent functions by scanning the functions directory.
     * 
     * Reads all `.py` and `.js` files from the functions directory, loading
     * each file's full source code content into memory. Non-script files
     * (e.g., `.txt`, `.md`, directories) are ignored.
     * 
     * @returns {AgentFunction[]} Array of function definitions with name, content,
     *   type, and file path. Returns an empty array if the directory is empty
     *   or an error occurs during scanning.
     */
    public listFunctions(): AgentFunction[] {
        this.ensureDir();
        try {
            const files = fs.readdirSync(this.functionsDir);
            const functions: AgentFunction[] = [];

            for (const file of files) {
                if (file.endsWith('.py') || file.endsWith('.js')) {
                    const fullPath = path.join(this.functionsDir, file);
                    const content = fs.readFileSync(fullPath, 'utf-8');
                    const ext = path.extname(file);
                    const name = path.basename(file, ext);

                    functions.push({
                        name,
                        content,
                        type: ext === '.py' ? 'python' : 'javascript',
                        path: fullPath
                    });
                }
            }
            return functions;
        } catch (e) {
            console.error('[FunctionService] List failed:', e);
            return [];
        }
    }

    /**
     * Saves a custom agent function to disk as a script file.
     * 
     * The function name is sanitized to remove any characters that are not
     * alphanumeric, hyphens, or underscores, preventing filesystem issues
     * and path traversal attacks. The file extension is determined by the
     * script type (`.py` for Python, `.js` for JavaScript).
     * 
     * If a file with the same name and type already exists, it is overwritten.
     * 
     * @param {string} name - The function keyword name (e.g., `'fetch_weather'`).
     * @param {string} content - The full source code content of the script.
     * @param {'python' | 'javascript'} type - The scripting language.
     * @returns {boolean} `true` if saved successfully, `false` on error.
     */
    public saveFunction(name: string, content: string, type: 'python' | 'javascript'): boolean {
        this.ensureDir();
        try {
            const ext = type === 'python' ? '.py' : '.js';
            const safeName = name.replace(/[^a-zA-Z0-9_-]/g, ''); // Sanitize
            const filePath = path.join(this.functionsDir, `${safeName}${ext}`);
            fs.writeFileSync(filePath, content, 'utf-8');
            return true;
        } catch (e) {
            console.error('[FunctionService] Save failed:', e);
            return false;
        }
    }

    /**
     * Deletes a custom agent function's script file from disk.
     * 
     * @param {string} name - The function keyword name to delete.
     * @param {'python' | 'javascript'} type - The script type (determines file extension).
     * @returns {boolean} `true` if the file was found and deleted, `false` if
     *   the file didn't exist or an error occurred.
     */
    public deleteFunction(name: string, type: 'python' | 'javascript'): boolean {
        try {
            const ext = type === 'python' ? '.py' : '.js';
            const filePath = path.join(this.functionsDir, `${name}${ext}`);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                return true;
            }
            return false;
        } catch (e) {
            console.error('[FunctionService] Delete failed:', e);
            return false;
        }
    }

    /**
     * Checks whether a function with the given keyword exists on disk.
     * 
     * Looks for both `.py` and `.js` variants of the keyword. Returns `true`
     * if either exists. This is used by the agent to validate `$keyword`
     * function calls before attempting execution.
     * 
     * @param {string} keyword - The function keyword to check (e.g., `'summarize'`).
     * @returns {boolean} `true` if a Python or JavaScript script with this keyword exists.
     */
    public exists(keyword: string): boolean {
        this.ensureDir();
        const pyPath = path.join(this.functionsDir, `${keyword}.py`);
        const jsPath = path.join(this.functionsDir, `${keyword}.js`);
        return fs.existsSync(pyPath) || fs.existsSync(jsPath);
    }

    /**
     * Executes a custom agent function by spawning a child process.
     * 
     * Resolution order:
     * 1. Looks for `<keyword>.py` first (Python preferred).
     * 2. If not found, looks for `<keyword>.js` (JavaScript fallback).
     * 3. If neither exists, throws an `Error`.
     * 
     * Execution details:
     * - Uses `SystemService.detectEnv()` to resolve the correct Python/Node.js
     *   executable path, respecting virtual environments and workspace config.
     * - The child process inherits the detected environment variables (including
     *   venv activation, `.env` file values, etc.).
     * - The working directory is set to the workspace root.
     * - Both `stdout` and `stderr` are captured.
     * - On exit code 0: returns trimmed stdout.
     * - On non-zero exit: returns formatted error message with stderr and stdout.
     * 
     * @param {string} keyword - The function keyword to execute (e.g., `'fetch_weather'`).
     * @param {string[]} args - Array of command-line arguments to pass to the script.
     * @returns {Promise<string>} The trimmed stdout output on success, or a formatted
     *   error string (including exit code and stderr) on failure.
     * @throws {Error} If the function file doesn't exist or the child process
     *   fails to spawn entirely.
     */
    public async executeFunction(keyword: string, args: string[]): Promise<string> {
        this.ensureDir();
        // Try Python then JS
        let filePath = path.join(this.functionsDir, `${keyword}.py`);
        let isPython = true;

        if (!fs.existsSync(filePath)) {
            filePath = path.join(this.functionsDir, `${keyword}.js`);
            isPython = false;
        }

        if (!fs.existsSync(filePath)) {
            throw new Error(`Function '$${keyword}' not found.`);
        }

        const env = await this.systemService.detectEnv(this.workspaceDir);
        const customEnv = env.envVariables || process.env;

        return new Promise((resolve, reject) => {
            let cmd: string;
            let cmdArgs: string[];

            if (isPython) {
                const pyPath = env.pythonPath || 'python';
                cmd = pyPath;
                cmdArgs = [filePath, ...args];
            } else {
                const nodePath = env.nodePath || 'node';
                cmd = nodePath;
                cmdArgs = [filePath, ...args];
            }

            console.log(`[FunctionService] Executing: ${cmd} ${cmdArgs.join(' ')}`);

            const child = spawn(cmd, cmdArgs, {
                env: customEnv,
                cwd: this.workspaceDir,
                shell: true
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', d => stdout += d.toString());
            child.stderr.on('data', d => stderr += d.toString());

            child.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    resolve(`[ERROR Exit ${code}]:\n${stderr}\n${stdout}`);
                }
            });

            child.on('error', (err) => {
                reject(err);
            });
        });
    }
}
