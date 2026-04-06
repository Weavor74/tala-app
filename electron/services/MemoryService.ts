import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { RuntimeFlags } from './RuntimeFlags';
import { policyGate } from './policy/PolicyGate';

/**
 * Association
 * Represents a link between two memory items.
 */
export interface MemoryAssociation {
    target_id: string;
    type: 'related_to' | 'contradicts' | 'supersedes';
    weight: number;
}

/**
 * Represents a single memory entry stored locally or retrieved from the MCP server.
 * Memories are short-term conversational context pieces (facts, preferences,
 * decisions) that the agent can recall during interactions.
 */
export interface MemoryItem {
    /** Unique identifier — timestamp string for local items, 'remote' for MCP-sourced items. */
    id: string;
    /** The text content of the memory (e.g., "User prefers dark themes"). */
    text: string;
    /** Optional metadata attached to the memory (e.g., source, category, tags). */
    metadata?: any;
    /** Relevance score from search operations (0–N where higher = more relevant). */
    score?: number;
    /** Final composite score after reranking. */
    compositeScore?: number;
    /** Unix timestamp (ms) of when the memory was created. */
    timestamp: number;

    // --- ENRICHED METADATA (PHASE 1) ---
    salience: number;           // 0.0 - 1.0 (importance)
    confidence: number;         // 0.0 - 1.0 (trustworthiness)
    created_at: number;         // Unix timestamp
    last_accessed_at: number | null;
    last_reinforced_at: number | null;
    access_count: number;
    associations: MemoryAssociation[];
    status: 'active' | 'contested' | 'superseded' | 'archived';
}

