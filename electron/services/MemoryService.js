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
exports.MemoryService = void 0;
var index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
var stdio_js_1 = require("@modelcontextprotocol/sdk/client/stdio.js");
var electron_1 = require("electron");
var fs_1 = require("fs");
var path_1 = require("path");
/**
 * MemoryService
 *
 * Provides short-term, conversational memory for the Tala agent. Implements a
 * dual-storage strategy with an MCP remote backend (Mem0) as the primary store
 * and a local JSON file as a fallback.
 *
 * **Architecture:**
 * - **Primary**: Remote Mem0 MCP server (`mem0-core/server.py`) accessed via
 *   the MCP SDK. Provides semantic search and AI-powered memory extraction.
 * - **Fallback**: Local JSON file at `{userData}/tala_memory.json`. Uses simple
 *   keyword matching for search. Always receives writes for redundancy.
 *
 * **Difference from RagService:**
 * - `MemoryService` = short-term, conversational memory (facts, preferences, turns).
 * - `RagService` = long-term, document-based memory (narrative files, knowledge base).
 *
 * @example
 * ```typescript
 * const memory = new MemoryService();
 * await memory.ignite('/path/to/python', '/path/to/server.py');
 * await memory.add('User prefers TypeScript over JavaScript');
 * const results = await memory.search('programming language preference');
 * ```
 */
