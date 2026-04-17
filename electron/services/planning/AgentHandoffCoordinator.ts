/**
 * AgentHandoffCoordinator.ts — Execution bridge for PlanningService agent handoffs
 *
 * Consumes the typed agent ExecutionHandoff produced by PlanningService and dispatches
 * the PlannedAgentInvocation to the appropriate downstream agent execution authority.
 *
 * Design invariants
 * ─────────────────
 * 1. Not a planner — this class does not produce plans, analyse goals, or modify
 *    planning state beyond calling markExecutionCompleted / markExecutionFailed.
 * 2. Preflight first — before dispatch, preflight validation runs synchronously.
 *    Preflight failure marks the plan failed with a machine-readable reason code and
 *    signals that replanning may be appropriate (replanAdvised: true).
 * 3. Typed contract — only the 'agent' handoff type is accepted.  Any other type
 *    throws immediately so the caller knows to use the correct coordinator.
 * 4. Policy enforcement — the invocation's failurePolicy is honoured:
 *    stop     → mark the plan failed
 *    retry    → coordinator defers retry to the executor; returns result as-is
 *    skip     → mark completed (not recommended for agent; prefer 'escalate')
 *    escalate → mark result as requiring operator gate (replanAdvised: true)
 * 5. Execution-boundary propagation — the plan's executionBoundaryId is passed as
 *    executionId in AgentInvocationContext so agent telemetry is correlated to
 *    the planning lifecycle.
 * 6. Telemetry lifecycle parity — emits the same lifecycle event pattern as
 *    WorkflowHandoffCoordinator (dispatched, invocation_failed, dispatch_failed) plus
 *    preflight-specific events (agent_handoff_preflight_failed).  invocation_failed is
 *    emitted by _executeInvocation() for executor-thrown failures; dispatch_failed is
 *    emitted only at the dispatch layer (preflight, policy, outer catch).
 * 7. Stable failure reason codes — all failures carry an AgentHandoffFailureCode from
 *    the shared type contract, making them machine-actionable without string parsing.
 * 8. Honest failure — on execution failure with failurePolicy 'stop',
 *    markExecutionFailed() is called and the error is propagated to the caller.
 * 9. No silent side effects — every dispatch attempt is observable via telemetry.
 */

import { TelemetryBus } from '../telemetry/TelemetryBus';
import { PlanningService } from './PlanningService';
import type {
    ExecutionPlan,
    PlannedAgentInvocation,
    AgentHandoffFailureCode,
    GoalExecutionStyle,
} from '../../../shared/planning/PlanningTypes';

// ─── Executor interface ────────────────────────────────────────────────────────

/**
 * Invocation context passed to the agent executor on dispatch.
 * Correlates agent session telemetry to the planning lifecycle.
 */
export interface AgentInvocationContext {
    /** Matches the plan's executionBoundaryId for cross-subsystem correlation. */
    executionId: string;
    /** Always 'planning_handoff' — identifies this as a plan-initiated dispatch. */
    executionType: 'planning_handoff';
    /** Always 'planning' — execution originated from the planning subsystem. */
    executionOrigin: 'planning';
}

/**
 * Minimal interface for the agent execution authority.
 * Defined here to allow injection in tests without importing the full kernel.
 */
export interface IAgentExecutor {
    executeAgent(
        agentId: string,
        executionMode: GoalExecutionStyle,
        input: Record<string, unknown>,
        ctx?: AgentInvocationContext,
    ): Promise<{ success: boolean; data?: unknown; error?: string; durationMs?: number }>;
}

// ─── Preflight ────────────────────────────────────────────────────────────────

/** Valid execution modes for agent handoffs. */
const VALID_AGENT_EXECUTION_MODES: ReadonlySet<GoalExecutionStyle> = new Set([
    'llm_assisted',
    'hybrid',
]);

/**
 * Result of a preflight validation for an agent invocation.
 */
