/**
 * PolicyGate.ts
 *
 * Lightweight runtime enforcement stub that provides a single, consistent
 * place to check whether an execution should be allowed before any side
 * effects occur.
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

// ─── PolicyGate ───────────────────────────────────────────────────────────────

/**
 * PolicyGate — runtime enforcement stub.
 *
 * Currently implements a permissive allow-all policy so that wiring this gate
 * into call sites produces no behavioural change.  Rules are added here as the
 * policy system matures; existing callers automatically gain enforcement once
 * rules are present.
 */
export class PolicyGate {

    /**
     * Evaluate whether the described action should be allowed.
     *
     * @param context  Description of the action to check.
     * @returns        A PolicyDecision that the caller must honour.
     */
    evaluate(context: PolicyContext): PolicyDecision {
        // Stub: allow everything.  This is intentionally permissive until real
        // rules are introduced.  The seam is in place; enforcement is additive.
        return {
            allowed: true,
            reason: `action '${context.action}' permitted — no policy rule matched`,
            code: 'POLICY_DEFAULT_ALLOW',
        };
    }

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