/**
 * Fact-Based Conversational Memory Engine.
 * 
 * The `MemoryService` provides episodic and semantic memory for the agent, 
 * specializing in short-term facts, preferences, and state. It implements 
 * a high-reliability dual-storage strategy.
 * 
 * **Architecture:**
 * - **Primary (Remote)**: Mem0 MCP server (`mem0-core/server.py`) for AI-powered 
 *   extraction and graph-based relationships.
 * - **Fallback (Local)**: Synchronous JSON persistence at `tala_memory.json` 
 *   for instant recovery and redundancy.
 * 
 * **Key Features:**
 * - **Composite Scoring**: Reranks memories using semantic similarity, 
 *   salience, recency, and confidence.
 * - **Contradiction Detection**: Automatically marks old facts as contested 
 *   or superseded when new information conflicts.
 * - **Association Expansion**: Performs one-hop graph walks to retrieve 
 *   contextually related memories.
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
     * Returns true when the MCP client is connected to the mem0-core server.
     * Used by AgentService.getStartupStatus() to surface real mem0 readiness.
     */
    public getReadyStatus(): boolean { return this.client !== null; }

    // --- SCORING CONSTANTS (PHASE 2) ---
    private static readonly WEIGHT_SEMANTIC = 0.35;
    private static readonly WEIGHT_SALIENCE = 0.25;
    private static readonly WEIGHT_RECENCY = 0.15;
    private static readonly WEIGHT_CONFIDENCE = 0.15;
    private static readonly WEIGHT_ASSOCIATION = 0.10;
    private static readonly RECENCY_DECAY_LAMBDA = 0.05; // ~14 day half-life

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
                const raw = JSON.parse(fs.readFileSync(this.localPath, 'utf-8'));
                if (Array.isArray(raw)) {
                    this.localMemories = raw.map(m => this.normalizeMemory(m));
                }
            } catch (e) {
                console.error("[Memory] Failed to load local memories", e);
                this.localMemories = [];
            }
        }
    }

    /**
     * Normalizes a memory item to ensure it has all required metadata fields.
     * This handles migration of legacy memories.
     */
    private normalizeMemory(m: any): MemoryItem {
        const metadata = m.metadata || {};

        // 1. Canonical Source Normalization
        let source = metadata.source || 'explicit';
        if (source === 'conversation' || source === 'chat') source = 'explicit';
        if (!['rag', 'mem0', 'explicit', 'astro', 'graph', 'core'].includes(source)) {
            source = 'explicit';
        }

        // 2. Canonical Role/Scope Normalization
        let role = metadata.role || 'core';
        if (role === 'system') role = 'core';

        const finalMetadata = { ...metadata, source, role };

        return {
            id: m.id || Date.now().toString(),
            text: m.text || "",
            metadata: finalMetadata,
            score: m.score,
            timestamp: m.timestamp || Date.now(),
            salience: m.salience ?? 0.5,
            confidence: m.confidence ?? (finalMetadata.source === 'explicit' ? 0.9 : 0.7),
            created_at: m.created_at || m.timestamp || Date.now(),
            last_accessed_at: m.last_accessed_at ?? null,
            last_reinforced_at: m.last_reinforced_at ?? (m.created_at || m.timestamp || Date.now()),
            access_count: m.access_count ?? 0,
            associations: Array.isArray(m.associations) ? m.associations : [],
            status: m.status || 'active'
        };
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
        if (!RuntimeFlags.ENABLE_MEM0_REMOTE) {
            console.log(`[MemoryService] Remote mem0 is DISABLED via feature flag. Skipping ignition.`);
            return;
        }
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

        // Resolve (not reject) on timeout so igniteSoul() is not hard-aborted.
        // A late-connecting mem0 server (e.g. waiting for Ollama model warmup) can
        // still complete in the background and set this.client, after which
        // getReadyStatus() will return true. This matches AstroService semantics.
        const timeoutPromise = new Promise<void>((resolve) => {
            setTimeout(() => {
                if (!this.client) {
                    console.warn('[MemoryService] Ignition timed out (15000ms). Proceeding in background.');
                }
                resolve();
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
    async search(query: string, limit = 5, mode: string = 'assistant'): Promise<MemoryItem[]> {
        // Preferred: MCP
        if (this.client && RuntimeFlags.ENABLE_MEM0_REMOTE && !RuntimeFlags.ENABLE_PG_CANONICAL_ONLY) {
            try {
                const result = await this.client.callTool({
                    name: "mem0_search",
                    arguments: { query, limit, filters: mode === 'rp' ? { role: 'rp' } : { role: 'core' } }
                });

                if (result && result.content && Array.isArray(result.content)) {
                    const textContent = result.content.find((c: any) => c.type === 'text');
                    if (textContent && textContent.text) {
                        try {
                            const parsed = JSON.parse(textContent.text);
                            
                            // Check for remote error object
                            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error) {
                                console.warn(`[Memory] Remote search returned error: ${parsed.error}. Falling back to local.`);
                            } else if (Array.isArray(parsed)) {
                                // Map remote results to normalized MemoryItems
                                return parsed.map((m: any) => this.normalizeMemory({
                                    id: m.id || 'remote',
                                    text: m.text || String(m),
                                    timestamp: Date.now(),
                                    score: m.score,
                                    metadata: m.metadata || {}
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
        let filteredMemories = this.localMemories;
        if (mode === 'rp') {
            filteredMemories = filteredMemories.filter(m => m.metadata?.role === 'rp');
        } else {
            // Core modes (assistant/hybrid) only see core memories
            filteredMemories = filteredMemories.filter(m => m.metadata?.role !== 'rp');
        }

        const terms = query.toLowerCase().split(' ').filter(t => t.length > 3);
        if (terms.length === 0) return filteredMemories.slice(-limit).reverse(); // Return latest if no terms

        const scored = filteredMemories.map(m => {
            let semanticScore = 0;
            terms.forEach(t => {
                if (m.text.toLowerCase().includes(t)) semanticScore += 1;
            });
            const normalizedSemantic = Math.min(semanticScore / terms.length, 1.0);
            return { m, normalizedSemantic };
        });

        // Get top direct hits
        const topDirect = scored
            .sort((a, b) => b.normalizedSemantic - a.normalizedSemantic)
            .slice(0, 5);

        // Expand associations
        const expanded = this.expandAssociations(topDirect.map(d => d.m));

        // Combine and dedup
        const combined = [...topDirect.map(d => ({ item: d.m, semantic: d.normalizedSemantic, boost: 0 }))];
        expanded.forEach(e => {
            if (!combined.find(c => c.item.id === e.item.id)) {
                combined.push({ item: e.item, semantic: 0, boost: e.weight });
            }
        });

        const reranked = combined.map(c => {
            const compositeResult = this.calculateCompositeScore(c.item, c.semantic, c.boost);
            return {
                ...c.item,
                compositeScore: compositeResult.final_score,
                audit: compositeResult
            };
        });

        const results = reranked
            .filter(m => m.compositeScore && m.compositeScore > 0.1)
            .sort((a, b) => (b.compositeScore || 0) - (a.compositeScore || 0))
            .slice(0, limit);

        // Update Access Metadata
        results.forEach(m => {
            m.last_accessed_at = Date.now();
            m.access_count++;
            console.log(`[MemoryAudit] id=${m.id} text="${m.text.substring(0, 30)}..." score=${m.compositeScore?.toFixed(3)} (sem:${m.audit?.semantic_similarity.toFixed(2)} sal:${m.audit?.salience_component.toFixed(2)} rec:${m.audit?.recency_component.toFixed(2)} conf:${m.audit?.confidence_component.toFixed(2)} assoc:${m.audit?.association_component.toFixed(2)})`);
        });

        return results;
    }

    /**
     * Expands a set of memories by one-hop associations.
     */
    private expandAssociations(seeds: MemoryItem[]): { item: MemoryItem, weight: number }[] {
        const expanded: { item: MemoryItem, weight: number }[] = [];
        const THRESHOLD = 0.3;

        seeds.forEach(seed => {
            seed.associations.forEach(assoc => {
                if (assoc.weight >= THRESHOLD) {
                    const target = this.localMemories.find(m => m.id === assoc.target_id);
                    if (target) {
                        expanded.push({ item: target, weight: assoc.weight });
                    }
                }
            });
        });
        return expanded;
    }

    private calculateCompositeScore(item: MemoryItem, semanticSimilarity: number, associationBoost: number = 0) {
        const salienceComp = item.salience * MemoryService.WEIGHT_SALIENCE;
        const confidenceComp = item.confidence * MemoryService.WEIGHT_CONFIDENCE;

        const recencyScore = this.calculateRecencyScore(item);
        const recencyComp = recencyScore * MemoryService.WEIGHT_RECENCY;

        const associationComp = associationBoost * MemoryService.WEIGHT_ASSOCIATION;

        const semanticComp = semanticSimilarity * MemoryService.WEIGHT_SEMANTIC;

        let finalScore = semanticComp + salienceComp + recencyComp + confidenceComp + associationComp;

        // Status Penalties
        let statusPenalty = 0;
        if (item.status === 'contested') statusPenalty = 0.3;
        if (item.status === 'superseded' || item.status === 'archived') statusPenalty = 0.8;

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
    }

    /**
     * Calculates recency score using exponential decay.
     */
    private calculateRecencyScore(item: MemoryItem): number {
        const now = Date.now();
        const referenceTime = item.last_reinforced_at || item.last_accessed_at || item.created_at;
        const diffDays = (now - referenceTime) / (1000 * 60 * 60 * 24);
        return Math.exp(-MemoryService.RECENCY_DECAY_LAMBDA * diffDays);
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
    async add(text: string, metadata: any = {}, mode: string = 'assistant'): Promise<boolean> {
        // P7A derived write guard: every durable write should carry canonical_memory_id.
        // MemoryService is a derived system (mem0 abstraction + local JSON). Any durable
        // write without a canonical_memory_id is a P7A violation — warn (or throw in strict mode).
        if (!metadata.canonical_memory_id) {
            const source = metadata.source ?? 'unknown';
            const message =
                `[P7A][MemoryService] Derived write without canonical_memory_id (source="${source}"). ` +
                `Ensure MemoryAuthorityService.createCanonicalMemory() is called first and its ID ` +
                `is passed as canonical_memory_id in metadata.`;
            if (process.env.NODE_ENV === 'test' && process.env.TALA_STRICT_MEMORY === '1') {
                throw new Error(message);
            }
            console.warn(message);
        }
        const role = mode === 'rp' ? 'rp' : 'core';
        const finalMetadata = { ...metadata, role };

        // --- POLICY GATE: memory write pre-check ---
        // Fires before any local or remote write mutation.
        // PolicyDeniedError propagates to the caller; no writes occur on block.
        policyGate.assertSideEffect({
            actionKind: 'memory_write',
            executionMode: mode,
            targetSubsystem: 'MemoryService',
            mutationIntent: 'mem0 write',
        });

        const now = Date.now();
        const newItem: MemoryItem = {
            id: now.toString(),
            text,
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
        await this.handleContradiction(newItem);
        this.saveLocal();

        if (this.client && RuntimeFlags.ENABLE_MEM0_REMOTE) {
            try {
                const result = await this.client.callTool({
                    name: "mem0_add",
                    arguments: { text, metadata: finalMetadata }
                });
                if (result && result.content && Array.isArray(result.content)) {
                    const textContent = result.content.find((c: any) => c.type === 'text');
                    if (textContent && textContent.text) {
                        try {
                            const parsed = JSON.parse(textContent.text);
                            if (parsed.error) {
                                console.warn(`[Memory] Remote add reported error: ${parsed.error}`);
                            }
                        } catch (e) {
                            // Non-JSON response (legacy compat), ignore
                        }
                    }
                }
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
            item.last_reinforced_at = Date.now();
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

    /**
     * Detects and handles contradictions when a new memory is added.
     */
    private async handleContradiction(newItem: MemoryItem) {
        // Simple heuristic: find memories with high keyword overlap
        const terms = newItem.text.toLowerCase().split(' ').filter(t => t.length > 3);
        if (terms.length < 2) return;

        const candidates = this.localMemories.filter(m => m.id !== newItem.id && m.status === 'active');

        for (const candidate of candidates) {
            let overlap = 0;
            terms.forEach(t => {
                if (candidate.text.toLowerCase().includes(t)) overlap++;
            });

            // If overlap is high (e.g. 70%), assume it might talk about the same subject
            if (overlap / terms.length >= 0.7) {
                const newIsExplicit = newItem.metadata?.source === 'explicit';
                const oldIsExplicit = candidate.metadata?.source === 'explicit';

                if (newIsExplicit && !oldIsExplicit) {
                    candidate.status = 'superseded';
                    newItem.associations.push({ target_id: candidate.id, type: 'supersedes', weight: 1.0 });
                } else {
                    candidate.status = 'contested';
                    newItem.associations.push({ target_id: candidate.id, type: 'contradicts', weight: 0.8 });
                    candidate.associations.push({ target_id: newItem.id, type: 'contradicts', weight: 0.8 });
                }
            }
        }
    }
}
