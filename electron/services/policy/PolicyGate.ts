/**
 * PolicyGate.ts
 *
 * Lightweight runtime enforcement stub that provides a single, consistent
 * place to check whether an execution or side effect should be allowed before
 * any observable state changes occur.
 *
 * Design intent:
 *   - Introduce a minimal allow/deny seam without redesigning existing
 *     guardrails or changing broader runtime behaviour.
 *   - PolicyDecision is the canonical shape returned by every gate check.
 *   - PolicyGate itself is side-effect free and deterministic; the same
 *     context always produces the same decision.
 *   - A singleton export (policyGate) is provided for shared use, matching
 *     the pattern established by toolGatekeeper.
 *
 * Two evaluation tiers:
 *   1. Execution admission  — checked at AgentKernel.classifyExecution() via evaluate().
 *                             Use checkExecution(ExecutionAdmissionContext) for typed access.
 *   2. Side-effect pre-check — checked before tool invocations, memory writes, file writes,
 *                             workflow actions, and autonomy actions.
 *                             Use checkSideEffect(SideEffectContext) / assertSideEffect().
 *
 * Extension path:
 *   - Add named rule methods (e.g. checkMemoryWrite, checkToolInvocation)
 *     that delegate to evaluate() with a typed PolicyContext.
 *   - Replace the stub allow-all body with real rules as the policy system
 *     matures.
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * The canonical decision shape produced by PolicyGate.evaluate().
 *
 * Every gate check returns one of these.  Callers must respect the decision
 * before performing the guarded action.
 */
export interface PolicyDecision {
    /** True when the action is permitted; false when it must be blocked. */
    allowed: boolean;
    /**
     * Human-readable explanation of why the decision was made.
     * Always populated so callers can surface or log the rationale.
     */
    reason: string;
    /**
     * Optional machine-readable code identifying the specific rule that
     * produced this decision (e.g. 'POLICY_DISABLED', 'RULE_BLOCKED').
     * Useful for telemetry, audit logs, and programmatic handling.
     */
    code?: string;
    /**
     * Optional structured payload carrying additional context about the
     * decision (e.g. which rule fired, threshold values, source labels).
     * Must be plain-object-serialisable.
     */
    metadata?: Record<string, unknown>;
}

/**
 * Input provided to PolicyGate.evaluate() describing the action to check.
 *
 * This is the low-level, untyped input for direct callers.
 * Prefer the typed wrappers — ExecutionAdmissionContext / SideEffectContext —
 * via checkExecution() and checkSideEffect() respectively.
 */
export interface PolicyContext {
    /**
     * Short identifier for the action being gated (e.g. 'tool_invoke',
     * 'memory_write', 'autonomy_task', 'file_write').
     */
    action: string;
    /**
     * Active chat or runtime mode at the time of the request
     * ('rp' | 'hybrid' | 'assistant' | 'system').
     */
    mode?: string;
    /**
     * Originating subsystem or actor (e.g. 'kernel', 'autonomy_engine',
     * 'user', 'mcp').
     */
    origin?: string;
    /**
     * Arbitrary additional context provided by the caller.  Kept untyped so
     * individual call-sites can attach whatever metadata is relevant without
     * requiring a new PolicyContext variant per action type.
     */
    payload?: Record<string, unknown>;
}

// ─── Typed evaluation contexts ────────────────────────────────────────────────

/**
 * Typed context for top-level execution admission checks.
 *
 * Use this with checkExecution() when evaluating whether a new execution
 * should be admitted before any side effects begin.
 *
 * Maps to action='execution.admit' inside evaluate().
 */
export interface ExecutionAdmissionContext {
    /** Logical type of the execution being admitted (e.g. 'chat_turn', 'autonomy_task'). */
    executionType: string;
    /** Origin of the execution request (e.g. 'ipc', 'autonomy_engine', 'chat_ui'). */
    executionOrigin?: string;
    /** Runtime mode in effect (e.g. 'assistant', 'rp', 'hybrid', 'system'). */
    executionMode?: string;
    /** Execution ID already assigned to this attempt (for correlation). */
    executionId?: string;
}

/**
 * Discriminated kind of side effect being attempted.
 *
 * Variants:
 *   tool_invoke      — a named tool call dispatched via ToolService
 *   memory_write     — a write to the mem0 or canonical memory store
 *   file_write       — a file system write operation
 *   workflow_action  — an action dispatched by the workflow runner
 *   autonomy_action  — an action dispatched inside an autonomous goal pipeline
 */
export type SideEffectActionKind =
    | 'tool_invoke'
    | 'memory_write'
    | 'file_write'
    | 'workflow_action'
    | 'autonomy_action';

/**
 * Typed context for side-effect pre-checks.
 *
 * Use this with checkSideEffect() / assertSideEffect() immediately before any
 * action that produces observable state changes (tool calls, memory writes, etc.).
 *
 * All fields except actionKind are optional so callers can supply only what is
 * available at their call site without being forced to thread extra state.
 *
 * Maps to action=actionKind inside evaluate().
 */
export interface SideEffectContext {
    /** Discriminated kind of the side effect being attempted. */
    actionKind: SideEffectActionKind;
    /** ID of the parent execution this side effect belongs to (for telemetry correlation). */
    executionId?: string;
    /** Logical type of the parent execution (e.g. 'chat_turn', 'autonomy_task'). */
    executionType?: string;
    /** Origin of the parent execution (e.g. 'ipc', 'autonomy_engine'). */
    executionOrigin?: string;
    /** Runtime mode in effect when the side effect was requested. */
    executionMode?: string;
    /**
     * Capability name being exercised (e.g. 'fs_write_text', 'mem0_add',
     * 'shell_run').  Matches tool names in ToolService for tool_invoke kind.
     */
    capability?: string;
    /**
     * The subsystem that would execute this action
     * (e.g. 'ToolService', 'MemoryService', 'WorkflowRunner').
     */
    targetSubsystem?: string;
    /**
     * Human-readable description of what state would be mutated.
     * Used for logging and future audit trail.
     * Examples: 'tool invocation: fs_write_text', 'mem0 write: post-turn memory'.
     */
    mutationIntent?: string;
}

