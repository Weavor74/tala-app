import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
import path from 'path';
import { RuntimeFlags } from './RuntimeFlags';
import { policyGate } from './policy/PolicyGate';
import type { MemoryRuntimeResolution } from '../../shared/memory/MemoryRuntimeResolution';
import { MemoryIntegrityPolicy } from './memory/MemoryIntegrityPolicy';
import { MemoryRepairTriggerService } from './memory/MemoryRepairTriggerService';
import type { MemoryHealthStatus, MemoryHealthTransition, MemoryIntegrityMode } from '../../shared/memory/MemoryHealthStatus';
import { TelemetryBus } from './telemetry/TelemetryBus';
import { resolveStoragePath } from './PathResolver';

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
    private static readonly UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    /** MCP SDK client instance for communicating with the remote Mem0 server. Null if not connected. */
    private client: Client | null = null;
    /** The stdio transport used to communicate with the Mem0 child process. */
    private transport: StdioClientTransport | null = null;
    /** Absolute path to the local JSON memory file (fallback storage). */
    private localPath: string;
    /** In-memory array of all locally stored memories, loaded from disk at startup. */
    private localMemories: MemoryItem[] = [];
    /** Last resolved memory runtime configuration (set during ignite()). */
    private _resolvedMemoryConfig: MemoryRuntimeResolution | null = null;
    /**
     * Mutable tracked state managed by _setIfChanged.
     * These fields are the single source of truth for subsystem flags that
     * participate in change-detection (canonicalReady, ragAvailable,
     * integrityMode).  Reading or writing them via the helper keeps the
     * logic type-safe without indexing `this` with a generic key.
     */
    private _trackedState = {
        canonicalReady: false,
        ragAvailable: false,
        integrityMode: 'balanced' as MemoryIntegrityMode,
    };
    /** Whether the graph projection service is available. Updated externally. */
    private _graphAvailable: boolean = false;

    // ── Health-status cache (avoids redundant per-turn recomputation) ────────
    /** Short-lived cache of the last evaluated health status. */
    private _lastHealthStatus: MemoryHealthStatus | null = null;
    /** Timestamp (ms) of the last cache population. */
    private _lastHealthEvalTs: number = 0;
    /** Maximum age of a cached status before forced recomputation. */
    private static readonly HEALTH_STATUS_TTL_MS = 1000;

    // ── Transition tracking ──────────────────────────────────────────────────
    /** State from the previous health evaluation (undefined before first evaluation). */
    private _lastKnownState: MemoryHealthStatus['state'] | undefined;
    /** Mode from the previous health evaluation. */
    private _lastKnownMode: MemoryHealthStatus['mode'] | undefined;

    // ── Deferred-work backlog counters ───────────────────────────────────────
    /** Pending extraction tasks awaiting retry when subsystem recovers. */
    private _pendingExtractionCount: number = 0;
    /** Pending embedding tasks awaiting retry when subsystem recovers. */
    private _pendingEmbeddingCount: number = 0;
    /** Pending graph-projection tasks awaiting retry when subsystem recovers. */
    private _pendingProjectionCount: number = 0;

    private static readonly MEMORY_BACKLOG_WARNING_THRESHOLD = 250;
    private static readonly MEMORY_BACKLOG_ERROR_THRESHOLD = 1000;

    /**
     * Returns true when the MCP client is connected to the mem0-core server.
     * Used by AgentService.getStartupStatus() to surface real mem0 readiness.
     */
    public getReadyStatus(): boolean { return this.client !== null; }

    /**
     * Notifies MemoryService of external subsystem availability so that
     * getHealthStatus() can produce an accurate evaluation.
     *
     * Call this from AgentService after startup or whenever the state of any
     * of these subsystems changes.
     *
     * Invalidates the cached health status so the next call to getHealthStatus()
     * reflects the new availability.
     */
    public setSubsystemAvailability(opts: {
        canonicalReady?: boolean;
        ragAvailable?: boolean;
        graphAvailable?: boolean;
        integrityMode?: MemoryIntegrityMode;
    }): void {
        let changed = false;
        if (this._setIfChanged('canonicalReady', opts.canonicalReady)) changed = true;
        if (this._setIfChanged('ragAvailable', opts.ragAvailable)) changed = true;
        if (opts.graphAvailable !== undefined && opts.graphAvailable !== this._graphAvailable) {
            console.log(`[MemoryService] graphProjection availability changed: ${this._graphAvailable} -> ${opts.graphAvailable}`);
            this._graphAvailable = opts.graphAvailable;
            changed = true;
        }
        if (this._setIfChanged('integrityMode', opts.integrityMode)) changed = true;
        if (changed) {
            this._invalidateHealthCache('subsystem_availability_changed');
        }
    }

    /**
     * Updates the resolved memory runtime configuration used by getHealthStatus()
     * to evaluate extraction and embeddings provider availability.
     *
     * Call this from a repair handler after re-running MemoryProviderResolver so
     * that the health evaluation reflects the freshly resolved provider state.
     * Automatically invalidates the health cache.
     */
    public setResolvedMemoryConfig(config: MemoryRuntimeResolution): void {
        this._resolvedMemoryConfig = config;
        this._invalidateHealthCache('resolved_config_changed');
    }

    /** Updates a tracked-state field only if the new value differs. Returns true when changed. */
    private _setIfChanged<K extends keyof typeof this._trackedState>(
        key: K,
        value: (typeof this._trackedState)[K] | undefined,
    ): boolean {
        if (value !== undefined && value !== this._trackedState[key]) {
            this._trackedState[key] = value;
            return true;
        }
        return false;
    }

    /**
     * Returns a structured MemoryHealthStatus by evaluating all memory
     * subsystem components via MemoryIntegrityPolicy.
     *
     * Results are cached for HEALTH_STATUS_TTL_MS to avoid redundant
     * recomputation on every turn.  The cache is automatically invalidated
     * whenever subsystem availability, integrity mode, or resolved config
     * changes.
     *
     * This is the single source of truth for memory runtime health.
     * AgentService must call this before gating memory retrieval or writes.
     */
    public getHealthStatus(): MemoryHealthStatus {
        const now = Date.now();
        if (
            this._lastHealthStatus !== null &&
            now - this._lastHealthEvalTs < MemoryService.HEALTH_STATUS_TTL_MS
        ) {
            return this._lastHealthStatus;
        }

        const status = MemoryIntegrityPolicy.evaluate({
            canonicalReady: this._trackedState.canonicalReady,
            mem0Ready: this.client !== null,
            resolvedMode: this._resolvedMemoryConfig?.mode,
            extractionEnabled: this._resolvedMemoryConfig?.extraction.enabled ?? false,
            embeddingsEnabled: this._resolvedMemoryConfig?.embeddings.enabled ?? false,
            graphAvailable: this._graphAvailable,
            ragAvailable: this._trackedState.ragAvailable,
            integrityMode: this._trackedState.integrityMode,
        });

        // ── Cache the result ─────────────────────────────────────────────────
        this._lastHealthStatus = status;
        this._lastHealthEvalTs = now;

        // ── Emit telemetry event for observability ───────────────────────────
        TelemetryBus.getInstance().emit({
            event: 'memory.health_evaluated',
            subsystem: 'memory',
            executionId: 'memory-health',
            payload: {
                state: status.state,
                mode: status.mode,
                hardDisabled: status.hardDisabled,
                shouldTriggerRepair: status.shouldTriggerRepair,
                reasons: status.reasons,
                summary: status.summary,
            },
        });

        // ── Track health state transitions ────────────────────────────────────
        this._trackTransition(status);

        // ── Trigger repair if warranted ───────────────────────────────────────
        MemoryRepairTriggerService.getInstance().maybeEmit(status);

        return status;
    }

    /**
     * Increments the deferred-work backlog counters for the specified work
     * types, then evaluates whether any threshold is breached and emits a
     * repair trigger if so.
     *
     * These counters serve as in-memory approximations for threshold checks.
     * The persistent source of truth lives in the deferred_memory_work table
     * via DeferredMemoryReplayService.
     *
     * Call this from extraction/embedding/projection paths whenever a task
     * must be deferred because the relevant subsystem is unavailable.
     */
    public trackDeferredWork(opts: {
        extraction?: number;
        embedding?: number;
        projection?: number;
    }): void {
        if (opts.extraction) this._pendingExtractionCount += opts.extraction;
        if (opts.embedding) this._pendingEmbeddingCount += opts.embedding;
        if (opts.projection) this._pendingProjectionCount += opts.projection;
        this._checkBacklogThresholds();
    }

    /**
     * Resets the deferred-work backlog counters (e.g. when the subsystem
     * recovers and deferred work has been processed).
     */
    public resetDeferredWork(opts: { extraction?: boolean; embedding?: boolean; projection?: boolean } = {}): void {
        if (opts.extraction) this._pendingExtractionCount = 0;
        if (opts.embedding) this._pendingEmbeddingCount = 0;
        if (opts.projection) this._pendingProjectionCount = 0;
    }

    /** Returns a snapshot of the current deferred-work backlog counts. */
    public getDeferredWorkCounts(): { extraction: number; embedding: number; projection: number } {
        return {
            extraction: this._pendingExtractionCount,
            embedding: this._pendingEmbeddingCount,
            projection: this._pendingProjectionCount,
        };
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private _invalidateHealthCache(reason: string): void {
        if (this._lastHealthStatus !== null) {
            console.log(`[MemoryService] memory health cache invalidated reason=${reason}`);
        }
        this._lastHealthStatus = null;
        this._lastHealthEvalTs = 0;
    }

    private _trackTransition(status: MemoryHealthStatus): void {
        const prevState = this._lastKnownState;
        const prevMode = this._lastKnownMode;

        const stateChanged = prevState !== undefined && prevState !== status.state;
        const modeChanged = prevMode !== undefined && prevMode !== status.mode;

        if (stateChanged || modeChanged) {
            const fromState = prevState ?? status.state;
            const fromMode = prevMode ?? status.mode;

            const transition: MemoryHealthTransition = {
                fromState,
                toState: status.state,
                fromMode,
                toMode: status.mode,
                reasons: status.reasons,
                at: status.evaluatedAt,
            };

            console.log(
                `[MemoryService] memory health transition ${transition.fromState} -> ${transition.toState}` +
                ` mode ${transition.fromMode} -> ${transition.toMode}`,
            );

            TelemetryBus.getInstance().emit({
                event: 'memory.health_transition',
                subsystem: 'memory',
                executionId: 'memory-health',
                payload: transition as unknown as Record<string, unknown>,
            });
        }

        this._lastKnownState = status.state;
        this._lastKnownMode = status.mode;
    }

    private _checkBacklogThresholds(): void {
        const repair = MemoryRepairTriggerService.getInstance();
        const counts = {
            pendingExtraction: this._pendingExtractionCount,
            pendingEmbedding: this._pendingEmbeddingCount,
            pendingProjection: this._pendingProjectionCount,
        };

        const max = Math.max(
            this._pendingExtractionCount,
            this._pendingEmbeddingCount,
            this._pendingProjectionCount,
        );

        if (max >= MemoryService.MEMORY_BACKLOG_ERROR_THRESHOLD) {
            repair.emitDirect('unknown', 'degraded', 'critical', {
                message: 'Deferred work backlog exceeded error threshold',
                threshold: MemoryService.MEMORY_BACKLOG_ERROR_THRESHOLD,
                ...counts,
            });
        } else if (max >= MemoryService.MEMORY_BACKLOG_WARNING_THRESHOLD) {
            repair.emitDirect('unknown', 'degraded', 'warning', {
                message: 'Deferred work backlog exceeded warning threshold',
                threshold: MemoryService.MEMORY_BACKLOG_WARNING_THRESHOLD,
                ...counts,
            });
        }
    }

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
        this.localPath = resolveStoragePath(path.join('memory', 'tala_memory.json'));
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

        const canonicalIdFromMetadata = typeof metadata.canonical_memory_id === 'string' ? metadata.canonical_memory_id : null;
        const canonicalIdFromRecordId = typeof m.id === 'string' && MemoryService.UUID_RE.test(m.id) ? m.id : null;
        const canonicalMemoryId = canonicalIdFromMetadata ?? canonicalIdFromRecordId;

        const finalMetadata = {
            ...metadata,
            source,
            role,
            canonical_memory_id: canonicalMemoryId,
        };

        return {
            id: canonicalMemoryId || m.id || Date.now().toString(),
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

    private hasCanonicalMemoryAnchor(memory: Pick<MemoryItem, 'metadata'>): boolean {
        const canonicalId = memory.metadata?.canonical_memory_id;
        return typeof canonicalId === 'string' && MemoryService.UUID_RE.test(canonicalId);
    }

    private filterCanonicalBackedMemories(memories: MemoryItem[], source: string): MemoryItem[] {
        const canonicalBacked = memories.filter(memory => this.hasCanonicalMemoryAnchor(memory));
        const dropped = memories.length - canonicalBacked.length;
        if (dropped > 0) {
            console.warn(
                `[MemoryService] Suppressed ${dropped} non-canonical derived memory item(s) from ${source}.`,
            );
        }
        return canonicalBacked;
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
     * @param {Record<string, string>} envVars - Additional environment variables.
     * @param {MemoryRuntimeResolution} [resolvedConfig] - Pre-resolved memory runtime
     *   configuration from MemoryProviderResolver.  When provided, this is serialised
     *   to a temp file and injected into mem0-core via TALA_MEMORY_RUNTIME_CONFIG_PATH,
     *   replacing mem0-core's own startup probing logic.
     * @returns {Promise<void>}
     */
    async ignite(pythonPath: string, scriptPath: string, envVars: Record<string, string> = {}, resolvedConfig?: MemoryRuntimeResolution) {
        if (!RuntimeFlags.ENABLE_MEM0_REMOTE) {
            console.log(`[MemoryService] Remote mem0 is DISABLED via feature flag. Skipping ignition.`);
            return;
        }
        console.log(`[MemoryService] Igniting embedded Mem0 server at ${scriptPath}...`);

        // Store resolved config so getHealthStatus() can use it
        if (resolvedConfig) {
            this._resolvedMemoryConfig = resolvedConfig;
            this._invalidateHealthCache('resolved_config_changed');
        }

        // --- Inject Tala-resolved memory runtime config ---
        // Write the resolved config to a temp file and pass its path via env var so
        // mem0-core no longer needs to probe inference backends on its own.
        const runtimeEnv: Record<string, string> = { ...envVars };
        if (resolvedConfig) {
            console.log(`[MemoryService] Resolved memory runtime mode: ${resolvedConfig.mode}`);
            if (resolvedConfig.extraction.enabled) {
                console.log(`[MemoryService] Extraction provider: ${resolvedConfig.extraction.providerType}${resolvedConfig.extraction.model ? ' / ' + resolvedConfig.extraction.model : ''}`);
            } else {
                console.log(`[MemoryService] Extraction provider: none (${resolvedConfig.extraction.reason})`);
            }
            if (resolvedConfig.embeddings.enabled) {
                console.log(`[MemoryService] Embedding provider: ${resolvedConfig.embeddings.providerType}${resolvedConfig.embeddings.model ? ' / ' + resolvedConfig.embeddings.model : ''}`);
            } else {
                console.log(`[MemoryService] Embedding provider: none (${resolvedConfig.embeddings.reason})`);
            }
            console.log(`[MemoryService] Launching mem0-core with Tala-injected memory runtime config`);

            try {
                const configPath = resolveStoragePath(path.join('temp', `tala_memory_runtime_${Date.now()}.json`));
                const configDir = path.dirname(configPath);
                if (!fs.existsSync(configDir)) {
                    fs.mkdirSync(configDir, { recursive: true });
                }
                fs.writeFileSync(configPath, JSON.stringify(resolvedConfig, null, 2), 'utf-8');
                runtimeEnv['TALA_MEMORY_RUNTIME_CONFIG_PATH'] = configPath;
            } catch (writeErr) {
                console.warn('[MemoryService] Failed to write memory runtime config file; mem0-core will use fallback resolution.', writeErr);
            }
        } else {
            console.log(`[MemoryService] No resolved memory runtime config provided; mem0-core will resolve independently.`);
        }

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
                    env: { ...process.env, ...runtimeEnv, PYTHONUNBUFFERED: '1' }
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
                                const normalized = parsed.map((m: any) => this.normalizeMemory({
                                    id: m.id || 'remote',
                                    text: m.text || String(m),
                                    timestamp: Date.now(),
                                    score: m.score,
                                    metadata: m.metadata || {}
                                }));
                                return this.filterCanonicalBackedMemories(normalized, 'mem0_search');
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
        filteredMemories = this.filterCanonicalBackedMemories(filteredMemories, 'local_memory_store');

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
        // MemoryAuthority invariant: derived durable writes MUST be anchored to canonical IDs.
        if (!metadata.canonical_memory_id || !MemoryService.UUID_RE.test(String(metadata.canonical_memory_id))) {
            const source = metadata.source ?? 'unknown';
            const message =
                `[P7A][MemoryService] Derived write without canonical_memory_id (source="${source}"). ` +
                `Ensure tryCreateCanonicalMemory() or createMemory() is called first and its ID ` +
                `is passed as canonical_memory_id in metadata.`;
            throw new Error(message);
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
            mutationIntent: 'derived_memory_write',
        });

        const now = Date.now();
        const newItem: MemoryItem = {
            id: String(metadata.canonical_memory_id),
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
        return this.filterCanonicalBackedMemories([...this.localMemories], 'getAll').sort((a, b) => b.timestamp - a.timestamp);
    }

    /**
     * Deletes a memory item by ID.
     * @param {string} id - The ID of the memory to delete.
     * @returns {Promise<boolean>} True if found and deleted, false otherwise.
     */
    public async delete(id: string): Promise<boolean> {
        return this.deleteByCanonicalMemoryId(id);
    }

    public async deleteByCanonicalMemoryId(canonicalMemoryId: string): Promise<boolean> {
        const index = this.localMemories.findIndex(
            memory => memory.metadata?.canonical_memory_id === canonicalMemoryId || memory.id === canonicalMemoryId,
        );
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
        return this.updateByCanonicalMemoryId(id, text);
    }

    public async updateByCanonicalMemoryId(canonicalMemoryId: string, text: string): Promise<boolean> {
        const item = this.localMemories.find(
            memory => memory.metadata?.canonical_memory_id === canonicalMemoryId || memory.id === canonicalMemoryId,
        );
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

