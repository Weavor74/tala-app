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

import type {
    SystemHealthOverallStatus,
    SystemOperatingMode,
    SystemDegradationFlag,
    SystemHealthSubsystemSeverity,
    SystemHealthAutoActionState,
    SystemCapabilityAvailabilityStatus,
    SystemCapabilityAvailability,
    SystemIncidentSeverity,
    SystemHealthIncidentEntry,
    SystemTrustExplanation,
    SystemTrustScoreInputs,
    SystemCapability,
    SystemModeContract,
    SystemModeTransition,
    SystemHealthSubsystemSnapshot,
    SystemHealthSnapshot,
} from './system-health-types';
import type { SeamStabilityReport } from './governance/SeamStability';
import type { McpAuthorityReasonCode, McpServerClassification } from './mcpAuthorityTypes';
import type { AuthorityLaneDiagnosticsRecord } from './planning/executionAuthorityTypes';
import type { FailureClass, RecoveryOutcomeStatus } from './runtime/failureRecoveryTypes';
import type {
    PlanningMemoryReasonCode,
    StrategyFamily,
    VerificationDepth,
} from './planning/PlanningMemoryTypes';
import type { KernelTurnDiagnosticsView } from './turnArbitrationTypes';
import type {
    MemoryAuthorityDecision,
    MemoryAuthorityDiagnosticsView,
    MemoryAuthorityReasonCode,
    MemoryWriteCategory,
} from './memoryAuthorityTypes';

// ——— Canonical system health + mode contract (Phase D) ————————————————
// NOTE: Re-exported from shared/system-health-types.ts to keep one canonical contract source.
export type {
    SystemHealthOverallStatus,
    SystemOperatingMode,
    SystemDegradationFlag,
    SystemHealthSubsystemSeverity,
    SystemHealthAutoActionState,
    SystemCapabilityAvailabilityStatus,
    SystemCapabilityAvailability,
    SystemIncidentSeverity,
    SystemHealthIncidentEntry,
    SystemTrustExplanation,
    SystemTrustScoreInputs,
    SystemCapability,
    SystemModeContract,
    SystemModeTransition,
    SystemHealthSubsystemSnapshot,
    SystemHealthSnapshot,
};

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
    kind: 'stdio' | 'websocket' | 'http';
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
    /** Authority-state projection: configured does not imply approved/active. */
    classification?: McpServerClassification;
    /** Stable machine-usable MCP authority reason codes. */
    reasonCodes?: McpAuthorityReasonCode[];
    /** Activation state emitted by the MCP authority seam. */
    activationState?: 'registered' | 'rejected' | 'pending_activation' | 'active' | 'degraded' | 'blocked_by_policy';
    /** Canonical provider/template type metadata. */
    providerKind?: 'external_mcp_server';
    templateKind?: 'stdio' | 'websocket' | 'http';
    /** Approved capability counters emitted by authority normalization. */
    approvedCapabilityCounts?: {
        tools: number;
        resources: number;
        prompts: number;
    };
    /** Quarantined malformed capability counters emitted by authority validation. */
    quarantinedCapabilityCounts?: {
        tools: number;
        resources: number;
        prompts: number;
    };
    /** Runtime transport streaming support status for this provider. */
    streamingSupportStatus?: 'not_applicable' | 'request_response' | 'sse_limited' | 'sse_enabled' | 'unknown';
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

/**
 * Canonical operator action identifiers used by the unified dashboard action contract.
 */
