# Contract: telemetry.ts

**Source**: [shared\telemetry.ts](../../shared/telemetry.ts)

## Interfaces

### `CanonicalTelemetryEvent`
```typescript
interface CanonicalTelemetryEvent {
    /** ISO 8601 UTC timestamp of event emission. */
    timestamp: string;
    /** Unique event ID (uuid v4). */
    eventId: string;
    /** The agent turn this event belongs to ('global' when not turn-scoped). */
    turnId: string;
    /** Optional correlation chain ID for multi-step operations. */
    correlationId?: string;
    /** Session ID for grouping events across turns. */
    sessionId: string;
    /** The subsystem that emitted this event. */
    subsystem: TelemetrySubsystem;
    /** Specific event type. */
    eventType: TelemetryEventType;
    /** Severity level. */
    severity: TelemetrySeverity;
    /** Operating mode at the time of the event. */
    mode: string;
    /** Service or component that emitted this event. */
    actor: string;
    /** Human-readable summary safe for logging (no sensitive content). */
    summary: string;
    /** Structured payload — must not contain raw user content or model prompts. */
    payload: Record<string, unknown>;
    /** Whether the operation this event represents succeeded, failed, etc. */
    status: TelemetryStatus;
    /** Telemetry channel (audit / operational / debug). */
    channel: TelemetryChannel;
}
```

### `TurnPayload`
```typescript
interface TurnPayload {
    mode: string;
    intent?: string;
    intentConfidence?: number;
    durationMs?: number;
    toolCallCount?: number;
    hadErrors?: boolean;
}
```

### `InferencePayload`
```typescript
interface InferencePayload {
    provider: string;
    engine: string;
    modelName: string;
    streamMode: boolean;
    requestDurationMs?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    errorCode?: string;
    errorMessage?: string;
}
```

### `LocalInferenceStatePayload`
```typescript
interface LocalInferenceStatePayload {
    previousState: LocalInferenceState;
    newState: LocalInferenceState;
    reason: string;
    port?: number;
    modelPath?: string;
}
```

### `McpLifecyclePayload`
```typescript
interface McpLifecyclePayload {
    serviceId: string;
    serviceKind: 'stdio' | 'websocket';
    priorState: McpServiceState;
    newState: McpServiceState;
    reason?: string;
    durationMs?: number;
    restartCount?: number;
}
```

### `McpHealthCheckPayload`
```typescript
interface McpHealthCheckPayload {
    serviceId: string;
    serviceKind: 'stdio' | 'websocket';
    healthy: boolean;
    durationMs?: number;
    errorMessage?: string;
    retryCount?: number;
}
```

### `McpInventoryPayload`
```typescript
interface McpInventoryPayload {
    totalConfigured: number;
    totalReady: number;
    totalDegraded: number;
    totalUnavailable: number;
}
```

### `MemoryPayload`
```typescript
interface MemoryPayload {
    retrievedCount?: number;
    filteredCount?: number;
    writeCategory?: string;
    writeSuppressed?: boolean;
    suppressReason?: string;
}
```

### `DocRetrievalPayload`
```typescript
interface DocRetrievalPayload {
    query?: string;
    resultCount?: number;
    topScore?: number;
    sources?: string[];
    suppressReason?: string;
    gatingRuleMatched?: string;
    durationMs?: number;
}
```

### `ReflectionPayload`
```typescript
interface ReflectionPayload {
    triggerReason: string;
    evidenceSummary?: string;
    anomalyCount?: number;
    failureCount?: number;
    outputType?: ReflectionOutputType;
    suppressReason?: string;
}
```

