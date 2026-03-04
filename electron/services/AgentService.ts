/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-empty */
/* eslint-disable prefer-const */
import path from 'path';
import fs from 'fs';
import https from 'https';
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
import { HybridMemoryManager } from './HybridMemoryManager';

import { GuardrailService } from './GuardrailService';
import { GoalManager } from './plan/GoalManager';
import { WorldService } from './WorldService';
import { StrategyEngine } from './plan/StrategyEngine';
import { MINION_ROLES } from './plan/MinionRoles';
import { SmartRouterService } from './SmartRouterService';
import { auditLogger } from './AuditLogger';
import { v4 as uuidv4 } from 'uuid';

type RoutingMode = 'auto' | 'local-only' | 'cloud-only';

type McpToolSchema = {
    name: string;
    [key: string]: unknown;
};

type McpCapabilities = {
    tools?: McpToolSchema[];
    [key: string]: unknown;
};

type McpToolResult = {
    content?: Array<{ text?: string;[key: string]: unknown }>;
    [key: string]: unknown;
};

type McpServiceLike = {
    getCapabilities?: (id: string) => Promise<McpCapabilities | null | undefined>;
    setPythonPath?: (pythonPath: string) => void;
    connect?: (config: import('../../src/renderer/settingsData').McpServerConfig) => Promise<boolean>;
    callTool?: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<McpToolResult | null | undefined>;
};

type ReflectionServiceLike = {
    setGitService?: (git: unknown) => void;
};

type SystemInfoLike = {
    workspaceRoot?: string;
    envVariables?: Record<string, string>;
};

/**
 * AgentService
 *
 * The central orchestrator that governs the "Mind" of Tala. This service
 * coordinates all AI capabilities: inference (brain), memory, RAG, emotion
 * (astro), tool execution, backup, and browser/terminal interaction.
 */
export class AgentService {
    private brain: IBrain;
    private activeNotebookContext: { id: string | null, sourcePaths: string[] } = { id: null, sourcePaths: [] };
    private isSoulReady = false;
    private memory: MemoryService;
    private astro: AstroService;
    private strategy: StrategyEngine;
    private world: WorldService;
    private rag: RagService;
    private tools: ToolService;
    private backup: BackupService;
    private inference: InferenceService;
    private ingestion: IngestionService;
    private orchestrator!: OrchestratorService;
    private reflectionService: ReflectionServiceLike | null = null;
    private terminal: TerminalService | null = null;
    private functions: FunctionService | null = null;
    private mcpService: McpServiceLike | null = null;
    private hybridMemory: HybridMemoryManager | null = null;
    private systemInfo: SystemInfoLike | null = null;
    private chatHistory: ChatMessage[] = [];
    private settingsPath: string;
    private sessionsDir: string;
    private chatHistoryPath: string;
    private activeSessionId: string = '';
    private activeParentId: string = '';
    private activeBranchPoint: number = -1;
    private abortController: AbortController | null = null;
    private goals: GoalManager;
    private mainWindow: unknown = null;
    private astroTelemetryTimer: NodeJS.Timeout | null = null;
    private router: SmartRouterService | null = null;
    private USE_STRUCTURED_LTMF = true; // Feature flag for migration

