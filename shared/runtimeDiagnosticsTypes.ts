/**
 * Canonical Runtime Diagnostics Types — Priority 2A
 *
 * Defines the normalized type model for runtime diagnostics across
 * inference and MCP subsystems. This is the single authoritative schema
 * for producing RuntimeDiagnosticsSnapshot objects that can be consumed
 * by IPC handlers, UI surfaces, and diagnostic tooling.
 *
 * Design rules:
 * - Prefer typed state over booleans.
 * - Every field that can be stale carries a timestamp.
 * - Inference and MCP share the same normalized status vocabulary.
 * - Snapshot is safe to serialize over IPC (no circular refs, no functions).
 */

// ─── Normalized runtime status vocabulary ─────────────────────────────────────

/**
 * Canonical runtime status values shared across inference and MCP subsystems.
 * Prefer these over ad hoc strings or booleans.
 */
export type RuntimeStatus =
    | 'unknown'       // Status has not yet been determined
    | 'disabled'      // Administratively disabled
    | 'starting'      // Startup/connection handshake in progress
    | 'ready'         // Fully operational and accepting requests
    | 'busy'          // Currently processing a request
    | 'degraded'      // Partially operational; may recover
    | 'unavailable'   // Temporarily unreachable; retry pending
    | 'failed'        // Exhausted retries; manual intervention required
    | 'recovering'    // Reconnect attempt in progress after failure
    | 'stopped';      // Gracefully shut down

// ——— Canonical system health + mode contract (Phase D) ————————————————

export type SystemHealthOverallStatus =
    | 'healthy'
    | 'degraded'
    | 'impaired'
    | 'recovery'
    | 'maintenance'
    | 'failed';

export type SystemOperatingMode =
    | 'NORMAL'
    | 'DEGRADED_INFERENCE'
    | 'DEGRADED_MEMORY'
    | 'DEGRADED_TOOLS'
    | 'DEGRADED_AUTONOMY'
    | 'SAFE_MODE'
    | 'READ_ONLY'
    | 'RECOVERY'
    | 'MAINTENANCE';

export type SystemDegradationFlag = Exclude<SystemOperatingMode, 'NORMAL'>;

export type SystemHealthSubsystemSeverity = 'info' | 'warning' | 'error' | 'critical';

export type SystemHealthAutoActionState =
    | 'none'
    | 'monitoring'
    | 'fallback_active'
    | 'repair_pending'
    | 'repair_active'
    | 'blocked';

export type SystemCapability =
    | 'chat_inference'
    | 'workflow_execute'
    | 'tool_execute_read'
    | 'tool_execute_write'
    | 'tool_execute_diagnostic'
    | 'memory_canonical_read'
    | 'memory_canonical_write'
    | 'memory_promotion'
    | 'autonomy_execute'
    | 'repair_execute'
    | 'repair_promotion'
    | 'self_modify';

export interface SystemModeContract {
    mode: SystemOperatingMode;
    entry_conditions: string[];
    exit_conditions: string[];
    allowed_capabilities: SystemCapability[];
    blocked_capabilities: SystemCapability[];
    fallback_behavior: string[];
    user_facing_behavior_changes: string[];
    telemetry_expectations: string[];
    operator_actions_allowed: string[];
    autonomy_allowed: boolean;
    writes_allowed: boolean;
    operator_approval_required_for: string[];
}

export interface SystemModeTransition {
    from_mode: SystemOperatingMode;
    to_mode: SystemOperatingMode;
    transitioned_at: string;
    reason_codes: string[];
}

export interface SystemHealthSubsystemSnapshot {
    name: string;
    status: SystemHealthOverallStatus;
    severity: SystemHealthSubsystemSeverity;
    last_checked_at: string;
    last_changed_at: string;
    reason_codes: string[];
    evidence: string[];
    operator_impact: string;
    auto_action_state: SystemHealthAutoActionState;
    recommended_actions: string[];
}

export interface SystemHealthSnapshot {
    timestamp: string;
    overall_status: SystemHealthOverallStatus;
    subsystem_entries: SystemHealthSubsystemSnapshot[];
    trust_score: number;
    degraded_capabilities: string[];
    blocked_capabilities: string[];
    active_fallbacks: string[];
    active_incidents: string[];
    pending_repairs: string[];
    current_mode: string;
    effective_mode: SystemOperatingMode;
    active_degradation_flags: SystemDegradationFlag[];
    mode_contract: SystemModeContract;
    recent_mode_transitions: SystemModeTransition[];
    operator_attention_required: boolean;
}