export interface AgentPreflightResult {
    passed: boolean;
    /** Machine-readable failure code; present only when passed=false. */
    failureCode?: AgentHandoffFailureCode;
    /** Human-readable description of the failure; present only when passed=false. */
    details?: string;
    /**
     * Whether replanning is advised following this preflight failure.
     * True for capability mismatches (capability may become available after replan).
     * False for hard invariant violations (e.g. invalid executionMode).
     */
    replanAdvised?: boolean;
}

/**
 * Runs deterministic preflight checks on a PlannedAgentInvocation.
 *
 * Checks (in order, first failure wins):
 *   1. agentId is non-empty
 *   2. executionMode is a valid agent execution mode
 *   3. All requiredCapabilities are present in the available set
 *
 * @param invocation - The invocation to validate.
 * @param availableCapabilities - The capabilities currently available in the runtime.
 */
export function runAgentPreflight(
    invocation: PlannedAgentInvocation,
    availableCapabilities: ReadonlySet<string> = new Set(),
): AgentPreflightResult {
    if (!invocation.agentId || invocation.agentId.trim() === '') {
        return {
            passed: false,
            failureCode: 'preflight:invalid_agent_id',
            details: 'agentId is empty or whitespace',
            replanAdvised: false,
        };
    }

    if (!VALID_AGENT_EXECUTION_MODES.has(invocation.executionMode)) {
        return {
            passed: false,
            failureCode: 'preflight:invalid_execution_mode',
            details: `executionMode '${invocation.executionMode}' is not valid for agent handoffs; expected llm_assisted or hybrid`,
            replanAdvised: false,
        };
    }

    const required = invocation.requiredCapabilities ?? [];
    const missing = required.filter(c => !availableCapabilities.has(c));
    if (missing.length > 0) {
        return {
            passed: false,
            failureCode: 'preflight:capability_missing',
            details: `missing capabilities: ${missing.join(', ')}`,
            replanAdvised: true,
        };
    }

    return { passed: true };
}

// ─── Result types ─────────────────────────────────────────────────────────────

/** Result of the agent invocation dispatch. */
export interface AgentInvocationResult {
    agentId: string;
    executionMode: GoalExecutionStyle;
    success: boolean;
    data?: unknown;
    error?: string;
    durationMs?: number;
    /** Stable failure reason code; present only when success=false. */
    failureCode?: AgentHandoffFailureCode;
}

/** Result of a full plan agent dispatch. */
export interface AgentDispatchResult {
    planId: string;
    executionBoundaryId: string;
    success: boolean;
    /** Result of the agent invocation attempt. */
    invocation?: AgentInvocationResult;
    /** Populated on overall failure. */
    error?: string;
    /** Stable failure reason code for the overall dispatch; present on failure. */
    failureCode?: AgentHandoffFailureCode;
    /**
     * True when the failure is caused by a preflight check or a condition where
     * replanning is the recommended recovery path (e.g. missing capability).
     * Callers can use this to trigger PlanningService.replan() with the appropriate
     * trigger (e.g. 'capability_loss').
     */
    replanAdvised?: boolean;
    /**
     * Suggested replan trigger code when replanAdvised is true.
     * Directly usable as the `trigger` field of a ReplanRequest.
     */
    replanTrigger?: 'capability_loss' | 'policy_block' | 'dependency_failure';
}

// ─── Coordinator ──────────────────────────────────────────────────────────────

/**
 * AgentHandoffCoordinator
 *
 * Wires the planning subsystem to the agent execution authority for 'agent'
 * type handoffs.  This is the single real execution path from a planning decision
 * to a governed agent kernel invocation.
 *
 * Usage:
 *   const coordinator = new AgentHandoffCoordinator(agentExecutor);
 *   const result = await coordinator.dispatch(planId, availableCapabilities);
 */
export class AgentHandoffCoordinator {
    private readonly _planning: PlanningService;
    private readonly _bus: TelemetryBus;

    constructor(
        private readonly _agentExecutor: IAgentExecutor,
    ) {
        this._planning = PlanningService.getInstance();
        this._bus = TelemetryBus.getInstance();
    }

