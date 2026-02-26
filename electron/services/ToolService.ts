import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { AnnotationParser } from './AnnotationParser';

/**
 * Defines the shape of a tool that can be registered with the ToolService.
 * 
 * Tools are exposed to the AI brain as callable functions. Each tool has a name,
 * description, JSON Schema parameters, and an async execute function.
 * 
 * The execute function can return either:
 * - A simple string result.
 * - An object with `result` and `images` (base64 strings) for vision-capable tools.
 */
export interface ToolDefinition {
    /** Unique tool name used by the AI to invoke it (e.g., `'write_file'`, `'browse'`). */
    name: string;
    /** Human-readable description injected into the system prompt to help the AI decide when to use this tool. */
    description: string;
    /** JSON Schema object describing the expected input arguments. */
    parameters: any;
    /** The async function that executes the tool's logic. May return a string or an object with images. */
    execute: (args: any) => Promise<string | { result: string; images: string[] }>;
}

/**
 * ToolService
 * 
 * Central registry for all tools available to the Tala AI agent. Tools are
 * callable functions that the AI can invoke during conversations to perform
 * actions like reading/writing files, browsing the web, running terminal
 * commands, capturing screenshots, and interacting with memory services.
 * 
 * **Tool categories:**
 * 
 * | Category | Tools | Registered by |
 * |----------|-------|---------------|
 * | File I/O | `write_file`, `read_file`, `list_files` | `registerCoreTools()` |
 * | Browser | `browse`, `browser_click`, `browser_type`, `browser_scroll`, `browser_hover`, `browser_press_key`, `browser_get_dom`, `browser_screenshot`, `search_web` | `registerCoreTools()` |
 * | Terminal | `terminal_run`, `execute_command`, `execute_script` | `registerCoreTools()` |
 * | Memory | `mem0_search`, `mem0_add`, `mem0_get_recent` | `setMemoryService()` |
 * | Desktop | `desktop_screenshot`, `desktop_input` | `setMemoryService()` |
 * 
 * **How tools reach the AI:**
 * `getToolSchemas()` generates a formatted string of all registered tools,
 * which `AgentService` injects into the system prompt. When the AI responds
 * with a `TOOL_CALL` block, `AgentService.chat()` parses the tool name and
 * arguments, then calls `executeTool()` to run the tool.
 * 
 * @example
 * ```typescript
    * const tools = new ToolService();
 * tools.setRoot('/workspace');
 * const schemas = tools.getToolSchemas();
 * const result = await tools.executeTool('write_file', { path: 'hello.txt', content: 'Hello!' });
 * ```
 */
export class ToolService {
    /** Map of registered tools, keyed by tool name. */
    private tools: Map<string, ToolDefinition> = new Map();
    /** Current workspace directory for sandboxing file operations. */
    private workspaceDir: string;
    /** Cached system environment info (Python/Node paths) used by `execute_script`. */
    private systemInfo: any = null;
    /** Reference to the McpService for external tool integration. */
    private mcpService: any = null;
    /** Cache of available MCP tools, keyed by tool name. */
    private mcpTools: Map<string, { serverId: string, def: any }> = new Map();

    /**
     * Creates a new ToolService and registers all core tools.
     * 
     * Sets the workspace to `~/Documents/TalaWorkspace` by default.
     * Core tools (file I/O, browser, terminal) are registered immediately.
     * Service-dependent tools (Memory) are added later via setter methods.
     */
    constructor() {
        this.workspaceDir = path.join(app.getPath('documents'), 'TalaWorkspace');
        this.registerCoreTools();
    }

    /**
     * Injects the system environment info (detected by `SystemService`) so
     * tools like `execute_script` can locate the correct Python/Node executables.
     * 
     * @param {any} info - SystemInfo object with `pythonPath`, `pythonEnvPath`, `nodePath`, etc.
     */
    public setSystemInfo(info: any) {
        this.systemInfo = info;
    }

    /**
     * Returns the current workspace root directory.
     */
    public getWorkspaceDir(): string {
        return this.workspaceDir;
    }

    /**
     * Updates the workspace root for file I/O tools.
     * 
     * Called when the user changes their active workspace directory.
     * All file operations are sandboxed within this directory.
     * 
     * @param {string} newRoot - New absolute path to the workspace root.
     */
    public setRoot(newRoot: string) {
        this.workspaceDir = newRoot;
    }