// ─── Transition record ────────────────────────────────────────────────────────

/**
 * A single recorded lifecycle state transition for a service or subsystem.
 */
export interface RuntimeTransitionRecord {
    /** ISO 8601 timestamp of the transition. */
    timestamp: string;
    /** Status before the transition. */
    fromStatus: RuntimeStatus;
    /** Status after the transition. */
    toStatus: RuntimeStatus;
    /** Human-readable reason for the transition. */
    reason?: string;
}

// ─── Failure summary ─────────────────────────────────────────────────────────

/**
 * Aggregated failure summary for a subsystem or service.
 */
export interface RuntimeFailureSummary {
    /** Total failure count in the current session/window. */
    count: number;
    /** ISO timestamp of the most recent failure. */
    lastFailureTime?: string;
    /** Human-readable reason for the most recent failure. */
    lastFailureReason?: string;
    /** IDs of services/providers that have failed. */
    failedEntityIds: string[];
}

// ─── Stream diagnostics status ────────────────────────────────────────────────

/**
 * Lifecycle status of an active or recently-completed inference stream.
 * Maps to the internal StreamExecutionStatus used in the canonical stream path.
 */
export type StreamDiagnosticsStatus =
    | 'idle'         // No stream in progress or recently completed
    | 'pending'      // Stream requested, not yet opened
    | 'opening'      // Transport connecting, awaiting first token
    | 'streaming'    // Tokens actively flowing
    | 'completed'    // Stream finished successfully
    | 'aborted'      // Stream cancelled (abort signal or user action)
    | 'timed_out'    // Stream open or completion timed out
    | 'failed';      // Stream failed with an error

// ─── Provider inventory summary ───────────────────────────────────────────────

/**
 * Compact summary of the inference provider inventory state.
 */
export interface ProviderInventorySummary {
    /** Total providers in the registry. */
    total: number;
    /** Providers currently in ready state. */
    ready: number;
    /** Providers currently unavailable (not_running or unreachable). */
    unavailable: number;
    /** Providers in degraded state (responding with errors). */
    degraded: number;
}

// ─── Inference diagnostics state ─────────────────────────────────────────────

/**
 * Normalized snapshot of the inference subsystem's live state.
 * Updated after each provider selection and stream execution.
 */
export interface InferenceDiagnosticsState {
    /** ID of the currently selected inference provider (if any). */
    selectedProviderId?: string;
    /** Display name of the currently selected provider. */
    selectedProviderName?: string;
    /** Type of the currently selected provider (ollama, llamacpp, etc.). */
    selectedProviderType?: string;
    /** Whether the selected provider is currently ready. */
    selectedProviderReady: boolean;
    /** ID of the provider actually used on the last execution. */
    lastUsedProviderId?: string;
    /** Providers attempted during the last execution (in order). */
    attemptedProviders: string[];
    /** Whether fallback was applied during the last execution. */
    fallbackApplied: boolean;
    /** Current stream status. */
    streamStatus: StreamDiagnosticsStatus;
    /** Status of the most recently completed stream (if any). */
    lastStreamStatus?: StreamDiagnosticsStatus;
    /** Reason for the last failure (if any). */
    lastFailureReason?: string;
    /** ISO timestamp of the last failure (if any). */
    lastFailureTime?: string;
    /** ISO timestamp of the last stream timeout (if any). */
    lastTimeoutTime?: string;
    /** Compact summary of the current provider inventory. */
    providerInventorySummary: ProviderInventorySummary;
    /** ISO timestamp of the last state update. */
    lastUpdated: string;
}

// ─── MCP service diagnostics ──────────────────────────────────────────────────

/**
 * Normalized diagnostics snapshot for a single MCP service.
 */
