import { ToolService } from '../ToolService';
import { PolicyDeniedError, type SideEffectContext } from '../policy/PolicyGate';
import { enforceSideEffectWithGuardrails } from '../policy/PolicyEnforcement';
import { TelemetryBus } from '../telemetry/TelemetryBus';
import { GuardrailCircuitBreakerStore } from '../runtime/guardrails/GuardrailCircuitBreaker';
import { executeWithRuntimeGuardrails } from '../runtime/guardrails/GuardrailExecutor';
import type { GuardrailFailureKind } from '../runtime/guardrails/RuntimeGuardrailTypes';
import { SystemModeManager } from '../SystemModeManager';

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
    /** Deprecated. Policy enforcement is always performed at this seam. */
    enforcePolicy?: boolean;
    /** Explicitly marks this tool invocation as idempotent-safe for retries. */
    toolInvocationIdempotent?: boolean;
    /** Optional per-invocation timeout budget in milliseconds. */
    toolTimeoutMs?: number;
}

const SAFE_READ_ONLY_TOOLS = new Set<string>([
    'fs_read_text',
    'fs_list',
    'mem0_search',
    'mem0_get_recent',
    'browser_get_dom',
    'browser_screenshot',
    'search_web',
]);

const TRANSIENT_ERROR_PATTERNS = [
    'ETIMEDOUT',
    'ECONNRESET',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'timeout',
    'temporar',
];

function isTransientToolError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return TRANSIENT_ERROR_PATTERNS.some((token) =>
        message.toLowerCase().includes(token.toLowerCase()),
    );
}

function isSafeToolRetry(
    toolName: string,
    args: unknown,
    ctx?: ToolInvocationContext,
): boolean {
    if (ctx?.toolInvocationIdempotent) return true;
    if (SAFE_READ_ONLY_TOOLS.has(toolName)) return true;
    if (args && typeof args === 'object') {
        const value = args as Record<string, unknown>;
        if (value.idempotent === true || value.retrySafe === true) return true;
    }
    return false;
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
 * 1. Pre-execution policy enforcement (always-on at this seam).
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
    private readonly breakerStore = new GuardrailCircuitBreakerStore();

    constructor(private readonly tools: ToolService) {}

    /**
     * Execute a tool by name.
     *
     * Emits `tool.requested` before execution, then `tool.completed` or
     * `tool.failed` depending on outcome.  Timing (`durationMs`) is captured
     * regardless of outcome.
     *
     * Policy enforcement is always evaluated before execution starts. A
     * PolicyDeniedError is propagated to the caller unchanged and no tool
     * execution telemetry is emitted after the block.
     *
     * @param name          Tool name (provider prefixes are stripped inside ToolService).
     * @param args          Key-value arguments for the tool.
     * @param allowedNames  Optional turn-scoped allowlist enforced inside ToolService.
     * @param ctx           Optional execution context for policy enforcement and telemetry.
     * @returns             Normalized ToolInvocationResult containing the raw tool data.
     * @throws PolicyDeniedError when the policy check fails.
     */
    async executeTool(
        name: string,
        args: any,
        allowedNames?: ReadonlySet<string>,
        ctx?: ToolInvocationContext,
    ): Promise<ToolInvocationResult> {
        // ── 0. Runtime mode contract (deterministic capability gate) ─────────
        const capability = SystemModeManager.resolveToolCapability(name);
        SystemModeManager.assertCapability(
            capability,
            'ToolExecutionCoordinator.executeTool',
            ctx?.executionId,
        );

        // ── 1. Policy gate (throws PolicyDeniedError before any telemetry) ────
        const sideEffectCtx: SideEffectContext = {
            actionKind: 'tool_invoke',
            executionId: ctx?.executionId,
            executionType: ctx?.executionType,
            executionOrigin: ctx?.executionOrigin,
            executionMode: ctx?.executionMode,
            capability: name,
            targetSubsystem: 'ToolService',
            mutationIntent: `tool invocation: ${name}`,
        };
        await enforceSideEffectWithGuardrails('tool', sideEffectCtx, {
            toolName: name,
            args: (args && typeof args === 'object') ? args as Record<string, unknown> : { value: String(args ?? '') },
        });

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
        const retrySafe = isSafeToolRetry(name, args, ctx);
        const breaker = this.breakerStore.get(
            `tool:${name}`,
            {
                failureThreshold: 3,
                resetAfterMs: 15_000,
            },
        );
        try {
            const guarded = await executeWithRuntimeGuardrails({
                domain: 'tools',
                operationName: 'tool_execution',
                targetKey: name,
                executionId: ctx?.executionId,
                timeoutMs: ctx?.toolTimeoutMs,
                maxAttempts: retrySafe ? 2 : 1,
                circuitBreaker: breaker,
                classifyFailure: (error): GuardrailFailureKind => {
                    if (error instanceof PolicyDeniedError) return 'policy_denied';
                    return 'runtime_error';
                },
                shouldRetry: (error, _attempt, failureKind) =>
                    retrySafe && failureKind !== 'policy_denied' && isTransientToolError(error),
                shouldCountFailureForCircuit: (_error, failureKind) =>
                    failureKind !== 'policy_denied',
                execute: async () => this.tools.executeTool(name, args, allowedNames),
            });

            if (!guarded.ok) {
                throw guarded.error ?? new Error(`Tool execution failed: ${name}`);
            }

            const rawResult = guarded.value;
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
