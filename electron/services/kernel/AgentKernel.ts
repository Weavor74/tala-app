import { v4 as uuidv4 } from 'uuid';
import type { AgentService } from '../AgentService';
import type { AgentTurnOutput } from '../../types/artifacts';

// ═══════════════════════════════════════════════════════════════════════════
// KERNEL RUNTIME TYPES
// Lightweight shared types that define the kernel's public contract.
// Keep additions here minimal — these evolve with the kernel, not with callers.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Discriminated union of execution types the kernel can route.
 * - 'chat'  : standard user-initiated turn (currently the only path)
 * Future additions: 'headless', 'autonomous', 'evaluation', 'tool_only'
 */
export type ExecutionType = 'chat';

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
 */
export interface KernelExecutionMeta {
    /** Unique ID for this execution turn -- useful for log correlation. */
    executionId: string;
    /** Unix ms timestamp when the kernel received the request. */
    startedAt: number;
    /** Logical type of execution (e.g. 'chat'). */
    executionType: ExecutionType;
    /**
     * Classification assigned during the classify stage.
     * Guides future routing decisions in classifyExecution().
     */
    executionClass: ExecutionClass;
    /** Wall-clock duration in ms from intake to finalize. */
    durationMs: number;
}

/**
 * Normalized request envelope passed between kernel stages.
 * normalizeRequest() ensures this is always fully populated before
 * being forwarded to classifyExecution() or runDelegatedFlow().
 */
export interface KernelRequest {
    userMessage: string;
    images?: string[];
    capabilitiesOverride?: any;
}

/**
 * Result envelope returned by AgentKernel.execute().
 * Extends AgentTurnOutput with kernel-level execution metadata.
 * Callers that only need turn output can ignore `meta`.
 */
export interface KernelResult extends AgentTurnOutput {
    meta: KernelExecutionMeta;
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

    constructor(agent: AgentService) {
        this.agent = agent;
    }

    // ─── Stage 1: normalizeRequest ──────────────────────────────────────────
    // Validates and normalizes the inbound request before anything else runs.
    // Future: coerce malformed payloads, strip disallowed fields, source ACL.

    private normalizeRequest(raw: KernelRequest): KernelRequest {
        return {
            userMessage: raw.userMessage ?? '',
            images: raw.images ?? [],
            capabilitiesOverride: raw.capabilitiesOverride,
        };
    }

    // ─── Stage 2: intake ────────────────────────────────────────────────────
    // Stamps execution metadata after request is normalized.
    // Future: execution budget checks, authority pre-validation gate.

    private intake(request: KernelRequest, executionType: ExecutionType): KernelExecutionMeta {
        const meta: KernelExecutionMeta = {
            executionId: uuidv4(),
            startedAt: Date.now(),
            executionType,
            executionClass: 'standard',  // default; overwritten by classifyExecution() in Phase 3
            durationMs: 0,
        };
        console.log(`[AgentKernel] ── INTAKE           ── id=${meta.executionId} type=${executionType} msgLen=${request.userMessage.length}`);
        return meta;
    }

    // ─── Stage 3: classifyExecution ─────────────────────────────────────────
    // Classifies the turn to produce a routing hint for downstream stages.
    // Future: mode detection, tool-need prediction, policy gate, context assembly.

    private classifyExecution(request: KernelRequest, meta: KernelExecutionMeta): void {
        // Placeholder — classification logic attaches here in Phase 3.
        // Currently always resolves to 'standard' (set during intake).
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
        return this.agent.chat(
            request.userMessage,
            onToken,
            onEvent,
            request.images,
            request.capabilitiesOverride
        );
    }

    // ─── Stage 5: finalizeExecution ─────────────────────────────────────────
    // Records wall-clock duration and assembles the KernelResult.
    // Future: post-turn telemetry emission, outcome learning, audit records.

    private finalizeExecution(meta: KernelExecutionMeta, turnOutput: AgentTurnOutput): KernelResult {
        meta.durationMs = Date.now() - meta.startedAt;
        console.log(`[AgentKernel] ── FINALIZE         ── id=${meta.executionId} duration=${meta.durationMs}ms channel=${turnOutput.outputChannel ?? 'chat'}`);
        return { ...turnOutput, meta };
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

        // Stage 2 -- intake
        const meta = this.intake(normalized, 'chat');

        // Stage 3 -- classifyExecution
        this.classifyExecution(normalized, meta);

        // Stage 4 -- runDelegatedFlow
        const turnOutput = await this.runDelegatedFlow(normalized, meta, onToken, onEvent);

        // Stage 5 -- finalizeExecution
        return this.finalizeExecution(meta, turnOutput);
    }
}
