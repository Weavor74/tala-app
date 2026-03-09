import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'fs';
import * as path from 'path';
import { LogViewerService } from './LogViewerService';

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
    async ignite(pythonPath: string, scriptPath: string, envVars: Record<string, string> = {}): Promise<void> {
        console.log(`[RagService] Igniting RAG Core at ${scriptPath}...`);

        const connectPromise = async () => {
            try {
                // Capture stdout/stderr for debugging
                // We do NOT spawn a separate process for logs because StdioClientTransport needs to own the stdio.
                // But if we want to debug, StdioClientTransport is tricky because it consumes stdout.
                // We rely on the client connection for success.
                // If we need logs, we might rely on the python script writing to a file, or use SSE in future.

                // For now, we trust StdioClientTransport to handle the process spawning.

                const transport = new StdioClientTransport({
                    command: pythonPath,
                    args: [scriptPath],
                    env: { ...process.env, ...envVars, PYTHONUNBUFFERED: '1' }
                });

                const client = new Client({
                    name: 'tala-rag-client',
                    version: '1.0.0'
                }, {
                    capabilities: {}
                });

                console.log(`[RagService] Spawning: ${pythonPath} ${scriptPath}`);

                await client.connect(transport);
                this.client = client;
                this.isReady = true;
                console.log('[RagService] RAG Core ignited successfully.');

                // Verify connection
                await this.client.listTools();
            } catch (error) {
                console.error('[RagService] Ignition failed:', error);
                this.isReady = false;
                // Don't throw, just stay offline
            }
        };

        const timeoutPromise = new Promise<void>((resolve, reject) => {
            setTimeout(() => {
                if (!this.isReady) {
                    console.warn('[RagService] Ignition timed out (15000ms). Rejecting promise.');
                    reject(new Error("RAG Core ignition timed out. Server failed to start."));
                } else {
                    resolve();
                }
            }, 15000);
        });

        // Race the connection against the timeout
        await Promise.race([connectPromise(), timeoutPromise]);
    }

    public setLogViewerService(lvs: LogViewerService) {
        this.logViewerService = lvs;
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
        // Transport matches lifespan of client usually, but SDK client.close() handles it.
    }
}
