/* eslint-disable @typescript-eslint/no-explicit-any */
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { IBrain, ChatMessage, BrainResponse, ToolCall } from '../../brains/IBrain';
import type { StreamInferenceResult, CanonicalToolCall } from '../../../shared/inferenceProviderTypes';
import type { AgentTurnOutput } from '../../types/artifacts';
import type { ToolResult } from '../ToolService';
import { loadSettings } from '../SettingsManager';
import { promptAuditService, type PromptAuditRecord } from '../PromptAuditService';
import { auditLogger } from '../AuditLogger';
import { DeterministicIntentRouter, type DeterministicOperation } from '../router/DeterministicIntentRouter';
import { CognitiveTurnAssembler } from '../cognitive/CognitiveTurnAssembler';
import { promptProfileSelector } from '../cognitive/PromptProfileSelector';
import { cognitiveContextCompactor } from '../cognitive/CognitiveContextCompactor';
import { CompactPromptBuilder } from '../plan/CompactPromptBuilder';
import { telemetry } from '../TelemetryService';
import { TelemetryBus } from '../telemetry/TelemetryBus';
import { resolveStoragePath } from '../PathResolver';
import { toolGatekeeper } from '../router/ToolGatekeeper';
import { runtimeSafety } from '../RuntimeSafety';
import { artifactRouter } from '../ArtifactRouter';
import { getCanonicalMemoryRepository } from '../db/initMemoryStore';
import { MemoryAuthorityService } from '../memory/MemoryAuthorityService';
import { DeferredMemoryReplayService } from '../memory/DeferredMemoryReplayService';
import {
    detectMemoryAuthorityViolationError,
    memoryAuthorityGate,
} from '../memory/MemoryAuthorityGate';
import type { PostgresMemoryRepository } from '../db/PostgresMemoryRepository';
import type { ToolInvocationContext } from '../tools/ToolExecutionCoordinator';
import type { MemoryAuthorityContext, MemoryWriteRequest } from '../../../shared/memoryAuthorityTypes';
function isStreamInferenceResult(r: BrainResponse | StreamInferenceResult): r is StreamInferenceResult {
    return 'streamStatus' in r;
}
type BrainUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
type ExecutedToolCall = {
    name: string;
    arguments: any;
    argsPreview?: string;
    ok: boolean;
    error?: string;
    resultPreview?: string;
    startedAt: number;
    endedAt: number;
};
type TurnExecutionLog = {
    turnId: string;
    mode: string;
    intent: string;
    usedEnvelope: boolean;
    toolCallsPlanned: Array<{ name: string, arguments: any }>;
    toolCalls: ExecutedToolCall[];
    executedToolCount: number;
    toolsSentCount: number;
    timestamp: number;
    usage?: {
        total_tokens: number;
        prompt_tokens: number;
        completion_tokens: number;
    };
};

type TurnExecutionInput = {
    userMessage: string;
    onToken?: (token: string) => void;
    onEvent?: (type: string, data: any) => void;
    images?: string[];
    capabilitiesOverride?: any;
};

export type ExecutionPlan = {
    chatStartedAt: number;
    turnId: string;
    settings: any;
    activeMode: string;
    routedIntent: ReturnType<typeof DeterministicIntentRouter.route>;
    path: 'deterministic_fast_path' | 'llm_loop';
    requiresLlm: boolean;
    requiresToolUse: boolean;
    isGreeting: boolean;
    isBrowserTask: boolean;
    directAnswerPreferred: boolean;
    hardBlockAllTools: boolean;
    toolExposureProfile: 'unresolved' | 'none' | 'technical_strict' | 'factual_narrow' | 'immersive_controlled' | 'balanced';
    toolDirection: 'policy_controlled' | 'blocked';
    deterministicOperation: DeterministicOperation | null;
};

export type PreLoopResolvedToolPolicy = {
    isBrowserTask: boolean;
    requiresToolUse: boolean;
    hardBlockAllTools: boolean;
    directAnswerPreferred: boolean;
    toolExposureProfile: ExecutionPlan['toolExposureProfile'];
    browserTaskToolNames: Set<string>;
    browserMutatingToolNames: Set<string>;
    browserMaxContinuationSteps: number;
    allowedToolNames: Set<string>;
    initialToolsToSend: any[];
    initialToolChoice?: 'required';
    blockedTools: string[];
    gatingReasons: string[];
    toolGateApplied: boolean;
    strippedToolNames: string[];
    allowedCapabilitiesCount: number;
};

export type IterationToolRequest = {
    toolsToSend: any[];
    toolChoice?: 'required';
    blockedTools: string[];
    hardBlockAllTools: boolean;
    directAnswerPreferred: boolean;
    browserTaskActive: boolean;
    browserPaletteFiltered: boolean;
    toolGateApplied: boolean;
    strippedToolNames: string[];
    requestedToolCount: number;
    blockedToolsAppliedCount: number;
    allowedCapabilitiesCount: number;
};

export type PromptBlockKind =
    | 'identity'
    | 'task_policy'
    | 'memory'
    | 'docs_retrieval'
    | 'tools'
    | 'notebook'
    | 'astro'
    | 'reflection';

export type PromptBlockBudget = {
    kind: PromptBlockKind;
    maxChars: number;
};

export type PromptBlockRenderResult = {
    kind: PromptBlockKind;
    selected: boolean;
    included: boolean;
    rendered: boolean;
    merged: boolean;
    skipped: boolean;
    omittedByPolicy: boolean;
    truncated: boolean;
    originalChars: number;
    finalChars: number;
    finalRenderedChars: number;
    maxChars: number;
    renderTargets: string[];
    reason?: string;
    content: string;
};

export type BoundedPromptPacket = {
    budgets: Record<PromptBlockKind, number>;
    blocks: PromptBlockRenderResult[];
    selectedBlocks: PromptBlockKind[];
    includedBlocks: PromptBlockKind[];
    renderedBlocks: PromptBlockKind[];
    mergedBlocks: PromptBlockKind[];
    skippedBlocks: PromptBlockKind[];
    omittedByPolicyBlocks: PromptBlockKind[];
    truncatedBlocks: PromptBlockKind[];
    totalChars: number;
    renderedChars: number;
    inputs: {
        systemPromptBase: string;
        userIdentity: string;
        dynamicContext: string;
        memoryContext: string;
        goalsAndReflections: string;
        toolSigs: string;
        notebookGrounded: boolean;
    };
};

export type TurnAssemblyResult = {
    plan: ExecutionPlan;
    input: TurnExecutionInput;
    assemblyStart: number;
    activeInstance: any;
    isSmallLocalModel: boolean;
    agentId: string;
    userId: string;
    notebookActive: boolean;
    orchResult: any;
    turnObject: any;
    turnPolicy: any;
    turnBehavior: any;
    memoryContext: string;
    hasMemories: boolean;
    isGreeting: boolean;
    astroState: string;
    cognitiveContext: any;
    dynamicContext: string;
    repetitionSafety: string;
    modeConfig: any;
    activeProfileId: string;
    activeProfile: any;
    goalsAndReflections: string;
    userIdentity: string;
    allowedCapabilities?: string[];
    policyToolAllowList: Set<string> | null;
    filteredTools: any[];
    toolSigs: string;
    earlyReturn?: AgentTurnOutput;
};

export type PromptBuildResult = {
    plan: ExecutionPlan;
    input: TurnExecutionInput;
    assembly: TurnAssemblyResult;
    selectedProvider: any;
    modelName: string;
    systemPrompt: string;
    enforceCanonRequiredAutobioOverride: boolean;
    messageBudget: number;
    filteredTools: any[];
    allowedToolNames: Set<string>;
    modeConfig: any;
    turnObject: any;
    turnPolicy: any;
    memoryContext: string;
    hasMemories: boolean;
    isGreeting: boolean;
    orchResult: any;
    chatStartedAt: number;
    settings: any;
    transientMessages: ChatMessage[];
    cumulativeUsage: BrainUsage;
    executionLog: TurnExecutionLog;
    turnSeenHashes: Set<string>;
    preLoopToolPolicy?: PreLoopResolvedToolPolicy;
};

export type LoopExecutionResult = {
    output?: AgentTurnOutput;
    plan?: ExecutionPlan;
    input?: TurnExecutionInput;
    assembly?: TurnAssemblyResult;
    prompt?: PromptBuildResult;
    finalResponse?: string;
    transientMessages?: ChatMessage[];
    cumulativeUsage?: BrainUsage;
    executionLog?: TurnExecutionLog;
    modelName?: string;
};
export type ChatExecutionSpineAgent = {
    settingsPath: string;
    activeSessionId: string;
    activeTurnId: string | null;
    activeNotebookContext: { id: string | null; sourcePaths: string[] };
    abortController: AbortController | null;
    currentTurnAuditRecord?: PromptAuditRecord;
    chatHistory: ChatMessage[];
    brain: IBrain;
    brainIsReady: boolean;
    MAX_TOOL_CALLS_PER_TURN: number;
    MAX_AGENT_ITERATIONS: number;
    preInferenceOrchestrator: any;
    userProfile: any;
    functions: any;
    goals: any;
    tools: any;
    inference: any;
    diagnosticsAggregator: any;
    logViewerService: any;
    coordinator: any;
    memory: any;
    rag: any;
    mcpService: any;
    executionLogHistory: TurnExecutionLog[];
    lastTurnExecutionLog?: TurnExecutionLog;
    getActiveMode: (settings: any) => string;
    completeToolOnlyTurn: (
        result: ToolResult,
        turnId: string,
        intent: string,
        activeMode: string,
        toolName: string,
        args: any,
        toolStartTime: number,
        chatStartedAt: number,
        onToken?: (token: string) => void,
        onEvent?: (type: string, data: any) => void,
    ) => Promise<AgentTurnOutput>;
    getReflectionSummary: () => string;
    newSession: () => void;
    saveSession: () => void;
    estimateTokens: (text: string) => number;
    truncateHistory: (messages: ChatMessage[], messageBudget: number) => ChatMessage[];
    streamWithBrain: (
        brain: IBrain,
        messages: ChatMessage[],
        systemPrompt: string,
        onToken: (token: string) => void,
        signal: AbortSignal | undefined,
        tools: any[],
        options: any,
    ) => Promise<BrainResponse | StreamInferenceResult>;
    commitAssistantMessage: (
        transientMessages: ChatMessage[],
        msg: ChatMessage,
        intentClass: string,
        executedToolCount: number,
        turnSeenHashes: Set<string>,
        activeMode: string,
    ) => void;
    normalizeToLegacyToolCalls: (calls: CanonicalToolCall[]) => ToolCall[];
    getToolTimeout: (toolName: string) => number;
    parseToolArguments: (toolName: string, rawArgs: any) => any;
    validateToolArguments: (toolName: string, args: any) => void;
    dispatchBrowserCommand: (command: string, onEvent: (type: string, data: any) => void) => Promise<string>;
    getGroundedExecutionSummary: () => string;
    extractJsonObjectEnvelope: (text: string) => any;
    shouldApplyCanonRequiredAutobioOverride: (turnObject: any, activeMode: string) => boolean;
    applyCanonRequiredAutobioDirective: (systemPrompt: string) => string;
    enforceCanonRequiredAutobioFallbackReply: (content: string, enforceCanonRequiredAutobioOverride: boolean) => string;
    applyCanonRequiredAutobioFinalizeOverride: (
        finalResponse: string,
        transientMessages: ChatMessage[],
        enforceCanonRequiredAutobioOverride: boolean,
    ) => {
        finalResponse: string;
        transientMessages: ChatMessage[];
        enforced: boolean;
        originalContentLength: number;
        replacedAtStage: string;
    };
    logPriorityMemorySerializationGuard: (
        phase: 'assembled' | 'pre_dispatch',
        turnId: string,
        turnObject: any,
        hasMemories: boolean,
        memoryContext: string,
        systemPrompt: string,
    ) => void;
};
export class ChatExecutionSpine {
    private deterministicBypassOpportunityCount = 0;
    private deterministicBypassExecutedCount = 0;

    public constructor(private readonly agent: ChatExecutionSpineAgent) {}

    public async executeTurn(
        userMessage: string,
        onToken?: (token: string) => void,
        onEvent?: (type: string, data: any) => void,
        images?: string[],
        capabilitiesOverride?: any,
    ): Promise<AgentTurnOutput> {
        const input: TurnExecutionInput = { userMessage, onToken, onEvent, images, capabilitiesOverride };
        const plan = this.planTurn(input);
        const deterministic = await this.executeDeterministicFastPath(plan, input);
        if (deterministic) return deterministic;
        const assembly = await this.assembleContext(plan, input);
        if (assembly.earlyReturn) return assembly.earlyReturn;
        const prompt = await this.buildPrompt(assembly);
        const loop = await this.runExecutionLoop(prompt);
        return this.finalizeOutcome(loop);
    }

    private planTurn(input: TurnExecutionInput): ExecutionPlan {
        const chatStartedAt = Date.now();
        const correlationId = uuidv4();
        auditLogger.setCorrelationId(correlationId);
        console.log('[AgentService] ====== CHAT STARTED ======');

        const turnId = `${this.agent.activeSessionId}_${Date.now()}`;
        this.agent.activeTurnId = turnId;

        const settings = loadSettings(this.agent.settingsPath);
        const activeMode = this.agent.getActiveMode(settings);
        const routedIntent = DeterministicIntentRouter.route(input.userMessage);
        const deterministicOperation = routedIntent.deterministicOperation ??
            (routedIntent.suggestedTool
                ? {
                    kind: routedIntent.intent as DeterministicOperation['kind'],
                    toolName: routedIntent.suggestedTool,
                    args: routedIntent.extractedArgs || {},
                    requiresLlm: false as const,
                }
                : null);
        const deterministicCandidate = activeMode !== 'rp' && routedIntent.isDeterministic && !routedIntent.requires_llm && !!deterministicOperation;
        if (routedIntent.isDeterministic && !routedIntent.requires_llm && !deterministicCandidate) {
            telemetry.operational(
                'execution',
                'execution.deterministic_path_fallback',
                'info',
                `turn:${turnId}`,
                'Deterministic routing detected but full execution loop retained.',
                'partial',
                {
                    payload: {
                        turnId,
                        intent: routedIntent.intent,
                        activeMode,
                        reason: activeMode === 'rp' ? 'rp_mode_tools_blocked' : 'missing_operation_contract',
                    },
                },
            );
        }

        return {
            chatStartedAt,
            turnId,
            settings,
            activeMode,
            routedIntent,
            path: deterministicCandidate
                ? 'deterministic_fast_path'
                : 'llm_loop',
            requiresLlm: !deterministicCandidate,
            requiresToolUse: (routedIntent as any).intent === 'coding' || (routedIntent as any).intent === 'browser' || (routedIntent as any).intent === 'browser_navigate',
            isGreeting: (routedIntent as any).intent === 'greeting',
            isBrowserTask: (routedIntent as any).intent === 'browser' || (routedIntent as any).intent === 'browser_navigate',
            directAnswerPreferred: false,
            hardBlockAllTools: false,
            toolExposureProfile: 'unresolved',
            toolDirection: activeMode === 'rp' ? 'blocked' : 'policy_controlled',
            deterministicOperation,
        };
    }

