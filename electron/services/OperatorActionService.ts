import { v4 as uuidv4 } from 'uuid';
import type { RuntimeDiagnosticsAggregator } from './RuntimeDiagnosticsAggregator';
import type { RuntimeControlService } from './RuntimeControlService';
import type { AutonomousRunOrchestrator } from './autonomy/AutonomousRunOrchestrator';
import type { ReflectionService } from './reflection/ReflectionService';
import type { LogViewerService } from './LogViewerService';
import { policyGate } from './policy/PolicyGate';
import { TelemetryBus } from './telemetry/TelemetryBus';
import { checkCanonicalDbHealth } from './db/initMemoryStore';
import { loadSettings } from './SettingsManager';
import { auditLogger } from './AuditLogger';
import type { McpServerConfig } from '../../shared/settings';
import type {
    OperatorActionId,
    OperatorActionSource,
    OperatorActionRequest,
    OperatorActionResultContract,
    SystemHealthSnapshot,
} from '../../shared/runtimeDiagnosticsTypes';

interface OperatorActionDeps {
    diagnosticsAggregator: RuntimeDiagnosticsAggregator;
    runtimeControl: RuntimeControlService;
    getSettingsPath: () => string;
    autonomyOrchestrator?: AutonomousRunOrchestrator;
    reflectionService?: ReflectionService;
    logViewerService?: LogViewerService;
}

type RollbackAvailability = OperatorActionResultContract['rollback_availability'];

const HIGH_RISK_ACTIONS = new Set<OperatorActionId>([
    'exit_safe_mode',
    'clear_maintenance_mode',
    'approve_repair_proposal',
    'unlock_self_improvement',
]);

export class OperatorActionService {
    private actionHistory: OperatorActionResultContract[] = [];
    private autoRepairHistory: OperatorActionResultContract[] = [];
    private selfImprovementLocked = false;
    private highRiskApprovalRequired = false;
    private acknowledgedIncidents = new Set<string>();
    private mutedAlertKeys = new Set<string>();
    private pinnedIssue: string | null = null;

    constructor(private readonly deps: OperatorActionDeps) {}

