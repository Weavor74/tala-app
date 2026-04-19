import { v4 as uuidv4 } from 'uuid';
import type { AgentService } from '../AgentService';
import type { AgentTurnOutput } from '../../types/artifacts';
import type {
    RuntimeExecutionType,
    RuntimeExecutionOrigin,
    RuntimeExecutionMode,
    ExecutionRequest,
    ExecutionState,
} from '../../../shared/runtime/executionTypes';
import { createInitialExecutionState, createExecutionRequest, setExecutionTerminalState } from '../../../shared/runtime/ExecutionRuntimeFactory';
import { ExecutionStateStore } from './ExecutionStateStore';
import { TelemetryBus } from '../telemetry/TelemetryBus';
import { policyGate, PolicyDeniedError } from '../policy/PolicyGate';
import { PlanningLoopService } from '../planning/PlanningLoopService';
import { ChatLoopExecutor } from '../planning/ChatLoopExecutor';
import { ChatLoopObserver } from '../planning/ChatLoopObserver';
import { PlanningService } from '../planning/PlanningService';
import { PlanningLoopAuthorityRouter } from '../planning/PlanningLoopAuthorityRouter';
import type { PlanningLoopRoutingDecision } from '../../../shared/planning/executionAuthorityTypes';
import { SystemModeManager } from '../SystemModeManager';
import type {
    TurnArbitrationDecision,
    TurnAuthorityEnvelope,
} from '../../../shared/turnArbitrationTypes';
import type { MemoryAuthorityContext } from '../../../shared/memoryAuthorityTypes';
import type { ChatTurnAssistantResponse, ChatTurnResult, ChatTurnResultSource } from '../../../shared/chatTurnResultTypes';
import type { RuntimeEventType } from '../../../shared/runtimeEventTypes';
import { TurnContextService } from './TurnContextBuilder';
import { TurnIntentAnalysisService } from './TurnIntentAnalyzer';
import { TurnArbitrationService } from './TurnArbitrator';
import { SelfInspectionExecutionService } from '../agent/SelfInspectionExecutionService';
import { SelfKnowledgeExecutionService } from '../agent/SelfKnowledgeExecutionService';
import { buildSelfKnowledgePersonaAdaptation } from '../agent/PersonaIdentityResponseAdapter';
import {
    resolveImmersiveRelationalRequest,
    resolveOperationalSystemRequest,
    resolvePersonaIdentityDisclosure,
} from '../../../shared/agent/PersonaIdentityPolicy';

// ═══════════════════════════════════════════════════════════════════════════
// KERNEL RUNTIME TYPES
// Lightweight shared types that define the kernel's public contract.
// Keep additions here minimal — these evolve with the kernel, not with callers.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Classification of how a turn should be handled by the kernel.
 * Populated during the classify stage and carried through to finalize.
 * - 'standard'      : normal multi-turn chat with optional tool use
 * - 'direct_answer' : low-complexity turn; tool calls likely not needed
 * - 'tool_heavy'    : turn expected to require significant tool orchestration
 *
 * Currently always resolves to 'standard' — value is reserved for Phase 3
 * routing logic inside classifyExecution().
 */
export type ExecutionClass = 'standard' | 'direct_answer' | 'tool_heavy';

export type PlanBlockedRecoveryAction =
    | 'replan'
    | 'degrade_to_chat'
    | 'escalate'
    | 'terminate';

export interface PlanBlockedRecoveryDecision {
    action: PlanBlockedRecoveryAction;
    reasonCode: string;
    userSafeMessage?: string;
    metadata?: Record<string, unknown>;
}

type AssistantOutputChannel = NonNullable<AgentTurnOutput['outputChannel']>;

export type AssistantOutputLike = string | {
    content: string;
    artifactId?: string;
    outputChannel?: AssistantOutputChannel;
};

export type NormalizedAssistantOutput = {
    content: string;
    artifactId?: string;
    outputChannel: AssistantOutputChannel;
};

export function normalizeAssistantOutput(value: AssistantOutputLike): NormalizedAssistantOutput {
    if (typeof value === 'string') {
        return {
            content: value,
            outputChannel: 'chat',
        };
    }
    return {
        content: value.content,
        artifactId: value.artifactId,
        outputChannel: value.outputChannel ?? 'chat',
    };
}

export const AGENT_RESPONSE_RUNTIME_EVENTS = {
    turnResponseCreated: 'agent.turn_response_created',
    turnResponsePublished: 'agent.turn_response_published',
    turnResponseMissing: 'agent.turn_response_missing',
    selfKnowledgeResponseCreated: 'agent.self_knowledge_response_created',
    selfKnowledgeResponsePublished: 'agent.self_knowledge_response_published',
    selfKnowledgeResponseMissing: 'agent.self_knowledge_response_missing',
} as const satisfies Record<
    | 'turnResponseCreated'
    | 'turnResponsePublished'
    | 'turnResponseMissing'
    | 'selfKnowledgeResponseCreated'
    | 'selfKnowledgeResponsePublished'
    | 'selfKnowledgeResponseMissing',
    RuntimeEventType
>;

const AGENT_PERSONA_IDENTITY_EVENTS = {
    gateApplied: 'agent.persona_identity_gate_applied',
    metaDisclosureBlocked: 'agent.persona_identity_meta_disclosure_blocked',
    responseTransformed: 'agent.persona_identity_response_transformed',
    systemDisclosureAllowed: 'agent.persona_identity_system_disclosure_allowed',
    personaTruthEnforced: 'agent.persona_truth_enforced',
    personaTruthMetaRewriteApplied: 'agent.persona_truth_meta_rewrite_applied',
    personaTruthMetaDisclosureBlocked: 'agent.persona_truth_meta_disclosure_blocked',
    personaTruthCanonSelected: 'agent.persona_truth_canon_selected',
} as const satisfies Record<
    | 'gateApplied'
    | 'metaDisclosureBlocked'
    | 'responseTransformed'
    | 'systemDisclosureAllowed'
    | 'personaTruthEnforced'
    | 'personaTruthMetaRewriteApplied'
    | 'personaTruthMetaDisclosureBlocked'
    | 'personaTruthCanonSelected',
    RuntimeEventType
>;

type PlanBlockedTaskClass =
    | 'source_summary'
    | 'notebook_summary'
    | 'retrieval_answer'
    | 'document_synthesis'
    | 'non_critical_response'
    | 'authority_required';

function classifyPlanBlockedTaskClass(userMessage: string): PlanBlockedTaskClass {
    const text = userMessage.toLowerCase();
    if (/(notebook|source).{0,20}(summary|summarize)|summarize.{0,20}(notebook|source)/.test(text)) {
        return text.includes('notebook') ? 'notebook_summary' : 'source_summary';
    }
    if (/(summarize|summary|synthesize|synthesis|digest|overview)/.test(text)) {
        return 'document_synthesis';
    }
    if (/(retrieve|retrieval|find|search|lookup|source[- ]grounded|factual)/.test(text)) {
        return 'retrieval_answer';
    }
    if (/(explain|clarify|help me understand|what is|why is)/.test(text)) {
        return 'non_critical_response';
    }
    return 'authority_required';
}

function isOperatorSensitiveExecution(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return /(delete|drop|remove|terminate|restart|shutdown|kill|purge|publish|deploy|write|persist|store|commit|push|approve|authorize|elevate|production|canonical|memory update)/.test(text);
}

function isAutonomousExecutionOrigin(origin: RuntimeExecutionOrigin): boolean {
    return origin === 'autonomy_engine';
}

function resolvePlanBlockedRecovery(args: {
    blockedReason: string;
    activeMode: string;
    autonomyDegraded: boolean;
    policyGateDegraded: boolean;
    availableCapabilities: ReadonlySet<string>;
    taskClass?: PlanBlockedTaskClass;
    planId?: string;
    goalId?: string;
}): PlanBlockedRecoveryDecision {
    const reason = args.blockedReason.toLowerCase();
    const taskClass = args.taskClass ?? 'authority_required';
    const nonCriticalTask = taskClass === 'source_summary'
        || taskClass === 'notebook_summary'
        || taskClass === 'retrieval_answer'
        || taskClass === 'document_synthesis'
        || taskClass === 'non_critical_response';
    const autonomyUnavailable = args.autonomyDegraded
        || args.activeMode === 'DEGRADED_AUTONOMY'
        || !args.availableCapabilities.has('autonomy_execute');
    const policyBlocked = args.policyGateDegraded
        || reason.includes('policy')
        || reason.includes('approval')
        || reason.includes('denied');
    const unrecoverable = reason.includes('unrecoverable')
        || reason.includes('no_valid_path')
        || reason.includes('no_fallback');
    const replannable = Boolean(args.goalId && args.planId);

    if (policyBlocked) {
        return {
            action: 'escalate',
            reasonCode: 'plan_blocked.recover.escalate.policy_or_approval_block',
            userSafeMessage: 'This task needs operator review before planning can continue.',
        };
    }
    if (autonomyUnavailable && nonCriticalTask) {
        return {
            action: 'degrade_to_chat',
            reasonCode: 'plan_blocked.recover.degrade_to_chat.degraded_autonomy_non_critical',
            userSafeMessage: 'Planning is temporarily constrained, so I am continuing with a safe direct response path.',
            metadata: { taskClass },
        };
    }
    if (!unrecoverable && replannable) {
        return {
            action: 'replan',
            reasonCode: 'plan_blocked.recover.replan.blocked_plan_replannable',
        };
    }
    return {
        action: 'terminate',
        reasonCode: 'plan_blocked.recover.terminate.no_safe_path',
        userSafeMessage: 'I could not safely recover this blocked plan path.',
    };
}

/**
 * Lightweight metadata stamped onto every kernel execution.
 * Provides a stable correlation handle and classification summary.
 *
 * `executionType`, `origin`, and `mode` use the canonical shared vocabulary
 * from `shared/runtime/executionTypes.ts`.
 */