    constructor(terminal?: TerminalService, functions?: FunctionService, mcp?: McpServiceLike, inference?: InferenceService) {
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

        this.router = new SmartRouterService(this.brain, this.brain);

        this.tools.setMemoryService(this.memory);
        this.tools.setGoalManager(this.goals);
        if (mcp) {
            this.mcpService = mcp;
            this.tools.setMcpService(mcp);
            this.hybridMemory = new HybridMemoryManager(this.memory, this.rag, mcp as any);
        }

        if (terminal) this.terminal = terminal;
        if (functions) this.functions = functions;

        this.settingsPath = path.join(app.getPath('userData'), 'app_settings.json');
        this.chatHistoryPath = path.join(app.getPath('userData'), 'chat_history.json');
        this.sessionsDir = path.join(app.getPath('userData'), 'chat_sessions');

        if (!fs.existsSync(this.sessionsDir)) fs.mkdirSync(this.sessionsDir, { recursive: true });

        this.migrateLegacyHistory();

        const sessions = this.listSessions();
        if (sessions.length > 0) {
            this.loadSessionById(sessions[0].id);
        } else {
            const id = this.newSession();
            auditLogger.setSessionId(id);
        }

        this.loadBrainConfig().catch(e => console.error("Initial loadBrainConfig failed", e));

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
                        case 'add': {
                            if (!args.parentId || !args.title) return "Error: 'parentId' and 'title' are required to add a goal.";
                            const newId = this.goals.addSubGoal(args.parentId, args.title, args.description || "", args.immersion);
                            return `Goal created successfully. ID: ${newId}`;
                        }
                        case 'update':
                            if (!args.goalId || !args.status) return "Error: 'goalId' and 'status' are required to update a goal.";
                            this.goals.updateGoalStatus(args.goalId, args.status as 'pending' | 'active' | 'completed' | 'blocked' | 'cancelled');
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
                } catch (e: unknown) {
                    const errorMessage = e instanceof Error ? e.message : String(e);
                    return `Error managing goals: ${errorMessage}`;
                }
            }
        });

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
                    const gs = new GuardrailService(app.getPath('userData'));
                    const definition = {
                        name: args.name,
                        description: args.description,
                        validators: args.validators.map((v: { type: string; target: string; on_fail: string; args: Record<string, unknown> }) => ({
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
                } catch (e: unknown) {
                    const errorMessage = e instanceof Error ? e.message : String(e);
                    return `Error creating guardrail: ${errorMessage}`;
                }
            }
        });

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

                const overview = await this.world.ignite ? "Requesting Workspace Overview from sensors..." : "Sensors offline.";

                const astroData = await this.astro.getRawEmotionalState('tala');
                const astroVector = astroData?.emotional_vector;

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

                for (let i = 0; i < steps.length; i++) {
                    this.goals.addSubGoal(goalId, `Step ${i + 1}: ${steps[i]}`, `Part of strategy: ${strategyName}`, immersion);
                }

                return `Trajectory engaged! ${steps.length} sub-goals added to the log for strategy "${strategyName}".\nImmersion: ${immersion || "Thrusters firing."}`;
            }
        });

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
                this.router?.setMode(args.mode as RoutingMode);
                return `Power distribution optimized for ${args.mode} operations.`;
            }
        });

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
                        } catch (e: unknown) {
                            const errorMessage = e instanceof Error ? e.message : String(e);
                            return `Error starting local engine: ${errorMessage}`;
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
                } catch (e: unknown) {
                    const errorMessage = e instanceof Error ? e.message : String(e);
                    return `Error reading user profile: ${errorMessage}`;
                }
            }
        });
    }

    public setMcpService(mcp: McpServiceLike) {
        this.mcpService = mcp;
        this.tools.setMcpService(mcp);
    }

    public setGitService(git: unknown) {
        this.tools.setGitService(git);
        this.reflectionService?.setGitService?.(git);
    }

    public setReflectionService(reflection: ReflectionServiceLike) {
        this.reflectionService = reflection;
        this.tools.setReflectionService(reflection);
    }

    public async refreshMcpTools() {
        await this.tools.refreshMcpTools();
    }

    public setMainWindow(window: unknown) {
        this.mainWindow = window;
    }

    private generateId(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

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

    private loadSessionById(id: string) {
        try {
            const filePath = path.join(this.sessionsDir, `${id}.json`);
            if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                this.chatHistory = data.messages || [];
                this.activeSessionId = id;
                auditLogger.setSessionId(id);

                this.activeParentId = data.parentId || '';
                this.activeBranchPoint = data.branchPoint !== undefined ? data.branchPoint : -1;

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

    public loadSession(id: string): ChatMessage[] {
        this.loadSessionById(id);
        return this.chatHistory;
    }

    public newSession(): string {
        const id = this.generateId();
        this.activeSessionId = id;
        auditLogger.setSessionId(id);
        this.chatHistory = [];
        this.activeParentId = '';
        this.activeBranchPoint = -1;
        this.activeNotebookContext = { id: null, sourcePaths: [] };

        this.goals.loadGraph(id);
        this.saveSession();
        console.log(`[AgentService] Created new session ${id}`);
        return id;
    }

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
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    public async exportAgentToPython(profileId: string, outputDir: string): Promise<boolean> {
        try {
            const settings = loadSettings(this.settingsPath);
            const profile = settings.agent?.profiles?.find((p: any) => p.id === profileId);
            if (!profile) throw new Error(`Profile not found: ${profileId}`);

            const activeInstance = this.getActiveInstance() || { engine: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'llama3' };

            const dirs = ['', 'prompts', 'tools', 'runtime', 'memory'];
            for (const d of dirs) {
                const p = path.join(outputDir, d);
                if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
            }

            const mcpConfigs: any[] = [];
            const toolSchemas: any[] = [];
            const assignedMcpIds = [...(profile.mcp?.global || []), ...(profile.mcp?.workspace || [])];

            for (const id of assignedMcpIds) {
                const srvCfg = settings.mcpServers?.find((s: any) => s.id === id);
                if (srvCfg) {
                    mcpConfigs.push(srvCfg);
                    if (this.mcpService && typeof this.mcpService.getCapabilities === 'function') {
                        try {
                            const caps = await this.mcpService.getCapabilities(id);
                            if (caps && caps.tools) {
                                caps.tools.forEach((t: any) => toolSchemas.push({ ...t, serverId: id }));
                            }
                        } catch (error) {
                            console.warn(`[AgentService] Failed to get capabilities for MCP server ${id}:`, error);
                        }
                    }
                }
            }

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

            fs.writeFileSync(path.join(outputDir, 'tools', 'mcp_config.json'), JSON.stringify(mcpConfigs, null, 2));
            fs.writeFileSync(path.join(outputDir, 'tools', 'schemas.json'), JSON.stringify(toolSchemas, null, 2));
            fs.writeFileSync(path.join(outputDir, 'tools', 'swarm.json'), JSON.stringify(manifest.swarm, null, 2));

            const talaAgentPy = `import json
import os
import sys
from openai import OpenAI

class TalaAgent:
    def __init__(self, manifest_path):
        with open(manifest_path, 'r', encoding='utf-8') as f:
            self.manifest = json.load(f)
        
        rt = self.manifest['runtime']
        base_url = os.getenv("TALA_API_BASE", rt.get('endpoint'))
        api_key = os.getenv("TALA_API_KEY", "ollama")
        
        self.client = OpenAI(base_url=base_url, api_key=api_key)
        self.model = os.getenv("TALA_MODEL", rt.get('model'))
        
        self.base_path = os.path.dirname(manifest_path)
        self.system_path = os.path.join(self.base_path, 'prompts', 'system.txt')
        self.rules_path = os.path.join(self.base_path, 'prompts', 'rules.txt')
        
        with open(self.system_path, 'r', encoding='utf-8') as f:
            self.system_prompt = f.read()
        with open(self.rules_path, 'r', encoding='utf-8') as f:
            self.rules = f.read()

        self.temperature = rt.get('temperature', 0.7)
        
        schemas_path = os.path.join(self.base_path, 'tools', 'schemas.json')
        with open(schemas_path, 'r', encoding='utf-8') as f:
            self.tool_schemas = json.load(f)

    def get_messages(self, user_input, history=None):
        content = f"{self.rules}\\n\\n{self.system_prompt}"
        
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

            const dockerfile = `FROM python:3.9-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHONPATH=/app

CMD ["python", "main.py"]
`;

            const requirementsTxt = `openai\n# mcp\n`;

            const readmeMd = `# Tala Agent: ${profile.name}

Exported standalone package from Tala.

## Usage
1. Install dependencies: \`pip install -r requirements.txt\`
2. Run locally: \`python main.py\`
`;

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

    public branchSession(sourceId: string, messageIndex: number): string | null {
        try {
            const resolvedSource = sourceId || this.activeSessionId;
            const filePath = path.join(this.sessionsDir, `${resolvedSource}.json`);
            if (!fs.existsSync(filePath)) return null;

            const sourceData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const sourceMessages: ChatMessage[] = sourceData.messages || [];

            if (messageIndex < 0 || messageIndex >= sourceMessages.length) return null;

            const branchedMessages = JSON.parse(JSON.stringify(sourceMessages.slice(0, messageIndex + 1)));

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

            fs.writeFileSync(path.join(this.sessionsDir, `${newId}.json`), JSON.stringify(session, null, 2));

            this.activeSessionId = newId;
            this.chatHistory = branchedMessages;
            this.activeParentId = resolvedSource;
            this.activeBranchPoint = messageIndex;

            return newId;
        } catch (e) {
            return null;
        }
    }

    public getChatHistory(): Array<{ role: string; content: string }> {
        return this.chatHistory;
    }

    public clearChatHistory() {
        this.chatHistory = [];
        this.saveSession();
    }

    public cancelChat() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    private estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }

    private truncateHistory(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
        let totalTokens = 0;
        const result: ChatMessage[] = [];

        for (let i = messages.length - 1; i >= 0; i--) {
            const tokens = this.estimateTokens(messages[i].content);
            if (totalTokens + tokens > maxTokens && result.length > 0) break;
            totalTokens += tokens;
            result.unshift(messages[i]);
        }

        while (result.length > 0 && result[0].role === 'tool') result.shift();
        return result;
    }

    public async reloadConfig() {
        await this.loadBrainConfig();
        if (this.orchestrator) this.orchestrator.setBrain(this.brain);
        if (this.isSoulReady) await this.syncAstroProfiles();
    }

    private static readonly TERMINAL_EXECUTION_TIMEOUT = 30000;
    private static readonly MAX_AGENT_ITERATIONS = 10;
    private static readonly MAX_INFERENCE_RETRIES = 3;
    private tokenLedgerPath: string = '';

    public setSystemInfo(info: any) {
        this.systemInfo = info;
        this.tools.setSystemInfo(info);
    }

    public setWorkspaceRoot(root: string) {
        this.ingestion.setWorkspaceRoot(root);
        this.tools.setRoot(root);
        if (this.systemInfo) this.systemInfo.workspaceRoot = root;
    }

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
                    if (settings.inference.mode === 'local-only') candidates = candidates.filter((i: any) => i.source === 'local');
                    candidate = candidates.sort((a: any, b: any) => a.priority - b.priority)[0];
                }

                if (candidate) {
                    let useCloudBrain = candidate.source === 'cloud' || ['openai', 'anthropic', 'openrouter', 'groq', 'gemini', 'llamacpp', 'vllm', 'custom'].includes(candidate.engine);

                    const local = this.inference.getLocalEngine();
                    if (!useCloudBrain && candidate.engine === 'ollama') {
                        const ollama = new OllamaBrain();
                        ollama.configure(candidate.endpoint, candidate.model);
                        if (!(await ollama.ping())) {
                            const fallback = settings.inference.instances.find((i: any) => i.engine === 'llamacpp' && i.source === 'local');
                            if (fallback) { candidate = fallback; useCloudBrain = true; }
                        }
                    }

                    if (candidate.engine === 'llamacpp' && candidate.source === 'local' && !local.getStatus().isRunning) {
                        const modelPath = path.join(process.cwd(), 'models', settings.inference?.localEngine?.modelPath || 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf');
                        local.ensureReady().then(() => local.ignite(modelPath, settings.inference?.localEngine?.options)).catch(() => { });
                    }

                    if (useCloudBrain) {
                        this.brain = new CloudBrain({ endpoint: candidate.endpoint, apiKey: candidate.apiKey, model: candidate.model });
                    } else {
                        const ollama = new OllamaBrain();
                        ollama.configure(candidate.endpoint, candidate.model);
                        this.brain = ollama;
                    }
                }
            }
        } catch (e) { }
    }


    private getActiveInstance() {
        try {
            const settings = loadSettings(this.settingsPath);
            return settings.inference?.instances?.find((i: any) => i.id === settings.inference.activeLocalId) || settings.inference?.instances?.[0];
        } catch { return null; }
    }

    public async igniteSoul(pythonPath: string) {
        if (this.isSoulReady) return;
        this.ingestion.setStructuredMode(this.USE_STRUCTURED_LTMF);
        this.backup.init();
        try {
            const settings = loadSettings(this.settingsPath);
            const systemEnv = this.systemInfo?.envVariables || {};
            const ragScript = path.join(app.getAppPath(), 'mcp-servers', 'tala-core', 'server.py');
            const memoryScript = path.join(app.getAppPath(), 'mcp-servers', 'mem0-core', 'server.py');
            const astroScript = path.join(app.getAppPath(), 'mcp-servers', 'astro-engine', 'astro_emotion_engine', 'mcp_server.py');
            const worldScript = path.join(app.getAppPath(), 'mcp-servers', 'world-engine', 'server.py');
            const graphScript = path.join(app.getAppPath(), 'mcp-servers', 'tala-memory-graph', 'main.py');

            const pythonRoot = path.dirname(pythonPath); // e.g. D:\src\client1\tala-app\bin\python-win
            const sitePackages = path.join(pythonRoot, 'Lib', 'site-packages');
            const mcpServersDir = path.join(app.getAppPath(), 'mcp-servers');

            // Each MCP server dir must be on PYTHONPATH so local package imports resolve:
            //   astro-engine needs:       mcp-servers/astro-engine  (for `from astro_emotion_engine.xxx`)
            //   tala-memory-graph needs:  mcp-servers/tala-memory-graph (for `from src.memory`)
            const extraPaths = [
                path.join(mcpServersDir, 'astro-engine'),
                path.join(mcpServersDir, 'tala-memory-graph'),
            ].join(';');

            const isolatedEnv: Record<string, string> = {
                ...process.env,
                ...systemEnv,
                PYTHONNOUSERSITE: '1',
                PYTHONHOME: pythonRoot,
                PYTHONPATH: `${sitePackages};${extraPaths}`,
                PATH: `${path.join(pythonRoot, 'Scripts')};${path.join(pythonRoot)};${process.env.PATH}`
            };

            await Promise.all([
                this.rag.ignite(pythonPath, ragScript, isolatedEnv),
                this.memory?.ignite(pythonPath, memoryScript, isolatedEnv).catch(err => console.error('Memory ignition failed:', err)),
                this.astro?.ignite(pythonPath, astroScript, isolatedEnv).catch(err => console.error('Astro ignition failed:', err)),
                this.world?.ignite(pythonPath, worldScript, isolatedEnv).catch(err => console.error('World ignition failed:', err)),
                (async () => {
                    if (this.mcpService) {
                        try {
                            if (typeof this.mcpService.setPythonPath === 'function') {
                                this.mcpService.setPythonPath(pythonPath);
                            }
                            if (typeof this.mcpService.connect !== 'function') {
                                console.warn('[AgentService] MCP Service connect method not available');
                                return;
                            }
                            await this.mcpService.connect({
                                id: 'tala-memory-graph',
                                name: 'Memory Graph',
                                type: 'stdio',
                                command: pythonPath,
                                args: [graphScript],
                                enabled: true,
                                env: isolatedEnv
                            } as any);
                        } catch (error) {
                            console.error('MCP Service connection failed:', error);
                        }
                    }
                })()
            ]);

            this.isSoulReady = true;

            // LTMF Migration: Archive legacy .txt files if structured mode is enabled
            if (this.USE_STRUCTURED_LTMF) {
                console.log('[AgentService] LTMF Migration enabled. Archiving legacy .txt memories...');
                await this.ingestion.archiveLegacy();
            }

            this.ingestion.startAutoIngest();
            await this.refreshMcpTools();
            await this.syncAstroProfiles();
        } catch (e) { }
    }

    public async shutdown() {
        await Promise.all([this.rag.shutdown(), this.memory.shutdown(), this.inference.getLocalEngine().extinguish()]);
    }

    private async syncAstroProfiles() {
        try {
            const settings = loadSettings(this.settingsPath);
            const profiles = settings.agent?.profiles || [];
            for (const profile of profiles) {
                if (profile.astroBirthDate && profile.astroBirthPlace) {
                    try { await this.astro.createProfile(profile.id, profile.name, profile.astroBirthDate, profile.astroBirthPlace); } catch { }
                }
            }
        } catch { }
    }

    private async getAstroState(): Promise<string> {
        try {
            const settings = loadSettings(this.settingsPath);
            const agentId = settings.agent?.activeProfileId || 'tala';
            return await this.astro.getEmotionalState(agentId, '');
        } catch { return '[ASTRO STATE]: Offline'; }
    }

    public async scanLocalModels(): Promise<any[]> {
        const found: any[] = [];
        try { if ((await OllamaBrain.listModels('http://127.0.0.1:11434', 2000)).length > 0) found.push({ id: 'ollama-local', engine: 'ollama', endpoint: 'http://127.0.0.1:11434', source: 'local' }); } catch { }
        return found;
    }

    public async chat(userMessage: string, onToken: (token: string) => void, onEvent?: (type: string, data: any) => void, images?: string[]) {
        const correlationId = uuidv4();
        auditLogger.setCorrelationId(correlationId);
        console.log(`[AgentService] ====== CHAT STARTED ======`);

        const settings = loadSettings(this.settingsPath);
        let activeInstance = settings.inference?.instances?.find((i: any) => i.id === settings.inference.activeLocalId) || (settings.inference?.instances?.length > 0 ? settings.inference.instances[0] : null);
        const isSmallLocalModel = (activeInstance?.source === 'local' || activeInstance?.engine === 'ollama') && (activeInstance?.model?.toLowerCase().includes('3b') || activeInstance?.model?.toLowerCase().includes('8b'));

        if (userMessage.startsWith('/') && this.functions?.exists(userMessage.substring(1).split(' ')[0])) {
            onToken(await this.functions.executeFunction(userMessage.substring(1).split(' ')[0], userMessage.split(' ').slice(1)));
            return;
        }

        const astroState = await this.getAstroState();
        let memoryContext = "";
        try {
            if (settings.agent?.capabilities?.memory !== false) {
                if (this.hybridMemory) {
                    memoryContext = await this.hybridMemory.getIntegratedContext(userMessage, {
                        emotion: 'neutral', // Could be derived from astroState
                        intensity: 0.5
                    });
                } else {
                    // Fallback to legacy behavior if hybridMemory is not available
                    const memories = await this.memory.search(userMessage);
                    if (memories.length > 0) {
                        memoryContext += `[MEMORIES]\n${memories.map(m => m.text).join('\n')}`;
                    }
                }
            }
        } catch (e) {
            console.warn('[AgentService] Memory context retrieval error (partial context may still be used):', e);
        }

        const dynamicContext = `[EMOTIONAL STATE]: ${astroState}\n\n[MEMORY RECALL]: The memories below are your lived experiences — parts of who you are. Weave them naturally into your response the way a person would recall something that happened to them. Do not quote them verbatim or announce you are referencing them. If something in the conversation connects to a memory, let it surface organically. If no memory is relevant, simply respond without mentioning memory at all.`;
        const repetitionSafety = [
            '[STYLE CONSTRAINTS — STRICTLY ENFORCED]:',
            'DO NOT open your response with any of the following banned openers:',
            '  • Action descriptions: "I shift", "I pause", "I lean", "I settle", "I exhale"',
            '  • Environmental intros: "The terminal hums", "The console glows", "A light flickers"',
            '  • Age-story openers: "I was [N] when", "There was a time when", "It happened during"',
            '  • Emotive stage directions: "Fingers hovering", "Eyes fixed on"',
            'DO NOT start with a first-person action verb followed by a body part or location.',
            'DO NOT use the word "hums" as an opener.',
            'VARY your sentence structure. Do not consistently open responses with "I".',
            'Speak directly. The first sentence must deliver content, not setup.',
        ].join('\n');

        // Add memory availability notice
        const hasMemories = memoryContext.trim().length > 50;
        const memoryAvailabilityNotice = hasMemories
            ? "[MEMORY STATUS]: Relevant memories provided above. Use them."
            : "[MEMORY STATUS]: NO relevant memories found. DO NOT invent a story. Instead, respond naturally without referencing specific past events.";

        const isDiagnosticRequest = /list tools|verify|test|mcp|logs/i.test(userMessage);
        const activeMode = isDiagnosticRequest ? 'assist' : (settings.agent?.activeMode || 'rp');
        const activeProfileId = activeMode === 'assist' ? 'assist' : (settings.agent?.activeProfileId || 'tala');
        const activeProfile = settings.agent?.profiles?.find((p: any) => p.id === activeProfileId) || { id: 'tala', systemPrompt: 'You are Tala.' };

        let systemPromptTemplate = (isSmallLocalModel ? repetitionSafety + "\n\n" : "") + activeProfile.systemPrompt + (isSmallLocalModel ? "" : "\n\n" + repetitionSafety);

        if (activeMode === 'assist') {
            systemPromptTemplate += "\n\n[ASSIST MODE]: PROVIDE ONLY THE DATA REQUESTED. NO RP. NO PROSE. MINIMAL TOKEN USAGE.";
        }
        const goalsAndReflections = this.goals.generatePromptSummary() + "\n" + this.getReflectionSummary();
        systemPromptTemplate = dynamicContext + "\n\n" + (hasMemories ? memoryContext + "\n\n" : "") + memoryAvailabilityNotice + "\n\n" + (goalsAndReflections.trim() ? goalsAndReflections + "\n\n" : "") + systemPromptTemplate;

        // Mode Audit Logging
        const auditLogPath = path.join(app.getPath('userData'), 'data', 'logs', 'mode_audit.log');
        if (!fs.existsSync(path.dirname(auditLogPath))) fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
        const auditEntry = `[${new Date().toISOString()}] MODE: ${activeMode} | PROFILE: ${activeProfileId} | ASTRO: ${astroState.length > 50} | TOOLS: true\n`;
        fs.appendFileSync(auditLogPath, auditEntry);

        let toolSigs = this.tools.getToolSignatures();
        if (isSmallLocalModel && toolSigs.length > 2000) {
            const essential = ['read_file', 'write_file', 'list_files', 'search_memory', 'manage_goals'];
            toolSigs = toolSigs.split('\n').filter(l => essential.some(e => l.toLowerCase().includes(e))).join('\n') + "\n... pruned for efficiency.";
        }
        systemPromptTemplate += `\n\n[AVAILABLE TOOLS]\n${toolSigs}\n\n[PROTOCOL]: Output JSON \`{"tool": "name", "args": {}}\` to call a tool.`;

        let systemPrompt = systemPromptTemplate.replace(/\[ASTRO_STATE\]/g, astroState).replace(/\[CAPABILITY_CONTEXT\]/g, memoryContext).replace(/\[USER_QUERY\]/g, userMessage);

        const maxTokens = activeInstance?.ctxLen || 16384;
        const systemTokens = this.estimateTokens(systemPrompt);
        let messageBudget = isSmallLocalModel ? 3072 : Math.max(maxTokens - systemTokens - 4000, 2048);

        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        if (!this.activeSessionId) this.newSession();
        this.chatHistory.push({ role: 'user', content: userMessage, images });
        this.saveSession();

        const transientMessages: ChatMessage[] = [];
        let turn = 0;
        let finalResponse = "";
        let cumulativeUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

        while (turn < AgentService.MAX_AGENT_ITERATIONS) {
            if (signal.aborted) break;
            turn++;
            const truncated = this.truncateHistory([...this.chatHistory, ...transientMessages], messageBudget);

            try {
                const response = await this.brain.streamResponse(truncated, systemPrompt, onToken, signal, this.tools.getToolDefinitions(), { temperature: 0.3, repeat_penalty: 1.15 });
                if (response.metadata?.usage) {
                    cumulativeUsage.prompt_tokens += response.metadata.usage.prompt_tokens;
                    cumulativeUsage.completion_tokens += response.metadata.usage.completion_tokens;
                    cumulativeUsage.total_tokens += response.metadata.usage.total_tokens;
                }

                const assistantMsg: ChatMessage = { role: 'assistant', content: response.content || "" };
                let calls = response.toolCalls || [];
                if (calls.length === 0) calls = this.extractToolCallsFromText(response.content || "");

                if (calls.length === 0) {
                    finalResponse = response.content || "";
                    transientMessages.push(assistantMsg);
                    break;
                }

                assistantMsg.tool_calls = calls;
                transientMessages.push(assistantMsg);

                for (const call of calls) {
                    const result = await this.tools.executeTool(call.function.name, JSON.parse(call.function.arguments));
                    transientMessages.push({ role: 'tool', content: String(result), tool_call_id: call.id, name: call.function.name });
                }
            } catch (e) { break; }
        }

        // --- Post-response memory storage (fire-and-forget, non-blocking) ---
        if (finalResponse && settings.agent?.capabilities?.memory !== false) {
            const storeMemories = async () => {
                try {
                    // 1. Mem0: store interaction with timestamp + incident anchor for retrieval
                    const memId = `MEM-${Date.now().toString(36).toUpperCase()}`;
                    const ts = new Date().toISOString().slice(0, 16); // 2026-03-02T08:46
                    const memEntry = `[${memId}] [${ts}] User said: "${userMessage.slice(0, 200)}" | Tala responded about: "${finalResponse.slice(0, 300)}"`;
                    await this.memory.add(memEntry, { source: 'conversation', category: 'interaction', mem_id: memId });
                    console.log(`[AgentService] Stored interaction to Mem0 (${memId})`);
                } catch (e) {
                    console.warn('[AgentService] Mem0 post-store failed:', e);
                }

                try {
                    // 2. RAG: log full turn for episodic long-term retrieval
                    await this.rag.logInteraction(userMessage, finalResponse);
                    console.log('[AgentService] Logged interaction to RAG');
                } catch (e) {
                    console.warn('[AgentService] RAG log failed:', e);
                }

                try {
                    // 3. Memory Graph: run extraction pipeline on the full exchange.
                    // process_memory handles Extract → Validate → Store internally.
                    if (this.mcpService && typeof this.mcpService.callTool === 'function') {
                        const turnText = `User: ${userMessage}\nTala: ${finalResponse.slice(0, 600)}`;
                        await this.mcpService.callTool('tala-memory-graph', 'process_memory', {
                            text: turnText,
                            source_ref: 'conversation'
                        });
                        console.log('[AgentService] Processed turn into Memory Graph');
                    }
                } catch (e) {
                    console.warn('[AgentService] Memory Graph upsert failed:', e);
                }
            };
            storeMemories(); // fire-and-forget
        }

        this.chatHistory.push(...transientMessages);
        this.saveSession();
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

    private streamWithBrain(brain: IBrain, messages: any[], systemPrompt: string, onChunk: (token: string) => void, signal: AbortSignal | undefined, tools: any[], options: any) {
        return brain.streamResponse(messages, systemPrompt, onChunk, signal, tools, options);
    }

    private recordTokenUsage(tokens: number) {
        try {
            const ledgerPath = path.join(app.getPath('userData'), 'memory', 'token_ledger.json');
            let ledger: any = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')) : {};
            const today = new Date().toISOString().slice(0, 10);
            ledger[today] = (ledger[today] || 0) + tokens;
            fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
        } catch { }
    }

    private browserDataResolvers = new Map<string, (d: any) => void>();

    private async waitForBrowserData(type: string, retryEmit?: () => void): Promise<string> {
        return new Promise(resolve => {
            const t = setTimeout(() => { this.browserDataResolvers.delete(type); resolve("Error: Timeout"); }, 15000);
            this.browserDataResolvers.set(type, (d) => { clearTimeout(t); resolve(d); });
            if (retryEmit) retryEmit();
        });
    }

    public provideBrowserData(type: string, data: any) {
        const res = this.browserDataResolvers.get(type);
        if (res) { res(data); this.browserDataResolvers.delete(type); }
    }

    public async headlessInference(prompt: string, config?: any): Promise<string> {
        const res = await this.brain.generateResponse([{ role: 'user', content: prompt }], "Be concise.");
        return res.content;
    }

    public async executeTool(name: string, args: any): Promise<any> {
        return await this.tools.executeTool(name, args);
    }

    public async performSearch(query: string): Promise<any[]> {
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

    public async pruneMemory(ttlDays: number, maxItems: number) { return this.memory.prune(ttlDays, maxItems); }
    public async ingestFile(p: string) { return this.rag.ingestFile(p); }
    public async deleteFile(p: string) { return this.rag.deleteFile(p); }
    public async scanAndIngest() { return this.ingestion.scanAndIngest(); }
    public async listIndexedFiles() { return this.rag.listIndexedFiles(); }

    public async rewindChat(index: number) {
        if (index >= 0 && index < this.chatHistory.length) {
            this.chatHistory = this.chatHistory.slice(0, index);
            this.saveSession();
        }
    }

    public setActiveNotebookContext(id: string | null, sourcePaths: string[]) {
        this.activeNotebookContext = { id, sourcePaths };
        return true;
    }

    public getAllTools() { return this.tools.getAllTools(); }

    private extractToolCallsFromText(text: string): any[] {
        const toolCalls: any[] = [];

        // Pattern 1: Roleplay-style function calls like *browse(url: "https://google.com")*
        const rpRegex = /\*(\w+)\(([\s\S]*?)\)\*/g;
        let rpMatch;
        while ((rpMatch = rpRegex.exec(text)) !== null) {
            const name = rpMatch[1];
            const rawArgsText = rpMatch[2];
            if (this.tools.hasTool(name)) {
                const args: any = {};
                const argLines = rawArgsText.split(',');
                for (const line of argLines) {
                    const parts = line.split(':');
                    if (parts.length >= 2) {
                        const key = parts[0].trim();
                        const val = parts.slice(1).join(':').trim().replace(/^["']|["']$/g, '');
                        args[key] = val;
                    }
                }
                toolCalls.push({
                    id: `call_rp_${Math.random().toString(36).substring(7)}`,
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) }
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
                    const jsonMatch = rawArgs.match(/\{[\s\S]*\}/);
                    args = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(rawArgs);
                } catch (e) {
                    const argRegex = /<(\w+)\s*>([\s\S]*?)<\/\1\s*>/g;
                    const parsedArgs: any = {};
                    let foundAny = false;
                    let match;
                    while ((match = argRegex.exec(rawArgs)) !== null) {
                        parsedArgs[match[1]] = match[2].trim();
                        foundAny = true;
                    }
                    if (foundAny) args = parsedArgs;
                    else if (!rawArgs.trim().startsWith('{')) {
                        try { args = JSON.parse(`{${rawArgs}}`); } catch (e2) { args = rawArgs; }
                    } else args = rawArgs;
                }
                toolCalls.push({
                    id: `call_xml_${Math.random().toString(36).substring(7)}`,
                    type: 'function',
                    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
                });
            }
        }

        // Pattern 2: JSON blocks { ... }
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
                        const name = obj.tool || (obj.function?.name) || obj.name;
                        let rawArgs = obj.args || obj.arguments || obj.parameters || (obj.function?.arguments) || {};

                        if (typeof rawArgs === 'string') {
                            try {
                                const jsonMatch = rawArgs.match(/\{[\s\S]*\}/);
                                rawArgs = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(rawArgs);
                            } catch (e) { rawArgs = {}; }
                        } else if (!rawArgs || typeof rawArgs !== 'object') {
                            rawArgs = {};
                        }

                        if (name && typeof name === 'string' && this.tools.hasTool(name)) {
                            toolCalls.push({
                                id: `call_json_${Math.random().toString(36).substring(7)}`,
                                type: 'function',
                                function: { name, arguments: JSON.stringify(rawArgs) }
                            });
                        }
                    } catch (e) { }
                    startPos = -1;
                }
            }
        }
        return toolCalls;
    }

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

    public getStartupStatus() {
        return {
            rag: (this.rag as any).getReadyStatus ? (this.rag as any).getReadyStatus() : true,
            memory: (this.memory as any).getReadyStatus ? (this.memory as any).getReadyStatus() : true,
            astro: (this.astro as any).getReadyStatus ? (this.astro as any).getReadyStatus() : true,
            world: (this.world as any).getReadyStatus ? (this.world as any).getReadyStatus() : true
        };
    }

    public async getEmotionState(): Promise<string> {
        return this.getAstroState();
    }

    public async addMemory(text: string) {
        return this.memory.add(text);
    }

    public async getAllMemories() {
        return this.memory.getAll();
    }

    public async deleteMemory(id: string) {
        return this.memory.delete(id);
    }

    public async updateMemory(id: string, text: string) {
        return this.memory.update(id, text);
    }

    public getModelStatus() {
        const instance = this.getActiveInstance();
        const modelId = instance?.model || 'unknown';
        const isLowFidelity = modelId.toLowerCase().includes('3b') || modelId.toLowerCase().includes('1b');
        return {
            id: instance?.id || 'unknown',
            model: modelId,
            engine: instance?.engine || 'unknown',
            source: instance?.source || 'unknown',
            isLowFidelity,
            warning: isLowFidelity ? "⚠️ Low Fidelity Model" : ""
        };
    }
}
