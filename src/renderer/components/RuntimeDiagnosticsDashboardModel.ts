import type {
    OperatorActionAvailability,
    OperatorActionStateSnapshot,
    RuntimeDiagnosticsSnapshot,
    HandoffExecutionRecord,
    HandoffDiagnosticsSnapshot,
} from '../../../shared/runtimeDiagnosticsTypes';
import type {
    AuthorityLane,
    AuthorityLanePolicyOutcome,
    ExecutionAuthorityClassification,
    NonTrivialWorkReasonCode,
    DegradedExecutionReason,
    DegradedModeCode,
} from '../../../shared/planning/executionAuthorityTypes';

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
    approve_recovery_retry: 'Approve Recovery Retry',
    approve_recovery_replan: 'Approve Recovery Replan',
    approve_recovery_degraded_continue: 'Approve Degraded Continue',
    force_recovery_stop: 'Force Recovery Stop',
    deny_recovery_action: 'Deny Recovery Action',
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

// ─── Execution Authority UI Model ─────────────────────────────────────────────

/**
 * All five canonical authority lanes ordered for display.
 * Ensures every doctrined lane is always visible in the UI even when its count is zero.
 */
export const ALL_AUTHORITY_LANES: AuthorityLane[] = [
    'planning_loop',
    'trivial_direct',
    'chat_continuity_degraded_direct',
    'autonomy_safechangeplanner_pipeline',
    'operator_policy_gate',
];

/** Human-readable label for each authority lane. */
export const AUTHORITY_LANE_LABELS: Record<AuthorityLane, string> = {
    planning_loop: 'Planning Loop',
    trivial_direct: 'Trivial Direct',
    chat_continuity_degraded_direct: 'Degraded Direct (chat continuity)',
    autonomy_safechangeplanner_pipeline: 'Autonomy SafeChangePlanner Pipeline',
    operator_policy_gate: 'Operator Policy Gate',
};

/**
 * View model for a degraded execution decision.
 * Only present when the authority lane is `chat_continuity_degraded_direct`.
 */
export interface DegradedDecisionView {
    reason: DegradedExecutionReason;
    directAllowed: boolean;
    degradedModeCode: DegradedModeCode;
    doctrine: string;
    detectedIn: string;
    detectedAt: string;
}

/**
 * Projected read model for the execution authority section of the operator UI.
 *
 * Derived exclusively from `RuntimeDiagnosticsSnapshot.executionAuthority`.
 * Null when no authority lane has been resolved yet in the current session.
 */
export interface AuthorityLaneDiagnosticsView {
    /** Currently active authority lane. */
    currentLane: AuthorityLane;
    /** Human-readable label for the current lane. */
    currentLaneLabel: string;
    /** Final execution authority classification from the routing decision. */
    routingClassification: ExecutionAuthorityClassification;
    /** Policy outcome for this execution boundary. */
    policyOutcome: AuthorityLanePolicyOutcome;
    /** Machine-readable reason codes explaining the routing decision. */
    reasonCodes: NonTrivialWorkReasonCode[];
    /** Loop run ID, present only on the `planning_loop` lane. */
    loopId: string | undefined;
    /** Execution boundary ID for this turn. */
    executionBoundaryId: string;
    /** ISO-8601 timestamp when the authority lane was resolved. */
    resolvedAt: string;
    /** One-line human-readable summary. */
    summary: string;
    /** Degraded execution decision; present only on `chat_continuity_degraded_direct`. */
    degradedDecision: DegradedDecisionView | undefined;
    /** Per-lane resolution counts for all five doctrined lanes. Always populated (zero if none). */
    laneResolutionCounts: Record<AuthorityLane, number>;
    /** Running count of `chat_continuity_degraded_direct` resolutions this session. */
    degradedDirectCount: number;
    /** ISO-8601 timestamp of the last authority lane update. */
    lastUpdated: string;
}

/**
 * Projects `RuntimeDiagnosticsSnapshot.executionAuthority` into a typed UI view model.
 *
 * Returns null if no authority lane has been resolved yet (executionAuthority is absent).
 * This function is pure and deterministic — safe to test without a DOM or renderer.
 */
