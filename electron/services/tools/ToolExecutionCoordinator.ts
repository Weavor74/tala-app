import { ToolService } from '../ToolService';
import { policyGate, PolicyDeniedError, type SideEffectContext } from '../policy/PolicyGate';
import { TelemetryBus } from '../telemetry/TelemetryBus';

/**
 * Context carried through a single tool invocation.
 *
 * All fields except `name` and `args` are optional so callers can supply only
 * what is available at their call site.  These map directly onto the
 * SideEffectContext fields used by PolicyGate, making it simple to add richer
 * telemetry at this seam in a future phase.
 */
export interface ToolInvocationContext {
    /** ID of the parent execution (e.g. turnId) for telemetry correlation. */
    executionId?: string;
    /** Logical type of the parent execution (e.g. 'chat_turn'). */
    executionType?: string;
    /** Origin of the parent execution (e.g. 'ipc', 'autonomy_engine'). */
    executionOrigin?: string;
    /** Runtime mode in effect (e.g. 'rp', 'hybrid', 'assistant'). */
    executionMode?: string;
    /**
     * When true, ToolExecutionCoordinator will call policyGate.assertSideEffect()
     * before delegating to ToolService.  Defaults to false so the fast-path and
     * public API call sites that already handle their own guards are unaffected.
     */
    enforcePolicy?: boolean;
}

/**
 * Normalized result produced by ToolExecutionCoordinator for each tool invocation.
 *
 * This type is used internally and returned by executeTool().  Callers that
 * previously received a raw ToolService result can access it via the `data`
 * field; all other fields are additive metadata.
 *
 * The `data` field carries the original ToolService return value unchanged, so
 * existing callers that read `result.data` (or adapt via a compatibility shim)
 * are unaffected.
 */
export interface ToolInvocationResult {
    /** Whether the tool executed without throwing. */
    success: boolean;
    /** Name of the tool that was invoked. */
    toolName: string;
    /** Raw return value from ToolService.executeTool(). Present on success. */
    data?: unknown;
    /** Error message. Present when success is false. */
    error?: string;
    /** Wall-clock execution time in milliseconds. */
    durationMs?: number;
    /** Reserved for future timeout cancellation support. Always false currently. */
    timedOut?: boolean;
}

/**
 * ToolExecutionCoordinator
 *
 * The primary live seam for all tool execution in the Tala runtime.
 * Wraps ToolService.executeTool() and owns:
 *
 * 1. Pre-execution policy enforcement (when `ctx.enforcePolicy === true`).
 * 2. Execution timing — `durationMs` is captured for every invocation.
 * 3. Telemetry emission — `tool.requested`, `tool.completed`, `tool.failed`
 *    events are emitted to TelemetryBus, correlated to the parent execution
 *    via `ctx.executionId`.
 * 4. Normalized result — raw ToolService output is wrapped in
 *    `ToolInvocationResult` so downstream consumers receive consistent shape.
 *
 * Existing callers are unaffected: the method signature is unchanged, and
 * callers that previously consumed the raw ToolService result can access it
 * via `result.data`.
 *
 * Future phases may add retry logic, timeout handling, and per-tool
 * circuit-breakers at this seam without touching callers.
 */
export class ToolExecutionCoordinator {
    constructor(private readonly tools: ToolService) {}

    /**
     * Execute a tool by name.
     *
     * Emits `tool.requested` before execution, then `tool.completed` or
     * `tool.failed` depending on outcome.  Timing (`durationMs`) is captured
     * regardless of outcome.
     *
     * When `ctx.enforcePolicy` is true, PolicyGate.assertSideEffect() is called
     * before any execution begins.  A PolicyDeniedError is propagated to the
     * caller unchanged and no telemetry is emitted after the block.
     *
     * @param name          Tool name (provider prefixes are stripped inside ToolService).
     * @param args          Key-value arguments for the tool.
     * @param allowedNames  Optional turn-scoped allowlist enforced inside ToolService.
     * @param ctx           Optional execution context for policy enforcement and telemetry.
     * @returns             Normalized ToolInvocationResult containing the raw tool data.
     * @throws PolicyDeniedError when `ctx.enforcePolicy` is true and the policy check fails.
     */
    async executeTool(
        name: string,
        args: any,
        allowedNames?: ReadonlySet<string>,
        ctx?: ToolInvocationContext,
    ): Promise<ToolInvocationResult> {
        // ── 1. Policy gate (throws PolicyDeniedError before any telemetry) ────
        if (ctx?.enforcePolicy) {
            const sideEffectCtx: SideEffectContext = {
                actionKind: 'tool_invoke',
                executionId: ctx.executionId,
                executionType: ctx.executionType,
                executionOrigin: ctx.executionOrigin,
                executionMode: ctx.executionMode,
                capability: name,
                targetSubsystem: 'ToolService',
                mutationIntent: `tool invocation: ${name}`,
            };
            policyGate.assertSideEffect(sideEffectCtx);
        }

        // ── 2. Telemetry: tool.requested ──────────────────────────────────────
        const bus = TelemetryBus.getInstance();
        const executionId = ctx?.executionId ?? '';
        bus.emit({
            executionId,
            subsystem: 'tools',
            event: 'tool.requested',
            phase: 'pre_execution',
            payload: {
                toolName: name,
                executionType: ctx?.executionType,
                executionOrigin: ctx?.executionOrigin,
                executionMode: ctx?.executionMode,
            },
        });

        // ── 3. Execution timing + delegation ─────────────────────────────────
        const startTime = Date.now();
        try {
            const rawResult = await this.tools.executeTool(name, args, allowedNames);
            const durationMs = Date.now() - startTime;

            // ── 4. Normalized result (success) ────────────────────────────────
            const invocationResult: ToolInvocationResult = {
                success: true,
                toolName: name,
                data: rawResult,
                durationMs,
            };

            // ── 5. Telemetry: tool.completed ──────────────────────────────────
            bus.emit({
                executionId,
                subsystem: 'tools',
                event: 'tool.completed',
                phase: 'post_execution',
                payload: {
                    toolName: name,
                    durationMs,
                    executionType: ctx?.executionType,
                    executionOrigin: ctx?.executionOrigin,
                    executionMode: ctx?.executionMode,
                },
            });

            return invocationResult;
        } catch (err: unknown) {
            const durationMs = Date.now() - startTime;
            const errorMessage = err instanceof Error ? err.message : String(err);

            // ── 7. Telemetry: tool.failed ─────────────────────────────────────
            bus.emit({
                executionId,
                subsystem: 'tools',
                event: 'tool.failed',
                phase: 'post_execution',
                payload: {
                    toolName: name,
                    durationMs,
                    error: errorMessage,
                    executionType: ctx?.executionType,
                    executionOrigin: ctx?.executionOrigin,
                    executionMode: ctx?.executionMode,
                },
            });

            // Re-throw so callers retain existing error-handling behavior.
            throw err;
        }
    }
}
