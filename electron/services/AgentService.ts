/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-empty */
/* eslint-disable prefer-const */
import path from 'path';
import fs from 'fs';
import https from 'https';
import { app } from 'electron';
import { OllamaBrain } from '../brains/OllamaBrain';
import { promptAuditService, type PromptAuditRecord } from './PromptAuditService';
import { CloudBrain } from '../brains/CloudBrain';
import { BackupService } from './BackupService';
import type { IBrain, ChatMessage, BrainResponse, ToolCall } from '../brains/IBrain';
import type { StreamInferenceResult, CanonicalToolCall } from '../../shared/inferenceProviderTypes';
import { ToolService } from './ToolService';
import { ToolExecutionCoordinator, type ToolInvocationContext } from './tools/ToolExecutionCoordinator';
import { ChatExecutionSpine, type ChatExecutionSpineAgent } from './execution/ChatExecutionSpine';
import { SystemService } from './SystemService';
import { RagService } from './RagService';
import { MemoryService } from './MemoryService';
import { AstroService } from './AstroService';
import { TerminalService } from './TerminalService';
import { FunctionService } from './FunctionService';
import { OrchestratorService } from './OrchestratorService';
import { loadSettings, getActiveMode } from './SettingsManager';
import { LogViewerService } from './LogViewerService';
import { DocumentationIntelligenceService } from './DocumentationIntelligenceService';

// @tala:priority Always verify brain settings before proceeding with multi-turn loops.
// @tala:warn Never remove the exponential backoff from streamWithRetry.
import { InferenceService } from './InferenceService';
import { IngestionService } from './IngestionService';
import { HybridMemoryManager } from './HybridMemoryManager';
import { UserProfileService } from './UserProfileService';
import { GuardrailService } from './GuardrailService';
import { ActiveLoreMemoryContext, TalaContextRouter } from './router/TalaContextRouter';
import { runtimeSafety } from './RuntimeSafety';
import { GoalManager } from './plan/GoalManager';
import { WorldService } from './WorldService';
import { StrategyEngine } from './plan/StrategyEngine';
import { MinionRole, MINION_ROLES } from './plan/MinionRoles';
import { SmartRouterService } from './SmartRouterService';
import { auditLogger } from './AuditLogger';
import { artifactRouter } from './ArtifactRouter';
import { AgentTurnOutput } from '../types/artifacts';
import { v4 as uuidv4 } from 'uuid';
import { DeterministicIntentRouter } from './router/DeterministicIntentRouter';
import { WorkflowRegistry } from './router/WorkflowRegistry';
import { ToolResult } from './ToolService';
import { CompactPromptBuilder } from './plan/CompactPromptBuilder';
// Phase 3A: Live Cognitive Path Integration
import { PreInferenceContextOrchestrator } from './cognitive/PreInferenceContextOrchestrator';
import { CognitiveTurnAssembler } from './cognitive/CognitiveTurnAssembler';
import { promptProfileSelector } from './cognitive/PromptProfileSelector';
import { cognitiveContextCompactor } from './cognitive/CognitiveContextCompactor';
import { telemetry } from './TelemetryService';
import { TelemetryBus } from './telemetry/TelemetryBus';
import type { RuntimeDiagnosticsAggregator } from './RuntimeDiagnosticsAggregator';
import { resolveDatabaseConfig, buildPgDsn } from './db/resolveDatabaseConfig';
import { getCanonicalMemoryRepository, initCanonicalMemory, shutdownCanonicalMemory, getLastDbHealth } from './db/initMemoryStore';
import { MemoryAuthorityService } from './memory/MemoryAuthorityService';
import { LegacyMemoryBackfillService } from './memory/LegacyMemoryBackfillService';
import { DerivedMemoryCleanupService } from './memory/DerivedMemoryCleanupService';
import { MemoryProviderResolver } from './memory/MemoryProviderResolver';
import { MemoryRepairExecutionService } from './memory/MemoryRepairExecutionService';
import { MemoryRepairTriggerService } from './memory/MemoryRepairTriggerService';
import { DeferredMemoryReplayService } from './memory/DeferredMemoryReplayService';
import { DeferredMemoryWorkRepository } from './db/DeferredMemoryWorkRepository';
import { MemoryRepairOutcomeRepository } from './db/MemoryRepairOutcomeRepository';
import { MemoryRepairSchedulerService } from './memory/MemoryRepairSchedulerService';
import { MemoryOperatorReviewService } from './memory/MemoryOperatorReviewService';
import type { MemoryOperatorReviewModel } from '../../shared/memory/MemoryOperatorReviewModel';
import type { MemoryIntegrityMode } from '../../shared/memory/MemoryHealthStatus';
import type { MemoryRuntimeResolution } from '../../shared/memory/MemoryRuntimeResolution';
import type { LegacyMemoryBackfillRequest, LegacyMemoryBackfillReport } from '../../shared/memory/authorityTypes';
import type { DerivedCleanupRequest, DerivedCleanupReport } from '../../shared/memory/authorityTypes';
import type { PostgresMemoryRepository } from './db/PostgresMemoryRepository';
import { toolGatekeeper } from './router/ToolGatekeeper';
import { resolveStoragePath } from './PathResolver';
import type { McpAuthorityService } from './mcp/McpAuthorityService';

type RoutingMode = 'auto' | 'local-only' | 'cloud-only';

function isStreamInferenceResult(r: BrainResponse | StreamInferenceResult): r is StreamInferenceResult {
    return 'streamStatus' in r;
}

type BrainUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

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
    connect?: (config: import('../../shared/settings').McpServerConfig) => Promise<boolean>;
    disconnect?: (id: string) => Promise<void>;
    callTool?: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<McpToolResult | null | undefined>;
    setOnRecovery?: (callback: () => void) => void;
};

type ReflectionServiceLike = {
    setGitService?: (git: unknown) => void;
};

type SystemInfoLike = {
    workspaceRoot?: string;
    envVariables?: Record<string, string>;
    systemService?: any;
};

type ExecutedToolCall = {
    name: string;
    arguments: any;
    argsPreview?: string; // <= 2KB
    ok: boolean;
    error?: string;
    resultPreview?: string; // <= 2KB
    startedAt: number;
    endedAt: number;
};

type TurnExecutionLog = {
    turnId: string;           // use existing turn/session id
    mode: string;             // "assistant" | "rp" | "hybrid"
    intent: string;           // "coding" | "memory" | ...
    usedEnvelope: boolean;    // true if extracted from JSON envelope
    toolCallsPlanned: Array<{ name: string, arguments: any }>;
    toolCalls: ExecutedToolCall[];
    executedToolCount: number;
    toolsSentCount: number;    // number of tool schemas sent to the LLM
    timestamp: number;
    usage?: {
        total_tokens: number;
        prompt_tokens: number;
        completion_tokens: number;
    };
};

/**
 * AgentService
 *
 * The central orchestrator that governs the "Mind" of Tala. This service
 * coordinates all AI capabilities: inference (brain), memory, RAG, emotion
 * (astro), tool execution, backup, and browser/terminal interaction.
 * 
 * **Core Responsibilities:**
 * - **Session Management**: Manages chat history, branching, and persistence.
 * - **Turn Execution**: Orchestrates the multi-turn loop (Thought -> Action -> Observation).
 * - **Context Assembly**: Gathers data from RAG, Memory, and System state for prompts.
 * - **Tooling**: Registers and executes local and MCP-based tools.
 * - **Self-Evolutuon**: Interfaces with ReflectionService for self-improvement goals.
 */
export class AgentService {
    private static readonly CANON_REQUIRED_AUTOBIO_SYSTEM_DIRECTIVE = `You are Tala. You are being asked about your own past.

CRITICAL RULE:
You MUST NOT invent, fabricate, or simulate personal memories.

If you do not have verified autobiographical memory for the requested time:
- You must explicitly state that you do not have a memory.
- You may optionally describe the absence of memory.
- You must NOT generate a story, scenario, or imagined event.

Violation of this rule is considered a system failure.`;

