import { v4 as uuidv4 } from 'uuid';
import type { AgentService } from '../AgentService';
import type { AgentTurnOutput } from '../../types/artifacts';

/**
 * Discriminated union of execution types the kernel can route.
 * Currently only 'chat' exists; extend here as new paths are added.
 */
export type ExecutionType = 'chat';

/**
 * Lightweight metadata stamped onto every kernel execution.
 * Provides a stable correlation handle without touching AgentService.
 */
export interface KernelExecutionMeta {
    /** Unique ID for this execution turn — useful for log correlation. */
    executionId: string;
    /** Unix ms timestamp when the kernel received the request. */
    startedAt: number;
    /** Logical type of execution (e.g. 'chat'). */
    executionType: ExecutionType;
    /** Wall-clock duration in ms from intake to finalize. */
    durationMs: number;
}

/**
 * Minimal request envelope for AgentKernel.execute().
 * Mirrors the parameters accepted by AgentService.chat() so the kernel
 * can be a transparent pass-through for now.
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

/**
 * AgentKernel — primary execution entrypoint for the Tala runtime (Phase 2d).
 *
 * execute() is structured into three visible stages:
 *   1. Intake    — normalize the request and stamp execution metadata
 *   2. Delegate  — hand off to AgentService.chat() unchanged
 *   3. Finalize  — record duration and surface metadata to the caller
 *
 * All existing orchestration logic lives inside AgentService; the kernel
 * coordinates the entrypoint without replacing any subsystem yet.
 *
 * Phase 3 hooks:
 *   - Policy/authority gates slot into intake
 *   - Context assembly slots between intake and delegate
 *   - Post-turn learning/telemetry slots into finalize
 */
export class AgentKernel {
    private readonly agent: AgentService;

    constructor(agent: AgentService) {
        this.agent = agent;
    }

    // ─── Stage 1: Intake ────────────────────────────────────────────────────
    // Normalizes the inbound request and stamps execution metadata.
    // Future: policy gates, authority checks, and context pre-assembly go here.

    private intake(request: KernelRequest, executionType: ExecutionType): KernelExecutionMeta {
        const meta: KernelExecutionMeta = {
            executionId: uuidv4(),
            startedAt: Date.now(),
            executionType,
            durationMs: 0,
        };
        console.log(`[AgentKernel] ── INTAKE  ── id=${meta.executionId} type=${executionType} msgLen=${request.userMessage.length}`);
        return meta;
    }

    // ─── Stage 3: Finalize ──────────────────────────────────────────────────
    // Records wall-clock duration and merges metadata into the result.
    // Future: post-turn telemetry, learning hooks, and audit records go here.

    private finalize(meta: KernelExecutionMeta, turnOutput: AgentTurnOutput): KernelResult {
        meta.durationMs = Date.now() - meta.startedAt;
        console.log(`[AgentKernel] ── FINALIZE── id=${meta.executionId} duration=${meta.durationMs}ms channel=${turnOutput.outputChannel ?? 'chat'}`);
        return { ...turnOutput, meta };
    }

    // ─── Public entrypoint ──────────────────────────────────────────────────

    /**
     * Execute a single agent turn through the kernel pipeline.
     *
     * Stages:
     *   intake    → stamp execution metadata, future: policy + context
     *   delegate  → AgentService.chat() (all existing orchestration)
     *   finalize  → record duration, future: telemetry + learning hooks
     */
    public async execute(
        request: KernelRequest,
        onToken?: (token: string) => void,
        onEvent?: (type: string, data: any) => void
    ): Promise<KernelResult> {
        // ── Stage 1: Intake ──
        const meta = this.intake(request, 'chat');

        // ── Stage 2: Delegate ──
        // All existing orchestration remains inside AgentService.chat().
        // No logic moved; no behavior changed.
        console.log(`[AgentKernel] ── DELEGATE── id=${meta.executionId}`);
        const turnOutput = await this.agent.chat(
            request.userMessage,
            onToken,
            onEvent,
            request.images,
            request.capabilitiesOverride
        );

        // ── Stage 3: Finalize ──
        return this.finalize(meta, turnOutput);
    }
}