### `CognitivePayload`
```typescript
interface CognitivePayload {
    /** Active mode for the turn. */
    mode?: string;
    /** Number of memory contributions applied. */
    memoryContributionCount?: number;
    /** Memory categories applied (counts per category). */
    memoryCategories?: Partial<Record<string, number>>;
    /** Whether memory retrieval was suppressed. */
    memoryRetrievalSuppressed?: boolean;
    /** Whether documentation context was applied. */
    docContextApplied?: boolean;
    /** Number of documentation sources applied. */
    docSourceCount?: number;
    /** Whether emotional modulation was applied. */
    emotionalModulationApplied?: boolean;
    /** Emotional modulation strength. */
    emotionalModulationStrength?: string;
    /** Whether astro engine was unavailable. */
    astroUnavailable?: boolean;
    /** Number of reflection behavioral notes applied. */
    reflectionNoteCount?: number;
    /** Whether the cognitive context was compacted. */
    wasCompacted?: boolean;
    /** Correlation ID linking to the full audit trail. */
    correlationId?: string;
    /** Reason for skipping modulation or reflection contribution. */
    skipReason?: string;
}
```

### `ArtifactPayload`
```typescript
interface ArtifactPayload {
    channel: string;
    artifactType?: string;
    suppressChatContent?: boolean;
    reason?: string;
}
```

### `McpPayload`
```typescript
interface McpPayload {
    serverId?: string;
    toolName?: string;
    serverState?: string;
    durationMs?: number;
    errorMessage?: string;
}
```

### `TurnReconstruction`
```typescript
interface TurnReconstruction {
    turnId: string;
    sessionId: string;
    mode: string;
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
    intent?: string;
    memoryRetrieved: boolean;
    memoryWriteCategory?: string;
    inferenceProvider?: string;
    inferenceModel?: string;
    inferenceDurationMs?: number;
    inferenceStatus: TelemetryStatus;
    artifactChannel?: string;
    docRetrievalOccurred: boolean;
    docSources?: string[];
    reflectionTriggered: boolean;
    hadErrors: boolean;
    hadDegradedFallback: boolean;
    toolCallCount: number;
    eventSequence: Array<{ eventType: TelemetryEventType; timestamp: string; status: TelemetryStatus }
```

### `A2UITelemetryPayload`
```typescript
interface A2UITelemetryPayload {
    /** Surface identifier (cognition, world, maintenance). */
    surfaceId?: string;
    /** Surface type classification. */
    surfaceType?: string;
    /** Target rendering pane. Always 'document_editor' for Tala surfaces. */
    targetPane?: 'document_editor';
    /** Action name, if this is an action event. */
    actionName?: string;
    /** Outcome of the operation. */
    outcome?: 'success' | 'failure' | 'rejected' | 'fallback';
    /** Whether the surface tab was focused after the operation. */
    focused?: boolean;
    /** Human-readable reason for rejection or failure. */
    reason?: string;
}
```

### `TelemetrySeverity`
```typescript
type TelemetrySeverity =  'debug' | 'info' | 'warn' | 'error';
```

### `TelemetrySubsystem`
```typescript
type TelemetrySubsystem = 
    | 'agent'
    | 'router'
    | 'memory'
    | 'retrieval'
    | 'inference'
    | 'local_inference'
    | 'mcp'
    | 'artifact'
    | 'docs_intel'
    | 'reflection'
    | 'planning'
    | 'execution'
    | 'governance'
    | 'cognitive'
    | 'audit'
    | 'system'
    | 'world_model'
    | 'maintenance'
    | 'autonomy'
    | 'self_model'
    | 'unknown';
```