    public async executeAction(request: OperatorActionRequest): Promise<OperatorActionResultContract> {
        const action = request.action;
        const requestedBy = request.requested_by || 'operator';
        const actionId = uuidv4();
        const source: OperatorActionSource = request.source ?? 'operator';
        const executedAt = new Date().toISOString();
        const before = this.deps.diagnosticsAggregator.getSystemHealthSnapshot();
        const deny = (reason: string, affectedSubsystems: string[]) =>
            this._buildDeniedResult(
                action,
                requestedBy,
                executedAt,
                before,
                reason,
                affectedSubsystems,
                actionId,
                source,
            );
        const modeAllowed = this._checkModeAllowance(action, before);
        if (!modeAllowed.allowed) {
            return deny(modeAllowed.reason, modeAllowed.affectedSubsystems);
        }

        const decision = policyGate.checkSideEffect({
            actionKind: 'workflow_action',
            executionOrigin: 'operator_dashboard',
            executionMode: 'assistant',
            capability: `operator_action:${action}`,
            targetSubsystem: 'OperatorActionService',
            mutationIntent: action,
        });
        if (!decision.allowed) {
            return deny(`policy_denied:${decision.reason}`, ['policy_gate']);
        }

        if (this.selfImprovementLocked && this._isSelfImprovementAction(action)) {
            return deny('self_improvement_locked', ['reflection_service', 'autonomy_orchestrator']);
        }

        if (this.highRiskApprovalRequired && HIGH_RISK_ACTIONS.has(action)) {
            const explicitlyApproved = request.params?.operator_approved === true;
            if (!explicitlyApproved) {
                return deny('human_approval_required_for_high_risk_action', ['policy_gate']);
            }
        }

        let reason = 'action_executed';
        let rollback: RollbackAvailability = 'manual';
        let affectedSubsystems: string[] = [];
        let details: Record<string, unknown> | undefined;

        try {
            switch (action) {
                case 'pause_autonomy': {
                    this.deps.autonomyOrchestrator?.setGlobalEnabled(false);
                    affectedSubsystems = ['autonomy_orchestrator'];
                    rollback = 'manual';
                    break;
                }
                case 'resume_autonomy': {
                    this.deps.autonomyOrchestrator?.setGlobalEnabled(true);
                    affectedSubsystems = ['autonomy_orchestrator'];
                    rollback = 'manual';
                    break;
                }
                case 'enter_safe_mode': {
                    this.deps.diagnosticsAggregator.setOperatorModeOverride('SAFE_MODE', {
                        reason: 'operator_requested',
                        requestedBy,
                        timestamp: executedAt,
                    });
                    affectedSubsystems = ['runtime_mode_manager'];
                    rollback = 'manual';
                    break;
                }
                case 'exit_safe_mode': {
                    const override = this.deps.diagnosticsAggregator.getOperatorModeOverride();
                    if (!override || override.mode !== 'SAFE_MODE') {
                        return deny('safe_mode_override_not_active', ['runtime_mode_manager']);
                    }
                    this.deps.diagnosticsAggregator.setOperatorModeOverride(null, {
                        reason: 'operator_requested_clear',
                        requestedBy,
                        timestamp: executedAt,
                    });
                    affectedSubsystems = ['runtime_mode_manager'];
                    rollback = 'manual';
                    break;
                }
                case 'enter_maintenance_mode': {
                    this.deps.diagnosticsAggregator.setOperatorModeOverride('MAINTENANCE', {
                        reason: 'operator_requested',
                        requestedBy,
                        timestamp: executedAt,
                    });
                    affectedSubsystems = ['runtime_mode_manager'];
                    rollback = 'manual';
                    break;
                }
                case 'clear_maintenance_mode': {
                    const override = this.deps.diagnosticsAggregator.getOperatorModeOverride();
                    if (!override || override.mode !== 'MAINTENANCE') {
                        return deny('maintenance_override_not_active', ['runtime_mode_manager']);
                    }
                    this.deps.diagnosticsAggregator.setOperatorModeOverride(null, {
                        reason: 'operator_requested_clear',
                        requestedBy,
                        timestamp: executedAt,
                    });
                    affectedSubsystems = ['runtime_mode_manager'];
                    rollback = 'manual';
                    break;
                }
                case 'retry_subsystem_health_check': {
                    const target = String(request.params?.subsystem ?? 'all');
                    affectedSubsystems = await this._retryHealthFor(target);
                    rollback = 'none';
                    details = { target };
                    break;
                }
                case 'retry_inference_probe': {
                    const result = await this.deps.runtimeControl.probeProviders();
                    affectedSubsystems = ['inference_service'];
                    rollback = 'none';
                    details = { result };
                    break;
                }
                case 'restart_inference_adapter': {
                    const selectedProviderId = this.deps.diagnosticsAggregator.getSnapshot().inference.selectedProviderId;
                    if (selectedProviderId) {
                        const result = await this.deps.runtimeControl.restartProvider(selectedProviderId);
                        details = { providerId: selectedProviderId, result };
                    } else {
                        const result = await this.deps.runtimeControl.probeProviders();
                        details = { providerId: null, result };
                    }
                    affectedSubsystems = ['inference_service'];
                    rollback = 'manual';
                    break;
                }
                case 'rerun_db_health_validation': {
                    const health = await checkCanonicalDbHealth();
                    details = { health };
                    affectedSubsystems = ['db_health_service'];
                    rollback = 'none';
                    break;
                }
                case 'revalidate_memory_authority': {
                    const health = await checkCanonicalDbHealth();
                    details = { health };
                    affectedSubsystems = ['memory_authority_service', 'db_health_service'];
                    rollback = 'none';
                    break;
                }
                case 'rerun_derived_rebuild': {
                    details = await this._rerunDerivedRebuild();
                    affectedSubsystems = ['memory_authority_service', 'reflection_service'];
                    rollback = 'none';
                    break;
                }
                case 'flush_or_restart_stalled_queues': {
                    const summary = await this._flushStalledQueues();
                    details = summary;
                    affectedSubsystems = ['queue_backlog_pressure', 'reflection_service', 'autonomy_orchestrator'];
                    rollback = 'none';
                    break;
                }
                case 'retry_tool_connector_initialization': {
                    const summary = await this._retryToolConnectorInitialization();
                    details = summary;
                    affectedSubsystems = ['mcp_tool_availability', 'tool_execution_coordinator'];
                    rollback = 'manual';
                    break;
                }
                case 'approve_repair_proposal': {
                    const proposalId = String(request.params?.proposal_id ?? '');
                    if (!proposalId) {
                        return deny('missing_proposal_id', ['reflection_service']);
                    }
                    const patch = this.deps.reflectionService?.getActivePatches().get(proposalId);
                    if (!patch || !this.deps.reflectionService) {
                        return deny('proposal_not_found', ['reflection_service']);
                    }
                    const mockReport: any = { overallResult: 'pass' };
                    await this.deps.reflectionService.getPromoter().promotePatch(patch, mockReport, requestedBy);
                    patch.status = 'promoted';
                    affectedSubsystems = ['reflection_service'];
                    rollback = 'manual';
                    details = { proposalId };
                    break;
                }
                case 'reject_repair_proposal': {
                    const proposalId = String(request.params?.proposal_id ?? '');
                    if (!proposalId) {
                        return deny('missing_proposal_id', ['reflection_service']);
                    }
                    const patch = this.deps.reflectionService?.getActivePatches().get(proposalId);
                    if (!patch) {
                        return deny('proposal_not_found', ['reflection_service']);
                    }
                    patch.status = 'rejected';
                    affectedSubsystems = ['reflection_service'];
                    rollback = 'none';
                    details = { proposalId };
                    break;
                }
                case 'defer_proposal': {
                    const proposalId = String(request.params?.proposal_id ?? '');
                    if (!proposalId) {
                        return deny('missing_proposal_id', ['reflection_service']);
                    }
                    const patch = this.deps.reflectionService?.getActivePatches().get(proposalId);
                    if (!patch) {
                        return deny('proposal_not_found', ['reflection_service']);
                    }
                    patch.status = 'staged';
                    affectedSubsystems = ['reflection_service'];
                    rollback = 'manual';
                    details = { proposalId };
                    break;
                }
                case 'lock_self_improvement': {
                    this.selfImprovementLocked = true;
                    this.deps.autonomyOrchestrator?.setGlobalEnabled(false);
                    affectedSubsystems = ['autonomy_orchestrator', 'reflection_service'];
                    rollback = 'manual';
                    break;
                }
                case 'unlock_self_improvement': {
                    this.selfImprovementLocked = false;
                    affectedSubsystems = ['autonomy_orchestrator', 'reflection_service'];
                    rollback = 'manual';
                    break;
                }
                case 'require_human_approval_high_risk': {
                    const required = request.params?.required !== false;
                    this.highRiskApprovalRequired = required;
                    details = { required };
                    affectedSubsystems = ['policy_gate'];
                    rollback = 'manual';
                    break;
                }
                case 'acknowledge_incident': {
                    const incidentId = String(request.params?.incident_id ?? '');
                    if (!incidentId) {
                        return deny('missing_incident_id', ['diagnostics']);
                    }
                    this.acknowledgedIncidents.add(incidentId);
                    affectedSubsystems = ['diagnostics'];
                    rollback = 'none';
                    details = { incidentId };
                    break;
                }
                case 'mute_duplicate_alerts': {
                    const key = String(request.params?.alert_key ?? 'global_duplicates');
                    this.mutedAlertKeys.add(key);
                    affectedSubsystems = ['diagnostics'];
                    rollback = 'manual';
                    details = { alertKey: key };
                    break;
                }
                case 'pin_active_issue': {
                    const issueId = String(request.params?.issue_id ?? '');
                    if (!issueId) {
                        return deny('missing_issue_id', ['diagnostics']);
                    }
                    this.pinnedIssue = issueId;
                    affectedSubsystems = ['diagnostics'];
                    rollback = 'manual';
                    details = { issueId };
                    break;
                }
                case 'open_evidence_log_trail': {
                    const evidence = await this._openEvidenceTrail(request.params);
                    details = evidence;
                    affectedSubsystems = ['log_viewer'];
                    rollback = 'none';
                    break;
                }
                case 'export_health_snapshot': {
                    details = { snapshot: this.deps.diagnosticsAggregator.getSystemHealthSnapshot() };
                    affectedSubsystems = ['diagnostics'];
                    rollback = 'none';
                    break;
                }
                default: {
                    return deny('unknown_action', ['diagnostics']);
                }
            }
        } catch (err: any) {
            return deny(
                `action_execution_error:${err?.message ?? String(err)}`,
                affectedSubsystems.length ? affectedSubsystems : ['diagnostics'],
            );
        }

        const after = this.deps.diagnosticsAggregator.getSystemHealthSnapshot();
        const result = this._buildAllowedResult(
            action,
            requestedBy,
            executedAt,
            before,
            after,
            reason,
            affectedSubsystems,
            rollback,
            details,
            actionId,
            source,
        );
        this._recordActionResult(result);
        this._emitAuditRecord(result);

        TelemetryBus.getInstance().emit({
            executionId: actionId,
            subsystem: 'system',
            event: source === 'operator' ? 'execution.operator_action' : 'execution.auto_action',
            phase: 'operator_action',
            payload: {
                action,
                requestedBy,
                allowed: true,
                reason,
                affectedSubsystems,
                resultingMode: after.effective_mode,
                source,
            },
        });

        return result;
    }

