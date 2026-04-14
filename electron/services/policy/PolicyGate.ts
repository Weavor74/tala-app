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
 *                             Use checkSideEffect(SideEffectContext) / assertSideEffect() (sync)
 *                             or checkSideEffectAsync() / assertSideEffectAsync() (config-driven).
 *
 * Config-driven evaluation (Phase 3):
 *   Call setConfig(GuardrailPolicyConfig) to load builder-authored guardrail rules.
 *   Then call evaluateAsync() / checkSideEffectAsync() / assertSideEffectAsync() to run
 *   both the existing hard-coded rules AND the config-driven profile rules, including
 *   validator dispatch via ValidatorRegistry.
 *
 *   Rule resolution order (evaluateAsync):
 *     1. Existing hard-coded synchronous rules (file_write/rp, autonomy_action/rp, etc.) run first.
 *        A hard-coded deny short-circuits the rest.
 *     2. Active profile rules are evaluated in ruleIds order (index 0 = highest priority).
 *        Each rule's scopes array must ALL match (AND semantics).
 *        An empty scopes array is a global rule that always matches.
 *     3. First rule whose action is 'deny' → block immediately.
 *     4. Rules whose action is 'require_validation' → run validators;
 *        if shouldDenyOverall → block immediately; else continue.
 *     5. Rules whose action is 'warn' or 'require_confirmation' → record warning, continue.
 *     6. Rules whose action is 'allow' → no-op, continue checking.
 *     7. Default → allow.
 *
 * Telemetry events emitted (via TelemetryBus):
 *   execution.blocked     — emitted when a rule or validator denies
 *   policy.rule_matched   — emitted for each rule whose scopes matched
 *   validation.requested  — emitted before running validators for a rule
 *   validation.completed  — emitted after validators return (pass or deny)
 *   validation.failed     — emitted if ValidatorRegistry throws (defensive)
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import type { GuardrailPolicyConfig, GuardrailRule, GuardrailScope } from '../../../shared/guardrails/guardrailPolicyTypes';
import type { GuardrailValidationRequest } from '../guardrails/types';
import { ValidatorRegistry, validatorRegistry as _defaultRegistry } from '../guardrails/ValidatorRegistry';
import { TelemetryBus } from '../telemetry/TelemetryBus';
import type { RuntimeEventType } from '../../../shared/runtimeEventTypes';

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
    | 'autonomy_action'
    | 'inference_output';

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
 *   POLICY_FILE_WRITE_RP_BLOCK        — blocks file_write when executionMode === 'rp'
 *   POLICY_AUTONOMY_RP_BLOCK          — blocks autonomy_action when executionMode === 'rp'
 *   POLICY_WORKFLOW_RP_BLOCK          — blocks workflow_action when executionMode === 'rp'
 *   POLICY_MEMORY_WRITE_RP_BLOCK      — blocks memory_write when executionMode === 'rp'
 *                                        and mutationIntent === 'write'
 */
export class PolicyGate {

    // ─── Config and registry injection ────────────────────────────────────────

    /** Active guardrail policy config (set via setConfig). */
    private _config: GuardrailPolicyConfig | undefined;

    /** ValidatorRegistry used for require_validation rules. Defaults to module singleton. */
    private _registry: ValidatorRegistry = _defaultRegistry;

    /**
     * Load a GuardrailPolicyConfig so evaluateAsync() can apply builder-authored rules.
     * Pass undefined to clear and fall back to hard-coded rules only.
     */
    setConfig(config: GuardrailPolicyConfig | undefined): void {
        this._config = config;
    }

    /**
     * Returns the currently active guardrail profile ID, if a policy config
     * has been loaded via setConfig().
     */
    getActiveProfileId(): string | undefined {
        return this._config?.activeProfileId;
    }

    /**
     * Override the ValidatorRegistry used for require_validation dispatching.
     * Use in tests to inject a custom registry with mock adapters.
     */
    setRegistry(registry: ValidatorRegistry): void {
        this._registry = registry;
    }

    // ─── Synchronous evaluation ───────────────────────────────────────────────

