/**
 * executionTypes.ts — Shared Runtime Execution Contracts
 *
 * Canonical vocabulary for execution modeling across the Tala runtime.
 * Shared between Electron main process, renderer, and any future subsystem
 * that needs to describe, track, or reason about a unit of runtime work.
 *
 * Design principles:
 * - Lightweight: types only — no logic, no imports, no side-effects
 * - Stable: naming is forward-compatible with current and near-future paths
 * - Non-invasive: existing Phase 3 executionTypes.ts is not modified
 * - Composable: callers may extend these interfaces for phase-specific needs
 *
 * Relationship to existing types:
 *   shared/executionTypes.ts        — Phase 3 controlled execution lifecycle (narrower scope)
 *   electron/services/kernel/AgentKernel.ts — KernelExecutionMeta / ExecutionType (kernel-local)
 *   shared/autonomyTypes.ts         — autonomous goal execution tracking
 *   shared/telemetry.ts             — TelemetrySubsystem for observability
 *
 * Phase 2 adoption candidates (first callers):
 *   - AgentKernel.ts   (KernelExecutionMeta can reference RuntimeExecutionType)
 *   - IpcRouter.ts     (chat-done payload can surface executionOrigin)
 *   - AutonomousRunOrchestrator.ts (map autonomous runs to RuntimeExecutionState)
 */

// ─── Execution Type ───────────────────────────────────────────────────────────

/**
 * Discriminated type of a runtime execution unit.
 *
 * chat_turn          — a user-initiated conversational turn
 * workflow_run       — an execution driven by a saved workflow definition
 * tool_action        — a discrete MCP tool invocation or tool chain
 * autonomy_task      — an autonomous goal scheduled and run by AutonomousRunOrchestrator
 * reflection_task    — a reflection or self-model evaluation pass
 * system_maintenance — a background maintenance or housekeeping operation
 */
export type RuntimeExecutionType =
    | 'chat_turn'
    | 'workflow_run'
    | 'tool_action'
    | 'autonomy_task'
    | 'reflection_task'
    | 'system_maintenance';

// ─── Execution Origin ─────────────────────────────────────────────────────────

/**
 * The originating source of a runtime execution request.
 *
 * chat_ui            — initiated from the renderer chat interface
 * ipc                — initiated via an IPC call from the renderer or a preload bridge
 * workflow_builder   — initiated by the workflow builder surface
 * guardrails_builder — initiated by the guardrails/policy configuration surface
 * autonomy_engine    — initiated internally by AutonomousRunOrchestrator
 * system             — initiated by the Electron main process itself (boot, maintenance)
 * scheduler          — initiated by a scheduled or timer-based trigger
 */
export type RuntimeExecutionOrigin =
    | 'chat_ui'
    | 'ipc'
    | 'workflow_builder'
    | 'guardrails_builder'
    | 'autonomy_engine'
    | 'system'
    | 'scheduler';

// ─── Execution Mode ───────────────────────────────────────────────────────────

/**
 * The Tala runtime mode in effect when the execution was created.
 *
 * assistant — standard assistant mode; tool use permitted; no roleplay persona
 * hybrid    — blended assistant + light roleplay persona; tool use permitted
 * rp        — full roleplay mode; tool use may be suppressed depending on policy
 * system    — internal system execution; no user-facing mode applies
 */
export type RuntimeExecutionMode =
    | 'assistant'
    | 'hybrid'
    | 'rp'
    | 'system';

// ─── Execution Status ─────────────────────────────────────────────────────────

/**
 * Normalized lifecycle status for a runtime execution unit.
 *
 * Forward-only state machine. Terminal states: completed | failed | cancelled | degraded.
 *
 * created     — execution request received and registered; not yet evaluated
 * accepted    — request passed pre-flight checks; ready to begin
 * blocked     — request was evaluated and blocked (governance, policy, or eligibility)
 * planning    — active planning phase (e.g. SafeChangePlanner, strategy selection)
 * executing   — actively applying changes or invoking tools
 * finalizing  — post-execution cleanup, verification, or scoring
 * completed   — execution succeeded and finalized cleanly
 * failed      — execution encountered an unrecoverable error
 * cancelled   — execution was explicitly cancelled before or during execution
 * degraded    — execution completed but with partial or reduced-quality output
 */
export type RuntimeExecutionStatus =
    | 'created'
    | 'accepted'
    | 'blocked'
    | 'planning'
    | 'executing'
    | 'finalizing'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'degraded';