    public getActionHistory(): OperatorActionResultContract[] {
        return [...this.actionHistory];
    }

    public getAutoRepairHistory(): OperatorActionResultContract[] {
        return [...this.autoRepairHistory];
    }

    public async executeAutoAction(
        action: OperatorActionId,
        params?: Record<string, unknown>,
        requestedBy: string = 'system_auto_repair',
    ): Promise<OperatorActionResultContract> {
        return this.executeAction({
            action,
            requested_by: requestedBy,
            params,
            source: 'auto_repair',
        });
    }

    public getVisibilityState(): {
        acknowledged_incidents: string[];
        muted_duplicate_alert_keys: string[];
        pinned_issue: string | null;
        self_improvement_locked: boolean;
        high_risk_human_approval_required: boolean;
    } {
        return {
            acknowledged_incidents: [...this.acknowledgedIncidents],
            muted_duplicate_alert_keys: [...this.mutedAlertKeys],
            pinned_issue: this.pinnedIssue,
            self_improvement_locked: this.selfImprovementLocked,
            high_risk_human_approval_required: this.highRiskApprovalRequired,
        };
    }

    private _buildDeniedResult(
        action: OperatorActionId,
        requestedBy: string,
        executedAt: string,
        before: SystemHealthSnapshot,
        reason: string,
        affectedSubsystems: string[],
        actionExecutionId: string = uuidv4(),
        source: OperatorActionSource = 'operator',
    ): OperatorActionResultContract {
        const result: OperatorActionResultContract = {
            action_id: actionExecutionId,
            action,
            requested_by: requestedBy,
            executed_at: executedAt,
            allowed: false,
            reason,
            affected_subsystems: affectedSubsystems,
            resulting_mode_change: null,
            resulting_health_delta: {
                overall_before: before.overall_status,
                overall_after: before.overall_status,
                trust_score_before: before.trust_score,
                trust_score_after: before.trust_score,
                trust_score_delta: 0,
                new_incidents: [],
                resolved_incidents: [],
            },
            rollback_availability: 'none',
            source,
        };
        this._recordActionResult(result);
        this._emitAuditRecord(result);
        TelemetryBus.getInstance().emit({
            executionId: actionExecutionId,
            subsystem: 'system',
            event: source === 'operator' ? 'execution.operator_action' : 'execution.auto_action',
            phase: 'operator_action',
            payload: {
                action,
                requestedBy,
                allowed: false,
                reason,
                affectedSubsystems,
                resultingMode: before.effective_mode,
                source,
            },
        });
        return result;
    }