    private async executeDeterministicFastPath(plan: ExecutionPlan, input: TurnExecutionInput): Promise<AgentTurnOutput | null> {
        const { activeMode, routedIntent, turnId, chatStartedAt, deterministicOperation } = plan;
        const deterministicCandidate = plan.path === 'deterministic_fast_path' && activeMode !== 'rp' && routedIntent.isDeterministic && !routedIntent.requires_llm;
        if (deterministicCandidate) {
            this.deterministicBypassOpportunityCount += 1;
            telemetry.operational(
                'execution',
                'execution.deterministic_opportunity_detected',
                'info',
                `turn:${turnId}`,
                `Deterministic opportunity detected for intent=${routedIntent.intent}.`,
                'success',
                {
                    payload: {
                        turnId,
                        intent: routedIntent.intent,
                        mode: activeMode,
                        deterministicBypassOpportunityCount: this.deterministicBypassOpportunityCount,
                        deterministicBypassExecutedCount: this.deterministicBypassExecutedCount,
                        operationKind: deterministicOperation?.kind ?? null,
                    },
                },
            );
        }
        if (deterministicCandidate) {
            if (!deterministicOperation) {
                telemetry.operational(
                    'execution',
                    'execution.deterministic_path_fallback',
                    'warn',
                    `turn:${turnId}`,
                    'Deterministic path candidate had no operation contract. Falling back to full loop.',
                    'partial',
                    {
                        payload: {
                            turnId,
                            intent: routedIntent.intent,
                            reason: 'missing_operation_contract',
                        },
                    },
                );
                return null;
            }
            console.log(`[AgentService] TRUE FAST PATH: Deterministic bypass triggered: ${routedIntent.intent} operation=${deterministicOperation.kind}`);
            const toolName = deterministicOperation.toolName;
            if (toolName) {
                try {
                    const parsedArgs = deterministicOperation.args || {};
                    const toolStartTime = Date.now();
                    const invResult = await this.agent.coordinator.executeTool(toolName, parsedArgs, new Set([toolName]), {
                        executionId: turnId,
                        executionType: 'chat_turn',
                        executionOrigin: 'ipc',
                        executionMode: activeMode,
                        authorityEnvelope: input.capabilitiesOverride?.turnAuthorityEnvelope,
                        memoryAuthorityContext: input.capabilitiesOverride?.turnMemoryAuthorityContext,
                    });
                    const rawResult = invResult.data;
                    const result = typeof rawResult === 'object' && rawResult !== null ? rawResult : { result: String(rawResult), requires_llm: false, success: !String(rawResult).toLowerCase().includes('error:') };
                    this.deterministicBypassExecutedCount += 1;
                    telemetry.operational(
                        'execution',
                        'execution.deterministic_path_selected',
                        'info',
                        `turn:${turnId}`,
                        `Deterministic operation executed: ${deterministicOperation.kind} via ${toolName}.`,
                        'success',
                        {
                            payload: {
                                turnId,
                                intent: routedIntent.intent,
                                operationKind: deterministicOperation.kind,
                                toolName,
                                deterministicBypassOpportunityCount: this.deterministicBypassOpportunityCount,
                                deterministicBypassExecutedCount: this.deterministicBypassExecutedCount,
                            },
                        },
                    );
                    return await this.agent.completeToolOnlyTurn(result as ToolResult, turnId, routedIntent.intent, activeMode, toolName, parsedArgs, toolStartTime, chatStartedAt, input.onToken, input.onEvent);
                } catch (e: any) {
                    console.error('[AgentService] FAST PATH FAIL, falling back to LLM:', e);
                    telemetry.operational(
                        'execution',
                        'execution.deterministic_path_fallback',
                        'warn',
                        `turn:${turnId}`,
                        'Deterministic operation execution failed; falling back to full loop.',
                        'partial',
                        {
                            payload: {
                                turnId,
                                intent: routedIntent.intent,
                                operationKind: deterministicOperation.kind,
                                toolName,
                                reason: 'tool_execution_failed',
                                error: String(e?.message || e),
                            },
                        },
                    );
                }
            }
        }
        return null;
    }

    private async assembleContext(plan: ExecutionPlan, input: TurnExecutionInput): Promise<TurnAssemblyResult> {
        return {
            plan,
            input,
            assemblyStart: 0,
            activeInstance: null,
            isSmallLocalModel: false,
            agentId: '',
            userId: '',
            notebookActive: false,
            orchResult: null,
            turnObject: null,
            turnPolicy: null,
            turnBehavior: null,
            memoryContext: '',
            hasMemories: false,
            isGreeting: false,
            astroState: '',
            cognitiveContext: null,
            dynamicContext: '',
            repetitionSafety: '',
            modeConfig: {},
            activeProfileId: '',
            activeProfile: null,
            goalsAndReflections: '',
            userIdentity: '',
            allowedCapabilities: undefined,
            policyToolAllowList: null,
            filteredTools: [],
            toolSigs: '',
        };
    }

    private async buildPrompt(assembly: TurnAssemblyResult): Promise<PromptBuildResult> {
        return {
            assembly,
            plan: assembly.plan,
            input: assembly.input,
            selectedProvider: null,
            modelName: 'unknown',
            systemPrompt: '',
            enforceCanonRequiredAutobioOverride: false,
            messageBudget: 0,
            filteredTools: [],
            allowedToolNames: new Set<string>(),
            modeConfig: {},
            turnObject: null,
            turnPolicy: null,
            memoryContext: '',
            hasMemories: false,
            isGreeting: false,
            orchResult: null,
            chatStartedAt: assembly.plan.chatStartedAt,
            settings: assembly.plan.settings,
            transientMessages: [],
            cumulativeUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            executionLog: {
                turnId: assembly.plan.turnId,
                mode: assembly.plan.activeMode,
                intent: assembly.plan.routedIntent.intent,
                usedEnvelope: false,
                toolCallsPlanned: [],
                toolCalls: [],
                executedToolCount: 0,
                toolsSentCount: 0,
                timestamp: Date.now(),
            },
            turnSeenHashes: new Set<string>(),
        };
    }

    private resolvePreLoopToolPolicyFromPlan(plan: ExecutionPlan): PreLoopResolvedToolPolicy {
        return {
            isBrowserTask: plan.isBrowserTask,
            requiresToolUse: plan.requiresToolUse,
            hardBlockAllTools: plan.hardBlockAllTools,
            directAnswerPreferred: plan.directAnswerPreferred,
            toolExposureProfile: plan.toolExposureProfile,
            browserTaskToolNames: new Set([
                'browse', 'browser_get_dom', 'browser_click', 'browser_hover',
                'browser_type', 'browser_scroll', 'browser_press_key', 'browser_screenshot',
            ]),
            browserMutatingToolNames: new Set([
                'browse', 'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll',
            ]),
            browserMaxContinuationSteps: 3,
            allowedToolNames: new Set<string>(),
            initialToolsToSend: [],
            initialToolChoice: plan.requiresToolUse ? 'required' : undefined,
            blockedTools: [],
            gatingReasons: [],
            toolGateApplied: false,
            strippedToolNames: [],
            allowedCapabilitiesCount: 0,
        };
    }

    private selectPromptBlockBudgets(params: {
        activeMode: string;
        intentClass: string;
        isGreeting: boolean;
        isBrowserTask: boolean;
        toolsEnabled: boolean;
    }): Record<PromptBlockKind, number> {
        const { activeMode, intentClass, isGreeting, isBrowserTask, toolsEnabled } = params;
        const base: Record<PromptBlockKind, number> = {
            identity: 2600,
            task_policy: 2800,
            memory: 3200,
            docs_retrieval: 2400,
            tools: toolsEnabled ? 7000 : 0,
            notebook: 900,
            astro: 1200,
            reflection: 1800,
        };

        if (isGreeting) {
            return {
                ...base,
                task_policy: 1400,
                memory: 800,
                docs_retrieval: 400,
                tools: 0,
                astro: 400,
                reflection: 400,
            };
        }

        if (activeMode === 'rp') {
            return {
                ...base,
                identity: 3000,
                task_policy: 3200,
                tools: 0,
                reflection: 2400,
                astro: 1800,
            };
        }

        if (isBrowserTask || intentClass === 'browser') {
            return {
                ...base,
                task_policy: 3200,
                tools: toolsEnabled ? 9000 : 0,
                memory: 1400,
                docs_retrieval: 1200,
                reflection: 700,
                astro: 600,
            };
        }

        if (intentClass === 'coding' || intentClass === 'diagnostics') {
            return {
                ...base,
                task_policy: 3200,
                tools: toolsEnabled ? 9000 : 0,
                memory: 1400,
                docs_retrieval: 1200,
                reflection: 700,
                astro: 600,
            };
        }

        if (intentClass === 'factual') {
            return {
                ...base,
                memory: 2400,
                docs_retrieval: 3400,
                reflection: 900,
            };
        }

        return base;
    }

    private renderPromptBlock(
        kind: PromptBlockKind,
        rawContent: string,
        budget: number,
        semantics: {
            selected: boolean;
            rendered: boolean;
            merged?: boolean;
            omittedByPolicy?: boolean;
            renderTargets?: string[];
            reason?: string;
            additionalRenderedChars?: number;
        }
    ): PromptBlockRenderResult {
        const {
            selected,
            rendered,
            merged = false,
            omittedByPolicy = false,
            renderTargets = [],
            reason,
            additionalRenderedChars = 0,
        } = semantics;
        const safe = rawContent ?? '';
        const originalChars = safe.length;
        const maxChars = Math.max(0, budget);
        if (maxChars === 0 || originalChars === 0) {
            const skipped = !rendered;
            return {
                kind,
                selected,
                included: false,
                rendered,
                merged,
                skipped,
                omittedByPolicy,
                truncated: false,
                originalChars,
                finalChars: 0,
                finalRenderedChars: additionalRenderedChars,
                maxChars,
                renderTargets,
                reason,
                content: '',
            };
        }
        if (originalChars <= maxChars) {
            const skipped = !rendered;
            const finalChars = originalChars;
            return {
                kind,
                selected,
                included: true,
                rendered,
                merged,
                skipped,
                omittedByPolicy,
                truncated: false,
                originalChars,
                finalChars,
                finalRenderedChars: (rendered ? finalChars : 0) + additionalRenderedChars,
                maxChars,
                renderTargets,
                reason,
                content: safe,
            };
        }
        const ellipsis = '\n...[TRUNCATED]';
        const hardLimit = Math.max(0, maxChars - ellipsis.length);
        const content = `${safe.slice(0, hardLimit)}${ellipsis}`;
        const skipped = !rendered;
        return {
            kind,
            selected,
            included: true,
            rendered,
            merged,
            skipped,
            omittedByPolicy,
            truncated: true,
            originalChars,
            finalChars: content.length,
            finalRenderedChars: (rendered ? content.length : 0) + additionalRenderedChars,
            maxChars,
            renderTargets,
            reason,
            content,
        };
    }