export type OperatorActionId =
    | 'pause_autonomy'
    | 'resume_autonomy'
    | 'enter_safe_mode'
    | 'exit_safe_mode'
    | 'enter_maintenance_mode'
    | 'clear_maintenance_mode'
    | 'retry_subsystem_health_check'
    | 'retry_inference_probe'
    | 'restart_inference_adapter'
    | 'rerun_db_health_validation'
    | 'revalidate_memory_authority'
    | 'rerun_derived_rebuild'
    | 'flush_or_restart_stalled_queues'
    | 'retry_tool_connector_initialization'
    | 'approve_recovery_retry'
    | 'approve_recovery_replan'
    | 'approve_recovery_degraded_continue'
    | 'force_recovery_stop'
    | 'deny_recovery_action'
    | 'approve_repair_proposal'
    | 'reject_repair_proposal'
    | 'defer_proposal'
    | 'lock_self_improvement'
    | 'unlock_self_improvement'
    | 'require_human_approval_high_risk'
    | 'acknowledge_incident'
    | 'mute_duplicate_alerts'
    | 'pin_active_issue'
    | 'open_evidence_log_trail'
    | 'export_health_snapshot';

export type OperatorActionSource = 'operator' | 'auto_repair';

export interface OperatorActionRequest {
    action: OperatorActionId;
    requested_by: string;
    source?: OperatorActionSource;
    params?: Record<string, unknown>;
}

export interface OperatorActionResultContract {
    /** Stable action execution instance ID (UUID). */
    action_id: string;
    /** Canonical action identifier requested/executed. */
    action: OperatorActionId;
    requested_by: string;
    executed_at: string;
    allowed: boolean;
    reason: string;
    affected_subsystems: string[];
    resulting_mode_change: {
        from_mode: string;
        to_mode: string;
    } | null;
    resulting_health_delta: {
        overall_before: SystemHealthOverallStatus;
        overall_after: SystemHealthOverallStatus;
        trust_score_before: number;
        trust_score_after: number;
        trust_score_delta: number;
        new_incidents: string[];
        resolved_incidents: string[];
    };
    rollback_availability: 'none' | 'manual' | 'automatic';
    source: OperatorActionSource;
    details?: Record<string, unknown>;
}

export type OperatorActionCategory =
    | 'runtime_control'
    | 'recovery_control'
    | 'governance_control'
    | 'visibility_control';

export type OperatorActionRiskLevel = 'low' | 'medium' | 'high';

/**
 * Canonical operator action availability contract for dashboard controls.
 * Produced by backend policy/mode evaluation to avoid renderer-local heuristics.
 */
export interface OperatorActionAvailability {
    action: OperatorActionId;
    label: string;
    category: OperatorActionCategory;
    risk_level: OperatorActionRiskLevel;
    recommended: boolean;
    allowed: boolean;
    reason: string;
    requires_explicit_approval: boolean;
    affected_subsystems: string[];
}