    private _buildAllowedResult(
        action: OperatorActionId,
        requestedBy: string,
        executedAt: string,
        before: SystemHealthSnapshot,
        after: SystemHealthSnapshot,
        reason: string,
        affectedSubsystems: string[],
        rollback: RollbackAvailability,
        details?: Record<string, unknown>,
        actionExecutionId: string = uuidv4(),
        source: OperatorActionSource = 'operator',
    ): OperatorActionResultContract {
        const beforeIncidents = new Set(before.active_incidents);
        const afterIncidents = new Set(after.active_incidents);
        const newIncidents = [...afterIncidents].filter((i) => !beforeIncidents.has(i));
        const resolvedIncidents = [...beforeIncidents].filter((i) => !afterIncidents.has(i));
        const trustDelta = Math.round((after.trust_score - before.trust_score) * 100) / 100;

        return {
            action_id: actionExecutionId,
            action,
            requested_by: requestedBy,
            executed_at: executedAt,
            allowed: true,
            reason,
            affected_subsystems: affectedSubsystems,
            resulting_mode_change: before.effective_mode === after.effective_mode
                ? null
                : { from_mode: before.effective_mode, to_mode: after.effective_mode },
            resulting_health_delta: {
                overall_before: before.overall_status,
                overall_after: after.overall_status,
                trust_score_before: before.trust_score,
                trust_score_after: after.trust_score,
                trust_score_delta: trustDelta,
                new_incidents: newIncidents,
                resolved_incidents: resolvedIncidents,
            },
            rollback_availability: rollback,
            source,
            details,
        };
    }

