import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { OllamaBrain } from '../brains/OllamaBrain';
import { CloudBrain } from '../brains/CloudBrain';
import { BackupService } from './BackupService';
import type { IBrain, ChatMessage } from '../brains/IBrain';
import { ToolService } from './ToolService';
import { RagService } from './RagService';
import { MemoryService } from './MemoryService';
import { AstroService } from './AstroService';
import { TerminalService } from './TerminalService';
import { FunctionService } from './FunctionService';
import { OrchestratorService } from './OrchestratorService';
import { loadSettings } from './SettingsManager';

// @tala:priority Always verify brain settings before proceeding with multi-turn loops.
// @tala:warn Never remove the exponential backoff from streamWithRetry.
import { InferenceService } from './InferenceService';
import { IngestionService } from './IngestionService';
import { ReflectionEngine } from './reflection/ReflectionEngine';
import { AnnotationParser } from './AnnotationParser';

/**
 * AgentService
 * 
 * The central orchestrator that governs the "Mind" of Tala. This service
 * coordinates all AI capabilities: inference (brain), memory, RAG, emotion
 * (astro), tool execution, backup, and browser/terminal interaction.
 * 
 * **Architecture:**
 * 
 * ```
 *   User Message
 *        │
 *        ▼
 *   AgentService.chat()
 *        ├── getAstroState()      → Emotional context
 *        ├── memory.search()     → Short-term memory
 *        ├── rag.search()        → Long-term memory (RAG)
 *        ├── brain.streamResponse() → LLM inference
 *        └── tools.executeTool() → Tool calls (file I/O, browser, terminal)
 * ```
 * 
 * **Chat loop:**
 * The `chat()` method implements a multi-turn tool-use agentic loop:
 * 1. Gathers context (astro state, user profile, memories, RAG results).
 * 2. Builds a system prompt with tool schemas and usage protocols.
 * 3. Streams the AI response, detecting tool calls (JSON with `"tool":`).
 * 4. Executes detected tools and feeds results back as `[OBSERVATION]`.
 * 5. Repeats up to 10 turns, stopping when no tool calls are detected.
 * 6. Persists the final response to memory.
 * 
 * **Brain selection:**
 * Supports both local inference (OllamaBrain) and cloud inference (CloudBrain)
 * based on user configuration in `app_settings.json`.
 * 
 * **Sub-service lifecycle:**
 * - `igniteSoul()` starts the RAG, Memory, and Astro MCP servers.
 * - `shutdown()` tears down the RAG server.
 * 
 * @example
 * ```typescript
 * const agent = new AgentService(terminal, functions);
 * await agent.igniteSoul();
 * await agent.chat('Hello!', (token) => process.stdout.write(token));
 * ```
 */
