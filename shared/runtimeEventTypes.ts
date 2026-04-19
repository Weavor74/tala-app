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
    | 'kernel.turn_received'
    | 'kernel.turn_intent_analyzed'
    | 'kernel.turn_arbitrated'
    | 'kernel.turn_mode_conversational'
    | 'kernel.turn_mode_hybrid'
    | 'kernel.turn_mode_goal_execution'
    | 'kernel.goal_created'
    | 'kernel.goal_resumed'
    | 'kernel.goal_promotion_requested'
    | 'kernel.goal_promotion_rejected'
    | `kernel.${string}`
    | 'agent.self_inspection_detected'
    | 'agent.self_inspection_routed'
    | 'agent.self_inspection_tool_attempted'
    | 'agent.self_inspection_tool_succeeded'
    | 'agent.self_inspection_tool_failed'
    | 'agent.self_inspection_write_blocked'
    | 'agent.self_inspection_bypassed_greeting_policy'
    | 'agent.self_knowledge_detected'
    | 'agent.self_knowledge_routed'
    | 'agent.self_knowledge_snapshot_built'
    | 'agent.self_knowledge_source_unavailable'
    | 'agent.self_knowledge_response_grounded'
    | 'agent.self_knowledge_response_created'
    | 'agent.self_knowledge_response_published'
    | 'agent.self_knowledge_response_missing'
    | 'agent.self_knowledge_fallback_blocked'
    | 'agent.persona_identity_gate_applied'
    | 'agent.persona_identity_meta_disclosure_blocked'
    | 'agent.persona_identity_response_transformed'
    | 'agent.persona_identity_system_disclosure_allowed'
    | 'agent.persona_truth_enforced'
    | 'agent.persona_truth_meta_rewrite_applied'
    | 'agent.persona_truth_meta_disclosure_blocked'
    | 'agent.persona_truth_canon_selected'
    | 'agent.turn_response_created'
    | 'agent.turn_response_published'
    | 'agent.turn_response_missing'
    | `agent.${string}`
    | 'execution.created'
    | 'execution.accepted'
    | 'execution.blocked'
    | 'execution.finalizing'
    | 'execution.completed'
    | 'execution.failed'
    | 'execution.failure_normalized'
    | 'execution.recovery_attempted'
    | 'execution.recovery_retry_scheduled'
    | 'execution.recovery_reroute_selected'
    | 'execution.recovery_succeeded'
    | 'execution.recovery_exhausted'
    | 'execution.replan_requested'
    | 'execution.escalation_requested'
    | 'execution.degraded_completed'
    | `execution.${string}`
    | 'recovery.triggered'
    | 'recovery.decision_made'
    | 'recovery.retry_requested'
    | 'recovery.replan_requested'
    | 'recovery.escalation_requested'
    | 'recovery.degraded_continue_applied'
    | 'recovery.stop_requested'
    | 'recovery.loop_detected'
    | 'recovery.override_requested'
    | 'recovery.override_applied'
    | 'recovery.override_denied'
    | 'recovery.approval_required'
    | 'recovery.approval_granted'
    | 'recovery.approval_denied'
    | 'recovery.history_recorded'
    | 'recovery.analytics_updated'
    | 'recovery.action_executed'
    | 'recovery.action_failed'
    | `recovery.${string}`
    | 'tool.requested'
    | 'tool.completed'
    | 'tool.failed'
    | `tool.${string}`
    | 'memory.write_requested'
    | 'memory.authority_check_requested'
    | 'memory.authority_check_allowed'
    | 'memory.authority_check_denied'
    | 'memory.write_allowed'
    | 'memory.write_blocked'
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
    | 'planning.memory_context_built'
    | 'planning.strategy_selected'
    | 'planning.episode_recorded'
    | 'planning.episode_completed'
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
    | 'planning.agent_handoff_invocation_failed'
    | 'planning.agent_handoff_dispatch_failed'
    | 'planning.agent_handoff_completed'
    | 'planning.loop_started'
    | 'planning.loop_phase_transition'
    | 'planning.loop_iteration_budget_resolved'
    | 'planning.loop_iteration_started'
    | 'planning.loop_iteration_completed'
    | 'planning.loop_iteration_continued'
    | 'planning.loop_iteration_blocked_by_policy'
    | 'planning.loop_iteration_budget_exhausted'
    | 'planning.loop_iteration_replan_requested'
    | 'planning.loop_iteration_replan_accepted'
    | 'planning.loop_iteration_replan_denied'
    | 'planning.loop_iteration_improved_outcome'
    | 'planning.loop_iteration_no_material_improvement'
    | 'planning.iteration_tuning_snapshot_updated'
    | 'planning.iteration_tuning_recommendations_updated'
    | 'planning.iteration_governance_promotion_decided'
    | 'planning.iteration_governance_recommendation_expired'
    | 'planning.iteration_governance_override_revalidated'
    | 'planning.iteration_governance_override_retired'
    | 'planning.iteration_governance_action_requested'
    | 'planning.iteration_governance_action_completed'
    | 'planning.iteration_governance_action_blocked'
    | 'planning.iteration_governance_sweep_started'
    | 'planning.iteration_governance_sweep_completed'
    | 'planning.iteration_governance_recommendation_promoted'
    | 'planning.iteration_governance_recommendation_rejected'
    | 'planning.iteration_governance_override_disabled'
    | 'planning.iteration_governance_override_reenabled'
    | 'planning.iteration_governance_doctrine_incompatibility_detected'
    | 'planning.iteration_governance_assistance_requested'
    | 'planning.iteration_governance_priority_computed'
    | 'planning.iteration_governance_drift_detected'
    | 'planning.iteration_governance_preview_generated'
    | 'planning.iteration_governance_explanation_generated'
    | 'planning.loop_observation'
    | 'planning.loop_replan_decision'
    | 'planning.loop_completed'
    | 'planning.loop_aborted'
    | 'planning.loop_failed'
    | 'planning.plan_execution_started'
    | 'planning.plan_stage_started'
    | 'planning.plan_stage_completed'
    | 'planning.plan_stage_failed'
    | 'planning.plan_execution_completed'
    | 'planning.plan_execution_failed'
    | 'planning.turn_completion_assessed'
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


