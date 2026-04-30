import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'fs';
import * as path from 'path';
import { LogViewerService } from './LogViewerService';
import type { RagStartupResult, ServiceStartupState } from '../../shared/ragStartupTypes';

export type RagReadinessReasonCode =
    | 'process_not_ready'
    | 'client_not_connected'
    | 'tools_not_listed'
    | 'search_unavailable'
    | 'call_tool_failed';

export interface RagReadinessSnapshot {
    processReady: boolean;
    clientConnected: boolean;
    toolsListed: boolean;
    searchable: boolean;
    startupState: ServiceStartupState;
}

export interface RagStructuredSearchResult {
    status: 'ok' | 'degraded' | 'error';
    reasonCode?: RagReadinessReasonCode;
    reason?: string;
    results: Array<{ text: string; score: number; docId?: string; metadata?: Record<string, unknown> }>;
}

/**
 * Long-Term Narrative Memory Engine (RAG).
 * 
 * The `RagService` manages the connection to the Tala Core RAG MCP server, 
 * providing a high-capacity vector store for document-based retrieval. 
 * It is responsible for bridging the Electron main process with the Python-based 
 * ChromaDB backend.
 * 
 * **How it differs from MemoryService:**
 * - **RagService**: Large-scale, document-based narrative memory (ChromaDB). 
 *   Ideal for codebases, books, and logs.
 * - **MemoryService**: High-precision, fact-based conversational memory (Mem0). 
 *   Ideal for user preferences, names, and recent decisions.
 * 
 * **Core Responsibilities:**
 * - **MCP Orchestration**: Spawns and manages the `tala-core` Python process.
 * - **Vector Retrieval**: Provides semantic search capabilities for agent grounding.
 * - **Lifecycle Management**: Handles startup (`ignite`), search, and cleanup (`shutdown`).
 */
export class RagService {
    /** MCP SDK client for communicating with the tala-core RAG server. Null if not connected. */
    private client: Client | null = null;
    /** Whether the MCP client is connected and has been verified with `listTools()`. */
    private isReady = false;
    private processReady = false;
    private clientConnected = false;
    private toolsListed = false;
    private startupState: ServiceStartupState = 'not_started';
    private lastStartupResult: RagStartupResult | null = null;
    private startupInFlight: Promise<RagStartupResult> | null = null;
    private logViewerService: LogViewerService | null = null;

    /**
     * Spawns the Tala Core RAG MCP server and connects to it via stdio transport.
     * 
     * Unlike AstroService, this method does NOT spawn a separate debug process.
     * The `StdioClientTransport` owns the stdio stream. If the server writes logs
     * to stderr, they'll appear in the parent Electron process console.
     * 
     * After connecting, immediately calls `listTools()` to verify the connection
     * is alive and the server is responding to MCP requests.
     * 
     * Failures are caught and logged but NOT re-thrown. The service will remain
     * offline (`isReady = false`) and all subsequent calls will return empty results.
     * 
     * @param {string} pythonPath - Absolute path to the Python executable
     *   (typically from the project's venv).
     * @param {string} scriptPath - Absolute path to `mcp-servers/tala-core/server.py`.
     * @param {Record<string, string>} [envVars={}] - Additional environment variables
     *   to pass to the Python process (e.g., API keys from `.env`).
     * @returns {Promise<void>}
     */
    async ignite(
        pythonPath: string,
        scriptPath: string,
        envVars: Record<string, string> = {},
        options: { startupTimeoutMs?: number; slowStartGraceMs?: number } = {},
    ): Promise<RagStartupResult> {
        if (this.startupInFlight) {
            return this.startupInFlight;
        }

        const startupTimeoutMs = options.startupTimeoutMs ?? 15000;
        const slowStartGraceMs = options.slowStartGraceMs ?? 15000;

        const startupPromise = this.runIgnitionAttempt(
            pythonPath,
            scriptPath,
            envVars,
            startupTimeoutMs,
            slowStartGraceMs,
        );
        this.startupInFlight = startupPromise;

        try {
            return await startupPromise;
        } finally {
            this.startupInFlight = null;
        }
    }