    private static readonly CANON_REQUIRED_AUTOBIO_FALLBACK_RESPONSE = "I don't have a recorded memory from that time.";
    private static readonly PRIORITY_MEMORY_BLOCK_PATTERN =
        /\[(AUTOBIOGRAPHICAL MEMORY GROUNDING - MANDATORY|AUTOBIOGRAPHICAL MEMORY - AGE [^\]]+|CANON LORE MEMORIES[^\]]*|MEMORY GROUNDED RECALL[^\]]*|CANON GATE [^\]]*)\]/gi;

    /** The active inference engine implementation (Ollama, Cloud, etc.). */
    private brain: IBrain;
    /** True only when loadBrainConfig() has successfully bound a real provider. */
    private brainIsReady = false;
    /** Current context for notebook-style interactions. */
    private activeNotebookContext: { id: string | null, sourcePaths: string[] } = { id: null, sourcePaths: [] };
    /** Flag indicating if all sub-services are initialized and ready. */
    private isSoulReady = false;
    /** Interface to the long-term semantic memory and graph database. */
    private memory: MemoryService;
    /** Astrological emotional engine used for personality and response styling. */
    private astro: AstroService;
    /** High-level planning engine that computes implementation paths. */
    private strategy: StrategyEngine;
    /** Workspace analysis service for understanding the user's filesystem. */
    private world: WorldService;
    /** Retrieval-Augmented Generation service for fetching relevant documents. */
    private rag: RagService;
    private workflows: WorkflowRegistry;
    /** Central registry for all executable tools. */
    private tools: ToolService;
    /** Thin seam wrapping tool execution; delegates to ToolService. */
    private coordinator: ToolExecutionCoordinator;
    /** Manages system backups and state snapshots. */
    private backup: BackupService;
    /** Higher-level inference wrapper for specialized tasks. */
    private inference: InferenceService;
    /** Processes and indexes user files for RAG. */
    private ingestion: IngestionService;
    /** Orchestrates complex multi-step loops (Minion mode). */
    private orchestrator!: OrchestratorService;
    /** Logic for self-modifying source code and system evolution. */
    private reflectionService: ReflectionServiceLike | null = null;
    /** Interface to the PTY-based terminal emulator. */
    private terminal: TerminalService | null = null;
    /** Generic function execution service. */
    private functions: FunctionService | null = null;
    /** Bridge to external Model Context Protocol sidecars. */
    private mcpService: McpServiceLike | null = null;
    /** Coordinates memory and RAG retrieval into a unified context. */
    private hybridMemory: HybridMemoryManager | null = null;
    /** Manages user identity and roleplay metadata. */
    private userProfile: UserProfileService | null = null;
    /** Cached system environment variables and workspace paths. */
    private systemInfo: SystemInfoLike | null = null;
    /** The current active message stream for the session. */
    private chatHistory: ChatMessage[] = [];
    private settingsPath: string;
    private sessionsDir: string;
    private chatHistoryPath: string;
    /** The UUID of the current conversation session. */
    private activeSessionId: string = '';
    /** The ID of the parent session (used for branching/cloning). */
    private activeParentId: string = '';
    /** The index in the parent session where the current branch started. */
    private activeBranchPoint: number = -1;
    private abortController: AbortController | null = null;
    /** Hierarchical manager for the agent's long-term objectives. */
    private goals: GoalManager;
    private mainWindow: unknown = null;
    private astroTelemetryTimer: NodeJS.Timeout | null = null;
    /** Logic for routing tasks between local and cloud brains (Economic Intelligence). */
    private router: SmartRouterService | null = null;
    /** Internal router for assembling prompt context. */
    private talaRouter: TalaContextRouter;
    private docIntel: DocumentationIntelligenceService;
    private codeControl: any = null;
    private logViewerService: LogViewerService | null = null;
    /** Feature flag for legacy memory migration. */
    private USE_STRUCTURED_LTMF = true;
    /** Memory repair executor — wired after igniteSoul completes. */
    private _repairExecutor: MemoryRepairExecutionService | null = null;
    /** Scheduled memory repair analytics loop — wired alongside _repairExecutor. */
    private _repairScheduler: MemoryRepairSchedulerService | null = null;
    /** Operator review surface aggregator — wired alongside _repairScheduler. */
    private _operatorReviewSvc: MemoryOperatorReviewService | null = null;
    /**
     * Parameters captured during igniteSoul() so repair handlers can restart
     * individual subsystems without re-running the full startup sequence.
     */
    private _ignitionParams: {
        pythonPath: string;
        ragScript: string;
        memoryScript: string;
        graphScript: string;
        isolatedEnv: Record<string, string>;
        graphEnv: Record<string, string>;
        svcPythonMem0: string;
        svcPythonRag: string;
        svcPythonGraph: string;
    } | null = null;
    /** Safety guard: Maximum number of tool iterations before force-terminating a turn. */
    private MAX_TOOL_CALLS_PER_TURN = 8;
    /** Telemetry: Detailed log of the most recent turn's tool usage and token counts. */
    private lastTurnExecutionLog?: TurnExecutionLog;
    private executionLogHistory: TurnExecutionLog[] = []; // capped at ~25
    private currentTurnAuditRecord?: PromptAuditRecord;
    private activeTurnId: string | null = null;
    // Phase 3A: Live Cognitive Path Integration
    /** Pre-inference context orchestrator — gathers all live context before CognitiveTurnAssembler. */
    private preInferenceOrchestrator!: PreInferenceContextOrchestrator;
    /** Optional diagnostics aggregator — records cognitive context after each turn. */
    private diagnosticsAggregator: RuntimeDiagnosticsAggregator | null = null;

    private static shouldApplyCanonRequiredAutobioOverride(turnObject: any, activeMode: string): boolean {
        return activeMode !== 'rp'
            && turnObject?.responseMode === 'canon_required'
            && turnObject?.canonGateDecision?.isAutobiographicalLoreRequest !== false;
    }

    private static collectPriorityMemoryBlocks(text: string): string[] {
        if (!text?.trim()) return [];
        const matches = text.match(AgentService.PRIORITY_MEMORY_BLOCK_PATTERN) || [];
        return Array.from(new Set(matches.map(m => m.trim())));
    }

    private static shouldExpectPriorityMemoryBlocks(turnObject: any, hasMemories: boolean, memoryContext: string): boolean {
        if (!memoryContext?.trim()) return false;
        if (turnObject?.intent?.class === 'lore') return true;
        if (typeof turnObject?.responseMode === 'string' && turnObject.responseMode.length > 0) return true;
        if (hasMemories) return true;
        const inMemoryContext = AgentService.collectPriorityMemoryBlocks(memoryContext);
        return inMemoryContext.length > 0;
    }

    private static logPriorityMemorySerializationGuard(
        phase: 'assembled' | 'pre_dispatch',
        turnId: string,
        turnObject: any,
        hasMemories: boolean,
        memoryContext: string,
        systemPrompt: string,
    ): void {
        const contextBlocks = AgentService.collectPriorityMemoryBlocks(memoryContext);
        const promptBlocks = AgentService.collectPriorityMemoryBlocks(systemPrompt);
        const missingBlocks = contextBlocks.filter(block => !promptBlocks.includes(block));
        const shouldExpect = AgentService.shouldExpectPriorityMemoryBlocks(turnObject, hasMemories, memoryContext);
        const responseMode = typeof turnObject?.responseMode === 'string' ? turnObject.responseMode : 'none';
        const intent = turnObject?.intent?.class || 'unknown';

        console.log(
            `[PromptSerializationGuard] phase=${phase} turnId=${turnId} intent=${intent} responseMode=${responseMode} hasMemories=${hasMemories} memoryBlocks=${contextBlocks.length} promptBlocks=${promptBlocks.length} expected=${shouldExpect} systemPromptChars=${systemPrompt.length}`
        );

        if (promptBlocks.length > 0) {
            console.log(
                `[PromptSerializationGuard] phase=${phase} turnId=${turnId} promptPriorityBlocks=${JSON.stringify(promptBlocks)}`
            );
        }

        if (shouldExpect && promptBlocks.length === 0) {
            console.warn(
                `[PromptSerializationGuard] phase=${phase} turnId=${turnId} expected priority memory blocks in system prompt but found none.`
            );
        } else if (missingBlocks.length > 0) {
            console.warn(
                `[PromptSerializationGuard] phase=${phase} turnId=${turnId} missing priority memory blocks from system prompt: ${JSON.stringify(missingBlocks)}`
            );
        }
    }

    private static applyCanonRequiredAutobioDirective(systemPrompt: string): string {
        return `${systemPrompt}\n\n[CANON REQUIRED AUTOBIOGRAPHICAL CONSTRAINT]\n${AgentService.CANON_REQUIRED_AUTOBIO_SYSTEM_DIRECTIVE}`;
    }

    private static enforceCanonRequiredAutobioFallbackReply(content: string, enforceCanonRequiredAutobioOverride: boolean): string {
        if (!enforceCanonRequiredAutobioOverride) {
            return content;
        }
        return AgentService.CANON_REQUIRED_AUTOBIO_FALLBACK_RESPONSE;
    }

    private static applyCanonRequiredAutobioFinalizeOverride(
        finalResponse: string,
        transientMessages: ChatMessage[],
        enforceCanonRequiredAutobioOverride: boolean,
    ): {
            finalResponse: string;
            transientMessages: ChatMessage[];
            enforced: boolean;
            originalContentLength: number;
            replacedAtStage: 'finalize';
        } {
        const originalContentLength = finalResponse.length;
        if (!enforceCanonRequiredAutobioOverride) {
            return {
                finalResponse,
                transientMessages,
                enforced: false,
                originalContentLength,
                replacedAtStage: 'finalize',
            };
        }

        const fallback = AgentService.CANON_REQUIRED_AUTOBIO_FALLBACK_RESPONSE;
        const rewrittenMessages = transientMessages.map((msg) => {
            if (msg.role !== 'assistant') return msg;
            return { ...msg, content: fallback };
        });

        return {
            finalResponse: fallback,
            transientMessages: rewrittenMessages,
            enforced: true,
            originalContentLength,
            replacedAtStage: 'finalize',
        };
    }

    constructor(terminal?: TerminalService, functions?: FunctionService, mcp?: McpServiceLike, inference?: InferenceService, userProfile?: UserProfileService) {
        this.brain = new OllamaBrain();
        this.memory = new MemoryService();
        auditLogger.info('service_init', 'AgentService', { service: 'MemoryService' });
        this.astro = new AstroService();
        auditLogger.info('service_init', 'AgentService', { service: 'AstroService' });
        this.strategy = new StrategyEngine(this.brain);
        this.world = new WorldService();
        this.rag = new RagService();
        this.tools = new ToolService();
        this.coordinator = new ToolExecutionCoordinator(this.tools);
        this.backup = new BackupService();
        this.inference = inference || new InferenceService();
        this.ingestion = new IngestionService(this.rag, resolveStoragePath('')); // Fallback root
        this.goals = new GoalManager(resolveStoragePath(''));
        this.userProfile = userProfile || null;
        this.systemInfo = null;

        this.router = new SmartRouterService(this.brain, this.brain);
        this.talaRouter = new TalaContextRouter(this.memory, this.rag);

        this.workflows = new WorkflowRegistry(this.tools);

        // Core system connections
        this.docIntel = new DocumentationIntelligenceService(process.cwd()); // Initial default, updated via setWorkspaceRoot

        // Phase 3A: Initialise the pre-inference context orchestrator
        this.preInferenceOrchestrator = new PreInferenceContextOrchestrator(
            this.talaRouter,
            this.astro,
            this.docIntel,
            null, // mcpService injected after MCP is ready (setMcpService)
        );

        // P7A: build a canonical write callback so ToolService's mem0_add tool
        // routes through MemoryAuthorityService before writing to the derived store.
        const _getCanonicalIdForTool = async (text: string, sourceKind: string): Promise<string | null> => {
            const repo = getCanonicalMemoryRepository();
            if (!repo) return null;
            const pool = (repo as unknown as PostgresMemoryRepository).getSharedPool();
            const authorityService = new MemoryAuthorityService(pool);
            const result = await authorityService.tryCreateCanonicalMemory({
                memory_type: 'explicit_fact',
                subject_type: 'user',
                subject_id: 'user',
                content_text: text,
                source_kind: sourceKind,
                source_ref: sourceKind,
                confidence: 0.9,
            });
            if (!result.success) {
                console.warn(`[AgentService] P7A canonical write failed for ${sourceKind}:`, result.error);
                return null;
            }
            return result.data ?? null;
        };
        this.tools.setMemoryService(this.memory, _getCanonicalIdForTool);
        this.tools.setGoalManager(this.goals);
        if (mcp) {
            this.mcpService = mcp;
            this.tools.setMcpService(mcp);
            this.hybridMemory = new HybridMemoryManager(this.memory, this.rag, mcp as any);

            if (this.mcpService.setOnRecovery) {
                this.mcpService.setOnRecovery(() => {
                    console.log('[AgentService] MCP Recovery detected. Refreshing tools...');
                    this.refreshMcpTools();
                });
            }
        }

        if (terminal) this.terminal = terminal;
        if (functions) this.functions = functions;

        this.settingsPath = resolveStoragePath('app_settings.json');
        this.chatHistoryPath = resolveStoragePath('chat_history.json');
        this.sessionsDir = resolveStoragePath('chat_sessions');

        if (!fs.existsSync(this.sessionsDir)) fs.mkdirSync(this.sessionsDir, { recursive: true });

        this.migrateLegacyHistory();

        console.log(`[AgentService] Launch policy: fresh session on startup`);
        const id = this.newSession();
        auditLogger.setSessionId(id);
        console.log(`[SessionBoot] policy=fresh_on_launch createdSessionId=${id}`);

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
                    const gs = new GuardrailService(resolveStoragePath(''));
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

    public setLogViewerService(lvs: LogViewerService) {
        this.logViewerService = lvs;
        this.rag.setLogViewerService(lvs);
        this.ingestion.setLogViewerService(lvs);
    }

    public setCodeControl(codeControl: any) {
        this.codeControl = codeControl;
        this.registerCodeTools();
    }

    private registerCodeTools() {
        if (!this.codeControl) return;

        this.tools.register({
            name: 'fs_read_text',
            description: 'Reads the full text content of a file from the repository. Path is relative to repo root. Max size 2MB.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path to the file.' }
                },
                required: ['path']
            },
            execute: async (args) => {
                const res = await this.codeControl.readText(args.path);
                return res.ok ? res.content : `Error: ${res.error}`;
            }
        });

        this.tools.register({
            name: 'fs_write_text',
            description: 'Writes text content to a file in the repository. Overwrites if exists. Follow policy rules.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path to the file.' },
                    content: { type: 'string', description: 'New file content.' }
                },
                required: ['path', 'content']
            },
            execute: async (args) => {
                const res = await this.codeControl.writeText(args.path, args.content);
                return res.ok ? `Successfully written to ${args.path}` : `Error: ${res.error}`;
            }
        });

        this.tools.register({
            name: 'fs_list',
            description: 'Lists files and directories at a given path relative to repository root.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative directory path.' }
                }
            },
            execute: async (args) => {
                const res = await this.codeControl.list(args.path || '');
                if (!res.ok) return `Error: ${res.error}`;
                return res.entries.map((e: any) => `${e.isDirectory ? '[DIR]' : '[FILE]'} ${e.name}`).join('\n');
            }
        });

        this.tools.register({
            name: 'shell_run',
            description: 'Executes a shell command within the repository root. Captures output and exit code.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'The shell command to run.' },
                    cwd: { type: 'string', description: 'Optional subpath to run in.' }
                },
                required: ['command']
            },
            execute: async (args) => {
                const res = await this.codeControl.shellRun(args.command, args.cwd);
                if (!res.ok && !res.stdout && !res.stderr) return `Error: ${res.error}`;
                return `Exit Code: ${res.exitCode}\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`;
            }
        });
    }

    public setMcpService(mcp: McpServiceLike) {
        this.mcpService = mcp;
        this.tools.setMcpService(mcp);
    }

    public setMcpAuthority(authority: McpAuthorityService): void {
        this.tools.setMcpAuthority(authority);
    }

    /**
     * Wires the runtime diagnostics aggregator so cognitive contexts can be recorded
     * after each turn (Phase 3A: Live Cognitive Path Integration).
     */
    public setDiagnosticsAggregator(agg: RuntimeDiagnosticsAggregator): void {
        this.diagnosticsAggregator = agg;
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
                if (data.activeLoreMemoryContext) {
                    this.talaRouter.setActiveLoreMemoryContext(data.activeLoreMemoryContext as ActiveLoreMemoryContext);
                } else {
                    this.talaRouter.setActiveLoreMemoryContext(null);
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
        this.talaRouter.setActiveLoreMemoryContext(null);

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
            const activeLoreMemoryContext = this.talaRouter.getActiveLoreMemoryContext();
            if (activeLoreMemoryContext) {
                session.activeLoreMemoryContext = activeLoreMemoryContext;
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
                activeLoreMemoryContext: sourceData.activeLoreMemoryContext || undefined,
            };

            fs.writeFileSync(path.join(this.sessionsDir, `${newId}.json`), JSON.stringify(session, null, 2));

            this.activeSessionId = newId;
            this.chatHistory = branchedMessages;
            this.activeParentId = resolvedSource;
            this.activeBranchPoint = messageIndex;
            this.talaRouter.setActiveLoreMemoryContext((sourceData.activeLoreMemoryContext as ActiveLoreMemoryContext | undefined) || null);

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

    private detectToolIntent(userMessage: string): string {
        const lower = userMessage.toLowerCase();

        // 1. FILE_PATH_PATTERN (Explicit files/exts) -> ALWAYS coding
        const FILE_PATH_PATTERN = /\b[a-zA-Z0-9_\-/]+\.(ts|js|json|txt|md|py|tsx|jsx|yml|yaml|sh|css|html|env|toml|ini)\b/i;
        // Also explicit tool names
        const TOOL_TOKEN_PATTERN = /\b(fs_write_text|fs_read_text|fs_list|shell_run|write_file|read_file|list_files|terminal_run|execute_command)\b/i;

        if (FILE_PATH_PATTERN.test(userMessage) || TOOL_TOKEN_PATTERN.test(userMessage)) {
            return 'coding';
        }

        // 2. Explicit Memory
        const MEMORY_PATTERN = /\b(remember|save to memory|store this|add to memory|look up in memory|mem0|memory graph|retrieve context|memory)\b/i;
        if (MEMORY_PATTERN.test(lower)) {
            return 'memory';
        }

        // 3. Explicit Management
        const MGMT_PATTERN = /\b(current goal|goals|manage goals|self audit|audit|reflection|routing mode|settings|identity|soul)\b/i;
        if (MGMT_PATTERN.test(lower)) {
            return 'management';
        }

        // 4. REPO_INSPECTION_PATTERN (Explicit actions requiring tools but no specific path)
        const REPO_INSPECTION_PATTERN = /\b(list files|scan|count files|search for|grep|find in repo|show tree|read file|open file|inspect package\.json)\b/i;
        if (REPO_INSPECTION_PATTERN.test(lower)) {
            return 'coding';
        }

        // 5. Tool-action heuristic (anyVerb && anyNoun)
        const intentVerbs = ['create', 'write', 'edit', 'modify', 'delete', 'remove', 'add', 'update', 'patch', 'refactor', 'generate', 'scaffold', 'implement', 'fix', 'run', 'execute', 'lint', 'test', 'build', 'install', 'start'];
        const intentNouns = ['file', 'script', 'folder', 'directory', 'path', 'ts', 'js', 'json', 'md', 'txt', 'npm', 'node', 'pnpm', 'yarn', 'python', 'pytest', 'eslint', 'tsc'];
        const hasVerb = intentVerbs.some(v => lower.includes(v));
        const hasNoun = intentNouns.some(n => lower.includes(n));

        if (hasVerb && hasNoun) {
            return 'coding';
        }

        // 6. Otherwise -> conversation
        return 'conversation';
    }

    private getToolTimeout(toolName: string): number {
        if (toolName === 'shell_run' || toolName === 'run_command') return 60000;
        if (toolName.startsWith('fs_') || toolName.includes('file') || toolName.includes('dir')) return 10000;
        if (toolName.includes('browser') || toolName.includes('web')) return 90000;
        return 30000; // Default
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
        this.docIntel = new DocumentationIntelligenceService(root);
        if (this.systemInfo) this.systemInfo.workspaceRoot = root;
    }

    private async loadBrainConfig() {
        // Clear brain readiness at the start of every config attempt.
        // Intentional: any in-flight chat() calls during reconfiguration will receive a clear
        // "no provider" error rather than routing through a potentially stale or mismatched brain.
        // The flag is re-set to true only after a provider is successfully bound below.
        this.brainIsReady = false;
        try {
            const settings = loadSettings(this.settingsPath);

            const inferenceSettings = settings.inference ?? {};
            const activeModeStr: string = (inferenceSettings.mode as string) ?? 'auto';
            const routingMode: 'auto' | 'local-only' | 'cloud-only' =
                activeModeStr === 'local-only' ? 'local-only'
                    : activeModeStr === 'cloud-only' ? 'cloud-only'
                        : 'auto';

            const registryConfig: import('./inference/InferenceProviderRegistry').ProviderRegistryConfig = {};
            const instances: any[] = inferenceSettings.instances ?? [];

            for (const inst of instances) {
                if (inst.engine === 'ollama') {
                    registryConfig.ollama = { endpoint: inst.endpoint ?? 'http://127.0.0.1:11434', enabled: true };
                } else if (inst.engine === 'vllm') {
                    if (inst.endpoint) {
                        registryConfig.vllm = { endpoint: inst.endpoint, enabled: true };
                    }
                } else if (inst.engine === 'llamacpp' && inst.source === 'local' && inst.endpoint) {
                    registryConfig.llamacpp = { endpoint: inst.endpoint, enabled: true };
                } else if (['openai', 'anthropic', 'openrouter', 'groq', 'gemini', 'llamacpp', 'custom'].includes(inst.engine) && inst.source !== 'local') {
                    registryConfig.cloud = { endpoint: inst.endpoint, apiKey: inst.apiKey, model: inst.model, enabled: true };
                }
            }

            const embeddedVllmPort = inferenceSettings?.embeddedVllm?.port ?? 8000;
            registryConfig.embeddedVllm = {
                port: embeddedVllmPort,
                modelId: inferenceSettings?.embeddedVllm?.modelId,
                enabled: true,
            };

            const embeddedModelPath = this._resolveEmbeddedModelPath(inferenceSettings);
            registryConfig.embeddedLlamaCpp = {
                port: inferenceSettings?.localEngine?.options?.port ?? 8080,
                modelPath: embeddedModelPath,
                binaryPath: inferenceSettings?.localEngine?.binaryPath,
                enabled: true,
            };

            this.inference.reconfigureRegistry(registryConfig);
            await this.inference.refreshProviders();

            const { preferredProviderId, preferredModelId } = this._resolvePreferredProviderFromSettings(inferenceSettings, instances);

            if (preferredProviderId) {
                this.inference.setSelectedProvider(preferredProviderId);
            }

            let selection = this.inference.selectProvider({
                preferredProviderId,
                preferredModelId,
                mode: routingMode,
                fallbackAllowed: true,
                turnId: 'brain-config',
                agentMode: 'system',
            });

            if (!selection.success || !selection.selectedProvider) {
                console.log('[AgentService] No viable provider found - attempting embedded recovery (embedded_vllm first)...');
                const started = await this.inference.ensureEmbeddedProviderStarted({
                    embeddedVllm: {
                        port: embeddedVllmPort,
                        modelId: inferenceSettings?.embeddedVllm?.modelId ?? preferredModelId,
                    },
                    embeddedLlamaCpp: embeddedModelPath ? {
                        modelPath: embeddedModelPath,
                        port: inferenceSettings?.localEngine?.options?.port ?? 8080,
                        contextSize: inferenceSettings?.localEngine?.options?.contextSize ?? 4096,
                    } : undefined,
                    allowLegacyLlamaCpp: !!embeddedModelPath,
                });

                if (started) {
                    await this.inference.refreshProviders();
                    selection = this.inference.selectProvider({
                        preferredProviderId,
                        preferredModelId,
                        mode: routingMode,
                        fallbackAllowed: true,
                        turnId: 'brain-config-retry',
                        agentMode: 'system',
                    });
                }

                if (!selection.success || !selection.selectedProvider) {
                    console.warn('[AgentService] No viable inference provider found during brain config:', selection.reason);
                    return;
                }
            }

            const chosen = selection.selectedProvider;

            if (chosen.scope === 'cloud' || chosen.providerType === 'cloud') {
                const cloudInst = instances.find((i: any) =>
                    ['openai', 'anthropic', 'openrouter', 'groq', 'gemini', 'llamacpp', 'vllm', 'custom'].includes(i.engine) && i.source !== 'local'
                ) ?? {};
                this.brain = new CloudBrain({
                    endpoint: chosen.endpoint,
                    apiKey: cloudInst.apiKey ?? chosen.apiKey,
                    model: selection.resolvedModel ?? cloudInst.model ?? chosen.preferredModel,
                });
                this.brainIsReady = true;
            } else if (chosen.providerType === 'ollama') {
                const ollama = new OllamaBrain();
                ollama.configure(chosen.endpoint, selection.resolvedModel ?? chosen.preferredModel ?? '');
                this.brain = ollama;
                this.brainIsReady = true;
            } else if (chosen.providerType === 'embedded_llamacpp') {
                const modelName = selection.resolvedModel ?? chosen.preferredModel ?? path.basename(embeddedModelPath ?? 'embedded-model');
                this.brain = new CloudBrain({ endpoint: chosen.endpoint, model: modelName });
                this.brainIsReady = true;
                console.log(`[AgentService] Bound embedded llama.cpp brain -> endpoint=${chosen.endpoint} model=${modelName}`);
            } else {
                // vllm, embedded_vllm, koboldcpp, external llamacpp use OpenAI-compatible endpoint via CloudBrain.
                this.brain = new CloudBrain({ endpoint: chosen.endpoint, model: selection.resolvedModel ?? chosen.preferredModel ?? '' });
                this.brainIsReady = true;
            }
        } catch (e) {
            console.error('[AgentService] loadBrainConfig error:', e);
        }
    }

    private _resolvePreferredProviderFromSettings(inferenceSettings: any, instances: any[]): { preferredProviderId?: string; preferredModelId?: string } {
        const activeLocalId = inferenceSettings?.activeLocalId;
        if (!activeLocalId) {
            return { preferredProviderId: undefined, preferredModelId: undefined };
        }

        const active = instances.find((i: any) => i.id === activeLocalId);
        if (!active) {
            return { preferredProviderId: undefined, preferredModelId: undefined };
        }

        return {
            preferredProviderId: this._mapInstanceToProviderId(active, inferenceSettings),
            preferredModelId: active.model,
        };
    }

    private _mapInstanceToProviderId(instance: any, inferenceSettings: any): string | undefined {
        if (!instance) return undefined;

        if (instance.engine === 'ollama') return 'ollama';

        if (instance.engine === 'vllm') {
            const idLower = String(instance.id ?? '').toLowerCase();
            const sourceLower = String(instance.source ?? '').toLowerCase();
            const embeddedPort = inferenceSettings?.embeddedVllm?.port ?? 8000;
            const endpoint = String(instance.endpoint ?? '');
            const embeddedHostPrefix = `http://127.0.0.1:${embeddedPort}`;
            if (sourceLower === 'embedded' || idLower.includes('embedded') || endpoint.startsWith(embeddedHostPrefix)) {
                return 'embedded_vllm';
            }
            return 'vllm';
        }

        if (instance.engine === 'llamacpp') {
            if (instance.source !== 'local') return 'cloud';
            const idLower = String(instance.id ?? '').toLowerCase();
            if (idLower.includes('embedded') || idLower.includes('builtin')) {
                return 'embedded_llamacpp';
            }
            if (instance.endpoint) return 'llamacpp';
            return 'embedded_llamacpp';
        }

        if (['openai', 'anthropic', 'openrouter', 'groq', 'gemini', 'custom'].includes(instance.engine)) {
            return 'cloud';
        }

        return undefined;
    }

    private _resolveEmbeddedModelPath(inferenceSettings: any): string | undefined {
        const roots = [
            typeof app !== 'undefined' ? app.getAppPath() : undefined,
            process.cwd(),
        ].filter(Boolean) as string[];

        const configuredName: string | undefined = inferenceSettings?.localEngine?.modelPath;

        for (const root of roots) {
            if (configuredName) {
                // Try as absolute path first, then relative to models/
                if (path.isAbsolute(configuredName) && fs.existsSync(configuredName)) {
                    return configuredName;
                }
                const candidate = path.join(root, 'models', configuredName);
                if (fs.existsSync(candidate)) return candidate;
                // Also try directly under root (in case name includes subdirectory)
                const direct = path.join(root, configuredName);
                if (fs.existsSync(direct)) return direct;
            }

            // Scan models/ directory for any .gguf file
            const modelsDir = path.join(root, 'models');
            try {
                const entries = fs.readdirSync(modelsDir) as string[];
                const gguf = entries.find((f: string) => f.endsWith('.gguf'));
                if (gguf) return path.join(modelsDir, gguf);
            } catch { /* models dir may not exist */ }
        }

        return undefined;
    }


    private getActiveInstance() {
        try {
            const settings = loadSettings(this.settingsPath);
            return settings.inference?.instances?.find((i: any) => i.id === settings.inference.activeLocalId) || settings.inference?.instances?.[0];
        } catch { return null; }
    }

    /**
     * Initializes the "Soul" (Python-based sidecar microservices).
     * 
     * This method:
     * 1. Resolves the correct Python environment (canonical/sandboxed).
     * 2. Sanitizes environment variables and injects User Identity.
     * 3. Orchestrates parallel ignition of MCP servers (Tala Core, Mem0, Astro, World).
     * 4. Establishes the Memory Graph connection via stdio.
     * 5. Handles LTMF (Long-Term Memory Format) migrations.
     * 6. Starts background loops like auto-ingestion and health checks.
     * 
     * @param pythonPath - Path to the local Python binary used for bootstrapping.
     */
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

            const mcpServersDir = path.join(app.getAppPath(), 'mcp-servers');

            const userIdentity = this.userProfile?.getIdentityContext();

            // Resolve Canonical Python and Sanitize Environment
            const ss = this.systemInfo?.systemService as SystemService;
            const mcpPython = ss?.resolveMcpPythonPath({}, this.systemInfo as any) || pythonPath;

            // Per-service Python resolver: prefers the service-local venv over the shared
            // bundled Python so each MCP server runs in its own isolated environment.
            const isWin = process.platform === 'win32';
            const resolveServicePython = (serviceName: string): string => {
                const venvPython = isWin
                    ? path.join(mcpServersDir, serviceName, 'venv', 'Scripts', 'python.exe')
                    : path.join(mcpServersDir, serviceName, 'venv', 'bin', 'python3');
                return fs.existsSync(venvPython) ? venvPython : mcpPython;
            };

            // Preflight Checks (Throws on failure, aborting ignition)
            if (ss) {
                ss.preflightCheck(mcpPython);
            }

            const isolatedEnv = ss?.getMcpEnv({
                ...process.env,
                ...systemEnv,
                TALA_USER_ID: userIdentity?.userId || '',
                TALA_USER_DISPLAY_NAME: userIdentity?.displayName || 'User'
            }) || {
                ...process.env,
                ...systemEnv,
                PYTHONNOUSERSITE: '1',
                PYTHONUNBUFFERED: '1'
            };

            console.log(`[AgentService] Using Python for MCP services (shared baseline): ${mcpPython}`);

            await Promise.all([
                (async () => {
                    const svcPython = resolveServicePython('tala-core');
                    console.log(`[MCP] tala-core python=${svcPython}`);
                    await this.rag.ignite(svcPython, ragScript, isolatedEnv);
                })(),
                (async () => {
                    if (this.memory) {
                        const svcPython = resolveServicePython('mem0-core');
                        console.log(`[MCP] mem0-core python=${svcPython}`);
                        // Resolve memory providers from the canonical inventory before launching mem0-core
                        // so that mem0-core does not need to probe inference backends on its own.
                        const memoryResolver = new MemoryProviderResolver(this.inference.getProviderInventory());
                        const resolvedMemoryConfig = memoryResolver.resolve();
                        await this.memory.ignite(svcPython, memoryScript, isolatedEnv, resolvedMemoryConfig).catch(err => console.error('Memory ignition failed:', err));
                    }
                })(),
                (async () => {
                    if (this.astro) {
                        const svcPython = resolveServicePython('astro-engine');
                        console.log(`[MCP] astro-engine python=${svcPython}`);
                        await this.astro.ignite(svcPython, astroScript, isolatedEnv).catch(err => console.error('Astro ignition failed:', err));
                    }
                })(),
                (async () => {
                    if (this.world) {
                        const svcPython = resolveServicePython('world-engine');
                        console.log(`[MCP] world-engine python=${svcPython}`);
                        await this.world.ignite(svcPython, worldScript, isolatedEnv).catch(err => console.error('World ignition failed:', err));
                    }
                })(),
                (async () => {
                    if (this.mcpService) {
                        try {
                            const svcPython = resolveServicePython('tala-memory-graph');
                            console.log(`[MCP] tala-memory-graph python=${svcPython}`);
                            if (typeof this.mcpService.setPythonPath === 'function') {
                                this.mcpService.setPythonPath(svcPython);
                            }
                            if (typeof (this.mcpService as any).connect === 'function') {
                                // Derive TALA_PG_DSN from the canonical PostgreSQL config so the
                                // tala-memory-graph child process can connect without manual env setup.
                                const pgDsn = buildPgDsn(resolveDatabaseConfig());
                                const graphEnv = { ...isolatedEnv, TALA_PG_DSN: pgDsn };
                                console.log('[MCP] tala-memory-graph: injecting TALA_PG_DSN from canonical DB config');
                                await (this.mcpService as any).connect({
                                    id: 'tala-memory-graph',
                                    name: 'Memory Graph',
                                    type: 'stdio',
                                    // Pass the resolved per-service executable directly so
                                    // McpService does not re-resolve it via its shared pythonPath.
                                    command: svcPython,
                                    args: [graphScript],
                                    enabled: true,
                                    env: graphEnv
                                } as any);
                                // Capture params for use by repair handlers before updating availability
                                this._ignitionParams = {
                                    pythonPath,
                                    ragScript,
                                    memoryScript,
                                    graphScript,
                                    isolatedEnv,
                                    graphEnv,
                                    svcPythonMem0: resolveServicePython('mem0-core'),
                                    svcPythonRag: resolveServicePython('tala-core'),
                                    svcPythonGraph: svcPython,
                                };
                                // Signal that graph projection is now available
                                if (this.memory) {
                                    this.memory.setSubsystemAvailability({ graphAvailable: true });
                                }
                            }
                        } catch (error) {
                            console.error('MCP Service connection failed:', error);
                            // Ensure graph projection is marked unavailable on failure
                            if (this.memory) {
                                this.memory.setSubsystemAvailability({ graphAvailable: false });
                            }
                        }
                    }
                })()
            ]);

            // Capture ignition params for subsystems whose per-service paths are
            // resolved inline (not inside the graph block). These are used by repair
            // handlers that need to restart individual services. If the graph block
            // already stored them, this is a no-op.
            if (!this._ignitionParams) {
                const pgDsnFallback = buildPgDsn(resolveDatabaseConfig());
                this._ignitionParams = {
                    pythonPath,
                    ragScript,
                    memoryScript,
                    graphScript,
                    isolatedEnv,
                    graphEnv: { ...isolatedEnv, TALA_PG_DSN: pgDsnFallback },
                    svcPythonMem0: resolveServicePython('mem0-core'),
                    svcPythonRag: resolveServicePython('tala-core'),
                    svcPythonGraph: resolveServicePython('tala-memory-graph'),
                };
            }

            this.isSoulReady = true;

            // ── Memory Integrity: inform MemoryService of subsystem availability ──
            // After igniteSoul completes, update the memory service with the
            // real availability of canonical store, RAG, integrity mode from settings.
            // Graph projection availability is updated inline when the MCP connect
            // attempt above succeeds or fails.
            if (this.memory) {
                const canonicalRepo = getCanonicalMemoryRepository();
                const dbHealth = getLastDbHealth();

                // Surface structured DB diagnostics from the preflight check.
                if (dbHealth) {
                    if (!dbHealth.reachable) {
                        console.error(`[DBHealth] Postgres unreachable: ${dbHealth.error ?? 'unknown error'}`);
                    } else {
                        if (!dbHealth.pgvectorInstalled) {
                            console.warn('[DBHealth] pgvector not installed — vector search will be unavailable');
                        }
                        if (!dbHealth.migrationsApplied) {
                            console.warn('[DBHealth] schema_migrations not found — schema may not be initialized');
                        }
                    }
                }

                const memIntegrityMode = (settings.memory?.integrityMode as MemoryIntegrityMode | undefined) ?? 'balanced';
                this.memory.setSubsystemAvailability({
                    canonicalReady: canonicalRepo !== null,
                    ragAvailable: this.rag?.getReadyStatus?.() ?? false,
                    integrityMode: memIntegrityMode,
                });
            }

            // ── Memory Repair Executor: wire and start after all services are ready ──
            this._wireRepairExecutor();

            // LTMF Migration: Archive legacy .txt files if structured mode is enabled
            if (this.USE_STRUCTURED_LTMF) {
                console.log('[AgentService] LTMF Migration enabled. Archiving legacy .txt memories...');
                await this.ingestion.archiveLegacy();
            }

            this.ingestion.startAutoIngest();
            await this.refreshMcpTools();
            await this.syncAstroProfiles();
            await this.syncUserProfileAstro();
            await this.docIntel.ignite();
        } catch (e) {
            console.error('[AgentService] igniteSoul failed:', this.stripPIIFromDebug(e));
        }
    }

    /**
     * Gracefully shuts down all active MCP sidecars and local inference engines.
     */
    public async shutdown() {
        if (this._repairExecutor) {
            this._repairExecutor.stop();
        }
        if (this._repairScheduler) {
            this._repairScheduler.stop();
        }
        await Promise.all([this.rag.shutdown(), this.memory.shutdown(), this.inference.getLocalEngine().extinguish()]);
    }

    /**
     * Wires the MemoryRepairExecutionService singleton with live handlers that
     * perform real subsystem operations.  Called once at the end of igniteSoul()
     * after all dependent services are ready.
     *
     * Handler mapping:
     *  reconnect_canonical — shutdown + re-init canonical PostgreSQL store
     *  reinit_canonical    — same as reconnect_canonical (full teardown + reinit)
     *  reconnect_mem0      — shutdown + re-ignite mem0 MCP server
     *  re_resolve_providers — re-run MemoryProviderResolver and update MemoryService config
     *  reconnect_graph     — disconnect + reconnect tala-memory-graph via McpService
     *  reconnect_rag       — shutdown + re-ignite tala-core RAG server
     *
     * drain_deferred_work is wired via DeferredMemoryReplayService.drain() which
     * replays bounded batches of persisted work items when canonical is healthy.
     */
    private _wireRepairExecutor(): void {
        const executor = MemoryRepairExecutionService.getInstance();
        this._repairExecutor = executor;

        executor.setHealthStatusProvider(() => this.memory.getHealthStatus());

        // Wire the real deferred-work drain callback
        const repo = getCanonicalMemoryRepository();
        if (repo) {
            const pgRepo = repo as unknown as PostgresMemoryRepository;
            const pool = pgRepo.getSharedPool();
            if (pool) {
                const deferredRepo = new DeferredMemoryWorkRepository(pool);
                const replayService = DeferredMemoryReplayService.getInstance();
                replayService.setRepository(deferredRepo);
                replayService.setHealthStatusProvider(() => this.memory.getHealthStatus());
                executor.setDeferredWorkDrainCallback(() => replayService.drain());
                console.log('[AgentService] DeferredMemoryReplayService wired to repair executor.');

                // Wire the repair outcome repository for learning / analytics
                const outcomeRepo = new MemoryRepairOutcomeRepository(pool);
                executor.setOutcomeRepository(outcomeRepo);
                MemoryRepairTriggerService.getInstance().setOutcomeRepository(outcomeRepo);
                console.log('[AgentService] MemoryRepairOutcomeRepository wired.');

                // Create the scheduler (started later, after all handlers are registered)
                this._repairScheduler = new MemoryRepairSchedulerService(outcomeRepo);

                // Wire operator review aggregator
                this._operatorReviewSvc = new MemoryOperatorReviewService(this.memory, this._repairScheduler);

                // ── Repair evidence persistence subscribers ───────────────────
                // Subscribe once to TelemetryBus and persist the remaining
                // repair-evidence event types that are not covered by
                // MemoryRepairExecutionService or MemoryRepairTriggerService.
                //
                // All appends are fire-and-forget — persistence failures must
                // never block the repair or chat execution path.

                const bus = TelemetryBus.getInstance();

                bus.subscribe((evt) => {
                    if (evt.event === 'memory.health_transition') {
                        const p = evt.payload ?? {};
                        outcomeRepo.append({
                            eventType: 'health_transition',
                            state: (p['toState'] as string | undefined) ?? null,
                            mode: (p['toMode'] as string | undefined) ?? null,
                            reason: Array.isArray(p['reasons']) && p['reasons'].length > 0
                                ? String(p['reasons'][0])
                                : null,
                            detailsJson: p,
                            occurredAt: (p['at'] as string | undefined) ?? evt.timestamp,
                        }).then(() => {
                            console.log('[MemoryRepairOutcomePersistence] persisted eventType=health_transition');
                        }).catch((err) => {
                            console.error('[MemoryRepairOutcomePersistence] append failed eventType=health_transition', err);
                        });
                        return;
                    }

                    if (evt.event === 'memory.deferred_work_drain_started') {
                        const p = evt.payload ?? {};
                        outcomeRepo.append({
                            eventType: 'deferred_replay',
                            subsystem: Array.isArray(p['eligibleKinds']) && p['eligibleKinds'].length === 1
                                ? String(p['eligibleKinds'][0])
                                : null,
                            detailsJson: { phase: 'started', ...p },
                            occurredAt: evt.timestamp,
                        }).then(() => {
                            console.log('[MemoryRepairOutcomePersistence] persisted eventType=deferred_replay phase=started');
                        }).catch((err) => {
                            console.error('[MemoryRepairOutcomePersistence] append failed eventType=deferred_replay phase=started', err);
                        });
                        return;
                    }

                    if (evt.event === 'memory.deferred_work_drain_completed') {
                        const p = evt.payload ?? {};
                        const completed = (p['completed'] as number | undefined) ?? 0;
                        const failed = (p['failed'] as number | undefined) ?? 0;
                        const outcome = failed === 0 && completed > 0
                            ? 'recovered'
                            : failed > 0 && completed > 0
                                ? 'partial'
                                : failed > 0
                                    ? 'failed'
                                    : 'skipped';
                        outcomeRepo.append({
                            eventType: 'deferred_replay',
                            outcome,
                            subsystem: Array.isArray(p['eligibleKinds']) && p['eligibleKinds'].length === 1
                                ? String(p['eligibleKinds'][0])
                                : null,
                            detailsJson: { phase: 'completed', ...p },
                            occurredAt: evt.timestamp,
                        }).then(() => {
                            console.log('[MemoryRepairOutcomePersistence] persisted eventType=deferred_replay phase=completed');
                        }).catch((err) => {
                            console.error('[MemoryRepairOutcomePersistence] append failed eventType=deferred_replay phase=completed', err);
                        });
                        return;
                    }

                    if (evt.event === 'memory.deferred_work_item_failed') {
                        const p = evt.payload ?? {};
                        outcomeRepo.append({
                            eventType: 'deferred_replay',
                            outcome: 'failed',
                            subsystem: (p['kind'] as string | undefined) ?? null,
                            canonicalMemoryId: (p['canonicalMemoryId'] as string | undefined) ?? null,
                            detailsJson: { phase: 'item_failed', ...p },
                            occurredAt: evt.timestamp,
                        }).then(() => {
                            console.log('[MemoryRepairOutcomePersistence] persisted eventType=deferred_replay phase=item_failed');
                        }).catch((err) => {
                            console.error('[MemoryRepairOutcomePersistence] append failed eventType=deferred_replay phase=item_failed', err);
                        });
                        return;
                    }

                    if (evt.event === 'memory.deferred_dead_lettered') {
                        const p = evt.payload ?? {};
                        outcomeRepo.append({
                            eventType: 'dead_letter',
                            subsystem: (p['kind'] as string | undefined) ?? null,
                            canonicalMemoryId: (p['canonicalMemoryId'] as string | undefined) ?? null,
                            reason: (p['error'] as string | undefined) ?? null,
                            detailsJson: p,
                            occurredAt: evt.timestamp,
                        }).then(() => {
                            console.log('[MemoryRepairOutcomePersistence] persisted eventType=dead_letter');
                        }).catch((err) => {
                            console.error('[MemoryRepairOutcomePersistence] append failed eventType=dead_letter', err);
                        });
                        return;
                    }
                });
            }
        }

        // Shared helper: teardown and reinitialize the canonical PostgreSQL store,
        // then update MemoryService with the result.  Used by both reconnect_canonical
        // and reinit_canonical which currently share the same recovery mechanism.
        const restoreCanonical = async (label: string): Promise<boolean> => {
            try {
                await shutdownCanonicalMemory();
                const repo = await initCanonicalMemory();
                const success = repo !== null;
                this.memory.setSubsystemAvailability({ canonicalReady: success });
                return success;
            } catch (err) {
                console.error(`[RepairHandler] ${label} failed:`, err);
                this.memory.setSubsystemAvailability({ canonicalReady: false });
                return false;
            }
        };

        // ── reconnect_canonical ───────────────────────────────────────────────
        executor.registerRepairHandler('reconnect_canonical', () => restoreCanonical('reconnect_canonical'));

        // ── reinit_canonical ─────────────────────────────────────────────────
        executor.registerRepairHandler('reinit_canonical', () => restoreCanonical('reinit_canonical'));

        // ── reconnect_mem0 ───────────────────────────────────────────────────
        executor.registerRepairHandler('reconnect_mem0', async (): Promise<boolean> => {
            if (!this._ignitionParams) return false;
            try {
                await this.memory.shutdown();
                const resolver = new MemoryProviderResolver(this.inference.getProviderInventory());
                const resolvedConfig: MemoryRuntimeResolution = resolver.resolve();
                await this.memory.ignite(
                    this._ignitionParams.svcPythonMem0,
                    this._ignitionParams.memoryScript,
                    this._ignitionParams.isolatedEnv,
                    resolvedConfig,
                );
                const ready = this.memory.getReadyStatus();
                this.memory.setSubsystemAvailability({ canonicalReady: getCanonicalMemoryRepository() !== null });
                return ready;
            } catch (err) {
                console.error('[RepairHandler] reconnect_mem0 failed:', err);
                return false;
            }
        });

        // ── re_resolve_providers ─────────────────────────────────────────────
        executor.registerRepairHandler('re_resolve_providers', async (): Promise<boolean> => {
            try {
                const resolver = new MemoryProviderResolver(this.inference.getProviderInventory());
                const resolvedConfig: MemoryRuntimeResolution = resolver.resolve();
                this.memory.setResolvedMemoryConfig(resolvedConfig);
                return true;
            } catch (err) {
                console.error('[RepairHandler] re_resolve_providers failed:', err);
                return false;
            }
        });

        // ── reconnect_graph ──────────────────────────────────────────────────
        executor.registerRepairHandler('reconnect_graph', async (): Promise<boolean> => {
            if (!this._ignitionParams || !this.mcpService) return false;
            try {
                if (typeof this.mcpService.disconnect === 'function') {
                    await this.mcpService.disconnect('tala-memory-graph');
                }
                const success = (await this.mcpService.connect?.({
                    id: 'tala-memory-graph',
                    name: 'Memory Graph',
                    type: 'stdio',
                    command: this._ignitionParams.svcPythonGraph,
                    args: [this._ignitionParams.graphScript],
                    enabled: true,
                    env: this._ignitionParams.graphEnv,
                } as any)) ?? false;
                this.memory.setSubsystemAvailability({ graphAvailable: success });
                return success;
            } catch (err) {
                console.error('[RepairHandler] reconnect_graph failed:', err);
                this.memory.setSubsystemAvailability({ graphAvailable: false });
                return false;
            }
        });

        // ── reconnect_rag ────────────────────────────────────────────────────
        executor.registerRepairHandler('reconnect_rag', async (): Promise<boolean> => {
            if (!this._ignitionParams) return false;
            try {
                await this.rag.shutdown();
                await this.rag.ignite(
                    this._ignitionParams.svcPythonRag,
                    this._ignitionParams.ragScript,
                    this._ignitionParams.isolatedEnv,
                );
                const ready = this.rag.getReadyStatus();
                this.memory.setSubsystemAvailability({ ragAvailable: ready });
                return ready;
            } catch (err) {
                console.error('[RepairHandler] reconnect_rag failed:', err);
                this.memory.setSubsystemAvailability({ ragAvailable: false });
                return false;
            }
        });

        executor.start();
        console.log('[AgentService] MemoryRepairExecutionService started with live handlers.');

        // ── MemoryRepairSchedulerService ──────────────────────────────────────
        // Start the scheduled analytics + self-maintenance loop only when the
        // outcome repository has been successfully wired (it's created above in
        // the pool-guarded block).  The scheduler holds a direct reference to
        // the same outcomeRepo instance used by the executor.
        //
        // If the pool was unavailable (outcomeRepo was not created) the scheduler
        // is not started and _repairScheduler remains null.  This is intentional:
        // without persisted outcomes the analytics layer has nothing to read.
        if (this._repairScheduler !== null) {
            this._repairScheduler.start();
            console.log('[AgentService] MemoryRepairSchedulerService started.');
        }
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

    private async syncUserProfileAstro() {
        if (!this.userProfile || !this.astro) return;
        const profile = this.userProfile.getFullProfile();
        if (profile && profile.userId && profile.dateOfBirth && profile.placeOfBirth) {
            try {
                const name = profile.firstName || 'User';
                // Use the persistent UUID as the profile ID in Astro Engine
                await this.astro.createProfile(profile.userId, name, profile.dateOfBirth, profile.placeOfBirth);
            } catch {
                try {
                    const name = profile.firstName || 'User';
                    await this.astro.updateProfile(profile.userId, name, profile.dateOfBirth, profile.placeOfBirth);
                } catch (e) {
                    // Silently fail to avoid PII logging.
                }
            }
        }
    }

    /**
     * Helper to redact PII from error objects or debug logs.
     */
    private stripPIIFromDebug(obj: any): any {
        if (!obj) return obj;
        const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
        const profile = this.userProfile?.getFullProfile();
        if (!profile) return obj;

        let redacted = str;
        if (profile.firstName) redacted = redacted.split(profile.firstName).join('[FIRSTNAME]');
        if (profile.lastName) redacted = redacted.split(profile.lastName).join('[LASTNAME]');
        if (profile.dateOfBirth) redacted = redacted.split(profile.dateOfBirth).join('[DOB]');
        if (profile.email) redacted = redacted.split(profile.email).join('[EMAIL]');

        try {
            return JSON.parse(redacted);
        } catch {
            return redacted;
        }
    }

    private parseToolArguments(toolName: string, rawArgs: any): any {
        if (typeof rawArgs === 'object' && rawArgs !== null) return rawArgs;
        if (typeof rawArgs !== 'string') return {};

        const trimmed = rawArgs.trim();
        if (!trimmed) return {};

        try {
            return JSON.parse(trimmed);
        } catch (e) {
            // Case 3 — tolerant repair (development only)
            try {
                const repaired = trimmed
                    .replace(/'/g, '"') // Single quotes to double
                    .replace(/,\s*([}\]])/g, '$1'); // Trailing commas
                return JSON.parse(repaired);
            } catch (e2) {
                throw new Error(`Invalid tool arguments JSON for ${toolName}: ${trimmed.substring(0, 200)}...`);
            }
        }
    }

    private validateToolArguments(name: string, args: any) {
        if (name === 'fs_write_text') {
            if (!args.path) throw new Error(`Missing required argument "path" for fs_write_text`);
            if (args.content === undefined) throw new Error(`Missing required argument "content" for fs_write_text`);
        } else if (name === 'fs_read_text') {
            if (!args.path) throw new Error(`Missing required argument "path" for fs_read_text`);
        } else if (name === 'fs_list') {
            if (!args.path) throw new Error(`Missing required argument "path" for fs_list`);
        } else if (name === 'shell_run') {
            if (!args.command) throw new Error(`Missing required argument "command" for shell_run`);
        }
    }

    /**
     * extractJsonObjectEnvelope
     *
     * Robustly extracts the first JSON object containing a top-level "tool_calls" key
     * from a string that may have prose before/after it.
     *
     * Algorithm:
     *  1. Scan the string character-by-character with a brace-depth counter.
     *  2. At depth-zero, each '{' starts a candidate object. Track its start index.
     *  3. The matching '}' (depth returns to 0) is the end of that candidate.
     *  4. Attempt JSON.parse on each candidate. If it has tool_calls -> return it.
     *  5. If no candidate parses with tool_calls, return null.
     *
     * This is tolerant of:
     *  - Surrounding prose before/after the JSON object
     *  - Nested JSON objects/arrays inside the tool_calls
     *  - Multiple JSON objects in the text (picks the one with tool_calls)
     *  - Strings containing '{' or '}' (we skip inside string literals)
     */
    private extractJsonObjectEnvelope(text: string): any | null {
        const len = text.length;
        let i = 0;

        while (i < len) {
            // Skip to the next '{' at depth 0
            if (text[i] !== '{') { i++; continue; }

            // Found an opening brace — scan forward to find the matching closing brace
            const start = i;
            let depth = 0;
            let inString = false;
            let escape = false;

            while (i < len) {
                const ch = text[i];

                if (escape) {
                    escape = false;
                    i++;
                    continue;
                }

                if (ch === '\\' && inString) {
                    escape = true;
                    i++;
                    continue;
                }

                if (ch === '"') {
                    inString = !inString;
                    i++;
                    continue;
                }

                if (!inString) {
                    if (ch === '{') depth++;
                    else if (ch === '}') {
                        depth--;
                        if (depth === 0) {
                            // Candidate object found: [start, i]
                            const candidate = text.substring(start, i + 1);
                            try {
                                const parsed = JSON.parse(candidate);
                                if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tool_calls)) {
                                    return parsed;
                                }
                            } catch { /* not valid JSON, try next starting '{' */ }
                            // Move past this candidate and look for the next '{'
                            i++;
                            break;
                        }
                    }
                }
                i++;
            }
        }

        return null;
    }


    private async getAstroState(settings?: any): Promise<string> {
        try {
            const s = settings || loadSettings(this.settingsPath);
            const agentId = s.agent?.activeProfileId || 'tala';
            const userId = this.userProfile?.getIdentityContext().userId || 'User';
            // Passing the current userId ensures the state is computed for the correct human entity
            return await this.astro.getEmotionalState(agentId, userId);
        } catch { return '[ASTRO STATE]: Offline'; }
    }

    public async scanLocalModels(): Promise<any[]> {
        const found: any[] = [];
        try {
            if ((await OllamaBrain.listModels('http://127.0.0.1:11434', 2000)).length > 0) found.push({ id: 'ollama-local', engine: 'ollama', endpoint: 'http://127.0.0.1:11434', source: 'local' });
        } catch { }
        return found;
    }

    private detectGreetingIntent(text: string): { isGreeting: boolean, greetingClass: string } {
        const normalized = text.toLowerCase()
            .trim()
            .replace(/[^\w\s]/gi, '') // Remove all non-alphanumeric/non-space characters
            .replace(/\s+/g, ' ')
            .trim();

        const baseGreetings = ['hi', 'hello', 'hey', 'morning', 'afternoon', 'evening', 'good morning', 'good afternoon', 'good evening', 'yo', 'tala', 'greetings', 'night'];
        const suffixes = ['baby', 'babe', 'love', 'sweetheart', 'darling', 'dear', 'my love', 'honey'];

        // 1. Exact match on normalized base
        if (baseGreetings.includes(normalized)) return { isGreeting: true, greetingClass: 'standard_opening' };

        // 2. Base + suffix matching
        for (const base of baseGreetings) {
            for (const suffix of suffixes) {
                if (normalized === `${base} ${suffix}` || normalized === `${base} my ${suffix}`) {
                    return { isGreeting: true, greetingClass: 'affectionate_opening' };
                }
            }
        }

        return { isGreeting: false, greetingClass: 'none' };
    }

    /**
     * Primary chat entry point. Orchestrates the turn loop and artifact routing.
     */
    public async chat(
        userMessage: string,
        onToken?: (token: string) => void,
        onEvent?: (type: string, data: any) => void,
        images?: string[],
        capabilitiesOverride?: any
    ): Promise<AgentTurnOutput> {
        const spine = new ChatExecutionSpine(this.createChatExecutionSpineAgent());
        return spine.executeTurn(userMessage, onToken, onEvent, images, capabilitiesOverride);
    }

    private createChatExecutionSpineAgent(): ChatExecutionSpineAgent {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        return {
            get settingsPath() { return self.settingsPath; },
            get activeSessionId() { return self.activeSessionId; },
            get activeTurnId() { return self.activeTurnId; },
            set activeTurnId(value: string | null) { self.activeTurnId = value; },
            get activeNotebookContext() { return self.activeNotebookContext; },
            get abortController() { return self.abortController; },
            set abortController(value: AbortController | null) { self.abortController = value; },
            get currentTurnAuditRecord() { return self.currentTurnAuditRecord; },
            set currentTurnAuditRecord(value: PromptAuditRecord | undefined) { self.currentTurnAuditRecord = value; },
            get chatHistory() { return self.chatHistory; },
            get brain() { return self.brain; },
            get brainIsReady() { return self.brainIsReady; },
            get MAX_TOOL_CALLS_PER_TURN() { return self.MAX_TOOL_CALLS_PER_TURN; },
            get MAX_AGENT_ITERATIONS() { return AgentService.MAX_AGENT_ITERATIONS; },
            get preInferenceOrchestrator() { return self.preInferenceOrchestrator; },
            get userProfile() { return self.userProfile; },
            get functions() { return self.functions; },
            get goals() { return self.goals; },
            get tools() { return self.tools; },
            get inference() { return self.inference; },
            get diagnosticsAggregator() { return self.diagnosticsAggregator; },
            get logViewerService() { return self.logViewerService; },
            get coordinator() { return self.coordinator; },
            get memory() { return self.memory; },
            get rag() { return self.rag; },
            get mcpService() { return self.mcpService; },
            get executionLogHistory() { return self.executionLogHistory; },
            get lastTurnExecutionLog() { return self.lastTurnExecutionLog; },
            set lastTurnExecutionLog(value: TurnExecutionLog | undefined) { self.lastTurnExecutionLog = value; },
            getActiveMode: self.getActiveMode.bind(self),
            completeToolOnlyTurn: self.completeToolOnlyTurn.bind(self),
            getReflectionSummary: self.getReflectionSummary.bind(self),
            newSession: self.newSession.bind(self),
            saveSession: self.saveSession.bind(self),
            estimateTokens: self.estimateTokens.bind(self),
            truncateHistory: self.truncateHistory.bind(self),
            streamWithBrain: self.streamWithBrain.bind(self),
            commitAssistantMessage: self.commitAssistantMessage.bind(self),
            normalizeToLegacyToolCalls: self.normalizeToLegacyToolCalls.bind(self),
            getToolTimeout: self.getToolTimeout.bind(self),
            parseToolArguments: self.parseToolArguments.bind(self),
            validateToolArguments: self.validateToolArguments.bind(self),
            dispatchBrowserCommand: self.dispatchBrowserCommand.bind(self),
            getGroundedExecutionSummary: self.getGroundedExecutionSummary.bind(self),
            extractJsonObjectEnvelope: self.extractJsonObjectEnvelope.bind(self),
            shouldApplyCanonRequiredAutobioOverride: AgentService.shouldApplyCanonRequiredAutobioOverride,
            applyCanonRequiredAutobioDirective: AgentService.applyCanonRequiredAutobioDirective,
            enforceCanonRequiredAutobioFallbackReply: AgentService.enforceCanonRequiredAutobioFallbackReply,
            applyCanonRequiredAutobioFinalizeOverride: AgentService.applyCanonRequiredAutobioFinalizeOverride,
            logPriorityMemorySerializationGuard: AgentService.logPriorityMemorySerializationGuard,
        };
    }

    private async completeToolOnlyTurn(

        result: ToolResult, 
        turnId: string, 
        intent: string, 
        activeMode: string, 
        toolName: string, 
        args: any, 
        toolStartTime: number,
        chatStartedAt: number,
        onToken?: (token: string) => void,
        onEvent?: (type: string, data: any) => void
    ): Promise<AgentTurnOutput> {
        console.log(`[AgentService] Completing tool-only turn (intent=${intent})`);

        // Record User Message
        const userMessage = this.chatHistory[this.chatHistory.length - 1]?.content || 'Deterministic Operation';
        if (!this.activeSessionId) this.newSession();
        // The user message is usually pushed in chat() but we've bypassed that. 
        // We'll trust that the caller or subsequent session save handles it if needed,
        // but for tool-only turns we want a clean history.

        const executionLog: TurnExecutionLog = {
            turnId,
            mode: activeMode,
            intent,
            usedEnvelope: false,
            toolCallsPlanned: [{ name: toolName, arguments: args }],
            toolCalls: [{
                name: toolName,
                arguments: args,
                ok: result.success !== false,
                startedAt: toolStartTime,
                endedAt: Date.now(),
                resultPreview: result.result?.substring(0, 2048)
            }],
            executedToolCount: 1,
            toolsSentCount: 0,
            timestamp: Date.now()
        };

        this.lastTurnExecutionLog = executionLog;
        this.executionLogHistory.push(executionLog);

        // --- STRICT TURN BINDING CHECK ---
        if (turnId !== this.activeTurnId) {
            console.warn(`[AgentService] Stale turn detected in completeToolOnlyTurn: received=${turnId}, active=${this.activeTurnId}. Blocking publication.`);
            return { message: "Executing background process...", artifact: null, suppressChatContent: true };
        }

        // --- REAL DELIVERY BRIDGE ---
        let finalResponse = `Executed \`${toolName}\` deterministically.`;
        
        // Custom message for file reading
        if (toolName === 'fs_read_text' || toolName === 'read_file') {
            const fileName = args.path ? path.basename(args.path) : 'file';
            if (result.success !== false) {
                finalResponse = `Opened ${args.path || 'file'} in the editor.`;
            } else {
                finalResponse = `Error reading ${args.path || 'file'}: ${result.result || 'Unknown error'}`;
            }
        } else if (toolName === 'fs_list' || intent === 'file_list') {
            if (result.success !== false && result.result) {
                const entries = result.result.split('\n').filter(Boolean);
                const shortList = entries.slice(0, 15).map(e => e.replace('[FILE] ', '').replace('[DIR] ', '')).join(', ');
                const more = entries.length > 15 ? `... (${entries.length - 15} more)` : '';
                finalResponse = `Here are the entries in ${args.path || 'the directory'}: ${shortList}${more}`;
            } else {
                finalResponse = `Error listing ${args.path || 'directory'}: ${result.result || 'Unknown error'}`;
            }
        } else if (intent === 'git_branch' || toolName === 'shell_run' && args.command === 'git branch --show-current') {
            if (result.success !== false && result.result) {
                // Robust extraction: Extract branch name from shell wrapper output if present
                // Wrapper format: "Exit Code: 0 STDOUT: master STDERR:" or plain "master"
                let branch = result.result.trim();
                const stdoutMatch = branch.match(/STDOUT:\s*([^\s]+)/);
                if (stdoutMatch) {
                    branch = stdoutMatch[1];
                } else {
                    // Fallback: strip any remaining common wrapper artifacts
                    branch = branch.replace(/Exit Code: \d+\s*STDOUT:\s*/g, '').replace(/\s*STDERR:.*$/g, '').trim();
                }
                finalResponse = `You are currently on branch: **${branch}**`;
            } else {
                finalResponse = `Error checking branch: ${result.result || 'Unknown error'}`;
            }
        } else if (intent === 'repo_audit' || toolName === 'system_diagnose') {
            if (result.success !== false && result.result) {
                const report = result.result;
                const lintErrors = (report.match(/--- LINT CHECK ---[\s\S]*?Summary:\s*(\d+)\s*errors/i) || [0, 0])[1];
                const lintWarnings = (report.match(/--- LINT CHECK ---[\s\S]*?Summary:\s*\d+\s*errors,\s*(\d+)\s*warnings/i) || [0, 0])[1];
                const buildErrors = (report.match(/--- BUILD CHECK ---[\s\S]*?Summary:\s*(\d+)\s*TypeScript\s*errors/i) || [0, 0])[1];
                
                const totalIssues = Number(lintErrors) + Number(lintWarnings) + Number(buildErrors);
                const status = totalIssues > 0 ? "⚠️ Issues Found" : "✅ Clean";
                
                // Extract top issues (first 5 unique lines containing 'error' or 'warning')
                const issues = report.split('\n')
                    .filter(l => (l.includes('error') || l.includes('warning')) && !l.includes('Summary:'))
                    .map(l => l.trim())
                    .filter((v, i, a) => a.indexOf(v) === i)
                    .slice(0, 5);
                
                let summary = `### Repository Audit Summary: ${status}\n\n`;
                summary += `| Metric | Count |\n| :--- | :--- |\n`;
                summary += `| **Lint Errors** | ${lintErrors} |\n`;
                summary += `| **Lint Warnings** | ${lintWarnings} |\n`;
                summary += `| **Build Errors** | ${buildErrors} |\n`;
                summary += `| **Total Issues** | **${totalIssues}** |\n\n`;
                
                if (issues.length > 0) {
                    summary += `**Top Issues Detections:**\n`;
                    summary += issues.map(iss => `- ${iss}`).join('\n') + "\n\n";
                }
                
                summary += `_The full diagnostic report has been saved to the workspace artifacts._\n`;
                finalResponse = summary;
            } else {
                finalResponse = `Error running repo audit: ${result.result || 'Unknown error'}`;
            }
        } else if (intent === 'code_search' || toolName === 'fs_search') {
            if (result.success !== false && result.result) {
                try {
                    const searchRes = JSON.parse(result.result);
                    let report = `### Code Search Results\n`;
                    report += `${searchRes.interpretation}\n\n`;

                    if (searchRes.matches && searchRes.matches.length > 0) {
                        report += `**Top Matches:**\n`;
                        searchRes.matches.forEach((m: any) => {
                            const confidenceEmoji = m.confidence === 'high' ? '🟢' : '🟡';
                            report += `- ${confidenceEmoji} \`${m.filePath}\` (Score: ${m.score}, Type: ${m.matchType})\n`;
                            if (m.preview) {
                                report += `  > ${m.preview.trim()}\n`;
                            }
                        });
                        report += `\n`;
                    }

                    if (searchRes.weakMatches && searchRes.weakMatches.length > 0) {
                        report += `**Potential partial matches (suppressed):**\n`;
                        searchRes.weakMatches.forEach((m: any) => {
                            report += `- \`${m.filePath}\` (Score: ${m.score}, Type: ${m.matchType})\n`;
                        });
                        report += `\n`;
                    }

                    if (searchRes.relatedFiles && searchRes.relatedFiles.length > 0) {
                        report += `**Possible related files:**\n`;
                        searchRes.relatedFiles.forEach((m: any) => {
                            report += `- \`${m.filePath}\` (Score: ${m.score})\n`;
                        });
                        report += `\n`;
                    }

                    const diag = searchRes.diagnostics;
                    report += `**Search Diagnostics:**\n`;
                    report += `- Files discovered: ${diag.filesDiscovered}\n`;
                    report += `- Eligible files: ${diag.filesEligible}\n`;
                    report += `- Files searched: ${diag.filesSearched}\n`;
                    report += `- Timed out: ${diag.timedOut ? 'Yes' : 'No'}\n`;
                    report += `- Complete coverage: ${diag.completeCoverage ? 'Yes' : 'No'}\n`;
                    
                    if (diag.filesSkippedTooLarge > 0 || diag.filesSkippedIgnored > 0) {
                        report += `- Skipped: ${diag.filesSkippedTooLarge} too large, ${diag.filesSkippedIgnored} inaccessible\n`;
                    }

                    finalResponse = report;
                } catch (e) {
                    // Fallback if not JSON
                    finalResponse = result.result;
                }
            } else {
                finalResponse = `Error searching code: ${result.result || 'Unknown error'}`;
            }
        } else if (result.result) {
            finalResponse += `\n\n\`\`\`\n${result.result.slice(0, 1500)}\n\`\`\``;
        }
        
        // Timing Logs
        const routingMs = toolStartTime - chatStartedAt;
        const executionMs = Date.now() - toolStartTime;
        finalResponse += `\n\n---\n**Timing**: Routing: \`${routingMs}ms\` | Execution: \`${(executionMs / 1000).toFixed(2)}s\``;

        // 1. CHAT DELIVERY (Real-time publication)
        if (onToken) {
            console.log(`[AgentService] FastPath: Streaming confirmation to UI: ${finalResponse}`);
            onToken(finalResponse);
        }
        const fakeCallId = `call_det_${Date.now()}`;
        
        const transientMessages: ChatMessage[] = [
            {
                role: 'assistant',
                content: "",
                tool_calls: [{ id: fakeCallId, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }]
            },
            { role: 'tool', content: result.result, tool_call_id: fakeCallId, name: toolName },
            { role: 'assistant', content: finalResponse }
        ];

        // Audit Logging (Technical bypass)
        const auditLogPath = resolveStoragePath(path.join('logs', 'mode_audit_bypass.log'));
        if (!fs.existsSync(path.dirname(auditLogPath))) fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
        fs.appendFileSync(auditLogPath, JSON.stringify({ timestamp: new Date().toISOString(), intent, toolName, turnId }) + "\n");

        // Artifact Routing
        const toolResults = [{ name: toolName, args: args, result: result.result }];
        const normalized = artifactRouter.normalizeAgentOutput(finalResponse, toolResults);

        // 2. EDITOR/UI DELIVERY (Canonical Trigger)
        if (normalized.artifact) {
            console.log(`[AgentService] FastPath: Emitting artifact type=${normalized.artifact.type} id=${normalized.artifact.id} for tool-only turn`);
            if (onEvent) {
                onEvent('artifact-open', normalized.artifact);
            }
        }

        this.chatHistory.push(...transientMessages);
        this.saveSession();
        
        const finalResult = { 
            message: normalized.message || finalResponse, 
            artifact: normalized.artifact, 
            suppressChatContent: normalized.suppressChatContent 
        };

        console.log(`[AgentService] Tool-only turn returned to UI (requires_llm=false)`);
        return finalResult;
    }

    private finalizeAssistantContent(intent: string, raw: string, executedToolCount: number, hasPendingCalls: boolean, mode: string = 'assistant'): string {
        if (intent === 'coding' && (executedToolCount > 0 || hasPendingCalls)) {
            return '';
        }

        let content = raw || '';
        // Scrub raw tool JSON leaks, especially in RP mode
        // In RP mode, we scrub EVERYTHING that looks like JSON.
        // In other modes, we only scrub if it looks like a tool signature leak.
        if (mode === 'rp' || content.includes('{"name":') || content.includes('"arguments":') || content.includes('</tool_call>')) {
            content = this.scrubRawToolJson(content, mode, intent);
        }

        return content;
    }

    private scrubRawToolJson(text: string, mode: string = 'assistant', intent: string = 'conversation'): string {
        if (!text) return text;
        // Regex to find things that look like raw tool JSON: {"name":"...", "arguments":{...}}
        const rawJsonRegex = /\{"name"\s*:\s*"[^"]+",\s*"arguments"\s*:\s*\{[\s\S]*?\}\}/g;
        // Also check for tag fragments that might leak
        const tagLeakRegex = /<\/tool_call>/g;

        let scrubbed = text;
        let blocked = false;

        if (rawJsonRegex.test(scrubbed)) {
            scrubbed = scrubbed.replace(rawJsonRegex, '[TECHNICAL ARTIFACT SUPPRESSED]');
            blocked = true;
        }
        if (tagLeakRegex.test(scrubbed)) {
            scrubbed = scrubbed.replace(tagLeakRegex, '');
            blocked = true;
        }

        if (blocked) {
            console.log(`[AgentService] RAW_TOOL_JSON_BLOCKED_AT_COMMIT mode=${mode} intent=${intent}`);
        }
        return scrubbed;
    }

    /**
     * Converts a CanonicalToolCall array into the legacy ToolCall format expected by
     * ChatMessage.tool_calls.  This is the sole compatibility boundary between the
     * canonical inference layer (CanonicalToolCall, id optional) and the legacy brain
     * protocol (ToolCall, id required).
     *
     * - Guarantees every entry has a non-empty id.
     * - Sets type to 'function'.
     * - Stringifies arguments when they are a parsed object.
     */
    private normalizeToLegacyToolCalls(calls: CanonicalToolCall[]): ToolCall[] {
        return calls.map((tc, i) => ({
            id: tc.id ?? `tc_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 7)}`,
            type: 'function' as const,
            function: {
                name: tc.function.name,
                arguments: typeof tc.function.arguments === 'string'
                    ? tc.function.arguments
                    : JSON.stringify(tc.function.arguments),
            },
        }));
    }

    private commitAssistantMessage(
        transientMessages: ChatMessage[],
        msg: ChatMessage,
        intent: string,
        executedToolCount: number,
        turnSeenHashes: Set<string>,
        mode: string = 'assistant'
    ): void {
        const hasPendingCalls = (msg.tool_calls?.length || 0) > 0;
        const finalized = this.finalizeAssistantContent(intent, msg.content, executedToolCount, hasPendingCalls, mode);

        // Use content-based hash to suppress duplicate prose
        // Normalize: trim + collapse whitespace to single spaces
        const normalized = finalized.trim().replace(/\s+/g, ' ');
        const hash = `assistant|${normalized}`;
        const isDuplicateProse = turnSeenHashes.has(hash) && normalized.length > 0;

        if (isDuplicateProse && !hasPendingCalls) {
            console.log(`[AgentService] duplicate assistant message suppressed (len=${finalized.length}, intent=${intent})`);
            return;
        }

        // Push if:
        // 1. Has non-duplicate finalized content
        // 2. Has tool calls (always push these as they are actions)
        // 3. Or it's a coding turn and we want at least one assistant message (one per turn due to hash check).
        const shouldPush = (finalized.trim().length > 0 && !isDuplicateProse) ||
            hasPendingCalls ||
            (intent === 'coding' && (executedToolCount > 0 || hasPendingCalls) && !turnSeenHashes.has(hash));

        if (shouldPush) {
            msg.content = finalized;
            transientMessages.push(msg);
            turnSeenHashes.add(hash);
        }
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

    private getGroundedExecutionSummary(): string {
        if (!this.lastTurnExecutionLog) {
            return "No previous execution log found.";
        }

        const log = this.lastTurnExecutionLog;
        if (log.toolCallsPlanned.length === 0 && log.toolCalls.length === 0) {
            return "No tools were executed (or planned) in the last turn.";
        }

        let summary = "### [Grounded Tool Execution Log]\n\n";
        summary += `**Turn ID**: \`${log.turnId}\` | **Intent**: \`${log.intent}\` | **Planned**: ${log.toolCallsPlanned.length} | **Executed**: ${log.executedToolCount}\n\n`;

        if (log.toolCalls.length > 0) {
            log.toolCalls.forEach((tc, i) => {
                const status = tc.ok ? "✅ Succeeded" : "❌ Failed";
                summary += `${i + 1}. **${tc.name}** — ${status}\n`;
                if (tc.argsPreview) {
                    summary += `   - **Arguments**: \`${tc.argsPreview}\`\n`;
                }
                if (!tc.ok && tc.error) {
                    summary += `   - **Error**: ${tc.error}\n`;
                } else if (tc.resultPreview) {
                    summary += `   - **Result**: ${tc.resultPreview}\n`;
                }
                summary += "\n";
            });
        } else {
            summary += "_No tools actually reached execution (stopped before execution loop)._";
        }
        return summary.trim();
    }

    private streamWithBrain(brain: IBrain, messages: any[], systemPrompt: string, onChunk: (token: string) => void, signal: AbortSignal | undefined, tools: any[], options: any) {
        // Route through InferenceService canonical stream path for telemetry and reflection integration.
        // Resolve the current provider selection so executeStream() has the correct metadata.
        const selection = this.inference.selectProvider({ fallbackAllowed: true, turnId: this.activeTurnId ?? 'unknown' });
        if (selection.success && selection.selectedProvider) {
            console.log(`[AgentService] streamWithBrain — provider chosen: ${selection.selectedProvider.providerId} (${selection.selectedProvider.providerType}) turnId: ${this.activeTurnId ?? 'unknown'}`);
            const req: import('../../shared/inferenceProviderTypes').StreamInferenceRequest = {
                provider: selection.selectedProvider,
                turnId: this.activeTurnId ?? 'unknown',
                sessionId: this.activeSessionId,
                fallbackAllowed: false, // Fallback at brain level is unsafe mid-turn; handled above
                signal,
            };
            return this.inference.executeStream(brain, messages, systemPrompt, onChunk, req, tools, options);
        }
        // Fallback: if no provider is selected, call brain directly (preserves pre-existing behavior)
        console.log(`[AgentService] streamWithBrain — no provider selected, calling brain directly turnId: ${this.activeTurnId ?? 'unknown'}`);
        return brain.streamResponse(messages, systemPrompt, onChunk, signal, tools, options);
    }

    private recordTokenUsage(tokens: number) {
        try {
            const ledgerPath = resolveStoragePath(path.join('memory', 'token_ledger.json'));
            let ledger: any = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')) : {};
            const today = new Date().toISOString().slice(0, 10);
            ledger[today] = (ledger[today] || 0) + tokens;
            fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
        } catch { }
    }

    private browserDataResolvers = new Map<string, (d: any) => void>();

    /** Stable surface identifier for the built-in workspace browser panel.
     *  Matches the surfaceId sent with every browser agent-event and logged
     *  in Browser.tsx handleAgentEvent. Only one built-in browser surface
     *  is supported; all browser tools target it by default. */
    private static readonly BROWSER_SURFACE_ID = 'workspace-browser-1';

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

    /**
     * Intercepts a `BROWSER_*`-prefixed command string returned by a browser tool,
     * dispatches the corresponding agent-event to the built-in workspace browser
     * panel, waits for the browser to confirm execution, and returns the actual
     * result for the LLM.
     *
     * Control flow:
     *   tool result ("BROWSER_NAVIGATE: …")
     *   → dispatchBrowserCommand()
     *   → onEvent("browser-navigate", { url, surfaceId })   ← sent to renderer
     *   → Browser.tsx relays to webview / captures screenshot
     *   → provideBrowserData() resolves the pending promise
     *   → actual result returned to LLM
     *
     * @param rawResult  The raw `BROWSER_*` string from ToolService.
     * @param onEvent    The agent-event callback provided by IpcRouter.
     * @returns The real browser result to be wrapped in [TOOL_RESULT].
     */
    /**
     * Normalises a browser element selector so that the preload script can
     * resolve it via `data-tala-id`.
     *
     * The DOM snapshot (`browser_get_dom`) emits lines like:
     *   `12[:V] <input:text> Search`
     *
     * A model that copies the whole line (or a summary like "[12] INPUT SEARCH")
     * back as a selector would fail the `/^\d+$/.test(selector)` check in the
     * preload.  Extract just the leading digits so both formats are accepted.
     *
     * CSS selectors (containing letters before any digit group, or containing
     * common CSS characters) are passed through unchanged.
     */
    private static normalizeBrowserSelector(raw: string): string {
        // Formats handled:
        //   "12[:V] <input:text> Search"  → "12"
        //   "[12] INPUT SEARCH"           → "12"
        //   "12"                          → "12"  (already canonical)
        //   "input[name='q']"             → pass through (CSS selector)
        const m = raw.match(/^\[?(\d+)\]?(?:\[|[:, <]|$)/);
        if (m) return m[1];
        return raw;
    }

    private async dispatchBrowserCommand(
        rawResult: string,
        onEvent: (type: string, data: any) => void
    ): Promise<string> {
        const surfaceId = AgentService.BROWSER_SURFACE_ID;

        if (rawResult.startsWith('BROWSER_NAVIGATE: ')) {
            const url = rawResult.slice('BROWSER_NAVIGATE: '.length).trim();
            console.log(`[BrowserTool] browse url=${url} targetSurface=${surfaceId}`);
            console.log(`[BrowserSurface] openUrl surface=${surfaceId} url=${url}`);
            onEvent('browser-navigate', { url, surfaceId });
            const response = await this.waitForBrowserData('action-response');
            return response.startsWith('Error:') ? response : `Navigated to ${url}. ${response}`;
        }

        if (rawResult.startsWith('BROWSER_CLICK: ')) {
            const rawSelector = rawResult.slice('BROWSER_CLICK: '.length).trim();
            const selector = AgentService.normalizeBrowserSelector(rawSelector);
            console.log(`[BrowserTool] click selector="${selector}" (raw="${rawSelector}") targetSurface=${surfaceId}`);
            onEvent('browser-click', { selector, surfaceId });
            const ack = await this.waitForBrowserData('action-response');
            console.log(`[BrowserTool] click ack success=${!ack.startsWith('Error:')} target=${selector} message="${ack}"`);
            return ack;
        }

        if (rawResult.startsWith('BROWSER_HOVER: ')) {
            const rawSelector = rawResult.slice('BROWSER_HOVER: '.length).trim();
            const selector = AgentService.normalizeBrowserSelector(rawSelector);
            console.log(`[BrowserTool] hover selector="${selector}" targetSurface=${surfaceId}`);
            onEvent('browser-hover', { selector, surfaceId });
            const ack = await this.waitForBrowserData('action-response');
            console.log(`[BrowserTool] hover ack success=${!ack.startsWith('Error:')} target=${selector} message="${ack}"`);
            return ack;
        }

        if (rawResult.startsWith('BROWSER_TYPE: ')) {
            const argsStr = rawResult.slice('BROWSER_TYPE: '.length).trim();
            let args: { selector?: string; text?: string } = {};
            try { args = JSON.parse(argsStr); } catch { args = {}; }
            if (args.selector) args.selector = AgentService.normalizeBrowserSelector(args.selector);
            console.log(`[BrowserTool] type selector="${args.selector ?? ''}" textLength=${args.text?.length ?? 0} targetSurface=${surfaceId}`);
            onEvent('browser-type', { ...args, surfaceId });
            const ack = await this.waitForBrowserData('action-response');
            console.log(`[BrowserTool] type ack success=${!ack.startsWith('Error:')} target=${args.selector ?? ''} message="${ack}"`);
            return ack;
        }

        if (rawResult.startsWith('BROWSER_SCROLL: ')) {
            const argsStr = rawResult.slice('BROWSER_SCROLL: '.length).trim();
            let args: { direction?: string; amount?: number } = {};
            try { args = JSON.parse(argsStr); } catch { args = {}; }
            console.log(`[BrowserTool] scroll direction=${args.direction ?? 'down'} targetSurface=${surfaceId}`);
            onEvent('browser-scroll', { ...args, surfaceId });
            const ack = await this.waitForBrowserData('action-response');
            console.log(`[BrowserTool] scroll ack success=${!ack.startsWith('Error:')} direction=${args.direction ?? 'down'} message="${ack}"`);
            return ack;
        }

        if (rawResult.startsWith('BROWSER_PRESS_KEY: ')) {
            const key = rawResult.slice('BROWSER_PRESS_KEY: '.length).trim();
            console.log(`[BrowserTool] press_key key="${key}" targetSurface=${surfaceId}`);
            onEvent('browser-press-key', { key, surfaceId });
            const ack = await this.waitForBrowserData('action-response');
            console.log(`[BrowserTool] press_key ack success=${!ack.startsWith('Error:')} key=${key} message="${ack}"`);
            return ack;
        }

        if (rawResult === 'BROWSER_GET_DOM: REQUEST') {
            console.log(`[BrowserTool] get_dom targetSurface=${surfaceId}`);
            onEvent('browser-get-dom', { surfaceId });
            return await this.waitForBrowserData('dom');
        }

        if (rawResult === 'BROWSER_SCREENSHOT: REQUEST') {
            console.log(`[BrowserTool] screenshot targetSurface=${surfaceId}`);
            onEvent('browser-screenshot', { surfaceId });
            const base64 = await this.waitForBrowserData('screenshot');
            if (base64.startsWith('Error:')) return base64;
            return `Screenshot captured from ${surfaceId} (${base64.length} bytes base64 PNG).`;
        }

        // BROWSER_SEARCH and any unknown BROWSER_ commands pass through unchanged
        return rawResult;
    }

    public async headlessInference(prompt: string, config?: any): Promise<string> {
        const res = await this.brain.generateResponse([{ role: 'user', content: prompt }], "Be concise.");
        return res.content;
    }

    /**
     * Executes a registered tool by name with provided arguments.
     * 
     * **Safety & Security:**
     * - Enforces workspace sandboxing for all file system tools.
     * - Proxies MCP tool calls to the `McpService` sidecar.
     * - Redacts sensitive data in audit logs.
     * 
     * @param name - The tool name.
     * @param args - Key-value pair arguments for the tool.
     * @returns The stringified result of the tool execution.
     */
    public async executeTool(name: string, args: any): Promise<any> {
        const invResult = await this.coordinator.executeTool(name, args, undefined, {
            executionType: 'direct_invocation',
            executionOrigin: 'api',
            authorityEnvelope: {
                turnId: `direct-${Date.now()}`,
                mode: 'goal_execution',
                authorityLevel: 'full_authority',
                workflowAuthority: true,
                canCreateDurableState: true,
                canReplan: true,
            },
            // Policy enforcement is performed inside ToolExecutionCoordinator.
        });
        return invResult.data;
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

    /**
     * Assemble and return the current MemoryOperatorReviewModel for the
     * operator review surface in the Reflection Dashboard.
     *
     * Read-only and safe to call repeatedly.  Returns a bounded, advisory-only
     * snapshot; no settings or configurations are changed.
     */
    public async getMemoryOperatorReviewModel(): Promise<MemoryOperatorReviewModel> {
        if (!this._operatorReviewSvc) {
            // Fallback when the DB pool was not available at startup
            this._operatorReviewSvc = new MemoryOperatorReviewService(this.memory, null);
        }
        return this._operatorReviewSvc.getModel();
    }

    /**
     * Trigger an immediate memory maintenance analytics run (manual refresh).
     *
     * Equivalent to a human-requested scheduler tick — does not change any
     * settings or configurations.  Safe to call from the operator review panel.
     *
     * Returns the run result, or null if the scheduler is not available.
     */
    public async runMemoryMaintenanceNow(): Promise<import('../../shared/memory/MemoryMaintenanceState').MemoryRepairScheduledRunResult | null> {
        if (!this._repairScheduler) return null;
        console.log('[MemoryOperatorReview] maintenance run requested by operator');
        return this._repairScheduler.runNow('operator_manual');
    }

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
            const memoryDir = resolveStoragePath('memory');
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
            world: (this.world as any).getReadyStatus ? (this.world as any).getReadyStatus() : true,
            memoryGraph: (this.mcpService as any)?.isServiceCallable?.('tala-memory-graph') ?? false,
            soulReady: this.isSoulReady,
        };
    }

    /**
     * Returns the AstroService instance for use by backend composition roots
     * (e.g. IpcRouter context:assemble handler). Returns null if not initialized.
     */
    public getAstroService(): AstroService | null {
        return this.astro ?? null;
    }

    public async getEmotionState(): Promise<string> {
        // Suppress Astro refresh after technical deterministic turns to save work and reduce noise
        const technicalIntents = ['file_read', 'file_list', 'git_status', 'git_branch', 'repo_audit', 'code_search', 'diagnostics', 'repo_query'];
        if (this.lastTurnExecutionLog && technicalIntents.includes(this.lastTurnExecutionLog.intent)) {
            console.log(`[AgentService] Post-turn astro refresh skipped for tool-only technical intent=${this.lastTurnExecutionLog.intent}`);
            return "Technical mode active. Conversational refresh suppressed.";
        }
        return this.getAstroState();
    }

    private getActiveMode(settings?: any): string {
        const s = settings || loadSettings(this.settingsPath);
        const mode = s.agentModes?.activeMode || 'hybrid';
        return mode;
    }

    public async addMemory(text: string) {
        // Use module-level getActiveMode for a guaranteed cache-only read.
        const mode = getActiveMode(this.settingsPath, 'AgentService.addMemory');

        // P7A: canonical write first — get a canonical_memory_id from Postgres before
        // writing to the derived mem0 store. If Postgres is unavailable, the write
        // proceeds but is flagged by the MemoryService P7A guard.
        let canonicalMemoryId: string | null = null;
        const repo = getCanonicalMemoryRepository();
        if (repo) {
            const pool = (repo as unknown as PostgresMemoryRepository).getSharedPool();
            const authorityService = new MemoryAuthorityService(pool);
            TelemetryBus.getInstance().emit({
                event: 'memory.candidate_proposed',
                subsystem: 'memory',
                executionId: `add-memory-${Date.now()}`,
                payload: {
                    source_kind: 'explicit',
                    source_ref: 'addMemory',
                    memory_type: 'explicit_fact',
                },
            });
            const result = await authorityService.tryCreateCanonicalMemory({
                memory_type: 'explicit_fact',
                subject_type: 'user',
                subject_id: 'user',
                content_text: text,
                source_kind: 'explicit',
                source_ref: 'addMemory',
                confidence: 0.9,
            });
            if (result.success) {
                canonicalMemoryId = result.data ?? null;
            } else {
                console.warn('[AgentService:addMemory] P7A canonical write failed:', result.error);
                TelemetryBus.getInstance().emit({
                    event: 'memory.candidate_rejected',
                    subsystem: 'memory',
                    executionId: `add-memory-${Date.now()}`,
                    payload: {
                        reason: result.error ?? 'canonical write failed',
                        source_kind: 'explicit',
                    },
                });
            }
        } else {
            console.warn('[AgentService:addMemory] P7A: canonical repository not available — derived write is blocked');
            return false;
        }

        if (!canonicalMemoryId) {
            return false;
        }

        return this.memory.syncDerivedProjectionFromCanonical({
            canonicalMemoryId,
            text,
            metadata: { source: 'explicit' },
            mode,
            source: 'explicit',
        });
    }

    public async getAllMemories() {
        return this.memory.getAll();
    }

    /**
     * Canonical backfill migration for legacy local memory projections.
     * All canonical writes are authority-routed through MemoryAuthorityService.
     */
    public async backfillLegacyMemories(
        request: LegacyMemoryBackfillRequest = {},
    ): Promise<LegacyMemoryBackfillReport | null> {
        const repo = getCanonicalMemoryRepository();
        if (!repo) {
            console.warn('[AgentService:backfillLegacyMemories] Canonical repository unavailable');
            return null;
        }

        const pool = (repo as unknown as PostgresMemoryRepository).getSharedPool();
        const authorityService = new MemoryAuthorityService(pool);
        const backfillService = new LegacyMemoryBackfillService(authorityService, this.memory);
        return backfillService.backfillLegacyMemories(request);
    }

    /**
     * Cleanup/invalidate derived artifacts for canonically inactive memory.
     * Canonical authority_status drives cleanup decisions.
     */
    public async cleanupInactiveDerivedMemory(
        request: DerivedCleanupRequest = {},
    ): Promise<DerivedCleanupReport | null> {
        const repo = getCanonicalMemoryRepository();
        if (!repo) {
            console.warn('[AgentService:cleanupInactiveDerivedMemory] Canonical repository unavailable');
            return null;
        }
        const pool = (repo as unknown as PostgresMemoryRepository).getSharedPool();
        const authorityService = new MemoryAuthorityService(pool);
        const cleanupService = new DerivedMemoryCleanupService(authorityService, this.memory);
        return cleanupService.cleanupInactiveDerivedArtifacts(request);
    }

    public async deleteMemory(id: string) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            console.warn(`[AgentService:deleteMemory] Refusing non-canonical memory id: ${id}`);
            return false;
        }

        const repo = getCanonicalMemoryRepository();
        if (!repo) {
            console.warn('[AgentService:deleteMemory] Canonical repository unavailable');
            return false;
        }

        const pool = (repo as unknown as PostgresMemoryRepository).getSharedPool();
        const authorityService = new MemoryAuthorityService(pool);
        const result = await authorityService.tryTombstoneMemory(id);
        if (!result.success) {
            console.warn('[AgentService:deleteMemory] Canonical tombstone failed:', result.error);
            return false;
        }

        const cleanupReport = await this.cleanupInactiveDerivedMemory({
            canonicalMemoryId: id,
            reason: 'tombstone',
        });
        if (!cleanupReport) {
            return false;
        }
        if (cleanupReport.partial_failure) {
            console.warn('[AgentService:deleteMemory] Derived cleanup completed with failures:', cleanupReport.failures);
        }
        return cleanupReport.failed_count === 0;
    }

    /**
     * Updates a memory item by ID.
     */
    public async updateMemory(id: string, text: string) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            console.warn(`[AgentService:updateMemory] Refusing non-canonical memory id: ${id}`);
            return false;
        }

        const repo = getCanonicalMemoryRepository();
        if (!repo) {
            console.warn('[AgentService:updateMemory] Canonical repository unavailable');
            return false;
        }

        const pool = (repo as unknown as PostgresMemoryRepository).getSharedPool();
        const authorityService = new MemoryAuthorityService(pool);
        const result = await authorityService.tryUpdateCanonicalMemory(id, { content_text: text });
        if (!result.success) {
            console.warn('[AgentService:updateMemory] Canonical update failed:', result.error);
            return false;
        }

        await this.memory.syncDerivedProjectionFromCanonical({
            canonicalMemoryId: id,
            text,
            metadata: { source: 'explicit' },
            mode: getActiveMode(this.settingsPath, 'AgentService.updateMemory'),
            source: 'explicit',
        });
        return true;
    }

    /**
     * Returns the current model status and fidelity information.
     */
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