export interface KernelExecutionMeta {
    /** Unique ID for this execution turn -- useful for log correlation. */
    executionId: string;
    /** Unix ms timestamp when the kernel received the request. */
    startedAt: number;
    /** Logical type of execution. Currently always 'chat_turn'. */
    executionType: RuntimeExecutionType;
    /**
     * Classification assigned during the classify stage.
     * Guides future routing decisions in classifyExecution().
     */
    executionClass: ExecutionClass;
    /** Wall-clock duration in ms from intake to finalize. */
    durationMs: number;
    /** The originating source of this execution request. */
    origin: RuntimeExecutionOrigin;
    /** The Tala runtime mode in effect when this execution was created. */
    mode: RuntimeExecutionMode;
    /**
     * Legacy authority routing projection for diagnostics parity.
     * Derived from turn arbitration mode.
     */
    routingDecision?: PlanningLoopRoutingDecision;
    /**
     * Immutable turn arbitration decision for this turn.
     * Set once during classifyExecution and never mutated afterward.
     */
    turnArbitration?: TurnArbitrationDecision;
    /**
     * Execution authority envelope propagated to downstream coordinators.
     */
    authorityEnvelope?: TurnAuthorityEnvelope;
}

/**
 * Normalized request envelope passed between kernel stages.
 * normalizeRequest() ensures this is always fully populated before
 * being forwarded to classifyExecution() or runDelegatedFlow().
 *
 * Callers may supply `origin` and `executionMode` to propagate the actual
 * execution context (e.g. the active mode from settings) into the kernel's
 * execution vocabulary. When omitted, the kernel defaults to `'ipc'` and
 * `'assistant'` respectively.
 */
export interface KernelRequest {
    userMessage: string;
    images?: string[];
    capabilitiesOverride?: any;
    turnId?: string;
    conversationId?: string;
    attachments?: unknown[];
    workspaceContext?: Record<string, unknown>;
    activeGoalId?: string;
    operatorMode?: 'chat' | 'goal' | 'auto';
    requestedSurface?: string;
    /**
     * Caller-provided execution origin.
     * Defaults to `'ipc'` inside `intake()` when not supplied.
     */
    origin?: RuntimeExecutionOrigin;
    /**
     * Caller-provided runtime mode.
     * Defaults to `'assistant'` inside `intake()` when not supplied.
     * Callers should pass the resolved mode from settings (e.g. 'rp', 'hybrid').
     */
    executionMode?: RuntimeExecutionMode;
}

/**
 * Result envelope returned by AgentKernel.execute().
 * Extends AgentTurnOutput with kernel-level execution metadata.
 * Callers that only need turn output can ignore `meta` and `executionState`.
 */
export interface KernelResult extends AgentTurnOutput {
    meta: KernelExecutionMeta;
    turnResult: ChatTurnResult;
    /**
     * Terminal ExecutionState for this turn, built at finalizeExecution.
     * Provides a normalized view of the execution using the shared runtime
     * vocabulary for downstream consumers (telemetry, audit, IPC surfacing).
     */
    executionState: ExecutionState;
}

// ═══════════════════════════════════════════════════════════════════════════
// AGENT KERNEL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * AgentKernel — stable top-level execution shell for the Tala runtime.
 *
 * This class is the recognized primary entrypoint for all Tala execution.
 * Its job is to coordinate the full lifecycle of a runtime turn through a
 * structured 5-stage pipeline, while delegating all substantive work to the
 * existing subsystems below it.
 *
 * ── Pipeline stages ─────────────────────────────────────────────────────
 *
 *   1. normalizeRequest   Validate and normalize the inbound KernelRequest.
 *                         Future: request coercion, source validation, ACL.
 *
 *   2. intake             Stamp execution metadata (ID, timestamps, type).
 *                         Future: budget checks, authority pre-validation.
 *
 *   3. classifyExecution  Classify the turn to guide downstream routing.
 *                         Future: mode detection, tool-need prediction,
 *                         policy gate, context assembly trigger.
 *
 *   4. runDelegatedFlow   Hand off to AgentService.chat() — all existing
 *                         orchestration logic remains there unchanged.
 *                         Future: inference orchestration boundary,
 *                         tool execution coordination boundary,
 *                         memory write coordination boundary.
 *
 *   5. finalizeExecution  Record duration, merge metadata into result.
 *                         Future: post-turn telemetry emission,
 *                         outcome learning hooks, audit record writes.
 *
 * ── Future responsibility boundaries ────────────────────────────────────
 *
 *   Policy enforcement      → normalizeRequest / intake
 *   Context assembly        → classifyExecution (between classify and delegate)
 *   Inference orchestration → runDelegatedFlow
 *   Tool execution coord.   → runDelegatedFlow
 *   Memory write coord.     → finalizeExecution
 *   Telemetry emission      → finalizeExecution
 *
 * None of those boundaries are active yet — the corresponding methods are
 * thin stubs that preserve all existing behavior.  They exist so Phase 3
 * work has a stable named seam to attach to without touching callers.
 */
export class AgentKernel {
    private readonly agent: AgentService;
    private readonly _stateStore: ExecutionStateStore = new ExecutionStateStore();
    /**
     * Planning loop executor — holds the ChatLoopExecutor with streaming
     * callback support.  Wired at construction time.
     */
    private readonly _chatLoopExecutor: ChatLoopExecutor;
    private readonly _turnContextBuilder = new TurnContextService();
    private readonly _turnIntentAnalyzer = new TurnIntentAnalysisService();
    private readonly _turnArbitrator = new TurnArbitrationService();
    private readonly _selfInspectionExecution = new SelfInspectionExecutionService();
    private readonly _selfKnowledgeExecution = new SelfKnowledgeExecutionService();
    private readonly _personaContinuityByConversation = new Map<string, boolean>();

    constructor(agent: AgentService) {
        this.agent = agent;

        // ── Wire PlanningLoopService for authority routing ──────────────────
        // Create a ChatLoopExecutor that wraps AgentService.chat() as the
        // ILoopExecutor beneath the planning loop.
        // PlanningService.getInstance() lazily creates its singleton here.
        const planning = PlanningService.getInstance();
        this._chatLoopExecutor = new ChatLoopExecutor(
            (message, onToken, onEvent, images) =>
                this.agent.chat(message, onToken, onEvent, images),
            planning,
            {
                toolAuthority: {
                    executeTool: async (name, args, _allowedNames, _ctx) => {
                        const startedAt = Date.now();
                        try {
                            const data = await this.agent.executeTool(name, args);
                            return {
                                success: true,
                                toolName: name,
                                data,
                                durationMs: Date.now() - startedAt,
                            };
                        } catch (error) {
                            return {
                                success: false,
                                toolName: name,
                                error: error instanceof Error ? error.message : String(error),
                                durationMs: Date.now() - startedAt,
                            };
                        }
                    },
                },
                workflowAuthority: {
                    executeWorkflow: async (workflowId, input) =>
                        this.agent.executeWorkflow(workflowId, input),
                },
                agentAuthority: {
                    executeAgent: async (_agentId, input) => {
                        const startedAt = Date.now();
                        try {
                            const message = typeof input.message === 'string'
                                ? input.message
                                : typeof input.prompt === 'string'
                                    ? input.prompt
                                    : 'Execute planned agent stage';
                            const data = await this.agent.chat(message);
                            return {
                                success: true,
                                data,
                                durationMs: Date.now() - startedAt,
                            };
                        } catch (error) {
                            return {
                                success: false,
                                error: error instanceof Error ? error.message : String(error),
                                durationMs: Date.now() - startedAt,
                            };
                        }
                    },
                },
            },
        );
        const observer = new ChatLoopObserver();
        // Initialize PlanningLoopService with the chat-based executor and observer.
        // This makes PlanningLoopService the real runtime authority for non-trivial work.
        PlanningLoopService.initialize(this._chatLoopExecutor, observer, planning);
    }

    /**
     * Read-only access to the kernel's execution state store.
     * Callers may inspect active and completed execution states without
     * mutating the store directly.
     */
    get stateStore(): ExecutionStateStore {
        return this._stateStore;
    }

    // ─── Internal helpers ────────────────────────────────────────────────────

    /**
     * Constructs the canonical ExecutionRequest for a given meta + request pair.
     * Used by intake() when registering the initial state and by finalizeExecution()
     * as a defensive fallback so both paths stay consistent.
     */
    private _buildExecRequest(meta: KernelExecutionMeta, userMessage: string): ExecutionRequest {
        return createExecutionRequest({
            executionId: meta.executionId,
            type: meta.executionType,
            origin: meta.origin,
            mode: meta.mode,
            actor: 'user',
            input: { message: userMessage },
            metadata: {},
        });
    }

    private _composeCapabilitiesOverride(
        capabilitiesOverride: any,
        turnDecision: TurnArbitrationDecision,
        authorityEnvelope: TurnAuthorityEnvelope,
    ): any {
        const turnMemoryAuthorityContext: MemoryAuthorityContext = {
            turnId: turnDecision.turnId,
            conversationId: undefined,
            goalId: turnDecision.activeGoalId,
            turnMode: turnDecision.mode,
            memoryWriteMode: turnDecision.memoryWriteMode,
            authorityEnvelope,
        };
        if (capabilitiesOverride && typeof capabilitiesOverride === 'object') {
            return {
                ...capabilitiesOverride,
                turnAuthorityEnvelope: authorityEnvelope,
                turnMemoryAuthorityContext,
            };
        }
        return {
            turnAuthorityEnvelope: authorityEnvelope,
            turnMemoryAuthorityContext,
        };
    }

