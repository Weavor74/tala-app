"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolService = void 0;
var electron_1 = require("electron");
var path_1 = require("path");
var fs_1 = require("fs");
var AnnotationParser_1 = require("./AnnotationParser");
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
var ToolService = /** @class */ (function () {
    /**
     * Creates a new ToolService and registers all core tools.
     *
     * Sets the workspace to `~/Documents/TalaWorkspace` by default.
     * Core tools (file I/O, browser, terminal) are registered immediately.
     * Service-dependent tools (Memory) are added later via setter methods.
     */
    function ToolService() {
        /** Map of registered tools, keyed by tool name. */
        this.tools = new Map();
        /** Cached system environment info (Python/Node paths) used by `execute_script`. */
        this.systemInfo = null;
        /** Reference to the McpService for external tool integration. */
        this.mcpService = null;
        /** Cache of available MCP tools, keyed by tool name. */
        this.mcpTools = new Map();
        this.workspaceDir = path_1.default.join(electron_1.app.getPath('documents'), 'TalaWorkspace');
        this.registerCoreTools();
    }
    /**
     * Injects the system environment info (detected by `SystemService`) so
     * tools like `execute_script` can locate the correct Python/Node executables.
     *
     * @param {any} info - SystemInfo object with `pythonPath`, `pythonEnvPath`, `nodePath`, etc.
     */
    ToolService.prototype.setSystemInfo = function (info) {
        this.systemInfo = info;
    };
    /**
     * Returns the current workspace root directory.
     */
    ToolService.prototype.getWorkspaceDir = function () {
        return this.workspaceDir;
    };
    /**
     * Updates the workspace root for file I/O tools.
     *
     * Called when the user changes their active workspace directory.
     * All file operations are sandboxed within this directory.
     *
     * @param {string} newRoot - New absolute path to the workspace root.
     */
    ToolService.prototype.setRoot = function (newRoot) {
        this.workspaceDir = newRoot;
    };
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
    ToolService.prototype.setMemoryService = function (memory) {
        var _this = this;
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                var results, e_1;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            _a.trys.push([0, 2, , 3]);
                            return [4 /*yield*/, memory.search(args.query, args.limit || 5)];
                        case 1:
                            results = _a.sent();
                            if (!results || results.length === 0)
                                return [2 /*return*/, "No relevant memories found."];
                            return [2 /*return*/, "Memory Results:\n" + results.map(function (m) {
                                    var _a;
                                    var date = m.timestamp ? new Date(m.timestamp).toLocaleString() : 'Unknown Date';
                                    return "- [".concat(date, "][Score: ").concat(((_a = m.score) === null || _a === void 0 ? void 0 : _a.toFixed(2)) || '?', "] ").concat(m.text, " ");
                                }).join('\n')];
                        case 2:
                            e_1 = _a.sent();
                            return [2 /*return*/, "Error searching memory: ".concat(e_1.message, " ")];
                        case 3: return [2 /*return*/];
                    }
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                var e_2;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            _a.trys.push([0, 2, , 3]);
                            return [4 /*yield*/, memory.add(args.text)];
                        case 1:
                            _a.sent();
                            return [2 /*return*/, "Memory stored successfully."];
                        case 2:
                            e_2 = _a.sent();
                            return [2 /*return*/, "Error storing memory: ".concat(e_2.message, " ")];
                        case 3: return [2 /*return*/];
                    }
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                var results, e_3;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            _a.trys.push([0, 2, , 3]);
                            return [4 /*yield*/, memory.search("", args.limit || 5)];
                        case 1:
                            results = _a.sent();
                            if (!results || results.length === 0)
                                return [2 /*return*/, "No memories found."];
                            return [2 /*return*/, "Recent Memories (Chronological):\n" + results.map(function (m) {
                                    var date = m.timestamp ? new Date(m.timestamp).toLocaleString() : 'Unknown Date';
                                    return "- [".concat(date, "] ").concat(m.text, " ");
                                }).join('\n')];
                        case 2:
                            e_3 = _a.sent();
                            return [2 /*return*/, "Error getting recent memory: ".concat(e_3.message, " ")];
                        case 3: return [2 /*return*/];
                    }
                });
            }); }
        });
        this.register({
            name: 'desktop_screenshot',
            description: 'Capture a screenshot of the primary display. Returns base64 image data. Use this to "see" what is on the user\'s screen.',
            parameters: { type: 'object', properties: {} },
            execute: function () { return __awaiter(_this, void 0, void 0, function () {
                var screenshot, imgBuffer, e_4;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            _a.trys.push([0, 2, , 3]);
                            screenshot = require('screenshot-desktop');
                            return [4 /*yield*/, screenshot({ format: 'png' })];
                        case 1:
                            imgBuffer = _a.sent();
                            return [2 /*return*/, {
                                    result: "Screenshot captured.",
                                    images: [imgBuffer.toString('base64')]
                                }];
                        case 2:
                            e_4 = _a.sent();
                            return [2 /*return*/, "Error capturing screenshot: ".concat(e_4.message, " ")];
                        case 3: return [2 /*return*/];
                    }
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                var exec_1, scriptPath, cmd_1;
                return __generator(this, function (_a) {
                    try {
                        exec_1 = require('child_process').exec;
                        scriptPath = path_1.default.resolve(__dirname, '..', 'scripts', 'InputHelper.ps1');
                        cmd_1 = "powershell -ExecutionPolicy Bypass -File \"".concat(scriptPath, "\" -Action \"").concat(args.action, "\"");
                        if (args.x !== undefined)
                            cmd_1 += " -X ".concat(args.x);
                        if (args.y !== undefined)
                            cmd_1 += " -Y ".concat(args.y);
                        if (args.text)
                            cmd_1 += " -Text \"".concat(args.text.replace(/"/g, '\\"'), "\"");
                        return [2 /*return*/, new Promise(function (resolve) {
                                exec_1(cmd_1, function (error, stdout) {
                                    if (error)
                                        resolve("Error: ".concat(error.message));
                                    else
                                        resolve(stdout.trim() || "Action executed.");
                                });
                            })];
                    }
                    catch (e) {
                        return [2 /*return*/, "Error executing input: ".concat(e.message)];
                    }
                    return [2 /*return*/];
                });
            }); }
        });
    };
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
    ToolService.prototype.registerCoreTools = function () {
        var _this = this;
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                var targetPath;
                return __generator(this, function (_a) {
                    try {
                        targetPath = path_1.default.join(this.workspaceDir, args.path);
                        // Prevention of directory traversal
                        if (!targetPath.startsWith(this.workspaceDir)) {
                            return [2 /*return*/, "Error: Access denied. You can only write within the workspace."];
                        }
                        // Ensure dir exists
                        fs_1.default.mkdirSync(path_1.default.dirname(targetPath), { recursive: true });
                        fs_1.default.writeFileSync(targetPath, args.content, 'utf-8');
                        return [2 /*return*/, "Success: File written to ".concat(args.path)];
                    }
                    catch (e) {
                        return [2 /*return*/, "Error writing file: ".concat(e.message)];
                    }
                    return [2 /*return*/];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                var targetPath, stats, content, lines, numberedContent, annotationResult, annotationBlock;
                return __generator(this, function (_a) {
                    try {
                        targetPath = path_1.default.join(this.workspaceDir, args.path);
                        if (!targetPath.startsWith(this.workspaceDir) || !fs_1.default.existsSync(targetPath)) {
                            return [2 /*return*/, "Error: File not found or access denied."];
                        }
                        stats = fs_1.default.statSync(targetPath);
                        if (stats.size > 1024 * 1024) {
                            return [2 /*return*/, "Error: File is too large to read directly (".concat(Math.round(stats.size / 1024), "KB). Use a search tool or list directories instead.")];
                        }
                        content = fs_1.default.readFileSync(targetPath, 'utf-8');
                        lines = content.split('\n');
                        numberedContent = lines.map(function (l, i) { return "".concat(String(i + 1).padStart(4, ' '), ": ").concat(l); }).join('\n');
                        annotationResult = AnnotationParser_1.AnnotationParser.parseFile(targetPath);
                        annotationBlock = AnnotationParser_1.AnnotationParser.formatForContext(annotationResult);
                        if (annotationBlock) {
                            return [2 /*return*/, "".concat(annotationBlock, "\n\n[FILE CONTENT]\n").concat(numberedContent)];
                        }
                        return [2 /*return*/, numberedContent];
                    }
                    catch (e) {
                        return [2 /*return*/, "Error reading file: ".concat(e.message)];
                    }
                    return [2 /*return*/];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                var targetPath, list_1, files;
                var _this = this;
                return __generator(this, function (_a) {
                    try {
                        targetPath = path_1.default.join(this.workspaceDir, args.path);
                        if (!targetPath.startsWith(this.workspaceDir))
                            return [2 /*return*/, "Error: Access denied."];
                        list_1 = function (dir, depth) {
                            if (depth === void 0) { depth = 0; }
                            if (depth > 2)
                                return []; // Limit depth
                            var entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
                            var results = [];
                            for (var _i = 0, entries_1 = entries; _i < entries_1.length; _i++) {
                                var entry = entries_1[_i];
                                if (['node_modules', '.git', 'dist', 'dist-electron'].includes(entry.name))
                                    continue;
                                var full = path_1.default.join(dir, entry.name);
                                var rel = path_1.default.relative(_this.workspaceDir, full).replace(/\\/g, '/');
                                results.push("".concat(entry.isDirectory() ? '[DIR]' : '[FILE]', " ").concat(rel));
                                if (args.recursive && entry.isDirectory()) {
                                    results = __spreadArray(__spreadArray([], results, true), list_1(full, depth + 1), true);
                                }
                            }
                            return results;
                        };
                        files = list_1(targetPath);
                        return [2 /*return*/, files.length > 0 ? files.join('\n') : "Directory is empty."];
                    }
                    catch (e) {
                        return [2 /*return*/, "Error listing files: ".concat(e.message)];
                    }
                    return [2 /*return*/];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                var targetPath;
                return __generator(this, function (_a) {
                    try {
                        targetPath = path_1.default.join(this.workspaceDir, args.path);
                        if (!targetPath.startsWith(this.workspaceDir)) {
                            return [2 /*return*/, "Error: Access denied. You can only delete within the workspace."];
                        }
                        if (!fs_1.default.existsSync(targetPath)) {
                            return [2 /*return*/, "Error: Path ".concat(args.path, " does not exist.")];
                        }
                        fs_1.default.rmSync(targetPath, { recursive: true, force: true });
                        return [2 /*return*/, "Success: Deleted ".concat(args.path)];
                    }
                    catch (e) {
                        return [2 /*return*/, "Error deleting path: ".concat(e.message)];
                    }
                    return [2 /*return*/];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                var targetPath;
                return __generator(this, function (_a) {
                    try {
                        targetPath = path_1.default.join(this.workspaceDir, args.path);
                        if (!targetPath.startsWith(this.workspaceDir)) {
                            return [2 /*return*/, "Error: Access denied. You can only create within the workspace."];
                        }
                        fs_1.default.mkdirSync(targetPath, { recursive: true });
                        return [2 /*return*/, "Success: Directory created at ".concat(args.path)];
                    }
                    catch (e) {
                        return [2 /*return*/, "Error creating directory: ".concat(e.message)];
                    }
                    return [2 /*return*/];
                });
            }); }
        });
        // Tool: get_user_profile
        this.register({
            name: 'get_user_profile',
            description: 'Retrieves the detailed user profile, including real-world and roleplay (RP) identity information such as birthdate, contact details, and history. Use this if you need to verify the user\'s age or personal details before proceeding with limited content.',
            parameters: { type: 'object', properties: {} },
            execute: function () { return __awaiter(_this, void 0, void 0, function () {
                var profilePath, profile;
                return __generator(this, function (_a) {
                    try {
                        profilePath = path_1.default.join(this.workspaceDir, 'data', 'user_profile.json');
                        if (!fs_1.default.existsSync(profilePath)) {
                            return [2 /*return*/, "Error: User profile not found at data/user_profile.json"];
                        }
                        profile = fs_1.default.readFileSync(profilePath, 'utf-8');
                        return [2 /*return*/, profile];
                    }
                    catch (e) {
                        return [2 /*return*/, "Error reading user profile: ".concat(e.message)];
                    }
                    return [2 /*return*/];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                var fullPath, content, occurrences, newContent;
                return __generator(this, function (_a) {
                    try {
                        fullPath = path_1.default.join(this.workspaceDir, args.path);
                        if (!fullPath.startsWith(this.workspaceDir))
                            return [2 /*return*/, "Error: Access denied."];
                        if (!fs_1.default.existsSync(fullPath))
                            return [2 /*return*/, "Error: File not found at ".concat(args.path)];
                        content = fs_1.default.readFileSync(fullPath, 'utf-8');
                        occurrences = content.split(args.search).length - 1;
                        if (occurrences === 0) {
                            return [2 /*return*/, "Error: Search block not found in ".concat(args.path, ". Ensure the search string exactly matches the file content including whitespace.")];
                        }
                        if (occurrences > 1) {
                            return [2 /*return*/, "Error: Multiple occurrences of the search block found in ".concat(args.path, ". Please provide a more specific (larger) search block to ensure a surgical edit.")];
                        }
                        newContent = content.replace(args.search, args.replace);
                        fs_1.default.writeFileSync(fullPath, newContent);
                        return [2 /*return*/, "Success: Patched ".concat(args.path)];
                    }
                    catch (e) {
                        return [2 /*return*/, "Error patching file: ".concat(e.message)];
                    }
                    return [2 /*return*/];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                var fullSrc, fullDest;
                return __generator(this, function (_a) {
                    try {
                        fullSrc = path_1.default.join(this.workspaceDir, args.src);
                        fullDest = path_1.default.join(this.workspaceDir, args.dest);
                        if (!fullSrc.startsWith(this.workspaceDir) || !fullDest.startsWith(this.workspaceDir)) {
                            return [2 /*return*/, "Error: Access denied. Paths must be within the workspace."];
                        }
                        if (!fs_1.default.existsSync(fullSrc)) {
                            return [2 /*return*/, "Error: Source ".concat(args.src, " does not exist.")];
                        }
                        fs_1.default.mkdirSync(path_1.default.dirname(fullDest), { recursive: true });
                        fs_1.default.renameSync(fullSrc, fullDest);
                        return [2 /*return*/, "Success: Moved ".concat(args.src, " to ").concat(args.dest)];
                    }
                    catch (e) {
                        return [2 /*return*/, "Error moving file: ".concat(e.message)];
                    }
                    return [2 /*return*/];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                var fullSrc, fullDest;
                return __generator(this, function (_a) {
                    try {
                        fullSrc = path_1.default.join(this.workspaceDir, args.src);
                        fullDest = path_1.default.join(this.workspaceDir, args.dest);
                        if (!fullSrc.startsWith(this.workspaceDir) || !fullDest.startsWith(this.workspaceDir)) {
                            return [2 /*return*/, "Error: Access denied. Paths must be within the workspace."];
                        }
                        if (!fs_1.default.existsSync(fullSrc)) {
                            return [2 /*return*/, "Error: Source ".concat(args.src, " does not exist.")];
                        }
                        fs_1.default.mkdirSync(path_1.default.dirname(fullDest), { recursive: true });
                        fs_1.default.cpSync(fullSrc, fullDest, { recursive: true });
                        return [2 /*return*/, "Success: Copied ".concat(args.src, " to ").concat(args.dest)];
                    }
                    catch (e) {
                        return [2 /*return*/, "Error copying file: ".concat(e.message)];
                    }
                    return [2 /*return*/];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    if (!args.url || typeof args.url !== 'string') {
                        return [2 /*return*/, "Error: Invalid arguments. 'url' string is required."];
                    }
                    return [2 /*return*/, "BROWSER_NAVIGATE: ".concat(args.url)];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, "BROWSER_CLICK: ".concat(args.selector)];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, "BROWSER_HOVER: ".concat(args.selector)];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, "BROWSER_TYPE: ".concat(JSON.stringify(args))];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, "BROWSER_SCROLL: ".concat(JSON.stringify(args))];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, "BROWSER_PRESS_KEY: ".concat(args.key)];
                });
            }); }
        });
        // Tool: browser_get_dom
        this.register({
            name: 'browser_get_dom',
            description: 'Retrieves a list of interactive elements on the page, each assigned a unique numeric ID (e.g. [12] BUTTON). Use these IDs for clicking and typing.',
            parameters: { type: 'object', properties: {} },
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, "BROWSER_GET_DOM: REQUEST"];
                });
            }); }
        });
        // Tool: browser_screenshot
        this.register({
            name: 'browser_screenshot',
            description: 'Captures a high-quality screenshot of the active web page in the center panel. Use this to verify visual state.',
            parameters: { type: 'object', properties: {} },
            execute: function () { return __awaiter(_this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, "BROWSER_SCREENSHOT: REQUEST"];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, "BROWSER_SEARCH: ".concat(args.query)];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    return [2 /*return*/, "TERMINAL_RUN: ".concat(args.command)];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                var exec;
                var _this = this;
                return __generator(this, function (_a) {
                    exec = require('child_process').exec;
                    return [2 /*return*/, new Promise(function (resolve) {
                            exec(args.command, { cwd: _this.workspaceDir }, function (err, stdout, stderr) {
                                if (err)
                                    resolve("Error: ".concat(err.message, "\n").concat(stderr));
                                else
                                    resolve(stdout || stderr || "Command executed with no output.");
                            });
                        })];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                var exec, scriptPath, cmd, pyPath, nodePath;
                var _this = this;
                var _a, _b, _c;
                return __generator(this, function (_d) {
                    exec = require('child_process').exec;
                    scriptPath = path_1.default.join(this.workspaceDir, args.path);
                    if (!scriptPath.startsWith(this.workspaceDir))
                        return [2 /*return*/, "Error: Access denied."];
                    cmd = '';
                    if (args.path.endsWith('.py')) {
                        pyPath = ((_a = this.systemInfo) === null || _a === void 0 ? void 0 : _a.pythonEnvPath) || ((_b = this.systemInfo) === null || _b === void 0 ? void 0 : _b.pythonPath) || 'python';
                        cmd = "\"".concat(pyPath, "\" \"").concat(scriptPath, "\"");
                    }
                    else if (args.path.endsWith('.js') || args.path.endsWith('.ts')) {
                        nodePath = ((_c = this.systemInfo) === null || _c === void 0 ? void 0 : _c.nodePath) || 'node';
                        if (args.path.endsWith('.ts'))
                            cmd = "npx ts-node \"".concat(scriptPath, "\"");
                        else
                            cmd = "\"".concat(nodePath, "\" \"").concat(scriptPath, "\"");
                    }
                    else {
                        return [2 /*return*/, "Error: Unsupported script type. Only .py, .js, .ts supported."];
                    }
                    return [2 /*return*/, new Promise(function (resolve) {
                            exec(cmd, { cwd: _this.workspaceDir }, function (err, stdout, stderr) {
                                if (err)
                                    resolve("Error: ".concat(err.message, "\n").concat(stderr));
                                else
                                    resolve(stdout || stderr || "Script executed successfully.");
                            });
                        })];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    // We return a prefixed string that AgentService.chat() will intercept
                    // and emit as an 'a2ui-update' event.
                    return [2 /*return*/, "A2UI_RENDER: ".concat(JSON.stringify(args.tree))];
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                var exec, runCheck, report, lintOut, errors, warnings, lines, buildOut, errors, lines;
                var _this = this;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            exec = require('child_process').exec;
                            runCheck = function (cmd) {
                                return new Promise(function (resolve) {
                                    exec(cmd, { cwd: _this.workspaceDir }, function (err, stdout, stderr) {
                                        resolve(stdout + '\n' + stderr);
                                    });
                                });
                            };
                            report = "[SYSTEM DIAGNOSIS REPORT]\n\n";
                            if (!(args.checkLint !== false)) return [3 /*break*/, 2];
                            report += "--- LINT CHECK ---\n";
                            return [4 /*yield*/, runCheck("npm run lint")];
                        case 1:
                            lintOut = _a.sent();
                            errors = (lintOut.match(/error/gi) || []).length;
                            warnings = (lintOut.match(/warning/gi) || []).length;
                            report += "Summary: ".concat(errors, " errors, ").concat(warnings, " warnings\n");
                            if (errors > 0 || warnings > 0) {
                                lines = lintOut.split('\n').filter(function (l) { return l.includes('error') || l.includes('warning'); }).slice(0, 10);
                                report += lines.join('\n') + (lines.length >= 10 ? "\n...(truncated)" : "") + "\n";
                            }
                            else {
                                report += "Clean.\n";
                            }
                            _a.label = 2;
                        case 2:
                            if (!(args.checkBuild !== false)) return [3 /*break*/, 4];
                            report += "\n--- BUILD CHECK ---\n";
                            return [4 /*yield*/, runCheck("npm run build")];
                        case 3:
                            buildOut = _a.sent();
                            errors = (buildOut.match(/error TS\d+/gi) || []).length;
                            report += "Summary: ".concat(errors, " TypeScript errors\n");
                            if (errors > 0) {
                                lines = buildOut.split('\n').filter(function (l) { return l.includes('error TS'); }).slice(0, 10);
                                report += lines.join('\n') + (lines.length >= 10 ? "\n...(truncated)" : "") + "\n";
                            }
                            else if (buildOut.includes('error')) {
                                report += "Build failed with general error.\n";
                                report += buildOut.substring(0, 500) + "\n";
                            }
                            else {
                                report += "Success.\n";
                            }
                            _a.label = 4;
                        case 4: return [2 /*return*/, report];
                    }
                });
            }); }
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
            execute: function (args) { return __awaiter(_this, void 0, void 0, function () {
                var tree;
                return __generator(this, function (_a) {
                    tree = {
                        type: 'goal_tree',
                        props: { goals: args.goals }
                    };
                    return [2 /*return*/, "A2UI_RENDER: ".concat(JSON.stringify(tree))];
                });
            }); }
        });
    };
    /**
     * Registers a new tool, making it available to the AI agent.
     *
     * If a tool with the same name is already registered, it is overwritten.
     *
     * @param {ToolDefinition} tool - The tool definition to register.
     */
    ToolService.prototype.register = function (tool) {
        this.tools.set(tool.name, tool);
    };
    /**
     * Injects the McpService dependency.
     */
    ToolService.prototype.setMcpService = function (mcp) {
        console.log('[ToolService] MCP Service Injected');
        this.mcpService = mcp;
    };
    /**
     * Refreshes the list of available MCP tools from all connected servers.
     * This should be called whenever MCP connections change.
     */
    ToolService.prototype.refreshMcpTools = function () {
        return __awaiter(this, void 0, void 0, function () {
            var serverIds, _i, serverIds_1, serverId, caps, _a, _b, tool, e_5;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        if (!this.mcpService)
                            return [2 /*return*/];
                        console.log('[ToolService] Refreshing MCP Tools...');
                        this.mcpTools.clear();
                        serverIds = this.mcpService.getActiveConnections();
                        _i = 0, serverIds_1 = serverIds;
                        _c.label = 1;
                    case 1:
                        if (!(_i < serverIds_1.length)) return [3 /*break*/, 6];
                        serverId = serverIds_1[_i];
                        _c.label = 2;
                    case 2:
                        _c.trys.push([2, 4, , 5]);
                        return [4 /*yield*/, this.mcpService.getCapabilities(serverId)];
                    case 3:
                        caps = _c.sent();
                        if (caps.tools) {
                            for (_a = 0, _b = caps.tools; _a < _b.length; _a++) {
                                tool = _b[_a];
                                // Avoid overwriting core tools
                                if (this.tools.has(tool.name)) {
                                    console.warn("[ToolService] Skipping MCP tool '".concat(tool.name, "' from '").concat(serverId, "' (collision with core tool)."));
                                    continue;
                                }
                                // Register in mcpTools map
                                this.mcpTools.set(tool.name, { serverId: serverId, def: tool });
                                console.log("[ToolService] Registered MCP tool: ".concat(tool.name, " form ").concat(serverId));
                            }
                        }
                        return [3 /*break*/, 5];
                    case 4:
                        e_5 = _c.sent();
                        console.error("[ToolService] Failed to load tools from ".concat(serverId, ":"), e_5);
                        return [3 /*break*/, 5];
                    case 5:
                        _i++;
                        return [3 /*break*/, 1];
                    case 6: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Generates a formatted string describing all registered tools and their
     * JSON Schema parameters. This string is injected into the system prompt
     * so the AI knows what tools are available.
     *
     * @returns {string} Multi-line string with tool names, descriptions, and parameter schemas.
     */
    ToolService.prototype.getToolSchemas = function () {
        var schemaStr = "You have access to the following tools:\n\n";
        // Core Tools
        this.tools.forEach(function (tool) {
            schemaStr += "### ".concat(tool.name, "\nDescription: ").concat(tool.description, "\nJSON Schema: ").concat(JSON.stringify(tool.parameters), "\n\n");
        });
        // MCP Tools
        this.mcpTools.forEach(function (entry, name) {
            var tool = entry.def;
            schemaStr += "### ".concat(tool.name, "\nDescription: ").concat(tool.description || 'No description provided.', " (Source: ").concat(entry.serverId, ")\nJSON Schema: ").concat(JSON.stringify(tool.inputSchema || tool.parameters), "\n\n");
        });
        return schemaStr;
    };
    /**
     * Generates a compact, TypeScript-style signature list of all tools.
     * Use this when Native Tools are enabled to save token space in the system prompt.
     *
     * Format: `tool_name(param: type, ...) - Description`
     */
    ToolService.prototype.getToolSignatures = function () {
        var sigStr = "Available Tools (Native Definitions Provided):\n";
        var formatParams = function (schema) {
            if (!schema || !schema.properties)
                return '';
            return Object.entries(schema.properties).map(function (_a) {
                var _b;
                var key = _a[0], val = _a[1];
                return "".concat(key).concat(((_b = schema.required) === null || _b === void 0 ? void 0 : _b.includes(key)) ? '' : '?', ": ").concat(val.type);
            }).join(', ');
        };
        // Core Tools
        this.tools.forEach(function (tool) {
            sigStr += "- ".concat(tool.name, "(").concat(formatParams(tool.parameters), ") : ").concat(tool.description.slice(0, 100)).concat(tool.description.length > 100 ? '...' : '', "\n");
        });
        // MCP Tools
        this.mcpTools.forEach(function (entry, name) {
            var tool = entry.def;
            var schema = tool.inputSchema || tool.parameters;
            sigStr += "- ".concat(tool.name, "(").concat(formatParams(schema), ") : ").concat(tool.description ? tool.description.slice(0, 100) : '', " (Source: ").concat(entry.serverId, ")\n");
        });
        return sigStr;
    };
    /**
     * Checks if a tool with the given name is registered.
     *
     * @param {string} name - The tool name to check.
     * @returns {boolean} `true` if the tool exists.
     */
    ToolService.prototype.hasTool = function (name) {
        return this.tools.has(name) || this.mcpTools.has(name);
    };
    /**
     * Recursively rewrites a JSON schema to comply with OpenAI's Strict Structured Outputs (GBNF).
     * Enforces `additionalProperties: false` on all objects and explicitly lists all properties in `required`.
     */
    ToolService.prototype.makeStrictSchema = function (schema) {
        if (!schema || typeof schema !== 'object')
            return schema;
        var strictSchema = __assign({}, schema);
        if (strictSchema.type === 'object') {
            strictSchema.additionalProperties = false;
            // Collect all properties
            var props = strictSchema.properties ? Object.keys(strictSchema.properties) : [];
            // Ensure all properties are required for strict outputs
            if (props.length > 0) {
                strictSchema.required = props;
            }
            else {
                // If it's an object with no properties, strict mode requires an empty properties object
                strictSchema.properties = {};
            }
            // Recursively apply to all child properties
            if (strictSchema.properties) {
                for (var key in strictSchema.properties) {
                    strictSchema.properties[key] = this.makeStrictSchema(strictSchema.properties[key]);
                }
            }
        }
        else if (strictSchema.type === 'array' && strictSchema.items) {
            strictSchema.items = this.makeStrictSchema(strictSchema.items);
        }
        return strictSchema;
    };
    /**
     * Returns tool definitions in the format expected by OpenAI/Ollama APIs.
     * @returns {Array<{ type: 'function', function: { name: string, description: string, parameters: any, strict?: boolean } }>}
     */
    ToolService.prototype.getToolDefinitions = function () {
        var _this = this;
        var definitions = [];
        // Core Tools
        this.tools.forEach(function (tool) {
            definitions.push({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    strict: true,
                    parameters: _this.makeStrictSchema(tool.parameters || { type: 'object', properties: {} })
                }
            });
        });
        // MCP Tools
        this.mcpTools.forEach(function (entry, name) {
            var tool = entry.def;
            definitions.push({
                type: 'function',
                function: {
                    name: name, // Use registry key 'name' which is guaranteed to be the correct ID
                    description: tool.description || 'No description provided.',
                    strict: true,
                    parameters: _this.makeStrictSchema(tool.inputSchema || tool.parameters || { type: 'object', properties: {} })
                }
            });
        });
        return definitions;
    };
    /**
     * Returns a simple list of all tool names and descriptions.
     * Used by the UI for tool selection dropdowns.
     * @returns {Array<{ name: string, description: string, source: string }>}
     */
    ToolService.prototype.getAllTools = function () {
        var list = [];
        this.tools.forEach(function (tool) {
            list.push({
                name: tool.name,
                description: tool.description,
                source: 'core'
            });
        });
        this.mcpTools.forEach(function (entry, name) {
            list.push({
                name: name,
                description: entry.def.description || 'No description provided.',
                source: entry.serverId
            });
        });
        return list;
    };
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
    ToolService.prototype.executeTool = function (name, args) {
        return __awaiter(this, void 0, Promise, function () {
            var tool, output, entry, result, text, e_6;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        // Strip provider-specific prefixes if present (e.g. Gemini OpenAI shim prepends 'default_api:')
                        if (name.startsWith('default_api:')) {
                            name = name.substring('default_api:'.length);
                        }
                        if (!this.tools.has(name)) return [3 /*break*/, 2];
                        tool = this.tools.get(name);
                        return [4 /*yield*/, tool.execute(args)];
                    case 1:
                        output = _a.sent();
                        return [2 /*return*/, output];
                    case 2:
                        if (!this.mcpTools.has(name)) return [3 /*break*/, 6];
                        entry = this.mcpTools.get(name);
                        _a.label = 3;
                    case 3:
                        _a.trys.push([3, 5, , 6]);
                        return [4 /*yield*/, this.mcpService.callTool(entry.serverId, name, args)];
                    case 4:
                        result = _a.sent();
                        // Result structure from MCP SDK: { content: [{ type: 'text', text: '...' }] }
                        if (result && result.content && Array.isArray(result.content)) {
                            text = result.content
                                .filter(function (c) { return c.type === 'text'; })
                                .map(function (c) { return c.text; })
                                .join('\n');
                            return [2 /*return*/, text || JSON.stringify(result)];
                        }
                        return [2 /*return*/, JSON.stringify(result)];
                    case 5:
                        e_6 = _a.sent();
                        return [2 /*return*/, "Error executing MCP tool ".concat(name, ": ").concat(e_6.message)];
                    case 6: return [2 /*return*/, "Error: Tool ".concat(name, " not found.")];
                }
            });
        });
    };
    return ToolService;
}());
exports.ToolService = ToolService;
