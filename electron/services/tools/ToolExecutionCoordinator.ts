import { ToolService } from '../ToolService';
import { policyGate, PolicyDeniedError, type SideEffectContext } from '../policy/PolicyGate';

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
 * ToolExecutionCoordinator
 *
 * The primary live seam for all tool execution in the Tala runtime.
 * Wraps ToolService.executeTool() and owns the pre-execution policy check
 * when `ctx.enforcePolicy === true`.
 *
 * Callers that set `enforcePolicy: true` delegate the PolicyGate
 * assertSideEffect() call to this class, removing the duplicate check at the
 * call site.  Callers that omit the flag (or pass `false`) retain their own
 * guards as before.
 *
 * Future phases may add retry logic, timeout handling, and per-tool
 * telemetry at this seam without touching callers.
 */
export class ToolExecutionCoordinator {
    constructor(private readonly tools: ToolService) {}

    /**
     * Execute a tool by name.
     *
     * When `ctx.enforcePolicy` is true, PolicyGate.assertSideEffect() is called
     * before delegation to ToolService.  A PolicyDeniedError is propagated to
     * the caller unchanged.
     *
     * @param name          Tool name (provider prefixes are stripped inside ToolService).
     * @param args          Key-value arguments for the tool.
     * @param allowedNames  Optional turn-scoped allowlist enforced inside ToolService.
     * @param ctx           Optional execution context for policy enforcement and future telemetry.
     * @returns             The raw result from the tool (string, ToolResult, or any).
     * @throws PolicyDeniedError when `ctx.enforcePolicy` is true and the policy check fails.
     */
    async executeTool(
        name: string,
        args: any,
        allowedNames?: ReadonlySet<string>,
        ctx?: ToolInvocationContext,
    ): Promise<any> {
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

        return this.tools.executeTool(name, args, allowedNames);
    }
}