    private async _retryHealthFor(target: string): Promise<string[]> {
        const normalized = target.toLowerCase();
        if (normalized === 'inference') {
            await this.deps.runtimeControl.probeProviders();
            return ['inference_service'];
        }
        if (normalized === 'tools' || normalized === 'mcp') {
            this.deps.runtimeControl.probeMcpServices();
            return ['mcp_tool_availability', 'tool_execution_coordinator'];
        }
        if (normalized === 'db' || normalized === 'memory') {
            await checkCanonicalDbHealth();
            return normalized === 'db'
                ? ['db_health_service']
                : ['memory_authority_service', 'db_health_service'];
        }
        await this.deps.runtimeControl.probeProviders();
        this.deps.runtimeControl.probeMcpServices();
        await checkCanonicalDbHealth();
        return ['inference_service', 'mcp_tool_availability', 'db_health_service', 'memory_authority_service'];
    }

    private async _retryToolConnectorInitialization(): Promise<Record<string, unknown>> {
        const snapshot = this.deps.diagnosticsAggregator.getSnapshot();
        const unavailable = snapshot.mcp.services.filter((s) => s.status === 'failed' || s.status === 'unavailable');
        const settings = loadSettings(this.deps.getSettingsPath());
        const configs = (settings.mcpServers ?? []) as McpServerConfig[];
        const restarted: string[] = [];
        const failed: Array<{ serviceId: string; reason: string }> = [];

        for (const svc of unavailable) {
            try {
                const result = await this.deps.runtimeControl.restartMcpService(svc.serviceId, configs);
                if (result.success) restarted.push(svc.serviceId);
                else failed.push({ serviceId: svc.serviceId, reason: result.error ?? 'unknown' });
            } catch (err: any) {
                failed.push({ serviceId: svc.serviceId, reason: err?.message ?? String(err) });
            }
        }
        if (unavailable.length === 0) {
            this.deps.runtimeControl.probeMcpServices();
        }
        return { attempted: unavailable.map((s) => s.serviceId), restarted, failed };
    }

    private async _flushStalledQueues(): Promise<Record<string, unknown>> {
        const refl = this.deps.reflectionService;
        const summary: Record<string, unknown> = {};
        if (refl) {
            const queue = await refl.getQueueService().listAll();
            const retryable = queue.filter((q) => q.status === 'failed' || q.status === 'cancelled');
            const retried: string[] = [];
            for (const item of retryable) {
                const ok = await refl.getQueueService().retryItem(item.queueItemId);
                if (ok) retried.push(item.queueItemId);
            }
            await refl.getScheduler().tickNow();
            summary.reflection = {
                total: queue.length,
                retryable: retryable.length,
                retried,
                schedulerTicked: true,
            };
        } else {
            summary.reflection = { available: false };
        }

        if (this.deps.autonomyOrchestrator) {
            await this.deps.autonomyOrchestrator.checkPendingGovernanceRuns();
            summary.autonomy = { checkedPendingGovernanceRuns: true };
        } else {
            summary.autonomy = { available: false };
        }
        return summary;
    }

