/**
 * Canonical Telemetry Schema — Phase 2 Trustworthiness Hardening
 *
 * Defines the single authoritative event envelope for all structured telemetry
 * emitted across TALA subsystems. Every significant runtime action must produce
 * an event that conforms to this schema so that a user turn can be reconstructed
 * from telemetry alone.
 *
 * Event categories mirror the turn lifecycle:
 *   turn_start → context_assembled → inference_started → inference_completed
 *   → artifact_routed → turn_completed
 *
 * Failure states are first-class:
 *   inference_failed, degraded_fallback, mcp_unavailable, doc_retrieval_suppressed
 *
 * Redaction policy:
 *   Raw user content and model prompts are never stored in the payload.
 *   Use summary/hash fields when attribution is required.
 */

// ─── Severity ────────────────────────────────────────────────────────────────

export type TelemetrySeverity = 'debug' | 'info' | 'warn' | 'error';

// ─── Subsystem identifiers ────────────────────────────────────────────────────

export type TelemetrySubsystem =
    | 'agent'
    | 'router'
    | 'memory'
    | 'inference'
    | 'local_inference'
    | 'mcp'
    | 'artifact'
    | 'docs_intel'
    | 'reflection'
    | 'audit'
    | 'system'
    | 'unknown';

// ─── Event type categories ────────────────────────────────────────────────────

export type TelemetryEventType =
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
    // Degraded / fallback
    | 'degraded_fallback'
    | 'subsystem_unavailable'
    // Generic
    | 'operational'
    | 'developer_debug';

// ─── Event channel classification ────────────────────────────────────────────

/**
 * Distinguishes between three telemetry channels:
 * - audit: immutable record for human diagnosis and compliance
 * - operational: service health and runtime state changes
 * - debug: verbose developer context (may be filtered in production)
 */
export type TelemetryChannel = 'audit' | 'operational' | 'debug';

// ─── Status ──────────────────────────────────────────────────────────────────

export type TelemetryStatus = 'success' | 'failure' | 'partial' | 'suppressed' | 'unknown';

// ─── Canonical event envelope ─────────────────────────────────────────────────

/**
 * The canonical telemetry event emitted by all TALA subsystems.
 *
 * Every field is required except for optional payload and correlationId.
 * Sensitive content must never appear in summary or payload.
 */
export interface CanonicalTelemetryEvent {
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

// ─── Typed payload interfaces ─────────────────────────────────────────────────

/** Payload for turn_start / turn_completed events. */
export interface TurnPayload {
    mode: string;
    intent?: string;
    intentConfidence?: number;
    durationMs?: number;
    toolCallCount?: number;
    hadErrors?: boolean;
}

/** Payload for inference_started / inference_completed / inference_failed events. */
export interface InferencePayload {
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

/** Payload for local_inference state change events. */
export interface LocalInferenceStatePayload {
    previousState: LocalInferenceState;
    newState: LocalInferenceState;
    reason: string;
    port?: number;
    modelPath?: string;
}

/**
 * Lifecycle states for the local inference subsystem.
 * These are explicit, named states — not boolean flags.
 */
export type LocalInferenceState =
    | 'disabled'
    | 'starting'
    | 'ready'
    | 'busy'
    | 'degraded'
    | 'unavailable'
    | 'failed';

/**
 * Lifecycle states for individual MCP services.
 * Aligned with RuntimeStatus in runtimeDiagnosticsTypes.ts.
 */
export type McpServiceState =
    | 'disabled'
    | 'starting'
    | 'ready'
    | 'degraded'
    | 'unavailable'
    | 'failed'
    | 'recovering'
    | 'stopped';

/**
 * Payload for MCP service lifecycle transition events.
 * Used by mcp_service_starting, mcp_service_ready, mcp_service_degraded,
 * mcp_service_unavailable, mcp_service_failed, mcp_service_recovering,
 * mcp_service_recovered.
 */
export interface McpLifecyclePayload {
    serviceId: string;
    serviceKind: 'stdio' | 'websocket';
    priorState: McpServiceState;
    newState: McpServiceState;
    reason?: string;
    durationMs?: number;
    restartCount?: number;
}

/**
 * Payload for mcp_health_check_completed / mcp_health_check_failed events.
 */
export interface McpHealthCheckPayload {
    serviceId: string;
    serviceKind: 'stdio' | 'websocket';
    healthy: boolean;
    durationMs?: number;
    errorMessage?: string;
    retryCount?: number;
}

/**
 * Payload for mcp_inventory_refreshed events.
 */
export interface McpInventoryPayload {
    totalConfigured: number;
    totalReady: number;
    totalDegraded: number;
    totalUnavailable: number;
}

/** Payload for memory_retrieved / memory_write_decision events. */
export interface MemoryPayload {
    retrievedCount?: number;
    filteredCount?: number;
    writeCategory?: string;
    writeSuppressed?: boolean;
    suppressReason?: string;
}

/** Payload for doc_retrieval_* events. */
export interface DocRetrievalPayload {
    query?: string;
    resultCount?: number;
    topScore?: number;
    sources?: string[];
    suppressReason?: string;
    gatingRuleMatched?: string;
    durationMs?: number;
}

/** Payload for reflection_* events. */
export interface ReflectionPayload {
    triggerReason: string;
    evidenceSummary?: string;
    anomalyCount?: number;
    failureCount?: number;
    outputType?: ReflectionOutputType;
    suppressReason?: string;
}

/**
 * Classification of reflection output types.
 * Each output type encodes the nature of the reflection conclusion.
 */
export type ReflectionOutputType =
    | 'operational_summary'
    | 'anomaly_summary'
    | 'improvement_candidate'
    | 'regression_warning'
    | 'confidence_limited_observation';

/** Payload for artifact_routed / artifact_suppressed events. */
export interface ArtifactPayload {
    channel: string;
    artifactType?: string;
    suppressChatContent?: boolean;
    reason?: string;
}

/** Payload for mcp_status / mcp_tool_invoked events. */
export interface McpPayload {
    serverId?: string;
    toolName?: string;
    serverState?: string;
    durationMs?: number;
    errorMessage?: string;
}

// ─── Turn reconstruction model ────────────────────────────────────────────────

/**
 * A reconstructed view of a single agent turn, assembled from telemetry events.
 * Supports human diagnosis without requiring raw log inspection.
 */
export interface TurnReconstruction {
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
    eventSequence: Array<{ eventType: TelemetryEventType; timestamp: string; status: TelemetryStatus }>;
}