    private _emitTurnResponseEvent(meta: KernelExecutionMeta, event: RuntimeEventType, payload: Record<string, unknown>): void {
        TelemetryBus.getInstance().emit({
            executionId: meta.executionId,
            subsystem: 'agent',
            event,
            phase: 'delegate',
            payload: {
                turnId: meta.turnArbitration?.turnId,
                mode: meta.mode,
                authorityPath: meta.turnArbitration?.mode ?? 'unknown',
                route: meta.routingDecision?.classification ?? 'unknown',
                finalizationState: 'pending',
                durationMs: Date.now() - meta.startedAt,
                ...payload,
            },
        });
    }

    private _normalizeAssistantTurnResult(turnResult: ChatTurnResult): ChatTurnResult {
        if (turnResult.kind !== 'assistant_response') {
            return turnResult;
        }
        return {
            ...turnResult,
            message: normalizeAssistantOutput(turnResult.message),
        };
    }

    private _getConversationId(request: KernelRequest): string {
        return request.conversationId ?? 'default';
    }

    private _isFollowupToPersonaConversation(request: KernelRequest): boolean {
        return this._personaContinuityByConversation.get(this._getConversationId(request)) === true;
    }

    private _updatePersonaContinuity(request: KernelRequest, meta: KernelExecutionMeta): void {
        const conversationId = this._getConversationId(request);
        const mode = (meta.mode ?? '').toLowerCase();
        const text = request.userMessage ?? '';
        const wasPersona = this._personaContinuityByConversation.get(conversationId) === true;
        const operational = resolveOperationalSystemRequest(text);
        const immersive = resolveImmersiveRelationalRequest(text);

        let nextPersonaState = wasPersona;
        if (mode === 'rp') {
            nextPersonaState = !operational || immersive;
        } else if (mode === 'hybrid') {
            if (immersive) {
                nextPersonaState = true;
            } else if (operational) {
                nextPersonaState = false;
            }
        } else {
            nextPersonaState = false;
        }

        this._personaContinuityByConversation.set(conversationId, nextPersonaState);
        if (this._personaContinuityByConversation.size > 128) {
            const oldestKey = this._personaContinuityByConversation.keys().next().value as string | undefined;
            if (oldestKey) this._personaContinuityByConversation.delete(oldestKey);
        }
    }

    private _assistantResponse(content: string, source: ChatTurnResultSource, outputChannel: AgentTurnOutput['outputChannel'] = 'chat'): ChatTurnAssistantResponse {
        const normalizedMessage = normalizeAssistantOutput({
            content,
            outputChannel,
        });
        return {
            kind: 'assistant_response',
            source,
            message: normalizedMessage,
        };
    }

    private _turnFailure(errorCode: string, message: string, source: ChatTurnResultSource): ChatTurnResult {
        return {
            kind: 'turn_failure',
            errorCode,
            message,
            source,
        };
    }

    private _toChatTurnResult(output: AgentTurnOutput, source: ChatTurnResultSource): ChatTurnResult {
        const hasMessage = typeof output.message === 'string' && output.message.trim().length > 0;
        const hasArtifact = Boolean(output.artifact);
        if (hasMessage || hasArtifact) {
            const normalizedMessage = normalizeAssistantOutput({
                content: output.message ?? '',
                artifactId: output.artifact?.id,
                outputChannel: output.outputChannel,
            });
            return {
                kind: 'assistant_response',
                source,
                message: normalizedMessage,
            };
        }
        return this._turnFailure(
            'chat_turn_missing_response_artifact',
            'Accepted turn did not produce an assistant response artifact.',
            source,
        );
    }

    // ─── Stage 1: normalizeRequest ──────────────────────────────────────────
    // Validates and normalizes the inbound request before anything else runs.
    // Future: coerce malformed payloads, strip disallowed fields, source ACL.

    private normalizeRequest(raw: KernelRequest): KernelRequest {
        return {
            userMessage: raw.userMessage ?? '',
            images: raw.images ?? [],
            capabilitiesOverride: raw.capabilitiesOverride,
            turnId: raw.turnId,
            conversationId: raw.conversationId,
            attachments: raw.attachments ?? [],
            workspaceContext: raw.workspaceContext,
            activeGoalId: raw.activeGoalId,
            operatorMode: raw.operatorMode ?? 'auto',
            requestedSurface: raw.requestedSurface,
            origin: raw.origin,
            executionMode: raw.executionMode,
        };
    }

    // ─── Stage 2: intake ────────────────────────────────────────────────────
    // Stamps execution metadata after request is normalized.
    // Future: execution budget checks, authority pre-validation gate.

    private intake(
        request: KernelRequest,
        executionType: RuntimeExecutionType,
    ): KernelExecutionMeta {
        // Prefer caller-supplied origin/mode; fall back to conservative defaults.
        const origin: RuntimeExecutionOrigin = request.origin ?? 'ipc';
        const mode: RuntimeExecutionMode = request.executionMode ?? 'assistant';
        const meta: KernelExecutionMeta = {
            executionId: uuidv4(),
            startedAt: Date.now(),
            executionType,
            executionClass: 'standard',  // default; overwritten by classifyExecution() in Phase 3
            durationMs: 0,
            origin,
            mode,
        };
        console.log(`[AgentKernel] ── INTAKE           ── id=${meta.executionId} type=${executionType} origin=${origin} mode=${mode} msgLen=${request.userMessage.length}`);

        // execution.created — execution request received; executionId assigned
        TelemetryBus.getInstance().emit({
            executionId: meta.executionId,
            subsystem: 'kernel',
            event: 'execution.created',
            phase: 'intake',
            payload: { type: executionType, origin, mode },
        });

        // Register the initial ExecutionState in the store so downstream stages
        // can advance it through the lifecycle using the store's convenience APIs.
        this._stateStore.beginExecution(
            this._buildExecRequest(meta, request.userMessage),
            'AgentKernel'
        );

        // execution.accepted — request registered and ready to begin
        TelemetryBus.getInstance().emit({
            executionId: meta.executionId,
            subsystem: 'kernel',
            event: 'execution.accepted',
            phase: 'intake',
            payload: { type: executionType, origin, mode },
        });

        return meta;
    }

    // ─── Stage 3: classifyExecution ─────────────────────────────────────────
    // Classifies the turn to produce a routing hint for downstream stages.
    // Also performs the top-level policy admission check (PolicyGate).
    // Authority routing: classifies the request as trivial or non-trivial and
    // stores the PlanningLoopRoutingDecision on meta for use in runDelegatedFlow.