    /**
    * Injects the MemoryService dependency and registers memory + desktop tools.
    * 
    * Registers five tools:
    * - `mem0_search` — Searches long-term memory (semantic or keyword).
    * - `mem0_add` — Stores a new fact/memory.
    * - `mem0_get_recent` — Retrieves the N most recent memories.
    * - `desktop_screenshot` — Captures a screenshot of the primary display.
    * - `desktop_input` — Controls mouse/keyboard via PowerShell.
    * 
    * @param {any} memory - The MemoryService instance.
    */
    public setMemoryService(memory: any) {
        console.log('[ToolService] Memory Service Injected');

        this.register({
            name: 'mem0_search',
            description: 'Search long-term memory for relevant facts, preferences, and past conversations.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The search term or question to look up.' },
                    limit: { type: 'number', description: 'Max results (default 5)' }
                },
                required: ['query']
            },
            execute: async (args) => {
                try {
                    const results = await memory.search(args.query, args.limit || 5);
                    if (!results || results.length === 0) return "No relevant memories found.";
                    return "Memory Results:\n" + results.map((m: any) => {
                        const date = m.timestamp ? new Date(m.timestamp).toLocaleString() : 'Unknown Date';
                        return `- [${date}][Score: ${m.score?.toFixed(2) || '?'}] ${m.text} `;
                    }).join('\n');
                } catch (e: any) { return `Error searching memory: ${e.message} `; }
            }
        });

        this.register({
            name: 'mem0_add',
            description: 'Explicitly add a new fact or memory to long-term storage.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'The fact or memory to store.' }
                },
                required: ['text']
            },
            execute: async (args) => {
                try {
                    await memory.add(args.text);
                    return "Memory stored successfully.";
                } catch (e: any) { return `Error storing memory: ${e.message} `; }
            }
        });

        this.register({
            name: 'mem0_get_recent',
            description: 'Get the most recent memories added to the database, regardless of relevance. Use this to understand "what just happened".',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Number of recent memories to retrieve (default 5)' }
                },
                required: []
            },
            execute: async (args) => {
                try {
                    // Empty query triggers the "latest" fallback in MemoryService.search
                    const results = await memory.search("", args.limit || 5);
                    if (!results || results.length === 0) return "No memories found.";
                    return "Recent Memories (Chronological):\n" + results.map((m: any) => {
                        const date = m.timestamp ? new Date(m.timestamp).toLocaleString() : 'Unknown Date';
                        return `- [${date}] ${m.text} `;
                    }).join('\n');
                } catch (e: any) { return `Error getting recent memory: ${e.message} `; }
            }
        });

        this.register({
            name: 'desktop_screenshot',
            description: 'Capture a screenshot of the primary display. Returns base64 image data. Use this to "see" what is on the user\'s screen.',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
                try {
                    const screenshot = require('screenshot-desktop');
                    const imgBuffer = await screenshot({ format: 'png' });
                    return {
                        result: "Screenshot captured.",
                        images: [imgBuffer.toString('base64')]
                    };
                } catch (e: any) { return `Error capturing screenshot: ${e.message} `; }
            }
        });

        this.register({
            name: 'desktop_input',
            description: 'Control mouse and keyboard via Powershell. Actions: "move", "click", "type", "move_click".',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['move', 'click', 'type', 'move_click'] },
                    x: { type: 'number', description: 'X coordinate' },
                    y: { type: 'number', description: 'Y coordinate' },
                    text: { type: 'string', description: 'Text to type' }
                },
                required: ['action']
            },
            execute: async (args) => {
                try {
                    const { exec } = require('child_process');
                    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'InputHelper.ps1');
                    let cmd = `powershell -ExecutionPolicy Bypass -File "${scriptPath}" -Action "${args.action}"`;
                    if (args.x !== undefined) cmd += ` -X ${args.x}`;
                    if (args.y !== undefined) cmd += ` -Y ${args.y}`;
                    if (args.text) cmd += ` -Text "${args.text.replace(/"/g, '\\"')}"`;

                    return new Promise((resolve) => {
                        exec(cmd, (error: any, stdout: string) => {
                            if (error) resolve(`Error: ${error.message}`);
                            else resolve(stdout.trim() || "Action executed.");
                        });
                    });
                } catch (e: any) { return `Error executing input: ${e.message}`; }
            }
        });
    }

    /**
     * Registers the core toolset that is always available (no service dependencies).
     * 
     * **Registered tools:**
     * - **File I/O:** `write_file`, `read_file`, `list_files`
     * - **Browser automation:** `browse`, `browser_click`, `browser_hover`,
     *   `browser_type`, `browser_scroll`, `browser_press_key`, `browser_get_dom`,
     *   `browser_screenshot`, `search_web`
     * - **Terminal:** `terminal_run`, `execute_command`, `execute_script`
     * 
     * Browser and terminal tools return special prefixed strings (e.g.,
     * `'BROWSER_NAVIGATE: https://...'`, `'TERMINAL_RUN: ls'`) that are
     * intercepted and dispatched by `AgentService.chat()` via event callbacks.
     * 
     * @private
     */
    private registerCoreTools() {
        // Tool: write_file
        this.register({
            name: 'write_file',
            description: 'Writes content to a file in the workspace. Use this to generate code, save notes, create scripts, or modify existing files.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path to the file (e.g., "notes/ideas.txt")' },
                    content: { type: 'string', description: 'The text content to write' }
                },
                required: ['path', 'content']
            },
            execute: async (args) => {
                try {
                    const targetPath = path.join(this.workspaceDir, args.path);

                    // Prevention of directory traversal
                    if (!targetPath.startsWith(this.workspaceDir)) {
                        return "Error: Access denied. You can only write within the workspace.";
                    }

                    // Ensure dir exists
                    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                    fs.writeFileSync(targetPath, args.content, 'utf-8');
                    return `Success: File written to ${args.path}`;
                } catch (e: any) {
                    return `Error writing file: ${e.message}`;
                }
            }
        });

        // Tool: read_file
        this.register({
            name: 'read_file',
            description: 'Reads content from a file in the workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path to the file' }
                },
                required: ['path']
            },
            execute: async (args) => {
                try {
                    const targetPath = path.join(this.workspaceDir, args.path);

                    if (!targetPath.startsWith(this.workspaceDir) || !fs.existsSync(targetPath)) {
                        return "Error: File not found or access denied.";
                    }

                    const stats = fs.statSync(targetPath);
                    if (stats.size > 1024 * 1024) {
                        return `Error: File is too large to read directly (${Math.round(stats.size / 1024)}KB). Use a search tool or list directories instead.`;
                    }

                    const content = fs.readFileSync(targetPath, 'utf-8');
                    const lines = content.split('\n');

                    // Add 1-indexed line numbers
                    const numberedContent = lines.map((l, i) => `${String(i + 1).padStart(4, ' ')}: ${l}`).join('\n');

                    // Parse annotations
                    const annotationResult = AnnotationParser.parseFile(targetPath);
                    const annotationBlock = AnnotationParser.formatForContext(annotationResult);

                    if (annotationBlock) {
                        return `${annotationBlock}\n\n[FILE CONTENT]\n${numberedContent}`;
                    }

                    return numberedContent;
                } catch (e: any) {
                    return `Error reading file: ${e.message}`;
                }
            }
        });

        // Tool: list_files
        this.register({
            name: 'list_files',
            description: 'Lists files in a specific directory of the workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path to the directory (e.g., "", "src", "memory")' },
                    recursive: { type: 'boolean', description: 'Whether to list subdirectories' }
                },
                required: ['path']
            },
            execute: async (args) => {
                try {
                    const targetPath = path.join(this.workspaceDir, args.path);
                    if (!targetPath.startsWith(this.workspaceDir)) return "Error: Access denied.";

                    const list = (dir: string, depth: number = 0): string[] => {
                        if (depth > 2) return []; // Limit depth
                        const entries = fs.readdirSync(dir, { withFileTypes: true });
                        let results: string[] = [];
                        for (const entry of entries) {
                            if (['node_modules', '.git', 'dist', 'dist-electron'].includes(entry.name)) continue;
                            const full = path.join(dir, entry.name);
                            const rel = path.relative(this.workspaceDir, full).replace(/\\/g, '/');
                            results.push(`${entry.isDirectory() ? '[DIR]' : '[FILE]'} ${rel}`);
                            if (args.recursive && entry.isDirectory()) {
                                results = [...results, ...list(full, depth + 1)];
                            }
                        }
                        return results;
                    };

                    const files = list(targetPath);
                    return files.length > 0 ? files.join('\n') : "Directory is empty.";
                } catch (e: any) {
                    return `Error listing files: ${e.message}`;
                }
            }
        });

        // Tool: delete_file
        this.register({
            name: 'delete_file',
            description: 'Deletes a file or directory at the specified path within the workspace. WARNING: This operation is permanent.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path to the file or directory to delete (e.g. "old_script.py" or "temp_data/")' }
                },
                required: ['path']
            },
            execute: async (args) => {
                try {
                    const targetPath = path.join(this.workspaceDir, args.path);
                    if (!targetPath.startsWith(this.workspaceDir)) {
                        return "Error: Access denied. You can only delete within the workspace.";
                    }
                    if (!fs.existsSync(targetPath)) {
                        return `Error: Path ${args.path} does not exist.`;
                    }
                    fs.rmSync(targetPath, { recursive: true, force: true });
                    return `Success: Deleted ${args.path}`;
                } catch (e: any) {
                    return `Error deleting path: ${e.message}`;
                }
            }
        });

        // Tool: create_directory
        this.register({
            name: 'create_directory',
            description: 'Creates a new directory (and any necessary parent directories) in the workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path for the new directory (e.g. "src/components")' }
                },
                required: ['path']
            },
            execute: async (args) => {
                try {
                    const targetPath = path.join(this.workspaceDir, args.path);
                    if (!targetPath.startsWith(this.workspaceDir)) {
                        return "Error: Access denied. You can only create within the workspace.";
                    }
                    fs.mkdirSync(targetPath, { recursive: true });
                    return `Success: Directory created at ${args.path}`;
                } catch (e: any) {
                    return `Error creating directory: ${e.message}`;
                }
            }
        });

        // Tool: get_user_profile
        this.register({
            name: 'get_user_profile',
            description: 'Retrieves the detailed user profile, including real-world and roleplay (RP) identity information such as birthdate, contact details, and history. Use this if you need to verify the user\'s age or personal details before proceeding with limited content.',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
                try {
                    const profilePath = path.join(this.workspaceDir, 'data', 'user_profile.json');
                    if (!fs.existsSync(profilePath)) {
                        return "Error: User profile not found at data/user_profile.json";
                    }
                    const profile = fs.readFileSync(profilePath, 'utf-8');
                    return profile;
                } catch (e: any) {
                    return `Error reading user profile: ${e.message}`;
                }
            }
        });

        // Tool: patch_file
        this.register({
            name: 'patch_file',
            description: 'Applies a targeted "search and replace" modification to a file. This is highly efficient for editing specific blocks of code without rewriting the entire file. Use unique search blocks to avoid multiple matches.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path to the file.' },
                    search: { type: 'string', description: 'The exact string to find in the file. Must be unique.' },
                    replace: { type: 'string', description: 'The replacement string.' }
                },
                required: ['path', 'search', 'replace']
            },
            execute: async (args) => {
                try {
                    const fullPath = path.join(this.workspaceDir, args.path);
                    if (!fullPath.startsWith(this.workspaceDir)) return "Error: Access denied.";
                    if (!fs.existsSync(fullPath)) return `Error: File not found at ${args.path}`;

                    let content = fs.readFileSync(fullPath, 'utf-8');
                    const occurrences = content.split(args.search).length - 1;

                    if (occurrences === 0) {
                        return `Error: Search block not found in ${args.path}. Ensure the search string exactly matches the file content including whitespace.`;
                    }
                    if (occurrences > 1) {
                        return `Error: Multiple occurrences of the search block found in ${args.path}. Please provide a more specific (larger) search block to ensure a surgical edit.`;
                    }

                    const newContent = content.replace(args.search, args.replace);
                    fs.writeFileSync(fullPath, newContent);
                    return `Success: Patched ${args.path}`;
                } catch (e: any) {
                    return `Error patching file: ${e.message}`;
                }
            }
        });

        // Tool: move_file
        this.register({
            name: 'move_file',
            description: 'Moves or renames a file or directory within the workspace.',
            parameters: {
                type: 'object',
                properties: {
                    src: { type: 'string', description: 'Original relative path (e.g. "old_name.txt")' },
                    dest: { type: 'string', description: 'New relative path (e.g. "new_name.txt")' }
                },
                required: ['src', 'dest']
            },
            execute: async (args) => {
                try {
                    const fullSrc = path.join(this.workspaceDir, args.src);
                    const fullDest = path.join(this.workspaceDir, args.dest);
                    if (!fullSrc.startsWith(this.workspaceDir) || !fullDest.startsWith(this.workspaceDir)) {
                        return "Error: Access denied. Paths must be within the workspace.";
                    }
                    if (!fs.existsSync(fullSrc)) {
                        return `Error: Source ${args.src} does not exist.`;
                    }
                    fs.mkdirSync(path.dirname(fullDest), { recursive: true });
                    fs.renameSync(fullSrc, fullDest);
                    return `Success: Moved ${args.src} to ${args.dest}`;
                } catch (e: any) {
                    return `Error moving file: ${e.message}`;
                }
            }
        });

        // Tool: copy_file
        this.register({
            name: 'copy_file',
            description: 'Copies a file or directory within the workspace.',
            parameters: {
                type: 'object',
                properties: {
                    src: { type: 'string', description: 'Source relative path' },
                    dest: { type: 'string', description: 'Destination relative path' }
                },
                required: ['src', 'dest']
            },
            execute: async (args) => {
                try {
                    const fullSrc = path.join(this.workspaceDir, args.src);
                    const fullDest = path.join(this.workspaceDir, args.dest);
                    if (!fullSrc.startsWith(this.workspaceDir) || !fullDest.startsWith(this.workspaceDir)) {
                        return "Error: Access denied. Paths must be within the workspace.";
                    }
                    if (!fs.existsSync(fullSrc)) {
                        return `Error: Source ${args.src} does not exist.`;
                    }
                    fs.mkdirSync(path.dirname(fullDest), { recursive: true });
                    fs.cpSync(fullSrc, fullDest, { recursive: true });
                    return `Success: Copied ${args.src} to ${args.dest}`;
                } catch (e: any) {
                    return `Error copying file: ${e.message}`;
                }
            }
        });

        // Tool: browse
        this.register({
            name: 'browse',
            description: 'Starts a navigation to a URL. After this, you should use browser_get_dom to read the page content.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'The URL to navigate to.' }
                },
                required: ['url']
            },
            execute: async (args) => {
                if (!args.url || typeof args.url !== 'string') {
                    return "Error: Invalid arguments. 'url' string is required.";
                }
                return `BROWSER_NAVIGATE: ${args.url}`;
            }
        });

        // Tool: browser_click
        this.register({
            name: 'browser_click',
            description: 'Clicks an element on the current page. PREFERRED: Use the numeric ID found in browser_get_dom (e.g. "12"). Fallback: CSS selector.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'The Entity ID (e.g. "12") or CSS selector.' }
                },
                required: ['selector']
            },
            execute: async (args) => {
                return `BROWSER_CLICK: ${args.selector}`;
            }
        });

        // Tool: browser_hover
        this.register({
            name: 'browser_hover',
            description: 'Hovers the mouse over an element without clicking. Useful for triggering dropdowns or menus. Use the numeric ID from browser_get_dom.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'The Entity ID (e.g. "12")' }
                },
                required: ['selector']
            },
            execute: async (args) => {
                return `BROWSER_HOVER: ${args.selector}`;
            }
        });

        // Tool: browser_type
        this.register({
            name: 'browser_type',
            description: 'Types text into an input field. PREFERRED: Use the numeric ID found in browser_get_dom (e.g. "12"). Fallback: CSS selector.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'The Entity ID (e.g. "12") or CSS selector.' },
                    text: { type: 'string', description: 'The text to type' }
                },
                required: ['selector', 'text']
            },
            execute: async (args) => {
                return `BROWSER_TYPE: ${JSON.stringify(args)}`;
            }
        });

        // Tool: browser_scroll
        this.register({
            name: 'browser_scroll',
            description: 'Scrolls the page content.',
            parameters: {
                type: 'object',
                properties: {
                    direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Scroll direction.' },
                    amount: { type: 'number', description: 'Pixels to scroll (ignored for top/bottom, default 300)' }
                },
                required: ['direction']
            },
            execute: async (args) => {
                return `BROWSER_SCROLL: ${JSON.stringify(args)}`;
            }
        });

        // Tool: browser_press_key
        this.register({
            name: 'browser_press_key',
            description: 'Presses a specific keyboard key (Enter, Escape, ArrowDown, etc.) in the browser context.',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'The key name (e.g. "Enter", "Escape", "ArrowDown")' }
                },
                required: ['key']
            },
            execute: async (args) => {
                return `BROWSER_PRESS_KEY: ${args.key}`;
            }
        });

        // Tool: browser_get_dom
        this.register({
            name: 'browser_get_dom',
            description: 'Retrieves a list of interactive elements on the page, each assigned a unique numeric ID (e.g. [12] BUTTON). Use these IDs for clicking and typing.',
            parameters: { type: 'object', properties: {} },
            execute: async (args) => {
                return `BROWSER_GET_DOM: REQUEST`;
            }
        });

        // Tool: browser_screenshot
        this.register({
            name: 'browser_screenshot',
            description: 'Captures a high-quality screenshot of the active web page in the center panel. Use this to verify visual state.',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
                return `BROWSER_SCREENSHOT: REQUEST`;
            }
        });

        // Tool: search_web
        this.register({
            name: 'search_web',
            description: 'Performs a web search to find information without navigating a browser visually. Returns a list of results (titles and URLs). Use this for general queries.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The search term(s).' }
                },
                required: ['query']
            },
            execute: async (args) => {
                return `BROWSER_SEARCH: ${args.query}`;
            }
        });

        // Tool: terminal_run
        this.register({
            name: 'terminal_run',
            description: 'Runs a command in the visible terminal. Use this for general system operations, running scripts anywhere on the disk, or installing packages.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'The command to run (e.g. "cd C:/Users && dir")' }
                },
                required: ['command']
            },
            execute: async (args) => {
                return `TERMINAL_RUN: ${args.command}`;
            }
        });

        // Tool: execute_command
        this.register({
            name: 'execute_command',
            description: 'Executes a shell command in the workspace directory. Use carefully.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'The command to run (e.g. "python hello.py")' }
                },
                required: ['command']
            },
            execute: async (args) => {
                const { exec } = require('child_process');
                return new Promise((resolve) => {
                    exec(args.command, { cwd: this.workspaceDir }, (err: any, stdout: string, stderr: string) => {
                        if (err) resolve(`Error: ${err.message}\n${stderr}`);
                        else resolve(stdout || stderr || "Command executed with no output.");
                    });
                });
            }
        });

        // Tool: execute_script
        this.register({
            name: 'execute_script',
            description: 'Runs a script file (Python or Node) found in the workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path to the script (e.g. "scripts/hello.py")' }
                },
                required: ['path']
            },
            execute: async (args) => {
                const { exec } = require('child_process');
                const scriptPath = path.join(this.workspaceDir, args.path);
                if (!scriptPath.startsWith(this.workspaceDir)) return "Error: Access denied.";

                let cmd = '';
                if (args.path.endsWith('.py')) {
                    // Prioritize Virtual Env if detected
                    const pyPath = this.systemInfo?.pythonEnvPath || this.systemInfo?.pythonPath || 'python';
                    cmd = `"${pyPath}" "${scriptPath}"`;
                } else if (args.path.endsWith('.js') || args.path.endsWith('.ts')) {
                    const nodePath = this.systemInfo?.nodePath || 'node';
                    if (args.path.endsWith('.ts')) cmd = `npx ts-node "${scriptPath}"`;
                    else cmd = `"${nodePath}" "${scriptPath}"`;
                } else {
                    return "Error: Unsupported script type. Only .py, .js, .ts supported.";
                }

                return new Promise((resolve) => {
                    exec(cmd, { cwd: this.workspaceDir }, (err: any, stdout: string, stderr: string) => {
                        if (err) resolve(`Error: ${err.message}\n${stderr}`);
                        else resolve(stdout || stderr || "Script executed successfully.");
                    });
                });
            }
        });

        // Tool: render_a2ui
        this.register({
            name: 'render_a2ui',
            description: 'Render a rich UI to the user. Use this to present educational or instructional content with layout, images, and formatting. Input is a JSON tree of components.',
            parameters: {
                type: 'object',
                properties: {
                    tree: {
                        type: 'object',
                        description: 'Root component node. Type: "container", "heading", "text", "image", "columns", "code", etc.',
                        properties: {
                            type: { type: 'string' },
                            props: { type: 'object' },
                            children: { type: 'array' }
                        },
                        required: ['type']
                    }
                },
                required: ['tree']
            },
            execute: async (args) => {
                // We return a prefixed string that AgentService.chat() will intercept
                // and emit as an 'a2ui-update' event.
                return `A2UI_RENDER: ${JSON.stringify(args.tree)}`;
            }
        });

        // Tool: system_diagnose
        this.register({
            name: 'system_diagnose',
            description: 'Performs a deep diagnostic scan of the project (Lint + Build). Returns a structured report of errors and warnings. Use this after making significant code changes to ensure system stability.',
            parameters: {
                type: 'object',
                properties: {
                    checkLint: { type: 'boolean', description: 'Whether to run eslint check (default: true)' },
                    checkBuild: { type: 'boolean', description: 'Whether to run tsc/vite build check (default: true)' }
                }
            },
            execute: async (args) => {
                const { exec } = require('child_process');
                const runCheck = (cmd: string): Promise<string> => {
                    return new Promise((resolve) => {
                        exec(cmd, { cwd: this.workspaceDir }, (err: any, stdout: string, stderr: string) => {
                            resolve(stdout + '\n' + stderr);
                        });
                    });
                };

                let report = "[SYSTEM DIAGNOSIS REPORT]\n\n";
                if (args.checkLint !== false) {
                    report += "--- LINT CHECK ---\n";
                    const lintOut = await runCheck("npm run lint");
                    const errors = (lintOut.match(/error/gi) || []).length;
                    const warnings = (lintOut.match(/warning/gi) || []).length;
                    report += `Summary: ${errors} errors, ${warnings} warnings\n`;
                    if (errors > 0 || warnings > 0) {
                        // Extract first 5 errors for brevity
                        const lines = lintOut.split('\n').filter(l => l.includes('error') || l.includes('warning')).slice(0, 10);
                        report += lines.join('\n') + (lines.length >= 10 ? "\n...(truncated)" : "") + "\n";
                    } else {
                        report += "Clean.\n";
                    }
                }

                if (args.checkBuild !== false) {
                    report += "\n--- BUILD CHECK ---\n";
                    const buildOut = await runCheck("npm run build");
                    const errors = (buildOut.match(/error TS\d+/gi) || []).length;
                    report += `Summary: ${errors} TypeScript errors\n`;
                    if (errors > 0) {
                        const lines = buildOut.split('\n').filter(l => l.includes('error TS')).slice(0, 10);
                        report += lines.join('\n') + (lines.length >= 10 ? "\n...(truncated)" : "") + "\n";
                    } else if (buildOut.includes('error')) {
                        report += "Build failed with general error.\n";
                        report += buildOut.substring(0, 500) + "\n";
                    } else {
                        report += "Success.\n";
                    }
                }

                return report;
            }
        });

        // Tool: task_plan
        this.register({
            name: 'task_plan',
            description: 'Updates your internal roadmap for the current task. This renders a visual "Goal Tree" in the UI to keep the user informed of your progress.',
            parameters: {
                type: 'object',
                properties: {
                    goals: {
                        type: 'array',
                        description: 'List of sub-goals for the current task.',
                        items: {
                            type: 'object',
                            properties: {
                                title: { type: 'string', description: 'Description of the goal.' },
                                status: { type: 'string', enum: ['pending', 'in-progress', 'completed'], description: 'Current status.' }
                            },
                            required: ['title', 'status']
                        }
                    }
                },
                required: ['goals']
            },
            execute: async (args) => {
                // Render the GoalTree via A2UI
                const tree = {
                    type: 'goal_tree',
                    props: { goals: args.goals }
                };
                return `A2UI_RENDER: ${JSON.stringify(tree)}`;
            }
        });
    }

    /**
     * Registers a new tool, making it available to the AI agent.
     * 
     * If a tool with the same name is already registered, it is overwritten.
     * 
     * @param {ToolDefinition} tool - The tool definition to register.
     */
    public register(tool: ToolDefinition) {
        this.tools.set(tool.name, tool);
    }

    /**
     * Injects the McpService dependency.
     */
    public setMcpService(mcp: any) {
        console.log('[ToolService] MCP Service Injected');
        this.mcpService = mcp;
    }

    /**
     * Refreshes the list of available MCP tools from all connected servers.
     * This should be called whenever MCP connections change.
     */
    public async refreshMcpTools() {
        if (!this.mcpService) return;

        console.log('[ToolService] Refreshing MCP Tools...');
        this.mcpTools.clear();

        const serverIds = this.mcpService.getActiveConnections();
        for (const serverId of serverIds) {
            try {
                const caps = await this.mcpService.getCapabilities(serverId);
                if (caps.tools) {
                    for (const tool of caps.tools) {
                        // Avoid overwriting core tools
                        if (this.tools.has(tool.name)) {
                            console.warn(`[ToolService] Skipping MCP tool '${tool.name}' from '${serverId}' (collision with core tool).`);
                            continue;
                        }

                        // Register in mcpTools map
                        this.mcpTools.set(tool.name, { serverId, def: tool });
                        console.log(`[ToolService] Registered MCP tool: ${tool.name} form ${serverId}`);
                    }
                }
            } catch (e) {
                console.error(`[ToolService] Failed to load tools from ${serverId}:`, e);
            }
        }
    }

    /**
     * Generates a formatted string describing all registered tools and their
     * JSON Schema parameters. This string is injected into the system prompt
     * so the AI knows what tools are available.
     * 
     * @returns {string} Multi-line string with tool names, descriptions, and parameter schemas.
     */
    public getToolSchemas(): string {
        let schemaStr = "You have access to the following tools:\n\n";

        // Core Tools
        this.tools.forEach(tool => {
            schemaStr += `### ${tool.name}\nDescription: ${tool.description}\nJSON Schema: ${JSON.stringify(tool.parameters)}\n\n`;
        });

        // MCP Tools
        this.mcpTools.forEach((entry, name) => {
            const tool = entry.def;
            schemaStr += `### ${tool.name}\nDescription: ${tool.description || 'No description provided.'} (Source: ${entry.serverId})\nJSON Schema: ${JSON.stringify(tool.inputSchema || tool.parameters)}\n\n`;
        });

        return schemaStr;
    }

    /**
     * Generates a compact, TypeScript-style signature list of all tools.
     * Use this when Native Tools are enabled to save token space in the system prompt.
     * 
     * Format: `tool_name(param: type, ...) - Description`
     */
    public getToolSignatures(): string {
        let sigStr = "Available Tools (Native Definitions Provided):\n";

        const formatParams = (schema: any) => {
            if (!schema || !schema.properties) return '';
            return Object.entries(schema.properties).map(([key, val]: [string, any]) => {
                return `${key}${schema.required?.includes(key) ? '' : '?'}: ${val.type}`;
            }).join(', ');
        };

        // Core Tools
        this.tools.forEach(tool => {
            sigStr += `- ${tool.name}(${formatParams(tool.parameters)}) : ${tool.description.slice(0, 100)}${tool.description.length > 100 ? '...' : ''}\n`;
        });

        // MCP Tools
        this.mcpTools.forEach((entry, name) => {
            const tool = entry.def;
            const schema = tool.inputSchema || tool.parameters;
            sigStr += `- ${tool.name}(${formatParams(schema)}) : ${tool.description ? tool.description.slice(0, 100) : ''} (Source: ${entry.serverId})\n`;
        });

        return sigStr;
    }


    /**
     * Checks if a tool with the given name is registered.
     * 
     * @param {string} name - The tool name to check.
     * @returns {boolean} `true` if the tool exists.
     */
    public hasTool(name: string): boolean {
        return this.tools.has(name) || this.mcpTools.has(name);
    }

    /**
     * Recursively rewrites a JSON schema to comply with OpenAI's Strict Structured Outputs (GBNF).
     * Enforces `additionalProperties: false` on all objects and explicitly lists all properties in `required`.
     */
    private makeStrictSchema(schema: any): any {
        if (!schema || typeof schema !== 'object') return schema;

        const strictSchema = { ...schema };

        if (strictSchema.type === 'object') {
            strictSchema.additionalProperties = false;

            // Collect all properties
            const props = strictSchema.properties ? Object.keys(strictSchema.properties) : [];

            // Ensure all properties are required for strict outputs
            if (props.length > 0) {
                strictSchema.required = props;
            } else {
                // If it's an object with no properties, strict mode requires an empty properties object
                strictSchema.properties = {};
            }

            // Recursively apply to all child properties
            if (strictSchema.properties) {
                for (const key in strictSchema.properties) {
                    strictSchema.properties[key] = this.makeStrictSchema(strictSchema.properties[key]);
                }
            }
        } else if (strictSchema.type === 'array' && strictSchema.items) {
            strictSchema.items = this.makeStrictSchema(strictSchema.items);
        }

        return strictSchema;
    }

    /**
     * Returns tool definitions in the format expected by OpenAI/Ollama APIs.
     * @returns {Array<{ type: 'function', function: { name: string, description: string, parameters: any, strict?: boolean } }>}
     */
    public getToolDefinitions() {
        const definitions: any[] = [];

        // Core Tools
        this.tools.forEach(tool => {
            definitions.push({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    strict: true,
                    parameters: this.makeStrictSchema(tool.parameters || { type: 'object', properties: {} })
                }
            });
        });

        // MCP Tools
        this.mcpTools.forEach((entry, name) => {
            const tool = entry.def;
            definitions.push({
                type: 'function',
                function: {
                    name: name, // Use registry key 'name' which is guaranteed to be the correct ID
                    description: tool.description || 'No description provided.',
                    strict: true,
                    parameters: this.makeStrictSchema(tool.inputSchema || tool.parameters || { type: 'object', properties: {} })
                }
            });
        });

        return definitions;
    }

    /**
     * Returns a simple list of all tool names and descriptions.
     * Used by the UI for tool selection dropdowns.
     * @returns {Array<{ name: string, description: string, source: string }>}
     */
    public getAllTools() {
        const list: any[] = [];

        this.tools.forEach(tool => {
            list.push({
                name: tool.name,
                description: tool.description,
                source: 'core'
            });
        });

        this.mcpTools.forEach((entry, name) => {
            list.push({
                name: name,
                description: entry.def.description || 'No description provided.',
                source: entry.serverId
            });
        });

        return list;
    }

    /**
     * Executes a registered tool with the given arguments.
     * 
     * Looks up the tool by name and calls its `execute` function.
     * If the tool is not found, returns an error string instead of throwing.
     * 
     * @param {string} name - The name of the tool to execute.
     * @param {any} args - The arguments parsed from the AI's `TOOL_CALL` block.
     * @returns {Promise<any>} The tool's output (may include a special prefix
     *   like `'BROWSER_NAVIGATE:'` that triggers event handling in AgentService).
     */
    public async executeTool(name: string, args: any): Promise<any> {
        // Strip provider-specific prefixes if present (e.g. Gemini OpenAI shim prepends 'default_api:')
        if (name.startsWith('default_api:')) {
            name = name.substring('default_api:'.length);
        }

        // Core Tool
        if (this.tools.has(name)) {
            const tool = this.tools.get(name)!;
            const output = await tool.execute(args);
            return output as any;
        }

        // MCP Tool
        if (this.mcpTools.has(name)) {
            const entry = this.mcpTools.get(name)!;
            try {
                const result = await this.mcpService.callTool(entry.serverId, name, args);

                // Result structure from MCP SDK: { content: [{ type: 'text', text: '...' }] }
                if (result && result.content && Array.isArray(result.content)) {
                    // Extract text content
                    const text = result.content
                        .filter((c: any) => c.type === 'text')
                        .map((c: any) => c.text)
                        .join('\n');
                    return text || JSON.stringify(result);
                }

                return JSON.stringify(result);
            } catch (e: any) {
                return `Error executing MCP tool ${name}: ${e.message}`;
            }
        }

        return `Error: Tool ${name} not found.`;
    }
}