    private async runIgnitionAttempt(
        pythonPath: string,
        scriptPath: string,
        envVars: Record<string, string>,
        startupTimeoutMs: number,
        slowStartGraceMs: number,
    ): Promise<RagStartupResult> {
        console.log(`[RagService] Igniting RAG Core at ${scriptPath}...`);

        this.isReady = false;
        this.processReady = false;
        this.clientConnected = false;
        this.toolsListed = false;
        this.client = null;
        this.updateStartupState('starting', 'startup_initiated');

        const startedAt = Date.now();
        let enteredSlowStart = false;

        const connectionAttempt = this.establishConnection(pythonPath, scriptPath, envVars)
            .then((client) => ({ ok: true as const, client }))
            .catch((error: unknown) => ({ ok: false as const, error }));

        const phaseOne = await Promise.race([
            connectionAttempt,
            this.delay(startupTimeoutMs).then(() => null),
        ]);

        if (phaseOne !== null) {
            return this.resolveConnectionOutcome(phaseOne, startedAt, enteredSlowStart);
        }

        enteredSlowStart = true;
        this.updateStartupState('slow_start', 'startup_timeout_entered_grace');
        console.warn(
            `[RagService] Cold start exceeded normal window (${startupTimeoutMs}ms) but readiness may still be in-flight; entering slow_start grace period (${slowStartGraceMs}ms).`,
        );

        const phaseTwo = await Promise.race([
            connectionAttempt,
            this.delay(slowStartGraceMs).then(() => null),
        ]);

        if (phaseTwo !== null) {
            return this.resolveConnectionOutcome(phaseTwo, startedAt, enteredSlowStart);
        }

        const degradedElapsed = Date.now() - startedAt;
        const degradedResult: RagStartupResult = {
            state: 'degraded',
            reason: 'startup_grace_window_exhausted',
            elapsedMs: degradedElapsed,
            processAlive: true,
            readySignalObserved: false,
        };
        this.lastStartupResult = degradedResult;
        this.updateStartupState('degraded', degradedResult.reason);

        console.warn(
            `[RagService] RAG Core still not ready after ${degradedElapsed}ms (normal=${startupTimeoutMs}ms + grace=${slowStartGraceMs}ms). Marking degraded while connection remains in-flight.`,
        );

        void connectionAttempt.then((lateOutcome) => {
            const lateElapsed = Date.now() - startedAt;
            if (lateOutcome.ok) {
                this.client = lateOutcome.client;
                this.clientConnected = true;
                this.toolsListed = true;
                this.processReady = true;
                this.isReady = true;
                const lateReady: RagStartupResult = {
                    state: 'ready',
                    reason: 'late_ready_after_degraded',
                    elapsedMs: lateElapsed,
                    processAlive: true,
                    readySignalObserved: true,
                };
                this.lastStartupResult = lateReady;
                this.updateStartupState('ready', lateReady.reason);
                console.log(
                    `[RagService] RAG Core ready after ${lateElapsed}ms (degraded-to-ready recovery).`,
                );
                return;
            }

            const message = lateOutcome.error instanceof Error ? lateOutcome.error.message : String(lateOutcome.error);
            this.isReady = false;
            this.clientConnected = false;
            this.toolsListed = false;
            this.processReady = false;
            const lateFailed: RagStartupResult = {
                state: 'failed',
                reason: `late_failure:${message}`,
                elapsedMs: lateElapsed,
                processAlive: false,
                readySignalObserved: false,
            };
            this.lastStartupResult = lateFailed;
            this.updateStartupState('failed', lateFailed.reason);
            console.error(`[RagService] Ignition failed after degraded startup window: ${message}`);
        });

        return degradedResult;
    }

    protected async establishConnection(
        pythonPath: string,
        scriptPath: string,
        envVars: Record<string, string>,
    ): Promise<Client> {
        const transport = new StdioClientTransport({
            command: pythonPath,
            args: [scriptPath],
            env: { ...process.env, ...envVars, PYTHONUNBUFFERED: '1' },
        });

        const client = new Client(
            {
                name: 'tala-rag-client',
                version: '1.0.0',
            },
            {
                capabilities: {},
            },
        );

        console.log(`[RagService] Spawning: ${pythonPath} ${scriptPath}`);
        await client.connect(transport);
        this.processReady = true;
        this.clientConnected = true;
        this.toolsListed = false;
        this.updateStartupState('process_ready_tools_unlisted', 'client_connected_pending_tools');
        await client.listTools();
        this.toolsListed = true;
        return client;
    }

