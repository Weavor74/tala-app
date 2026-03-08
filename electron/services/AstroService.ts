import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

/**
 * AstroService
 * 
 * Manages the lifecycle and communication with the embedded Astro Emotion Engine
 * MCP server. This service is responsible for calculating Tala's real-time
 * emotional state based on astrological natal chart data and current planetary transits.
 * 
 * **How it integrates with the agent:**
 * During each conversation turn, `AgentService.chat()` calls `getEmotionalState()`
 * to inject an `[ASTRO STATE]` block into the system prompt. This block contains:
 * - **System Instructions**: Personality modifiers based on current planetary energy.
 * - **Style Guide**: Communication tone guidance (e.g., "Be more nurturing today").
 * - **Emotional Vector**: Numeric scores for dimensions like warmth, intensity, clarity.
 * 
 * **Architecture:**
 * The service spawns the Astro Engine as a Python child process and communicates
 * via the MCP SDK's stdio transport. The engine uses Swiss Ephemeris for planetary
 * position calculations and runs 13 planetary modules to produce the emotional state.
 * 
 * **Lifecycle:**
 * 1. `ignite()` — Spawns the Python process and connects the MCP client.
 * 2. `getEmotionalState()` — Called per chat turn to get current emotional modulation.
 * 3. `shutdown()` — Kills the Python process during app closure.
 * 
 * @example
 * ```typescript
 * const astro = new AstroService();
 * await astro.ignite('/path/to/python', '/path/to/astro-engine');
 * const state = await astro.getEmotionalState('tala', 'User is asking about career');
 * console.log(state); // "[ASTRO STATE]\nSystem Instructions: ..."
 * ```
 */
export class AstroService {
    /** MCP SDK client instance for calling Astro Engine tools. Null if not connected. */
    private client: Client | null = null;
    /** The spawned Python child process running the Astro Engine MCP server. */
    private serverProcess: ChildProcess | null = null;
    /** Whether the MCP client is connected and ready to receive tool calls. */
    private isReady = false;
    public getReadyStatus(): boolean { return this.isReady; }

    /** In-memory cache for emotional state to prevent redundant expensive planetary calculations. */
    private stateCache: Map<string, { state: string, timestamp: number }> = new Map();
    private readonly CACHE_TTL_MS = 5000;

    /**
     * Spawns the Astro Emotion Engine as a Python child process and connects
     * the MCP client to it via stdio transport.
     * 
     * This method performs two parallel operations:
     * 1. **Spawns a debug process**: A child process that captures stdout/stderr
     *    output to a log file at `{userData}/astro_engine.log` for debugging.
     * 2. **Creates an MCP transport**: A separate `StdioClientTransport` that
     *    the MCP SDK uses for bidirectional tool-call communication.
     * 
     * The engine is started with:
     * - `python -m astro_emotion_engine.mcp_server` (module execution mode).
     * - `PYTHONUNBUFFERED=1` to ensure real-time log output.
     * - `ASTRO_FORCE_FALLBACK=1` to use the fallback ephemeris provider if
     *   Swiss Ephemeris data files are not available.
     * 
     * On success, `isReady` is set to `true` and subsequent tool calls are enabled.
     * On failure, the error is re-thrown to the caller (AgentService).
     * 
     * @param {string} pythonPath - Absolute path to the Python executable
     *   (typically from the venv: `mcp-servers/tala-core/venv/Scripts/python.exe`).
     * @param {string} scriptPath - Absolute path to the astro-engine package directory
     *   (e.g., `mcp-servers/astro-engine/astro_emotion_engine/`). Used as the `cwd`
     *   for the spawned process (the parent directory of the package).
     * @returns {Promise<void>}
     * @throws {Error} If the MCP connection fails (e.g., Python not found, import errors).
     */
    async ignite(pythonPath: string, scriptPath: string, envVars: Record<string, string> = {}): Promise<void> {
        console.log(`[AstroService] Igniting Astro Engine at ${scriptPath}...`);

        const connectPromise = async () => {
            try {
                // We need to run from the parent directory of 'astro_emotion_engine' so python -m works
                const packageDir = path.dirname(scriptPath); // .../astro_emotion_engine
                const parentDir = path.dirname(packageDir);  // .../astro-engine

                // Connect MCP client
                // Note: StdioClientTransport handles process spawning internally.
                // Re-running it here ensures we only have ONE process.
                const transport = new StdioClientTransport({
                    command: pythonPath,
                    args: ['-m', 'astro_emotion_engine.mcp_server'],
                    cwd: parentDir,
                    env: { ...process.env, ...envVars, PYTHONUNBUFFERED: '1', ASTRO_FORCE_FALLBACK: '1' }
                });

                const client = new Client({
                    name: 'tala-astro-client',
                    version: '1.0.0'
                }, {
                    capabilities: {}
                });

                const command = `${pythonPath} -m astro_emotion_engine.mcp_server`;
                console.log(`[AstroService] Spawning: ${command} in ${parentDir}`);

                await client.connect(transport);
                this.client = client;
                this.isReady = true;
                console.log('[AstroService] Astro Engine ignited successfully.');
            } catch (error) {
                console.error('[AstroService] Ignition failed:', error);
                this.isReady = false;
                // Don't throw, allow fallback
            }
        };

        const timeoutPromise = new Promise<void>((resolve) => {
            setTimeout(() => {
                if (!this.isReady) {
                    console.warn('[AstroService] Ignition timed out (15000ms). Proceeding in background.');
                }
                resolve();
            }, 15000);
        });

        await Promise.race([connectPromise(), timeoutPromise]);
    }