// ─── PolicyGate ───────────────────────────────────────────────────────────────

/**
 * PolicyGate — runtime enforcement stub.
 *
 * Implements a named-rule evaluation approach.  Rules are evaluated in order
 * inside evaluate(); the first matching rule wins.  Unmatched actions fall
 * through to the default allow decision so that all existing callers remain
 * unaffected unless they match a named rule.
 *
 * Active rules:
 *   POLICY_FILE_WRITE_RP_BLOCK — blocks file_write when executionMode === 'rp'
 */
export class PolicyGate {

    /**
     * Evaluate whether the described action should be allowed.
     *
     * @param context  Description of the action to check.
     * @returns        A PolicyDecision that the caller must honour.
     */
    evaluate(context: PolicyContext): PolicyDecision {
        // ─── Rule: block file_write in rp mode ────────────────────────────────
        // File system writes are not permitted during role-play sessions.
        // This is the first concrete enforcement rule; it proves the gate blocks
        // unsafe behaviour end-to-end without requiring additional call-site wiring.
        if (context.action === 'file_write' && context.mode === 'rp') {
            return {
                allowed: false,
                reason: 'file_write not allowed in rp mode',
                code: 'POLICY_FILE_WRITE_RP_BLOCK',
            };
        }

        // Default: allow any action that did not match a named rule above.
        return {
            allowed: true,
            reason: `action '${context.action}' permitted — no policy rule matched`,
            code: 'POLICY_DEFAULT_ALLOW',
        };
    }

    // ─── Typed evaluation wrappers ────────────────────────────────────────────

    /**
     * Typed admission check for a top-level execution request.
     *
     * Converts an ExecutionAdmissionContext to a PolicyContext and delegates
     * to evaluate().  Use at execution entry seams (e.g. AgentKernel.classifyExecution).
     *
     * @param ctx  Typed execution admission context.
     * @returns    A PolicyDecision that the caller must honour.
     */
    checkExecution(ctx: ExecutionAdmissionContext): PolicyDecision {
        return this.evaluate({
            action: 'execution.admit',
            mode: ctx.executionMode,
            origin: ctx.executionOrigin,
            payload: {
                type: ctx.executionType,
                executionId: ctx.executionId,
            },
        });
    }

    /**
     * Typed pre-check for a side-effect action (tool invocation, memory write, etc.).
     *
     * Converts a SideEffectContext to a PolicyContext and delegates to evaluate().
     * Use immediately before any action that produces observable state changes.
     *
     * @param ctx  Typed side-effect context describing the proposed action.
     * @returns    A PolicyDecision that the caller must honour.
     */
    checkSideEffect(ctx: SideEffectContext): PolicyDecision {
        return this.evaluate({
            action: ctx.actionKind,
            mode: ctx.executionMode,
            origin: ctx.executionOrigin,
            payload: {
                executionId: ctx.executionId,
                executionType: ctx.executionType,
                capability: ctx.capability,
                targetSubsystem: ctx.targetSubsystem,
                mutationIntent: ctx.mutationIntent,
            },
        });
    }

    // ─── Convenience wrappers ─────────────────────────────────────────────────

    /**
     * Convenience wrapper: returns true when evaluate() yields allowed=true.
     *
     * Use this when the caller only needs a boolean and does not need to log
     * or surface the reason.
     */
    isAllowed(context: PolicyContext): boolean {
        return this.evaluate(context).allowed;
    }

    /**
     * Convenience wrapper: throws a PolicyDeniedError when the action is not
     * allowed.  Use this at enforcement boundaries where a denied action should
     * halt execution rather than returning a result to the caller.
     */
    assertAllowed(context: PolicyContext): void {
        const decision = this.evaluate(context);
        if (!decision.allowed) {
            throw new PolicyDeniedError(decision);
        }
    }

    /**
     * Typed side-effect guard: throws a PolicyDeniedError when checkSideEffect()
     * returns allowed=false.
     *
     * Use this at side-effect seams (tool calls, memory writes, file writes, etc.)
     * where a denied action should halt before any state mutation occurs.
     *
     * Currently enforces: file_write blocked in rp mode (POLICY_FILE_WRITE_RP_BLOCK).
     * Additional rules in evaluate() automatically enforce here as they are added.
     */
    assertSideEffect(ctx: SideEffectContext): void {
        const decision = this.checkSideEffect(ctx);
        if (!decision.allowed) {
            throw new PolicyDeniedError(decision);
        }
    }
}

// ─── PolicyDeniedError ────────────────────────────────────────────────────────

/**
 * Thrown by PolicyGate.assertAllowed() when a gate check fails.
 *
 * Consumers can catch this specific type to distinguish policy denials from
 * other runtime errors.
 */
export class PolicyDeniedError extends Error {
    readonly decision: PolicyDecision;

    constructor(decision: PolicyDecision) {
        super(`PolicyGate denied: ${decision.reason}${decision.code ? ` [${decision.code}]` : ''}`);
        this.name = 'PolicyDeniedError';
        this.decision = decision;
    }
}

// ─── Module-level singleton ───────────────────────────────────────────────────

/**
 * Shared singleton used across the runtime.  Stateless, so sharing is safe.
 */
export const policyGate = new PolicyGate();