    private classifyExecution(request: KernelRequest, meta: KernelExecutionMeta): void {
        const decision = policyGate.evaluate({
            action: 'execution.admit',
            mode: meta.mode,
            origin: meta.origin,
            payload: { type: meta.executionType, executionId: meta.executionId },
        });

        if (!decision.allowed) {
            console.log(`[AgentKernel] POLICY BLOCKED id=${meta.executionId} code=${decision.code ?? 'none'} reason=${decision.reason}`);
            this._stateStore.blockExecution(meta.executionId, decision.reason);
            TelemetryBus.getInstance().emit({
                executionId: meta.executionId,
                subsystem: 'kernel',
                event: 'execution.blocked',
                phase: 'classify',
                payload: {
                    type: meta.executionType,
                    origin: meta.origin,
                    mode: meta.mode,
                    blockedReason: decision.reason,
                    code: decision.code,
                },
            });
            throw new PolicyDeniedError(decision);
        }

        const context = this._turnContextBuilder.build(request, meta);
        const bus = TelemetryBus.getInstance();
        bus.emit({
            executionId: meta.executionId,
            subsystem: 'kernel',
            event: 'kernel.turn_received',
            phase: 'classify',
            payload: {
                turnId: context.request.turnId,
                conversationId: context.request.conversationId,
                hasActiveGoal: context.hasActiveGoal,
                operatorMode: context.request.operatorMode,
            },
        });

        const intent = this._turnIntentAnalyzer.analyze(context);
        bus.emit({
            executionId: meta.executionId,
            subsystem: 'kernel',
            event: 'kernel.turn_intent_analyzed',
            phase: 'classify',
            payload: {
                turnId: context.request.turnId,
                conversationalWeight: intent.conversationalWeight,
                hybridWeight: intent.hybridWeight,
                goalExecutionWeight: intent.goalExecutionWeight,
                hasExecutionVerb: intent.hasExecutionVerb,
                containsBuildOrFixRequest: intent.containsBuildOrFixRequest,
                likelyNeedsOnlyExplanation: intent.likelyNeedsOnlyExplanation,
                referencesActiveWork: intent.referencesActiveWork,
                reasonCodes: intent.reasonCodes,
            },
        });

        const { decision: turnDecision, envelope } = this._turnArbitrator.arbitrate(context, intent);
        meta.turnArbitration = turnDecision;
        meta.authorityEnvelope = envelope;
        meta.routingDecision = turnDecision.mode === 'goal_execution'
            ? {
                complexity: 'non_trivial',
                classification: 'planning_loop_required',
                requiresLoop: true,
                reasonCodes: ['execution_keyword_detected'],
                summary: 'derived_from_turn_mode:goal_execution',
            }
            : {
                complexity: 'trivial',
                classification: 'trivial_direct_allowed',
                requiresLoop: false,
                reasonCodes: [],
                summary: `derived_from_turn_mode:${turnDecision.mode}`,
            };
        if (meta.routingDecision.requiresLoop) {
            bus.emit({
                executionId: meta.executionId,
                subsystem: 'planning',
                event: 'planning.loop_routing_selected',
                phase: 'classify',
                payload: {
                    classification: meta.routingDecision.classification,
                    reasonCodes: turnDecision.reasonCodes,
                    loopInitialized: PlanningLoopService.isInitialized(),
                },
            });
        } else {
            bus.emit({
                executionId: meta.executionId,
                subsystem: 'planning',
                event: 'planning.loop_routing_direct_allowed',
                phase: 'classify',
                payload: {
                    classification: meta.routingDecision.classification,
                    summary: meta.routingDecision.summary,
                },
            });
        }

        bus.emit({
            executionId: meta.executionId,
            subsystem: 'kernel',
            event: 'kernel.turn_arbitrated',
            phase: 'classify',
            payload: {
                turnId: turnDecision.turnId,
                mode: turnDecision.mode,
                source: turnDecision.source,
                confidence: turnDecision.confidence,
                reasonCodes: turnDecision.reasonCodes,
                goalIntent: turnDecision.goalIntent,
                shouldCreateGoal: turnDecision.shouldCreateGoal,
                shouldResumeGoal: turnDecision.shouldResumeGoal,
                activeGoalId: turnDecision.activeGoalId,
                requiresPlan: turnDecision.requiresPlan,
                requiresExecutionLoop: turnDecision.requiresExecutionLoop,
                authorityLevel: turnDecision.authorityLevel,
                memoryWriteMode: turnDecision.memoryWriteMode,
                selfInspectionRequest: turnDecision.selfInspectionRequest === true,
                selfInspectionOperation: turnDecision.selfInspectionOperation,
                selfInspectionRequestedPaths: turnDecision.selfInspectionRequestedPaths ?? [],
                selfKnowledgeDetected: turnDecision.selfKnowledgeDetected === true,
                selfKnowledgeRequestedAspects: turnDecision.selfKnowledgeRequestedAspects ?? [],
                selfKnowledgeRouted: turnDecision.selfKnowledgeRouted === true,
                selfKnowledgeSourceTruths: turnDecision.selfKnowledgeSourceTruths ?? [],
                selfKnowledgeBypassedFallback: turnDecision.selfKnowledgeBypassedFallback === true,
            },
        });
        if (turnDecision.selfInspectionRequest) {
            bus.emit({
                executionId: meta.executionId,
                subsystem: 'agent',
                event: 'agent.self_inspection_detected',
                phase: 'classify',
                payload: {
                    turnId: turnDecision.turnId,
                    originalIntent: 'kernel_turn_intent',
                    resolvedIntent: turnDecision.mode,
                    mode: meta.mode,
                    requestedOperation: turnDecision.selfInspectionOperation ?? 'unknown',
                    requestedPaths: turnDecision.selfInspectionRequestedPaths ?? [],
                    toolsAllowed: true,
                    writesAllowed: request.capabilitiesOverride?.allowWritesThisTurn === true,
                    reasonCodes: turnDecision.reasonCodes,
                },
            });
            bus.emit({
                executionId: meta.executionId,
                subsystem: 'agent',
                event: 'agent.self_inspection_bypassed_greeting_policy',
                phase: 'classify',
                payload: {
                    turnId: turnDecision.turnId,
                    mode: meta.mode,
                    reasonCodes: ['self_inspection_precedence_over_greeting'],
                },
            });
        }
        if (turnDecision.selfKnowledgeDetected) {
            bus.emit({
                executionId: meta.executionId,
                subsystem: 'agent',
                event: 'agent.self_knowledge_detected',
                phase: 'classify',
                payload: {
                    turnId: turnDecision.turnId,
                    mode: meta.mode,
                    requestedAspects: turnDecision.selfKnowledgeRequestedAspects ?? [],
                    toolsAllowed: true,
                    writesAllowed: request.capabilitiesOverride?.allowWritesThisTurn === true,
                    reasonCodes: turnDecision.reasonCodes,
                },
            });
            bus.emit({
                executionId: meta.executionId,
                subsystem: 'agent',
                event: 'agent.self_knowledge_fallback_blocked',
                phase: 'classify',
                payload: {
                    turnId: turnDecision.turnId,
                    mode: meta.mode,
                    reasonCodes: ['self_knowledge_precedence_over_conversational_fallback'],
                },
            });
        }

        const modeEvent =
            turnDecision.mode === 'goal_execution'
                ? 'kernel.turn_mode_goal_execution'
                : turnDecision.mode === 'hybrid'
                    ? 'kernel.turn_mode_hybrid'
                    : 'kernel.turn_mode_conversational';
        bus.emit({
            executionId: meta.executionId,
            subsystem: 'kernel',
            event: modeEvent,
            phase: 'classify',
            payload: {
                turnId: turnDecision.turnId,
                authorityLevel: turnDecision.authorityLevel,
                activeGoalId: turnDecision.activeGoalId,
            },
        });

        if (turnDecision.shouldCreateGoal) {
            bus.emit({
                executionId: meta.executionId,
                subsystem: 'kernel',
                event: 'kernel.goal_created',
                phase: 'classify',
                payload: {
                    turnId: turnDecision.turnId,
                    createdGoalId: `pending:${meta.executionId}`,
                },
            });
        } else if (turnDecision.shouldResumeGoal && turnDecision.activeGoalId) {
            bus.emit({
                executionId: meta.executionId,
                subsystem: 'kernel',
                event: 'kernel.goal_resumed',
                phase: 'classify',
                payload: {
                    turnId: turnDecision.turnId,
                    activeGoalId: turnDecision.activeGoalId,
                },
            });
        }

        if (
            context.request.operatorMode === 'chat' &&
            (intent.containsBuildOrFixRequest || intent.hasExecutionVerb)
        ) {
            bus.emit({
                executionId: meta.executionId,
                subsystem: 'kernel',
                event: 'kernel.goal_promotion_rejected',
                phase: 'classify',
                payload: {
                    turnId: turnDecision.turnId,
                    reasonCode: 'operator_chat_override',
                },
            });
        } else if (turnDecision.mode === 'hybrid' && turnDecision.shouldResumeGoal) {
            bus.emit({
                executionId: meta.executionId,
                subsystem: 'kernel',
                event: 'kernel.goal_promotion_requested',
                phase: 'classify',
                payload: {
                    turnId: turnDecision.turnId,
                    activeGoalId: turnDecision.activeGoalId,
                },
            });
        }

        this._stateStore.advancePhase(meta.executionId, 'planning', 'turn_arbitration');
        console.log(`[AgentKernel] CLASSIFY id=${meta.executionId} mode=${turnDecision.mode} source=${turnDecision.source}`);
    }

