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
import { GoalManager } from './plan/GoalManager';
import { WorldService } from './WorldService';
import { StrategyEngine } from './plan/StrategyEngine';
import { MINION_ROLES } from './plan/MinionRoles';
import { SmartRouterService } from './SmartRouterService';
import { auditLogger } from './AuditLogger';
import { v4 as uuidv4 } from 'uuid';

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
    private activeNotebookContext: { id: string | null, sourcePaths: string[] } = { id: null, sourcePaths: [] };
    /** Whether `igniteSoul()` has completed successfully. */
    private isSoulReady = false;
    /** Short-term conversational memory (Mem0). */
    private memory: MemoryService;
    /** Astrological emotion engine for persona modulation. */
    private astro: AstroService;
    /** Navigation computer for multi-path strategic planning. */
    private strategy: StrategyEngine;
    /** World model for environmental context. */
    private world: WorldService;
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
    /** Reference to the reflection service for self-modification and cleanup. */
    private reflectionService: any = null;
    /** Optional reference to the terminal for executing commands. */
    private terminal: TerminalService | null = null;
    /** Optional reference to the function service for `/command` shortcuts. */
    private functions: FunctionService | null = null;
    /** Reference to the mcp service for external tools. */
    private mcpService: any = null;
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
    /** Managed Goal Graph for hierarchical task tracking. */
    private goals: GoalManager;
    /** Reference to the main BrowserWindow for IPC. */
    private mainWindow: any = null;
    /** Timer for periodic Astro state telemetry updates. */
    private astroTelemetryTimer: NodeJS.Timeout | null = null;
    /** Intelligent brain router for cost/fidelity optimization. */
    private router: SmartRouterService | null = null;
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
        auditLogger.info('service_init', 'AgentService', { service: 'MemoryService' });
        this.astro = new AstroService();
        auditLogger.info('service_init', 'AgentService', { service: 'AstroService' });
        this.strategy = new StrategyEngine(this.brain);
        this.world = new WorldService();
        this.rag = new RagService();
        this.tools = new ToolService();
        this.backup = new BackupService();
        this.inference = inference || new InferenceService();
        this.ingestion = new IngestionService(this.rag, app.getPath('userData')); // Fallback root
        this.goals = new GoalManager(app.getPath('userData'));

        // Default brains for router (placeholders updated in loadBrainConfig)
        this.router = new SmartRouterService(this.brain, this.brain);

        this.tools.setMemoryService(this.memory);
        this.tools.setGoalManager(this.goals);
        if (mcp) {
            this.mcpService = mcp;
            this.tools.setMcpService(mcp);
        }

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
            const id = this.newSession();
            auditLogger.setSessionId(id);
        }

        this.loadBrainConfig().catch(e => console.error("Initial loadBrainConfig failed", e));

        // ═══════════════════════════════════════════════════════════════════════
        // ORCHESTRATOR & DELEGATION TOOL
        // ═══════════════════════════════════════════════════════════════════════
        this.orchestrator = new OrchestratorService(this.brain, this.tools);

        this.tools.register({
            name: 'delegate_task',
            description: 'Spawns a specialized sub-agent drone ("Minion") to perform a focused task. This parallelizes your reasoning and offloads technical work. Frame: "Deploying Automated Drone".',
            parameters: {
                type: 'object',
                properties: {
                    role: { type: 'string', enum: ['engineer', 'researcher', 'security', 'logistics'], description: 'The specialized persona for the drone.' },
                    task: { type: 'string', description: 'The specific task for the drone (e.g., "Refactor the authentication module").' },
                    context: { type: 'string', description: 'Additional context or constraints for the task.' }
                },
                required: ['role', 'task']
            },
            execute: async (args) => {
                const roleDef = MINION_ROLES[args.role as keyof typeof MINION_ROLES];
                if (!roleDef) return `Error: Unknown drone role "${args.role}". Available: ${Object.keys(MINION_ROLES).join(', ')}`;

                const systemPrompt = `${roleDef.systemPrompt}\n\n[COMMANDER'S CONTEXT]\n${args.context || "No additional context provided."}`;
                const report = await this.orchestrator.runHeadlessLoop(args.task, systemPrompt);

                return `### [DRONE REPORT: ${roleDef.title}]\n\n**Task**: ${args.task}\n\n${report}`;
            }
        });

        // Tool: manage_goals
        this.tools.register({
            name: 'manage_goals',
            description: 'Manage the hierarchical Goal Graph. Use this to decompose complex requests into smaller sub-goals, update progress, or switch focus. This ensures long-term tasks stay organized.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['add', 'update', 'focus', 'sync'], description: 'Action to perform: "add" a sub-goal, "update" status, "focus" on a goal, or "sync" immersion text.' },
                    parentId: { type: 'string', description: 'Parent goal ID (required for "add").' },
                    goalId: { type: 'string', description: 'Target goal ID (required for "update", "focus", and "sync").' },
                    title: { type: 'string', description: 'Short title of the new goal.' },
                    description: { type: 'string', description: 'Success criteria for the goal.' },
                    status: { type: 'string', enum: ['pending', 'active', 'completed', 'blocked', 'cancelled'], description: 'New status for the goal.' },
                    immersion: { type: 'string', description: 'Star Citizen roleplay immersion text (e.g., "The ship\'s hull is creaking under the pressure of the nebula").' }
                },
                required: ['action']
            },
            execute: async (args) => {
                try {
                    switch (args.action) {
                        case 'add':
                            if (!args.parentId || !args.title) return "Error: 'parentId' and 'title' are required to add a goal.";
                            const newId = this.goals.addSubGoal(args.parentId, args.title, args.description || "", args.immersion);
                            return `Goal created successfully. ID: ${newId}`;
                        case 'update':
                            if (!args.goalId || !args.status) return "Error: 'goalId' and 'status' are required to update a goal.";
                            this.goals.updateGoalStatus(args.goalId, args.status as any);
                            return `Goal ${args.goalId} updated to ${args.status}.`;
                        case 'focus':
                            if (!args.goalId) return "Error: 'goalId' is required to set focus.";
                            this.goals.setActiveGoal(args.goalId);
                            return `Focus switched to goal ${args.goalId}.`;
                        case 'sync':
                            if (!args.goalId || !args.immersion) return "Error: 'goalId' and 'immersion' are required to sync.";
                            this.goals.updateImmersion(args.goalId, args.immersion);
                            return `Immersion log updated for goal ${args.goalId}.`;
                        default:
                            return "Error: Unknown action.";
                    }
                } catch (e: any) {
                    return `Error managing goals: ${e.message}`;
                }
            }
        });

        // Tool: build_guardrail
        this.tools.register({
            name: 'build_guardrail',
            description: 'Create a new Guardrail or Validator. A Guardrail is a collection of Validators. If the user asks you to build a validator for specific criteria (e.g. "with x, y, and z"), use the "CustomLLM" type and write a precise prompt to check for those criteria. Other available types: ToxicLanguage, BanList, DetectPII, RegexMatch, ContainsString.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Name of the guardrail or validator.' },
                    description: { type: 'string', description: 'What this guardrail/validator checks for.' },
                    validators: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                type: { type: 'string', enum: ['CustomLLM', 'ToxicLanguage', 'BanList', 'DetectPII', 'RegexMatch', 'ContainsString', 'ProfanityFree', 'RestrictToTopic', 'ValidLength'], description: 'The type of validator. Use CustomLLM for custom/bespoke rules.' },
                                target: { type: 'string', enum: ['input', 'output', 'both'], description: 'Whether to validate user input, agent output, or both.' },
                                on_fail: { type: 'string', enum: ['noop', 'fix', 'filter', 'refrain', 'exception'], description: 'Action to take on failure. "noop" logs it, "filter" removes it, "refrain" blocks the response, "exception" throws an error.' },
                                args: { type: 'object', description: 'Args for the validator. For CustomLLM: {"prompt": "Does this text mention x, y, z, 1, 2, or 3? Reply PASS if it does, FAIL if it doesn\'t. Text:{value}"}. For BanList: {"banned_words": ["x", "y"]}.' }
                            },
                            required: ['type', 'target', 'on_fail', 'args']
                        }
                    }
                },
                required: ['name', 'description', 'validators']
            },
            execute: async (args) => {
                try {
                    const { GuardrailService } = require('./GuardrailService');
                    const gs = new GuardrailService(app.getPath('userData'));
                    const definition = {
                        name: args.name,
                        description: args.description,
                        validators: args.validators.map((v: any) => ({
                            id: Math.random().toString(36).substring(7),
                            type: v.type,
                            target: v.target,
                            on_fail: v.on_fail,
                            args: v.args,
                            enabled: true
                        }))
                    };
                    const saved = gs.saveGuard(definition);
                    return `Successfully created Guardrail/Validator "${saved.name}" with ID: ${saved.id}. You DO NOT need to write any code, the system handles it. Tell the user it is built.`;
                } catch (e: any) {
                    return `Error creating guardrail: ${e.message}`;
                }
            }
        });

        // Tool: calculate_strategies (The Navigator)
        this.tools.register({
            name: 'calculate_strategies',
            description: 'Calculates multiple implementation paths (strategies) for the active goal. Use this when a task is complex or high-risk to evaluate your options before proceeding. Framing: "Navigation Computer".',
            parameters: {
                type: 'object',
                properties: {
                    goalId: { type: 'string', description: 'The ID of the goal to analyze (defaults to active goal).' }
                }
            },
            execute: async (args) => {
                const goalId = args.goalId || this.goals.loadGraph(this.activeSessionId)?.activeGoalId;
                if (!goalId) return "Error: No active goal found to analyze.";

                const graph = this.goals.loadGraph(this.activeSessionId);
                const goal = graph?.nodes[goalId];
                if (!goal) return `Error: Goal ${goalId} not found.`;

                // Build a quick overview for context
                const overview = await this.world.ignite ? "Requesting Workspace Overview from sensors..." : "Sensors offline.";

                // Deep Astro Integration: Get emotional vector for modulation
                const astroData = await this.astro.getRawEmotionalState('tala');
                const astroVector = astroData?.emotional_vector;

                // In a real run, we'd use the world engine here. For now, we use a basic prompt.
                const simulation = await this.strategy.computePaths(goal, "Context provided via RAG and File reading.", astroVector);

                const output = simulation.paths.map((p, i) => {
                    return `[PATH ${i + 1}: ${p.name}]\n` +
                        `- Immersion: ${p.immersion}\n` +
                        `- Risk: ${p.riskScore}/10 (Hull Integrity)\n` +
                        `- Cost: ${p.estimatedCost}/10 (Fuel Use)\n` +
                        `- Rationale: ${p.rationale}\n` +
                        `- Steps: ${p.steps.join(', ')}`;
                }).join('\n\n');

                return `### [NAVIGATOR: STRATEGIC PATH ANALYSIS]\n\n${output}\n\n**Recommendation**: Path ${simulation.recommendedIndex + 1}`;
            }
        });

        // Tool: select_strategy (Engage Trajectory)
        this.tools.register({
            name: 'select_strategy',
            description: 'Commits to a specific implementation path from a previous strategy calculation. This will automatically break down the chosen strategy into sub-goals in your log. Frame: "Engaging Selected Trajectory".',
            parameters: {
                type: 'object',
                properties: {
                    goalId: { type: 'string', description: 'The parent goal ID.' },
                    strategyName: { type: 'string', description: 'The name of the path to adopt.' },
                    steps: { type: 'array', items: { type: 'string' }, description: 'The steps from the chosen strategy.' },
                    immersion: { type: 'string', description: 'Flavor text for the transition.' }
                },
                required: ['goalId', 'strategyName', 'steps']
            },
            execute: async (args) => {
                const { goalId, strategyName, steps, immersion } = args;

                // Add sub-goals for each step
                for (let i = 0; i < steps.length; i++) {
                    this.goals.addSubGoal(goalId, `Step ${i + 1}: ${steps[i]}`, `Part of strategy: ${strategyName}`, immersion);
                }

                return `Trajectory engaged! ${steps.length} sub-goals added to the log for strategy "${strategyName}".\nImmersion: ${immersion || "Thrusters firing."}`;
            }
        });

        // Tool: smart_route (Economic Intelligence)
        this.tools.register({
            name: 'set_routing_mode',
            description: 'Configures the Economic Intelligence engine. Adjusts how tasks are routed between local (Ollama) and cloud models. Frame: "Optimizing Power Distribution".',
            parameters: {
                type: 'object',
                properties: {
                    mode: { type: 'string', enum: ['auto', 'local-only', 'cloud-only'], description: 'Routing policy.' }
                },
                required: ['mode']
            },
            execute: async (args) => {
                this.router?.setMode(args.mode as any);
                return `Power distribution optimized for ${args.mode} operations.`;
            }
        });

        // Tool: manage_local_engine
        this.tools.register({
            name: 'manage_local_engine',
            description: 'Manages the built-in llama.cpp inference engine. Use this to start/stop the local CPU-based brain or check its status. Framing: "Local Engine Control".',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['start', 'stop', 'status', 'download'], description: 'Action to perform.' }
                },
                required: ['action']
            },
            execute: async (args) => {
                const local = this.inference.getLocalEngine();
                switch (args.action) {
                    case 'start':
                        try {
                            await local.ensureReady();
                            const settings = loadSettings(this.settingsPath);
                            const modelPath = path.join(process.cwd(), 'models', settings.inference?.localEngine?.modelPath || 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf');
                            await local.ignite(modelPath, settings.inference?.localEngine?.options);
                            return "Success: Local engine started.";
                        } catch (e: any) {
                            return `Error starting local engine: ${e.message}`;
                        }
                    case 'stop':
                        local.extinguish();
                        return "Success: Local engine stopped.";
                    case 'status':
                        return JSON.stringify(local.getStatus(), null, 2);
                    case 'download':
                        local.ensureReady().catch(e => console.error("Background download failed", e));
                        return "Success: Background download initiated. Check status for progress.";
                    default:
                        return "Error: Unknown action.";
                }
            }
        });

        // Tool: get_user_profile
        this.tools.register({
            name: 'get_user_profile',
            description: 'Retrieves the detailed user profile, including real-world and roleplay (RP) identity information such as birthdate, contact details, and history. Use this if you need to verify the user\'s age or personal details before proceeding with limited content.',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
                try {
                    const profilePath = path.join(this.tools.getWorkspaceDir(), 'data', 'user_profile.json');
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
    }

    /**
     * Injects the McpService dependency.
     */
    public setMcpService(mcp: any) {
        this.mcpService = mcp;
        this.tools.setMcpService(mcp);
    }

    /**
     * Injects the GitService dependency.
     */
    public setGitService(git: any) {
        this.tools.setGitService(git);
        // ReflectionService also needs Git for self-modification
        this.reflectionService?.setGitService(git);
    }

    /**
     * Injects the ReflectionService dependency.
     */
    public setReflectionService(reflection: any) {
        this.reflectionService = reflection;
        this.tools.setReflectionService(reflection);
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
                auditLogger.setSessionId(id);

                // Restore Branch Metadata
                this.activeParentId = data.parentId || '';
                this.activeBranchPoint = data.branchPoint !== undefined ? data.branchPoint : -1;

                // Restore Notebook Context if present
                if (data.notebookContext) {
                    this.activeNotebookContext = data.notebookContext;
                } else {
                    this.activeNotebookContext = { id: null, sourcePaths: [] };
                }

                this.goals.loadGraph(id);
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
        auditLogger.setSessionId(id);
        this.chatHistory = [];
        this.activeParentId = '';
        this.activeBranchPoint = -1;
        this.activeNotebookContext = { id: null, sourcePaths: [] };

        this.goals.loadGraph(id); // Clear goals for new ID
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

    /**
     * Exports an agent profile as a standalone Python codeset.
     * @param profileId - The ID of the agent profile to export.
     * @param outputDir - The directory where the codeset will be created.
     */
    public async exportAgentToPython(profileId: string, outputDir: string): Promise<boolean> {
        try {
            const settings = loadSettings(this.settingsPath);
            const profile = settings.agent?.profiles?.find((p: any) => p.id === profileId);
            if (!profile) throw new Error(`Profile not found: ${profileId}`);

            const activeInstance = this.getActiveInstance() || { engine: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'llama3' };

            // 1. Setup Directory Structure
            const dirs = ['', 'prompts', 'tools', 'runtime', 'memory'];
            for (const d of dirs) {
                const p = path.join(outputDir, d);
                if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
            }

            // 2. Fetch Tool Definitions & MCP Configs
            const mcpConfigs: any[] = [];
            const toolSchemas: any[] = [];
            const assignedMcpIds = [...(profile.mcp?.global || []), ...(profile.mcp?.workspace || [])];

            for (const id of assignedMcpIds) {
                const srvCfg = settings.mcpServers?.find((s: any) => s.id === id);
                if (srvCfg) {
                    mcpConfigs.push(srvCfg);
                    if (this.mcpService) {
                        const caps = await this.mcpService.getCapabilities(id);
                        if (caps && caps.tools) {
                            caps.tools.forEach((t: any) => toolSchemas.push({ ...t, serverId: id }));
                        }
                    }
                }
            }

            // 3. Manifest (manifest.json)
            const manifest = {
                metadata: {
                    id: profile.id,
                    name: profile.name,
                    version: "1.0.0",
                    description: profile.description || "Standalone Tala Agent",
                    author: "Tala Export",
                    exported_at: new Date().toISOString()
                },
                runtime: {
                    engine: activeInstance.engine,
                    model: activeInstance.model,
                    endpoint: activeInstance.endpoint.includes('11434') && !activeInstance.endpoint.includes('/v1')
                        ? `${activeInstance.endpoint}/v1`
                        : activeInstance.endpoint,
                    temperature: profile.temperature || 0.7,
                    max_tokens: 4096
                },
                policies: {
                    memory: profile.memoryPolicy || "local-file",
                    tools: "enabled",
                    permissions: ["filesystem", "network", "subprocess"]
                },
                wiring: {
                    mcp_servers: mcpConfigs.map(c => ({ id: c.id, name: c.name, type: c.type, url: c.url })),
                    allowed_tools: toolSchemas.map(t => t.name)
                },
                swarm: {
                    role: profile.role || "autonomous-agent",
                    delegation_rules: "restricted",
                    coordinator_endpoint: null
                }
            };

            // 4. Prompt Stack
            const systemPrompt = profile.systemPrompt || "You are a helpful AI assistant.";
            const rules = profile.rules?.global || "";
            const dynamicInjections = `# This file defines dynamic context injections for the agent.
# You can modify this to inject environment-specific data at runtime.
def get_dynamic_context():
    return {}
`;
            fs.writeFileSync(path.join(outputDir, 'prompts', 'system.txt'), systemPrompt);
            fs.writeFileSync(path.join(outputDir, 'prompts', 'rules.txt'), rules);
            fs.writeFileSync(path.join(outputDir, 'prompts', 'dynamic_injections.py'), dynamicInjections);

            // 5. Tool Wiring
            fs.writeFileSync(path.join(outputDir, 'tools', 'mcp_config.json'), JSON.stringify(mcpConfigs, null, 2));
            fs.writeFileSync(path.join(outputDir, 'tools', 'schemas.json'), JSON.stringify(toolSchemas, null, 2));
            fs.writeFileSync(path.join(outputDir, 'tools', 'swarm.json'), JSON.stringify(manifest.swarm, null, 2));

            // 6. tala_agent.py (Advanced Core)
            const talaAgentPy = `import json
import os
import sys
from openai import OpenAI

class TalaAgent:
    def __init__(self, manifest_path):
        with open(manifest_path, 'r', encoding='utf-8') as f:
            self.manifest = json.load(f)
        
        # Determine API Configuration from manifest or env overrides
        rt = self.manifest['runtime']
        base_url = os.getenv("TALA_API_BASE", rt.get('endpoint'))
        api_key = os.getenv("TALA_API_KEY", "ollama")
        
        self.client = OpenAI(base_url=base_url, api_key=api_key)
        self.model = os.getenv("TALA_MODEL", rt.get('model'))
        
        # Identity and Constraints
        self.base_path = os.path.dirname(manifest_path)
        self.system_path = os.path.join(self.base_path, 'prompts', 'system.txt')
        self.rules_path = os.path.join(self.base_path, 'prompts', 'rules.txt')
        
        with open(self.system_path, 'r', encoding='utf-8') as f:
            self.system_prompt = f.read()
        with open(self.rules_path, 'r', encoding='utf-8') as f:
            self.rules = f.read()

        self.temperature = rt.get('temperature', 0.7)
        
        # Tools
        schemas_path = os.path.join(self.base_path, 'tools', 'schemas.json')
        with open(schemas_path, 'r', encoding='utf-8') as f:
            self.tool_schemas = json.load(f)

    def get_messages(self, user_input, history=None):
        content = f"{self.rules}\\n\\n{self.system_prompt}"
        
        # Load dynamic injections if available
        try:
            sys.path.append(os.path.join(self.base_path, 'prompts'))
            import dynamic_injections
            dyn_ctx = dynamic_injections.get_dynamic_context()
            if dyn_ctx:
                content += f"\\n\\n[DYNAMIC CONTEXT]\\n{json.dumps(dyn_ctx, indent=2)}"
        except ImportError:
            pass

        msgs = [{"role": "system", "content": content}]
        if history:
            msgs.extend(history)
        msgs.append({"role": "user", "content": user_input})
        return msgs

    def chat_stream(self, user_input, history=None):
        messages = self.get_messages(user_input, history)
        
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=self.temperature,
                stream=True
            )
            
            for chunk in response:
                if chunk.choices and len(chunk.choices) > 0:
                    content = chunk.choices[0].delta.content
                    if content:
                        yield content
        except Exception as e:
            yield f"\\n[Inference Error]: {str(e)}"
`;

            // 7. main.py (CLI Runner)
            const mainPy = `import json
import os
import sys
from tala_agent import TalaAgent

def main():
    manifest_path = os.path.join(os.path.dirname(__file__), 'manifest.json')
    if not os.path.exists(manifest_path):
        print(f"Error: manifest.json not found at {manifest_path}")
        return

    with open(manifest_path, 'r', encoding='utf-8') as f:
        manifest = json.load(f)
    
    print(f"\\n--- {manifest['metadata']['name']} Engaged ---")
    print(f"Role: {manifest['swarm']['role']}")
    print("Type 'exit' or 'quit' to end session.\\n")
    
    agent = TalaAgent(manifest_path)
    history = []
    
    while True:
        try:
            user_input = input("User > ")
            if not user_input.strip(): continue
            if user_input.lower() in ['exit', 'quit']:
                break
                
            print(f"\\n{manifest['metadata']['name']} > ", end="", flush=True)
            full_response = ""
            for chunk in agent.chat_stream(user_input, history):
                print(chunk, end="", flush=True)
                full_response += chunk
            print("\\n")
            
            history.append({"role": "user", "content": user_input})
            history.append({"role": "assistant", "content": full_response})
            
            if len(history) > 20: history = history[-20:]
                
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"\\n[ERROR]: {e}")

if __name__ == "__main__":
    main()
`;

            // 8. Dockerfile
            const dockerfile = `FROM python:3.9-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Set dynamic library path for potential C extensions in MCP
ENV PYTHONPATH=/app

CMD ["python", "main.py"]
`;

            // 9. requirements.txt
            const requirementsTxt = `openai\n# mcp  # Uncomment if using MCP tools in python\n`;

            // 10. README.md
            const readmeMd = `# Tala Agent: ${profile.name}

Exported standalone package from Tala.

## Package Structure
- \`manifest.json\`: Full identity, runtime, and policy configuration.
- \`prompts/\`: System prompt, rules, and dynamic injection scripts.
- \`tools/\`: MCP server configuration, tool schemas, and swarm topology.
- \`tala_agent.py\`: Core agent logic.
- \`main.py\`: CLI interactive runner.
- \`Dockerfile\`: Containerized deployment support.

## Usage
1. Install dependencies: \`pip install -r requirements.txt\`
2. Run locally: \`python main.py\`
3. Run via Docker: \`docker build -t tala-agent . && docker run -it tala-agent\`

## Runtime Overrides
You can use environment variables to override the manifest settings:
- \`TALA_API_BASE\`: LLM endpoint.
- \`TALA_API_KEY\`: API key.
- \`TALA_MODEL\`: Model ID.
`;

            // Write Everything
            fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
            fs.writeFileSync(path.join(outputDir, 'tala_agent.py'), talaAgentPy);
            fs.writeFileSync(path.join(outputDir, 'main.py'), mainPy);
            fs.writeFileSync(path.join(outputDir, 'Dockerfile'), dockerfile);
            fs.writeFileSync(path.join(outputDir, 'requirements.txt'), requirementsTxt);
            fs.writeFileSync(path.join(outputDir, 'README.md'), readmeMd);

            return true;
        } catch (e) {
            console.error(`[AgentService] Failed to export agent:`, e);
            throw e;
        }
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
            if (this.activeNotebookContext.id) {
                session.notebookContext = this.activeNotebookContext;
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
                console.error(`[AgentService] Cannot branch: messageIndex ${messageIndex} out of range(0 - ${sourceMessages.length - 1})`);
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

        // PROTOCOL STABILITY: Never start history with a 'tool' message.
        // A tool message MUST follow the assistant call that spawned it.
        while (result.length > 0 && result[0].role === 'tool') {
            console.warn('[AgentService] Truncation dropped a leading tool message to preserve protocol.');
            result.shift();
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
        await this.loadBrainConfig();
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
    private async loadBrainConfig() {
        try {
            const settings = loadSettings(this.settingsPath);
            if (settings.inference?.instances) {
                let candidate = null;
                if (settings.inference.activeLocalId) {
                    candidate = settings.inference.instances.find((i: any) => i.id === settings.inference.activeLocalId);
                }
                if (!candidate) {
                    let candidates = [...settings.inference.instances];
                    if (settings.inference.mode === 'local-only') {
                        candidates = candidates.filter((i: any) => i.source === 'local');
                    } else if (settings.inference.mode === 'cloud-only') {
                        candidates = candidates.filter((i: any) => i.source === 'cloud');
                    }
                    candidate = candidates.sort((a: any, b: any) => a.priority - b.priority)[0];
                }

                if (candidate) {
                    let useCloudBrain = candidate.source === 'cloud' ||
                        ['openai', 'anthropic', 'openrouter', 'groq', 'gemini', 'llamacpp', 'vllm', 'custom'].includes(candidate.engine);

                    // --- AUTOMATIC FALLBACK & STARTUP LOGIC ---
                    const local = this.inference.getLocalEngine();

                    if (!useCloudBrain && candidate.engine === 'ollama') {
                        const ollama = new OllamaBrain();
                        ollama.configure(candidate.endpoint, candidate.model);
                        const isOllamaUp = await ollama.ping();

                        if (!isOllamaUp) {
                            console.warn(`[AgentService] Ollama unreachable at ${candidate.endpoint}. Falling back to Llama.cpp.`);
                            const fallbackCandidate = settings.inference.instances.find((i: any) => i.engine === 'llamacpp' && i.source === 'local');
                            if (fallbackCandidate) {
                                candidate = fallbackCandidate;
                                useCloudBrain = true;
                            }
                        }
                    }

                    // If Llama.cpp is selected (either directly or via fallback), ensure it's running
                    if (candidate.engine === 'llamacpp' && candidate.source === 'local') {
                        if (!local.getStatus().isRunning) {
                            console.log(`[AgentService] Auto-igniting Llama.cpp (Selected/Fallback)...`);
                            const modelPath = path.join(process.cwd(), 'models', settings.inference?.localEngine?.modelPath || 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf');
                            // We don't await here to avoid blocking startup, but we do trigger it
                            local.ensureReady()
                                .then(() => local.ignite(modelPath, settings.inference?.localEngine?.options))
                                .catch(e => console.error("[AgentService] Llama.cpp ignition failed:", e));
                        }
                    }
                    // --- END FALLBACK & STARTUP LOGIC ---

                    if (useCloudBrain) {
                        this.brain = new CloudBrain({
                            endpoint: candidate.endpoint || 'https://api.openai.com/v1',
                            apiKey: candidate.apiKey,
                            model: candidate.model || 'gpt-4'
                        });
                    } else {
                        const ollama = new OllamaBrain();
                        ollama.configure(candidate.endpoint, candidate.model);
                        this.brain = ollama;
                    }

                    // Initialize Router with Local vs Cloud
                    const localCandidate = settings.inference.instances.find((i: any) => i.source === 'local') || candidate;
                    const cloudCandidate = settings.inference.instances.find((i: any) => i.source === 'cloud') || candidate;

                    if (localCandidate) {
                        const isLlamaCpp = localCandidate.engine === 'llamacpp';
                        const localBrain = isLlamaCpp
                            ? new CloudBrain({
                                endpoint: localCandidate.endpoint || 'http://127.0.0.1:8080/v1',
                                model: localCandidate.model
                            })
                            : new OllamaBrain();

                        if (localBrain instanceof OllamaBrain) {
                            localBrain.configure(localCandidate.endpoint, localCandidate.model);
                        }

                        if (cloudCandidate) {
                            const cloudBrain = new CloudBrain({
                                endpoint: cloudCandidate.endpoint || 'https://api.openai.com/v1',
                                apiKey: cloudCandidate.apiKey,
                                model: cloudCandidate.model || 'gpt-4'
                            });
                            this.router = new SmartRouterService(localBrain, cloudBrain);

                            // Sync Router Mode
                            const routerMode = settings.inference.mode === 'hybrid' ? 'auto' : settings.inference.mode;
                            this.router.setMode(routerMode as any);
                        }
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

        if (this.brain instanceof OllamaBrain && activeInstance) {
            (this.brain as OllamaBrain).configure(activeInstance.endpoint, activeInstance.model);
        }

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
            if (settings.inference?.instances && settings.inference.instances.length > 0) {
                if (settings.inference.activeLocalId) {
                    const found = settings.inference.instances.find((i: any) => i.id === settings.inference.activeLocalId);
                    if (found) return found;
                }
                if (settings.inference.mode === 'local-only') {
                    const locals = settings.inference.instances.filter((i: any) => i.source === 'local');
                    if (locals.length > 0) return locals[0];
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

            // 1. Built-in Local Engine (Removed Auto-Ignition)
            // We no longer auto-ignite the engine here to save resources and allow
            // the user to start it manually via the UI.
            this.sendStartupProgress('Core Systems Ready...', 15);


            // 2. RAG & Memory Configuration
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
            const worldScript = path.join(app.getAppPath(), 'mcp-servers', 'world-engine', 'server.py');

            // 2. RAG, Memory, Astro, World (Parallel Ignition)
            console.log('[AgentService] Igniting Core Knowledge Servers in parallel...');
            this.sendStartupProgress('Igniting Knowledge Ecosystem...', 30);

            const ignitionTasks = [
                this.rag.ignite(pythonPath, ragScript, ragEnv).catch(e => {
                    console.error('RAG fail', e);
                    this.mainWindow?.webContents.send('system:notification', { type: 'error', message: `RAG Engine Startup Failed: ${e.message}` });
                }),
                this.memory.ignite(pythonPath, memoryScript, systemEnv).catch(e => {
                    console.error('Memory fail', e);
                    this.mainWindow?.webContents.send('system:notification', { type: 'error', message: `Memory Engine Startup Failed: ${e.message}` });
                }),
                this.astro.ignite(pythonPath, astroScript, systemEnv).catch(e => {
                    console.error('Astro fail', e);
                    this.mainWindow?.webContents.send('system:notification', { type: 'error', message: `Astro Engine Startup Failed: ${e.message}` });
                }),
                this.world.ignite(pythonPath, worldScript, systemEnv).catch(e => {
                    console.error('World Engine fail', e);
                    this.mainWindow?.webContents.send('system:notification', { type: 'error', message: `World Engine Startup Failed: ${e.message}` });
                })
            ];

            // Wait for core services to at least attempt ignition
            await Promise.all(ignitionTasks);

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
                        console.log(`[AgentService] Astro profile created: ${profile.id} `);
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
                                console.log(`[AgentService] Astro profile updated: ${profile.id} `);
                            } catch (updateErr) {
                                console.error(`[AgentService] Failed to update astro profile ${profile.id}: `, updateErr);
                            }
                        } else {
                            console.error(`[AgentService] Failed to create astro profile ${profile.id}: `, e);
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
                console.log(`[AgentService] Active profile '${settings.agent?.activeProfileId}' invalid / missing.Falling back to '${agentId}'.`);
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
     *   (browser navigation, terminal commands, screenshot display).
     * @returns {Promise<void>}
     */
    public async chat(userMessage: string, onToken: (token: string) => void, onEvent?: (type: string, data: any) => void, images?: string[]) {
        const correlationId = uuidv4();
        auditLogger.setCorrelationId(correlationId);
        auditLogger.info('chat_received', 'AgentService', {
            messageLength: userMessage.length,
            imageCount: images?.length || 0,
            sessionId: this.activeSessionId
        }, correlationId);

        console.log(`[AgentService] ====== CHAT STARTED ====== Length: ${userMessage.length}, Images: ${images?.length || 0}`);

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

        // Wait for local engine if starting
        const local = this.inference.getLocalEngine();
        const localStatus = local.getStatus();
        const settings = loadSettings(this.settingsPath);
        let activeInstance = this.getActiveInstance();

        if (activeInstance?.engine === 'llamacpp' && activeInstance?.source === 'local') {
            if (!localStatus.isRunning) {
                onToken(`> *Igniting cold engine...*\n`);
                try {
                    // Try to wait for it (ignite returns a promise that resolves when ready)
                    // If it's already starting, we might need a way to wait for the existing promise.
                    // For now, let's just wait a few seconds or check if it's running.
                    let attempts = 0;
                    while (!local.getStatus().isRunning && attempts < 10) {
                        await new Promise(r => setTimeout(r, 2000));
                        attempts++;
                    }
                    if (!local.getStatus().isRunning) {
                        onToken(`> *Warning: Local engine is taking longer than expected to ignite. Attempting inference anyway...*\n`);
                    }
                } catch (e) {
                    console.error("[AgentService] Wait for local engine failed:", e);
                }
            }
        }

        // 1. Get State
        const astroState = await this.getAstroState();
        let userContext = "User: Unknown";
        let memoryContext = "";
        let capabilitiesContext = "";

        try {
            const profilePath = path.join(app.getPath('userData'), 'user_profile.json');
            const workspaceProfilePath = path.join(this.tools.getWorkspaceDir(), 'data', 'user_profile.json');
            const targetProfilePath = fs.existsSync(workspaceProfilePath) ? workspaceProfilePath : profilePath;

            if (fs.existsSync(targetProfilePath)) {
                const profile = JSON.parse(fs.readFileSync(targetProfilePath, 'utf-8'));
                userContext = `[USER IDENTITY]\nName: ${profile.firstName} ${profile.lastName}\nNOTE: Detailed information (Birthdate, RP Identity, History) is hidden for privacy. Use the 'get_user_profile' tool if you need this data to verify age or context.`;
            }

            // Memory/RAG Checks
            if (settings.agent?.capabilities?.memory !== false) {
                const memories = await this.memory.search(userMessage);
                if (memories.length > 0) memoryContext += `[MEMORIES]\n${memories.map(m => m.text).join('\n')}`;

                // Dual-Stream RAG Search (Roleplay vs Assistant)
                // If a notebook is active, we significantly boost the contribution of its sources.
                console.log('[AgentService] RAG Search starting...');

                const searchFilters: any = {};
                if (this.activeNotebookContext.sourcePaths?.length > 0) {
                    searchFilters.source = this.activeNotebookContext.sourcePaths;
                    console.log(`[AgentService] Filtering search to notebook sources: ${this.activeNotebookContext.sourcePaths.length} items`);
                }

                const [ragRoleplay, ragAssistant, ragNotebook] = await Promise.all([
                    this.rag.search(userMessage, { filter: { category: 'roleplay' }, limit: 3 }),
                    this.rag.search(userMessage, { filter: { category: 'assistant' }, limit: 1 }),
                    this.activeNotebookContext.sourcePaths?.length > 0 ? this.rag.search(userMessage, { filter: searchFilters, limit: 3 }) : Promise.resolve('')
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

                if (ragNotebook) {
                    console.log(`[AgentService] NOTEBOOK RAG HIT (${ragNotebook.length} chars)`);
                    memoryContext += `\n[NOTEBOOK CONTEXT - RESEARCH MATERIAL]\nThe user is currently referencing a "Notebook" for this task. The following sections are the MOST RELEVANT excerpts from your research sources. Prioritize these for accurate, grounded delivery:\n${ragNotebook}`;
                }
            } else {
                console.log('[AgentService] Memory/RAG Skipped (Disabled by User)');
                memoryContext += `\n[MEMORY SYSTEM DISABLED]\nLong-term memory retrieval is offline.`;
            }

            if (this.systemInfo) capabilitiesContext = `[SYSTEM]\nOS: ${this.systemInfo.os}\nNode: ${this.systemInfo.nodeVersion}`;
        } catch (e) { }

        // 2. Build Prompt
        let systemPromptTemplate = `[EMOTIONAL STATE]
[ASTRO_STATE]

[CONTEXT]
[USER_CONTEXT]
[CAPABILITY_CONTEXT]

[ROLEPLAY SAFETY PROTOCOL]
- If a user requests romantic or NSFW content, NEVER refuse on the basis of age/minor status WITHOUT first using 'get_user_profile' to verify their birthdate.
- Do NOT hallucinate the user's age or birthdate.
- If verified as an adult, stay in character and honor the persona rules defined in your profile.

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

        // Expanding native tool support for Ollama and other OpenAI-compatible providers
        const supportsNativeTools = [
            'openai', 'anthropic', 'google', 'gemini',
            'ollama', 'llamacpp', 'vllm', 'openrouter', 'groq', 'custom'
        ].includes(providerType);

        // We ALWAYS use compact signatures now to save tokens. The LLM gets the rules from the XML prompt.
        const toolSchemas = this.tools.getToolSignatures();

        // Debug Log
        if (supportsNativeTools) console.log(`[AgentService] Using Native Tool API (Provider: ${providerType})`);
        else console.log(`[AgentService] Using XML Fallback Tools (Provider: ${providerType})`);

        console.log('[AgentService DEBUG] Tool Schemas Length:', toolSchemas.length);
        console.log('[AgentService DEBUG] Tool Schemas Snapshot:', toolSchemas.substring(0, 500) + '...');
        systemPromptTemplate += `\n\n[AVAILABLE TOOLS]\n${toolSchemas}`;

        // Add Protocol
        if (supportsNativeTools) {
            systemPromptTemplate += `
[TOOL USAGE PROTOCOL]
1. Use tools ONLY when a specific action is required (file I/O, search, etc.).
2. For greetings, chatter, or explaining your thoughts, respond with plain text ONLY.
3. To call a tool, you MUST output a JSON block:
\`\`\`json
{
  "tool": "tool_name",
  "args": {
    "param": "value"
  }
}
\`\`\`
4. YOU MUST STOP and WAIT for a tool result after calling a tool. Do NOT hallucinate the results.

5. ENGINEERING AUTONOMY PROTOCOL:
   - You are a fully autonomous software engineer with "File Control".
   - If the user asks for a feature, bug fix, or code modification, YOU MUST:
     1. Use 'list_files' and 'read_file' to locate the relevant source code (e.g., App.tsx, AgentService.ts).
     2. Identify the exact changes needed to integrate the feature into the existing codebase.
     3. Use 'write_file' or 'patch_file' to apply the actual changes. Do NOT create standalone scripts unless explicitly requested.
   - You are responsible for the health of the project. Do NOT be tentative; if a change is requested, execute the tool calls immediately.


6. STRATEGIC PLANNING & REFLECTION PROTOCOL:
   - For any complex task, YOU MUST use 'manage_goals' or 'task_plan' to bootstrap your thinking and keep the user informed.
   - Review the [SHIP'S LOG: GOAL GRAPH] at the start of every turn to maintain technical continuity.
   - Review [REFLECTION LOGS: SYSTEM STABILITY] for observations the system has made about your performance (errors, tool failures).
   - If a proposal exists in the Reflection Panel, you can discuss it with the user to gain approval.

7. CRITICAL: If the user asks to "navigate", "browse", or "open" a specific site, you MUST use the browser tools. DO NOT substitute with 'search_web'.
`;
        } else {
            systemPromptTemplate += `
[TOOL USAGE PROTOCOL]
1. Use tools ONLY when a specific action is required (file I/O, search, etc.).
2. For greetings, chatter, or explaining your thoughts, respond with plain text ONLY.
3. To call a tool, you MUST output an XML block exactly like this:
<tool_call>
<name>tool_name</name>
<args>{"param": "value"}</args>
</tool_call>
4. YOU MUST STOP and WAIT for a tool result after calling a tool. Do NOT hallucinate the results.

5. ENGINEERING AUTONOMY PROTOCOL:
   - You are a fully autonomous software engineer with "File Control".
   - If the user asks for a feature, bug fix, or code modification, YOU MUST:
     1. Use 'list_files' and 'read_file' to locate the relevant source code (e.g., App.tsx, AgentService.ts).
     2. Identify the exact changes needed to integrate the feature into the existing codebase.
     3. Use 'write_file' or 'patch_file' to apply the actual changes. Do NOT create standalone scripts unless explicitly requested.
   - You are responsible for the health of the project. Do NOT be tentative; if a change is requested, execute the tool calls immediately.


6. STRATEGIC PLANNING & REFLECTION PROTOCOL:
   - For any complex task, YOU MUST use 'manage_goals' or 'task_plan' to bootstrap your thinking and keep the user informed.
   - Review the [SHIP'S LOG: GOAL GRAPH] at the start of every turn to maintain technical continuity.
   - Review [REFLECTION LOGS: SYSTEM STABILITY] for observations the system has made about your performance (errors, tool failures).
   - If a proposal exists in the Reflection Panel, you can discuss it with the user to gain approval.

7. CRITICAL: If the user asks to "navigate", "browse", or "open" a specific site, you MUST use the browser tools. DO NOT substitute with 'search_web'.
`;
        }

        const projectAnnotations = AnnotationParser.generateProjectSummary(this.tools.getWorkspaceDir());
        const goalSummary = this.goals.generatePromptSummary();
        const reflectionSummary = this.getReflectionSummary();

        let systemPrompt = systemPromptTemplate
            .replace('[ASTRO_STATE]', astroState)
            .replace('[USER_CONTEXT]', userContext)
            .replace('[CAPABILITY_CONTEXT]', capabilitiesContext + "\n" + memoryContext + "\n" + projectAnnotations + "\n" + goalSummary + "\n" + reflectionSummary)
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

        const fallbackInstructions = supportsNativeTools ? `
[FALLBACK TOOL FORMAT]
If your model does not support native tool-calling API, output a JSON block in your response:
{ "tool": "tool_name", "args": { "key": "value" } }
` : `
[FALLBACK TOOL FORMAT]
Always use the XML <tool_call> format for tools. Example:
<tool_call>
<name>search_web</name>
<args>{"query": "latest news"}</args>
</tool_call>
`;
        systemPrompt += fallbackInstructions;

        // 3. Inference Config — read context length for truncation
        if (!activeInstance && settings.inference?.instances?.length > 0) {
            activeInstance = settings.inference.instances.find((i: any) => i.id === settings.inference.activeLocalId) || settings.inference.instances[0];
        }

        // 4. Loop
        // Use candidate's ctxLen, or default to 32k for Ollama, 8k for others.
        const defaultCtx = activeInstance.engine === 'ollama' ? 32768 : 8192;
        const maxTokens = activeInstance.ctxLen || activeInstance.params?.ctxLen || defaultCtx;

        // Reserve context: System Prompt + 20% for generation buffer
        const systemTokens = this.estimateTokens(systemPrompt);
        const generationBuffer = Math.floor(maxTokens * 0.2);
        let messageBudget = Math.max(maxTokens - systemTokens - generationBuffer, 2048);

        // AGGRESSIVE CONTEXT PRUNING:
        // Local models (especially 3B/8B) suffer from "lost in the middle" with huge contexts.
        // Even if the engine (like Ollama) reports a 32k context window, we strictly cap
        // the chat history budget to keep the attention mechanism focused on recent turns.
        if (activeInstance && (activeInstance.source === 'local' || activeInstance.engine === 'ollama' || (activeInstance.model && activeInstance.model.toLowerCase().includes('3b')))) {
            messageBudget = Math.min(messageBudget, 3072);
            console.log(`[AgentService] 3B/Local Model detected. Forcing aggressive context pruning. messageBudget capped to ${messageBudget}`);
        }

        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        // Ensure active session
        if (!this.activeSessionId) {
            console.log("[AgentService] Creating new session");
            this.newSession();
        }

        // 1. Commit User Message
        console.log("[AgentService] Committing user message to chatHistory");
        const userMsg: ChatMessage = { role: 'user', content: userMessage, images };
        this.chatHistory.push(userMsg);

        console.log("[AgentService] Calling saveSession()");
        this.saveSession();
        console.log("[AgentService] saveSession() completed");

        // 1.5. Initialize Goal Graph if empty
        if (!this.goals.loadGraph(this.activeSessionId)) {
            const description = userMessage.slice(0, 500);
            this.goals.createGraph(this.activeSessionId, "Current Request", description);
        }
        this.goals.incrementTurn();

        // 2. Transient loop state
        const transientMessages: ChatMessage[] = [];
        let turn = 0;
        let finalResponse = "";
        let cumulativeUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

        // Prepare Native Tools
        let tools: any[] = [];
        if (supportsNativeTools) {
            console.log("[AgentService] Generating Native Tool Definitions...");
            tools = this.tools.getToolDefinitions();
            console.log(`[AgentService] Received ${tools.length} native tool definitions`);
        } else {
            console.log("[AgentService] XML Mode: Skipping Native Tool Definitions to save token payload.");
        }

        // ADDED: Circuit breaker for infinite tool failure loops
        let consecutiveToolErrors = 0;

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

                // Economic Intelligence: Determine best brain for this turn
                console.log(`[AgentService] Calling router.route()...`);
                const turnBrain = await this.router?.route(truncatedMessages, systemPrompt) || this.brain;
                console.log(`[AgentService] router.route() returned. Brain selected:`, turnBrain ? 'Yes' : 'No');

                console.log(`[AgentService] Calling this.streamWithBrain()...`);
                const response = await this.streamWithBrain(turnBrain, truncatedMessages, systemPrompt, (token: string) => {
                    if (assistantText.length === 0) {
                        console.log(`[AgentService] Received first token from streamWithBrain!`);
                    }
                    assistantText += token;
                    onToken(token);
                }, signal, tools, { timeout: 1800000, num_ctx: 32768, temperature: profile?.temperature || 0.7 }, onToken);

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
                    finalResponse = this.scrubSecrets(assistantText);
                    break;
                }

                // We track if ANY tool in parallel execution failed
                let currentTurnHadError = false;

                // Execute Native Tools - Parallel where possible
                // We execute "read" tools in parallel, but force "side-effect" tools (browser/terminal)
                // to run sequentially to avoid race conditions (e.g. colliding wait loops).

                const taskExecutors = toolCalls.map((call) => async (): Promise<ChatMessage> => {
                    const functionName = call.function.name;
                    let args = call.function.arguments;

                    if (typeof args === 'string') {
                        try { args = JSON.parse(args); } catch (e) { console.error("Failed to parse tool args", e); }
                    }

                    // Quiet Log for background tools (manage_goals), loud log for high impact (browse/terminal)
                    const isHighImpact = functionName === 'browse' || functionName.startsWith('browser_') || functionName.startsWith('terminal_');
                    if (isHighImpact) {
                        onToken(`\n> *Targeting ${functionName}...*\n`);
                    }
                    let res: any;
                    try {
                        res = await this.tools.executeTool(functionName, args);
                    } catch (err: any) {
                        currentTurnHadError = true;
                        // SELF-HEALING: Summarize complex errors for 3B models
                        const rawError = err.message || String(err);
                        console.error(`Tool Execution Error (${functionName}):`, rawError);

                        // Strip out long stack traces or confusing internal Node.js paths
                        const cleanError = rawError.split('\n')[0].replace(/(\/.*?\/)|([C-Z]:\\.*?\\)/g, '[PATH]/');

                        res = `[TOOL ERROR] Execution failed.\nReason: ${cleanError}\nAction required: Please review the arguments you provided and try a different approach. Do not repeat the exact same tool call.`;
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

                // ADDED: Circuit breaker check
                if (currentTurnHadError) {
                    consecutiveToolErrors++;
                    if (consecutiveToolErrors >= 3) {
                        console.warn(`[AgentService] Circuit breaker tripped! 3 consecutive turns with tool errors.`);
                        onToken(`\n\n> 🛑 *Circuit Breaker Tripped: I'm having trouble executing these tools correctly. I will stop trying and await your guidance.*\n`);
                        transientMessages.push({
                            role: 'system',
                            content: `SYSTEM WARNING: Circuit breaker tripped due to 3 consecutive failed tool execution attempts. The agent loop has been forcefully halted. Please review the errors and ask the user for help or clarification before trying again.`
                        });
                        break; // Break the while (turn < AgentService.MAX_AGENT_ITERATIONS) loop
                    }
                } else {
                    consecutiveToolErrors = 0;
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

        auditLogger.info('chat_completed', 'AgentService', {
            turns: turn,
            totalTokens: cumulativeUsage.total_tokens,
            promptTokens: cumulativeUsage.prompt_tokens,
            completionTokens: cumulativeUsage.completion_tokens
        });
    }

    private scrubSecrets(text: string): string {
        if (!text) return text;

        try {
            const settings = loadSettings(this.settingsPath);
            const firewall = settings.firewall;

            if (!firewall || firewall.enabled === false) {
                return text;
            }

            let scrubbed = text;
            const replacement = firewall.replacementText || '[REDACTED BY QUANTUM FIREWALL]';
            const sensitivity = firewall.sensitivity !== undefined ? firewall.sensitivity : 0.5;

            // Base patterns (always included if sensitivity > 0)
            const activePatterns: RegExp[] = [];

            if (sensitivity > 0) {
                // Use patterns from settings if present, else fallback to hardcoded
                const patternsToUse = (firewall.targetPatterns && Array.isArray(firewall.targetPatterns))
                    ? firewall.targetPatterns
                    : [
                        "sk-[a-zA-Z0-9]{32,}",
                        "ant-api-[a-zA-Z0-9_-]{32,}",
                        "[0-9a-f]{32,}",
                        "AIza[0-9A-Za-z-_]{35}",
                        "xox[bp]-[0-9]{12}-[0-9]{12}-[0-9]{12}-[a-z0-9]{32}"
                    ];

                patternsToUse.forEach((p: string) => {
                    activePatterns.push(new RegExp(p, 'gi'));
                });
            }

            let redactionCount = 0;
            activePatterns.forEach(p => {
                const matches = scrubbed.match(p);
                if (matches) {
                    redactionCount += matches.length;
                    scrubbed = scrubbed.replace(p, replacement);
                }
            });

            if (redactionCount > 0 && firewall.logRedactions) {
                auditLogger.info('firewall_redaction', 'AgentService', {
                    count: redactionCount,
                    patterns: activePatterns.length
                });
            }

            return scrubbed;
        } catch (e) {
            console.error("[AgentService] Firewall error:", e);
            return text;
        }
    }

    /**
     * Wraps brain.streamResponse with retry + exponential backoff.
     * Retries on transient errors (timeout, connection refused, 400/500).
     * Resets the streamed text between retries.
     */
    private async streamWithBrain(
        brain: IBrain,
        messages: any[],
        systemPrompt: string,
        onChunk: (token: string) => void,
        signal: AbortSignal | undefined,
        tools: any[],
        options: any,
        onToken?: (msg: string) => void
    ) {
        console.log(`\n\n[AgentService] ====== ENTERING streamWithBrain ====== `);
        console.log(`[AgentService] Tools passed: ${tools?.length || 0}`);
        let lastError: any;
        for (let attempt = 1; attempt <= AgentService.MAX_INFERENCE_RETRIES; attempt++) {
            try {
                console.log(`[AgentService] About to call brain.streamResponse (attempt ${attempt})...`);
                const result = await brain.streamResponse(messages, systemPrompt, onChunk, signal, tools, options);
                console.log(`[AgentService] brain.streamResponse returned successfully.`);
                return result;
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

                // Abortable wait
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, delay);
                    if (signal) {
                        const onAbort = () => {
                            clearTimeout(timer);
                            reject(new (globalThis.DOMException || Error as any)('Aborted', 'AbortError'));
                        };
                        signal.addEventListener('abort', onAbort, { once: true });
                    }
                });
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
     * Sets the notebook context for the current conversation.
     * When set, RAG searches will be filtered to only include these source paths.
     */
    public setActiveNotebookContext(id: string | null, sourcePaths: string[]) {
        console.log(`[AgentService] Setting Active Notebook Context: ${id} (${sourcePaths.length} sources)`);
        this.activeNotebookContext = { id, sourcePaths };
        return true;
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

        // Pattern 1.5: XML <tool_call> blocks 
        const xmlRegex = /<tool_call\s*>[\s\S]*?<name\s*>(.*?)<\/name\s*>[\s\S]*?<args\s*>([\s\S]*?)<\/args\s*>[\s\S]*?<\/tool_call\s*>/g;
        let xmlMatch;
        while ((xmlMatch = xmlRegex.exec(text)) !== null) {
            const name = xmlMatch[1].trim();
            const rawArgs = xmlMatch[2].trim();
            if (this.tools.hasTool(name)) {
                let args: any = {};
                try {
                    // Strategy: Extract the valid JSON object if possibly followed by garbage (like `>`)
                    const jsonMatch = rawArgs.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        args = JSON.parse(jsonMatch[0]);
                    } else {
                        args = JSON.parse(rawArgs);
                    }
                } catch (e) {
                    // Strategy 2: Try to parse XML-style tags: <arg>value</arg>
                    const argRegex = /<(\w+)\s*>([\s\S]*?)<\/\1\s*>/g;
                    const parsedArgs: any = {};
                    let match;
                    let foundAny = false;
                    while ((match = argRegex.exec(rawArgs)) !== null) {
                        parsedArgs[match[1]] = match[2].trim();
                        foundAny = true;
                    }

                    if (foundAny) {
                        args = parsedArgs;
                    } else if (!rawArgs.trim().startsWith('{')) {
                        // Strategy 3: Try to repair if it lacks outer braces
                        try { args = JSON.parse(`{${rawArgs}}`); } catch (e2) {
                            console.warn("[AgentService] Auto-repair of XML args failed. Passing raw string.");
                            args = rawArgs;
                        }
                    } else {
                        args = rawArgs;
                    }
                }
                toolCalls.push({
                    id: `call_xml_${Math.random().toString(36).substring(7)}`,
                    type: 'function',
                    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
                });
                console.log(`[AgentService DEBUG] Detected XML Tool Call: ${name}`);
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
                        let rawArgs = obj.args || obj.arguments || obj.parameters || (obj.function?.arguments) || {};

                        // Ensure args is an object for Ollama's strict validation
                        if (typeof rawArgs === 'string') {
                            try {
                                // Robust extraction: find the outermost { ... } block
                                const jsonMatch = rawArgs.match(/\{[\s\S]*\}/);
                                if (jsonMatch) {
                                    rawArgs = JSON.parse(jsonMatch[0]);
                                } else {
                                    rawArgs = JSON.parse(rawArgs);
                                }
                            } catch (e) {
                                console.error(`[AgentService] Failed to parse tool arguments for ${name}:`, rawArgs);
                                // Fallback to empty object to satisfy Ollama's strict validation
                                rawArgs = {};
                            }
                        } else if (!rawArgs || typeof rawArgs !== 'object') {
                            // Ensure it's at least an empty object if somehow null/undefined
                            rawArgs = {};
                        }

                        const args = JSON.stringify(rawArgs);

                        if (name && typeof name === 'string') {
                            if (this.tools.hasTool(name)) {
                                toolCalls.push({
                                    id: `call_json_${Math.random().toString(36).substring(7)}`,
                                    type: 'function',
                                    function: { name, arguments: args }
                                });
                                console.log(`[AgentService DEBUG] Detected Unified JSON Tool: ${name}`);
                            } else {
                                // IMPROVEMENT: If the model is clearly trying to use a tool but got the name wrong or hallucinated,
                                // we treat it as an observation of an unknown tool to let the model correct itself,
                                // or we can suppress it if it's likely a hallucination like "hello".
                                console.warn('[AgentService DEBUG] JSON looks like tool but was unknown:', name);
                                if (name === 'hello' || name === 'chat' || name === 'reply') {
                                    // Suppress known hallucination-prone non-tools
                                } else {
                                    toolCalls.push({
                                        id: `call_unknown_${Math.random().toString(36).substring(7)}`,
                                        type: 'function',
                                        function: { name: 'unknown_tool', arguments: JSON.stringify({ attempted_tool: name, message: "This tool does not exist. Use only the provided tools." }) }
                                    });
                                }
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

    /**
     * Retrieves a summary of recent reflection events and proposals.
     * This provides the agent with context on what the system has observed
     * about its own performance (errors, latency, tool failures).
     */
    public getReflectionSummary(): string {
        try {
            const memoryDir = path.join(app.getPath('userData'), 'memory');
            const reflectionsDir = path.join(memoryDir, 'reflections');
            const proposalsDir = path.join(memoryDir, 'proposals');

            let summary = "# [REFLECTION LOGS: SYSTEM STABILITY]\n";

            if (fs.existsSync(reflectionsDir)) {
                const files = fs.readdirSync(reflectionsDir)
                    .filter(f => f.endsWith('.json'))
                    .sort((a, b) => fs.statSync(path.join(reflectionsDir, b)).mtimeMs - fs.statSync(path.join(reflectionsDir, a)).mtimeMs)
                    .slice(0, 3); // Latest 3

                if (files.length > 0) {
                    summary += "## Recent System Observations:\n";
                    for (const f of files) {
                        try {
                            const data = JSON.parse(fs.readFileSync(path.join(reflectionsDir, f), 'utf-8'));
                            summary += `- [${new Date(data.timestamp).toLocaleString()}] ${data.summary}\n`;
                            if (data.observations) {
                                (data.observations as string[]).slice(0, 3).forEach(o => summary += `  * ${o}\n`);
                            }
                        } catch (e) { }
                    }
                }
            }

            if (fs.existsSync(proposalsDir)) {
                const proposalFiles = fs.readdirSync(proposalsDir)
                    .filter(f => f.endsWith('.json'))
                    .filter(f => {
                        try {
                            const p = JSON.parse(fs.readFileSync(path.join(proposalsDir, f), 'utf-8'));
                            return p.status === 'pending';
                        } catch { return false; }
                    })
                    .slice(0, 5);

                if (proposalFiles.length > 0) {
                    summary += "\n## Pending Optimization Proposals:\n";
                    summary += "The following system changes are pending user approval in the Reflection Panel:\n";
                    for (const f of proposalFiles) {
                        try {
                            const p = JSON.parse(fs.readFileSync(path.join(proposalsDir, f), 'utf-8'));
                            summary += `- [${p.category.toUpperCase()}] ${p.title}: ${p.description}\n`;
                        } catch (e) { }
                    }
                }
            }

            return summary === "# [REFLECTION LOGS: SYSTEM STABILITY]\n" ? "" : summary;
        } catch (e) {
            return "";
        }
    }
}
