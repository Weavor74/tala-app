/**
 * Canonical RuntimeEvent schema for the TelemetryBus.
 *
 * Defined in `shared/` so both the Electron main process (TelemetryBus) and
 * the renderer (TelemetryEventsPanel) share a single authoritative type source.
 *
 * All lifecycle events emitted through TelemetryBus must conform to RuntimeEvent.
 * Raw user content and model prompts must never appear in payload.
 */

// ─── Subsystem ───────────────────────────────────────────────────────────────

/**
 * Subsystem that emitted the event.
 * Aligns with TelemetrySubsystem in shared/telemetry.ts.
 * Typed narrowly so the bus does not depend on the full telemetry schema.
 */
export type RuntimeEventSubsystem =
    | 'kernel'
    | 'agent'
    | 'router'
    | 'autonomy'
    | 'planning'
    | 'inference'
    | 'memory'
    | 'mcp'
    | 'tools'
    | 'system'
    | 'unknown';

// ─── Event type ───────────────────────────────────────────────────────────────

/**
 * Lifecycle event vocabulary for basic execution observability.
 *
 * Naming convention: `<domain>.<lifecycle_verb>`
 *
 * New event types should be added as explicit union members (e.g.
 * `'execution.cancelled'`, `'execution.degraded'`) so tooling and
 * consumers can enumerate them statically.  The template literal
 * catch-alls (`execution.${string}`, `memory.${string}`, etc.) exist as
 * forward-compatibility escape hatches only — do not rely on them for new
 * first-class events.
 */
export type RuntimeEventType =
    | 'execution.created'
    | 'execution.accepted'
    | 'execution.blocked'
    | 'execution.finalizing'
    | 'execution.completed'
    | 'execution.failed'
    | `execution.${string}`
    | 'tool.requested'
    | 'tool.completed'
    | 'tool.failed'
    | `tool.${string}`
    | 'memory.write_requested'
    | 'memory.write_completed'
    | 'memory.write_failed'
    | 'memory.health_evaluated'
    | 'memory.health_transition'
    | 'memory.repair_trigger'
    | 'memory.repair_started'
    | 'memory.repair_action_started'
    | 'memory.repair_action_completed'
    | 'memory.repair_completed'
    | 'memory.capability_blocked'
    | 'memory.deferred_work_enqueued'
    | 'memory.deferred_work_drain_started'
    | 'memory.deferred_work_item_completed'
    | 'memory.deferred_work_item_failed'
    | 'memory.deferred_work_drain_completed'
    | 'memory.deferred_dead_lettered'
    | 'memory.repair_outcome_persisted'
    | 'memory.repair_reflection_generated'
    | 'memory.maintenance_run_started'
    | 'memory.maintenance_run_completed'
    | 'memory.maintenance_run_skipped'
    | 'memory.maintenance_decision'
    | 'memory.maintenance_escalation'
    | 'memory.adaptive_plan_generated'
    | 'memory.optimization_suggestions_generated'
    | `memory.${string}`
    | 'validation.requested'
    | 'validation.completed'
    | 'validation.failed'
    | `validation.${string}`
    | 'policy.rule_matched'
    | 'policy.rule_denied'
    | 'policy.default_allow'
    | `policy.${string}`
    | 'context.assembly_requested'
    | 'context.assembled'
    | 'context.truncated'
    | 'context.section_excluded'
    | `context.${string}`
    | 'planning.goal_registered'
    | 'planning.goal_analyzed'
    | 'planning.plan_created'
    | 'planning.plan_blocked'
    | 'planning.plan_approved'
    | 'planning.plan_denied'
    | 'planning.execution_handoff'
    | 'planning.replan_requested'
    | 'planning.plan_superseded'
    | 'planning.plan_completed'
    | 'planning.plan_failed'
    | 'planning.handoff_dispatched'
    | 'planning.handoff_dispatch_failed'
    | 'planning.handoff_step_failed'
    | 'planning.handoff_preflight_failed'
    | 'planning.workflow_handoff_dispatched'
    | 'planning.workflow_handoff_preflight_failed'
    | 'planning.workflow_handoff_invocation_failed'
    | 'planning.workflow_handoff_dispatch_failed'
    | 'planning.workflow_handoff_completed'
    | 'planning.agent_handoff_dispatched'
    | 'planning.agent_handoff_preflight_failed'
    | 'planning.agent_handoff_dispatch_failed'
    | 'planning.agent_handoff_completed'
    | 'planning.loop_started'
    | 'planning.loop_phase_transition'
    | 'planning.loop_iteration_started'
    | 'planning.loop_observation'
    | 'planning.loop_replan_decision'
    | 'planning.loop_completed'
    | 'planning.loop_aborted'
    | 'planning.loop_failed'
    /** Authority routing: non-trivial work was routed through PlanningLoopService. */
    | 'planning.loop_routing_selected'
    /** Authority routing: non-trivial work bypassed the loop (loop not initialised). */
    | 'planning.loop_routing_bypass_surfaced'
    /** Authority routing: trivial direct path was allowed for this request. */
    | 'planning.loop_routing_direct_allowed'
    /**
     * Authority lane resolved: the named authority lane that governed this
     * execution turn has been determined.  Emitted once per execution boundary
     * on all surfaces (chat, degraded chat, autonomy, operator).
     * Payload conforms to AuthorityLaneDiagnosticsRecord from
     * shared/planning/executionAuthorityTypes.ts.
     */
    | 'planning.authority_lane_resolved'
    | `planning.${string}`;

// ─── Event envelope ───────────────────────────────────────────────────────────

/**
 * Canonical runtime event envelope.
 *
 * Every significant lifecycle transition emitted through TelemetryBus must
 * conform to this shape. Fields are ordered from most stable (id, timestamp)
 * to most contextual (phase, payload).
 */
export interface RuntimeEvent {
    /** Unique event ID — `tevt-<uuid v4>`. */
    id: string;
    /** ISO 8601 UTC timestamp of emission. */
    timestamp: string;
    /** ID of the execution this event belongs to. Matches ExecutionRequest.executionId. */
    executionId: string;
    /**
     * Optional correlation chain ID. Use to link related events across subsystems
     * (e.g. an autonomy task spawning a chat_turn).
     */
    correlationId?: string;
    /** Subsystem that emitted this event. */
    subsystem: RuntimeEventSubsystem;
    /** Lifecycle event type. */
    event: RuntimeEventType;
    /**
     * Optional sub-phase label within the event's lifecycle stage.
     * Examples: 'intake', 'classify', 'context_assembly', 'tool_dispatch'.
     * Subsystems define their own phase labels.
     */
    phase?: string;
    /**
     * Optional structured payload. Must not contain raw user content or model prompts.
     * Typed as `Record<string, unknown>` to remain open for future extension.
     */
    payload?: Record<string, unknown>;
}

// ─── Handler type ─────────────────────────────────────────────────────────────

/** Handler invoked synchronously for each emitted event. */
export type RuntimeEventHandler = (event: RuntimeEvent) => void;