// ─── Execution Request ────────────────────────────────────────────────────────

/**
 * Normalized request envelope for a unit of Tala runtime work.
 *
 * Callers that need additional fields should extend this interface rather
 * than modifying it. Phase-specific envelopes (e.g. KernelRequest) may
 * embed or reference ExecutionRequest fields.
 */
export interface ExecutionRequest {
    /** Unique ID for this execution request. Prefer `exec-` prefix + UUID v4. */
    executionId: string;
    /**
     * ID of the parent execution, if this request was spawned by another.
     * Enables hierarchical tracking (e.g. an autonomy_task spawning tool_actions).
     */
    parentExecutionId?: string;
    /** Logical type of the execution. */
    type: RuntimeExecutionType;
    /** The originating source of the request. */
    origin: RuntimeExecutionOrigin;
    /** The Tala runtime mode in effect when the request was created. */
    mode: RuntimeExecutionMode;
    /**
     * Identity of the actor that initiated the request.
     * For user-initiated requests: the user identifier or session ID.
     * For system/autonomy requests: the subsystem name (e.g. 'autonomy_engine').
     */
    actor: string;
    /**
     * The primary input payload for this execution (e.g. user message, workflow spec).
     * Typed as `unknown` here so the base contract imposes no structural requirements.
     * Subsystems that handle a specific execution type should define a typed extension
     * of `ExecutionRequest` with a narrowed `input` field (e.g. `input: { message: string }`
     * for `chat_turn`, or `input: WorkflowDefinition` for `workflow_run`).
     */
    input: unknown;
    /** Arbitrary key-value metadata attached at request creation time. */
    metadata: Record<string, unknown>;
    /**
     * ISO 8601 timestamp when the execution request was created.
     * All timestamps in this module use ISO 8601 strings (e.g. `new Date().toISOString()`).
     * Consumers must parse this string for date arithmetic; TypeScript cannot enforce
     * the format at compile time.
     */
    createdAt: string;
}

// ─── Execution State ──────────────────────────────────────────────────────────

/**
 * Tracked runtime state for an active or completed execution unit.
 *
 * ExecutionState is the mutable counterpart to the immutable ExecutionRequest.
 * Subsystems that track execution progress should produce or update an
 * ExecutionState for each request they handle.
 */
export interface ExecutionState {
    /** Matches the executionId in the originating ExecutionRequest. */
    executionId: string;
    /** Logical type of the execution (copied from request). */
    type: RuntimeExecutionType;
    /** The originating source of the request (copied from request). */
    origin: RuntimeExecutionOrigin;
    /** The runtime mode in effect for this execution (copied from request). */
    mode: RuntimeExecutionMode;
    /** Current lifecycle status. */
    status: RuntimeExecutionStatus;
    /**
     * Human-readable label for the current internal phase within the execution.
     * More granular than `status`. Examples: 'context_assembly', 'tool_dispatch',
     * 'patch_apply', 'verification'. Subsystems define their own phase labels.
     */
    phase: string;
    /** ISO 8601 timestamp when execution began (transitioned to 'accepted'). */
    startedAt: string;
    /** ISO 8601 timestamp of the most recent status or phase update. */
    updatedAt: string;
    /** ISO 8601 timestamp when the execution reached a terminal status. */
    completedAt?: string;
    /**
     * True when the execution is in or completed in the 'degraded' status.
     * A degraded execution produced output but with reduced quality or partial results.
     */
    degraded: boolean;
    /**
     * Human-readable reason if the execution reached 'blocked' status.
     * Should reference the policy, rule, or check that caused the block.
     */
    blockedReason?: string;
    /**
     * Human-readable reason if the execution reached 'failed' status.
     * Should be stable enough for logging and telemetry correlation.
     */
    failureReason?: string;
    /**
     * Name of the subsystem currently handling this execution.
     * Updated as execution hands off between subsystems (e.g. 'AgentKernel',
     * 'AgentService', 'ToolGatekeeper', 'SafeChangePlanner').
     */
    activeSubsystem?: string;
    /**
     * Number of retry attempts made for this execution.
     * 0 for first attempt. Bounded by subsystem-specific retry limits.
     */
    retries: number;
    /**
     * Ordered list of tool call identifiers invoked during this execution.
     * Provides a lightweight audit trail without full tool output payloads.
     */
    toolCalls: string[];
}
