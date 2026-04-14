import type {
    OperatorActionAvailability,
    OperatorActionStateSnapshot,
    RuntimeDiagnosticsSnapshot,
} from '../../../shared/runtimeDiagnosticsTypes';

export interface DashboardActionView {
    id: string;
    label: string;
    allowed: boolean;
    reason: string;
    category: 'runtime_control' | 'recovery_control' | 'governance_control' | 'visibility_control';
    recommended: boolean;
    requiresApproval: boolean;
}

const FALLBACK_LABELS: Record<string, string> = {
    pause_autonomy: 'Pause Autonomy',
    resume_autonomy: 'Resume Autonomy',
    enter_safe_mode: 'Enter Safe Mode',
    exit_safe_mode: 'Exit Safe Mode',
    enter_maintenance_mode: 'Enter Maintenance Mode',
    clear_maintenance_mode: 'Clear Maintenance Mode',
    retry_subsystem_health_check: 'Retry Health Checks',
    retry_inference_probe: 'Retry Inference Probe',
    restart_inference_adapter: 'Restart Inference Adapter',
    rerun_db_health_validation: 'Re-run DB Validation',
    revalidate_memory_authority: 'Revalidate Memory Authority',
    rerun_derived_rebuild: 'Re-run Derived Rebuild',
    flush_or_restart_stalled_queues: 'Flush Stalled Queues',
    retry_tool_connector_initialization: 'Retry Tool Connector Init',
    approve_repair_proposal: 'Approve Repair Proposal',
    reject_repair_proposal: 'Reject Repair Proposal',
    defer_proposal: 'Defer Proposal',
    lock_self_improvement: 'Lock Self-Improvement',
    unlock_self_improvement: 'Unlock Self-Improvement',
    require_human_approval_high_risk: 'Require High-Risk Approval',
    acknowledge_incident: 'Acknowledge Incident',
    mute_duplicate_alerts: 'Mute Duplicate Alerts',
    pin_active_issue: 'Pin Active Issue',
    open_evidence_log_trail: 'Open Evidence Trail',
    export_health_snapshot: 'Export Health Snapshot',
};

function toActionView(action: OperatorActionAvailability): DashboardActionView {
    return {
        id: action.action,
        label: action.label || FALLBACK_LABELS[action.action] || action.action,
        allowed: action.allowed,
        reason: action.reason,
        category: action.category,
        recommended: action.recommended,
        requiresApproval: action.requires_explicit_approval,
    };
}

export function buildDashboardActionViews(
    _snapshot: RuntimeDiagnosticsSnapshot,
    operatorState: OperatorActionStateSnapshot | null,
): {
    contextActions: DashboardActionView[];
    groupedActions: Record<DashboardActionView['category'], DashboardActionView[]>;
    controlsUnavailable: boolean;
    controlsUnavailableReason: string | null;
} {
    const availableActions = (operatorState?.available_actions ?? []).map(toActionView);
    const source = availableActions;
    const contextActions = source.filter((a) => a.recommended).slice(0, 8);
    const groupedActions: Record<DashboardActionView['category'], DashboardActionView[]> = {
        runtime_control: source.filter((a) => a.category === 'runtime_control'),
        recovery_control: source.filter((a) => a.category === 'recovery_control'),
        governance_control: source.filter((a) => a.category === 'governance_control'),
        visibility_control: source.filter((a) => a.category === 'visibility_control'),
    };
    const controlsUnavailable = availableActions.length === 0;

    return {
        contextActions,
        groupedActions,
        controlsUnavailable,
        controlsUnavailableReason: controlsUnavailable
            ? 'operator_action_availability_unavailable'
            : null,
    };
}
