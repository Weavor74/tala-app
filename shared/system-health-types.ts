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

export type SystemHealthSubsystemSeverity = 'info' | 'warning' | 'error' | 'critical';

export type SystemHealthAutoActionState =
    | 'none'
    | 'monitoring'
    | 'fallback_active'
    | 'repair_pending'
    | 'repair_active'
    | 'blocked';

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
    operator_attention_required: boolean;
}