export interface McpServiceDiagnostics {
    /** Stable unique identifier for this service. */
    serviceId: string;
    /** Human-readable display name. */
    displayName: string;
    /** Transport kind (stdio process or websocket). */
    kind: 'stdio' | 'websocket';
    /** Whether this service is configured and enabled. */
    enabled: boolean;
    /** Current normalized lifecycle status. */
    status: RuntimeStatus;
    /** Whether the service is currently in a degraded (partial) state. */
    degraded: boolean;
    /** Whether the service is currently accepting requests. */
    ready: boolean;
    /** ISO timestamp of the last health check (if any). */
    lastHealthCheck?: string;
    /** ISO timestamp of the last lifecycle state transition. */
    lastTransitionTime?: string;
    /** Reason for the last failure or degradation (if any). */
    lastFailureReason?: string;
    /** Number of reconnect/restart attempts in the current session. */
    restartCount: number;
    /** Additional service-specific metadata. */
    metadata?: Record<string, unknown>;
}

// ─── MCP inventory diagnostics ────────────────────────────────────────────────

/**
 * Aggregated diagnostics for the full MCP service inventory.
 */
export interface McpInventoryDiagnostics {
    /** Diagnostics for all configured MCP services. */
    services: McpServiceDiagnostics[];
    /** Total number of configured services. */
    totalConfigured: number;
    /** Number of services currently in ready state. */
    totalReady: number;
    /** Number of services currently degraded. */
    totalDegraded: number;
    /** Number of services unavailable or failed. */
    totalUnavailable: number;
    /** True if any service marked as critical is unavailable. */
    criticalUnavailable: boolean;
    /** ISO timestamp of the last inventory update. */
    lastUpdated: string;
}

// ─── Operator action record ───────────────────────────────────────────────────

/**
 * Records a single operator-initiated runtime control action.
 * Stored in the snapshot for UI display and reflection awareness.
 */
export interface OperatorActionRecord {
    /** ISO timestamp of the action. */
    timestamp: string;
    /** Type of action performed. */
    action:
        | 'provider_restart'
        | 'provider_disable'
        | 'provider_enable'
        | 'provider_force_select'
        | 'provider_probe'
        | 'mcp_restart'
        | 'mcp_disable'
        | 'mcp_enable'
        | 'mcp_probe';
    /** ID of the entity the action was applied to. */
    entityId: string;
    /** Entity type for display. */
    entityType: 'provider' | 'mcp_service';
    /** State before the action. */
    priorState?: string;
    /** State after the action. */
    newState?: string;
    /** Human-readable reason or trigger. */
    reason?: string;
    /** Optional correlation ID for multi-step operations. */
    correlationId?: string;
}

// ─── Provider health score ─────────────────────────────────────────────────────

/**
 * Health score and recovery metadata for a single provider.
 * Tracked by ProviderHealthScorer for auto-demotion and recovery logic.
 */
export interface ProviderHealthScore {
    /** Provider ID. */
    providerId: string;
    /** Consecutive failure count. */
    failureStreak: number;
    /** Total timeout count in the current session. */
    timeoutCount: number;
    /** Total fallback count in the current session. */
    fallbackCount: number;
    /** ISO timestamp of the last successful inference. */
    lastSuccess?: string;
    /** ISO timestamp of the last failure. */
    lastFailure?: string;
    /** Whether the provider has been administratively suppressed from auto-selection. */
    suppressed: boolean;
    /** ISO timestamp when suppression expires (if time-bounded). */
    suppressedUntil?: string;
    /** Current effective selection priority (may differ from base priority during demotion). */
    effectivePriority: number;
}

// ─── Unified runtime diagnostics snapshot ────────────────────────────────────

/**
 * The top-level normalized runtime diagnostics snapshot.
 *
 * This is the authoritative read model produced by RuntimeDiagnosticsAggregator
 * and consumed by IPC handlers and any diagnostic surface.
 *
 * It must never contain circular references, functions, or non-serializable values.
 */