    private async runDelegatedFlow(
        request: KernelRequest,
        meta: KernelExecutionMeta,
        onToken?: (token: string) => void,
        onEvent?: (type: string, data: any) => void
    ): Promise<ChatTurnResult> {
        const turnDecision = meta.turnArbitration;
        const envelope = meta.authorityEnvelope;
        if (!turnDecision || !envelope) {
            throw new Error('AgentKernel.runDelegatedFlow: missing immutable turn arbitration decision');
        }
        if (turnDecision.selfKnowledgeDetected) {
            const systemHealth = SystemModeManager.getSystemHealthSnapshot();
            const writesAllowedByMode = systemHealth?.mode_contract.writes_allowed ?? true;
            const writesAllowedByTurn = request.capabilitiesOverride?.allowWritesThisTurn === true;
            const allowWritesThisTurn = writesAllowedByTurn && writesAllowedByMode;
            const capabilityMatrix = systemHealth?.capability_matrix ?? [];
            const toolsCapability = capabilityMatrix.find((entry) => entry.capability === 'tool_execute_read');
            const toolsAllowed = !toolsCapability
                || toolsCapability.status === 'available'
                || toolsCapability.status === 'degraded';

            TelemetryBus.getInstance().emit({
                executionId: meta.executionId,
                subsystem: 'agent',
                event: 'agent.self_knowledge_routed',
                phase: 'delegate',
                payload: {
                    turnId: turnDecision.turnId,
                    mode: meta.mode,
                    requestedAspects: turnDecision.selfKnowledgeRequestedAspects ?? [],
                    toolsAllowed,
                    writesAllowed: allowWritesThisTurn,
                    reasonCodes: turnDecision.reasonCodes,
                },
            });

            const runtimeDiagnosticsSnapshot = (this.agent as unknown as {
                getRuntimeDiagnosticsSnapshot?: () => unknown;
            }).getRuntimeDiagnosticsSnapshot?.();
            const selfModelService = (this.agent as unknown as {
                getSelfModelQueryService?: () => {
                    queryCapabilities: () => { capabilities: Array<{ id: string }> };
                    queryInvariants: () => { invariants: Array<{ id: string; statement?: string }> };
                    getArchitectureSummary: () => {
                        totalInvariants?: number;
                        activeInvariants?: number;
                        totalCapabilities?: number;
                        availableCapabilities?: number;
                        totalComponents?: number;
                    };
                } | null;
            }).getSelfModelQueryService?.() ?? null;
            const selfKnowledgeResult = await this._selfKnowledgeExecution.executeSelfKnowledgeTurn({
                text: request.userMessage,
                mode: meta.mode,
                allowWritesThisTurn,
                toolsAllowedThisTurn: toolsAllowed,
                reasonCodes: turnDecision.reasonCodes,
                toolRegistry: {
                    getAllTools: () =>
                        (this.agent as unknown as {
                            getAllTools?: () => Array<{ name?: string; source?: string; description?: string }>;
                        }).getAllTools?.() ?? [],
                },
                selfModelService: selfModelService
                    ? {
                        queryCapabilities: () => selfModelService.queryCapabilities(),
                        queryInvariants: () => selfModelService.queryInvariants(),
                        getArchitectureSummary: () => selfModelService.getArchitectureSummary(),
                    }
                    : undefined,
                runtimeDiagnostics: runtimeDiagnosticsSnapshot
                    ? { getSnapshot: () => runtimeDiagnosticsSnapshot }
                    : undefined,
                filesystemPolicy: {
                    getAllowedRoot: () =>
                        (this.agent as unknown as { getWorkspaceRootPath?: () => string | undefined }).getWorkspaceRootPath?.()
                        ?? (typeof request.workspaceContext?.workspaceRoot === 'string'
                            ? request.workspaceContext.workspaceRoot
                            : undefined),
                    getWritePolicy: () =>
                        allowWritesThisTurn ? 'writes_allowed_this_turn' : 'writes_blocked_this_turn',
                },
            });

            if (selfKnowledgeResult.sourceTruths.length === 0) {
                TelemetryBus.getInstance().emit({
                    executionId: meta.executionId,
                    subsystem: 'agent',
                    event: 'agent.self_knowledge_source_unavailable',
                    phase: 'delegate',
                    payload: {
                        turnId: turnDecision.turnId,
                        mode: meta.mode,
                        requestedAspects: turnDecision.selfKnowledgeRequestedAspects ?? [],
                        sourceTruths: [],
                        toolsAllowed,
                        writesAllowed: allowWritesThisTurn,
                        reasonCodes: [...turnDecision.reasonCodes, 'self_knowledge.authority_sources_unavailable'],
                    },
                });
            }

            TelemetryBus.getInstance().emit({
                executionId: meta.executionId,
                subsystem: 'agent',
                event: 'agent.self_knowledge_snapshot_built',
                phase: 'delegate',
                payload: {
                    turnId: turnDecision.turnId,
                    mode: meta.mode,
                    requestedAspects: turnDecision.selfKnowledgeRequestedAspects ?? [],
                    sourceTruths: selfKnowledgeResult.sourceTruths,
                    toolsAllowed,
                    writesAllowed: allowWritesThisTurn,
                    runtimeDegraded: (selfKnowledgeResult.snapshot.runtime.degradedReasons?.length ?? 0) > 0,
                    reasonCodes: turnDecision.reasonCodes,
                },
            });
            TelemetryBus.getInstance().emit({
                executionId: meta.executionId,
                subsystem: 'agent',
                event: 'agent.self_knowledge_response_grounded',
                phase: 'delegate',
                payload: {
                    turnId: turnDecision.turnId,
                    mode: meta.mode,
                    requestedAspects: turnDecision.selfKnowledgeRequestedAspects ?? [],
                    sourceTruths: selfKnowledgeResult.sourceTruths,
                    toolsAllowed,
                    writesAllowed: allowWritesThisTurn,
                    runtimeDegraded: (selfKnowledgeResult.snapshot.runtime.degradedReasons?.length ?? 0) > 0,
                    reasonCodes: turnDecision.reasonCodes,
                },
            });
            turnDecision.selfKnowledgeSourceTruths = selfKnowledgeResult.sourceTruths;
            turnDecision.selfKnowledgeRouted = true;
            turnDecision.selfKnowledgeBypassedFallback = true;
            const followupToPersonaConversation = this._isFollowupToPersonaConversation(request);
            const turnPolicyLabel = meta.mode === 'rp'
                ? 'persona_truth_lock'
                : turnDecision.personaIdentityProtection === true
                    ? 'persona_identity_protection'
                    : 'allow_system_identity';
            const personaDisclosure = resolvePersonaIdentityDisclosure({
                activeMode: meta.mode,
                turnIntent: turnDecision.mode,
                turnPolicy: turnPolicyLabel,
                messageText: request.userMessage,
                isOperationalRequest: turnDecision.isOperationalSystemRequest,
                isSystemKnowledgeRequest: turnDecision.selfKnowledgeDetected,
                isFollowupToPersonaConversation: followupToPersonaConversation,
            });
            const adaptedSelfKnowledge = buildSelfKnowledgePersonaAdaptation({
                rawContent: selfKnowledgeResult.summary,
                selfKnowledgeSnapshot: selfKnowledgeResult.snapshot,
                activeMode: meta.mode,
                turnIntent: turnDecision.mode,
                turnPolicy: turnPolicyLabel,
                userMessage: request.userMessage,
                personaIdentityContext: {
                    characterName: selfKnowledgeResult.snapshot.identity.agentName,
                    worldview: selfKnowledgeResult.snapshot.identity.summary,
                    roleplayFrame: meta.mode,
                },
                isOperationalRequest: turnDecision.isOperationalSystemRequest,
                isSystemKnowledgeRequest: turnDecision.selfKnowledgeDetected,
                isFollowupToPersonaConversation: followupToPersonaConversation,
            });

            TelemetryBus.getInstance().emit({
                executionId: meta.executionId,
                subsystem: 'agent',
                event: AGENT_PERSONA_IDENTITY_EVENTS.gateApplied,
                phase: 'delegate',
                payload: {
                    turnId: turnDecision.turnId,
                    mode: meta.mode,
                    turnIntent: turnDecision.mode,
                    turnPolicy: turnPolicyLabel,
                    disclosureMode: personaDisclosure.disclosureMode,
                    enforcementMode: personaDisclosure.disclosureMode === 'enforce_persona_truth'
                        ? 'absolute_persona_lock'
                        : 'contextual_persona_gate',
                    isFollowupToPersonaConversation: followupToPersonaConversation,
                    routeSource: 'self_knowledge',
                    matchedMetaCategories: adaptedSelfKnowledge.matchedMetaCategories ?? [],
                    reasonCodes: adaptedSelfKnowledge.reasonCodes,
                },
            });
            if (personaDisclosure.disclosureMode === 'allow_system_identity') {
                TelemetryBus.getInstance().emit({
                    executionId: meta.executionId,
                    subsystem: 'agent',
                    event: AGENT_PERSONA_IDENTITY_EVENTS.systemDisclosureAllowed,
                    phase: 'delegate',
                    payload: {
                        turnId: turnDecision.turnId,
                        mode: meta.mode,
                        turnIntent: turnDecision.mode,
                        turnPolicy: turnPolicyLabel,
                        disclosureMode: personaDisclosure.disclosureMode,
                        enforcementMode: 'contextual_persona_gate',
                        isFollowupToPersonaConversation: followupToPersonaConversation,
                        routeSource: 'self_knowledge',
                        matchedMetaCategories: adaptedSelfKnowledge.matchedMetaCategories ?? [],
                        reasonCodes: adaptedSelfKnowledge.reasonCodes,
                    },
                });
            } else if (personaDisclosure.disclosureMode === 'enforce_persona_truth') {
                TelemetryBus.getInstance().emit({
                    executionId: meta.executionId,
                    subsystem: 'agent',
                    event: AGENT_PERSONA_IDENTITY_EVENTS.personaTruthEnforced,
                    phase: 'delegate',
                    payload: {
                        turnId: turnDecision.turnId,
                        mode: meta.mode,
                        turnIntent: turnDecision.mode,
                        turnPolicy: turnPolicyLabel,
                        disclosureMode: personaDisclosure.disclosureMode,
                        enforcementMode: 'absolute_persona_lock',
                        isFollowupToPersonaConversation: followupToPersonaConversation,
                        routeSource: 'self_knowledge',
                        matchedMetaCategories: adaptedSelfKnowledge.matchedMetaCategories ?? [],
                        reasonCodes: adaptedSelfKnowledge.reasonCodes,
                    },
                });
                TelemetryBus.getInstance().emit({
                    executionId: meta.executionId,
                    subsystem: 'agent',
                    event: AGENT_PERSONA_IDENTITY_EVENTS.personaTruthCanonSelected,
                    phase: 'delegate',
                    payload: {
                        turnId: turnDecision.turnId,
                        mode: meta.mode,
                        turnIntent: turnDecision.mode,
                        turnPolicy: turnPolicyLabel,
                        disclosureMode: personaDisclosure.disclosureMode,
                        enforcementMode: 'absolute_persona_lock',
                        isFollowupToPersonaConversation: followupToPersonaConversation,
                        routeSource: 'self_knowledge',
                        matchedMetaCategories: adaptedSelfKnowledge.matchedMetaCategories ?? [],
                        reasonCodes: adaptedSelfKnowledge.reasonCodes,
                    },
                });
                if ((adaptedSelfKnowledge.matchedMetaCategories?.length ?? 0) > 0) {
                    TelemetryBus.getInstance().emit({
                        executionId: meta.executionId,
                        subsystem: 'agent',
                        event: AGENT_PERSONA_IDENTITY_EVENTS.personaTruthMetaRewriteApplied,
                        phase: 'delegate',
                        payload: {
                            turnId: turnDecision.turnId,
                            mode: meta.mode,
                            turnIntent: turnDecision.mode,
                            turnPolicy: turnPolicyLabel,
                            disclosureMode: personaDisclosure.disclosureMode,
                            enforcementMode: 'absolute_persona_lock',
                            isFollowupToPersonaConversation: followupToPersonaConversation,
                            routeSource: 'self_knowledge',
                            matchedMetaCategories: adaptedSelfKnowledge.matchedMetaCategories ?? [],
                            reasonCodes: adaptedSelfKnowledge.reasonCodes,
                        },
                    });
                    TelemetryBus.getInstance().emit({
                        executionId: meta.executionId,
                        subsystem: 'agent',
                        event: AGENT_PERSONA_IDENTITY_EVENTS.personaTruthMetaDisclosureBlocked,
                        phase: 'delegate',
                        payload: {
                            turnId: turnDecision.turnId,
                            mode: meta.mode,
                            turnIntent: turnDecision.mode,
                            turnPolicy: turnPolicyLabel,
                            disclosureMode: personaDisclosure.disclosureMode,
                            enforcementMode: 'absolute_persona_lock',
                            isFollowupToPersonaConversation: followupToPersonaConversation,
                            routeSource: 'self_knowledge',
                            matchedMetaCategories: adaptedSelfKnowledge.matchedMetaCategories ?? [],
                            reasonCodes: adaptedSelfKnowledge.reasonCodes,
                        },
                    });
                } else if (adaptedSelfKnowledge.adaptationMode === 'persona_block') {
                    TelemetryBus.getInstance().emit({
                        executionId: meta.executionId,
                        subsystem: 'agent',
                        event: AGENT_PERSONA_IDENTITY_EVENTS.personaTruthMetaDisclosureBlocked,
                        phase: 'delegate',
                        payload: {
                            turnId: turnDecision.turnId,
                            mode: meta.mode,
                            turnIntent: turnDecision.mode,
                            turnPolicy: turnPolicyLabel,
                            disclosureMode: personaDisclosure.disclosureMode,
                            enforcementMode: 'absolute_persona_lock',
                            isFollowupToPersonaConversation: followupToPersonaConversation,
                            routeSource: 'self_knowledge',
                            matchedMetaCategories: adaptedSelfKnowledge.matchedMetaCategories ?? [],
                            reasonCodes: adaptedSelfKnowledge.reasonCodes,
                        },
                    });
                }
            } else if (adaptedSelfKnowledge.adaptationMode === 'persona_block') {
                TelemetryBus.getInstance().emit({
                    executionId: meta.executionId,
                    subsystem: 'agent',
                    event: AGENT_PERSONA_IDENTITY_EVENTS.metaDisclosureBlocked,
                    phase: 'delegate',
                    payload: {
                        turnId: turnDecision.turnId,
                        mode: meta.mode,
                        turnIntent: turnDecision.mode,
                        turnPolicy: turnPolicyLabel,
                        disclosureMode: personaDisclosure.disclosureMode,
                        enforcementMode: 'contextual_persona_gate',
                        isFollowupToPersonaConversation: followupToPersonaConversation,
                        routeSource: 'self_knowledge',
                        matchedMetaCategories: adaptedSelfKnowledge.matchedMetaCategories ?? [],
                        reasonCodes: adaptedSelfKnowledge.reasonCodes,
                    },
                });
            } else if (adaptedSelfKnowledge.adaptationMode === 'persona_transform') {
                TelemetryBus.getInstance().emit({
                    executionId: meta.executionId,
                    subsystem: 'agent',
                    event: AGENT_PERSONA_IDENTITY_EVENTS.responseTransformed,
                    phase: 'delegate',
                    payload: {
                        turnId: turnDecision.turnId,
                        mode: meta.mode,
                        turnIntent: turnDecision.mode,
                        turnPolicy: turnPolicyLabel,
                        disclosureMode: personaDisclosure.disclosureMode,
                        enforcementMode: 'contextual_persona_gate',
                        isFollowupToPersonaConversation: followupToPersonaConversation,
                        routeSource: 'self_knowledge',
                        matchedMetaCategories: adaptedSelfKnowledge.matchedMetaCategories ?? [],
                        reasonCodes: adaptedSelfKnowledge.reasonCodes,
                    },
                });
            }

            const turnResult = this._assistantResponse(
                adaptedSelfKnowledge.content,
                'self_knowledge',
                adaptedSelfKnowledge.outputChannel
                    ?? (selfKnowledgeResult.blockedReason ? 'fallback' : 'chat'),
            );
            const normalizedSelfKnowledgeMessage = normalizeAssistantOutput(turnResult.message);
            this._emitTurnResponseEvent(meta, AGENT_RESPONSE_RUNTIME_EVENTS.selfKnowledgeResponseCreated, {
                source: 'self_knowledge',
                responseArtifactPresent: true,
                failureArtifactPresent: false,
                channel: normalizedSelfKnowledgeMessage.outputChannel,
            });
            this._emitTurnResponseEvent(meta, AGENT_RESPONSE_RUNTIME_EVENTS.turnResponseCreated, {
                source: 'self_knowledge',
                responseArtifactPresent: true,
                failureArtifactPresent: false,
                channel: normalizedSelfKnowledgeMessage.outputChannel,
            });
            return turnResult;
        }
        if (turnDecision.selfInspectionRequest) {
            const systemHealth = SystemModeManager.getSystemHealthSnapshot();
            const writesAllowedByMode = systemHealth?.mode_contract.writes_allowed ?? true;
            const writesAllowedByTurn = request.capabilitiesOverride?.allowWritesThisTurn === true;
            const allowWritesThisTurn = writesAllowedByTurn && writesAllowedByMode;
            TelemetryBus.getInstance().emit({
                executionId: meta.executionId,
                subsystem: 'agent',
                event: 'agent.self_inspection_routed',
                phase: 'delegate',
                payload: {
                    turnId: turnDecision.turnId,
                    originalIntent: 'kernel_turn_intent',
                    resolvedIntent: 'self_inspection',
                    mode: meta.mode,
                    requestedOperation: turnDecision.selfInspectionOperation ?? 'unknown',
                    requestedPaths: turnDecision.selfInspectionRequestedPaths ?? [],
                    toolsAllowed: true,
                    writesAllowed: allowWritesThisTurn,
                    reasonCodes: turnDecision.reasonCodes,
                },
            });
            const selfInspectionResult = await this._selfInspectionExecution.executeSelfInspectionTurn({
                text: request.userMessage,
                allowWritesThisTurn,
                toolExecutionCoordinator: {
                    executeTool: async (name: string, args: Record<string, unknown>) =>
                        this.agent.executeTool(name, args),
                },
            });
            for (const call of selfInspectionResult.toolCalls) {
                TelemetryBus.getInstance().emit({
                    executionId: meta.executionId,
                    subsystem: 'agent',
                    event: 'agent.self_inspection_tool_attempted',
                    phase: 'delegate',
                    payload: {
                        turnId: turnDecision.turnId,
                        toolId: call.toolId,
                        requestedOperation: selfInspectionResult.operation,
                        requestedPaths: turnDecision.selfInspectionRequestedPaths ?? [],
                        reasonCodes: turnDecision.reasonCodes,
                    },
                });
            }
            if (selfInspectionResult.blockedReason === 'write_not_allowed_this_turn') {
                TelemetryBus.getInstance().emit({
                    executionId: meta.executionId,
                    subsystem: 'agent',
                    event: 'agent.self_inspection_write_blocked',
                    phase: 'delegate',
                    payload: {
                        turnId: turnDecision.turnId,
                        requestedOperation: selfInspectionResult.operation,
                        requestedPaths: turnDecision.selfInspectionRequestedPaths ?? [],
                        toolsAllowed: true,
                        writesAllowed: false,
                        reasonCodes: [...turnDecision.reasonCodes, 'write_not_allowed_this_turn'],
                    },
                });
            }
            const selfInspectionSucceeded = !selfInspectionResult.blockedReason
                || selfInspectionResult.blockedReason === 'write_not_allowed_this_turn';
            TelemetryBus.getInstance().emit({
                executionId: meta.executionId,
                subsystem: 'agent',
                event: selfInspectionSucceeded
                    ? 'agent.self_inspection_tool_succeeded'
                    : 'agent.self_inspection_tool_failed',
                phase: selfInspectionSucceeded ? 'delegate' : 'failed',
                payload: {
                    turnId: turnDecision.turnId,
                    requestedOperation: selfInspectionResult.operation,
                    requestedPaths: turnDecision.selfInspectionRequestedPaths ?? [],
                    toolsAllowed: true,
                    writesAllowed: allowWritesThisTurn,
                    blockedReason: selfInspectionResult.blockedReason,
                    reasonCodes: turnDecision.reasonCodes,
                },
            });
            const turnResult = this._assistantResponse(
                selfInspectionResult.summary,
                'self_inspection',
                selfInspectionResult.blockedReason ? 'fallback' : 'chat',
            );
            const normalizedSelfInspectionMessage = normalizeAssistantOutput(turnResult.message);
            this._emitTurnResponseEvent(meta, AGENT_RESPONSE_RUNTIME_EVENTS.turnResponseCreated, {
                source: 'self_inspection',
                responseArtifactPresent: true,
                failureArtifactPresent: false,
                channel: normalizedSelfInspectionMessage.outputChannel,
            });
            return turnResult;
        }

        if (turnDecision.mode === 'goal_execution') {
            if (!PlanningLoopService.isInitialized()) {
                throw new Error('PlanningLoopService unavailable for goal_execution turn');
            }

            this._stateStore.advancePhase(meta.executionId, 'executing', 'goal_execution_loop');
            this._chatLoopExecutor.setStreamCallbacks(onToken, onEvent, request.images, envelope);
            const loop = PlanningLoopService.getInstance();
            const loopRun = await loop.startLoop({
                goal: request.userMessage,
                contextSummary: {
                    executionId: meta.executionId,
                    origin: meta.origin,
                    mode: meta.mode,
                    turnMode: turnDecision.mode,
                },
                iterationPolicyInput: {
                    turnMode: turnDecision.mode,
                    operatorMode: request.operatorMode ?? 'auto',
                    authorityLevel: turnDecision.authorityLevel,
                    recoveryMode: false,
                    autonomousMode: isAutonomousExecutionOrigin(meta.origin),
                    sideEffectSensitive: isOperatorSensitiveExecution(request.userMessage),
                    approvalGranted: false,
                },
                planningInvocation: {
                    invokedBy: 'agent_kernel',
                    invocationReason: 'goal_execution_turn',
                    turnId: turnDecision.turnId,
                    turnMode: turnDecision.mode,
                    authorityLevel: turnDecision.authorityLevel,
                    memoryWriteMode: turnDecision.memoryWriteMode,
                },
            });

            if (loopRun.phase !== 'completed') {
                const blockedReason = [loopRun.failureReason, loopRun.failureDetail]
                    .filter((value): value is string => Boolean(value && value.trim().length > 0))
                    .join(':') || 'unknown';

                if (loopRun.failureReason !== 'plan_blocked') {
                    throw new Error(
                        `goal_execution loop terminated with phase=${loopRun.phase} reason=${blockedReason}`,
                    );
                }

                const healthSnapshot = SystemModeManager.getSystemHealthSnapshot();
                const availableCapabilities = new Set(
                    (healthSnapshot?.capability_matrix ?? [])
                        .filter((capability) => capability.status === 'available' || capability.status === 'degraded')
                        .map((capability) => capability.capability),
                );
                const degradedAutonomy = healthSnapshot?.effective_mode === 'DEGRADED_AUTONOMY'
                    || Boolean(healthSnapshot?.active_degradation_flags.includes('DEGRADED_AUTONOMY'));
                const policyGateDegraded = Boolean(
                    healthSnapshot?.subsystem_entries.some(
                        (entry) => entry.name.toLowerCase().includes('policy') && entry.status !== 'healthy',
                    ),
                );
                const taskClass = classifyPlanBlockedTaskClass(request.userMessage);

                TelemetryBus.getInstance().emit({
                    executionId: meta.executionId,
                    subsystem: 'planning',
                    event: 'planning.plan_blocked_recovery_requested',
                    phase: 'delegate',
                    payload: {
                        executionId: meta.executionId,
                        executionBoundaryId: loopRun.executionBoundaryId ?? meta.executionId,
                        goalId: loopRun.goalId,
                        planId: loopRun.currentPlanId,
                        blockedReason,
                        degradedAutonomy,
                    },
                });

                const recoveryDecision = resolvePlanBlockedRecovery({
                    blockedReason,
                    activeMode: healthSnapshot?.effective_mode ?? meta.mode,
                    autonomyDegraded: degradedAutonomy,
                    policyGateDegraded,
                    availableCapabilities,
                    taskClass,
                    planId: loopRun.currentPlanId,
                    goalId: loopRun.goalId,
                });

                TelemetryBus.getInstance().emit({
                    executionId: meta.executionId,
                    subsystem: 'planning',
                    event: 'planning.plan_blocked_recovery_resolved',
                    phase: 'delegate',
                    payload: {
                        executionId: meta.executionId,
                        executionBoundaryId: loopRun.executionBoundaryId ?? meta.executionId,
                        goalId: loopRun.goalId,
                        planId: loopRun.currentPlanId,
                        blockedReason,
                        degradedAutonomy,
                        recoveryAction: recoveryDecision.action,
                        reasonCode: recoveryDecision.reasonCode,
                    },
                });

                if (recoveryDecision.action === 'degrade_to_chat') {
                    const degradedDecision = PlanningLoopAuthorityRouter.classifyDegradedExecution(
                        'plan_blocked',
                        { detectedIn: 'AgentKernel.runDelegatedFlow' },
                    );
                    TelemetryBus.getInstance().emit({
                        executionId: meta.executionId,
                        subsystem: 'planning',
                        event: 'planning.degraded_execution_decision',
                        phase: 'delegate',
                        payload: {
                            reason: degradedDecision.reason,
                            directAllowed: degradedDecision.directAllowed,
                            degradedModeCode: degradedDecision.degradedModeCode,
                            doctrine: degradedDecision.doctrine,
                            detectedIn: degradedDecision.detectedIn,
                            detectedAt: degradedDecision.detectedAt,
                        },
                    });
                    if (!degradedDecision.directAllowed) {
                        throw new Error(
                            `goal_execution plan_blocked recovery denied reason=${recoveryDecision.reasonCode}`,
                        );
                    }
                    TelemetryBus.getInstance().emit({
                        executionId: meta.executionId,
                        subsystem: 'planning',
                        event: 'planning.authority_lane_resolved',
                        phase: 'delegate',
                        payload: {
                            authorityLane: 'chat_continuity_degraded_direct',
                            routingClassification: meta.routingDecision?.classification ?? 'planning_loop_required',
                            reasonCodes: meta.turnArbitration?.reasonCodes ?? [],
                            executionBoundaryId: loopRun.executionBoundaryId ?? meta.executionId,
                            policyOutcome: 'allowed',
                            resolvedAt: new Date().toISOString(),
                            summary: 'chat continuity fallback after plan_blocked',
                            degradedExecutionDecision: degradedDecision,
                        },
                    });
                    TelemetryBus.getInstance().emit({
                        executionId: meta.executionId,
                        subsystem: 'kernel',
                        event: 'execution.degraded_fallback_applied',
                        phase: 'delegate',
                        payload: {
                            executionId: meta.executionId,
                            executionBoundaryId: loopRun.executionBoundaryId ?? meta.executionId,
                            goalId: loopRun.goalId,
                            planId: loopRun.currentPlanId,
                            blockedReason,
                            recoveryAction: recoveryDecision.action,
                            reasonCode: recoveryDecision.reasonCode,
                            degradedAutonomy,
                        },
                    });
                    const output = await this._runDirectChatFallback(request, meta, turnDecision, envelope, onToken, onEvent);
                    TelemetryBus.getInstance().emit({
                        executionId: meta.executionId,
                        subsystem: 'planning',
                        event: 'planning.plan_blocked_recovered',
                        phase: 'delegate',
                        payload: {
                            executionId: meta.executionId,
                            executionBoundaryId: loopRun.executionBoundaryId ?? meta.executionId,
                            goalId: loopRun.goalId,
                            planId: loopRun.currentPlanId,
                            blockedReason,
                            recoveryAction: recoveryDecision.action,
                            reasonCode: recoveryDecision.reasonCode,
                            degradedAutonomy,
                        },
                    });
                    return output;
                }

                if (recoveryDecision.action === 'replan') {
                    if (!loopRun.goalId || !loopRun.currentPlanId) {
                        throw new Error(
                            'goal_execution plan_blocked replan requested without goalId/currentPlanId',
                        );
                    }
                    try {
                        PlanningService.getInstance().replan(
                            {
                                goalId: loopRun.goalId,
                                priorPlanId: loopRun.currentPlanId,
                                trigger: blockedReason.includes('policy') ? 'policy_block' : 'dependency_failure',
                                triggerDetails: `plan_blocked_recovery:${recoveryDecision.reasonCode}`,
                            },
                            {
                                invokedBy: 'agent_kernel',
                                invocationReason: 'replan_after_execution_failure',
                                turnId: turnDecision.turnId,
                                turnMode: turnDecision.mode,
                                authorityLevel: turnDecision.authorityLevel,
                                memoryWriteMode: turnDecision.memoryWriteMode,
                            },
                        );
                    } catch (error) {
                        const failureDetail = error instanceof Error ? error.message : String(error);
                        TelemetryBus.getInstance().emit({
                            executionId: meta.executionId,
                            subsystem: 'planning',
                            event: 'planning.plan_blocked_escalated',
                            phase: 'delegate',
                            payload: {
                                executionId: meta.executionId,
                                executionBoundaryId: loopRun.executionBoundaryId ?? meta.executionId,
                                goalId: loopRun.goalId,
                                planId: loopRun.currentPlanId,
                                blockedReason,
                                recoveryAction: 'escalate',
                                reasonCode: 'plan_blocked.recover.escalate.replan_failed',
                                degradedAutonomy,
                                failureDetail,
                            },
                        });
                        const failure = this._assistantResponse(
                            'Planning recovery requested a replan, but replan could not be completed and has been escalated.',
                            'other',
                            'fallback',
                        );
                        this._emitTurnResponseEvent(meta, AGENT_RESPONSE_RUNTIME_EVENTS.turnResponseCreated, {
                            source: 'other',
                            responseArtifactPresent: true,
                            failureArtifactPresent: false,
                            channel: 'fallback',
                        });
                        return failure;
                    }
                    TelemetryBus.getInstance().emit({
                        executionId: meta.executionId,
                        subsystem: 'planning',
                        event: 'planning.plan_blocked_recovered',
                        phase: 'delegate',
                        payload: {
                            executionId: meta.executionId,
                            executionBoundaryId: loopRun.executionBoundaryId ?? meta.executionId,
                            goalId: loopRun.goalId,
                            planId: loopRun.currentPlanId,
                            blockedReason,
                            recoveryAction: recoveryDecision.action,
                            reasonCode: recoveryDecision.reasonCode,
                            degradedAutonomy,
                        },
                    });
                    const response = this._assistantResponse(
                        'Planning recovered by requesting a deterministic replan. Please continue with the updated goal execution path.',
                        'other',
                        'fallback',
                    );
                    this._emitTurnResponseEvent(meta, AGENT_RESPONSE_RUNTIME_EVENTS.turnResponseCreated, {
                        source: 'other',
                        responseArtifactPresent: true,
                        failureArtifactPresent: false,
                        channel: 'fallback',
                    });
                    return response;
                }

                if (recoveryDecision.action === 'escalate') {
                    TelemetryBus.getInstance().emit({
                        executionId: meta.executionId,
                        subsystem: 'planning',
                        event: 'planning.plan_blocked_escalated',
                        phase: 'delegate',
                        payload: {
                            executionId: meta.executionId,
                            executionBoundaryId: loopRun.executionBoundaryId ?? meta.executionId,
                            goalId: loopRun.goalId,
                            planId: loopRun.currentPlanId,
                            blockedReason,
                            recoveryAction: recoveryDecision.action,
                            reasonCode: recoveryDecision.reasonCode,
                            degradedAutonomy,
                        },
                    });
                    const response = this._assistantResponse(
                        recoveryDecision.userSafeMessage
                            ?? 'Planning is blocked and has been escalated for operator action.',
                        'other',
                        'fallback',
                    );
                    this._emitTurnResponseEvent(meta, AGENT_RESPONSE_RUNTIME_EVENTS.turnResponseCreated, {
                        source: 'other',
                        responseArtifactPresent: true,
                        failureArtifactPresent: false,
                        channel: 'fallback',
                    });
                    return response;
                }

                TelemetryBus.getInstance().emit({
                    executionId: meta.executionId,
                    subsystem: 'planning',
                    event: 'planning.plan_blocked_terminated',
                    phase: 'failed',
                    payload: {
                        executionId: meta.executionId,
                        executionBoundaryId: loopRun.executionBoundaryId ?? meta.executionId,
                        goalId: loopRun.goalId,
                        planId: loopRun.currentPlanId,
                        blockedReason,
                        recoveryAction: recoveryDecision.action,
                        reasonCode: recoveryDecision.reasonCode,
                        degradedAutonomy,
                    },
                });
                throw new Error(
                    `goal_execution plan_blocked terminated reasonCode=${recoveryDecision.reasonCode} blockedReason=${blockedReason}`,
                );
            }

            const executorResult = this._chatLoopExecutor.getLastExecutionResult();
            if (!executorResult) {
                throw new Error('goal_execution loop completed without executor result');
            }
            TelemetryBus.getInstance().emit({
                executionId: meta.executionId,
                subsystem: 'planning',
                event: 'planning.authority_lane_resolved',
                phase: 'delegate',
                payload: {
                    authorityLane: 'planning_loop',
                    routingClassification: meta.routingDecision?.classification ?? 'planning_loop_required',
                    reasonCodes: meta.turnArbitration?.reasonCodes ?? [],
                    executionBoundaryId: meta.executionId,
                    policyOutcome: 'allowed',
                    resolvedAt: new Date().toISOString(),
                    summary: 'planning_loop: selected by kernel turn arbitration',
                },
            });
            const turnResult = this._toChatTurnResult(executorResult, 'other');
            this._emitTurnResponseEvent(
                meta,
                turnResult.kind === 'assistant_response'
                    ? AGENT_RESPONSE_RUNTIME_EVENTS.turnResponseCreated
                    : AGENT_RESPONSE_RUNTIME_EVENTS.turnResponseMissing,
                {
                    source: turnResult.source,
                    responseArtifactPresent: turnResult.kind === 'assistant_response',
                    failureArtifactPresent: turnResult.kind === 'turn_failure',
                    channel: turnResult.kind === 'assistant_response'
                        ? (turnResult.message.outputChannel ?? 'chat')
                        : 'fallback',
                    errorCode: turnResult.kind === 'turn_failure' ? turnResult.errorCode : undefined,
                },
            );
            return turnResult;
        }

        this._stateStore.advancePhase(meta.executionId, 'executing', turnDecision.mode);
        TelemetryBus.getInstance().emit({
            executionId: meta.executionId,
            subsystem: 'planning',
            event: 'planning.authority_lane_resolved',
            phase: 'delegate',
            payload: {
                authorityLane: 'trivial_direct',
                routingClassification: meta.routingDecision?.classification ?? 'trivial_direct_allowed',
                reasonCodes: meta.turnArbitration?.reasonCodes ?? [],
                executionBoundaryId: meta.executionId,
                policyOutcome: 'allowed',
                resolvedAt: new Date().toISOString(),
                summary: `trivial_direct: kernel mode ${turnDecision.mode}`,
            },
        });
        const output = await this.agent.chat(
            request.userMessage,
            onToken,
            onEvent,
            request.images,
            this._composeCapabilitiesOverride(request.capabilitiesOverride, turnDecision, envelope),
        );
        const turnResult = this._toChatTurnResult(output, 'router');
        this._emitTurnResponseEvent(
            meta,
            turnResult.kind === 'assistant_response'
                ? AGENT_RESPONSE_RUNTIME_EVENTS.turnResponseCreated
                : AGENT_RESPONSE_RUNTIME_EVENTS.turnResponseMissing,
            {
                source: turnResult.source,
                responseArtifactPresent: turnResult.kind === 'assistant_response',
                failureArtifactPresent: turnResult.kind === 'turn_failure',
                channel: turnResult.kind === 'assistant_response'
                    ? (turnResult.message.outputChannel ?? 'chat')
                    : 'fallback',
                errorCode: turnResult.kind === 'turn_failure' ? turnResult.errorCode : undefined,
            },
        );
        return turnResult;
    }