### `TelemetryEventType`
```typescript
type TelemetryEventType = 
    // Turn lifecycle
    | 'turn_start'
    | 'turn_completed'
    | 'context_assembled'
    | 'mode_applied'
    // Memory
    | 'memory_retrieved'
    | 'memory_write_decision'
    | 'memory_retrieval_suppressed'
    // Capability / policy
    | 'capability_gated'
    // MCP lifecycle (Priority 2A — parity with inference lifecycle events)
    | 'mcp_service_starting'
    | 'mcp_service_ready'
    | 'mcp_service_degraded'
    | 'mcp_service_unavailable'
    | 'mcp_service_failed'
    | 'mcp_service_recovering'
    | 'mcp_service_recovered'
    | 'mcp_health_check_completed'
    | 'mcp_health_check_failed'
    | 'mcp_inventory_refreshed'
    // MCP tool invocation
    | 'mcp_status'
    | 'mcp_tool_invoked'
    | 'mcp_tool_failed'
    // Inference
    | 'inference_started'
    | 'inference_completed'
    | 'inference_failed'
    | 'inference_timeout'
    | 'inference_stream_partial'
    | 'inference_state_changed'
    // Provider lifecycle
    | 'provider_inventory_refreshed'
    | 'provider_detected'
    | 'provider_probe_failed'
    | 'provider_selected'
    | 'provider_fallback_applied'
    | 'provider_unavailable'
    // Provider runtime controls (Phase 2B)
    | 'provider_restart_requested'
    | 'provider_restart_completed'
    | 'provider_disabled'
    | 'provider_enabled'
    | 'provider_health_demoted'
    | 'provider_health_recovered'
    // MCP runtime controls (Phase 2B)
    | 'mcp_service_restart_requested'
    | 'mcp_service_restart_completed'
    | 'mcp_service_disabled'
    | 'mcp_service_enabled'
    // Streaming
    | 'stream_opened'
    | 'stream_completed'
    | 'stream_aborted'
    // Artifact routing
    | 'artifact_routed'
    | 'artifact_suppressed'
    // Documentation intelligence
    | 'doc_retrieval_started'
    | 'doc_retrieval_completed'
    | 'doc_retrieval_suppressed'
    | 'doc_retrieval_failed'
    // Reflection
    | 'reflection_triggered'
    | 'reflection_completed'
    | 'reflection_suppressed'
    | 'reflection_output_ready'
    // Cognitive loop (Phase 3)
    | 'cognitive_context_assembled'
    | 'memory_contribution_applied'
    | 'mode_policy_applied'
    | 'emotional_modulation_applied'
    | 'emotional_modulation_skipped'
    | 'reflection_contribution_applied'
    | 'doc_context_applied'
    | 'cognitive_context_compacted'
    // Phase 3B — Small-model compaction
    | 'prompt_profile_selected'
    | 'cognitive_context_compacted_for_model'
    | 'identity_compression_applied'
    | 'tool_compression_applied'
    | 'emotional_compression_applied'
    | 'memory_budget_applied'
    | 'doc_budget_applied'
    | 'reflection_budget_applied'
    // Phase 3A — Live cognitive path integration
    | 'preinference_orchestration_started'
    | 'preinference_orchestration_completed'
    | 'preinference_orchestration_failed'
    | 'mcp_preinference_requested'
    | 'mcp_preinference_completed'
    | 'mcp_preinference_suppressed'
    | 'mcp_preinference_failed'
    | 'memory_preinference_applied'
    | 'doc_preinference_applied'
    | 'emotional_state_requested'
    | 'emotional_state_applied'
    | 'emotional_state_skipped'
    | 'reflection_note_applied'
    | 'reflection_note_suppressed'
    | 'live_cognitive_context_recorded'
    | 'live_compaction_applied'
    | 'post_turn_memory_write'
    | 'post_turn_reflection_signal'
    // Phase 3C — Cognitive Behavior Validation + Small-Model Tuning
    | 'token_budget_computed'
    | 'memory_ranking_applied'
    | 'memory_explicit_override'
    | 'doc_retrieval_gated'
    | 'mcp_gating_evaluated'
    | 'emotional_modulation_capped'
    | 'reflection_threshold_evaluated'
    | 'preinference_duration_ms'
    | 'cognitive_assembly_duration_ms'
    | 'compaction_duration_ms'
    // Phase 4A — World Model
    | 'world_model_build_started'
    | 'world_model_build_completed'
    | 'world_model_build_partial'
    | 'world_model_build_failed'
    | 'world_state_applied'
    | 'world_state_skipped'
    // Degraded / fallback
    | 'degraded_fallback'
    | 'subsystem_unavailable'
    // Phase 4B — Self-maintenance
    | 'maintenance_issue_detected'
    | 'maintenance_issue_cleared'
    | 'maintenance_policy_evaluated'
    | 'maintenance_action_recommended'
    | 'maintenance_action_autoexecuted'
    | 'maintenance_action_skipped'
    | 'maintenance_action_failed'
    | 'maintenance_cooldown_applied'
    | 'maintenance_mode_changed'
    // A2UI workspace surfaces (Phase 4C)
    | 'a2ui_surface_open_requested'
    | 'a2ui_surface_opened'
    | 'a2ui_surface_updated'
    | 'a2ui_surface_failed'
    | 'a2ui_action_received'
    | 'a2ui_action_validated'
    | 'a2ui_action_executed'
    | 'a2ui_action_failed'
    // Browser task mode
    | 'browser_task_activated'
    | 'browser_task_tools_filtered'
    | 'browser_task_dom_fetched'
    | 'browser_task_step'
    | 'browser_task_finalized'
    | 'browser_task_continuation'
    // External search
    | 'external_search_started'
    | 'external_search_succeeded'
    | 'external_search_empty'
    | 'external_search_failed'
    | 'external_search_timeout'
    | 'external_search_fallback'
    // Phase 4 — Autonomous Self-Improvement
    | 'autonomy_goal_detected'
    | 'autonomy_goal_deduped'
    | 'autonomy_goal_ranked'
    | 'autonomy_goal_blocked'
    | 'autonomy_goal_selected'
    | 'autonomy_run_started'
    | 'autonomy_run_planning_started'
    | 'autonomy_run_governance_blocked'
    | 'autonomy_run_execution_started'
    | 'autonomy_run_completed'
    | 'autonomy_run_failed'
    | 'autonomy_run_cooled_down'
    | 'autonomy_learning_recorded'
    | 'autonomy_detection_cycle_started'
    // Phase 4.3 — Recovery Packs
    | 'recovery_pack_match_attempted'
    | 'recovery_pack_used'
    | 'recovery_pack_fallback'
    | 'recovery_pack_confidence_adjusted'
    | 'recovery_pack_outcome_recorded'
    // Phase 5.5 — Repair Campaigns
    | 'campaign_deferred'
    | 'campaign_aborted'
    | 'campaign_resumed'
    | 'campaign_halted'
    | 'campaign_completed'
    | 'campaign_rolled_back'
    | 'campaign_expired'
    | 'campaign_safety_bound_triggered'
    | 'campaign_checkpoint_completed'
    | 'campaign_reassessment_decided'
    // Phase 5.6 — Harmonization
    | 'harmonization_drift_detected'
    | 'harmonization_rule_matched'
    | 'harmonization_rule_weak_match'
    | 'harmonization_rule_rejected'
    | 'harmonization_rule_confidence_adjusted'
    | 'harmonization_campaign_created'
    | 'harmonization_campaign_fallback'
    | 'harmonization_campaign_succeeded'
    | 'harmonization_campaign_failed'
    | 'harmonization_campaign_rolled_back'
    | 'harmonization_outcome_recorded'
    | 'harmonization.dashboard.emitted'
    // Subsystem-namespaced events (Phase 3 execution, governance, planning, self-model)
    | `execution.${string}`
    | `governance.${string}`
    | `planning.${string}`
    | `selfModel.${string}`
    // Generic
    | 'operational'
    | 'developer_debug';
```

### `TelemetryChannel`
```typescript
type TelemetryChannel =  'audit' | 'operational' | 'debug';
```

### `TelemetryStatus`
```typescript
type TelemetryStatus =  'success' | 'failure' | 'partial' | 'suppressed' | 'unknown';
```

### `LocalInferenceState`
```typescript
type LocalInferenceState = 
    | 'disabled'
    | 'starting'
    | 'ready'
    | 'busy'
    | 'degraded'
    | 'unavailable'
    | 'failed';
```

### `McpServiceState`
```typescript
type McpServiceState = 
    | 'disabled'
    | 'starting'
    | 'ready'
    | 'degraded'
    | 'unavailable'
    | 'failed'
    | 'recovering'
    | 'stopped';
```

### `ReflectionOutputType`
```typescript
type ReflectionOutputType = 
    | 'operational_summary'
    | 'anomaly_summary'
    | 'improvement_candidate'
    | 'regression_warning'
    | 'confidence_limited_observation';
```