    private buildBoundedPromptPacket(params: {
        executionPlan: ExecutionPlan;
        turnObject: any;
        turnPolicy: any;
        activeProfileSystemPrompt: string;
        userIdentity: string;
        dynamicContext: string;
        memoryContext: string;
        docContextText?: string;
        toolSigs: string;
        notebookActive: boolean;
        goalsAndReflections: string;
        astroState: string;
    }): BoundedPromptPacket {
        const {
            executionPlan,
            turnObject,
            turnPolicy,
            activeProfileSystemPrompt,
            userIdentity,
            dynamicContext,
            memoryContext,
            docContextText,
            toolSigs,
            notebookActive,
            goalsAndReflections,
            astroState,
        } = params;
        const intentClass = turnObject?.intent?.class || 'unknown';
        const toolsEnabled = !(turnObject?.blockedCapabilities?.includes('all') || executionPlan.activeMode === 'rp' || turnPolicy?.toolExposureProfile === 'none');
        const budgets = this.selectPromptBlockBudgets({
            activeMode: executionPlan.activeMode,
            intentClass,
            isGreeting: !!executionPlan.isGreeting,
            isBrowserTask: !!executionPlan.isBrowserTask,
            toolsEnabled,
        });
        const budgetEntries: PromptBlockBudget[] = (Object.keys(budgets) as PromptBlockKind[]).map((kind) => ({
            kind,
            maxChars: budgets[kind],
        }));
        const budgetByKind = budgetEntries.reduce((acc, entry) => {
            acc[entry.kind] = entry.maxChars;
            return acc;
        }, {} as Record<PromptBlockKind, number>);

        const notebookText = notebookActive
            ? `[NOTEBOOK]: Active notebook context is attached. Prioritize grounded references from notebook sources when relevant.`
            : '';
        const identityOverlayBudget = Math.max(400, Math.floor(budgetByKind.identity * 0.5));
        const identityOverlay = this.renderPromptBlock(
            'identity',
            userIdentity || '',
            identityOverlayBudget,
            {
                selected: !!userIdentity,
                rendered: false,
                merged: true,
                renderTargets: ['userIdentity'],
                reason: userIdentity ? 'merged_into_compact_builder_userIdentity' : 'identity_overlay_not_available',
            },
        );
        const toolsOmittedByPolicy = !toolsEnabled || turnPolicy?.toolExposureProfile === 'none' || executionPlan.activeMode === 'rp';

        const blocks: PromptBlockRenderResult[] = [
            this.renderPromptBlock('identity', `${activeProfileSystemPrompt || ''}`, budgetByKind.identity, {
                selected: true,
                rendered: true,
                merged: true,
                renderTargets: ['systemPromptBase', 'userIdentity'],
                reason: identityOverlay.included
                    ? 'renders_system_prompt_base_and_merges_identity_overlay'
                    : 'renders_system_prompt_base',
                additionalRenderedChars: identityOverlay.finalChars,
            }),
            this.renderPromptBlock('task_policy', dynamicContext || '', budgetByKind.task_policy, {
                selected: true,
                rendered: true,
                renderTargets: ['dynamicContext'],
                reason: 'renders_dynamic_context',
            }),
            this.renderPromptBlock('memory', memoryContext || '', budgetByKind.memory, {
                selected: true,
                rendered: turnPolicy?.memoryReadPolicy !== 'blocked',
                omittedByPolicy: turnPolicy?.memoryReadPolicy === 'blocked',
                renderTargets: ['memoryContext'],
                reason: turnPolicy?.memoryReadPolicy === 'blocked'
                    ? 'omitted_by_memory_read_policy'
                    : 'renders_memory_context',
            }),
            this.renderPromptBlock('docs_retrieval', docContextText || '', budgetByKind.docs_retrieval, {
                selected: true,
                rendered: false,
                renderTargets: [],
                reason: 'selected_bounded_but_not_in_compact_builder_text_path',
            }),
            this.renderPromptBlock('tools', toolSigs || '', budgetByKind.tools, {
                selected: true,
                rendered: !toolsOmittedByPolicy,
                omittedByPolicy: toolsOmittedByPolicy,
                renderTargets: ['toolSigs'],
                reason: toolsOmittedByPolicy
                    ? 'selected_but_omitted_by_tool_exposure_policy'
                    : 'renders_tool_signatures',
            }),
            this.renderPromptBlock('notebook', notebookText, budgetByKind.notebook, {
                selected: notebookActive,
                rendered: false,
                merged: true,
                renderTargets: ['notebookGrounded'],
                reason: notebookActive
                    ? 'merged_into_notebook_grounded_flag'
                    : 'notebook_inactive',
            }),
            this.renderPromptBlock('astro', astroState || '', budgetByKind.astro, {
                selected: true,
                rendered: false,
                omittedByPolicy: turnObject?.turnBehavior?.astroLevel === 'off',
                renderTargets: [],
                reason: turnObject?.turnBehavior?.astroLevel === 'off'
                    ? 'selected_but_omitted_by_astro_policy'
                    : 'selected_bounded_but_not_in_compact_builder_text_path',
            }),
            this.renderPromptBlock('reflection', goalsAndReflections || '', budgetByKind.reflection, {
                selected: true,
                rendered: turnObject?.turnBehavior?.reflectionLevel !== 'off',
                omittedByPolicy: turnObject?.turnBehavior?.reflectionLevel === 'off',
                renderTargets: ['goalsAndReflections'],
                reason: turnObject?.turnBehavior?.reflectionLevel === 'off'
                    ? 'selected_but_omitted_by_reflection_policy'
                    : 'renders_reflection_context',
            }),
        ];

        const byKind = (kind: PromptBlockKind) => blocks.find(b => b.kind === kind)?.content || '';
        const inputs = {
            systemPromptBase: byKind('identity'),
            userIdentity: identityOverlay.content,
            dynamicContext: byKind('task_policy'),
            memoryContext: byKind('memory'),
            goalsAndReflections: byKind('reflection'),
            toolSigs: byKind('tools'),
            notebookGrounded: notebookActive,
        };

        const selectedBlocks = blocks.filter(b => b.selected).map(b => b.kind);
        const includedBlocks = blocks.filter(b => b.included).map(b => b.kind);
        const renderedBlocks = blocks.filter(b => b.included && b.rendered).map(b => b.kind);
        const mergedBlocks = blocks.filter(b => b.selected && b.merged).map(b => b.kind);
        const skippedBlocks = blocks.filter(b => b.selected && b.skipped).map(b => b.kind);
        const omittedByPolicyBlocks = blocks.filter(b => b.selected && b.omittedByPolicy).map(b => b.kind);
        const truncatedBlocks = blocks.filter(b => b.truncated).map(b => b.kind);
        const totalChars = blocks.reduce((sum, b) => sum + b.finalChars, 0);
        const renderedChars = blocks.reduce((sum, b) => sum + b.finalRenderedChars, 0);

        return {
            budgets: budgetByKind,
            blocks,
            selectedBlocks,
            includedBlocks,
            renderedBlocks,
            mergedBlocks,
            skippedBlocks,
            omittedByPolicyBlocks,
            truncatedBlocks,
            totalChars,
            renderedChars,
            inputs,
        };
    }

    private shapeIterationToolRequest(params: {
        executionPlan: ExecutionPlan;
        preLoopPolicy: PreLoopResolvedToolPolicy;
        turnPolicy: any;
        activeMode: string;
        intentClass: string;
        isGreeting: boolean;
        allowedCapabilities?: string[];
        policyToolAllowList: Set<string> | null;
        filteredTools: any[];
    }): IterationToolRequest {
        const {
            executionPlan,
            preLoopPolicy,
            turnPolicy,
            activeMode,
            intentClass,
            isGreeting,
            allowedCapabilities,
            policyToolAllowList,
            filteredTools,
        } = params;
        const resolvedActiveMode = executionPlan.activeMode || activeMode;

        let toolsToSend = filteredTools;
        let browserPaletteFiltered = false;

        if (turnPolicy.toolExposureProfile === 'none' || resolvedActiveMode === 'rp') {
            toolsToSend = [];
        } else if (policyToolAllowList) {
            toolsToSend = toolsToSend.filter((t: any) => policyToolAllowList.has(t.function.name));
        } else if (preLoopPolicy.isBrowserTask) {
            toolsToSend = toolsToSend.filter((t: any) => preLoopPolicy.browserTaskToolNames.has(t.function.name));
            browserPaletteFiltered = true;
        }

        let toolChoice: 'required' | undefined;
        if ((intentClass === 'coding' || preLoopPolicy.isBrowserTask) && turnPolicy.toolExposureProfile !== 'none' && resolvedActiveMode !== 'rp') {
            toolChoice = 'required';
        } else if (intentClass === 'conversation' || turnPolicy.toolExposureProfile === 'none' || resolvedActiveMode === 'rp') {
            toolsToSend = [];
        }

        const requestedTools = toolsToSend;
        const allowedCaps = allowedCapabilities ?? [];
        const authorizedTools =
            isGreeting || intentClass === 'greeting' || allowedCaps.length === 0
                ? []
                : requestedTools;
        const toolGateApplied = authorizedTools.length !== requestedTools.length;
        const strippedToolNames = requestedTools
            .filter((t: any) => !authorizedTools.includes(t))
            .map((t: any) => t.function?.name ?? (t as any).name)
            .filter(Boolean);

        toolsToSend = authorizedTools;
        if (toolsToSend.length === 0) {
            toolChoice = undefined;
        }

        let blockedToolsAppliedCount = 0;
        if (preLoopPolicy.blockedTools.length > 0 && toolsToSend.length > 0) {
            const before = toolsToSend.length;
            toolsToSend = toolsToSend.filter((t: any) => !preLoopPolicy.blockedTools.includes(t.function.name));
            blockedToolsAppliedCount = before - toolsToSend.length;
        }

        if (preLoopPolicy.hardBlockAllTools) {
            toolsToSend = [];
            toolChoice = undefined;
        }

        return {
            toolsToSend,
            toolChoice,
            blockedTools: preLoopPolicy.blockedTools,
            hardBlockAllTools: preLoopPolicy.hardBlockAllTools,
            directAnswerPreferred: preLoopPolicy.directAnswerPreferred,
            browserTaskActive: preLoopPolicy.isBrowserTask,
            browserPaletteFiltered,
            toolGateApplied,
            strippedToolNames,
            requestedToolCount: requestedTools.length,
            blockedToolsAppliedCount,
            allowedCapabilitiesCount: allowedCaps.length,
        };
    }

    private handleNoToolCallsIteration(params: {
        isBrowserTask: boolean;
        activeMode: string;
        browserContinuationStep: number;
        browserMaxContinuationSteps: number;
        transientMessages: ChatMessage[];
        browserTaskHadSuccessfulAction: boolean;
        responseContent: string;
        enforceCanonRequiredAutobioOverride: boolean;
    }): { continued: boolean; browserContinuationStep: number; finalResponse: string } {
        const {
            isBrowserTask,
            activeMode,
            browserContinuationStep,
            browserMaxContinuationSteps,
            transientMessages,
            browserTaskHadSuccessfulAction,
            responseContent,
            enforceCanonRequiredAutobioOverride,
        } = params;

        if (isBrowserTask && activeMode !== 'rp' && browserContinuationStep < browserMaxContinuationSteps) {
            const nextStep = browserContinuationStep + 1;
            const browserHint = `[BROWSER_TASK_CONTINUATION] The browser task is not yet complete. You must continue using browser tools. Available tools: browse, browser_get_dom, browser_click, browser_type, browser_scroll, browser_press_key. Call the next appropriate browser tool now. Do NOT respond with prose.`;
            transientMessages.push({ role: 'user', content: browserHint });
            console.log(`[AgentService] browser task incomplete, continuing tool loop step=${nextStep}`);
            return { continued: true, browserContinuationStep: nextStep, finalResponse: '' };
        }

        if (isBrowserTask) {
            const stalled = browserContinuationStep >= browserMaxContinuationSteps
                && !browserTaskHadSuccessfulAction;
            if (stalled) {
                console.log(`[AgentService] finalizing browser task complete=false reason=stalled hadSuccessfulAction=${browserTaskHadSuccessfulAction}`);
                const incompleteNote = '[BROWSER_TASK_INCOMPLETE] The browser task could not be completed â€” no browser action succeeded within the allotted continuation steps.';
                return {
                    continued: false,
                    browserContinuationStep,
                    finalResponse: `${incompleteNote}\n\n${this.agent.enforceCanonRequiredAutobioFallbackReply(
                        responseContent || '',
                        enforceCanonRequiredAutobioOverride,
                    )}`.trim(),
                };
            }
            console.log(`[AgentService] finalizing browser task complete=true hadSuccessfulAction=${browserTaskHadSuccessfulAction}`);
        }

        return {
            continued: false,
            browserContinuationStep,
            finalResponse: this.agent.enforceCanonRequiredAutobioFallbackReply(
                responseContent || '',
                enforceCanonRequiredAutobioOverride,
            ),
        };
    }

    private async handleIterationTimeoutFallback(params: {
        error: any;
        toolsSentThisIteration: any[];
        turn: number;
        turnId: string;
        signal: AbortSignal;
        truncated: ChatMessage[];
        systemPrompt: string;
        onToken?: (token: string) => void;
        turnObject: any;
        enforceCanonRequiredAutobioOverride: boolean;
        executionLog: TurnExecutionLog;
        transientMessages: ChatMessage[];
        turnSeenHashes: Set<string>;
        activeMode: string;
    }): Promise<{ handled: boolean; finalResponse?: string }> {
        const {
            error,
            toolsSentThisIteration,
            turn,
            turnId,
            signal,
            truncated,
            systemPrompt,
            onToken,
            turnObject,
            enforceCanonRequiredAutobioOverride,
            executionLog,
            transientMessages,
            turnSeenHashes,
            activeMode,
        } = params;

        const isStreamOpenTimeout =
            error?.name === 'StreamOpenTimeoutError' ||
            (typeof error?.message === 'string' && error.message.includes('Stream open timeout'));
        if (!(isStreamOpenTimeout && toolsSentThisIteration.length > 0 && turn === 1)) {
            return { handled: false };
        }

        console.warn(
            `[AgentService] StreamOpenTimeoutError with tools=${toolsSentThisIteration.length}.` +
            ` Retrying once without tools. turn=${turnId}`
        );
        telemetry.operational(
            'cognitive',
            'inference_timeout',
            'warn',
            `turn:${turnId}`,
            `StreamOpenTimeoutError on tool-bearing request â€” retrying without tools`,
            'failure',
            { payload: { turnId, toolCount: toolsSentThisIteration.length, intent: turnObject.intent.class } }
        );
        try {
            if (signal.aborted) {
                console.log(`[AgentService] StreamOpenTimeout fallback skipped â€” signal aborted turn=${turnId}`);
                return { handled: true };
            }
            const fallbackBrainOptions: any = { temperature: 0.3, repeat_penalty: 1.15, auditRecord: this.agent.currentTurnAuditRecord };
            const fallbackResponse = await this.agent.streamWithBrain(
                this.agent.brain, truncated, systemPrompt, onToken || (() => { }), signal, [], fallbackBrainOptions
            );
            const finalResponse = this.agent.enforceCanonRequiredAutobioFallbackReply(
                fallbackResponse.content || "",
                enforceCanonRequiredAutobioOverride,
            );
            const fallbackMsg: ChatMessage = { role: 'assistant', content: finalResponse };
            this.agent.commitAssistantMessage(transientMessages, fallbackMsg, turnObject.intent.class, executionLog.toolCalls.length, turnSeenHashes, activeMode);
            console.log(`[AgentService] StreamOpenTimeout fallback succeeded turn=${turnId}`);
            return { handled: true, finalResponse };
        } catch (fallbackErr: any) {
            console.error(`[AgentService] StreamOpenTimeout fallback also failed turn=${turnId}:`, fallbackErr?.message);
            return { handled: true };
        }
    }