    /**
     * Retrieves the current astrological emotional state for a given agent profile.
     * 
     * Calls the `get_emotional_state` MCP tool on the connected Astro Engine,
     * which runs the full calculation pipeline:
     * 1. Loads the agent's natal chart data from their stored profile.
     * 2. Calculates current planetary positions using the ephemeris provider.
     * 3. Runs all 13 planetary modules (Moon phase, Mercury, Venus, Mars, etc.).
     * 4. Aggregates scores into a normalized emotional vector.
     * 5. Generates system instructions, style guide, and mood label.
     * 
     * The returned string is formatted as an `[ASTRO STATE]` block that gets
     * injected into the agent's system prompt by `AgentService.chat()`.
     * 
     * If the engine is not ready (not ignited or crashed), returns a neutral
     * fallback state instead of throwing, so the agent can still function.
     * 
     * @param {string} [agentId='tala'] - The agent profile ID. Must match a profile
     *   previously created via `createProfile()` or stored in `agent_profiles.json`.
     * @param {string} [contextPrompt=''] - Optional context about the current
     *   interaction (e.g., `'User is asking about relationships'`). Used by the
     *   engine to fine-tune the emotional output for the conversation topic.
     * @returns {Promise<string>} Formatted emotional state string, prefixed with
     *   `[ASTRO STATE]`. Contains system instructions, style guide, emotional vector,
     *   and mood label. Returns a fallback string if the engine is offline.
     */
    async getEmotionalState(agentId: string = 'tala', contextPrompt: string = ''): Promise<string> {
        const now = Date.now();
        const cacheKey = `${agentId}:${contextPrompt}`;
        const cached = this.stateCache.get(cacheKey);

        if (cached && (now - cached.timestamp) < this.CACHE_TTL_MS) {
            console.log(`[AstroService] Returning cached emotional state for ${agentId} (TTL: ${this.CACHE_TTL_MS}ms)`);
            return cached.state;
        }

        console.log(`[AstroService] getEmotionalState called for ${agentId}. Ready: ${this.isReady}, Client: ${!!this.client}`);

        if (!this.isReady || !this.client) {
            console.warn('[AstroService] Not ready, returning neutral state');
            return '[ASTRO STATE]: Neutral (Engine offline)';
        }

        try {
            console.log(`[AstroService] Invoking MCP tool 'get_agent_emotional_state' for ${agentId}...`);
            const result = await this.client.callTool({
                name: 'get_agent_emotional_state',
                arguments: {
                    agent_id: agentId,
                    context_prompt: contextPrompt
                }
            });

            console.log('[AstroService] Tool call returned:', JSON.stringify(result).substring(0, 100) + '...');

            if (result.content && Array.isArray(result.content) && result.content.length > 0) {
                const content = result.content[0] as any;
                if (content && typeof content.text === 'string') {
                    // Check for logical errors returned as text
                    if (content.text.startsWith('❌')) {
                        throw new Error(content.text);
                    }

                    // Update cache
                    this.stateCache.set(cacheKey, { state: content.text, timestamp: now });
                    return content.text;
                }
            }

            console.warn('[AstroService] Tool returned no text content.');
            return '[ASTRO STATE]: Calculation returned no data';
        } catch (error) {
            console.error('[AstroService] getEmotionalState ERROR:', error);
            return '[ASTRO STATE]: Error (Calculation failed)';
        }
    }