    /**
     * Dispatches the agent handoff for the plan identified by planId.
     *
     * Pre-conditions:
     *   - Plan must exist and have status 'ready' or 'approved'.
     *   - Plan's handoff.type must be 'agent'.
     *
     * Execution sequence:
     *   1. Validate plan type (throws if wrong)
     *   2. Call markExecutionStarted (generates executionBoundaryId)
     *   3. Emit planning.agent_handoff_dispatched
     *   4. Run preflight (failureCode + replanAdvised on failure)
     *   5. Dispatch to executor
     *   6. Apply failurePolicy if needed
     *   7. On success: markExecutionCompleted
     *   8. On failure: markExecutionFailed with reason code
     *
     * @param planId - The plan to dispatch.
     * @param availableCapabilities - Set of capability names currently available.
     *   Used for preflight validation of requiredCapabilities on the invocation.
     * @throws Error if the plan is not found or has the wrong handoff type.
     */
    async dispatch(
        planId: string,
        availableCapabilities: ReadonlySet<string> = new Set(),
    ): Promise<AgentDispatchResult> {
        const plan = this._planning.getPlan(planId);
        if (!plan) {
            throw new Error(`AgentHandoffCoordinator: plan not found: ${planId}`);
        }

        if (plan.handoff.type !== 'agent') {
            throw new Error(
                `AgentHandoffCoordinator: only 'agent' handoff type is supported` +
                ` (plan ${planId} has type '${plan.handoff.type}')`,
            );
        }

        // Transition plan to executing state (generates executionBoundaryId)
        const executingPlan = this._planning.markExecutionStarted(planId);
        const executionBoundaryId = executingPlan.executionBoundaryId ?? `exec-fallback-${planId}`;

        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.agent_handoff_dispatched',
            payload: {
                planId,
                goalId: plan.goalId,
                executionBoundaryId,
                handoffType: 'agent',
                agentId: plan.handoff.invocation.agentId,
                executionMode: plan.handoff.invocation.executionMode,
            },
        });

        const { invocation, sharedInputs } = plan.handoff;

        // ── Preflight ────────────────────────────────────────────────────────
        const preflightResult = runAgentPreflight(invocation, availableCapabilities);
        if (!preflightResult.passed) {
            const failureMsg = `preflight failed for agent invocation (${invocation.agentId}): ${preflightResult.details ?? preflightResult.failureCode}`;
            this._emitPreflightFailed(plan, executionBoundaryId, invocation, preflightResult);
            this._planning.markExecutionFailed(planId, failureMsg);
            this._emitDispatchFailed(plan, executionBoundaryId, failureMsg, preflightResult.failureCode, preflightResult.replanAdvised);
            return {
                planId,
                executionBoundaryId,
                success: false,
                error: failureMsg,
                failureCode: preflightResult.failureCode,
                replanAdvised: preflightResult.replanAdvised,
                replanTrigger: preflightResult.replanAdvised ? 'capability_loss' : undefined,
            };
        }

        // ── Dispatch ─────────────────────────────────────────────────────────
        try {
            const invocationResult = await this._executeInvocation(
                invocation,
                sharedInputs,
                executionBoundaryId,
                plan,
            );

            if (!invocationResult.success) {
                if (invocation.failurePolicy === 'escalate') {
                    const escalateMsg = `Agent invocation (${invocation.agentId}) requires operator escalation`;
                    this._planning.markExecutionFailed(planId, escalateMsg);
                    this._emitDispatchFailed(plan, executionBoundaryId, escalateMsg, 'policy:escalation_required', true);
                    return {
                        planId,
                        executionBoundaryId,
                        success: false,
                        invocation: invocationResult,
                        error: escalateMsg,
                        failureCode: 'policy:escalation_required',
                        replanAdvised: true,
                        replanTrigger: 'policy_block',
                    };
                }

                if (invocation.failurePolicy === 'stop') {
                    const failureMsg = invocationResult.error ?? `Agent invocation (${invocation.agentId}) failed`;
                    this._planning.markExecutionFailed(planId, failureMsg);
                    this._emitDispatchFailed(plan, executionBoundaryId, failureMsg, invocationResult.failureCode ?? 'execution:agent_failed');
                    return {
                        planId,
                        executionBoundaryId,
                        success: false,
                        invocation: invocationResult,
                        error: failureMsg,
                        failureCode: invocationResult.failureCode ?? 'execution:agent_failed',
                    };
                }
                // 'skip' or 'retry' — tolerate failure and mark completed
            }

            this._planning.markExecutionCompleted(planId);
            const completedAt = new Date().toISOString();
            this._bus.emit({
                executionId: plan.goalId,
                subsystem: 'planning',
                event: 'planning.agent_handoff_completed',
                payload: {
                    planId,
                    goalId: plan.goalId,
                    executionBoundaryId,
                    handoffType: 'agent',
                    agentId: invocation.agentId,
                    completedAt,
                },
            });
            return {
                planId,
                executionBoundaryId,
                success: invocationResult.success,
                invocation: invocationResult,
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this._planning.markExecutionFailed(planId, message);
            this._emitDispatchFailed(plan, executionBoundaryId, message, 'dispatch:executor_unavailable');
            return {
                planId,
                executionBoundaryId,
                success: false,
                error: message,
                failureCode: 'dispatch:executor_unavailable',
            };
        }
    }

    /** Executes the planned agent invocation. */
    private async _executeInvocation(
        invocation: PlannedAgentInvocation,
        sharedInputs: Record<string, unknown>,
        executionBoundaryId: string,
        plan: ExecutionPlan,
    ): Promise<AgentInvocationResult> {
        const mergedInput: Record<string, unknown> = { ...sharedInputs, ...invocation.input };
        const ctx: AgentInvocationContext = {
            executionId: executionBoundaryId,
            executionType: 'planning_handoff',
            executionOrigin: 'planning',
        };

        try {
            const result = await this._agentExecutor.executeAgent(
                invocation.agentId,
                invocation.executionMode,
                mergedInput,
                ctx,
            );
            return {
                agentId: invocation.agentId,
                executionMode: invocation.executionMode,
                success: result.success,
                data: result.data,
                error: result.error,
                durationMs: result.durationMs,
                failureCode: result.success ? undefined : 'execution:agent_failed',
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this._bus.emit({
                executionId: plan.goalId,
                subsystem: 'planning',
                event: 'planning.agent_handoff_invocation_failed',
                payload: {
                    planId: plan.id,
                    goalId: plan.goalId,
                    executionBoundaryId,
                    agentId: invocation.agentId,
                    failureCode: 'dispatch:executor_unavailable',
                    error: message,
                },
            });
            return {
                agentId: invocation.agentId,
                executionMode: invocation.executionMode,
                success: false,
                error: message,
                failureCode: 'dispatch:executor_unavailable',
            };
        }
    }

    private _emitPreflightFailed(
        plan: ExecutionPlan,
        executionBoundaryId: string,
        invocation: PlannedAgentInvocation,
        preflightResult: AgentPreflightResult,
    ): void {
        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.agent_handoff_preflight_failed',
            payload: {
                planId: plan.id,
                goalId: plan.goalId,
                executionBoundaryId,
                agentId: invocation.agentId,
                executionMode: invocation.executionMode,
                failureCode: preflightResult.failureCode,
                details: preflightResult.details,
                replanAdvised: preflightResult.replanAdvised ?? false,
            },
        });
    }

    private _emitDispatchFailed(
        plan: ExecutionPlan,
        executionBoundaryId: string,
        error: string,
        failureCode?: AgentHandoffFailureCode,
        replanAdvised?: boolean,
    ): void {
        this._bus.emit({
            executionId: plan.goalId,
            subsystem: 'planning',
            event: 'planning.agent_handoff_dispatch_failed',
            payload: {
                planId: plan.id,
                goalId: plan.goalId,
                executionBoundaryId,
                handoffType: 'agent',
                failureCode,
                replanAdvised: replanAdvised ?? false,
                error,
            },
        });
    }
}