    private resolveConnectionOutcome(
        outcome: { ok: true; client: Client } | { ok: false; error: unknown },
        startedAt: number,
        enteredSlowStart: boolean,
    ): RagStartupResult {
        const elapsedMs = Date.now() - startedAt;

        if (outcome.ok) {
            this.client = outcome.client;
            this.processReady = true;
            this.clientConnected = true;
            this.toolsListed = true;
            this.isReady = true;
            const reason = enteredSlowStart ? 'slow_start_recovered' : 'startup_ready';
            const readyResult: RagStartupResult = {
                state: 'ready',
                reason,
                elapsedMs,
                processAlive: true,
                readySignalObserved: true,
            };
            this.lastStartupResult = readyResult;
            this.updateStartupState('ready', reason);
            if (enteredSlowStart) {
                console.log(`[RagService] RAG Core ready after ${elapsedMs}ms (slow_start recovery).`);
            } else {
                console.log('[RagService] RAG Core ignited successfully.');
            }
            return readyResult;
        }

        const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        this.client = null;
        this.isReady = false;
        this.processReady = false;
        this.clientConnected = false;
        this.toolsListed = false;
        const failedResult: RagStartupResult = {
            state: 'failed',
            reason: message,
            elapsedMs,
            processAlive: false,
            readySignalObserved: false,
        };
        this.lastStartupResult = failedResult;
        this.updateStartupState('failed', message);
        console.error('[RagService] Ignition failed:', outcome.error);
        return failedResult;
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private updateStartupState(state: ServiceStartupState, reason?: string): void {
        const previous = this.startupState;
        this.startupState = state;
        if (previous !== state) {
            console.log(
                `[RagService] startup_state ${previous} -> ${state}${reason ? ` (${reason})` : ''}`,
            );
        }
    }

    public setLogViewerService(lvs: LogViewerService) {
        this.logViewerService = lvs;
    }

    private getReadinessSnapshot(): RagReadinessSnapshot {
        return {
            processReady: this.processReady,
            clientConnected: this.clientConnected,
            toolsListed: this.toolsListed,
            searchable: this.processReady && this.clientConnected && this.toolsListed && !!this.client,
            startupState: this.startupState,
        };
    }

    public getReadiness(): RagReadinessSnapshot {
        return this.getReadinessSnapshot();
    }

    public async searchStructuredDetailed(
        query: string,
        options?: { limit?: number; filter?: Record<string, unknown> }
    ): Promise<RagStructuredSearchResult> {
        const readiness = this.getReadinessSnapshot();
        if (!readiness.processReady) {
            console.warn('[RagService] SearchStructured unavailable: process_not_ready');
            return { status: 'degraded', reasonCode: 'process_not_ready', reason: 'RAG process is not ready', results: [] };
        }
        if (!readiness.clientConnected || !this.client) {
            this.updateStartupState('process_ready_client_disconnected', 'client_not_connected');
            console.warn('[RagService] SearchStructured unavailable: client_not_connected');
            return { status: 'degraded', reasonCode: 'client_not_connected', reason: 'RAG client transport is not connected', results: [] };
        }
        if (!readiness.toolsListed) {
            this.updateStartupState('process_ready_tools_unlisted', 'tools_not_listed');
            console.warn('[RagService] SearchStructured unavailable: tools_not_listed');
            return { status: 'degraded', reasonCode: 'tools_not_listed', reason: 'RAG tools have not been listed', results: [] };
        }
        const results = await this.searchStructured(query, options);
        if (!this.clientConnected) {
            return {
                status: 'degraded',
                reasonCode: 'search_unavailable',
                reason: 'RAG client transport disconnected during search',
                results: [],
            };
        }
        return { status: 'ok', results };
    }

    /**
     * Structured RAG search result — a single retrieved document chunk with its score.
     */
    // (exposed as return type of searchStructured, defined inline to avoid circular imports)

    /**
     * Searches long-term narrative memory and returns structured result objects.
     *
     * Unlike `search()` which returns a formatted string, this method returns the raw
     * parsed array so callers can construct typed MemoryItem objects for injection
     * into the retrieval pipeline (e.g. TalaContextRouter lore retrieval).
     *
     * @param {string} query - The search query.
     * @param {object} [options] - Optional limit and metadata filter.
     * @returns {Promise<Array<{text: string, score: number, docId?: string}>>}
     */
    async searchStructured(
        query: string,
        options?: { limit?: number; filter?: Record<string, unknown> }
    ): Promise<Array<{ text: string; score: number; docId?: string; metadata?: Record<string, unknown> }>> {
        const readiness = this.getReadinessSnapshot();
        if (!readiness.processReady) {
            console.warn('[RagService] SearchStructured skipped: process not ready');
            return [];
        }
        if (!readiness.clientConnected || !this.client) {
            this.updateStartupState('process_ready_client_disconnected', 'client_not_connected');
            console.warn('[RagService] SearchStructured skipped: client not connected');
            return [];
        }
        if (!readiness.toolsListed) {
            this.updateStartupState('process_ready_tools_unlisted', 'tools_not_listed');
            console.warn('[RagService] SearchStructured skipped: tools not listed');
            return [];
        }

        try {
            const args: { query: string; limit?: number; filter_json?: string } = { query };
            if (options?.limit) args.limit = options.limit;
            if (options?.filter) args.filter_json = JSON.stringify(options.filter);

            console.log(`[RagService] SearchStructured: "${query}" filter=${args.filter_json || 'none'}`);

            const start = Date.now();
            const result = await this.client.callTool({ name: 'search_memory', arguments: args });
            const latency = Date.now() - start;

            this.logViewerService?.logPerformanceMetric({
                timestamp: new Date().toISOString(),
                source: 'RagService',
                subsystem: 'rag',
                metricType: 'latency',
                name: 'rag_query_time_ms',
                value: latency,
                unit: 'ms'
            });

            if (result.content && Array.isArray(result.content) && result.content.length > 0) {
                const raw = result.content[0] as { text?: string };
                if (raw && 'text' in raw) {
                    try {
                        const parsed = JSON.parse(raw.text ?? '') as
                            | Array<{ text?: string; score?: number; doc_id?: string; metadata?: Record<string, unknown> }>
                            | { text?: string; score?: number; doc_id?: string; metadata?: Record<string, unknown> };
                        const normalizeResult = (
                            item: { text?: string; score?: number; doc_id?: string; metadata?: Record<string, unknown> },
                        ): { text: string; score: number; docId?: string; metadata?: Record<string, unknown> } => {
                            const metadata =
                                item.metadata && typeof item.metadata === 'object'
                                    ? item.metadata
                                    : undefined;
                            const text =
                                item.text
                                ?? (typeof metadata?.text === 'string' ? metadata.text : '')
                                ?? '';
                            const docIdFromMetadata = typeof metadata?.id === 'string' ? metadata.id : undefined;
                            return {
                                text,
                                score: item.score ?? 0.5,
                                docId: item.doc_id ?? docIdFromMetadata,
                                metadata,
                            };
                        };
                        if (Array.isArray(parsed)) {
                            return parsed.map(normalizeResult);
                        } else if (typeof parsed === 'object' && parsed !== null && 'text' in parsed) {
                            return [normalizeResult(parsed)];
                        }
                    } catch {
                        // Non-JSON single text block — wrap as one result at moderate score
                        if (raw.text) return [{ text: raw.text, score: 0.5 }];
                    }
                }
            }
            console.warn('[RagService] SearchStructured: no parseable content in result');
            return [];
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('Not connected')) {
                this.clientConnected = false;
                this.isReady = false;
                this.updateStartupState('process_ready_client_disconnected', 'client_not_connected');
                console.warn('[RagService] SearchStructured degraded: search unavailable (client disconnected)');
                return [];
            }
            console.warn('[RagService] SearchStructured failed:', error);
            return [];
        }
    }

