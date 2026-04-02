import type { AgentService } from '../AgentService';
import type { AgentTurnOutput } from '../../types/artifacts';

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
 * Minimal result envelope returned by AgentKernel.execute().
 * Currently a direct alias of AgentTurnOutput; kept as a distinct type so
 * the kernel's contract can evolve independently without touching callers.
 */
export type KernelResult = AgentTurnOutput;

/**
 * AgentKernel — thin execution wrapper (Phase 2d foundation).
 *
 * This is a non-invasive wrapper that introduces a single centralized
 * execute() entry point without changing any runtime behavior.
 * All execution is delegated to AgentService.chat() unchanged.
 *
 * Phase 2d intent:
 *   - Establish the kernel boundary as the canonical entry point
 *   - Enable future policy injection, tracing, and context assembly
 *     to be added here without touching AgentService directly
 */
export class AgentKernel {
    private readonly agent: AgentService;

    constructor(agent: AgentService) {
        this.agent = agent;
    }

    /**
     * Execute a single agent turn.
     * Delegates directly to AgentService.chat() — no policy changes,
     * no context refactor, no behavior drift.
     */
    public async execute(
        request: KernelRequest,
        onToken?: (token: string) => void,
        onEvent?: (type: string, data: any) => void
    ): Promise<KernelResult> {
        return this.agent.chat(
            request.userMessage,
            onToken,
            onEvent,
            request.images,
            request.capabilitiesOverride
        );
    }
}