export function buildAuthorityLaneDiagnosticsView(
    snapshot: RuntimeDiagnosticsSnapshot,
): AuthorityLaneDiagnosticsView | null {
    const auth = snapshot.executionAuthority;
    if (!auth) return null;

    const r = auth.lastRecord;

    const laneResolutionCounts = Object.fromEntries(
        ALL_AUTHORITY_LANES.map((lane) => [lane, auth.laneResolutionCounts[lane] ?? 0]),
    ) as Record<AuthorityLane, number>;

    const degradedDecision: DegradedDecisionView | undefined = r.degradedExecutionDecision
        ? {
              reason: r.degradedExecutionDecision.reason,
              directAllowed: r.degradedExecutionDecision.directAllowed,
              degradedModeCode: r.degradedExecutionDecision.degradedModeCode,
              doctrine: r.degradedExecutionDecision.doctrine,
              detectedIn: r.degradedExecutionDecision.detectedIn,
              detectedAt: r.degradedExecutionDecision.detectedAt,
          }
        : undefined;

    return {
        currentLane: r.authorityLane,
        currentLaneLabel: AUTHORITY_LANE_LABELS[r.authorityLane] ?? r.authorityLane,
        routingClassification: r.routingClassification,
        policyOutcome: r.policyOutcome,
        reasonCodes: r.reasonCodes,
        loopId: r.loopId,
        executionBoundaryId: r.executionBoundaryId,
        resolvedAt: r.resolvedAt,
        summary: r.summary,
        degradedDecision,
        laneResolutionCounts,
        degradedDirectCount: auth.degradedDirectCount,
        lastUpdated: auth.lastUpdated,
    };
}

// ─── Handoff diagnostics UI model ─────────────────────────────────────────────

/**
 * Projected read model for a single handoff execution record in the operator UI.
 *
 * Derived exclusively from backend-authored HandoffExecutionRecord fields.
 * No field is inferred or fabricated by the renderer.
 */
export interface HandoffRecordView {
    handoffType: 'workflow' | 'agent';
    executionBoundaryId: string;
    targetId: string;
    readiness: HandoffExecutionRecord['readiness'];
    readinessLabel: string;
    policyStatus: HandoffExecutionRecord['policyStatus'];
    outcome: HandoffExecutionRecord['outcome'];
    reasonCode: string | undefined;
    replanAdvised: boolean;
    replanTrigger: string | undefined;
    startedAt: string;
    completedAt: string | undefined;
    durationMs: number | undefined;
    planId: string;
    goalId: string;
    error: string | undefined;
}

/**
 * Aggregated view model for the handoff diagnostics section of the operator UI.
 *
 * Null when no handoff has been dispatched in the current session.
 */
export interface HandoffDiagnosticsView {
    lastWorkflow: HandoffRecordView | null;
    lastAgent: HandoffRecordView | null;
    workflowDispatchCount: number;
    agentDispatchCount: number;
    workflowFailureCount: number;
    agentFailureCount: number;
    lastUpdated: string;
}

const READINESS_LABELS: Record<HandoffExecutionRecord['readiness'], string> = {
    dispatching: 'Dispatching',
    preflight_ok: 'Preflight OK',
    preflight_failed: 'Preflight Failed',
    completed: 'Completed',
    failed: 'Failed',
};

function toHandoffRecordView(r: HandoffExecutionRecord): HandoffRecordView {
    return {
        handoffType: r.handoffType,
        executionBoundaryId: r.executionBoundaryId,
        targetId: r.targetId,
        readiness: r.readiness,
        readinessLabel: READINESS_LABELS[r.readiness] ?? r.readiness,
        policyStatus: r.policyStatus,
        outcome: r.outcome,
        reasonCode: r.reasonCode,
        replanAdvised: r.replanAdvised ?? false,
        replanTrigger: r.replanTrigger,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        durationMs: r.durationMs,
        planId: r.planId,
        goalId: r.goalId,
        error: r.error,
    };
}

/**
 * Projects `RuntimeDiagnosticsSnapshot.handoffDiagnostics` into a typed UI view model.
 *
 * Returns null if no handoff has been dispatched yet (handoffDiagnostics is absent).
 * This function is pure and deterministic — all fields come from backend-authored state.
 * The renderer must not infer missing handoff outcome or reason information.
 */
export function buildHandoffDiagnosticsView(
    snapshot: RuntimeDiagnosticsSnapshot,
): HandoffDiagnosticsView | null {
    const hd = snapshot.handoffDiagnostics;
    if (!hd) return null;

    return {
        lastWorkflow: hd.lastWorkflowRecord ? toHandoffRecordView(hd.lastWorkflowRecord) : null,
        lastAgent: hd.lastAgentRecord ? toHandoffRecordView(hd.lastAgentRecord) : null,
        workflowDispatchCount: hd.workflowDispatchCount,
        agentDispatchCount: hd.agentDispatchCount,
        workflowFailureCount: hd.workflowFailureCount,
        agentFailureCount: hd.agentFailureCount,
        lastUpdated: hd.lastUpdated,
    };
}

// Re-export types used by the panel to keep imports co-located
export type { HandoffExecutionRecord, HandoffDiagnosticsSnapshot };

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