    /**
     * Evaluate whether the described action should be allowed.
     *
     * @param context  Description of the action to check.
     * @returns        A PolicyDecision that the caller must honour.
     */
    evaluate(context: PolicyContext): PolicyDecision {
        // ─── Rule: block file_write in rp mode ────────────────────────────────
        // File system writes are not permitted during role-play sessions.
        //
        // Seam note: this rule fires when action === 'file_write'.  The 'file_write'
        // SideEffectActionKind is the correct seam for direct file-system write
        // operations outside of tool invocations.  Tool-dispatched writes in
        // AgentService flow through the 'tool_invoke' seam (different action kind),
        // which is intentional — those are gated by capability-level checks at that
        // call site.  A Phase 2 rule can extend this gate to also match
        // actionKind='tool_invoke' with capability 'fs_write_text' if tighter
        // cross-seam enforcement is required.
        if (context.action === 'file_write' && context.mode === 'rp') {
            return {
                allowed: false,
                reason: 'file_write not allowed in rp mode',
                code: 'POLICY_FILE_WRITE_RP_BLOCK',
            };
        }

        // ─── Rule: block autonomy_action in rp mode ───────────────────────────
        // Autonomous pipeline execution is not permitted during role-play sessions.
        // Autonomy actions run goal pipelines that may produce side effects outside
        // the narrative context; they must be suppressed while rp mode is active.
        if (context.action === 'autonomy_action' && context.mode === 'rp') {
            return {
                allowed: false,
                reason: 'autonomy_action not allowed in rp mode',
                code: 'POLICY_AUTONOMY_RP_BLOCK',
            };
        }

        // ─── Rule: block workflow_action in rp mode ───────────────────────────
        // Workflow node execution is not permitted during role-play sessions.
        // Workflow actions can trigger arbitrary tool calls and state mutations;
        // they must be suppressed while rp mode is active.
        if (context.action === 'workflow_action' && context.mode === 'rp') {
            return {
                allowed: false,
                reason: 'workflow_action not allowed in rp mode',
                code: 'POLICY_WORKFLOW_RP_BLOCK',
            };
        }

        // ─── Rule: block memory_write with intent 'write' in rp mode ────────
        // Canonical memory mutations (update and tombstone) are not permitted
        // during role-play sessions.  This rule matches on the combination of
        // action, mode, and the specific mutationIntent='write' so that read-only
        // memory queries and non-rp writes are unaffected.
        if (
            context.action === 'memory_write' &&
            context.mode === 'rp' &&
            context.payload?.mutationIntent === 'write'
        ) {
            return {
                allowed: false,
                reason: 'memory_write not allowed in rp mode',
                code: 'POLICY_MEMORY_WRITE_RP_BLOCK',
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
     * Currently enforces:
     *   file_write blocked in rp mode     (POLICY_FILE_WRITE_RP_BLOCK)
     *   autonomy_action blocked in rp mode (POLICY_AUTONOMY_RP_BLOCK)
     *   workflow_action blocked in rp mode (POLICY_WORKFLOW_RP_BLOCK)
     *   memory_write (intent='write') blocked in rp mode (POLICY_MEMORY_WRITE_RP_BLOCK)
     * Additional rules in evaluate() automatically enforce here as they are added.
     */
    assertSideEffect(ctx: SideEffectContext): void {
        const decision = this.checkSideEffect(ctx);
        if (!decision.allowed) {
            throw new PolicyDeniedError(decision);
        }
    }

    // ─── Async config-driven evaluation (Phase 3) ─────────────────────────────

    /**
     * Async extension of evaluate() that also applies builder-authored guardrail
     * rules from the active GuardrailPolicyConfig (set via setConfig).
     *
     * Resolution order: hard-coded rules first, then active profile rules in
     * ruleIds order. See class-level JSDoc for full semantics.
     *
     * @param context  PolicyContext (same as evaluate()).
     * @param content  Optional content to pass to validators.
     */
    async evaluateAsync(
        context: PolicyContext,
        content?: string | Record<string, unknown>,
    ): Promise<PolicyDecision> {
        // Step 1: hard-coded synchronous rules always run first
        const hardcoded = this.evaluate(context);
        if (!hardcoded.allowed) {
            this._emitPolicyEvent('execution.blocked', context, {
                code: hardcoded.code,
                reason: hardcoded.reason,
                source: 'hardcoded',
            });
            return hardcoded;
        }

        // Step 2: no config → return hard-coded default
        if (!this._config) {
            return hardcoded;
        }

        // Step 3: gather active profile rules in priority order
        const profileRules = this._getActiveProfileRules();
        const warnings: string[] = [];

        // Step 4: evaluate each rule in profile order
        for (const rule of profileRules) {
            if (!rule.enabled) continue;
            if (!this._ruleMatchesContext(rule, context)) continue;

            this._emitPolicyEvent('policy.rule_matched', context, {
                ruleId: rule.id,
                ruleName: rule.name,
                ruleAction: rule.action,
                severity: rule.severity,
            });

            if (rule.action === 'deny') {
                const decision: PolicyDecision = {
                    allowed: false,
                    reason: `Rule '${rule.name}' denied the action`,
                    code: `RULE_DENY:${rule.id}`,
                    metadata: { ruleId: rule.id, severity: rule.severity },
                };
                this._emitPolicyEvent('execution.blocked', context, {
                    code: decision.code,
                    reason: decision.reason,
                    ruleId: rule.id,
                    source: 'rule_deny',
                });
                return decision;
            }

            if (rule.action === 'warn') {
                warnings.push(
                    `Rule '${rule.name}' flagged this action (severity: ${rule.severity})`,
                );
                continue;
            }

            if (rule.action === 'require_validation') {
                const validationRequest = this._makeValidationRequest(context, content);
                const executionId =
                    (context.payload?.executionId as string | undefined) ?? 'policy-eval';

                this._emitTelemetry('validation.requested', executionId, {
                    ruleId: rule.id,
                    ruleName: rule.name,
                });

                let aggregated;
                try {
                    aggregated = await this._registry.runRuleBindings(
                        this._config,
                        rule.id,
                        validationRequest,
                    );
                    this._emitTelemetry('validation.completed', executionId, {
                        ruleId: rule.id,
                        shouldDenyOverall: aggregated.shouldDenyOverall,
                        validatorCount: aggregated.results.length,
                        totalDurationMs: aggregated.totalDurationMs,
                        allSucceeded: aggregated.allSucceeded,
                    });
                } catch (err) {
                    this._emitTelemetry('validation.failed', executionId, {
                        ruleId: rule.id,
                        error: String(err),
                    });
                    // ValidatorRegistry.runRuleBindings() is designed to never throw —
                    // all adapter errors are caught and returned as result records.
                    // This catch is a defensive safeguard against unexpected infrastructure
                    // failures (e.g. out-of-memory, import errors after hot-reload).
                    // Fail-open here is intentional: infrastructure failures should not
                    // silently block safe execution paths. This is distinct from per-binding
                    // failOpen/failClosed semantics, which govern validator-level errors.
                    continue;
                }

                if (aggregated.shouldDenyOverall) {
                    const violationSummary = aggregated.allViolations
                        .map(v => v.message)
                        .join('; ');
                    const decision: PolicyDecision = {
                        allowed: false,
                        reason: `Validation blocked: ${
                            violationSummary || 'validator denied the action'
                        }`,
                        code: `VALIDATION_DENY:${rule.id}`,
                        metadata: {
                            ruleId: rule.id,
                            violations: aggregated.allViolations,
                            validatorResults: aggregated.results.map(r => ({
                                validatorId: r.validatorId,
                                shouldDeny: r.shouldDeny,
                                error: r.error,
                            })),
                        },
                    };
                    this._emitPolicyEvent('execution.blocked', context, {
                        code: decision.code,
                        reason: decision.reason,
                        ruleId: rule.id,
                        source: 'validation_deny',
                    });
                    return decision;
                }

                for (const w of aggregated.allWarnings) {
                    warnings.push(w);
                }
                continue;
            }

            if (rule.action === 'allow') {
                continue;
            }

            if (rule.action === 'require_confirmation') {
                warnings.push(
                    `Rule '${rule.name}' would require confirmation (severity: ${rule.severity})`,
                );
                continue;
            }
        }

        return {
            allowed: true,
            reason: hardcoded.reason,
            code: warnings.length > 0 ? 'POLICY_ALLOW_WITH_WARNINGS' : hardcoded.code,
            metadata: warnings.length > 0 ? { warnings } : undefined,
        };
    }

    /**
     * Typed async pre-check for a side-effect action.
     * Applies both hard-coded rules and config-driven rules.
     */
    async checkSideEffectAsync(
        ctx: SideEffectContext,
        content?: string | Record<string, unknown>,
    ): Promise<PolicyDecision> {
        return this.evaluateAsync(
            {
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
            },
            content,
        );
    }

    /**
     * Typed async side-effect guard: throws PolicyDeniedError when
     * checkSideEffectAsync() returns allowed=false.
     */
    async assertSideEffectAsync(
        ctx: SideEffectContext,
        content?: string | Record<string, unknown>,
    ): Promise<void> {
        const decision = await this.checkSideEffectAsync(ctx, content);
        if (!decision.allowed) {
            throw new PolicyDeniedError(decision);
        }
    }

    // ─── Private: rule resolution helpers ─────────────────────────────────────

    /** Return the ordered rule list for the active profile (index 0 = highest priority). */
    private _getActiveProfileRules(): GuardrailRule[] {
        if (!this._config) return [];
        const profile = this._config.profiles.find(
            p => p.id === this._config!.activeProfileId,
        );
        if (!profile) return [];
        return profile.ruleIds
            .map(ruleId => this._config!.rules.find(r => r.id === ruleId))
            .filter((r): r is GuardrailRule => r !== undefined);
    }

    /**
     * Return true when ALL scopes in rule.scopes match context.
     * Empty scopes array = global rule that always matches.
     */
    private _ruleMatchesContext(rule: GuardrailRule, context: PolicyContext): boolean {
        if (!rule.scopes || rule.scopes.length === 0) return true;
        return rule.scopes.every(scope => this._scopeMatchesContext(scope, context));
    }

    /**
     * Return true when every populated field in scope matches context.
     * ModeScope '*' is a wildcard that matches any mode value.
     */
    private _scopeMatchesContext(scope: GuardrailScope, context: PolicyContext): boolean {
        if (scope.mode !== undefined) {
            if (scope.mode !== '*' && context.mode !== scope.mode) return false;
        }
        if (scope.executionOrigin !== undefined) {
            if (context.origin !== scope.executionOrigin) return false;
        }
        if (scope.executionType !== undefined) {
            const ctxType = context.payload?.executionType as string | undefined;
            if (ctxType !== scope.executionType) return false;
        }
        if (scope.capability !== undefined) {
            const ctxCap = context.payload?.capability as string | undefined;
            if (ctxCap !== scope.capability) return false;
        }
        if (scope.memoryAction !== undefined) {
            if (context.action !== 'memory_write') return false;
            const ctxMemAction = context.payload?.memoryAction as string | undefined;
            if (ctxMemAction !== scope.memoryAction) return false;
        }
        if (scope.workflowNodeType !== undefined) {
            if (context.action !== 'workflow_action') return false;
            const ctxWfNodeType = context.payload?.workflowNodeType as string | undefined;
            if (ctxWfNodeType !== scope.workflowNodeType) return false;
        }
        if (scope.autonomyAction !== undefined) {
            if (context.action !== 'autonomy_action') return false;
            const ctxAutoAction = context.payload?.autonomyAction as string | undefined;
            if (ctxAutoAction !== scope.autonomyAction) return false;
        }
        return true;
    }

    /**
     * Build a GuardrailValidationRequest from context.
     * If content is not provided, the context payload is used as structured content.
     */
    private _makeValidationRequest(
        context: PolicyContext,
        content?: string | Record<string, unknown>,
    ): GuardrailValidationRequest {
        return {
            executionId: context.payload?.executionId as string | undefined,
            executionType: context.payload?.executionType as string | undefined,
            executionOrigin: context.origin,
            executionMode: context.mode,
            content: content ?? (context.payload ?? {}),
            targetSubsystem: context.payload?.targetSubsystem as string | undefined,
            actionKind: context.action,
        };
    }

    // ─── Private: telemetry helpers ───────────────────────────────────────────

    /** Emit a policy-domain event with action/mode and extra payload fields. */
    private _emitPolicyEvent(
        event: RuntimeEventType,
        context: PolicyContext,
        extra?: Record<string, unknown>,
    ): void {
        const executionId =
            (context.payload?.executionId as string | undefined) ?? 'policy-eval';
        this._emitTelemetry(event, executionId, {
            action: context.action,
            mode: context.mode,
            ...extra,
        });
    }

    /**
     * Emit a TelemetryBus event. Errors are swallowed so telemetry never
     * interrupts policy enforcement.
     */
    private _emitTelemetry(
        event: RuntimeEventType,
        executionId: string,
        payload?: Record<string, unknown>,
    ): void {
        try {
            TelemetryBus.getInstance().emit({
                executionId,
                subsystem: 'kernel',
                event,
                ...(payload !== undefined && { payload }),
            });
        } catch {
            // Telemetry failures must never interrupt policy enforcement.
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
