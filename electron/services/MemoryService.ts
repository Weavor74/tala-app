import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

/**
 * Represents a single memory entry stored locally or retrieved from the MCP server.
 * Memories are short-term conversational context pieces (facts, preferences,
 * decisions) that the agent can recall during interactions.
 */
interface MemoryItem {
    /** Unique identifier — timestamp string for local items, 'remote' for MCP-sourced items. */
    id: string;
    /** The text content of the memory (e.g., "User prefers dark themes"). */
    text: string;
    /** Optional metadata attached to the memory (e.g., source, category, tags). */
    metadata?: any;
    /** Relevance score from search operations (0–N where higher = more relevant). */
    score?: number;
    /** Unix timestamp (ms) of when the memory was created. */
    timestamp: number;
}

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
export class MemoryService {
    /** MCP SDK client instance for communicating with the remote Mem0 server. Null if not connected. */
    private client: Client | null = null;
    /** The stdio transport used to communicate with the Mem0 child process. */
    private transport: StdioClientTransport | null = null;
    /** Absolute path to the local JSON memory file (fallback storage). */
    private localPath: string;
    /** In-memory array of all locally stored memories, loaded from disk at startup. */
    private localMemories: MemoryItem[] = [];

    /**
     * Creates a new MemoryService instance.
     * 
     * Computes the local storage path (`{userData}/tala_memory.json`) and
     * immediately loads any existing memories from disk into the in-memory array.
     * The MCP client is NOT connected at this point — call `ignite()` or `connect()`
     * to establish the remote connection.
     */
    constructor() {
        this.localPath = path.join(app.getPath('userData'), 'tala_memory.json');
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
    private loadLocal() {
        if (fs.existsSync(this.localPath)) {
            try {
                this.localMemories = JSON.parse(fs.readFileSync(this.localPath, 'utf-8'));
            } catch (e) {
                this.localMemories = [];
            }
        }
    }

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
    private saveLocal() {
        try {
            fs.writeFileSync(this.localPath, JSON.stringify(this.localMemories, null, 2));
        } catch (e) {
            console.error("Failed to save memory", e);
        }
    }

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
    async ignite(pythonPath: string, scriptPath: string, envVars: Record<string, string> = {}) {
        console.log(`[MemoryService] Igniting embedded Mem0 server at ${scriptPath}...`);

        const connectPromise = async () => {
            try {
                // Check if files exist
                if (!fs.existsSync(pythonPath) || !fs.existsSync(scriptPath)) {
                    console.warn(`[MemoryService] Python/Script not found for Mem0. Using local fallback.`);
                    return;
                }

                this.transport = new StdioClientTransport({
                    command: pythonPath,
                    args: [scriptPath],
                    env: { ...process.env, ...envVars, PYTHONUNBUFFERED: '1' }
                });

                const client = new Client({
                    name: "tala-memory-client",
                    version: "1.0.0"
                }, {
                    capabilities: {}
                });

                // Handle transport errors specifically
                this.transport.onerror = (err: any) => {
                    console.error(`[MemoryService] Transport Error:`, err);
                };

                console.log(`[MemoryService] Spawning: ${pythonPath} ${scriptPath}`);

                await client.connect(this.transport);
                this.client = client;
                console.log(`[MemoryService] Connected to Embedded Mem0.`);
            } catch (e) {
                console.error(`[MemoryService] Ignition failed:`, e);
                this.client = null;
            }
        };

        const timeoutPromise = new Promise<void>((resolve, reject) => {
            setTimeout(() => {
                if (!this.client) {
                    console.warn('[MemoryService] Ignition timed out (15000ms). Rejecting promise.');
                    reject(new Error("Mem0 Core ignition timed out. Server failed to start."));
                } else {
                    resolve();
                }
            }, 15000);
        });

        await Promise.race([connectPromise(), timeoutPromise]);
    }

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
    async connect(command: string, args: string[]) {
        try {
            this.transport = new StdioClientTransport({
                command,
                args
            });
            this.client = new Client({
                name: "tala-client",
                version: "1.0.0"
            }, {
                capabilities: {}
            });

            await this.client.connect(this.transport);
            console.log(`[MemoryService] Connected to MCP: ${command}`);
        } catch (e) {
            console.error(`[MemoryService] Connection failed:`, e);
        }
    }

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
    async search(query: string, limit = 5): Promise<MemoryItem[]> {
        // Preferred: MCP
        if (this.client) {
            try {
                const result = await this.client.callTool({
                    name: "mem0_search",
                    arguments: { query, limit }
                });
                // Parse JSON response from the server
                if (result && result.content && Array.isArray(result.content)) {
                    const textContent = result.content.find((c: any) => c.type === 'text');
                    if (textContent && textContent.text) {
                        try {
                            const memories = JSON.parse(textContent.text);
                            if (Array.isArray(memories)) {
                                return memories.map((m: any) => ({
                                    id: 'remote',
                                    text: m.text || String(m),
                                    timestamp: Date.now()
                                }));
                            }
                        } catch (parseError) {
                            console.warn("[Memory] Failed to parse JSON response:", parseError);
                        }
                    }
                }
            } catch (e) {
                console.warn("[Memory] Remote search failed, falling back to local.");
            }
        }

        // Fallback: Local Keyword Search (Simple)
        const terms = query.toLowerCase().split(' ').filter(t => t.length > 3);
        if (terms.length === 0) return this.localMemories.slice(-limit).reverse(); // Return latest if no terms

        const scored = this.localMemories.map(m => {
            let score = 0;
            terms.forEach(t => {
                if (m.text.toLowerCase().includes(t)) score += 1;
            });
            return { ...m, score };
        });

        return scored
            .filter(m => m.score && m.score > 0)
            .sort((a, b) => (b.score || 0) - (a.score || 0))
            .slice(0, limit);
    }

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
    async add(text: string, metadata?: any): Promise<boolean> {
        // Always save local for redundancy
        const newItem: MemoryItem = {
            id: Date.now().toString(),
            text,
            metadata,
            timestamp: Date.now()
        };
        this.localMemories.push(newItem);
        this.saveLocal();

        if (this.client) {
            try {
                await this.client.callTool({
                    name: "mem0_add",
                    arguments: { text, metadata }
                });
            } catch (e) {
                console.warn("[Memory] Remote add failed");
            }
        }
        return true;
    }
    /**
     * Retrieves all locally stored memories.
     * @returns {Promise<MemoryItem[]>} Array of all local memory items.
     */
    public async getAll(): Promise<MemoryItem[]> {
        return [...this.localMemories].sort((a, b) => b.timestamp - a.timestamp);
    }

    /**
     * Deletes a memory item by ID.
     * @param {string} id - The ID of the memory to delete.
     * @returns {Promise<boolean>} True if found and deleted, false otherwise.
     */
    public async delete(id: string): Promise<boolean> {
        const index = this.localMemories.findIndex(m => m.id === id);
        if (index !== -1) {
            this.localMemories.splice(index, 1);
            this.saveLocal();
            // TODO: Delete from remote Mem0 when API is available
            return true;
        }
        return false;
    }

    /**
     * Updates the text of a memory item.
     * @param {string} id - The ID of the memory to update.
     * @param {string} text - The new text content.
     * @returns {Promise<boolean>} True if found and updated, false otherwise.
     */
    public async update(id: string, text: string): Promise<boolean> {
        const item = this.localMemories.find(m => m.id === id);
        if (item) {
            item.text = text;
            item.timestamp = Date.now();
            this.saveLocal();
            // TODO: Update remote Mem0 when API is available
            return true;
        }
        return false;
    }

    /**
     * Prunes old memories based on TTL and max count.
     * @param ttlDays Age in days to expire.
     * @param maxItems Maximum number of items to keep.
     * @returns Number of items removed.
     */
    public async prune(ttlDays: number, maxItems: number): Promise<number> {
        const now = Date.now();
        const cutoff = now - (ttlDays * 24 * 60 * 60 * 1000);

        const initialCount = this.localMemories.length;

        // Filter by TTL
        let kept = this.localMemories.filter(m => m.timestamp >= cutoff);

        // Filter by Max Items (keep newest)
        if (kept.length > maxItems) {
            kept.sort((a, b) => b.timestamp - a.timestamp);
            kept = kept.slice(0, maxItems);
        }

        const deletedCount = initialCount - kept.length;
        if (deletedCount > 0) {
            this.localMemories = kept;
            this.saveLocal();
        }

        return deletedCount;
    }
    /**
     * Shuts down the Memory service by closing the MCP client and transport.
     * This ensures the underlying Python process is terminated.
     */
    public async shutdown(): Promise<void> {
        if (this.client) {
            try {
                await this.client.close();
                console.log('[MemoryService] Disconnected.');
            } catch (e) {
                console.error('[MemoryService] Error during shutdown:', e);
            }
            this.client = null;
        }
        if (this.transport) {
            try {
                await this.transport.close();
            } catch (e) { /* ignore */ }
            this.transport = null;
        }
    }
}