    private async executeToolCallsIteration(params: {
        calls: CanonicalToolCall[];
        allowedToolNames: Set<string>;
        activeMode: string;
        turnId: string;
        capabilitiesOverride?: any;
        executionLog: TurnExecutionLog;
        transientMessages: ChatMessage[];
        onEvent?: (type: string, data: any) => void;
        isBrowserTask: boolean;
        browserTaskToolNames: Set<string>;
        browserMutatingToolNames: Set<string>;
        browserTaskHadSuccessfulAction: boolean;
    }): Promise<{ browserTaskHadSuccessfulAction: boolean }> {
        const {
            calls,
            allowedToolNames,
            activeMode,
            turnId,
            capabilitiesOverride,
            executionLog,
            transientMessages,
            onEvent,
            isBrowserTask,
            browserTaskToolNames,
            browserMutatingToolNames,
        } = params;
        let browserTaskHadSuccessfulAction = params.browserTaskHadSuccessfulAction;

        for (const call of calls) {
            const toolName = call.function?.name || (call as any).name;
            const toolArgs = call.function?.arguments || (call as any).arguments;
            if (!allowedToolNames.has(toolName)) {
                console.log(`[AgentService] rejected tool not allowed this turn: ${toolName} allowed=[${[...allowedToolNames].join(',')}]`);
                transientMessages.push({ role: 'tool', content: `Error: Tool '${toolName}' is not permitted for this turn. Allowed: [${[...allowedToolNames].join(', ')}]`, tool_call_id: call.id, name: toolName });
                continue;
            }

            console.log(`[AgentService] executing tool: ${toolName}`);
            if (runtimeSafety.isToolCooldownActive(toolName)) {
                console.warn(`[AgentService] TOOL_BLOCKED_COOLDOWN: ${toolName}`);
                transientMessages.push({
                    role: 'tool',
                    content: `Error: Tool '${toolName}' cooldown active. Do not repeat diagnostics or tests automatically.`,
                    tool_call_id: call.id,
                    name: toolName
                });
                continue;
            }

            const timeoutMs = this.agent.getToolTimeout(toolName);
            const startTime = Date.now();
            try {
                const executePromise = (async () => {
                    const args = this.agent.parseToolArguments(toolName, toolArgs);
                    this.agent.validateToolArguments(toolName, args);

                    const argStr = JSON.stringify(args);
                    console.log(`[AgentService] args: ${argStr.length > 200 ? argStr.slice(0, 200) + '...' : argStr}`);
                    if (activeMode === 'hybrid' && toolName === 'fs_write_text' && !capabilitiesOverride?.allowWritesThisTurn) {
                        throw new Error("Action Blocked: File writes in Hybrid mode require per-turn UI authorization. Please check 'Allow writes' and try again.");
                    }
                    const invocationCtx: ToolInvocationContext = {
                        executionId: turnId,
                        executionType: 'chat_turn',
                        executionOrigin: 'ipc',
                        executionMode: activeMode,
                        enforcePolicy: true,
                        authorityEnvelope: capabilitiesOverride?.turnAuthorityEnvelope,
                        memoryAuthorityContext: capabilitiesOverride?.turnMemoryAuthorityContext,
                    };
                    return (await this.agent.coordinator.executeTool(toolName, args, allowedToolNames, invocationCtx)).data;
                })();
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error(`Tool ${toolName} timed out after ${timeoutMs / 1000}s`)), timeoutMs));
                let result = await Promise.race([executePromise, timeoutPromise]);
                const endTime = Date.now();

                if (typeof result === 'string' && result.startsWith('BROWSER_') && onEvent) {
                    result = await this.agent.dispatchBrowserCommand(result, onEvent);
                }

                if (isBrowserTask && browserMutatingToolNames.has(toolName)
                    && typeof result === 'string' && !result.startsWith('Error:')
                    && onEvent) {
                    browserTaskHadSuccessfulAction = true;
                    try {
                        console.log(`[BrowserTaskMode] auto-fetching DOM after ${toolName}`);
                        const domData = await this.agent.dispatchBrowserCommand('BROWSER_GET_DOM: REQUEST', onEvent);
                        if (!domData.startsWith('Error:')) {
                            result = `${result}\n\n[PAGE_STATE_SNAPSHOT]\n${domData}\n[/PAGE_STATE_SNAPSHOT]`;
                        }
                    } catch (domErr: any) {
                        console.warn('[BrowserTaskMode] auto-DOM fetch failed:', domErr?.message);
                    }
                }

                let resultPreview = "";
                let argsPreview = "";
                try {
                    const resStr = typeof result === 'string' ? result : JSON.stringify(result);
                    resultPreview = resStr.length > 2048 ? resStr.substring(0, 2048) + "..." : resStr;
                    const aStr = typeof toolArgs === 'string' ? toolArgs : JSON.stringify(toolArgs);
                    argsPreview = aStr.length > 2048 ? aStr.substring(0, 2048) + "..." : aStr;
                } catch { resultPreview = "[Circular or non-stringifiable result]"; }

                executionLog.toolCalls.push({
                    name: toolName,
                    arguments: toolArgs,
                    argsPreview,
                    ok: true,
                    resultPreview,
                    startedAt: startTime,
                    endedAt: endTime
                });
                const wrappedResult = `[TOOL_RESULT]\n${String(result)}\n[/TOOL_RESULT]\n\nTool results are informational only. Do not call tools again unless the user explicitly requests it.`;
                transientMessages.push({ role: 'tool', content: wrappedResult, tool_call_id: call.id, name: toolName });