    /**
     * Retrieves the raw emotional vector and mood label.
     */
    async getRawEmotionalState(agentId: string = 'tala'): Promise<any> {
        if (!this.isReady || !this.client) return null;

        try {
            const result = await this.client.callTool({
                name: 'get_raw_agent_emotional_state',
                arguments: { agent_id: agentId }
            });

            if (result.content && Array.isArray(result.content) && result.content.length > 0) {
                const content = result.content[0] as any;
                if (content && typeof content.text === 'string') {
                    return JSON.parse(content.text);
                }
            }
        } catch (e) {
            console.error('[AstroService] getRawEmotionalState fail', e);
        }
        return null;
    }

    /**
     * Creates a new agent profile in the Astro Engine's persistent profile store.
     */
    async createProfile(agentId: string, name: string, birthDate: string, birthPlace: string): Promise<string> {
        if (!this.isReady || !this.client) {
            throw new Error('Astro Engine not ready');
        }

        try {
            const result = await this.client.callTool({
                name: 'create_agent_profile',
                arguments: {
                    agent_id: agentId,
                    name: name,
                    birth_date: birthDate,
                    birth_place: birthPlace
                }
            });

            if (result.content && Array.isArray(result.content) && result.content.length > 0) {
                const content = result.content[0] as any;
                if (content && typeof content.text === 'string') {
                    // Check for logical errors returned as text
                    if (content.text.startsWith('❌')) {
                        throw new Error(content.text);
                    }
                    return content.text;
                }
            }

            return 'Profile created (no confirmation)';
        } catch (error: any) {
            throw new Error(error.message || 'Failed to create profile');
        }
    }

    /**
     * Retrieves a formatted list of all agent profiles stored in the Astro Engine.
     */
    async listProfiles(): Promise<string> {
        if (!this.isReady || !this.client) {
            return 'Astro Engine not ready';
        }

        try {
            const result = await this.client.callTool({
                name: 'list_agent_profiles',
                arguments: {}
            });

            if (result.content && Array.isArray(result.content) && result.content.length > 0) {
                const content = result.content[0] as any;
                if (content && 'text' in content) {
                    return content.text;
                }
            }

            return 'No profiles found';
        } catch (error: any) {
            return `Error listing profiles: ${error.message}`;
        }
    }

    /**
     * Updates an existing agent profile in the Astro Engine.
     */
    async updateProfile(agentId: string, name?: string, birthDate?: string, birthPlace?: string): Promise<string> {
        if (!this.isReady || !this.client) {
            throw new Error('Astro Engine not ready');
        }

        try {
            const result = await this.client.callTool({
                name: 'update_agent_profile',
                arguments: {
                    agent_id: agentId,
                    name,
                    birth_date: birthDate,
                    birth_place: birthPlace
                }
            });

            if (result.content && Array.isArray(result.content) && result.content.length > 0) {
                const content = result.content[0] as any;
                if (content && typeof content.text === 'string') {
                    // Check for logical errors returned as text
                    if (content.text.startsWith('❌')) {
                        throw new Error(content.text);
                    }
                    return content.text;
                }
            }

            return 'Profile updated';
        } catch (error: any) {
            throw new Error(error.message || 'Failed to update profile');
        }
    }

    /**
     * Deletes an agent profile from the Astro Engine.
     */
    async deleteProfile(agentId: string): Promise<string> {
        if (!this.isReady || !this.client) {
            throw new Error('Astro Engine not ready');
        }

        try {
            const result = await this.client.callTool({
                name: 'delete_agent_profile',
                arguments: {
                    agent_id: agentId
                }
            });

            if (result.content && Array.isArray(result.content) && result.content.length > 0) {
                const content = result.content[0] as any;
                if (content && 'text' in content) {
                    return content.text;
                }
            }

            return 'Profile deleted';
        } catch (error: any) {
            throw new Error(`Failed to delete profile: ${error.message}`);
        }
    }

    /**
     * Shuts down the Astro Emotion Engine by killing the Python child process.
     */
    shutdown(): void {
        if (this.serverProcess) {
            this.serverProcess.kill();
            this.serverProcess = null;
        }
        this.client = null;
        this.isReady = false;
    }
}