    /**
     * Searches the long-term narrative memory for content relevant to the query.
     * 
     * Calls the `search_memory` MCP tool on the RAG server.
     * 
     * @param {string} query - The search query.
     * @param {Record<string, string>} [filter] - Optional metadata filter (e.g. { category: 'roleplay' }).
     * @returns {Promise<string>} The retrieved text content.
     */
    async search(query: string, options?: { limit?: number, filter?: Record<string, string> }): Promise<string> {
        if (!this.isReady || !this.client) {
            console.warn('[RagService] Search skipped: Service not ready');
            return '';
        }

        try {
            const args: { query: string; limit?: number; filter_json?: string } = { query };
            if (options?.limit) args.limit = options.limit;
            if (options?.filter) args.filter_json = JSON.stringify(options.filter);

            console.log(`[RagService] Searching: "${query}" with filter: ${args.filter_json || 'none'}`);

            const start = Date.now();
            const result = await this.client.callTool({
                name: 'search_memory',
                arguments: args
            });
            const latency = Date.now() - start;

            this.logViewerService?.logPerformanceMetric({
                timestamp: new Date().toISOString(),
                source: 'RagService',
                subsystem: 'rag',
                metricType: 'latency',
                name: 'rag_query_time_ms',
                value: latency,
                unit: 'ms'
            });

            console.log(`[RagService] Raw result content length: ${(result.content as unknown[])?.length || 0}`);

            // Handle new list[dict] response from server
            if (result.content && Array.isArray(result.content) && result.content.length > 0) {
                const raw = result.content[0] as { text?: string };
                if (raw && 'text' in raw) {
                    try {
                        const parsed = JSON.parse(raw.text ?? '') as Array<{ text: string; score?: number }> | { text: string; score?: number };

                        if (Array.isArray(parsed)) {
                            console.log(`[RagService] Parsed ${parsed.length} results`);
                            return parsed.map((r) => `- ${r.text} (Score: ${r.score?.toFixed(2)})`).join('\n');
                        } else if (typeof parsed === 'object' && parsed !== null) {
                            if ('text' in parsed) return `- ${parsed.text} (Score: ${parsed.score?.toFixed(2)})`;
                        }

                        return raw.text ?? '';
                    } catch {
                        return raw.text ?? ''; // Return raw if not json
                    }
                }
            }
            console.warn('[RagService] No content in search result');
            return '';
        } catch (error) {
            console.warn('[RagService] Search failed:', error);
            return '';
        }
    }