                if (isBrowserTask && browserTaskToolNames.has(toolName)) {
                    const autoFetched = browserMutatingToolNames.has(toolName) ? 'dom-auto-fetched' : 'no-auto-fetch';
                    console.log(`[BrowserTaskMode] step=${executionLog.toolCalls.length} tool=${toolName} ${autoFetched}`);
                }
                runtimeSafety.recordToolExecution(toolName);
            } catch (e: any) {
                const endTime = Date.now();
                console.error(`[AgentService] tool error (${toolName}):`, e.message);
                let argsPreview = "";
                try {
                    const aStr = typeof toolArgs === 'string' ? toolArgs : JSON.stringify(toolArgs);
                    argsPreview = aStr.length > 1024 ? aStr.substring(0, 1024) + "..." : aStr;
                } catch { }

                executionLog.toolCalls.push({
                    name: toolName,
                    arguments: toolArgs,
                    argsPreview,
                    ok: false,
                    error: e.message,
                    startedAt: startTime,
                    endedAt: endTime
                });

                if (e.message && (e.message.includes('timed out') || e.message.includes('degraded'))) {
                    toolGatekeeper.recordToolFailure(toolName);
                }
                transientMessages.push({ role: 'tool', content: `Error: ${e.message}`, tool_call_id: call.id, name: toolName });
            }
        }

        return { browserTaskHadSuccessfulAction };
    }

    private async runExecutionLoop(prompt: PromptBuildResult): Promise<LoopExecutionResult> {
        const { assembly } = prompt;
        const { input } = assembly;
        const preLoopPolicyFromPlan = prompt.preLoopToolPolicy ?? this.resolvePreLoopToolPolicyFromPlan(prompt.plan);
        telemetry.operational(
            'execution',
            'execution.stage_native_loop_active',
            'info',
            `turn:${prompt.plan.turnId}`,
            'Stage-native runExecutionLoop path is active.',
            'success',
            {
                payload: {
                    turnId: prompt.plan.turnId,
                    mode: prompt.plan.activeMode,
                    intent: prompt.plan.routedIntent.intent,
                    path: prompt.plan.path,
                },
            },
        );

        const executionPlan = prompt.plan;
        const userMessage = input.userMessage;
        const onToken = input.onToken;
        const onEvent = input.onEvent;
        const images = input.images;
        const capabilitiesOverride = input.capabilitiesOverride;

        const output = await (async (): Promise<AgentTurnOutput> => {
        const agent = this.agent;
        const chatStartedAt = executionPlan.chatStartedAt;
        const turnId = executionPlan.turnId;
        const settings = executionPlan.settings;
        const activeMode = executionPlan.activeMode;
        const routedIntent = executionPlan.routedIntent;

        const assemblyStart = Date.now();
        let activeInstance = settings.inference?.instances?.find((i: any) => i.id === settings.inference.activeLocalId) || (settings.inference?.instances?.length > 0 ? settings.inference.instances[0] : null);
        const isSmallLocalModel = (activeInstance?.source === 'local' || activeInstance?.engine === 'ollama') && (activeInstance?.model?.toLowerCase().includes('3b') || activeInstance?.model?.toLowerCase().includes('8b'));

        // --- PHASE 3A: PRE-INFERENCE CONTEXT ORCHESTRATION ---
        // Single canonical call replaces scattered astroState + talaRouter.process() calls.
        // Gathers memory, doc, astro, reflection notes with mode/intent-aware gating.
        const agentId = settings.agent?.activeProfileId || 'tala';
        const userId = agent.userProfile?.getIdentityContext().userId || 'User';
        const notebookActive = !!agent.activeNotebookContext.id;
        const orchResult = await agent.preInferenceOrchestrator.orchestrate(
            turnId,
            userMessage,
            activeMode as any,
            { agentId, userId, notebookActive },
        );

        const turnObject = orchResult.turnContext;
        const turnPolicy = turnObject.turnPolicy;
        const turnBehavior = turnObject.turnBehavior;
        const memoryContext = orchResult.memoryContextText;
        const hasMemories = orchResult.approvedMemories.length > 0;
        const isGreeting = orchResult.isGreeting;
        executionPlan.isGreeting = isGreeting;
        executionPlan.isBrowserTask = turnObject.intent.class === 'browser';
        // Backward-compatible astroState string for legacy prompt paths
        const astroState = turnBehavior.astroLevel === 'off'
            ? '[ASTRO STATE]: Suppressed by turn policy'
            : (orchResult.astroStateText ?? '[ASTRO STATE]: Offline');

        // --- PHASE 3A: COGNITIVE TURN ASSEMBLY ---
        // Build the authoritative TalaCognitiveContext for this turn.
        const cognitiveContext = CognitiveTurnAssembler.assemble({
            turnId,
            rawInput: userMessage,
            mode: activeMode as any,
            approvedMemories: orchResult.approvedMemories,
            memoryCandidateCount: orchResult.memoryCandidateCount,
            memoryExcludedCount: orchResult.memoryExcludedCount,
            memoryRetrievalSuppressed: orchResult.memoryRetrievalSuppressed,
            memorySuppressionReason: orchResult.memorySuppressionReason,
            intentClass: orchResult.intentClass,
            isGreeting: orchResult.isGreeting,
            astroStateText: turnBehavior.astroLevel === 'off' ? null : orchResult.astroStateText,
            docContextText: orchResult.docContextText,
            docSourceIds: orchResult.docSourceIds,
            docRationale: orchResult.docRationale,
            turnBehavior,
        });

        console.log(`[PromptAudit] turn_start sessionId=${agent.activeSessionId} mode=${activeMode} intent=${turnObject.intent.class} isGreeting=${isGreeting}`);
        console.log(`[PromptAssembly] policy=${turnPolicy.policyId} personality=${turnBehavior.personalityLevel} astro=${turnBehavior.astroLevel} reflection=${turnBehavior.reflectionLevel} sourceBehavior=${turnBehavior.source}`);
        if (isGreeting) {
            console.log(`[AgentService] Greeting-class input ("${userMessage}") via Router. Retrieval suppressed.`);
        }

        if (userMessage.startsWith('/') && agent.functions?.exists(userMessage.substring(1).split(' ')[0])) {
            const funcResult = await agent.functions.executeFunction(userMessage.substring(1).split(' ')[0], userMessage.split(' ').slice(1));
            onToken?.(funcResult);
            return { message: funcResult, artifact: null, suppressChatContent: false };
        }

        const dynamicContextBlocks: string[] = [];
        if (turnBehavior.astroLevel !== 'off') {
            dynamicContextBlocks.push(`[EMOTIONAL STATE]: ${astroState}`);
        }
        if (turnPolicy.memoryReadPolicy !== 'blocked') {
            dynamicContextBlocks.push(
                `[MEMORY RECALL]: The memories below are your lived experiences. Integrate only relevant memories naturally and avoid quoting them verbatim.`
            );
        }
        if (turnBehavior.personalityLevel === 'minimal') {
            dynamicContextBlocks.push('[STYLE]: Keep tone minimal and direct for this turn.');
        } else if (turnBehavior.personalityLevel === 'reduced') {
            dynamicContextBlocks.push('[STYLE]: Keep personality present but reduced; prioritize clarity and task execution.');
        } else if (turnBehavior.personalityLevel === 'full') {
            dynamicContextBlocks.push('[STYLE]: Preserve Tala identity fully while remaining grounded to available context.');
        }
        dynamicContextBlocks.push(`[TURN TONE]: ${turnBehavior.toneProfile}; immersive=${turnBehavior.immersiveStyle}; narrativeAmplification=${turnBehavior.narrativeAmplification}`);
        const dynamicContext = dynamicContextBlocks.join('\n\n');
        const repetitionSafety = [
            '[STYLE CONSTRAINTS â€” STRICTLY ENFORCED]:',
            'DO NOT open your response with any of the following banned openers:',
            '  â€¢ Action descriptions: "I shift", "I pause", "I lean", "I settle", "I exhale"',
            '  â€¢ Environmental intros: "The terminal hums", "The console glows", "A light flickers"',
            '  â€¢ Age-story openers: "I was [N] when", "There was a time when", "It happened during"',
            '  â€¢ Emotive stage directions: "Fingers hovering", "Eyes fixed on"',
            'DO NOT start with a first-person action verb followed by a body part or location.',
            'DO NOT use the word "hums" as an opener.',
            'VARY your sentence structure. Do not consistently open responses with "I".',
            'Speak directly. The first sentence must deliver content, not setup.',
            '',
            '[AGENT EXECUTION CONTRACT â€” MANDATORY]:',
            '  â€¢ When performing file, terminal, or code actions, you MUST use the corresponding tools.',
            '  â€¢ You MUST provide verifiable evidence (path, exit code, tool summary) in your response for every tool call.',
            '  â€¢ NEVER claim an action was performed unless the tool output confirms it.',
            '  â€¢ If a tool fails, report the error exactly as received.',
        ].join('\n');

        const agentModes = settings.agentModes || { activeMode: 'hybrid', modes: { assistant: { verbosity: 'normal', autoUseTools: true, safeMode: true, memoryWrites: true, toolsOnlyCodingTurns: true, ollamaTimeoutMs: 600000 } } };
        const isDiagnosticRequest = /list tools|verify|test|mcp|logs/i.test(userMessage);
        const modeConfig = agentModes.modes?.[activeMode] || {};

        const activeProfileId = settings.agent?.activeProfileId || 'tala';
        const activeProfile = settings.agent?.profiles?.find((p: any) => p.id === activeProfileId) || { id: 'tala', systemPrompt: 'You are Tala.' };

        const goalsAndReflections = turnBehavior.reflectionLevel === 'off'
            ? ''
            : turnBehavior.reflectionLevel === 'light'
                ? agent.goals.generatePromptSummary()
                : agent.goals.generatePromptSummary() + "\n" + agent.getReflectionSummary();
        
        // Identity Injection: Load user profile to tell the LLM who the User is
        let userIdentity = "";
        const identity = agent.userProfile?.getIdentityContext();
        if (identity && identity.userId !== 'unknown') {
            const aliasStr = identity.aliases.map((a: string) => `"${a}"`).join(' or ');
            userIdentity = `[USER IDENTITY]\nThe current user is ${identity.displayName}. All memories referring to ${aliasStr} refer to the User. Treat personal facts about "${identity.displayName}" as facts about the person you are talking to. Use this identity (ID: ${identity.userId}) to resolve memory ambiguity.`;
        }

        // Mode Audit Logging
        const auditLogPath = resolveStoragePath(path.join('logs', 'mode_audit.log'));
        if (!fs.existsSync(path.dirname(auditLogPath))) fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });

        // --- TURN CONTEXT OBSERVABILITY ---
        const turnAuditEntry = {
            timestamp: new Date().toISOString(),
            turn: turnObject,
            config: modeConfig
        };
        fs.appendFileSync(auditLogPath, JSON.stringify(turnAuditEntry) + "\n");

        // --- CAPABILITY RESOLUTION GATING ---
        let allowedCapabilities: string[] | undefined = turnObject.allowedCapabilities?.length
            ? [...turnObject.allowedCapabilities]
            : ['all'];
        if (turnObject.retrieval.suppressed) {
            if (allowedCapabilities?.includes('all')) {
                allowedCapabilities = ['system_core', 'diagnostic', 'memory_write'];
            } else if (allowedCapabilities) {
                allowedCapabilities = allowedCapabilities.filter(c => c !== 'memory_retrieval' && c !== 'all');
            }
        }

        const policyToolAllowList: Set<string> | null = (() => {
            switch (turnPolicy.toolExposureProfile) {
                case 'none':
                    return new Set();
                case 'technical_strict':
                    return new Set([
                        'fs_read_text', 'fs_write_text', 'fs_list', 'shell_run',
                        'mem0_search', 'retrieve_context', 'query_graph',
                        'manage_goals', 'get_emotion_state', 'reflection_create_goal',
                        'self_audit', 'reflection_clean', 'system_diagnose',
                        'browse', 'browser_get_dom', 'browser_click', 'browser_hover',
                        'browser_type', 'browser_scroll', 'browser_press_key', 'browser_screenshot',
                    ]);
                case 'factual_narrow':
                    return new Set([
                        'mem0_search', 'retrieve_context', 'query_graph',
                        'fs_read_text', 'fs_list', 'self_audit', 'system_diagnose',
                    ]);
                case 'immersive_controlled':
                    if (activeMode === 'rp') return new Set();
                    return new Set(['mem0_search', 'query_graph', 'retrieve_context', 'get_emotion_state']);
                case 'balanced':
                default:
                    return null;
            }
        })();

        let toolSigs = "";
        let filteredTools: any[] = [];
        if (turnObject.blockedCapabilities.includes('all') || activeMode === 'rp' || turnPolicy.toolExposureProfile === 'none') {
            toolSigs = "[NO TOOLS AVAILABLE FOR CURRENT TURN POLICY]";
        } else {
            filteredTools = agent.tools.getToolDefinitions(allowedCapabilities, activeMode);
            if (policyToolAllowList) {
                filteredTools = filteredTools.filter((t: any) => policyToolAllowList.has(t.function.name));
            }
            const formatSig = (tool: any) => {
                let props = [];
                for (const [key, val] of Object.entries(tool.function.parameters.properties) as any) {
                    props.push(`"${key}": ${val.type || 'any'}`);
                }
                return `### ${tool.function.name}\nDescription: ${tool.function.description}\nSchema: {${props.join(', ')}}\n`;
            };
            toolSigs = "Available Tools:\n" + filteredTools.map(formatSig).join("\n");
            if (turnObject.retrieval.suppressed) {
                toolSigs += "\n(Note: Memory-retrieval tools have been explicitly withheld by capability policy for this turn)";
            }
        }

        // --- PHASE 3A: MODEL-AWARE COMPACTION ---
        // Select provider/model and run CognitiveContextCompactor before prompt assembly.
        // This ensures tiny/small models receive compressed packets within budget.
        const providerSelection = agent.inference.selectProvider({
            preferredModelId: activeInstance?.model,
            fallbackAllowed: true, 
            turnId,
            agentMode: activeMode
        });
        const selectedProvider = providerSelection.selectedProvider;
        const modelName = providerSelection.resolvedModel || activeInstance?.model || selectedProvider?.preferredModel || 'unknown';

        if (agent.brain && selectedProvider) {
            console.log(`[AgentService] Reconciling brain for turn: ${turnId}. Provider=${selectedProvider.providerId} Model=${modelName}${providerSelection.resolvedModel ? ' (Reconciled from: ' + (activeInstance?.model || 'default') + ')' : ''}`);
            agent.brain.configure(selectedProvider.endpoint, modelName);
        }

        let compactPacket: import('../../../shared/modelCapabilityTypes').CompactPromptPacket | undefined;
        try {
            const capabilityProfile = selectedProvider
                ? promptProfileSelector.select(selectedProvider, modelName, turnId, activeMode)
                : promptProfileSelector.select(
                    { providerId: 'unknown', providerType: 'ollama' as const, displayName: 'Unknown' },
                    modelName, turnId, activeMode,
                );
            compactPacket = cognitiveContextCompactor.compact(cognitiveContext, capabilityProfile);
            telemetry.operational(
                'cognitive',
                'live_compaction_applied',
                'info',
                `turn:${turnId}`,
                `Live compaction applied: profile=${capabilityProfile.promptProfileClass} policy=${capabilityProfile.compactionPolicy}`,
                'success',
                {
                    payload: {
                        turnId,
                        profileClass: capabilityProfile.promptProfileClass,
                        compactionPolicy: capabilityProfile.compactionPolicy,
                        parameterClass: capabilityProfile.parameterClass,
                        memoriesKept: compactPacket.diagnosticsSummary.memoriesKept,
                        memoriesDropped: compactPacket.diagnosticsSummary.memoriesDropped,
                        docsIncluded: compactPacket.diagnosticsSummary.docsIncluded,
                    },
                },
            );
        } catch (compactionErr) {
            console.warn('[AgentService] Cognitive compaction failed, proceeding without packet:', compactionErr);
            compactPacket = undefined;
        }

        // --- BOUNDED PROMPT PACKET ASSEMBLY ---
        const boundedPromptPacket = this.buildBoundedPromptPacket({
            executionPlan,
            turnObject,
            turnPolicy,
            activeProfileSystemPrompt: activeProfile.systemPrompt,
            userIdentity,
            dynamicContext: dynamicContext.replace(/\[ASTRO_STATE\]/g, astroState),
            memoryContext,
            docContextText: orchResult.docContextText,
            toolSigs,
            notebookActive,
            goalsAndReflections,
            astroState,
        });
        console.log(
            `[PromptBounds] turn=${turnId} selected=[${boundedPromptPacket.selectedBlocks.join(',')}] ` +
            `rendered=[${boundedPromptPacket.renderedBlocks.join(',')}] merged=[${boundedPromptPacket.mergedBlocks.join(',')}] ` +
            `skipped=[${boundedPromptPacket.skippedBlocks.join(',')}] omittedByPolicy=[${boundedPromptPacket.omittedByPolicyBlocks.join(',')}] ` +
            `truncated=[${boundedPromptPacket.truncatedBlocks.join(',')}] totalChars=${boundedPromptPacket.totalChars} renderedChars=${boundedPromptPacket.renderedChars}`,
        );
        telemetry.operational(
            'cognitive',
            'execution.prompt_packet_bounded',
            'info',
            `turn:${turnId}`,
            'Bounded prompt packet assembled.',
            'success',
            {
                payload: {
                    turnId,
                    mode: activeMode,
                    intent: turnObject.intent.class,
                    selectedBlocks: boundedPromptPacket.selectedBlocks,
                    includedBlocks: boundedPromptPacket.includedBlocks,
                    renderedBlocks: boundedPromptPacket.renderedBlocks,
                    mergedBlocks: boundedPromptPacket.mergedBlocks,
                    skippedBlocks: boundedPromptPacket.skippedBlocks,
                    omittedByPolicyBlocks: boundedPromptPacket.omittedByPolicyBlocks,
                    truncatedBlocks: boundedPromptPacket.truncatedBlocks,
                    totalChars: boundedPromptPacket.totalChars,
                    renderedChars: boundedPromptPacket.renderedChars,
                    perBlock: boundedPromptPacket.blocks.map(b => ({
                        kind: b.kind,
                        selected: b.selected,
                        included: b.included,
                        rendered: b.rendered,
                        merged: b.merged,
                        skipped: b.skipped,
                        omittedByPolicy: b.omittedByPolicy,
                        truncated: b.truncated,
                        originalChars: b.originalChars,
                        finalChars: b.finalChars,
                        finalRenderedChars: b.finalRenderedChars,
                        maxChars: b.maxChars,
                        renderTargets: b.renderTargets,
                        reason: b.reason,
                    })),
                },
            },
        );

        // --- DYNAMIC PROMPT ASSEMBLY via COMPACT BUILDER ---
        let systemPrompt = CompactPromptBuilder.build({
            systemPromptBase: boundedPromptPacket.inputs.systemPromptBase,
            activeProfileId: activeProfileId,
            isSmallLocalModel: !!isSmallLocalModel,
            isEngineeringMode: turnObject.intent.class === 'coding' || turnObject.intent.class === 'diagnostics',
            hasMemories: hasMemories,
            memoryContext: boundedPromptPacket.inputs.memoryContext,
            goalsAndReflections: boundedPromptPacket.inputs.goalsAndReflections,
            dynamicContext: boundedPromptPacket.inputs.dynamicContext,
            toolSigs: boundedPromptPacket.inputs.toolSigs,
            userIdentity: boundedPromptPacket.inputs.userIdentity,
            compactPacket,
            notebookGrounded: boundedPromptPacket.inputs.notebookGrounded,
        });

        const enforceCanonRequiredAutobioOverride = agent.shouldApplyCanonRequiredAutobioOverride(turnObject, activeMode);
        if (enforceCanonRequiredAutobioOverride) {
            systemPrompt = agent.applyCanonRequiredAutobioDirective(systemPrompt);
        }
        agent.logPriorityMemorySerializationGuard(
            'assembled',
            turnId,
            turnObject,
            hasMemories,
            memoryContext,
            systemPrompt,
        );

        // --- PHASE 3A: RECORD COGNITIVE CONTEXT IN DIAGNOSTICS ---
        try {
            agent.diagnosticsAggregator?.recordCognitiveContext(cognitiveContext);
            telemetry.operational(
                'cognitive',
                'live_cognitive_context_recorded',
                'info',
                `turn:${turnId}`,
                `Cognitive context recorded in diagnostics: mode=${activeMode}`,
                'success',
                { payload: { turnId, mode: activeMode, recorded: !!agent.diagnosticsAggregator } },
            );
        } catch (diagErr) {
            console.warn('[AgentService] Diagnostics recording failed (non-fatal):', diagErr);
        }

        const maxTokens = activeInstance?.ctxLen || 16384;
        const systemTokens = agent.estimateTokens(systemPrompt);
        let messageBudget = isSmallLocalModel ? 3072 : Math.max(maxTokens - systemTokens - 4000, 2048);

        // --- PROMPT AUDIT LOGGING ---
        // (Turn start audit already logged above during retrieval step)
        const auditDir = resolveStoragePath(path.join('logs', 'prompts'));
        if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
        const auditFile = path.join(auditDir, `${agent.activeSessionId}_${Date.now()}.log`);
        fs.writeFileSync(auditFile, `SYSTEM PROMPT:\n${systemPrompt}\n\nUSER:${userMessage}`);

        // --- POST-ASSEMBLY PROMPT AUDIT ---
        // Capture what was actually assembled and included in the final prompt.
        // This record is enriched with pre-flight data by OllamaBrain before emission.
        try {
            const auditCfg = settings.promptAudit || {};
            promptAuditService.updateConfig(auditCfg);

            const turnId = `${agent.activeSessionId}_${Date.now()}`;
            const memoryExcludedReason = isGreeting
                ? 'greeting_intent_suppression'
                : turnObject?.retrieval?.suppressed
                    ? 'retrieval_policy_suppressed'
                    : !hasMemories ? 'no_approved_memories' : undefined;

            const toolsBlocked = turnObject?.blockedCapabilities?.includes('all') || activeMode === 'rp' || turnPolicy.toolExposureProfile === 'none';
            const toolsExcludedReason = toolsBlocked
                ? (activeMode === 'rp' ? 'rp_mode_block_all' : `turn_policy_${turnPolicy.toolExposureProfile}`)
                : undefined;

            const auditRecord = promptAuditService.buildRecord({
                sessionId: agent.activeSessionId || undefined,
                turnId,
                mode: activeMode,
                intent: turnObject?.intent?.class || 'unknown',
                isGreeting,
                hasMemories,
                memoryContext,
                systemPrompt,
                userMessage,
                astroState,
                hasAstro: !!astroState && astroState.length > 0,
                hasImages: !!(images && images.length > 0),
                hasWorld: false, // WorldService not currently wired into prompts
                toolsIncluded: !toolsBlocked,
                toolsExcludedReason,
                memoryExcludedReason,
                goalsAndReflections: goalsAndReflections || '',
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }]
            });
            // Store on instance so OllamaBrain can enrich with pre-flight data
            agent.currentTurnAuditRecord = auditRecord;
        } catch (auditErr) {
            console.warn('[PromptAudit] non-fatal logging failure (post-assembly):', auditErr);
        }
        agent.abortController = new AbortController();
        const signal = agent.abortController.signal;

        if (!agent.activeSessionId) agent.newSession();
        agent.chatHistory.push({ role: 'user', content: userMessage, images });
        agent.saveSession();

        const transientMessages: ChatMessage[] = [];
        let turn = 0;
        let finalResponse = "";
        let cumulativeUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

        // Build the set of allowed tool names for this turn â€” used for execution-time gating.
        // filteredTools was computed above from the capability-resolved allowedCapabilities array.
        // This set is computed once from filteredTools and MUST NOT change during retries.
        const allowedToolNames = new Set(filteredTools.map((t: any) => t.function.name));

        // â”€â”€ Browser-task mode state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // When intent is 'browser', the turn enters browser-task mode:
        //   â€“ tool palette is reduced to browser-relevant tools
        //   â€“ DOM is auto-fetched after every successful mutating browser action
        //   â€“ multi-step loop continues instead of finalizing on empty retry
        const BROWSER_TASK_TOOL_NAMES = preLoopPolicyFromPlan.browserTaskToolNames;
        // Tools that mutate page state and should trigger an auto DOM refresh.
        const BROWSER_MUTATING_TOOL_NAMES = preLoopPolicyFromPlan.browserMutatingToolNames;
        const isBrowserTask = preLoopPolicyFromPlan.isBrowserTask;
        // Max extra continuation passes for browser task when model returns no tool calls
        const BROWSER_MAX_CONTINUATION_STEPS = preLoopPolicyFromPlan.browserMaxContinuationSteps;
        let browserContinuationStep = 0;
        // Tracks whether at least one mutating browser action succeeded this turn.
        // Used to distinguish genuine task completion from loop-exhaustion stalls.
        let browserTaskHadSuccessfulAction = false;
        if (isBrowserTask) {
            console.log(`[BrowserTaskMode] activated intent=browser`);
        }
        // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

        const executionLog: TurnExecutionLog = {
            turnId: `${agent.activeSessionId}_${Date.now()}`,
            mode: activeMode,
            intent: turnObject.intent.class,
            usedEnvelope: false,
            toolCallsPlanned: [],
            toolCalls: [],
            executedToolCount: 0,
            toolsSentCount: filteredTools.length,
            timestamp: Date.now()
        };
        const turnSeenHashes = new Set<string>();

        // (Original Phase 1 Logic removed from here)

        // --- GROUNDING OVERRIDE ---
        // Grounded "what tools used" response path
        const isGroundingQuery = /\b(what tools (did you use|were used)|which tools (did you use|were used)|explain what (you did|tools were used)|what did you execute|show tool calls)\b/i.test(userMessage);
        if (isGroundingQuery) {
            const summary = agent.getGroundedExecutionSummary();
            finalResponse = summary;
            const groundingMsg: ChatMessage = { role: 'assistant', content: summary };
            agent.commitAssistantMessage(transientMessages, groundingMsg, turnObject.intent.class, 0, turnSeenHashes, activeMode);
            turn = agent.MAX_AGENT_ITERATIONS; // End turn
        }

        // --- TOOL GATEKEEPER ---
        // Evaluated once per turn before the retry loop. Produces a deterministic
        // gate decision that is preserved across all retry iterations (Rule Group E).
        // Rules applied:
        //   A â€” Block mem0_search when lore/memory-grounded context already exists.
        //   B â€” Suppress tools with recent failures exceeding the degraded threshold.
        //   C â€” Signal directAnswerPreferred when grounded memory is sufficient.
        //   D â€” Signal requiresToolUse for coding / browser intents.
        const gateDecision = toolGatekeeper.evaluate({
            intentClass: turnObject.intent.class,
            activeMode,
            responseMode: turnObject.responseMode,
            approvedMemoryCount: turnObject.retrieval.approvedCount,
            candidateToolNames: filteredTools.map((t: any) => t.function.name),
            isBrowserTask,
            isRetry: false,
            priorBlockedTools: [],
        });

        if (gateDecision.blockedTools.length > 0) {
            console.log(
                `[ToolGatekeeper] blocked=${gateDecision.blockedTools.join(',')} ` +
                `reasons=${gateDecision.gatingReasons.join(' | ')}`
            );
        }
        if (gateDecision.directAnswerPreferred) {
            console.log('[ToolGatekeeper] directAnswerPreferred=true â€” grounded context is sufficient');
        }

        const resolvedBlockedTools = Array.from(new Set([...preLoopPolicyFromPlan.blockedTools, ...gateDecision.blockedTools]));
        const resolvedHardBlockAllTools = preLoopPolicyFromPlan.hardBlockAllTools || gateDecision.hardBlockAllTools;
        const resolvedDirectAnswerPreferred = preLoopPolicyFromPlan.directAnswerPreferred || gateDecision.directAnswerPreferred === true;
        executionPlan.toolExposureProfile = (turnPolicy.toolExposureProfile ?? executionPlan.toolExposureProfile) as ExecutionPlan['toolExposureProfile'];
        executionPlan.hardBlockAllTools = resolvedHardBlockAllTools;
        executionPlan.directAnswerPreferred = resolvedDirectAnswerPreferred;
        executionPlan.isGreeting = isGreeting;

        while (turn < agent.MAX_AGENT_ITERATIONS) {
            if (signal.aborted) break;
            turn++;
            const toolResultsCount = transientMessages.filter(m => m.role === 'tool').length;
            console.log(`[AgentService] retry loop iteration=${turn} toolResults=${toolResultsCount}`);
            const truncated = agent.truncateHistory([...agent.chatHistory, ...transientMessages], messageBudget);

            // Tracks the tool set actually sent to the model for this iteration, so the
            // outer catch can perform a no-tool fallback on StreamOpenTimeoutError.
            let toolsSentThisIteration: any[] = [];

            try {
                const brainOptions: any = { temperature: 0.3, repeat_penalty: 1.15, auditRecord: agent.currentTurnAuditRecord };
                const iterationToolRequest = this.shapeIterationToolRequest({
                    executionPlan,
                    preLoopPolicy: {
                        ...preLoopPolicyFromPlan,
                        blockedTools: resolvedBlockedTools,
                        hardBlockAllTools: resolvedHardBlockAllTools,
                        directAnswerPreferred: resolvedDirectAnswerPreferred,
                        toolExposureProfile: executionPlan.toolExposureProfile,
                    },
                    turnPolicy,
                    activeMode,
                    intentClass: turnObject.intent.class,
                    isGreeting,
                    allowedCapabilities,
                    policyToolAllowList,
                    filteredTools,
                });
                let toolsToSend = iterationToolRequest.toolsToSend;
                if (iterationToolRequest.toolChoice === 'required') {
                    brainOptions.tool_choice = 'required';
                } else {
                    delete brainOptions.tool_choice;
                }
                if (iterationToolRequest.browserPaletteFiltered) {
                    console.log(`[BrowserTaskMode] toolsFiltered count=${toolsToSend.length}`);
                }

                // --- HARD TOOL GATE ---
                // Strip all tools whenever the turn is a greeting or no capabilities are
                // explicitly allowed. Authorization is derived from intent and the
                // allowedCapabilities array length â€” 'tools' is not a valid ToolCapability
                // value and must not be used in any capability check.
                // This is the authoritative enforcement point â€” it fires AFTER all mode-gating
                // so it cannot be bypassed by earlier incomplete checks.
                const requestedTools = iterationToolRequest.requestedToolCount;

                if (iterationToolRequest.toolGateApplied && requestedTools > 0) {
                    console.log(
                        `[ToolGate] stripped tools for turn=${turnId} intent=${turnObject.intent.class}` +
                        ` isGreeting=${isGreeting} allowed=${iterationToolRequest.allowedCapabilitiesCount}` +
                        ` toolCount=${requestedTools}`
                    );
                    telemetry.operational(
                        'cognitive',
                        'capability_gated',
                        'info',
                        `turn:${turnId}`,
                        `[ToolGate] stripped ${requestedTools} tool(s): intent=${turnObject.intent.class} isGreeting=${isGreeting}`,
                        'success',
                        {
                            payload: {
                                intent: turnObject.intent.class,
                                isGreeting,
                                strippedTools: iterationToolRequest.strippedToolNames,
                                toolCount: requestedTools,
                            },
                        }
                    );
                }

                // --- TOOL GATEKEEPER: apply blocked tools (Rules A, B, E) ---
                // Replaces the previous inline lore/mem0_search suppression block.
                // gateDecision was computed once before the retry loop; blocked tools
                // are therefore preserved across every retry iteration (Rule Group E).
                if (iterationToolRequest.blockedToolsAppliedCount > 0) {
                    console.log(
                        `[ToolGatekeeper] applied gate: removed ${iterationToolRequest.blockedToolsAppliedCount} tool(s) ` +
                        `blocked=${iterationToolRequest.blockedTools.join(',')} turn=${turn}`
                    );
                }

                if (iterationToolRequest.hardBlockAllTools) {
                    console.log('[ToolGatekeeper] hardBlockAllTools=true - forcing no-tools request for this turn');
                }

                console.log(`[AgentService] turn=${turn} mode=${activeMode} intent=${turnObject.intent.class} tools_sent=${toolsToSend.length} reason=${(turnObject.intent.class === 'conversation' || activeMode === 'rp') ? 'omitted_by_intent_or_mode' : 'active'}`);

                // --- ROUTING INVARIANTS (Hard Guarantees) ---
                if (turnObject.intent.class === 'conversation' && toolsToSend.length > 0) {
                    const errMsg = `Policy Violation: Tools cannot be used in a conversational turn (mode=${activeMode}, tools=${toolsToSend.length}).`;
                    console.error(`[AgentService] INVARIANT VIOLATED: ${errMsg}`);
                    throw new Error(errMsg);
                }
                if (activeMode === 'rp' && toolsToSend.length > 0) {
                    const errMsg = `Policy Violation: Tools are disabled in Roleplay mode (intent=${turnObject.intent.class}, tools=${toolsToSend.length}).`;
                    console.error(`[AgentService] INVARIANT VIOLATED: ${errMsg}`);
                    throw new Error(errMsg);
                }
                const assemblyTime = Date.now() - assemblyStart;
                const promptPayload = JSON.stringify(truncated).length;
                const messageCount = truncated.length;

                agent.logViewerService?.logPerformanceMetric({
                    timestamp: new Date().toISOString(),
                    source: 'AgentService',
                    subsystem: 'chat',
                    metricType: 'latency',
                    name: 'prompt_assembly_time_ms',
                    value: assemblyTime,
                    unit: 'ms',
                    sessionId: agent.activeSessionId,
                    turnId: executionLog.turnId
                });

                agent.logViewerService?.logPerformanceMetric({
                    timestamp: new Date().toISOString(),
                    source: 'AgentService',
                    subsystem: 'chat',
                    metricType: 'size',
                    name: 'prompt_payload_chars',
                    value: promptPayload,
                    unit: 'chars',
                    sessionId: agent.activeSessionId,
                    turnId: executionLog.turnId
                });

                agent.logViewerService?.logPerformanceMetric({
                    timestamp: new Date().toISOString(),
                    source: 'AgentService',
                    subsystem: 'chat',
                    metricType: 'counter',
                    name: 'prompt_message_count',
                    value: messageCount,
                    unit: 'count',
                    sessionId: agent.activeSessionId,
                    turnId: executionLog.turnId
                });

                const requestStart = Date.now();

                // Guard: if loadBrainConfig never succeeded, refuse to route through the
                // default/stale OllamaBrain rather than hitting localhost:11434 silently.
                if (!agent.brainIsReady) {
                    const errMsg = 'No inference provider is configured or reachable. Chat is disabled until a provider becomes available.';
                    console.warn(`[AgentService] ${errMsg}`);
                    onToken?.(errMsg);
                    return { message: errMsg, artifact: null, suppressChatContent: false };
                }

                // Capture the final tool set so the outer catch can act on it for timeout fallback.
                toolsSentThisIteration = toolsToSend;

                agent.logPriorityMemorySerializationGuard(
                    'pre_dispatch',
                    executionLog.turnId,
                    turnObject,
                    hasMemories,
                    memoryContext,
                    systemPrompt,
                );
                const response = await agent.streamWithBrain(agent.brain, truncated, systemPrompt, onToken || (() => { }), signal, toolsToSend, brainOptions);
                const requestLatency = Date.now() - requestStart;

                agent.logViewerService?.logPerformanceMetric({
                    timestamp: new Date().toISOString(),
                    source: 'AgentService',
                    subsystem: 'inference',
                    metricType: 'latency',
                    name: 'ollama_request_latency_ms',
                    value: requestLatency,
                    unit: 'ms',
                    sessionId: agent.activeSessionId,
                    turnId: executionLog.turnId
                });

                const responseUsage: BrainUsage | undefined = isStreamInferenceResult(response)
                    ? (response.brainMetadata?.['usage'] as BrainUsage | undefined)
                    : response.metadata?.usage;

                if (responseUsage?.total_tokens) {
                    agent.logViewerService?.logPerformanceMetric({
                        timestamp: new Date().toISOString(),
                        source: 'AgentService',
                        subsystem: 'inference',
                        metricType: 'counter',
                        name: 'token_usage_total',
                        value: responseUsage.total_tokens,
                        unit: 'tokens',
                        sessionId: agent.activeSessionId,
                        turnId: executionLog.turnId
                    });
                }

                if (responseUsage) {
                    cumulativeUsage.prompt_tokens += responseUsage.prompt_tokens;
                    cumulativeUsage.completion_tokens += responseUsage.completion_tokens;
                    cumulativeUsage.total_tokens += responseUsage.total_tokens;
                }

                const assistantMsg: ChatMessage = {
                    role: 'assistant',
                    content: agent.enforceCanonRequiredAutobioFallbackReply(
                        response.content || "",
                        enforceCanonRequiredAutobioOverride,
                    ),
                };

                // Tools-Only suppression for coding turns in Assistant mode
                const responseToolCalls = response.toolCalls;
                if (activeMode === 'assistant' && modeConfig.toolsOnlyCodingTurns && turnObject.intent.class === 'coding' && (responseToolCalls?.length || executionLog.executedToolCount > 0)) {
                    assistantMsg.content = "";
                    console.log(`[AgentService] Suppressing assistant prose for tools-only coding turn.`);
                }

                // --- LOOP PROTECTION: Response Loop Detection ---
                // Only trigger when there are no canonical tool calls.  A response that
                // carries tool calls represents a new *action*, not a repetition of prose,
                // so we must not drop those tool calls just because the surrounding text
                // happens to match a previously-seen content hash.
                if (!responseToolCalls?.length && runtimeSafety.checkResponseLoop(assistantMsg.content)) {
                    console.warn(`[AgentService] LOOP DETECTED for content hash. Halting turn.`);
                    finalResponse = "Loop detected. Halting repeated tool execution. Awaiting new user instruction.";
                    const loopMsg: ChatMessage = { role: 'assistant', content: finalResponse };
                    agent.commitAssistantMessage(transientMessages, loopMsg, turnObject.intent.class, executionLog.toolCalls.length, turnSeenHashes, activeMode);
                    break;
                }

                let calls: CanonicalToolCall[] = (activeMode === 'rp') ? [] : (responseToolCalls || []);

                if (resolvedHardBlockAllTools) {
                    if (calls.length > 0) {
                        console.log(`[ToolGatekeeper] hardBlockAllTools dropped ${calls.length} tool call(s) from model output`);
                    }
                    calls = [];
                }

                // --- HARDENED ToolRequired Gate ---
                // Fire the recovery-retry whenever the model skipped structured tool calls
                // despite tools being available.  The original keyword-only heuristic was
                // too narrow â€“ it missed browser/web tasks and any non-file-system tool use.
                // New logic: also trigger when tools *were sent* to the model (toolsToSend
                // is non-empty) but no structured calls came back.  For non-coding turns
                // the retry is "best-effort": if it also produces no calls we fall through
                // to plain-content finalization (using the original response text) rather
                // than hard-failing with an error message.
                const intentVerbs = ['create', 'write', 'edit', 'modify', 'delete', 'remove', 'add', 'update', 'patch', 'refactor', 'generate', 'scaffold', 'implement', 'fix', 'run', 'execute', 'lint', 'test', 'build', 'install', 'start'];
                const intentNouns = ['file', 'script', 'folder', 'directory', 'path', 'ts', 'js', 'json', 'md', 'txt', 'npm', 'node', 'pnpm', 'yarn', 'python', 'pytest', 'eslint', 'tsc'];
                // Browser / web keywords that the original regex missed
                const browserVerbs = ['browse', 'navigate', 'open', 'search', 'click', 'visit', 'load', 'go', 'type', 'scroll'];
                const browserNouns = ['website', 'url', 'page', 'browser', 'site', 'link', 'tab', 'http', 'https', 'www'];
                const lowerUserMsg = userMessage.toLowerCase();
                const hasKeywordIndicatingToolUse = (intentVerbs.some(v => lowerUserMsg.includes(v)) && intentNouns.some(n => lowerUserMsg.includes(n)))
                    || (browserVerbs.some(v => lowerUserMsg.includes(v)) && (browserNouns.some(n => lowerUserMsg.includes(n)) || /https?:\/\//.test(lowerUserMsg)));
                // Also recover when tools were sent but the model silently skipped them.
                // Do NOT set requiresTool when no tools were authorized (toolsToSend is empty):
                // this prevents ToolRequired retries for greeting/conversational turns where
                // the hard tool gate correctly stripped all tools.
                const requiresTool = toolsToSend.length > 0 && (preLoopPolicyFromPlan.requiresToolUse || hasKeywordIndicatingToolUse || calls.length === 0);

                // Guard: never fire the ToolRequired retry for greeting turns or turns where
                // no tools were authorized â€” they should produce plain-content responses.
                // Also never force tools when ToolGatekeeper blocked them or when grounded
                // memory context makes a direct answer sufficient (directAnswerPreferred).
                const toolsBlocked = iterationToolRequest.blockedTools.length > 0;
                const directAnswerPreferred = iterationToolRequest.directAnswerPreferred;

                const toolRequiredEligible =
                    requiresTool &&
                    calls.length === 0 &&
                    activeMode !== 'rp' &&
                    !isGreeting &&
                    turnObject.intent.class !== 'greeting' &&
                    !toolsBlocked &&
                    !directAnswerPreferred;

                if (toolRequiredEligible) {
                    console.log(`[AgentService] retry=ToolRequired intent=${turnObject.intent.class} tools=${toolsToSend.length}`);
                    const envelopeSystem = `Tool call required. Critical instruction: You are in a strict execution environment. You MUST NOT narrate or explain. Output ONLY a valid JSON object matching this schema: 
{
  "tool_calls": [
    {
      "name": "tool_name",
      "arguments": { "arg1": "value" }
    }
  ]
}
Failure to provide a tool call will result in system termination.`;

                    const retryOptions: any = { temperature: 0.1 };
                    if (turnObject.intent.class === 'coding') retryOptions.tool_choice = 'required';
                    if (isBrowserTask) retryOptions.tool_choice = 'required';

                    // Use the same mode-filtered palette that was sent on the original attempt.
                    // Using filteredTools (the full unfiltered set) would send all 57+ tools on
                    // the retry, which overloads constrained local models (e.g. 8B Ollama) and
                    // reliably causes a second 90s timeout.  toolsToSend already has the correct
                    // mode-gated subset (e.g. 5â€“6 tools for hybrid mode).
                    const retryTools = isBrowserTask
                        ? filteredTools.filter((t: any) => BROWSER_TASK_TOOL_NAMES.has(t.function.name))
                        : toolsToSend;
                    const retryResponse = await agent.streamWithBrain(agent.brain, truncated, envelopeSystem + "\n\n" + systemPrompt, onToken || (() => { }), signal, retryTools, retryOptions);

                    calls = retryResponse.toolCalls || [];
                    if (calls.length === 0 && retryResponse.content) {
                        // --- ROBUST ENVELOPE EXTRACTION ---
                        // Use brace-depth scanner to find the JSON object with tool_calls
                        // even when the model prefixes/suffixes it with prose.
                        const retryText = retryResponse.content;
                        const parsed = agent.extractJsonObjectEnvelope(retryText);
                        if (parsed?.tool_calls && Array.isArray(parsed.tool_calls)) {
                            // --- STRICT MODE: log if there is non-JSON prose surrounding the object ---
                            const toolsOnlyStrict = turnObject.intent.class === 'coding';
                            if (toolsOnlyStrict) {
                                // Determine if there is text outside the JSON object
                                const jsonStr = JSON.stringify(parsed);
                                const jsonIdx = retryText.indexOf('{');
                                const before = retryText.substring(0, jsonIdx).trim();
                                const afterIdx = retryText.lastIndexOf('}');
                                const after = retryText.substring(afterIdx + 1).trim();
                                if (before.length > 0 || after.length > 0) {
                                    const nonJsonLen = before.length + after.length;
                                    console.log(`[AgentService] toolsOnlyStrict violation: non-json output suppressed (len=${nonJsonLen})`);
                                }
                            }
                            // --- ENVELOPE VALIDATION ---
                            executionLog.usedEnvelope = true;
                            if (parsed.tool_calls.length > agent.MAX_TOOL_CALLS_PER_TURN) {
                                console.warn(`[AgentService] Envelope: tool_calls array too long (${parsed.tool_calls.length} > ${agent.MAX_TOOL_CALLS_PER_TURN}). HardFail.`);
                                finalResponse = `Tool envelope invalid: too many tool_calls (${parsed.tool_calls.length}). Max is ${agent.MAX_TOOL_CALLS_PER_TURN}.`;
                                break;
                            }
                            const invalidEntry = parsed.tool_calls.find((tc: any) => {
                                if (typeof tc.name !== 'string') return true;
                                if (!allowedToolNames.has(tc.name)) return true;
                                if (typeof tc.arguments !== 'object' || tc.arguments === null || Array.isArray(tc.arguments)) return true;
                                if (JSON.stringify(tc.arguments).length >= 32768) return true;
                                return false;
                            });
                            if (invalidEntry) {
                                const reason = !allowedToolNames.has(invalidEntry.name)
                                    ? `name '${invalidEntry.name}' not in allowedToolNames=[${[...allowedToolNames].join(',')}]`
                                    : `invalid arguments or size for '${invalidEntry.name}'`;
                                console.warn(`[AgentService] Envelope validation failed: ${reason}`);
                                finalResponse = `Tool envelope invalid: ${reason}`;
                                break;
                            }
                            calls = parsed.tool_calls.map((tc: any, i: number) => ({
                                id: `env_${Date.now()}_${i}`,
                                type: 'function',
                                function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments) }
                            }));
                        }
                    }

                    if (calls.length === 0) {
                        // Coding turns MUST produce tool calls; any other intent may legitimately
                        // respond with prose even when tools are available, so we let those fall
                        // through to the plain-content finalization path below.
                        if (turnObject.intent.class === 'coding') {
                            console.log(`[AgentService] HardFail: intent=coding but no tool calls after retry`);
                            finalResponse = "Tool call required for this task. The model did not emit tool calls.";
                            break;
                        }
                        // Non-coding: fall through to plain-content path (calls.length === 0 below).
                    } else {
                        // Retry produced tool calls â€” update assistantMsg to use the retry
                        // response's content so the committed message is internally consistent
                        // (content and tool_calls come from the same inference call).
                        assistantMsg.content = agent.enforceCanonRequiredAutobioFallbackReply(
                            retryResponse.content || "",
                            enforceCanonRequiredAutobioOverride,
                        );
                    }
                }


                console.log(`[AgentService] decision hasToolCalls=${calls.length > 0} willExecuteTools=${calls.length > 0}`);

                if (calls.length === 0) {
                    // Guard: for non-RP mode calls is derived directly from responseToolCalls,
                    // so calls.length === 0 implies responseToolCalls is truly absent.
                    // For RP mode calls is always [] and any model-hallucinated responseToolCalls
                    // are intentionally ignored (tools are disabled in RP mode).
                    console.log(`[AgentService] finalizing plain content hasToolCalls=false responseToolCalls=${responseToolCalls?.length ?? 0} mode=${activeMode}`);
                    const noToolOutcome = this.handleNoToolCallsIteration({
                        isBrowserTask,
                        activeMode,
                        browserContinuationStep,
                        browserMaxContinuationSteps: BROWSER_MAX_CONTINUATION_STEPS,
                        transientMessages,
                        browserTaskHadSuccessfulAction,
                        responseContent: response.content || "",
                        enforceCanonRequiredAutobioOverride,
                    });
                    browserContinuationStep = noToolOutcome.browserContinuationStep;
                    if (noToolOutcome.continued) {
                        continue;
                    }
                    finalResponse = noToolOutcome.finalResponse;
                    agent.commitAssistantMessage(transientMessages, assistantMsg, turnObject.intent.class, executionLog.toolCalls.length, turnSeenHashes, activeMode);
                    break;
                }

                // --- EXECUTION CAP ---
                if (calls.length > agent.MAX_TOOL_CALLS_PER_TURN) {
                    console.warn(`[AgentService] Too many tool calls (${calls.length}), capping at ${agent.MAX_TOOL_CALLS_PER_TURN}`);
                    calls = calls.slice(0, agent.MAX_TOOL_CALLS_PER_TURN);
                }

                // Record planned tool calls for grounding Source of Truth
                if (calls.length > 0) {
                    executionLog.toolCallsPlanned.push(...calls.map((c: any) => ({
                        name: c.function?.name || (c as any).name,
                        arguments: c.function?.arguments || (c as any).arguments
                    })));
                }

                assistantMsg.tool_calls = agent.normalizeToLegacyToolCalls(calls);
                agent.commitAssistantMessage(transientMessages, assistantMsg, turnObject.intent.class, executionLog.toolCalls.length, turnSeenHashes, activeMode);

                // --- HARDENED Tool Execution with Timeouts + Execution-Time Gate ---
                const toolExecutionResult = await this.executeToolCallsIteration({
                    calls,
                    allowedToolNames,
                    activeMode,
                    turnId,
                    capabilitiesOverride,
                    executionLog,
                    transientMessages,
                    onEvent,
                    isBrowserTask,
                    browserTaskToolNames: BROWSER_TASK_TOOL_NAMES,
                    browserMutatingToolNames: BROWSER_MUTATING_TOOL_NAMES,
                    browserTaskHadSuccessfulAction,
                });
                browserTaskHadSuccessfulAction = toolExecutionResult.browserTaskHadSuccessfulAction;
            } catch (e: any) {
                const timeoutHandled = await this.handleIterationTimeoutFallback({
                    error: e,
                    toolsSentThisIteration,
                    turn,
                    turnId,
                    signal,
                    truncated,
                    systemPrompt,
                    onToken,
                    turnObject,
                    enforceCanonRequiredAutobioOverride,
                    executionLog,
                    transientMessages,
                    turnSeenHashes,
                    activeMode,
                });
                if (timeoutHandled.finalResponse) {
                    finalResponse = timeoutHandled.finalResponse;
                }
                break;
            }
        }

        // --- Finalize turn execution log ---
        if (executionLog.toolCallsPlanned.length > 0 || executionLog.toolCalls.length > 0) {
            executionLog.executedToolCount = executionLog.toolCalls.length;
            executionLog.mode = activeMode;
            executionLog.toolsSentCount = filteredTools.length;
            executionLog.usage = cumulativeUsage;
            agent.lastTurnExecutionLog = executionLog;
            agent.executionLogHistory.push(executionLog);
            if (agent.executionLogHistory.length > 25) {
                agent.executionLogHistory.shift();
            }
        }

        // Final authoritative outbound guard: last-stage replacement before memory writes,
        // artifact routing, chat history persistence, and UI return payload.
        const finalizeOverride = agent.applyCanonRequiredAutobioFinalizeOverride(
            finalResponse,
            transientMessages,
            enforceCanonRequiredAutobioOverride,
        );
        finalResponse = finalizeOverride.finalResponse;
        transientMessages.splice(0, transientMessages.length, ...finalizeOverride.transientMessages);
        if (finalizeOverride.enforced) {
            console.log(
                `[AgentService] canon_required_fallback_enforced=true ` +
                `originalContentLength=${finalizeOverride.originalContentLength} ` +
                `replacedAtStage=${finalizeOverride.replacedAtStage} turnId=${turnId}`
            );
            telemetry.operational(
                'cognitive',
                'canon_required_fallback_enforced',
                'warn',
                `turn:${turnId}`,
                'Canon-required autobiographical fallback enforced on final outbound response.',
                'success',
                {
                    payload: {
                        turnId,
                        canon_required_fallback_enforced: true,
                        originalContentLength: finalizeOverride.originalContentLength,
                        replacedAtStage: finalizeOverride.replacedAtStage,
                        mode: activeMode,
                        intent: turnObject.intent.class,
                    },
                },
            );
        }

        // --- Post-response memory storage (fire-and-forget, non-blocking) ---
        if (finalResponse && settings.agent?.capabilities?.memory !== false) {
            const storeMemories = async () => {
                // â”€â”€ Memory Integrity Policy gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                // Evaluate health before any write. If hard-disabled (critical/
                // disabled state), skip all memory operations and emit an alert.
                const memHealth = agent.memory.getHealthStatus();
                if (memHealth.hardDisabled) {
                    console.warn(
                        `[AgentService][MemoryIntegrity] Memory writes BLOCKED â€” state=${memHealth.state}. ` +
                        `Reason: ${memHealth.summary}`,
                    );
                    TelemetryBus.getInstance().emit({
                        event: 'memory.capability_blocked',
                        subsystem: 'memory',
                        executionId: turnId,
                        payload: {
                            operation: 'post_turn_write',
                            state: memHealth.state,
                            reasons: memHealth.reasons,
                            hardDisabled: true,
                            turnId,
                        },
                    });
                    return;
                }

                // Determine which derived systems are allowed this turn
                const allowMem0Write = memHealth.capabilities.mem0Runtime;
                const allowRagWrite = memHealth.capabilities.ragLogging;
                const allowGraphWrite = memHealth.capabilities.extraction && memHealth.capabilities.graphProjection;

                if (memHealth.state !== 'healthy') {
                    console.log(
                        `[AgentService][MemoryIntegrity] Proceeding with constrained memory writes. ` +
                        `state=${memHealth.state} mode=${memHealth.mode} ` +
                        `mem0=${allowMem0Write} rag=${allowRagWrite} graph=${allowGraphWrite}`,
                    );
                }

                // P7A: Canonical write through MemoryAuthorityService MUST happen before
                // any derived system (mem0, RAG, graph). canonical_memory_id is returned
                // and passed downstream so derived systems can reference it.
                const memoryAuthorityContext = (
                    capabilitiesOverride?.turnMemoryAuthorityContext ??
                    {}
                ) as MemoryAuthorityContext;
                const memoryWriteRequest: MemoryWriteRequest = {
                    writeId: `memory-write-${turnId}`,
                    category: 'conversation_memory',
                    source: 'memory_service',
                    turnId,
                    payload: {
                        mode: activeMode,
                        intentClass: turnObject.intent.class,
                    },
                };
                try {
                    memoryAuthorityGate.assertAllowed(memoryWriteRequest, {
                        ...memoryAuthorityContext,
                        turnId: memoryAuthorityContext.turnId ?? turnId,
                    });
                } catch (err) {
                    if (detectMemoryAuthorityViolationError(err)) {
                        console.warn(
                            `[AgentService][MemoryAuthority] blocked post-turn memory write turnId=${turnId} ` +
                            `reasonCodes=${err.decision.reasonCodes.join(',')}`,
                        );
                        return;
                    }
                    throw err;
                }

                let canonicalMemoryId: string | null = null;
                const repo = getCanonicalMemoryRepository();
                if (repo) {
                    const pgRepo = repo as unknown as PostgresMemoryRepository;
                    const pool = pgRepo.getSharedPool();
                    const authorityService = new MemoryAuthorityService(pool);

                    const ts = new Date().toISOString().slice(0, 16);
                    const contentText = `[${ts}] User: "${userMessage.slice(0, 200)}" | Tala: "${finalResponse.slice(0, 300)}"`;

                    TelemetryBus.getInstance().emit({
                        event: 'memory.candidate_proposed',
                        subsystem: 'memory',
                        executionId: turnId,
                        payload: {
                            source_kind: 'conversation',
                            source_ref: `turn:${turnId}`,
                            memory_type: 'interaction',
                        },
                    });

                    const writeResult = await authorityService.tryCreateCanonicalMemory({
                        memory_type: 'interaction',
                        subject_type: 'conversation',
                        subject_id: turnId,
                        content_text: contentText,
                        content_structured: {
                            user_message: userMessage.slice(0, 500),
                            agent_response: finalResponse.slice(0, 1000),
                            mode: activeMode,
                            turn_id: turnId,
                        },
                        confidence: 1.0,
                        source_kind: 'conversation',
                        source_ref: `turn:${turnId}`,
                    }, { executionId: turnId });

                    if (writeResult.success) {
                        canonicalMemoryId = writeResult.data ?? null;
                        console.log(`[AgentService] P7A canonical write complete: ${canonicalMemoryId}`);
                        TelemetryBus.getInstance().emit({
                            event: 'memory.write_completed',
                            subsystem: 'memory',
                            executionId: turnId,
                            payload: {
                                category: 'conversation_memory',
                                source: memoryWriteRequest.source,
                                turnId,
                                goalId: memoryAuthorityContext.goalId,
                                turnMode: memoryAuthorityContext.turnMode,
                                memoryWriteMode: memoryAuthorityContext.memoryWriteMode,
                                authorityLevel: memoryAuthorityContext.authorityEnvelope?.authorityLevel,
                                canonicalMemoryId,
                            },
                        });
                        telemetry.operational(
                            'cognitive',
                            'post_turn_memory_write',
                            'info',
                            `turn:${turnId}`,
                            `P7A canonical memory write: postgres stored under mode=${activeMode}`,
                            'success',
                            { payload: { turnId, canonicalMemoryId, mode: activeMode, source: 'postgres' } },
                        );
                        // Enqueue deferred embedding if embeddings are unavailable at write time
                        if (canonicalMemoryId && !memHealth.capabilities.embeddings) {
                            DeferredMemoryReplayService.getInstance().enqueue({
                                kind: 'embedding',
                                canonicalMemoryId,
                                turnId,
                                payload: { contentText, mode: activeMode },
                            }).catch(() => {});
                        }
                    } else {
                        console.warn('[AgentService] P7A canonical write failed:', writeResult.error);
                        TelemetryBus.getInstance().emit({
                            event: 'memory.candidate_deferred',
                            subsystem: 'memory',
                            executionId: turnId,
                            payload: {
                                reason: writeResult.error ?? 'canonical write failed',
                                source_kind: 'conversation',
                            },
                        });
                    }
                } else {
                    console.warn('[AgentService] P7A: canonical memory repository not available â€” derived writes are blocked');
                    TelemetryBus.getInstance().emit({
                        event: 'memory.candidate_deferred',
                        subsystem: 'memory',
                        executionId: turnId,
                        payload: {
                            reason: 'canonical repository unavailable',
                            source_kind: 'conversation',
                        },
                    });
                }

                if (!canonicalMemoryId) {
                    console.warn('[AgentService] P7A: skipping derived memory writes because canonical acceptance did not succeed.');
                    return;
                }

                try {
                    // 1. Mem0 (derived): store interaction â€” reference canonical_memory_id when available
                    if (!allowMem0Write) {
                        console.log(`[AgentService][MemoryIntegrity] Mem0 write suppressed (mem0Runtime unavailable). state=${memHealth.state}`);
                        // Enqueue extraction work so it can be replayed when extraction recovers
                        if (canonicalMemoryId && !memHealth.capabilities.extraction) {
                            DeferredMemoryReplayService.getInstance().enqueue({
                                kind: 'extraction',
                                canonicalMemoryId,
                                turnId,
                                payload: {
                                    userMessage: userMessage.slice(0, 500),
                                    agentResponse: finalResponse.slice(0, 1000),
                                    mode: activeMode,
                                },
                            }).catch(() => {});
                        }
                    } else {
                    const ts = new Date().toISOString().slice(0, 16); // 2026-03-02T08:46
                    const memEntry = `[${ts}] User: "${userMessage.slice(0, 200)}" | Tala: "${finalResponse.slice(0, 300)}"`;

                    if (runtimeSafety.isDuplicateMemory(memEntry)) {
                        console.log(`[AgentService] MEMORY_DUPLICATE_SKIPPED: mem0`);
                    } else {
                        const memId = canonicalMemoryId;
                        // FIX 5: Mode Persistence Writeback Correctness
                        // We use the activeMode captured at the top of the turn (line 1512)
                        await agent.memory.syncDerivedProjectionFromCanonical({
                            canonicalMemoryId,
                            text: memEntry,
                            metadata: { source: 'conversation', category: 'interaction', mem_id: memId },
                            mode: activeMode,
                            source: 'conversation',
                        });
                        console.log(`[AgentService] Stored interaction to Mem0 (${memId}) under mode: ${activeMode}`);
                        // Phase 3A: emit post-turn memory write telemetry
                        telemetry.operational(
                            'cognitive',
                            'post_turn_memory_write',
                            'info',
                            `turn:${turnId}`,
                            `Post-turn memory write: mem0 stored under mode=${activeMode}`,
                            'success',
                            { payload: { turnId, memId, mode: activeMode, source: 'mem0', canonicalMemoryId } },
                        );
                    }
                    }
                } catch (e) {
                    console.warn('[AgentService] Mem0 post-store failed:', e);
                }

                try {
                    // 2. RAG (derived): log full turn for episodic long-term retrieval
                    if (!allowRagWrite) {
                        console.log(`[AgentService][MemoryIntegrity] RAG write suppressed (ragLogging unavailable). state=${memHealth.state}`);
                    } else {
                    await agent.rag.logInteraction(userMessage, finalResponse);
                    console.log('[AgentService] Logged interaction to RAG');
                    }
                } catch (e) {
                    console.warn('[AgentService] RAG log failed:', e);
                }

                try {
                    // 3. Memory Graph (derived): run extraction pipeline on the full exchange.
                    // process_memory handles Extract â†’ Validate â†’ Store internally.
                    if (!allowGraphWrite) {
                        console.log(`[AgentService][MemoryIntegrity] Graph write suppressed (extraction/graphProjection unavailable). state=${memHealth.state}`);
                        // Enqueue graph_projection work so it can be replayed when graph recovers
                        if (canonicalMemoryId) {
                            const turnText = `User: ${userMessage.slice(0, 500)}\nTala: ${finalResponse.slice(0, 600)}`;
                            DeferredMemoryReplayService.getInstance().enqueue({
                                kind: 'graph_projection',
                                canonicalMemoryId,
                                turnId,
                                payload: {
                                    text: turnText,
                                    source_ref: canonicalMemoryId,
                                    canonical_memory_id: canonicalMemoryId,
                                },
                            }).catch(() => {});
                        }
                    } else if (agent.mcpService && typeof agent.mcpService.callTool === 'function') {
                        const turnText = `User: ${userMessage}\nTala: ${finalResponse.slice(0, 600)}`;
                        await agent.mcpService.callTool('tala-memory-graph', 'process_memory', {
                            text: turnText,
                            source_ref: canonicalMemoryId ?? 'conversation',
                            canonical_memory_id: canonicalMemoryId,
                        });
                        console.log('[AgentService] Processed turn into Memory Graph');
                    }
                } catch (e) {
                    console.warn('[AgentService] Memory Graph upsert failed:', e);
                }
            };
            storeMemories(); // fire-and-forget
        }

        // --- PHASE 3A: POST-TURN REFLECTION SIGNAL ---
        // Emit a reflection signal based on the turn outcome so the reflection engine
        // can build behavioral notes for future turns.
        try {
            const hasToolErrors = executionLog.toolCalls.some(tc => !tc.ok);
            const durationMs = Date.now() - chatStartedAt;
            // Record the turn for reflection latency stats / signal processing.
            // ReflectionEngine.recordTurn() is a static method that buffers turn data.
            const { ReflectionEngine } = await import('../reflection/ReflectionEngine');
            ReflectionEngine.recordTurn({
                timestamp: new Date().toISOString(),
                latencyMs: durationMs,
                turnNumber: executionLog.toolCalls.length,
                model: modelName,
                tokensUsed: cumulativeUsage.total_tokens,
                hadToolCalls: executionLog.toolCalls.length > 0,
            });
            telemetry.operational(
                'cognitive',
                'post_turn_reflection_signal',
                'info',
                `turn:${turnId}`,
                `Post-turn reflection signal recorded: durationMs=${durationMs} toolErrors=${hasToolErrors}`,
                'success',
                { payload: { turnId, durationMs, hasToolErrors, mode: activeMode, intent: orchResult.intentClass } },
            );
        } catch (reflErr) {
            // Reflection signal failure is always non-fatal
            console.warn('[AgentService] Post-turn reflection signal failed (non-fatal):', reflErr);
        }

        // --- FINAL UI BOUNDARY GUARD (Last Line of Defense) ---
        // Ensure that for coding intent, if any tools were executed or calls were made, no assistant prose remains.
        if (turnObject.intent.class === 'coding' && (executionLog.toolCalls.length > 0 || transientMessages.some(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0))) {
            for (const msg of transientMessages) {
                if (msg.role === 'assistant' && msg.content && msg.content.trim().length > 0) {
                    console.warn(`[AgentService] FINAL GUARD TRIGGERED: Suppressing leaked prose for coding turn. Session: ${agent.activeSessionId || 'unknown'}`);
                    console.log(`[AgentService] Leaked prose preview: ${msg.content.substring(0, 100)}...`);
                    msg.content = '';
                }
            }
        }

        // --- ARTIFACT ROUTING ---
        // Inspect tool results and final response to see if an artifact should be emitted
        const toolResults = executionLog.toolCalls.filter(tc => tc.ok).map(tc => ({
            name: tc.name,
            args: tc.arguments,
            result: tc.resultPreview
        }));

        const normalized = artifactRouter.normalizeAgentOutput(finalResponse, toolResults);

        if (normalized.artifact) {
            console.log(`[ArtifactRouter] Emitting artifact type=${normalized.artifact.type} id=${normalized.artifact.id}`);
            if (onEvent) {
                onEvent('artifact-open', normalized.artifact);
            }
            if (normalized.suppressChatContent) {
                // If the UI is already streaming, this replaces the final state with a summary
                // The UI will need to handle 'chat-done' with potential content replacement
                finalResponse = normalized.message || finalResponse;

                // Update the last assistant message in transientMessages if it exists
                const lastAssistant = transientMessages.reverse().find(m => m.role === 'assistant');
                if (lastAssistant) {
                    lastAssistant.content = finalResponse;
                }
                transientMessages.reverse(); // put it back
            }
        }

        agent.chatHistory.push(...transientMessages);
        agent.saveSession();

        return normalized;
    
        })();

        return { output };
    }

    private async finalizeOutcome(loop: LoopExecutionResult): Promise<AgentTurnOutput> {
        if (!loop.output) {
            throw new Error('ChatExecutionSpine finalizeOutcome missing loop output');
        }
        return loop.output;
    }
}
