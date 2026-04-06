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
import { createInitialExecutionState, createExecutionRequest, finalizeExecutionState } from '../../../shared/runtime/executionHelpers';
import { ExecutionStateStore } from './ExecutionStateStore';
import { TelemetryBus } from '../telemetry/TelemetryBus';

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

    constructor(agent: AgentService) {
        this.agent = agent;
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

    // ─── Stage 1: normalizeRequest ──────────────────────────────────────────
    // Validates and normalizes the inbound request before anything else runs.
    // Future: coerce malformed payloads, strip disallowed fields, source ACL.

    private normalizeRequest(raw: KernelRequest): KernelRequest {
        return {
            userMessage: raw.userMessage ?? '',
            images: raw.images ?? [],
            capabilitiesOverride: raw.capabilitiesOverride,
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
    // Future: mode detection, tool-need prediction, policy gate, context assembly.

    private classifyExecution(request: KernelRequest, meta: KernelExecutionMeta): void {
        // Advance state to 'planning' to mark that the kernel is evaluating the turn.
        // Future: mode detection, tool-need prediction, policy gate, context assembly.
        this._stateStore.advancePhase(meta.executionId, 'planning', 'classifying');
        console.log(`[AgentKernel] ── CLASSIFY         ── id=${meta.executionId} class=${meta.executionClass}`);
    }

    // ─── Stage 4: runDelegatedFlow ──────────────────────────────────────────
    // Hands off to AgentService.chat() — all existing orchestration unchanged.
    // Future: inference orchestration boundary, tool execution coordination,
    //         memory write coordination.

    private async runDelegatedFlow(
        request: KernelRequest,
        meta: KernelExecutionMeta,
        onToken?: (token: string) => void,
        onEvent?: (type: string, data: any) => void
    ): Promise<AgentTurnOutput> {
        console.log(`[AgentKernel] ── DELEGATE         ── id=${meta.executionId} class=${meta.executionClass}`);

        // Advance execution state to 'executing' before handing off to AgentService.
        this._stateStore.advancePhase(meta.executionId, 'executing', 'delegated_flow');

        return this.agent.chat(
            request.userMessage,
            onToken,
            onEvent,
            request.images,
            request.capabilitiesOverride
        );
    }

    // ─── Stage 5: finalizeExecution ─────────────────────────────────────────
    // Records wall-clock duration, builds terminal ExecutionState, and assembles
    // the KernelResult.
    // Future: post-turn telemetry emission, outcome learning, audit records.

    private finalizeExecution(meta: KernelExecutionMeta, turnOutput: AgentTurnOutput, request: KernelRequest): KernelResult {
        meta.durationMs = Date.now() - meta.startedAt;
        console.log(`[AgentKernel] ── FINALIZE         ── id=${meta.executionId} duration=${meta.durationMs}ms channel=${turnOutput.outputChannel ?? 'chat'}`);

        // Advance to 'finalizing' before sealing the terminal record.
        this._stateStore.advancePhase(meta.executionId, 'finalizing', 'finalizing');

        // Seal the terminal state as 'completed'. Fall back to a freshly-constructed
        // state only in the unlikely case the store entry was evicted externally.
        const executionState = this._stateStore.completeExecution(meta.executionId)
            ?? finalizeExecutionState(
                createInitialExecutionState(this._buildExecRequest(meta, request.userMessage), 'AgentKernel'),
                { status: 'completed' }
            );

        // execution.completed — execution finalized cleanly
        TelemetryBus.getInstance().emit({
            executionId: meta.executionId,
            subsystem: 'kernel',
            event: 'execution.completed',
            phase: 'finalizing',
            payload: { type: meta.executionType, origin: meta.origin, mode: meta.mode, durationMs: meta.durationMs },
        });

        return { ...turnOutput, meta, executionState };
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
            return this.finalizeExecution(meta, turnOutput, normalized);
        } catch (err: unknown) {
            // On any pipeline error, mark the stored state as 'failed' before re-throwing.
            this._stateStore.failExecution(
                meta.executionId,
                err instanceof Error ? err.message : String(err)
            );
            throw err;
        }
    }
}
