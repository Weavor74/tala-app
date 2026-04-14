/**
 * Canonical system health contract for operator-visible runtime status.
 *
 * All status surfaces (diagnostics UI, log viewer health panel, telemetry
 * adapters, and incident summaries) should resolve to this schema.
 */

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

export type SystemHealthSubsystemSeverity = 'info' | 'warning' | 'error' | 'critical';

export type SystemHealthAutoActionState =
    | 'none'
    | 'monitoring'
    | 'fallback_active'
    | 'repair_pending'
    | 'repair_active'
    | 'blocked';

export type SystemCapabilityAvailabilityStatus =
    | 'available'
    | 'degraded'
    | 'blocked'
    | 'approval_required';

export interface SystemCapabilityAvailability {
    capability: string;
    status: SystemCapabilityAvailabilityStatus;
    reason: string;
    approval_required: boolean;
    impacted_by: string[];
}

export type SystemIncidentSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface SystemHealthIncidentEntry {
    incident_id: string;
    title: string;
    severity: SystemIncidentSeverity;
    start_time: string;
    dedup_family: string;
    current_state: string;
    evidence_links: string[];
    automated_actions_attempted: string[];
    recommended_operator_actions: string[];
}

export interface SystemTrustExplanation {
    telemetry_freshness: {
        inference_age_ms: number;
        mcp_age_ms: number;
        expected_max_age_ms: number;
    };
    last_successful_subsystem_check: string | null;
    stale_components: string[];
    missing_evidence: string[];
    suppressed_assumptions: string[];
    confidence_penalties: Array<{ reason: string; penalty: number }>;
}

/**
 * Canonical trust-score input factors used by deterministic health reduction.
 * Keeping this explicit prevents "vibe-based" trust scoring.
 */
export interface SystemTrustScoreInputs {
    inference_age_ms: number;
    mcp_age_ms: number;
    expected_max_age_ms: number;
    db_evidence_observed: boolean;
    telemetry_stream_observed: boolean;
}

/**
 * Normalized subsystem signal shape accepted by central health reducers.
 * Existing runtime services can adapt their native diagnostics into this shape.
 */
export interface SystemHealthSubsystemSignal {
    name: string;
    status: SystemHealthOverallStatus;
    severity: SystemHealthSubsystemSeverity;
    checked_at: string;
    reason_codes: string[];
    evidence: string[];
    operator_impact: string;
    auto_action_state: SystemHealthAutoActionState;
    recommended_actions: string[];
    active_fallbacks?: string[];
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
    capability_matrix: SystemCapabilityAvailability[];
    active_incident_entries: SystemHealthIncidentEntry[];
    trust_explanation: SystemTrustExplanation;
    trust_score_inputs: SystemTrustScoreInputs;
    operator_attention_required: boolean;
}