export interface RuntimeDiagnosticsSnapshot {
    /** ISO 8601 timestamp when this snapshot was assembled. */
    timestamp: string;
    /** Session ID (if known). */
    sessionId?: string;
    /** Normalized inference subsystem state. */
    inference: InferenceDiagnosticsState;
    /** Normalized MCP inventory state. */
    mcp: McpInventoryDiagnostics;
    /** Names of subsystems currently in degraded or failed state. */
    degradedSubsystems: string[];
    /** Recent failure summary across all subsystems. */
    recentFailures: RuntimeFailureSummary;
    /** Last-updated timestamp per subsystem (keyed by subsystem name). */
    lastUpdatedPerSubsystem: Record<string, string>;
    // ─── Phase 2B extensions ───────────────────────────────────────────────────
    /** Recent operator-triggered runtime control actions. */
    operatorActions: OperatorActionRecord[];
    /** Health scores and suppression state per provider. */
    providerHealthScores: ProviderHealthScore[];
    /** IDs of providers currently suppressed from auto-selection. */
    suppressedProviders: string[];
    /** Recent provider auto-recovery events (ISO timestamps + providerId). */
    recentProviderRecoveries: Array<{ providerId: string; timestamp: string; reason: string }>;
    /** Recent MCP service restart events (ISO timestamps + serviceId). */
    recentMcpRestarts: Array<{ serviceId: string; timestamp: string; reason: string }>;
    /** Canonical operator-facing system health snapshot (Phase D). */
    systemHealth: SystemHealthSnapshot;
    /** Normalized cognitive diagnostics for the most recent cognitive turn. */
    cognitive?: CognitiveDiagnosticsSnapshot;
}

// ─── Cognitive diagnostics snapshot ──────────────────────────────────────────

import type { MemoryContributionCategory, EmotionalModulationStrength } from './cognitiveTurnTypes';

/**
 * Normalized cognitive diagnostics read model for the most recent cognitive turn.
 * Safe to expose via IPC and UI surfaces.
 * Does not contain raw memory contents or full prompts.
 */
export interface CognitiveDiagnosticsSnapshot {
    /** ISO timestamp of this snapshot. */
    timestamp: string;
    /** Active cognitive mode. */
    activeMode: 'assistant' | 'rp' | 'hybrid';
    /** Summary of memory contributions in the last cognitive turn. */
    memoryContributionSummary: {
        totalApplied: number;
        byCategory: Partial<Record<MemoryContributionCategory, number>>;
        retrievalSuppressed: boolean;
    };
    /** Summary of documentation contributions in the last cognitive turn. */
    docContributionSummary: {
        applied: boolean;
        sourceCount: number;
    };
    /** Emotional modulation status in the last cognitive turn. */
    emotionalModulationStatus: {
        applied: boolean;
        strength: EmotionalModulationStrength;
        astroUnavailable: boolean;
    };
    /** Reflection note status in the last cognitive turn. */
    reflectionNoteStatus: {
        activeNoteCount: number;
        suppressedNoteCount: number;
        applied: boolean;
    };
    /** ISO timestamp of the last cognitive policy application. */
    lastPolicyAppliedAt?: string;

    // ─── Phase 3C extensions ──────────────────────────────────────────────────

    /** Active prompt profile class (tiny/small/medium/large). */
    promptProfile?: string;
    /** Compaction summary from the last cognitive turn. */
    compactionSummary?: {
        profileClass: string;
        compactionPolicy: string;
        memoriesKept: number;
        memoriesDropped: number;
        docsIncluded: boolean;
        reflectionNotesKept: number;
        reflectionNotesDropped: number;
        sectionsDropped: string[];
    };
    /** Memory contribution counts by category for the last cognitive turn. */
    memoryContributionCounts?: {
        candidatesFound: number;
        candidatesUsed: number;
        candidatesDropped: number;
        byCategoryUsed: Partial<Record<MemoryContributionCategory, number>>;
    };
    /** Documentation contribution counts for the last cognitive turn. */
    docContributionCounts?: {
        retrieved: number;
        used: number;
        compacted: number;
        suppressed: number;
    };
    /** MCP contribution counts for the last cognitive turn. */
    mcpContributionCounts?: {
        servicesRequested: number;
        servicesUsed: number;
        servicesFailed: number;
        servicesSuppressed: number;
    };
    /** Reflection contribution counts for the last cognitive turn. */
    reflectionContributionCounts?: {
        notesAvailable: number;
        notesApplied: number;
        notesSuppressed: number;
    };
    /** Emotional bias summary for the last cognitive turn. */
    emotionalBiasSummary?: {
        strength: EmotionalModulationStrength;
        dimensions: string[];
        modulationApplied: boolean;
    };
    /** Performance measurements for the last cognitive turn (ms). */
    performanceSummary?: {
        preinferenceDurationMs?: number;
        cognitiveAssemblyDurationMs?: number;
        compactionDurationMs?: number;
    };
}