    private async _runDirectChatFallback(
        request: KernelRequest,
        meta: KernelExecutionMeta,
        turnDecision: TurnArbitrationDecision,
        envelope: TurnAuthorityEnvelope,
        onToken?: (token: string) => void,
        onEvent?: (type: string, data: any) => void,
    ): Promise<ChatTurnResult> {
        this._stateStore.advancePhase(meta.executionId, 'executing', 'goal_execution_degraded_fallback');
        const output = await this.agent.chat(
            request.userMessage,
            onToken,
            onEvent,
            request.images,
            this._composeCapabilitiesOverride(request.capabilitiesOverride, turnDecision, envelope),
        );
        return this._toChatTurnResult(output, 'router');
    }

    private finalizeExecution(meta: KernelExecutionMeta, turnResult: ChatTurnResult, request: KernelRequest): KernelResult {
        meta.durationMs = Date.now() - meta.startedAt;
        turnResult = this._normalizeAssistantTurnResult(turnResult);
        const responseArtifactPresent = turnResult.kind === 'assistant_response'
            && (turnResult.message.content.trim().length > 0 || typeof turnResult.message.artifactId === 'string');
        const failureArtifactPresent = turnResult.kind === 'turn_failure';
        const channel = turnResult.kind === 'assistant_response'
            ? (turnResult.message.outputChannel ?? 'chat')
            : 'fallback';
        console.log(`[AgentKernel] FINALIZE id=${meta.executionId} duration=${meta.durationMs}ms channel=${channel}`);

        if (!responseArtifactPresent && !failureArtifactPresent) {
            const missingSource = turnResult.source;
            this._emitTurnResponseEvent(meta, AGENT_RESPONSE_RUNTIME_EVENTS.turnResponseMissing, {
                source: missingSource,
                responseArtifactPresent: false,
                failureArtifactPresent: false,
                channel: 'fallback',
                errorCode: 'chat_turn_missing_response_artifact',
            });
            if (missingSource === 'self_knowledge') {
                this._emitTurnResponseEvent(meta, AGENT_RESPONSE_RUNTIME_EVENTS.selfKnowledgeResponseMissing, {
                    source: missingSource,
                    responseArtifactPresent: false,
                    failureArtifactPresent: false,
                    channel: 'fallback',
                    errorCode: 'chat_turn_missing_response_artifact',
                });
            }
            turnResult = this._turnFailure(
                'chat_turn_missing_response_artifact',
                'Turn reached finalize without response or failure artifact.',
                missingSource,
            );
        }

        const turnOutput: AgentTurnOutput = turnResult.kind === 'assistant_response'
            ? {
                message: turnResult.message.content,
                outputChannel: turnResult.message.outputChannel ?? 'chat',
            }
            : {
                message: turnResult.message,
                outputChannel: 'fallback',
            };

        if (turnResult.kind === 'assistant_response' && (turnResult.source === 'self_knowledge' || turnResult.source === 'self_inspection')) {
            this.agent.publishAuthorityTurnToSession({
                userMessage: request.userMessage,
                assistantMessage: turnResult.message.content,
                images: request.images,
            });
        }

        // Advance to 'finalizing' before sealing the terminal record.
        this._stateStore.advancePhase(meta.executionId, 'finalizing', 'finalizing');

        // execution.finalizing — entering the finalization stage
        TelemetryBus.getInstance().emit({
            executionId: meta.executionId,
            subsystem: 'kernel',
            event: 'execution.finalizing',
            phase: 'finalizing',
            payload: { type: meta.executionType, origin: meta.origin, mode: meta.mode, durationMs: meta.durationMs },
        });

        const executionState = this._stateStore.completeExecution(meta.executionId)
            ?? setExecutionTerminalState(
                createInitialExecutionState(this._buildExecRequest(meta, request.userMessage), 'AgentKernel'),
                { status: 'completed' },
            );

        TelemetryBus.getInstance().emit({
            executionId: meta.executionId,
            subsystem: 'kernel',
            event: 'execution.completed',
            phase: 'finalizing',
            payload: { type: meta.executionType, origin: meta.origin, mode: meta.mode, durationMs: meta.durationMs },
        });

        return { ...turnOutput, meta, executionState, turnResult };
    }

