# Contract: runtimeEventTypes.ts

**Source**: [shared/runtimeEventTypes.ts](../../shared/runtimeEventTypes.ts)

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
    | 'planning.loop_started'
    | 'planning.loop_phase_transition'
    | 'planning.loop_iteration_started'
    | 'planning.loop_observation'
    | 'planning.loop_replan_decision'
    | 'planning.loop_completed'
    | 'planning.loop_aborted'
    | 'planning.loop_failed'
    | `planning.${string}`;
```

### `RuntimeEventHandler`
```typescript
type RuntimeEventHandler =  (event: RuntimeEvent) => void;
```