var MemoryService = /** @class */ (function () {
    /**
     * Creates a new MemoryService instance.
     *
     * Computes the local storage path (`{userData}/tala_memory.json`) and
     * immediately loads any existing memories from disk into the in-memory array.
     * The MCP client is NOT connected at this point — call `ignite()` or `connect()`
     * to establish the remote connection.
     */
    function MemoryService() {
        /** MCP SDK client instance for communicating with the remote Mem0 server. Null if not connected. */
        this.client = null;
        /** The stdio transport used to communicate with the Mem0 child process. */
        this.transport = null;
        /** In-memory array of all locally stored memories, loaded from disk at startup. */
        this.localMemories = [];
        this.localPath = path_1.default.join(electron_1.app.getPath('userData'), 'tala_memory.json');
        this.loadLocal();
    }
    /**
     * Loads the local memory store from the JSON file on disk into the
     * `localMemories` array.
     *
     * If the file doesn't exist (first launch) or contains invalid JSON,
     * the array is initialized to empty. This method is called once during
     * construction and is not expected to be called again.
     *
     * @private
     * @returns {void}
     */
    MemoryService.prototype.loadLocal = function () {
        var _this = this;
        if (fs_1.default.existsSync(this.localPath)) {
            try {
                var raw = JSON.parse(fs_1.default.readFileSync(this.localPath, 'utf-8'));
                if (Array.isArray(raw)) {
                    this.localMemories = raw.map(function (m) { return _this.normalizeMemory(m); });
                }
            }
            catch (e) {
                console.error("[Memory] Failed to load local memories", e);
                this.localMemories = [];
            }
        }
    };
    /**
     * Normalizes a memory item to ensure it has all required metadata fields.
     * This handles migration of legacy memories.
     */
    MemoryService.prototype.normalizeMemory = function (m) {
        var _a, _b, _c, _d, _e;
        var metadata = m.metadata || {};
        // 1. Canonical Source Normalization
        var source = metadata.source || 'explicit';
        if (source === 'conversation' || source === 'chat')
            source = 'explicit';
        if (!['rag', 'mem0', 'explicit', 'astro', 'graph', 'core'].includes(source)) {
            source = 'explicit';
        }
        // 2. Canonical Role/Scope Normalization
        var role = metadata.role || 'core';
        if (role === 'system')
            role = 'core';
        var finalMetadata = __assign(__assign({}, metadata), { source: source, role: role });
        return {
            id: m.id || Date.now().toString(),
            text: m.text || "",
            metadata: finalMetadata,
            score: m.score,
            timestamp: m.timestamp || Date.now(),
            salience: (_a = m.salience) !== null && _a !== void 0 ? _a : 0.5,
            confidence: (_b = m.confidence) !== null && _b !== void 0 ? _b : (finalMetadata.source === 'explicit' ? 0.9 : 0.7),
            created_at: m.created_at || m.timestamp || Date.now(),
            last_accessed_at: (_c = m.last_accessed_at) !== null && _c !== void 0 ? _c : null,
            last_reinforced_at: (_d = m.last_reinforced_at) !== null && _d !== void 0 ? _d : (m.created_at || m.timestamp || Date.now()),
            access_count: (_e = m.access_count) !== null && _e !== void 0 ? _e : 0,
            associations: Array.isArray(m.associations) ? m.associations : [],
            status: m.status || 'active'
        };
    };
    /**
     * Persists the current in-memory `localMemories` array to the JSON file on disk.
     *
     * Called after every `add()` operation to ensure local persistence. The file
     * is written with pretty-printed JSON (2-space indentation) for debuggability.
     * Write errors are caught and logged but do not throw — memory persistence
     * failures are non-fatal.
     *
     * @private
     * @returns {void}
     */
    MemoryService.prototype.saveLocal = function () {
        try {
            fs_1.default.writeFileSync(this.localPath, JSON.stringify(this.localMemories, null, 2));
        }
        catch (e) {
            console.error("Failed to save memory", e);
        }
    };
    /**
     * Starts the embedded Mem0 MCP server and connects to it.
     *
     * This is the preferred connection method, used during the application's
     * "igniteSoul" startup sequence. It spawns the Mem0 Python server as a child
     * process via stdio transport and establishes a bidirectional MCP connection.
     *
     * If the Python executable or script file doesn't exist on disk, the method
     * exits silently and the service falls back to local-only memory storage.
     * If the MCP connection fails, the client is nullified and the service
     * continues operating with local storage only.
     *
     * @param {string} pythonPath - Absolute path to the Python executable
     *   (e.g., from the project's virtual environment: `venv/Scripts/python.exe`).
     * @param {string} scriptPath - Absolute path to the Mem0 MCP server script
     *   (e.g., `mcp-servers/mem0-core/server.py`).
     * @returns {Promise<void>}
     */
    MemoryService.prototype.ignite = function (pythonPath_1, scriptPath_1) {
        return __awaiter(this, arguments, void 0, function (pythonPath, scriptPath, envVars) {
            var connectPromise, timeoutPromise;
            var _this = this;
            if (envVars === void 0) { envVars = {}; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        console.log("[MemoryService] Igniting embedded Mem0 server at ".concat(scriptPath, "..."));
                        connectPromise = function () { return __awaiter(_this, void 0, void 0, function () {
                            var client, e_1;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0:
                                        _a.trys.push([0, 2, , 3]);
                                        // Check if files exist
                                        if (!fs_1.default.existsSync(pythonPath) || !fs_1.default.existsSync(scriptPath)) {
                                            console.warn("[MemoryService] Python/Script not found for Mem0. Using local fallback.");
                                            return [2 /*return*/];
                                        }
                                        this.transport = new stdio_js_1.StdioClientTransport({
                                            command: pythonPath,
                                            args: [scriptPath],
                                            env: __assign(__assign(__assign({}, process.env), envVars), { PYTHONUNBUFFERED: '1' })
                                        });
                                        client = new index_js_1.Client({
                                            name: "tala-memory-client",
                                            version: "1.0.0"
                                        }, {
                                            capabilities: {}
                                        });
                                        // Handle transport errors specifically
                                        this.transport.onerror = function (err) {
                                            console.error("[MemoryService] Transport Error:", err);
                                        };
                                        console.log("[MemoryService] Spawning: ".concat(pythonPath, " ").concat(scriptPath));
                                        return [4 /*yield*/, client.connect(this.transport)];
                                    case 1:
                                        _a.sent();
                                        this.client = client;
                                        console.log("[MemoryService] Connected to Embedded Mem0.");
                                        return [3 /*break*/, 3];
                                    case 2:
                                        e_1 = _a.sent();
                                        console.error("[MemoryService] Ignition failed:", e_1);
                                        this.client = null;
                                        return [3 /*break*/, 3];
                                    case 3: return [2 /*return*/];
                                }
                            });
                        }); };
                        timeoutPromise = new Promise(function (resolve, reject) {
                            setTimeout(function () {
                                if (!_this.client) {
                                    console.warn('[MemoryService] Ignition timed out (15000ms). Rejecting promise.');
                                    reject(new Error("Mem0 Core ignition timed out. Server failed to start."));
                                }
                                else {
                                    resolve();
                                }
                            }, 15000);
                        });
                        return [4 /*yield*/, Promise.race([connectPromise(), timeoutPromise])];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Connects to an externally managed MCP memory server using a generic command.
     *
     * Unlike `ignite()`, this method does not validate file paths or provide
     * special error handling. It's a lower-level connection method for cases
     * where the server is managed externally or uses non-standard arguments.
     *
     * @param {string} command - The command to spawn (e.g., `'python'`, `'node'`).
     * @param {string[]} args - Array of command arguments (e.g., `['server.py']`).
     * @returns {Promise<void>}
     */
    MemoryService.prototype.connect = function (command, args) {
        return __awaiter(this, void 0, void 0, function () {
            var e_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        this.transport = new stdio_js_1.StdioClientTransport({
                            command: command,
                            args: args
                        });
                        this.client = new index_js_1.Client({
                            name: "tala-client",
                            version: "1.0.0"
                        }, {
                            capabilities: {}
                        });
                        return [4 /*yield*/, this.client.connect(this.transport)];
                    case 1:
                        _a.sent();
                        console.log("[MemoryService] Connected to MCP: ".concat(command));
                        return [3 /*break*/, 3];
                    case 2:
                        e_2 = _a.sent();
                        console.error("[MemoryService] Connection failed:", e_2);
                        return [3 /*break*/, 3];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Searches for memories relevant to the given query.
     *
     * Implements a cascading search strategy:
     *
     * **1. Remote Search (Preferred):**
     * If the MCP client is connected, calls the `mem0_search` tool on the remote
     * Mem0 server. The remote server uses semantic/vector search for high-quality
     * results. Results are mapped to `MemoryItem` objects with `id: 'remote'`.
     *
     * **2. Local Fallback:**
     * If the remote search fails or the MCP client is not connected, falls back
     * to a simple keyword-based search over the local memory array:
     * - Splits the query into terms (words with length > 3 characters).
     * - If no valid terms, returns the N most recent memories.
     * - Otherwise, scores each memory by counting how many query terms appear in
     *   its text (case-insensitive).
     * - Returns the top N results sorted by score descending.
     *
     * @param {string} query - The search query string (e.g., "What is the user's name?").
     * @param {number} [limit=5] - Maximum number of results to return.
     * @returns {Promise<MemoryItem[]>} Array of matching memories, ordered by relevance.
     *   Returns an empty array if no memories exist and no matches are found.
     */
    MemoryService.prototype.search = function (query_1) {
        return __awaiter(this, arguments, void 0, function (query, limit, mode) {
            var result, textContent, memories, e_3, filteredMemories, terms, scored, topDirect, expanded, combined, reranked, results;
            var _this = this;
            if (limit === void 0) { limit = 5; }
            if (mode === void 0) { mode = 'assistant'; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.client) return [3 /*break*/, 4];
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, this.client.callTool({
                                name: "mem0_search",
                                arguments: { query: query, limit: limit, filters: mode === 'rp' ? { role: 'rp' } : { role: 'core' } }
                            })];
                    case 2:
                        result = _a.sent();
                        // Parse JSON response from the server
                        if (result && result.content && Array.isArray(result.content)) {
                            textContent = result.content.find(function (c) { return c.type === 'text'; });
                            if (textContent && textContent.text) {
                                try {
                                    memories = JSON.parse(textContent.text);
                                    if (Array.isArray(memories)) {
                                        return [2 /*return*/, memories.map(function (m) { return _this.normalizeMemory({
                                                id: m.id || 'remote',
                                                text: m.text || String(m),
                                                timestamp: Date.now(),
                                                metadata: m.metadata || {}
                                            }); })];
                                    }
                                }
                                catch (parseError) {
                                    console.warn("[Memory] Failed to parse JSON response:", parseError);
                                }
                            }
                        }
                        return [3 /*break*/, 4];
                    case 3:
                        e_3 = _a.sent();
                        console.warn("[Memory] Remote search failed, falling back to local.");
                        return [3 /*break*/, 4];
                    case 4:
                        filteredMemories = this.localMemories;
                        if (mode === 'rp') {
                            filteredMemories = filteredMemories.filter(function (m) { var _a; return ((_a = m.metadata) === null || _a === void 0 ? void 0 : _a.role) === 'rp'; });
                        }
                        else {
                            // Core modes (assistant/hybrid) only see core memories
                            filteredMemories = filteredMemories.filter(function (m) { var _a; return ((_a = m.metadata) === null || _a === void 0 ? void 0 : _a.role) !== 'rp'; });
                        }
                        terms = query.toLowerCase().split(' ').filter(function (t) { return t.length > 3; });
                        if (terms.length === 0)
                            return [2 /*return*/, filteredMemories.slice(-limit).reverse()]; // Return latest if no terms
                        scored = filteredMemories.map(function (m) {
                            var semanticScore = 0;
                            terms.forEach(function (t) {
                                if (m.text.toLowerCase().includes(t))
                                    semanticScore += 1;
                            });
                            var normalizedSemantic = Math.min(semanticScore / terms.length, 1.0);
                            return { m: m, normalizedSemantic: normalizedSemantic };
                        });
                        topDirect = scored
                            .sort(function (a, b) { return b.normalizedSemantic - a.normalizedSemantic; })
                            .slice(0, 5);
                        expanded = this.expandAssociations(topDirect.map(function (d) { return d.m; }));
                        combined = __spreadArray([], topDirect.map(function (d) { return ({ item: d.m, semantic: d.normalizedSemantic, boost: 0 }); }), true);
                        expanded.forEach(function (e) {
                            if (!combined.find(function (c) { return c.item.id === e.item.id; })) {
                                combined.push({ item: e.item, semantic: 0, boost: e.weight });
                            }
                        });
                        reranked = combined.map(function (c) {
                            var compositeResult = _this.calculateCompositeScore(c.item, c.semantic, c.boost);
                            return __assign(__assign({}, c.item), { compositeScore: compositeResult.final_score, audit: compositeResult });
                        });
                        results = reranked
                            .filter(function (m) { return m.compositeScore && m.compositeScore > 0.1; })
                            .sort(function (a, b) { return (b.compositeScore || 0) - (a.compositeScore || 0); })
                            .slice(0, limit);
                        // Update Access Metadata
                        results.forEach(function (m) {
                            var _a, _b, _c, _d, _e, _f;
                            m.last_accessed_at = Date.now();
                            m.access_count++;
                            console.log("[MemoryAudit] id=".concat(m.id, " text=\"").concat(m.text.substring(0, 30), "...\" score=").concat((_a = m.compositeScore) === null || _a === void 0 ? void 0 : _a.toFixed(3), " (sem:").concat((_b = m.audit) === null || _b === void 0 ? void 0 : _b.semantic_similarity.toFixed(2), " sal:").concat((_c = m.audit) === null || _c === void 0 ? void 0 : _c.salience_component.toFixed(2), " rec:").concat((_d = m.audit) === null || _d === void 0 ? void 0 : _d.recency_component.toFixed(2), " conf:").concat((_e = m.audit) === null || _e === void 0 ? void 0 : _e.confidence_component.toFixed(2), " assoc:").concat((_f = m.audit) === null || _f === void 0 ? void 0 : _f.association_component.toFixed(2), ")"));
                        });
                        return [2 /*return*/, results];
                }
            });
        });
    };
    /**
     * Expands a set of memories by one-hop associations.
     */
    MemoryService.prototype.expandAssociations = function (seeds) {
        var _this = this;
        var expanded = [];
        var THRESHOLD = 0.3;
        seeds.forEach(function (seed) {
            seed.associations.forEach(function (assoc) {
                if (assoc.weight >= THRESHOLD) {
                    var target = _this.localMemories.find(function (m) { return m.id === assoc.target_id; });
                    if (target) {
                        expanded.push({ item: target, weight: assoc.weight });
                    }
                }
            });
        });
        return expanded;
    };
    MemoryService.prototype.calculateCompositeScore = function (item, semanticSimilarity, associationBoost) {
        if (associationBoost === void 0) { associationBoost = 0; }
        var salienceComp = item.salience * MemoryService.WEIGHT_SALIENCE;
        var confidenceComp = item.confidence * MemoryService.WEIGHT_CONFIDENCE;
        var recencyScore = this.calculateRecencyScore(item);
        var recencyComp = recencyScore * MemoryService.WEIGHT_RECENCY;
        var associationComp = associationBoost * MemoryService.WEIGHT_ASSOCIATION;
        var semanticComp = semanticSimilarity * MemoryService.WEIGHT_SEMANTIC;
        var finalScore = semanticComp + salienceComp + recencyComp + confidenceComp + associationComp;
        // Status Penalties
        var statusPenalty = 0;
        if (item.status === 'contested')
            statusPenalty = 0.3;
        if (item.status === 'superseded' || item.status === 'archived')
            statusPenalty = 0.8;
        finalScore = Math.max(0, finalScore - statusPenalty);
        return {
            semantic_similarity: semanticSimilarity,
            salience_component: salienceComp,
            recency_component: recencyComp,
            confidence_component: confidenceComp,
            association_component: associationComp,
            status_penalty: statusPenalty,
            final_score: finalScore
        };
    };
    /**
     * Calculates recency score using exponential decay.
     */
    MemoryService.prototype.calculateRecencyScore = function (item) {
        var now = Date.now();
        var referenceTime = item.last_reinforced_at || item.last_accessed_at || item.created_at;
        var diffDays = (now - referenceTime) / (1000 * 60 * 60 * 24);
        return Math.exp(-MemoryService.RECENCY_DECAY_LAMBDA * diffDays);
    };
    /**
     * Adds a new memory to both the local store and the remote MCP server.
     *
     * The memory is always saved to the local JSON file first (for redundancy),
     * then an attempt is made to push it to the remote Mem0 server if connected.
     * If the remote write fails, the memory still persists locally.
     *
     * A unique ID is generated using the current Unix timestamp in milliseconds.
     *
     * @param {string} text - The memory text content to store
     *   (e.g., "User prefers dark mode", "Steve's birthday is March 15").
     * @param {any} [metadata] - Optional metadata to attach to the memory.
     *   Common fields include `source`, `category`, `user_id`, etc.
     *   When sent to the remote server, metadata properties are spread into
     *   the tool arguments alongside the text.
     * @returns {Promise<boolean>} Always returns `true` (local write never fails fatally).
     */
    MemoryService.prototype.add = function (text_1) {
        return __awaiter(this, arguments, void 0, function (text, metadata, mode) {
            var role, finalMetadata, now, newItem, e_4;
            if (metadata === void 0) { metadata = {}; }
            if (mode === void 0) { mode = 'assistant'; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        role = mode === 'rp' ? 'rp' : 'core';
                        finalMetadata = __assign(__assign({}, metadata), { role: role });
                        now = Date.now();
                        newItem = {
                            id: now.toString(),
                            text: text,
                            metadata: finalMetadata,
                            timestamp: now,
                            salience: 0.5,
                            confidence: finalMetadata.source === 'explicit' ? 0.9 : 0.7,
                            created_at: now,
                            last_accessed_at: null,
                            last_reinforced_at: now,
                            access_count: 0,
                            associations: [],
                            status: 'active'
                        };
                        this.localMemories.push(newItem);
                        return [4 /*yield*/, this.handleContradiction(newItem)];
                    case 1:
                        _a.sent();
                        this.saveLocal();
                        if (!this.client) return [3 /*break*/, 5];
                        _a.label = 2;
                    case 2:
                        _a.trys.push([2, 4, , 5]);
                        return [4 /*yield*/, this.client.callTool({
                                name: "mem0_add",
                                arguments: { text: text, metadata: finalMetadata }
                            })];
                    case 3:
                        _a.sent();
                        return [3 /*break*/, 5];
                    case 4:
                        e_4 = _a.sent();
                        console.warn("[Memory] Remote add failed");
                        return [3 /*break*/, 5];
                    case 5: return [2 /*return*/, true];
                }
            });
        });
    };
    /**
     * Retrieves all locally stored memories.
     * @returns {Promise<MemoryItem[]>} Array of all local memory items.
     */
    MemoryService.prototype.getAll = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                return [2 /*return*/, __spreadArray([], this.localMemories, true).sort(function (a, b) { return b.timestamp - a.timestamp; })];
            });
        });
    };
    /**
     * Deletes a memory item by ID.
     * @param {string} id - The ID of the memory to delete.
     * @returns {Promise<boolean>} True if found and deleted, false otherwise.
     */
    MemoryService.prototype.delete = function (id) {
        return __awaiter(this, void 0, void 0, function () {
            var index;
            return __generator(this, function (_a) {
                index = this.localMemories.findIndex(function (m) { return m.id === id; });
                if (index !== -1) {
                    this.localMemories.splice(index, 1);
                    this.saveLocal();
                    // TODO: Delete from remote Mem0 when API is available
                    return [2 /*return*/, true];
                }
                return [2 /*return*/, false];
            });
        });
    };
    /**
     * Updates the text of a memory item.
     * @param {string} id - The ID of the memory to update.
     * @param {string} text - The new text content.
     * @returns {Promise<boolean>} True if found and updated, false otherwise.
     */
    MemoryService.prototype.update = function (id, text) {
        return __awaiter(this, void 0, void 0, function () {
            var item;
            return __generator(this, function (_a) {
                item = this.localMemories.find(function (m) { return m.id === id; });
                if (item) {
                    item.text = text;
                    item.timestamp = Date.now();
                    item.last_reinforced_at = Date.now();
                    this.saveLocal();
                    // TODO: Update remote Mem0 when API is available
                    return [2 /*return*/, true];
                }
                return [2 /*return*/, false];
            });
        });
    };
    /**
     * Prunes old memories based on TTL and max count.
     * @param ttlDays Age in days to expire.
     * @param maxItems Maximum number of items to keep.
     * @returns Number of items removed.
     */
    MemoryService.prototype.prune = function (ttlDays, maxItems) {
        return __awaiter(this, void 0, void 0, function () {
            var now, cutoff, initialCount, kept, deletedCount;
            return __generator(this, function (_a) {
                now = Date.now();
                cutoff = now - (ttlDays * 24 * 60 * 60 * 1000);
                initialCount = this.localMemories.length;
                kept = this.localMemories.filter(function (m) { return m.timestamp >= cutoff; });
                // Filter by Max Items (keep newest)
                if (kept.length > maxItems) {
                    kept.sort(function (a, b) { return b.timestamp - a.timestamp; });
                    kept = kept.slice(0, maxItems);
                }
                deletedCount = initialCount - kept.length;
                if (deletedCount > 0) {
                    this.localMemories = kept;
                    this.saveLocal();
                }
                return [2 /*return*/, deletedCount];
            });
        });
    };
    /**
     * Shuts down the Memory service by closing the MCP client and transport.
     * This ensures the underlying Python process is terminated.
     */
    MemoryService.prototype.shutdown = function () {
        return __awaiter(this, void 0, void 0, function () {
            var e_5, e_6;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.client) return [3 /*break*/, 5];
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, this.client.close()];
                    case 2:
                        _a.sent();
                        console.log('[MemoryService] Disconnected.');
                        return [3 /*break*/, 4];
                    case 3:
                        e_5 = _a.sent();
                        console.error('[MemoryService] Error during shutdown:', e_5);
                        return [3 /*break*/, 4];
                    case 4:
                        this.client = null;
                        _a.label = 5;
                    case 5:
                        if (!this.transport) return [3 /*break*/, 10];
                        _a.label = 6;
                    case 6:
                        _a.trys.push([6, 8, , 9]);
                        return [4 /*yield*/, this.transport.close()];
                    case 7:
                        _a.sent();
                        return [3 /*break*/, 9];
                    case 8:
                        e_6 = _a.sent();
                        return [3 /*break*/, 9];
                    case 9:
                        this.transport = null;
                        _a.label = 10;
                    case 10: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Detects and handles contradictions when a new memory is added.
     */
    MemoryService.prototype.handleContradiction = function (newItem) {
        return __awaiter(this, void 0, void 0, function () {
            var terms, candidates, _loop_1, _i, candidates_1, candidate;
            var _a, _b;
            return __generator(this, function (_c) {
                terms = newItem.text.toLowerCase().split(' ').filter(function (t) { return t.length > 3; });
                if (terms.length < 2)
                    return [2 /*return*/];
                candidates = this.localMemories.filter(function (m) { return m.id !== newItem.id && m.status === 'active'; });
                _loop_1 = function (candidate) {
                    var overlap = 0;
                    terms.forEach(function (t) {
                        if (candidate.text.toLowerCase().includes(t))
                            overlap++;
                    });
                    // If overlap is high (e.g. 70%), assume it might talk about the same subject
                    if (overlap / terms.length >= 0.7) {
                        var newIsExplicit = ((_a = newItem.metadata) === null || _a === void 0 ? void 0 : _a.source) === 'explicit';
                        var oldIsExplicit = ((_b = candidate.metadata) === null || _b === void 0 ? void 0 : _b.source) === 'explicit';
                        if (newIsExplicit && !oldIsExplicit) {
                            candidate.status = 'superseded';
                            newItem.associations.push({ target_id: candidate.id, type: 'supersedes', weight: 1.0 });
                        }
                        else {
                            candidate.status = 'contested';
                            newItem.associations.push({ target_id: candidate.id, type: 'contradicts', weight: 0.8 });
                            candidate.associations.push({ target_id: newItem.id, type: 'contradicts', weight: 0.8 });
                        }
                    }
                };
                for (_i = 0, candidates_1 = candidates; _i < candidates_1.length; _i++) {
                    candidate = candidates_1[_i];
                    _loop_1(candidate);
                }
                return [2 /*return*/];
            });
        });
    };
    // --- SCORING CONSTANTS (PHASE 2) ---
    MemoryService.WEIGHT_SEMANTIC = 0.35;
    MemoryService.WEIGHT_SALIENCE = 0.25;
    MemoryService.WEIGHT_RECENCY = 0.15;
    MemoryService.WEIGHT_CONFIDENCE = 0.15;
    MemoryService.WEIGHT_ASSOCIATION = 0.10;
    MemoryService.RECENCY_DECAY_LAMBDA = 0.05; // ~14 day half-life
    return MemoryService;
}());
exports.MemoryService = MemoryService;