    // ─── Public entrypoint ──────────────────────────────────────────────────

    /**
     * Execute a single agent turn through the full kernel pipeline.
     *
     *   normalizeRequest → intake → classifyExecution → runDelegatedFlow → finalizeExecution
     *
     * Each stage is a named seam.  Existing behavior is entirely preserved:
     * all substantive work happens inside AgentService.chat() via runDelegatedFlow().
     */
    public async execute(
        request: KernelRequest,
        onToken?: (token: string) => void,
        onEvent?: (type: string, data: any) => void
    ): Promise<KernelResult> {
        // Stage 1 -- normalizeRequest
        const normalized = this.normalizeRequest(request);

        // Stage 2 -- intake (stamps metadata and registers initial ExecutionState)
        const meta = this.intake(normalized, 'chat_turn');

        try {
            // Stage 3 -- classifyExecution
            this.classifyExecution(normalized, meta);

            // Stage 4 -- runDelegatedFlow (advances state to 'executing')
            const turnOutput = await this.runDelegatedFlow(normalized, meta, onToken, onEvent);

            // Stage 5 -- finalizeExecution (finalizes state to 'completed')
            const finalized = this.finalizeExecution(meta, turnOutput, normalized);
            this._updatePersonaContinuity(normalized, meta);
            return finalized;
        } catch (err: unknown) {
            // A PolicyDeniedError means execution.blocked was already emitted and
            // the state was already marked 'blocked' in classifyExecution().
            // Do not overwrite the state or double-emit execution.failed.
            if (err instanceof PolicyDeniedError) {
                throw err;
            }

            // On any other pipeline error, mark the stored state as 'failed' before re-throwing.
            const failureReason = err instanceof Error ? err.message : String(err);
            this._stateStore.failExecution(meta.executionId, failureReason);

            // execution.failed — execution terminated due to an unrecoverable error
            TelemetryBus.getInstance().emit({
                executionId: meta.executionId,
                subsystem: 'kernel',
                event: 'execution.failed',
                phase: 'failed',
                payload: { type: meta.executionType, origin: meta.origin, mode: meta.mode, failureReason },
            });

            throw err;
        }
    }
}





