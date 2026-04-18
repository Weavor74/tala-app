# Contract: runtimeEventTypes.ts

**Source**: [shared\runtimeEventTypes.ts](../../shared/runtimeEventTypes.ts)

## Interfaces

### `RuntimeEvent`
```typescript
interface RuntimeEvent {
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
```

### `RuntimeEventSubsystem`
```typescript
type RuntimeEventSubsystem = 
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
```

### `RuntimeEventType`
```typescript
type RuntimeEventType = 
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
    | 'planning.loop_iteration_started'
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
```

### `RuntimeEventHandler`
```typescript
type RuntimeEventHandler =  (event: RuntimeEvent) => void;
```