export interface OperatorActionStateSnapshot {
    actions: OperatorActionResultContract[];
    auto_actions: OperatorActionResultContract[];
    visibility: {
        acknowledged_incidents: string[];
        muted_duplicate_alert_keys: string[];
        pinned_issue: string | null;
        self_improvement_locked: boolean;
        high_risk_human_approval_required: boolean;
    };
    available_actions: OperatorActionAvailability[];
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

export type StorageAuthorityClass = 'canonical' | 'derived';

export type StorageAssignmentType = 'explicit' | 'bootstrap' | 'inferred' | 'unassigned';

export type StorageProviderOrigin = 'explicit_registry' | 'bootstrapped_legacy' | 'detected';

export type StorageValidationStatus = 'not_validated' | 'passed' | 'failed';

export interface StorageAuthoritySummaryDiagnostics {
    canonicalRuntimeAuthorityProviderId: string | null;
    derivedProviderIds: string[];
    registryHealth: 'healthy' | 'degraded' | 'conflict';
    bootstrapState: {
        hasBootstrapImports: boolean;
        bootstrappedProviderCount: number;
        detectedProviderCount: number;
        explicitRegistryProviderCount: number;
    };
    authorityState: {
        degraded: boolean;
        conflict: boolean;
        reasons: string[];
    };
}

export interface StorageProviderDiagnostics {
    providerId: string;
    providerType: string;
    authorityClass: StorageAuthorityClass;
    origin: StorageProviderOrigin;
    status: {
        reachable: 'reachable' | 'degraded' | 'offline' | 'unknown';
        auth: string;
        capable: boolean;
    };
    capabilities: string[];
    assignedRoles: string[];
    validation: {
        status: StorageValidationStatus;
        warnings: string[];
        errors: string[];
        dimensions?: Record<string, {
            status: StorageValidationStatus;
            reasonCode: string;
            remediationHint?: string;
        }>;
        classification?: {
            validButNotEligible: boolean;
            reachableButUnauthorized: boolean;
            configuredButPolicyBlocked: boolean;
            canonicalConflictState: boolean;
        };
    };
}

export interface StorageRoleDiagnostics {
    role: string;
    assignedProviderId: string | null;
    assignmentType: StorageAssignmentType;
    reasonCode?: string;
    eligibilityReasoning: string[];
    blockedAlternativeProviderIds: string[];
}

export interface StorageAssignmentExplanationDiagnostics {
    role: string;
    providerId: string | null;
    outcome: 'succeeded' | 'failed';
    reasonCode: string;
    reasonSummary: string;
    nextSteps: string[];
    timestamp: string;
}

export interface StorageDiagnosticsSnapshot {
    authoritySummary: StorageAuthoritySummaryDiagnostics;
    providers: StorageProviderDiagnostics[];
    roles: StorageRoleDiagnostics[];
    assignmentDecisions?: Array<{
        role: string;
        providerId: string | null;
        source: 'explicit_registry' | 'bootstrap' | 'policy' | 'recovery';
        outcome: 'applied' | 'preserved' | 'blocked' | 'skipped' | 'suggestion';
        reasonCode: string;
        timestamp: string;
    }>;
    lastAssignmentExplanation?: StorageAssignmentExplanationDiagnostics;
}

// ─── Handoff execution diagnostics ───────────────────────────────────────────

/**
 * Normalized diagnostics record for a single workflow or agent handoff execution.
 *
 * Every field maps 1-to-1 to authoritative telemetry emitted by
 * WorkflowHandoffCoordinator or AgentHandoffCoordinator.
 * No field is inferred or fabricated by the renderer.
 */
export interface HandoffExecutionRecord {
    /** Discriminates between workflow and agent handoff types. */
    handoffType: 'workflow' | 'agent';
    /** Execution boundary ID propagated from the plan's executionBoundaryId. */
    executionBoundaryId: string;
    /** The primary target: workflowId (workflow) or agentId (agent). */
    targetId: string;
    /** Execution readiness after preflight. */
    readiness: 'preflight_ok' | 'preflight_failed' | 'dispatching' | 'completed' | 'failed';
    /** Policy evaluation status for this handoff. */
    policyStatus: 'clear' | 'blocked' | 'escalation_required';
    /** Terminal outcome: success, failure, or still pending. */
    outcome: 'success' | 'failure' | 'pending';
    /**
     * Stable machine-readable failure reason code.
     * Maps to WorkflowHandoffFailureCode or AgentHandoffFailureCode.
     * Present only on failure.
     */
    reasonCode?: string;
    /** The declared failure policy for the invocation. */
    failurePolicy?: 'stop' | 'retry' | 'skip' | 'escalate';
    /** True when the coordinator advises replanning as the recovery path. */
    replanAdvised?: boolean;
    /** Suggested replan trigger code when replanAdvised is true. */
    replanTrigger?: 'capability_loss' | 'policy_block' | 'dependency_failure';
    /** ISO-8601 timestamp when the handoff was dispatched. */
    startedAt: string;
    /** ISO-8601 timestamp when the handoff reached a terminal state. */
    completedAt?: string;
    /** Wall-clock duration in milliseconds (only populated on completion). */
    durationMs?: number;
    /** The plan this handoff belongs to. */
    planId: string;
    /** The goal this handoff traces back to. */
    goalId: string;
    /** Human-readable error message on failure. */
    error?: string;
    /** Normalized failure class when a structured failure was emitted. */
    failureClass?: FailureClass;
    /** Recovery outcome status emitted by the execution boundary. */
    recoveryOutcome?: RecoveryOutcomeStatus;
    /** Number of local recovery attempts made at the execution boundary. */
    recoveryAttempts?: number;
    /** True when anti-thrash suppression prevented additional retries/reroutes. */
    antiThrashSuppressed?: boolean;
    /** True when execution completed in a degraded mode rather than full success. */
    degradedCompletion?: boolean;
}

/**
 * Aggregated handoff execution diagnostics snapshot.
 * Populated by RuntimeDiagnosticsAggregator from coordinator telemetry.
 */
export interface HandoffDiagnosticsSnapshot {
    /** Most recent workflow handoff execution record, if any. */
    lastWorkflowRecord?: HandoffExecutionRecord;
    /** Most recent agent handoff execution record, if any. */
    lastAgentRecord?: HandoffExecutionRecord;
    /** Total workflow handoff dispatches in the current session. */
    workflowDispatchCount: number;
    /** Total agent handoff dispatches in the current session. */
    agentDispatchCount: number;
    /** Total workflow handoff failures in the current session. */
    workflowFailureCount: number;
    /** Total agent handoff failures in the current session. */
    agentFailureCount: number;
    /** ISO-8601 timestamp of the last update. */
    lastUpdated: string;
}

/**
 * Planning-memory diagnostics snapshot derived from planning telemetry.
 * Tracks strategy-selection evidence for the most recent planning cycle.
 */
export interface PlanningMemoryDiagnosticsSnapshot {
    consulted: boolean;
    similarEpisodeCount: number;
    selectedStrategyFamily?: StrategyFamily;
    selectedVerificationDepth?: VerificationDepth;
    selectedLane?: 'trivial' | 'planning_loop' | 'workflow' | 'agent';
    confidence?: number;
    topReasonCodes: PlanningMemoryReasonCode[];
    dominantFailurePattern?: string;
    dominantRecoveryPattern?: string;
    lastUpdated: string;
}

export interface RuntimeMemoryAuthorityDiagnosticsView extends MemoryAuthorityDiagnosticsView {
    lastDecision?: MemoryAuthorityDecision;
    lastDeniedCategory?: MemoryWriteCategory;
    lastDeniedReasonCodes: MemoryAuthorityReasonCode[];
}

export interface RecoveryDiagnosticsSnapshot {
    activeDecision?: {
        triggerId: string;
        decisionId: string;
        decisionType: 'retry' | 'replan' | 'escalate' | 'degrade_and_continue' | 'stop';
        reasonCode: string;
        executionId: string;
        executionBoundaryId?: string;
        scope?: 'step' | 'handoff' | 'execution_boundary' | 'execution' | 'plan';
        handoffType?: 'tool' | 'workflow' | 'agent';
        origin?: 'automatic' | 'operator_override' | 'operator_approved';
        approvalState?: 'not_required' | 'pending_operator' | 'approved' | 'denied';
        overrideAllowed?: boolean;
        overrideApplied?: boolean;
        lastOperatorAction?: 'approve_retry' | 'approve_replan' | 'approve_degraded_continue' | 'force_stop' | 'deny';
        operatorReasonCode?: string;
        degradedMode?: {
            disabledCapabilities: string[];
            continueMode: 'reduced_capability' | 'read_only' | 'local_only';
        };
    };
    budget?: {
        retryCount: number;
        maxRetries: number;
        replanCount: number;
        maxReplans: number;
        remainingRetries: number;
        remainingReplans: number;
        scope: 'step' | 'handoff' | 'execution_boundary' | 'execution' | 'plan';
        loopDetected: boolean;
    };
    exhausted?: {
        retryExhausted: boolean;
        replanExhausted: boolean;
        anyExhausted: boolean;
    };
    counters: {
        retriesAttempted: number;
        replansRequested: number;
        escalationsRaised: number;
        degradedContinuesApplied: number;
        stopsIssued: number;
        loopsDetected: number;
        overridesApplied: number;
        approvalsRequired: number;
        approvalsDenied: number;
    };
    recentHistory: Array<{
        historyId: string;
        timestamp: string;
        executionId: string;
        executionBoundaryId?: string;
        triggerType: string;
        decisionType: 'retry' | 'replan' | 'escalate' | 'degrade_and_continue' | 'stop';
        reasonCode: string;
        scope?: 'step' | 'handoff' | 'execution_boundary' | 'execution' | 'plan';
        failureFamily?: string;
        origin: 'automatic' | 'operator_override' | 'operator_approved';
        operatorOverrideApplied: boolean;
        approvalState: 'not_required' | 'pending_operator' | 'approved' | 'denied';
        outcome: 'executed' | 'failed' | 'denied' | 'superseded';
        degradedMode?: {
            disabledCapabilities: string[];
            continueMode: 'reduced_capability' | 'read_only' | 'local_only';
        };
    }>;
    analytics: {
        totals: {
            retries: number;
            replans: number;
            escalations: number;
            degradedContinues: number;
            stops: number;
            overrides: number;
            loopDetections: number;
        };
        topReasonCodes: Array<{ reasonCode: string; count: number }>;
        byDecisionType: Array<{
            decisionType: 'retry' | 'replan' | 'escalate' | 'degrade_and_continue' | 'stop';
            count: number;
        }>;
        byFailureFamily: Array<{ failureFamily: string; count: number }>;
    };
    lastReasonCodes: string[];
    lastUpdated: string;
}

// ─── Execution authority lane diagnostics ─────────────────────────────────────

/**
 * Snapshot of the most recent authority-lane resolution for a runtime turn.
 *
 * Surfaced in RuntimeDiagnosticsSnapshot.executionAuthority so each task/turn
 * shows which authority lane was used and what the policy outcome was.
 *
 * Derived from the most recent `planning.authority_lane_resolved` event observed
 * by RuntimeDiagnosticsAggregator.
 */
export interface AuthorityLaneDiagnosticsSnapshot {
    /** The most recent authority-lane diagnostics record. */
    lastRecord: AuthorityLaneDiagnosticsRecord;
    /** ISO timestamp of the last update. */
    lastUpdated: string;
    /**
     * Running count of authority lane resolutions per lane name in the current
     * session (reset on TelemetryBus reset).
     */
    laneResolutionCounts: Partial<Record<string, number>>;
    /**
     * Running count of degraded-direct executions in the current session.
     * Incremented whenever `chat_continuity_degraded_direct` is resolved.
     */
    degradedDirectCount: number;
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
    /** Optional Storage Registry diagnostics model for settings and diagnostics panels. */
    storage?: StorageDiagnosticsSnapshot;
    /** Optional seam governance stability snapshot hook for future diagnostics/dashboard surfaces. */
    seamStability?: SeamStabilityReport;
    /** Normalized cognitive diagnostics for the most recent cognitive turn. */
    cognitive?: CognitiveDiagnosticsSnapshot;
    /**
     * Execution authority lane diagnostics.
     * Populated after the first `planning.authority_lane_resolved` event is observed.
     * Absent until at least one execution turn completes its authority classification.
     */
    executionAuthority?: AuthorityLaneDiagnosticsSnapshot;
    /**
     * Workflow and agent handoff execution diagnostics.
     * Populated after the first coordinator handoff event is observed.
     * Absent until at least one workflow or agent handoff has been dispatched.
     */
    handoffDiagnostics?: HandoffDiagnosticsSnapshot;
    /**
     * Planning-memory strategy diagnostics.
     * Populated after planning.memory_context_built/strategy_selected events.
     */
    planningMemory?: PlanningMemoryDiagnosticsSnapshot;
    /**
     * Kernel turn-arbitration diagnostics.
     * Populated after kernel.turn_arbitrated events.
     */
    kernelTurn?: KernelTurnDiagnosticsView;
    /**
     * Memory authority gate diagnostics.
     * Populated after memory.authority_check_* events.
     */
    memoryAuthority?: RuntimeMemoryAuthorityDiagnosticsView;
    /** Recovery decision and action diagnostics projected from recovery telemetry. */
    recovery?: RecoveryDiagnosticsSnapshot;
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