    /**
     * Returns the current readiness status of the RAG service.
     * @returns {boolean} True if the MCP client is connected and ready.
     */
    public getReadyStatus(): boolean {
        return this.isReady;
    }

    public getStartupState(): ServiceStartupState {
        return this.startupState;
    }

    public getLastStartupResult(): RagStartupResult | null {
        return this.lastStartupResult;
    }

    /**
     * Logs a conversation turn to the RAG server for continuity tracking.
     * 
     * Sends both the user's input and the agent's response to the `log_interaction`
     * MCP tool. The server may use this for building conversational context,
     * extracting facts, or updating the continuity log.
     * 
     * Failures are silently caught — interaction logging is non-critical.
     * 
     * @param {string} userText - The user's input message.
     * @param {string} agentText - The agent's response message.
     * @returns {Promise<void>}
     */
    async logInteraction(userText: string, agentText: string): Promise<void> {
        if (!this.isReady || !this.client) return;

        // --- RAG Noise Reduction ---
        // Skip if agent response is empty or purely a tool call/envelope JSON
        const trimmed = agentText.trim();
        if (!trimmed || (trimmed.startsWith('{') && trimmed.endsWith('}') && trimmed.includes('tool_calls'))) {
            return;
        }

        try {
            await this.client.callTool({
                name: 'log_interaction',
                arguments: { user_text: userText, agent_text: agentText }
            });
        } catch (error) {
            console.warn('[RagService] Log failed:', error);
        }
    }
    /**
     * Ingests a single file into the RAG vector database.
     * 
     * @param {string} filePath - Absolute path to the file.
     * @param {string} category - Category tag (e.g. 'roleplay', 'assistant'). Defaults to 'general'.
     * @returns {Promise<string>} Confirmation text.
     */
    async ingestFile(filePath: string, category: string = 'general'): Promise<string> {
        if (!this.isReady || !this.client) return 'RAG Service not ready';

        try {
            // --- RAG Noise Reduction: Skip Oversized Files ---
            const stats = fs.statSync(filePath);
            if (stats.size > 1024 * 1024) { // 1MB Cap for RAG items
                console.warn(`[RagService] Skipping oversized file: ${filePath} (${stats.size} bytes)`);
                return 'File too large for RAG ingestion';
            }

            const result = await this.client.callTool({
                name: 'ingest_file',
                arguments: { file_path: filePath, category }
            });

            if (result.content && Array.isArray(result.content) && result.content.length > 0) {
                const content = result.content[0] as { text?: string };
                if (content && 'text' in content) {
                    return content.text ?? '';
                }
            }
            return 'Ingestion called but no response text.';
        } catch (error: unknown) {
            console.error('[RagService] Ingestion failed:', error);
            return `Ingestion failed: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    /**
     * Deletes a previously ingested file's chunks from the RAG vector database.
     * 
     * Calls the `delete_file_memory` MCP tool, which removes all vector embeddings
     * associated with the given file path from ChromaDB.
     * 
     * @param {string} filePath - Absolute path of the file whose embeddings should be removed.
     * @returns {Promise<string>} Confirmation text from the server, or an error message.
     */
    async deleteFile(filePath: string): Promise<string> {
        if (!this.isReady || !this.client) return 'RAG Service not ready';

        try {
            const result = await this.client.callTool({
                name: 'delete_file_memory',
                arguments: { file_path: filePath }
            });
            if (result.content && Array.isArray(result.content) && result.content.length > 0) {
                const content = result.content[0] as { text?: string };
                if (content && 'text' in content) {
                    return content.text ?? '';
                }
            }
            return 'Deletion called.';
        } catch (error: unknown) {
            console.error('[RagService] Deletion failed:', error);
            return `Deletion failed: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    /**
     * Waits for the RAG service to become ready, up to a specified timeout.
     */
    private async waitForReady(timeoutMs: number = 10000): Promise<boolean> {
        if (this.isReady) return true;

        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (this.isReady) return true;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        return this.isReady;
    }

    /**
     * Lists all files currently indexed in the RAG vector database.
     * 
     * Calls the `list_indexed_files` MCP tool.
     * Handles both single JSON-string responses (legacy) and multi-block responses (FastMCP list[str]).
     * 
     * @returns {Promise<string[]>} Array of absolute file paths that have been ingested.
     */
    async listIndexedFiles(): Promise<string[]> {
        // Wait for readiness before assuming the index is empty
        const ready = await this.waitForReady(10000);
        if (!ready || !this.client) {
            throw new Error('[RagService] listIndexedFiles: Service not ready after timeout.');
        }

        try {
            const result = await this.client.callTool({
                name: 'list_indexed_files',
                arguments: {}
            });

            if (!result.content || !Array.isArray(result.content) || result.content.length === 0) {
                return [];
            }

            let paths: string[] = [];

            // Case A: Multiple content blocks (FastMCP returning list[str] as separate text items)
            if (result.content.length > 1) {
                console.log(`[RagService] Detected multi-block response (${result.content.length} items).`);
                paths = result.content
                    .map((c: { text?: string }) => c.text?.trim())
                    .filter((s): s is string => Boolean(s));
            }
            // Case B: Single content block (Might be a JSON string OR a single path)
            else {
                const rawText = (result.content[0] as { text?: string }).text || '';
                try {
                    // Try JSON parse first
                    const parsed = JSON.parse(rawText) as string[] | unknown;
                    if (Array.isArray(parsed)) {
                        paths = parsed;
                    } else {
                        // Not an array? Treat as single path if non-empty
                        if (rawText.length > 0) paths = [rawText];
                    }
                } catch {
                    // Not JSON. Treat as single path or python-style list string
                    if (rawText.startsWith('[') && rawText.endsWith(']')) {
                        // Python string representation fallback
                        paths = rawText
                            .replace(/[[\]']/g, '')
                            .split(',')
                            .map((s: string) => s.trim())
                            .filter(Boolean);
                    } else {
                        // Just a single path
                        if (rawText.length > 0) paths = [rawText];
                    }
                }
            }

            // Normalization
            const normalizedPaths = paths.map(this.normalizePath);
            return normalizedPaths;

        } catch (error) {
            console.error('[RagService] List failed:', error);
            throw error;
        }
    }

    /**
     * Unifies file path formatting for consistent comparison across platforms.
     * Force Windows paths to be consistent: Upper Case Drive, Backslashes.
     * 
     * @param p The raw path string to normalize.
     */
    private normalizePath(p: string): string {
        // Force Windows paths to be consistent: Backslashes, Lowercase
        // This ensures comparison between FileSystem paths and DB paths works reliably on Windows.
        let normalized = p.replace(/\//g, '\\');

        // Handle double-escaped backslashes from JSON/Python
        normalized = normalized.replace(/\\\\/g, '\\');

        // Allow lowercase drive letters for full case-insensitivity
        return normalized.toLowerCase();
    }

    /**
     * Shuts down the RAG service by closing the MCP client.
     * This ensures the underlying Python process is terminated.
     */
    public async shutdown(): Promise<void> {
        if (this.client) {
            try {
                // Add timeout to close() to prevent hangs
                await Promise.race([
                    this.client.close(),
                    new Promise(resolve => setTimeout(resolve, 2000))
                ]);
                console.log('[RagService] Disconnected.');
            } catch (e) {
                console.error('[RagService] Error during shutdown:', e);
            }
            this.client = null;
        }
        this.isReady = false;
        this.processReady = false;
        this.clientConnected = false;
        this.toolsListed = false;
        this.updateStartupState('not_started', 'shutdown_completed');
        // Transport matches lifespan of client usually, but SDK client.close() handles it.
    }
}