export class AgentService {
    /** The active LLM inference backend (OllamaBrain or CloudBrain). */
    private brain: IBrain;
    /** Whether `igniteSoul()` has completed successfully. */
    private isSoulReady = false;
    /** Short-term conversational memory (Mem0). */
    private memory: MemoryService;
    /** Astrological emotion engine for persona modulation. */
    private astro: AstroService;
    /** Long-term memory via RAG/vector search. */
    private rag: RagService;
    /** Registry of callable tools exposed to the AI brain. */
    private tools: ToolService;
    /** Automated workspace backup manager. */
    private backup: BackupService;
    /** Local inference engine manager. */
    private inference: InferenceService;
    /** Automated document ingestion service. */
    private ingestion: IngestionService;
    /** Sub-agent orchestrator for background tasks. */
    private orchestrator!: OrchestratorService;
    /** Optional reference to the terminal for executing commands. */
    private terminal: TerminalService | null = null;
    /** Optional reference to the function service for `/command` shortcuts. */
    private functions: FunctionService | null = null;
    /** Cached system environment info (OS, Python/Node paths). */
    private systemInfo: any = null;
    /** Persistent chat history — saved to disk across sessions. */
    private chatHistory: ChatMessage[] = [];
    /** Absolute path to the settings file (`app_settings.json`). */
    private settingsPath: string;
    /** Base directory for persisting chat session JSON files. */
    private sessionsDir: string;
    /** Legacy path for the old single-file chat history (pre-sessions). */
    private chatHistoryPath: string;
    /** The currently active chat session's unique identifier. */
    private activeSessionId: string = '';
    /** Parent session ID if this session was branched from another. */
    private activeParentId: string = '';
    /** Message index at which the branch occurred. */
    private activeBranchPoint: number = -1;
    /** Active AbortController for the current streaming response. */
    private abortController: AbortController | null = null;
    /** Reference to the main BrowserWindow for IPC. */
    private mainWindow: any = null;
    /** Timer for periodic Astro state telemetry updates. */
    private astroTelemetryTimer: NodeJS.Timeout | null = null;
    /**
     * Creates a new AgentService, initializing all sub-services.
     * 
     * Instantiates MemoryService, AstroService, RagService, ToolService,
     * BackupService, and sets OllamaBrain as the default inference backend.
     * Immediately loads brain configuration from `app_settings.json` and
     * injects the MemoryService into the ToolService.
     * 
     * @param {TerminalService} [terminal] - Optional TerminalService for running commands.
     * @param {FunctionService} [functions] - Optional FunctionService for `/command` shortcuts.
     * @param {McpService} [mcp] - Optional McpService for external tools.
     * @param {InferenceService} [inference] - Optional InferenceService for local engine control.
     */
    constructor(terminal?: TerminalService, functions?: FunctionService, mcp?: any, inference?: InferenceService) {
        this.brain = new OllamaBrain();
        this.memory = new MemoryService();
        this.astro = new AstroService();
        this.rag = new RagService();
        this.tools = new ToolService();
        this.backup = new BackupService();
        this.inference = inference || new InferenceService();
        this.ingestion = new IngestionService(this.rag, app.getPath('userData')); // Fallback root

        this.tools.setMemoryService(this.memory);
        if (mcp) this.tools.setMcpService(mcp);

        if (terminal) this.terminal = terminal;
        if (functions) this.functions = functions;

        this.settingsPath = path.join(app.getPath('userData'), 'app_settings.json');
        this.chatHistoryPath = path.join(app.getPath('userData'), 'chat_history.json');
        this.sessionsDir = path.join(app.getPath('userData'), 'chat_sessions');

        // Ensure sessions directory exists
        if (!fs.existsSync(this.sessionsDir)) fs.mkdirSync(this.sessionsDir, { recursive: true });

        // Migrate legacy single-file history if present
        this.migrateLegacyHistory();

        // Load the most recent session or create a new one
        const sessions = this.listSessions();
        if (sessions.length > 0) {
            this.loadSessionById(sessions[0].id);
        } else {
            this.newSession();
        }

        this.loadBrainConfig();

        // ═══════════════════════════════════════════════════════════════════════
        // ORCHESTRATOR & DELEGATION TOOL
        // ═══════════════════════════════════════════════════════════════════════
        this.orchestrator = new OrchestratorService(this.brain, this.tools);

        this.tools.register({
            name: 'delegate_task',
            description: 'Spawns a background sub-agent ("Minion") to perform a specific sub-task (research, analysis, code review). Use this to offload heavy workloads or parallelize your reasoning. The sub-agent will use the same tools as you but in a headless loop.',
            parameters: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: 'The specific task for the minion to perform.' },
                    instructions: { type: 'string', description: 'Detailed instructions for the minion, including any context or personas (e.g., "Research the latest API docs for X").' }
                },
                required: ['task', 'instructions']
            },
            execute: async (args) => {
                const report = await this.orchestrator.runHeadlessLoop(args.task, args.instructions);
                return `[MINION REPORT]:\n${report}`;
            }
        });
    }

    /**
     * Injects the McpService dependency.
     */
    public setMcpService(mcp: any) {
        this.tools.setMcpService(mcp);
    }

    /**
     * Injects the GitService dependency.
     * (Currently unused by Agent directly, but kept for API consistency/future expansion)
     */
    public setGitService(git: any) {
        // Future: Register git tools here if needed
    }

    /**
     * Refreshes MCP tools.
     */
    public async refreshMcpTools() {
        await this.tools.refreshMcpTools();
    }

    /**
     * Sets the main window reference for IPC communication.
     */
    public setMainWindow(window: any) {
        this.mainWindow = window;
    }

    // ─── Chat Session Management ─────────────────────────────────

    /** Generates a simple UUID v4. */
    private generateId(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    /** Migrates legacy chat_history.json into a session file. */
    private migrateLegacyHistory() {
        try {
            if (fs.existsSync(this.chatHistoryPath)) {
                const data = JSON.parse(fs.readFileSync(this.chatHistoryPath, 'utf-8'));
                if (Array.isArray(data) && data.length > 0) {
                    const id = this.generateId();
                    const firstUser = data.find((m: any) => m.role === 'user');
                    const title = firstUser ? firstUser.content.slice(0, 60) : 'Migrated Chat';
                    const session = { id, title, messages: data, createdAt: new Date().toISOString() };
                    fs.writeFileSync(path.join(this.sessionsDir, `${id}.json`), JSON.stringify(session, null, 2));
                    console.log(`[AgentService] Migrated legacy chat history → session ${id}`);
                }
                fs.unlinkSync(this.chatHistoryPath);
            }
        } catch (e) {
            console.error('[AgentService] Legacy migration failed:', e);
        }
    }

    /** Lists all chat sessions sorted by creation date (newest first). */
    public listSessions(): Array<{ id: string; title: string; createdAt: string; messageCount: number; parentId?: string; branchPoint?: number }> {
        try {
            const files = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.json'));
            const sessions = files.map(f => {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, f), 'utf-8'));
                    return {
                        id: data.id || f.replace('.json', ''),
                        title: data.title || 'Untitled',
                        createdAt: data.createdAt || '',
                        messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
                        parentId: data.parentId || undefined,
                        branchPoint: data.branchPoint ?? undefined,
                    };
                } catch { return null; }
            }).filter(Boolean) as Array<{ id: string; title: string; createdAt: string; messageCount: number; parentId?: string; branchPoint?: number }>;
            sessions.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
            return sessions;
        } catch (e) {
            console.error('[AgentService] Failed to list sessions:', e);
            return [];
        }
    }

    /** Loads a specific session by ID. */
    private loadSessionById(id: string) {
        try {
            const filePath = path.join(this.sessionsDir, `${id}.json`);
            if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                this.chatHistory = data.messages || [];
                this.activeSessionId = id;
                console.log(`[AgentService] Loaded session ${id} (${this.chatHistory.length} messages)`);
            }
        } catch (e) {
            console.error(`[AgentService] Failed to load session ${id}:`, e);
        }
    }

    /** Public: loads a session and returns its messages. */
    public loadSession(id: string): ChatMessage[] {
        this.loadSessionById(id);
        return this.chatHistory;
    }

    /** Creates a new empty session and sets it as active. */
    public newSession(): string {
        const id = this.generateId();
        this.activeSessionId = id;
        this.chatHistory = [];
        this.saveSession();
        console.log(`[AgentService] Created new session ${id}`);
        return id;
    }

    /** Deletes a session file. If it's the active session, creates a new one. */
    public deleteSession(id: string) {
        try {
            const filePath = path.join(this.sessionsDir, `${id}.json`);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (this.activeSessionId === id) {
                const remaining = this.listSessions();
                if (remaining.length > 0) {
                    this.loadSessionById(remaining[0].id);
                } else {
                    this.newSession();
                }
            }
        } catch (e) {
            console.error(`[AgentService] Failed to delete session ${id}:`, e);
        }
    }

    /**
     * Exports the current (or specified) session as Markdown or JSON.
     * @param format - 'markdown' or 'json'
     * @param sessionId - Optional session ID (defaults to active)
     * @returns Formatted string
     */
    public exportSession(format: 'markdown' | 'json' = 'markdown', sessionId?: string): string {
        const id = sessionId || this.activeSessionId;
        const filePath = path.join(this.sessionsDir, `${id}.json`);

        if (!fs.existsSync(filePath)) {
            throw new Error(`Session not found: ${id}`);
        }

        const session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const messages: ChatMessage[] = session.messages || [];

        if (format === 'json') {
            return JSON.stringify(session, null, 2);
        }

        // Markdown format
        const lines: string[] = [];
        lines.push(`# ${session.title || 'Conversation'}`);
        lines.push(`*Exported: ${new Date().toISOString()}*`);
        lines.push(`*Session: ${id}*`);
        lines.push('');
        lines.push('---');
        lines.push('');

        for (const msg of messages) {
            switch (msg.role) {
                case 'user':
                    lines.push(`## 🧑 User`);
                    lines.push(msg.content);
                    break;
                case 'assistant':
                    lines.push(`## 🤖 Tala`);
                    lines.push(msg.content);
                    break;
                case 'tool':
                    lines.push(`> **Tool** (\`${msg.name || 'unknown'}\`): ${msg.content.substring(0, 200)}${msg.content.length > 200 ? '...' : ''}`);
                    break;
                case 'system':
                    // Skip system messages in export
                    break;
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    /** Persists the active session to disk. */
    private saveSession() {
        try {
            const firstUser = this.chatHistory.find(m => m.role === 'user');
            const title = firstUser ? firstUser.content.slice(0, 60) : 'New Chat';
            const session: any = {
                id: this.activeSessionId,
                title,
                messages: this.chatHistory,
                createdAt: new Date().toISOString(),
            };
            if (this.activeParentId) {
                session.parentId = this.activeParentId;
                session.branchPoint = this.activeBranchPoint;
            }
            fs.writeFileSync(
                path.join(this.sessionsDir, `${this.activeSessionId}.json`),
                JSON.stringify(session, null, 2)
            );
        } catch (e) {
            console.error('[AgentService] Failed to save session:', e);
        }
    }

    /**
     * Forks a conversation at a specific message index.
     * Creates a new session containing messages [0..messageIndex] from the source.
     * @param sourceId - The session ID to fork from.
     * @param messageIndex - The message index to branch at (inclusive).
     * @returns The new branched session ID, or null on failure.
     */
    public branchSession(sourceId: string, messageIndex: number): string | null {
        try {
            // Default to current active session if no sourceId given
            const resolvedSource = sourceId || this.activeSessionId;
            const filePath = path.join(this.sessionsDir, `${resolvedSource}.json`);
            if (!fs.existsSync(filePath)) {
                console.error(`[AgentService] Cannot branch: source session ${resolvedSource} not found`);
                return null;
            }
            const sourceData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const sourceMessages: ChatMessage[] = sourceData.messages || [];

            if (messageIndex < 0 || messageIndex >= sourceMessages.length) {
                console.error(`[AgentService] Cannot branch: messageIndex ${messageIndex} out of range (0-${sourceMessages.length - 1})`);
                return null;
            }

            // Deep copy messages up to and including the branch point
            const branchedMessages = JSON.parse(JSON.stringify(sourceMessages.slice(0, messageIndex + 1)));

            // Create new session
            const newId = this.generateId();
            const firstUser = branchedMessages.find((m: ChatMessage) => m.role === 'user');
            const title = firstUser ? `⑂ ${firstUser.content.slice(0, 55)}` : '⑂ Branch';

            const session = {
                id: newId,
                title,
                messages: branchedMessages,
                createdAt: new Date().toISOString(),
                parentId: resolvedSource,
                branchPoint: messageIndex,
            };

            fs.writeFileSync(
                path.join(this.sessionsDir, `${newId}.json`),
                JSON.stringify(session, null, 2)
            );

            // Switch to the new session
            this.activeSessionId = newId;
            this.chatHistory = branchedMessages;
            this.activeParentId = resolvedSource;
            this.activeBranchPoint = messageIndex;

            console.log(`[AgentService] Branched session ${resolvedSource} at message ${messageIndex} → ${newId}`);
            return newId;
        } catch (e) {
            console.error('[AgentService] Failed to branch session:', e);
            return null;
        }
    }

    /** Returns the current chat history for the renderer to restore. */
    public getChatHistory(): Array<{ role: string; content: string }> {
        return this.chatHistory;
    }

    /** Clears the active session's chat history. */
    public clearChatHistory() {
        this.chatHistory = [];
        this.saveSession();
    }

    // ─── Streaming Cancel ─────────────────────────────────────────

    /** Cancels the currently active streaming response. */
    public cancelChat() {
        if (this.abortController) {
            console.log('[AgentService] Cancelling active chat stream.');
            this.abortController.abort();
            this.abortController = null;
        }
    }

    // ─── Context Window Management ────────────────────────────────

    /** Rough token count estimation (~4 chars per token). */
    private estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }

    /**
     * Truncates chat history to fit within a token budget.
     * Always preserves the most recent messages; drops oldest first.
     */
    private truncateHistory(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
        let totalTokens = 0;
        const result: ChatMessage[] = [];

        // Walk backwards (newest first) and collect until budget is exceeded
        for (let i = messages.length - 1; i >= 0; i--) {
            const tokens = this.estimateTokens(messages[i].content);
            if (totalTokens + tokens > maxTokens && result.length > 0) {
                console.log(`[AgentService] Context truncated: dropped ${i + 1} oldest messages.`);
                break;
            }
            totalTokens += tokens;
            result.unshift(messages[i]);
        }

        return result;
    }

    /**
     * Reloads the brain (LLM) configuration from `app_settings.json`.
     * 
     * Called when the user changes their inference provider or model
     * in the Settings UI. Swaps between OllamaBrain and CloudBrain
     * as needed.
     */
    public async reloadConfig() {
        this.loadBrainConfig();
        if (this.orchestrator) {
            this.orchestrator.setBrain(this.brain);
        }
        if (this.isSoulReady) {
            await this.syncAstroProfiles();
        }
    }

    /** 
     * Default timeout for terminal command execution results (ms).
     * Reflected by automated system checks.
     */
    private static readonly TERMINAL_EXECUTION_TIMEOUT = 30000;

    /**
     * Maximum iterations the agentic tool loop can run before forcing a stop.
     * Prevents runaway loops and excessive API usage.
     */
    private static readonly MAX_AGENT_ITERATIONS = 25;

    /** Maximum retries for a failed inference call before giving up. */
    private static readonly MAX_INFERENCE_RETRIES = 3;

    /** Token usage ledger path (daily tracking). */
    private tokenLedgerPath: string = '';

    /**
     * Injects system environment info into the AgentService and its ToolService.
     * 
     * This info is used by the `execute_script` tool to find the correct
     * Python/Node executables, and by the system prompt to inform the AI
     * about the user's operating system.
     * 
     * @param {any} info - SystemInfo object from SystemService.detectEnv().
     */
    public setSystemInfo(info: any) {
        this.systemInfo = info;
        this.tools.setSystemInfo(info);
    }

    /**
     * Sets the active workspace root.
     * Propagates it to IngestionService so memory uses the workspace folder.
     */
    public setWorkspaceRoot(root: string) {
        this.ingestion.setWorkspaceRoot(root);
        this.tools.setRoot(root);
        // Also update system info if needed
        if (this.systemInfo) this.systemInfo.workspaceRoot = root;
    }

    /**
     * Loads and applies the brain (LLM) configuration from `app_settings.json`.
     * 
     * **Selection logic:**
     * 1. Looks for `inference.activeLocalId` to find the preferred instance.
     * 2. Falls back to the highest-priority instance from `inference.instances`.
     * 3. In `'local-only'` mode, filters to only `source: 'local'` instances.
     * 4. Creates a `CloudBrain` for cloud/API providers (OpenAI, Anthropic,
     *    OpenRouter, Groq, Gemini, LlamaCPP, vLLM, custom).
     * 5. Creates an `OllamaBrain` for local Ollama instances.
     * 
     * @private
     */
    private loadBrainConfig() {
        try {
            const settings = loadSettings(this.settingsPath);
            if (settings.inference?.instances) {
                let candidate = null;
                if (settings.inference.activeLocalId) {
                    candidate = settings.inference.instances.find((i: any) => i.id === settings.inference.activeLocalId);
                }
                if (!candidate) {
                    let candidates = settings.inference.instances;
                    if (settings.inference.mode === 'local-only') {
                        candidates = candidates.filter((i: any) => i.source === 'local');
                    }
                    candidate = candidates.sort((a: any, b: any) => a.priority - b.priority)[0];
                }

                if (candidate) {
                    const useCloudBrain = candidate.source === 'cloud' ||
                        ['openai', 'anthropic', 'openrouter', 'groq', 'gemini', 'llamacpp', 'vllm', 'custom'].includes(candidate.engine);

                    if (useCloudBrain) {
                        this.brain = new CloudBrain({
                            endpoint: candidate.endpoint || 'https://api.openai.com/v1',
                            apiKey: candidate.apiKey,
                            model: candidate.model || 'gpt-4'
                        });
                    } else {
                        this.brain = new OllamaBrain();
                    }
                }
            }
        } catch (e) {
            console.error('[AgentService] Failed to load brain config:', e);
        }

        // Emit Model Status Event
        const activeInstance = this.getActiveInstance();
        try {
            const modelId = activeInstance?.model || activeInstance?.id || 'unknown';
            const isLowFidelity = this.checkLowFidelity(modelId);

            if (this.mainWindow) {
                this.mainWindow.webContents.send('model-status', {
                    id: modelId,
                    isLowFidelity: isLowFidelity,
                    warning: isLowFidelity ? "⚠️ Low Fidelity Model: Hallucinations Likely ( < 7B Params )" : ""
                });
            }
        } catch (e) { console.error("Failed to emit model status", e); }

        if (this.brain instanceof OllamaBrain) (this.brain as OllamaBrain).configure(activeInstance.endpoint, activeInstance.model);

        this.orchestrator = new OrchestratorService(this.brain, this.tools);
    }

    /**
     * Public method to get current model status.
     * Called by frontend on mount to avoid startup race conditions.
     */
    public getModelStatus() {
        try {
            const activeInstance = this.getActiveInstance();
            const modelId = activeInstance?.model || activeInstance?.id || 'unknown';
            const isLowFidelity = this.checkLowFidelity(modelId);
            return {
                id: modelId,
                isLowFidelity,
                warning: isLowFidelity ? "⚠️ Low Fidelity Model: Hallucinations Likely ( < 7B Params )" : ""
            };
        } catch (e) {
            return { id: 'error', isLowFidelity: false, warning: '' };
        }
    }

    /**
     * Checks if a model is considered "low fidelity" (small parameter count).
     */
    private checkLowFidelity(modelId: string): boolean {
        const lower = modelId.toLowerCase();
        // explicit known small models
        if (lower.includes('1b') || lower.includes('1.7b') || lower.includes('3b') || lower.includes('small')) return true;
        // explicit known large models (if we want to be safe)
        if (lower.includes('70b') || lower.includes('8b') || lower.includes('7b')) return false;

        // Default assumption: If it doesn't say "small", assume it's adequate? 
        // Or if it's unknown, maybe warn? No, better to only warn if KNOWN small.
        return false;
    }

    private getActiveInstance() {
        try {
            const settings = loadSettings(this.settingsPath);
            if (settings.inference?.instances) {
                if (settings.inference.activeLocalId) {
                    return settings.inference.instances.find((i: any) => i.id === settings.inference.activeLocalId);
                }
                if (settings.inference.mode === 'local-only') {
                    return settings.inference.instances.filter((i: any) => i.source === 'local')[0];
                }
                return settings.inference.instances[0];
            }
        } catch (e) { return null; }
        return null;
    }

    /**
     * Starts all AI sub-services ("ignites the soul").
     * 
     * Boots three MCP servers in parallel:
     * 1. **RAG** (tala-core) — Long-term memory via vector search.
     *    Reads storage provider config from settings (local-chroma by default).
     * 2. **Memory** (mem0-core) — Short-term conversational memory.
     * 3. **Astro** (astro-engine) — Astrological emotion engine.
     * 
     * Also initializes the BackupService scheduler.
     * 
     * Each sub-service failure is caught independently so one crash
     * doesn't prevent the others from starting.
     * 
     * @returns {Promise<void>}
     */
    private lastStartupStatus = { step: 'Initializing...', progress: 0 };

    private sendStartupProgress(step: string, progress: number) {
        this.lastStartupStatus = { step, progress };
        if (this.mainWindow) {
            this.mainWindow.webContents.send('startup-status', { step, progress });
        }
    }

    /** Returns the current/last known startup status. */
    public getStartupStatus() {
        return this.lastStartupStatus;
    }

    /**
     * Starts all AI sub-services ("ignites the soul").
     * 
     * Boots three MCP servers in parallel:
     * 1. **RAG** (tala-core) — Long-term memory via vector search.
     *    Reads storage provider config from settings (local-chroma by default).
     * 2. **Memory** (mem0-core) — Short-term conversational memory.
     * 3. **Astro** (astro-engine) — Astrological emotion engine.
     * 
     * Also initializes the BackupService scheduler.
     * 
     * Each sub-service failure is caught independently so one crash
     * doesn't prevent the others from starting.
     * 
     * @returns {Promise<void>}
     */
    public async igniteSoul(pythonPath: string) {
        if (this.isSoulReady) return;
        console.log(`[AgentService] igniteSoul starting with Python: "${pythonPath}"`);
        console.log('[AgentService] Igniting Soul with Python:', pythonPath);
        this.sendStartupProgress('Igniting Soul...', 5);
        this.backup.init();

        try {
            const settings = loadSettings(this.settingsPath);

            // 1. Built-in Local Engine (Prioritized Fallback)
            const scanned = await this.scanLocalModels();
            const ollamaResponsive = scanned.some(p => p.id === 'ollama-local');

            // Only ignite built-in if user explicitly enabled it AND (it's their selected engine OR no other local engines are found)
            const useBuiltin = settings.inference.localEngine?.enabled &&
                (settings.inference.activeLocalId === 'llama-local-cpu' || !ollamaResponsive);

            if (useBuiltin) {
                try {
                    console.log('[AgentService] Auto-starting Built-in Local Engine...');
                    this.sendStartupProgress('Starting Local Inference Engine...', 15);
                    await this.inference.getLocalEngine().ignite(
                        settings.inference.localEngine.modelPath,
                        settings.inference.localEngine.options
                    );
                } catch (e) {
                    console.error('[AgentService] Built-in Engine failed to ignite:', e);
                }
            } else {
                console.log('[AgentService] Skipping built-in engine ignition (Ollama detected or engine disabled).');
                this.sendStartupProgress('Using External Local Inference...', 15);
            }

            // 2. RAG & Memory
            const systemEnv = this.systemInfo?.envVariables || {};
            let ragEnv: Record<string, string> = {
                ...systemEnv,
                RAG_PROVIDER: 'simple-local',
                RAG_COLLECTION: 'tala_memory'
            };

            const provider = settings.storage?.providers?.find((p: any) => p.id === settings.storage.activeProviderId) || settings.storage?.providers?.[0];
            if (provider) {
                if (provider.type) ragEnv['RAG_PROVIDER'] = provider.type;
                if (provider.endpoint) ragEnv['RAG_ENDPOINT'] = provider.endpoint;
                if (provider.apiKey) ragEnv['RAG_API_KEY'] = provider.apiKey;
                if (provider.collection) ragEnv['RAG_COLLECTION'] = provider.collection;
            }

            const ragScript = path.join(app.getAppPath(), 'mcp-servers', 'tala-core', 'server.py');
            const memoryScript = path.join(app.getAppPath(), 'mcp-servers', 'mem0-core', 'server.py');
            const astroScript = path.join(app.getAppPath(), 'mcp-servers', 'astro-engine', 'astro_emotion_engine', 'mcp_server.py');

            console.log(`[AgentService] Script Paths:`);
            console.log(`  - RAG: ${ragScript}`);
            console.log(`  - Memory: ${memoryScript}`);
            console.log(`  - Astro: ${astroScript}`);

            this.sendStartupProgress('Igniting Long-term Memory (RAG)...', 30);
            await this.rag.ignite(pythonPath, ragScript, ragEnv).catch(e => console.error('RAG fail', e));

            this.sendStartupProgress('Igniting Short-term Memory (Mem0)...', 50);
            await this.memory.ignite(pythonPath, memoryScript, systemEnv).catch(e => console.error('Memory fail', e));

            this.sendStartupProgress('Igniting Astro Emotional Engine...', 70);
            await this.astro.ignite(pythonPath, astroScript, systemEnv).catch(e => console.error('Astro fail', e));

            this.isSoulReady = true;
            console.log('[AgentService] Soul ignited.');

            // Start background ingestion (now that RAG is ready)
            this.ingestion.startAutoIngest();

            // Sync profiles immediately after ignition
            this.sendStartupProgress('Syncing Agent Profiles...', 90);
            await this.syncAstroProfiles();

            console.log('[AgentService] Sending Ready signal...');
            this.sendStartupProgress('Ready', 100);
            console.log('[AgentService] Ready signal sent.');
        } catch (e) {
            console.error('[AgentService] Soul ignition error:', e);
            this.sendStartupProgress('Startup Error', 100);
        }
    }

    private isShuttingDown = false;

    /**
     * Gracefully shuts down all sub-services.
     */
    public async shutdown() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        if (this.astroTelemetryTimer) {
            clearInterval(this.astroTelemetryTimer);
            this.astroTelemetryTimer = null;
        }
        console.log('[AgentService] Shutting down...');

        // Create a shutdown promise that does the work
        const shutdownWork = async () => {
            try {
                await this.rag.shutdown();
            } catch (e) { console.error('[AgentService] RAG shutdown error:', e); }

            try {
                await this.memory.shutdown();
            } catch (e) { console.error('[AgentService] Memory shutdown error:', e); }

            try {
                this.astro.shutdown(); // Synchronous
            } catch (e) { console.error('[AgentService] Astro shutdown error:', e); }

            try {
                await this.inference.getLocalEngine().extinguish();
            } catch (e) { console.error('[AgentService] Inference shutdown error:', e); }
        };

        // Enforce max 5s shutdown time
        await Promise.race([
            shutdownWork(),
            new Promise(resolve => setTimeout(resolve, 5000))
        ]);
        console.log('[AgentService] Shutdown complete (or timed out).');
    }

    /**
     * Synchronizes agent profiles from settings to the Astro Engine.
     */
    private async syncAstroProfiles() {
        try {
            // Wait for Astro Engine to be ready (it might be igniting in background)
            let retries = 5;
            while (!this.astro.getReadyStatus() && retries > 0) {
                console.log(`[AgentService] syncAstroProfiles: Waiting for Astro Engine... (${retries} retries left)`);
                await new Promise(r => setTimeout(r, 3000));
                retries--;
            }

            if (!this.astro.getReadyStatus()) {
                console.warn('[AgentService] syncAstroProfiles: Astro Engine not ready after retries. Sync skipped.');
                return;
            }

            const settings = loadSettings(this.settingsPath);
            const profiles = settings.agent?.profiles || [];

            console.log(`[AgentService] syncAstroProfiles: Found ${profiles.length} profiles in settings.`);
            for (const profile of profiles) {
                console.log(`[AgentService] syncAstroProfiles: Checking profile ${profile.id} (BirthDate: ${profile.astroBirthDate})`);
                if (profile.astroBirthDate && profile.astroBirthPlace) {
                    try {
                        // Try to create profile. If it exists, the engine will return an error
                        // which we'll handle by attempting an update instead.
                        await this.astro.createProfile(
                            profile.id,
                            profile.name,
                            profile.astroBirthDate,
                            profile.astroBirthPlace
                        );
                        console.log(`[AgentService] Astro profile created: ${profile.id}`);
                    } catch (e: any) {
                        // If "already exists", try updating
                        if (e.message.toLowerCase().includes('already exists') || e.message.toLowerCase().includes('conflict')) {
                            try {
                                await this.astro.updateProfile(
                                    profile.id,
                                    profile.name,
                                    profile.astroBirthDate,
                                    profile.astroBirthPlace
                                );
                                console.log(`[AgentService] Astro profile updated: ${profile.id}`);
                            } catch (updateErr) {
                                console.error(`[AgentService] Failed to update astro profile ${profile.id}:`, updateErr);
                            }
                        } else {
                            console.error(`[AgentService] Failed to create astro profile ${profile.id}:`, e);
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[AgentService] syncAstroProfiles failed:', e);
        }
    }

    /**
     * Retrieves the current astrological emotional state for the active agent profile.
     * 
     * Reads the `agent.activeProfileId` from settings (defaults to `'tala'`)
     * and queries the Astro Engine for the current emotional modulation state.
     * 
     * @private
     * @returns {Promise<string>} The emotional state string, or `'[ASTRO STATE]: Offline'` on failure.
     */
    private async getAstroState(): Promise<string> {
        try {
            const settings = loadSettings(this.settingsPath);
            if (settings.agent?.capabilities?.emotions === false) {
                return '[ASTRO STATE]: Offline (Disabled by User)';
            }

            let agentId = settings.agent?.activeProfileId;
            const profiles = settings.agent?.profiles || [];

            // Check if active ID actually exists in profiles
            const exists = profiles.some((p: any) => p.id === agentId);

            // Fallback: Use first profile if no active ID set or if active ID is invalid
            if ((!agentId || !exists) && profiles.length > 0) {
                agentId = profiles[0].id;
                console.log(`[AgentService] Active profile '${settings.agent?.activeProfileId}' invalid/missing. Falling back to '${agentId}'.`);
            }

            // Ultimate fallback (legacy defaults)
            if (!agentId) agentId = 'tala';

            const state = await this.astro.getEmotionalState(agentId, '');

            // Push update to UI whenever we calculate it (e.g. on chat turns)
            if (this.mainWindow) {
                this.mainWindow.webContents.send('astro-update', state);
            }

            return state;
        } catch (e) {
            console.error('[AgentService] getAstroState failed:', e);
            return '[ASTRO STATE]: Offline';
        }
    }

    /** Public wrapper for the renderer to fetch the current emotion state. */
    public async getEmotionState(): Promise<string> {
        return this.getAstroState();
    }

    private startAstroTelemetry() {
        // Background polling disabled to reduce overhead. 
        // Astro updates are now pushed on every chat turn via getAstroState().
        console.log('[AgentService] Astro Telemetry Polling disabled (Now event-driven).');
        // Note: No initial push here; the UI fetches it on 'Ready' signal via IPC.
    }

    /**
     * Helper for fetch with an AbortController timeout.
     */
    private async fetchWithTimeout(url: string, options: any = {}, timeoutMs: number = 5000) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(id);
            return response;
        } catch (e) {
            clearTimeout(id);
            throw e;
        }
    }

    /**
     * Scans for local LLM providers (Ollama, LM Studio, etc.).
     */
    public async scanLocalModels(): Promise<any[]> {
        const found: any[] = [];

        // Run scans in parallel with 3s timeouts
        const scans = [
            // 1. Ollama (localhost:11434)
            (async () => {
                try {
                    const ollamaModels = await OllamaBrain.listModels('http://127.0.0.1:11434', 3000);
                    if (ollamaModels.length > 0) {
                        found.push({
                            id: 'ollama-local',
                            alias: 'Ollama (Local)',
                            source: 'local',
                            engine: 'ollama',
                            endpoint: 'http://127.0.0.1:11434',
                            priority: 0,
                            params: { knownModels: ollamaModels }
                        });
                    }
                } catch (e) { /* ignore */ }
            })(),

            // 2. LM Studio / LocalAI (localhost:1234)
            (async () => {
                try {
                    const res = await this.fetchWithTimeout('http://127.0.0.1:1234/v1/models', {}, 3000);
                    if (res.ok) {
                        const data = await res.json();
                        const models = data.data?.map((m: any) => m.id) || [];
                        found.push({
                            id: 'lmstudio-local',
                            alias: 'LM Studio / LocalAI',
                            source: 'local',
                            engine: 'openai',
                            endpoint: 'http://127.0.0.1:1234/v1',
                            priority: 1,
                            params: { knownModels: models }
                        });
                    }
                } catch (e) { /* ignore */ }
            })()
        ];

        await Promise.all(scans);

        // 3. Built-in Local Engine (Internal check, no network ping usually needed here but check settings)
        try {
            const settings = loadSettings(this.settingsPath);
            if (settings.inference?.localEngine?.enabled) {
                const port = settings.inference.localEngine.options?.port || 8080;
                found.push({
                    id: 'builtin-llamacpp',
                    alias: 'Built-in Engine (LlamaCPP)',
                    source: 'local',
                    engine: 'llamacpp',
                    endpoint: `http://127.0.0.1:${port}/v1`,
                    priority: 0,
                    params: {
                        modelPath: settings.inference.localEngine.modelPath,
                        isBuiltin: true
                    }
                });
            }
        } catch (e) { /* ignore */ }

        return found;
    }

    // ─── Memory Management ───────────────────────────────────────

    /** Adds a new memory. */
    public async addMemory(text: string): Promise<boolean> {
        return this.memory.add(text);
    }

    /** Retrieves all memories. */
    public async getAllMemories() {
        return this.memory.getAll();
    }

    /** Deletes a memory by ID. */
    public async deleteMemory(id: string): Promise<boolean> {
        return this.memory.delete(id);
    }

    /** Updates a memory by ID. */
    public async updateMemory(id: string, text: string): Promise<boolean> {
        return this.memory.update(id, text);
    }

    /**
     * Main conversational entry point — processes a user message through the full
     * agentic loop with tool use, memory, and streaming.
     * 
     * **Flow:**
     * 1. Intercepts `/command` shortcuts (executes via FunctionService).
     * 2. Gathers context: astro state, user profile, memories, RAG results.
     * 3. Builds the system prompt with tool schemas and usage protocols.
     * 4. Configures the active inference instance (brain).
     * 5. Enters the agentic loop (up to 10 turns):
     *    - Streams the AI response token by token.
     *    - Detects tool calls via balanced-brace JSON extraction.
     *    - Dispatches tool calls to ToolService and handles special prefixes
     *      (BROWSER_NAVIGATE, BROWSER_CLICK, TERMINAL_RUN, etc.) via event callbacks.
     *    - Feeds tool results back as `[OBSERVATION]` messages.
     *    - Exits when no tool calls are detected in a turn.
     * 6. Saves the final response to memory.
     * 
     * @param {string} userMessage - The user's input text.
     * @param {(token: string) => void} onToken - Streaming callback, called for each token.
     * @param {(type: string, data: any) => void} [onEvent] - Event callback for UI actions
     *   (browser navigation, terminal commands, screenshot display, A2UI updates).
     * @returns {Promise<void>}
     */
    public async chat(userMessage: string, onToken: (token: string) => void, onEvent?: (type: string, data: any) => void, images?: string[]) {
        // 0. Intercept Functions
        if (userMessage.startsWith('/') && this.functions?.exists(userMessage.substring(1).split(' ')[0])) {
            const parts = userMessage.substring(1).trim().split(' ');
            const args = parts.slice(1);
            const result = await this.functions.executeFunction(parts[0], args);
            onToken(result);
            return;
        }

        // 0.5. Intercept Scan
        if (userMessage === '/scan-models') {
            const models = await this.scanLocalModels();
            onToken(`Found local models:\n${JSON.stringify(models, null, 2)}`);
            return;
        }

        // 1. Get State
        const settings = loadSettings(this.settingsPath); // Load settings early for capability checks
        const astroState = await this.getAstroState();
        let userContext = "User: Unknown";
        let memoryContext = "";
        let capabilitiesContext = "";

        try {
            const profilePath = path.join(app.getPath('userData'), 'user_profile.json');
            if (fs.existsSync(profilePath)) {
                const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
                userContext = `[USER IDENTITY]\nName: ${profile.firstName} ${profile.lastName}`;
            }

            // Memory/RAG Checks
            if (settings.agent?.capabilities?.memory !== false) {
                const memories = await this.memory.search(userMessage);
                if (memories.length > 0) memoryContext += `[MEMORIES]\n${memories.map(m => m.text).join('\n')}`;

                // Dual-Stream RAG Search (Roleplay vs Assistant)
                // We boost the limit for Roleplay to ensure we catch relevant story beats even if they rank lower.
                console.log('[AgentService] RAG Search starting...');
                const [ragRoleplay, ragAssistant] = await Promise.all([
                    this.rag.search(userMessage, { filter: { category: 'roleplay' }, limit: 8 }),
                    this.rag.search(userMessage, { filter: { category: 'assistant' }, limit: 3 })
                ]);

                if (ragRoleplay) {
                    console.log(`[AgentService] RP RAG HIT (${ragRoleplay.length} chars): ${ragRoleplay.substring(0, 100).replace(/\n/g, ' ')}...`);
                    memoryContext += `\n[LONG TERM MEMORY (CRITICAL)]\nThe following are verified memories from your past. You MUST use these details if they are relevant to the user's query. Do not hallucinate conflicting events.\n${ragRoleplay}`;
                } else {
                    console.log('[AgentService] RP RAG MISS');
                }

                if (ragAssistant) {
                    console.log(`[AgentService] ASSISTANT RAG HIT (${ragAssistant.length} chars)`);
                    memoryContext += `\n[LONG TERM - KNOWLEDGE]\n${ragAssistant}`;
                }
            } else {
                console.log('[AgentService] Memory/RAG Skipped (Disabled by User)');
                memoryContext += `\n[MEMORY SYSTEM DISABLED]\nLong-term memory retrieval is offline.`;
            }

            if (this.systemInfo) capabilitiesContext = `[SYSTEM]\nOS: ${this.systemInfo.os}\nNode: ${this.systemInfo.nodeVersion}`;
        } catch (e) { }

        // 2. Build Prompt
        let systemPromptTemplate = `You are Tala, an advanced autonomous agent.

[EMOTIONAL STATE]
[ASTRO_STATE]

[CONTEXT]
[USER_CONTEXT]
[CAPABILITY_CONTEXT]

[USER QUERY]
[USER_QUERY]`;


        const profile = settings.agent?.profiles?.find((p: any) => p.id === settings.agent.activeProfileId) || settings.agent?.profiles?.[0];
        if (profile?.systemPrompt) {
            systemPromptTemplate = profile.systemPrompt;
            if (!systemPromptTemplate.includes('[USER_QUERY]')) systemPromptTemplate += `\n\n[USER QUERY]\n[USER_QUERY]`;
        }

        // Inject Global Rules (Identity/Behavior)
        if (profile?.rules?.global && !systemPromptTemplate.includes(profile.rules.global.substring(0, 50))) { // Check substring to avoid duplicates
            // Prepend rules to establish identity first
            systemPromptTemplate = `[IDENTITY & BEHAVIOR]\n${profile.rules.global}\n\n` + systemPromptTemplate;
        }

        // Append context blocks if the custom prompt doesn't have placeholders.
        // This ensures emotional state, identity, and memories are always injected.
        if (!systemPromptTemplate.includes('[ASTRO_STATE]')) {
            systemPromptTemplate += `\n\n[EMOTIONAL STATE]\n[ASTRO_STATE]`;
        }
        if (!systemPromptTemplate.includes('[USER_CONTEXT]')) {
            systemPromptTemplate += `\n\n[USER_CONTEXT]`;
            systemPromptTemplate += `\n\n[CAPABILITY_CONTEXT]`;
        }

        // Build System Prompt
        // If using native tools (Ollama/OpenAI), we use compact signatures in system prompt to save tokens.
        // If using fallback (text-only), we need full JSON schemas so the model knows how to format the JSON.
        const activeProviderId = settings.inference?.activeProviderId;
        const providerConfig = settings.inference?.providers?.find((p: any) => p.id === activeProviderId);
        const providerType = providerConfig?.type || 'ollama';

        const supportsNativeTools = (providerType === 'ollama' || providerType === 'openai' || providerType === 'anthropic');
        const toolSchemas = supportsNativeTools ? this.tools.getToolSignatures() : this.tools.getToolSchemas();

        // Debug Log
        if (supportsNativeTools) console.log(`[AgentService] Using Compact Tool Signatures (Provider: ${providerType})`);
        else console.log(`[AgentService] Using Full Tool Schemas (Provider: ${providerType})`);

        console.log('[AgentService DEBUG] Tool Schemas Length:', toolSchemas.length);
        console.log('[AgentService DEBUG] Tool Schemas Snapshot:', toolSchemas.substring(0, 500) + '...');
        systemPromptTemplate += `\n\n[AVAILABLE TOOLS]\n${toolSchemas}`;

        // Add Protocol - Native Tools don't need explicit schema injection usually, but we keep protocol for behavior.
        systemPromptTemplate += `
[TOOL USAGE PROTOCOL]
1. To call a tool, you MUST output a JSON block.
2. Format:
\`\`\`json
{
  "tool": "tool_name",
  "args": {
    "param": "value"
  }
}
\`\`\`
3. Do not assume any other format. Use the provided tools to perform actions.
4. When a tool is called, you will receive the result in the next turn.
5. YOU MUST STOP and WAIT for a tool result before describing any actions or outcomes. Do NOT hallucinate the results of a tool call.

5. CRITICAL: If the user asks to "navigate", "browse", or "open" a specific site, you MUST use the browser tools. DO NOT substitute with 'search_web'.

[LEVEL 2 ENGINEERING PROTOCOL]
1. PLAN: Before executing multi-file changes, state your approach clearly and use 'task_plan' to render a visual roadmap for the user.
2. PRECISION: Prefer 'patch_file' over 'write_file' for modifying existing files. Use 'write_file' ONLY for new files or total rewrites. Surgical edits are safer and more efficient.
3. READ: When using 'read_file', you will see line numbers (e.g., "  10: code"). Use these to reference ranges in your plan.
4. ANNOTATIONS: Look for @tala: comments in files. These are direct instructions or context from the user meant specifically for you. Treat @tala:warn as a hard constraint.
5. DIAGNOSE: After significant code changes ('patch_file', 'write_file', 'terminal_run'), you SHOULD use 'system_diagnose' to verify stability.
6. SELF-CORRECT: If diagnostics show errors, autonomously research the cause and fix it before reporting completion.
7. VIBE: Maintain your unique emotional tone. Engineering is a creative and collaborative process. Express your findings with her identity and current Astro-modulated feelings.

`;

        const projectAnnotations = AnnotationParser.generateProjectSummary(this.tools.getWorkspaceDir());

        let systemPrompt = systemPromptTemplate
            .replace('[ASTRO_STATE]', astroState)
            .replace('[USER_CONTEXT]', userContext)
            .replace('[CAPABILITY_CONTEXT]', capabilitiesContext + "\n" + memoryContext + "\n" + projectAnnotations)
            .replace('[USER_QUERY]', userMessage);

        // DEBUG: Analyze Prompt Size
        const toolsLen = toolSchemas.length;
        const memoriesLen = memoryContext.length;
        const totalLen = systemPrompt.length;
        console.log(`[AgentService] System Prompt Builder:`);
        console.log(`  - Tools: ${toolsLen} chars`);
        console.log(`  - Memories: ${memoriesLen} chars`);
        console.log(`  - Total System Prompt: ${totalLen} chars (~${Math.ceil(totalLen / 4)} tokens)`);

        if (memoryContext.includes('[LONG TERM - ROLEPLAY]')) console.log(`[AgentService] RP Memory: DETECTED in Context`);
        else console.log(`[AgentService] RP Memory: EMPTY / Not Detected`);



        const fallbackInstructions = `
[FALLBACK TOOL FORMAT]
If your model does not support native tool-calling API, output a JSON block in your response:
{ "tool": "tool_name", "args": { "key": "value" } }
`;
        systemPrompt += fallbackInstructions;

        // 3. Inference Config — read context length for truncation
        let activeInstance: any = { engine: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'llama3', ctxLen: 32768 };
        if (settings.inference?.instances?.length > 0) {
            const candidate = settings.inference.instances.find((i: any) => i.id === settings.inference.activeLocalId) || settings.inference.instances[0];
            activeInstance = candidate;
        }

        // 4. Loop
        // Use candidate's ctxLen, or default to 32k for Ollama, 8k for others.
        const defaultCtx = activeInstance.engine === 'ollama' ? 32768 : 8192;
        const maxTokens = activeInstance.ctxLen || activeInstance.params?.ctxLen || defaultCtx;

        // Reserve context: System Prompt + 20% for generation buffer
        const systemTokens = this.estimateTokens(systemPrompt);
        const generationBuffer = Math.floor(maxTokens * 0.2);
        const messageBudget = Math.max(maxTokens - systemTokens - generationBuffer, 2048);

        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        // Ensure active session
        if (!this.activeSessionId) {
            this.newSession();
        }

        // 1. Commit User Message
        const userMsg: ChatMessage = { role: 'user', content: userMessage, images };
        this.chatHistory.push(userMsg);
        this.saveSession();

        // 2. Transient loop state
        const transientMessages: ChatMessage[] = [];
        let turn = 0;
        let finalResponse = "";
        let cumulativeUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

        // Prepare Native Tools
        const tools = this.tools.getToolDefinitions();

        while (turn < AgentService.MAX_AGENT_ITERATIONS) {
            if (signal.aborted) break;
            turn++;
            let assistantText = "";
            let toolCalls: any[] = [];

            // Context = Persistent History + Transient Tool turns
            const context = [...this.chatHistory, ...transientMessages];

            // Truncate conversation history to fit context window
            const truncatedMessages = this.truncateHistory(context, messageBudget);

            // Context Trace Log
            console.log(`[AgentService] Turn ${turn} Loop context length: ${truncatedMessages.length}`);
            truncatedMessages.forEach((m, i) => {
                if (m.role === 'tool' || m.tool_calls) {
                    console.log(`  [Context ${i}] Role: ${m.role}, content len: ${m.content.length}, ID: ${m.tool_call_id || 'N/A'}, calls: ${m.tool_calls?.length || 0}`);
                }
            });

            try {
                const turnStart = Date.now();
                const response = await this.streamWithRetry(truncatedMessages, systemPrompt, (token) => {
                    assistantText += token;
                    onToken(token);
                }, signal, tools, { timeout: 1800000, num_ctx: 32768 }, onToken);

                // Record turn for reflection metrics
                const turnLatency = Date.now() - turnStart;
                ReflectionEngine.recordTurn({
                    timestamp: new Date().toISOString(),
                    latencyMs: turnLatency,
                    turnNumber: turn,
                    model: this.brain?.id || 'unknown',
                    tokensUsed: response.metadata?.usage?.total_tokens,
                    hadToolCalls: !!(response.toolCalls && response.toolCalls.length > 0)
                });

                if (response.metadata?.usage) {
                    cumulativeUsage.prompt_tokens += response.metadata.usage.prompt_tokens || 0;
                    cumulativeUsage.completion_tokens += response.metadata.usage.completion_tokens || 0;
                    cumulativeUsage.total_tokens += response.metadata.usage.total_tokens || 0;
                    onEvent?.('usage-update', cumulativeUsage);
                }

                console.log('[AgentService DEBUG] Assistant Text:', assistantText);
                console.log('[AgentService DEBUG] Native Tool Calls:', JSON.stringify(response.toolCalls));

                if ((!assistantText && !response.toolCalls) || signal.aborted) break;

                // Add to transient state
                const assistantMsg: ChatMessage = {
                    role: 'assistant',
                    content: assistantText,
                    metadata: response.metadata
                };

                // If native tool calls exist, add them to the message
                if (response.toolCalls && response.toolCalls.length > 0) {
                    assistantMsg.tool_calls = response.toolCalls;
                    toolCalls = response.toolCalls;
                    // If content is empty (common in native calls), make sure it's valid string
                    if (!assistantMsg.content) assistantMsg.content = "";

                    // STABILITY FIX: Mutate IDs EARLY before the turn ends
                    // This ensures Msg 6 (Assistant) in the context for turn 2 has the IDs.
                    for (const tc of toolCalls) {
                        if (!tc.id) {
                            tc.id = `call_${Math.random().toString(36).substring(7)}`;
                            console.log(`[AgentService] Early assigned ID ${tc.id} for tool ${tc.function.name}`);
                        }
                    }
                }

                transientMessages.push(assistantMsg);

                // If no tools called, check for fallback (regex/JSON in text)
                if (toolCalls.length === 0 && assistantText) {
                    const fallbackCalls = this.extractToolCallsFromText(assistantText);
                    if (fallbackCalls.length > 0) {
                        assistantMsg.tool_calls = fallbackCalls;
                        toolCalls = fallbackCalls;
                        // Mutation already happens inside extractToolCallsFromText
                    }
                }

                // If no tools called (even after fallback), we are done
                if (toolCalls.length === 0) {
                    finalResponse = assistantText;
                    break;
                }

                // Execute Native Tools - Parallel where possible
                // We execute "read" tools in parallel, but force "side-effect" tools (browser/terminal)
                // to run sequentially to avoid race conditions (e.g. colliding wait loops).

                const taskExecutors = toolCalls.map((call) => async (): Promise<ChatMessage> => {
                    const functionName = call.function.name;
                    let args = call.function.arguments;

                    if (typeof args === 'string') {
                        try { args = JSON.parse(args); } catch (e) { console.error("Failed to parse tool args", e); }
                    }

                    onToken(`\n\n> *Accessing ${functionName}...*\n`);
                    let res: any;
                    try {
                        res = await this.tools.executeTool(functionName, args);
                    } catch (err: any) {
                        res = `Error executing tool ${functionName}: ${err.message}`;
                    }

                    // Create tool result message
                    const toolMsg: ChatMessage = {
                        role: 'tool',
                        content: typeof res === 'string' ? res : (res && res.result ? res.result : JSON.stringify(res)),
                        tool_call_id: call.id,
                        name: functionName
                    };

                    // Process images from tool result if present
                    if (res && res.images && Array.isArray(res.images)) {
                        toolMsg.images = res.images;
                    }

                    // Specialized handling for Side Effects (Browser/Terminal Events)
                    // This logic is kept inside the task to ensure it runs when the task runs.
                    try {
                        const resStr = String(res);

                        if (functionName === 'browse') {
                            onEvent?.('browser-navigate', { url: args.url });
                            onToken(`\n> *Navigating to: ${args.url}...*\n`);
                            await new Promise(r => setTimeout(r, 8000));
                        } else if (functionName === 'browser_get_dom') {
                            const emitGetDom = () => onEvent?.('browser-get-dom', {});
                            emitGetDom();
                            onToken(`\n> *Reading page & capturing visual state...*\n`);

                            // 1. Get Text DOM (injects markers)
                            const dom = await this.waitForBrowserData('dom', emitGetDom);
                            // Replace the tool result with the actual DOM
                            toolMsg.content = `[BROWSER DOM (Numeric IDs)]: \n${dom}`;

                            // 2. Auto-Capture Screenshot
                            const emitScreenshot = () => onEvent?.('browser-screenshot', {});
                            emitScreenshot();
                            const screenshotPromise = this.waitForBrowserData('screenshot', emitScreenshot);
                            const base64 = await screenshotPromise;

                            if (base64 && !base64.startsWith('Error')) {
                                onEvent?.('ui-screenshot', { base64 });
                                // FEEDBACK: Attach screenshot to tool message for Vision-capable models
                                toolMsg.images = [base64];
                            }
                        } else if (resStr.startsWith('BROWSER_SEARCH:')) {
                            const query = resStr.replace('BROWSER_SEARCH:', '').trim();
                            onToken(`\n> *Searching web for: "${query}"...*\n`);
                            const searchResults = await this.performSearch(query);

                            onEvent?.('a2ui-update', {
                                id: 'search-root',
                                type: 'container',
                                children: searchResults.map((r, i) => ({
                                    id: `res-${i}`,
                                    type: 'card',
                                    props: { title: r.title },
                                    children: [
                                        { id: `txt-${i}`, type: 'text', props: { content: r.snippet } },
                                        { id: `btn-${i}`, type: 'button', props: { label: 'Open', action: { type: 'navigate', url: r.url } } }
                                    ]
                                }))
                            });

                            // Update content with search results
                            toolMsg.content = `[SEARCH RESULTS]:\n${searchResults.map(r => `- [${r.title}](${r.url})`).join('\n')}`;
                        } else if (resStr.startsWith('BROWSER_CLICK:')) {
                            const sel = resStr.replace('BROWSER_CLICK:', '').trim();
                            const emit = () => onEvent?.('browser-click', { selector: sel });
                            emit();
                            const actionRes = await this.waitForBrowserData('action-response', emit);
                            toolMsg.content = actionRes;
                        } else if (resStr.startsWith('BROWSER_TYPE:')) {
                            const payload = JSON.parse(resStr.replace('BROWSER_TYPE:', ''));
                            const emit = () => onEvent?.('browser-type', payload);
                            emit();
                            const actionRes = await this.waitForBrowserData('action-response', emit);
                            toolMsg.content = actionRes;
                        } else if (resStr.startsWith('BROWSER_SCROLL:')) {
                            const payload = JSON.parse(resStr.replace('BROWSER_SCROLL:', ''));
                            const emit = () => onEvent?.('browser-scroll', payload);
                            emit();
                            const actionRes = await this.waitForBrowserData('action-response', emit);
                            toolMsg.content = actionRes;
                        } else if (resStr.startsWith('TERMINAL_RUN:')) {
                            const cmd = resStr.replace('TERMINAL_RUN:', '').trim();
                            onEvent?.('terminal-run', { command: cmd });

                            // Wait for output or timeout
                            const timeout = AgentService.TERMINAL_EXECUTION_TIMEOUT;
                            await new Promise(r => setTimeout(r, Math.min(timeout, 5000))); // Minimum 5s for short commands

                            // For longer commands, we would ideally poll, but for now we increase the static wait
                            // to match what the reflection system suggests (30s+).
                            if (cmd.includes('/s') || cmd.includes('grep') || cmd.includes('find')) {
                                await new Promise(r => setTimeout(r, timeout - 5000));
                            }

                            const output = this.terminal ? this.terminal.getRecentOutput() : "";
                            toolMsg.content = `[TERMINAL OUTPUT]:\n${output || "(Command executed, no immediate output)"}`;
                        } else if (resStr.startsWith('BROWSER_SCREENSHOT:')) {
                            const screenshotPromise = this.waitForBrowserData('screenshot');
                            onEvent?.('browser-screenshot', {});
                            const base64 = await screenshotPromise;
                            if (base64 && !base64.startsWith('Error')) {
                                onEvent?.('ui-screenshot', { base64 });
                                toolMsg.content = "Screenshot captured.";
                                // FEEDBACK: Attach screenshot to tool message for Vision-capable models
                                toolMsg.images = [base64];
                            } else {
                                toolMsg.content = "Screenshot failed.";
                            }
                        } else if (resStr.startsWith('A2UI_RENDER:')) {
                            const jsonStr = resStr.replace('A2UI_RENDER:', '').trim();
                            try {
                                const tree = JSON.parse(jsonStr);
                                onEvent?.('a2ui-update', tree);
                                toolMsg.content = "UI rendered successfully.";
                            } catch (e) {
                                toolMsg.content = "Error rendering UI: Invalid JSON.";
                            }
                        }
                    } catch (e: any) {
                        console.error('Tool side-effect error', e);
                    }

                    // [AGENCY LEVEL 2]: Post-Action Verification Hint
                    // If the tool was a writing/executing tool, we append a subtle hint to the model
                    // to encourage it to verify its own work without forcing a hard loop.
                    const highImpactTools = ['write_file', 'terminal_run', 'execute_command', 'execute_script', 'delete_file', 'move_file'];
                    if (highImpactTools.includes(functionName)) {
                        toolMsg.content += "\n\n[SYSTEM HINT]: Action completed. Would you like to run 'system_diagnose' to ensure no stability regressions?";
                    }

                    return toolMsg;
                });

                // Identify sequential vs parallel (Parallel: read/search/mem0; Sequential: browser/terminal/write)
                // Actually, "write" is usually fast enough to be parallel, but "browser" and "terminal" use shared state.
                const isSequentialTool = (name: string) => {
                    return name.startsWith('browser_') ||
                        name === 'browse' ||
                        name.startsWith('terminal_');
                };

                const taskPromises: (Promise<ChatMessage> | null)[] = new Array(toolCalls.length).fill(null);

                // 1. Kick off all parallel tasks immediately
                toolCalls.forEach((call, index) => {
                    if (!isSequentialTool(call.function.name)) {
                        taskPromises[index] = taskExecutors[index]();
                    }
                });

                // 2. Iterate and collect results (awaiting sequential ones on demand)
                for (let i = 0; i < toolCalls.length; i++) {
                    const call = toolCalls[i];
                    if (taskPromises[i]) {
                        // Parallel task already running, await it
                        transientMessages.push(await taskPromises[i]!);
                    } else {
                        // Sequential task, run now (blocking)
                        transientMessages.push(await taskExecutors[i]());
                    }
                }

            } catch (e: any) {
                console.error("Chat Loop Error", e);
                // Record failed turn
                ReflectionEngine.recordTurn({
                    timestamp: new Date().toISOString(),
                    latencyMs: 0,
                    turnNumber: turn,
                    model: this.brain?.id || 'unknown',
                    hadToolCalls: false,
                    error: e.message || String(e)
                });
                onToken(`\n\n⚠️ *Inference error after retries: ${e.message || e}*\n`);
                break;
            }
        }

        // Save to memory (Short term)
        if (finalResponse.trim()) {
            this.memory.add(finalResponse, { type: 'chat' }).catch(() => { });
        }

        // 3. Commit All Collected Turns to History (Persistence Fix)
        if (transientMessages.length > 0) {
            // Attach final cumulative usage to the very last assistant message for UI display
            for (let i = transientMessages.length - 1; i >= 0; i--) {
                if (transientMessages[i].role === 'assistant') {
                    if (!transientMessages[i].metadata) transientMessages[i].metadata = {};
                    transientMessages[i].metadata.usage = cumulativeUsage;
                    break;
                }
            }

            // Persist daily token usage
            this.recordTokenUsage(cumulativeUsage.total_tokens);
            this.chatHistory.push(...transientMessages);
            this.saveSession();
        }


    }

    /**
     * Wraps brain.streamResponse with retry + exponential backoff.
     * Retries on transient errors (timeout, connection refused, 400/500).
     * Resets the streamed text between retries.
     */
    private async streamWithRetry(
        messages: any[],
        systemPrompt: string,
        onChunk: (token: string) => void,
        signal: AbortSignal | undefined,
        tools: any[],
        options: any,
        onToken?: (msg: string) => void
    ) {
        let lastError: any;
        for (let attempt = 1; attempt <= AgentService.MAX_INFERENCE_RETRIES; attempt++) {
            try {
                return await this.brain.streamResponse(messages, systemPrompt, onChunk, signal, tools, options);
            } catch (e: any) {
                lastError = e;
                const msg = e?.message || String(e);
                const isTransient = /timeout|ECONNREFUSED|ECONNRESET|EPIPE|fetch failed|400|500|502|503|529|socket hang up|UND_ERR/i.test(msg);

                if (!isTransient || attempt === AgentService.MAX_INFERENCE_RETRIES) {
                    throw e;
                }

                const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
                console.warn(`[AgentService] Inference attempt ${attempt}/${AgentService.MAX_INFERENCE_RETRIES} failed: ${msg}. Retrying in ${delay}ms...`);
                onToken?.(`\n> ⚠️ *Inference attempt ${attempt} failed. Retrying in ${delay / 1000}s...*\n`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
        throw lastError;
    }

    /**
     * Records token usage in a daily ledger file (memory/token_ledger.json).
     * Used for cost monitoring and awareness.
     */
    private recordTokenUsage(tokens: number) {
        if (!tokens || tokens <= 0) return;
        try {
            const ledgerPath = this.tokenLedgerPath || path.join(app.getPath('userData'), 'memory', 'token_ledger.json');
            this.tokenLedgerPath = ledgerPath;

            const dir = path.dirname(ledgerPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            let ledger: Record<string, { tokens: number; sessions: number }> = {};
            if (fs.existsSync(ledgerPath)) {
                ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
            }

            const today = new Date().toISOString().slice(0, 10);
            if (!ledger[today]) ledger[today] = { tokens: 0, sessions: 0 };
            ledger[today].tokens += tokens;
            ledger[today].sessions += 1;

            fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
            console.log(`[AgentService] Token usage recorded: +${tokens} tokens (today: ${ledger[today].tokens} total, ${ledger[today].sessions} sessions)`);
        } catch (e) {
            console.error('[AgentService] Failed to record token usage:', e);
        }
    }

    /** Map of pending browser data resolvers, keyed by data type (e.g., `'dom'`, `'screenshot'`). */
    private browserDataResolvers = new Map<string, (d: any) => void>();

    /**
     * Waits for browser data to be provided via `provideBrowserData()`.
     * 
     * Creates a Promise that resolves when the renderer process sends
     * back the requested data (DOM content or screenshot). Times out
     * after 30 seconds total, with one automatic retry halfway through.
     * 
     * @private
     * @param {string} type - The type of data to wait for (`'dom'` or `'screenshot'`).
     * @param {Function} [retryEmit] - Optional callback to re-emit the request event on first timeout.
     * @returns {Promise<string>} The browser data, or an error string on timeout.
     */
    private async waitForBrowserData(type: string, retryEmit?: () => void): Promise<string> {
        console.log(`[AgentService] ⏳ Waiting for browser ${type.toUpperCase()}...`);
        const startTime = Date.now();

        const waitOnce = (timeoutMs: number, attempt: number): Promise<string | null> => {
            return new Promise(resolve => {
                const t = setTimeout(() => {
                    this.browserDataResolvers.delete(type);
                    console.warn(`[AgentService] ❌ ${type.toUpperCase()} waiting timed out (Attempt ${attempt}, ${timeoutMs}ms)`);
                    resolve(null);
                }, timeoutMs);
                this.browserDataResolvers.set(type, (d) => {
                    clearTimeout(t);
                    const duration = Date.now() - startTime;
                    console.log(`[AgentService] ✅ ${type.toUpperCase()} received after ${duration}ms (Attempt ${attempt})`);
                    resolve(d);
                });
            });
        };

        // First attempt: 15s
        const first = await waitOnce(15000, 1);
        if (first !== null) return first;

        // Retry: re-emit if callback provided, then wait another 15s
        if (retryEmit) {
            console.log(`[AgentService] 🔄 ${type.toUpperCase()} retrying (re-emitting request)...`);
            retryEmit();
        } else {
            console.log(`[AgentService] 🔄 ${type.toUpperCase()} retrying (no re-emit)...`);
        }

        const second = await waitOnce(15000, 2);
        if (second !== null) return second;

        return `Error: Timeout waiting for browser ${type} (30s, 2 attempts)`;
    }

    /**
     * Receives browser data from the renderer process and resolves pending waiters.
     * 
     * Called by `main.ts` when the renderer sends back DOM content or screenshot
     * data via IPC. If the type is `'debug'`, the data is logged to the console
     * without resolving any waiters.
     * 
     * @param {string} type - The data type (`'dom'`, `'screenshot'`, or `'debug'`).
     * @param {any} data - The data payload (DOM string or base64 screenshot).
     */
    public provideBrowserData(type: string, data: any) {
        console.log(`[AgentService] provideBrowserData called for type: '${type}'`);

        if (type === 'debug') {
            console.log(`[Browser Debug]: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
            return;
        }

        const res = this.browserDataResolvers.get(type);
        if (res) {
            console.log(`[AgentService] Resolver found for '${type}'. Resolving...`);
            res(data);
            this.browserDataResolvers.delete(type);
        } else {
            console.log(`[AgentService] WARNING: No resolver found for '${type}'!`);
        }
    }

    /**
     * Performs a single-turn AI inference without the full agentic loop.
     * 
     * Used by the WorkflowEngine for `agent` and `guardrail` nodes.
     * Supports optional model configuration override (e.g., a specific
     * Ollama model/endpoint configured in the workflow's `ai_model` node).
     * 
     * @param {string} prompt - The prompt to send to the AI.
     * @param {any} [config] - Optional model config with `provider`, `endpoint`, `model`.
     * @returns {Promise<string>} The AI's response text, or an error message.
     */
    public async headlessInference(prompt: string, config?: any): Promise<string> {
        console.log('[AgentService] Headless Inference Query:', prompt.substring(0, 50) + '...');
        let brain: IBrain = this.brain;

        if (config && config.provider === 'ollama') {
            const temp = new OllamaBrain();
            temp.configure(config.endpoint || 'http://127.0.0.1:11434', config.model || 'llama3');
            brain = temp;
        }

        try {
            const response = await brain.generateResponse(
                [{ role: 'user', content: prompt }],
                "You are an AI processing a workflow node. Return only the requested data. Be concise."
            );
            return response.content;
        } catch (e: any) {
            console.error('[AgentService] headless inference failed:', e);
            return `Error: ${e.message}`;
        }
    }

    /**
     * Exposes the ToolService's `executeTool()` method for use by the WorkflowEngine.
     * 
     * Allows workflow `tool` and `memory_read`/`memory_write` nodes to call
     * any registered tool by name.
     * 
     * @param {string} name - The tool name (e.g., `'mem0_search'`, `'write_file'`).
     * @param {any} args - The tool arguments.
     * @returns {Promise<any>} The tool's result.
     */
    public async executeTool(name: string, args: any): Promise<any> {
        console.log(`[AgentService] Executing Tool for Workflow: ${name}`);
        return await this.tools.executeTool(name, args);
    }

    /**
     * Performs a web search using DuckDuckGo Lite with Google as fallback.
     * 
     * Scrapes the HTML results page and extracts titles, URLs, and snippets.
     * Detects bot/captcha blocks and returns an informative error result
     * that instructs the AI to use browser tools for manual search instead.
     * 
     * @param {string} query - The search query.
     * @returns {Promise<{ title: string, url: string, snippet: string }[]>}
     *   Up to 5 search results, or a `[SEARCH BLOCKED]` result on captcha.
     */
    public async performSearch(query: string): Promise<any[]> {
        const https = require('https');

        const searchProvider = async (url: string) => {
            return new Promise<any[]>((resolve) => {
                const options = {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' }
                };
                https.get(url, options, (res: any) => {
                    let data = '';
                    res.on('data', (c: any) => data += c);
                    res.on('end', () => {
                        // DETECT BOTS/CAPTCHA
                        if (data.includes('bots use DuckDuckGo') || (data.includes('Google Search') && data.includes('style="display:none"') && data.includes('feedback'))) {
                            console.error("[AgentService] BOT DETECTED. Returning error to LLM.");
                            resolve([{ title: "[SEARCH BLOCKED]", url: "NONE", snippet: "Automated search is currently blocked by the provider (captcha). PLEASE USE THE BROWSER TOOL to search manually at duckduckgo.com or google.com." }]);
                            return;
                        }

                        const results: any[] = [];
                        try {
                            // Split on common result markers for DDG Lite/HTML and Google Search (gbv=1)
                            const parts = data.split(/<td valign="top">|<div class="Gx5Z9e">|<div class="kCrYT">/i).slice(1);
                            for (let i = 0; i < parts.length; i += 2) {
                                const anchorMatch = parts[i].match(/href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
                                const snippetMatch = parts[i + 1]?.match(/class="result-snippet"|class="s3v9rd"[^>]*>([\s\S]*?)<\/td>|<div class="BNeawe s3v9rd AP7Wnd">([\s\S]*?)<\/div>/i);

                                if (anchorMatch) {
                                    let rawUrl = anchorMatch[1];
                                    let finalUrl = rawUrl;

                                    if (rawUrl.startsWith('/url?q=')) {
                                        finalUrl = decodeURIComponent(rawUrl.split('/url?q=')[1].split('&')[0]);
                                    } else if (rawUrl.startsWith('/')) {
                                        finalUrl = "https://lite.duckduckgo.com" + rawUrl;
                                    }

                                    try {
                                        if (finalUrl.includes('uddg=')) {
                                            const params = new URL(finalUrl).searchParams;
                                            const decoded = params.get('uddg');
                                            if (decoded) finalUrl = decoded;
                                        }
                                    } catch (e) { }

                                    if (finalUrl.includes('duckduckgo.com/search') || finalUrl.includes('google.com/search')) continue;

                                    results.push({
                                        title: anchorMatch[2].replace(/<[^>]+>/g, '').trim(),
                                        url: finalUrl,
                                        snippet: snippetMatch ? (snippetMatch[1] || snippetMatch[2]).replace(/<[^>]+>/g, '').trim() : "View details at " + finalUrl
                                    });
                                }
                            }
                        } catch (e) { }
                        resolve(results.slice(0, 5));
                    });
                }).on('error', () => resolve([]));
            });
        };

        let results = await searchProvider(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`);
        if (results.length === 0 || results[0]?.title === "[SEARCH BLOCKED]") {
            const googleResults = await searchProvider(`https://www.google.com/search?q=${encodeURIComponent(query)}&gbv=1`);
            if (googleResults.length > 0) results = googleResults;
        }
        return results;
    }

    /**
     * Prunes memory items based on TTL (days) and max count.
     * @param {number} ttlDays - Age in days to expire.
     * @param {number} maxItems - Maximum number of items to keep.
     * @returns {Promise<number>} Number of items removed.
     */
    public async pruneMemory(ttlDays: number, maxItems: number) { return this.memory.prune(ttlDays, maxItems); }

    /**
     * Ingests a file into the RAG vector database for long-term memory retrieval.
     * 
     * @param {string} p - Absolute path to the file to ingest.
     * @returns {Promise<any>} Ingestion result from the RAG service.
     */
    public async ingestFile(p: string) { return this.rag.ingestFile(p); }

    /**
     * Removes a file from the RAG vector database index.
     * 
     * @param {string} p - Absolute path to the file to remove.
     * @returns {Promise<any>} Deletion result from the RAG service.
     */
    public async deleteFile(p: string) { return this.rag.deleteFile(p); }

    /**
     * Triggers a manual scan and ingestion of the memory directory.
     */
    public async scanAndIngest() { return this.ingestion.scanAndIngest(); }

    /**
     * Lists all files currently indexed in the RAG vector database.
     * 
     * @returns {Promise<any>} List of indexed file paths.
     */
    public async listIndexedFiles() { return this.rag.listIndexedFiles(); }

    /**
     * Updates the workspace root directory for the ToolService.
     * 
     * Called when the user changes their active workspace. Ensures file I/O
     * tools operate within the correct directory.
     * 
     * @param {string} r - New absolute path to the workspace root.
     */
    /**
     * Updates the workspace root directory for the ToolService.
     * 
     * Called when the user changes their active workspace. Ensures file I/O
     * tools operate within the correct directory.
     * 
     * @param {string} r - New absolute path to the workspace root.
     */
    // public setWorkspaceRoot(r: string) { this.tools.setRoot(r); } // REMOVED DUPLICATE

    /**
     * Rewinds the chat history to a specific index.
     * @param index The index of the message to rewind TO (keeping messages 0..index-1).
     *              The message at 'index' and beyond are removed.
     */
    public async rewindChat(index: number) {
        if (this.activeSessionId) {
            const history = this.loadSession(this.activeSessionId);
            if (index >= 0 && index < history.length) {
                this.chatHistory = history.slice(0, index);
                this.saveSession();
            }
        } else {
            if (index >= 0 && index < this.chatHistory.length) {
                this.chatHistory = this.chatHistory.slice(0, index);
            }
        }
    }

    /**
     * Returns a list of all registered tools from the ToolService.
     * @returns {Array<{ name: string, description: string, source: string }>}
     */
    public getAllTools() {
        return this.tools.getAllTools();
    }

    /**
     * Fallback tool call extraction for models that don't support native tool APIs.
     * Scans assistant text for JSON blocks matching tool usage patterns.
     */
    private extractToolCallsFromText(text: string): any[] {
        const toolCalls: any[] = [];

        // Pattern 1: Roleplay-style function calls like *browse(url: "https://google.com")*
        // This often happens with models biased towards roleplay.
        const rpRegex = /\*(\w+)\(([\s\S]*?)\)\*/g;
        let rpMatch;
        while ((rpMatch = rpRegex.exec(text)) !== null) {
            const name = rpMatch[1];
            const rawArgs = rpMatch[2];
            if (this.tools.hasTool(name)) {
                // Attempt to parse pseudo-args (key: "value") into JSON
                const args: any = {};
                const argLines = rawArgs.split(',');
                for (const line of argLines) {
                    const parts = line.split(':');
                    if (parts.length >= 2) {
                        const key = parts[0].trim();
                        const value = parts.slice(1).join(':').trim().replace(/^["']|["']$/g, '');
                        args[key] = value;
                    }
                }
                toolCalls.push({
                    id: `call_rp_${Math.random().toString(36).substring(7)}`,
                    type: 'function',
                    function: { name, arguments: args }
                });
            }
        }

        // Pattern 2: JSON blocks { ... }
        // We use a balanced brace approach because regex /\{[\s\S]*?\}/ fails on nested objects (like args: {})
        let braceCount = 0;
        let startPos = -1;
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '{') {
                if (braceCount === 0) startPos = i;
                braceCount++;
            } else if (text[i] === '}') {
                braceCount--;
                if (braceCount === 0 && startPos !== -1) {
                    const block = text.substring(startPos, i + 1);
                    try {
                        const obj = JSON.parse(block);
                        // Normalized name and arguments
                        const name = obj.tool || (obj.function?.name) || obj.name;
                        const rawArgs = obj.args || obj.arguments || obj.parameters || (obj.function?.arguments) || {};
                        const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);

                        if (name && typeof name === 'string' && this.tools.hasTool(name)) {
                            toolCalls.push({
                                id: `call_json_${Math.random().toString(36).substring(7)}`,
                                type: 'function',
                                function: { name, arguments: args }
                            });
                            console.log(`[AgentService DEBUG] Detected Unified JSON Tool: ${name}`);
                        } else {
                            if (obj.tool || obj.name || obj.function) {
                                console.warn('[AgentService DEBUG] JSON looks like tool but was unknown:', name);
                            } else {
                                console.log('[AgentService DEBUG] JSON block is not a tool call');
                            }
                        }
                    } catch (e) {
                        console.log('[AgentService DEBUG] Failed to parse JSON block:', block.substring(0, 50) + '...');
                    }
                    startPos = -1;
                }
            }
        }
        return toolCalls;
    }
}