    /**
     * Best-effort derived state rebuild entrypoint.
     * This never bypasses canonical authority; it only performs bounded
     * revalidation and scheduler ticks through existing runtime services.
     */
    private async _rerunDerivedRebuild(): Promise<Record<string, unknown>> {
        const authorityHealth = await checkCanonicalDbHealth();
        if (!this.deps.reflectionService) {
            return {
                authorityHealth,
                reflectionSchedulerTicked: false,
                reason: 'reflection_service_not_initialized',
            };
        }
        await this.deps.reflectionService.getScheduler().tickNow();
        return {
            authorityHealth,
            reflectionSchedulerTicked: true,
        };
    }

    private async _openEvidenceTrail(params?: Record<string, unknown>): Promise<Record<string, unknown>> {
        const svc = this.deps.logViewerService;
        if (!svc) {
            return { available: false, reason: 'log_viewer_not_initialized' };
        }
        const sourceId = String(params?.source_id ?? 'audit');
        const entries = await svc.readEntries(sourceId, { limit: 25, offset: 0 });
        return {
            available: true,
            sourceId,
            totalSize: entries.totalSize,
            returned: entries.entries.length,
            entries: entries.entries.map((e) => ({
                id: e.id,
                timestamp: e.timestamp,
                level: e.level,
                message: e.message,
            })),
        };
    }

    private _isSelfImprovementAction(action: OperatorActionId): boolean {
        return action === 'approve_repair_proposal'
            || action === 'defer_proposal'
            || action === 'unlock_self_improvement';
    }

    private _emitAuditRecord(result: OperatorActionResultContract): void {
        auditLogger.info(
            result.allowed ? 'operator_action_executed' : 'operator_action_denied',
            'OperatorActionService',
            {
                action_id: result.action_id,
                action: result.action,
                requested_by: result.requested_by,
                source: result.source,
                allowed: result.allowed,
                reason: result.reason,
                affected_subsystems: result.affected_subsystems,
                resulting_mode_change: result.resulting_mode_change,
                resulting_health_delta: result.resulting_health_delta,
                rollback_availability: result.rollback_availability,
            },
            result.action_id,
        );
    }

    private _recordActionResult(result: OperatorActionResultContract): void {
        if (result.source === 'auto_repair') {
            this.autoRepairHistory.push(result);
            if (this.autoRepairHistory.length > 100) this.autoRepairHistory = this.autoRepairHistory.slice(-100);
            return;
        }
        this.actionHistory.push(result);
        if (this.actionHistory.length > 100) this.actionHistory = this.actionHistory.slice(-100);
    }

    private _checkModeAllowance(
        action: OperatorActionId,
        health: SystemHealthSnapshot,
    ): { allowed: boolean; reason: string; affectedSubsystems: string[] } {
        const allowed = health.mode_contract.operator_actions_allowed;
        const requires = (() => {
            switch (action) {
                case 'resume_autonomy':
                    return 'resume_autonomy';
                case 'enter_maintenance_mode':
                    return 'run_maintenance_checks';
                case 'clear_maintenance_mode':
                    return 'exit_maintenance';
                case 'revalidate_memory_authority':
                    return 'revalidate_authority';
                default:
                    return null;
            }
        })();
        if (requires && !allowed.includes(requires) && health.effective_mode !== 'NORMAL') {
            return {
                allowed: false,
                reason: `blocked_by_mode_contract:${health.effective_mode}:${requires}`,
                affectedSubsystems: ['runtime_mode_manager'],
            };
        }
        return { allowed: true, reason: 'allowed_by_mode_contract', affectedSubsystems: [] };
    }
}
