/**
 * MaintenanceActionExecutor — Phase 4B: Self-Maintenance Foundation
 *
 * Safe maintenance action execution layer. Executes only actions approved
 * by the MaintenancePolicyEngine, wrapping existing RuntimeControlService
 * operations with structured result objects, telemetry, and cooldown tracking.
 *
 * Safety constraints (enforced here, not only in policy):
 * - Only auto-safe actions may be executed without approval.
 * - Destructive actions (memory mutation, repo changes, provider deletion) are never executed.
 * - No silent repeated retries — every execution is logged.
 * - No filesystem mutation unless already part of a safe existing path.
 * - Execution results are always explicit with status, message, and optional error.
 *
 * Design rules:
 * - Does not duplicate runtime control logic — routes through RuntimeControlService.
 * - All executions emit telemetry via TelemetryService.
 * - The caller (SelfMaintenanceService) must check autoSafe before calling execute().
 */

import { telemetry } from '../TelemetryService';
import type { TelemetryEventType } from '../../../shared/telemetry';
import type { RuntimeControlService } from '../RuntimeControlService';
import type { McpServerConfig } from '../../../shared/settings';
import type {
    MaintenanceActionProposal,
    MaintenanceExecutionResult,
    MaintenanceExecutionStatus,
} from '../../../shared/maintenance/maintenanceTypes';

// ─── MaintenanceActionExecutor ────────────────────────────────────────────────

export class MaintenanceActionExecutor {

    constructor(
        private readonly runtimeControl: RuntimeControlService,
        private readonly getMcpConfigs: () => McpServerConfig[],
    ) {}

    /**
     * Execute a maintenance action proposal.
     * Returns a structured result with status, message, and optional cooldown.
     *
     * @param proposal - The action proposal from the policy engine.
     * @param bypassAutoSafeCheck - If true, skips the autoSafe gate (for approval-flow executions).
     */
    public async execute(
        proposal: MaintenanceActionProposal,
        bypassAutoSafeCheck = false,
    ): Promise<MaintenanceExecutionResult> {
        const executedAt = new Date().toISOString();

        // Safety gate: approval-pending actions are never auto-executed (check first)
        if (proposal.policyOutcome === 'request_user_approval' && !bypassAutoSafeCheck) {
            return this._result(proposal, 'requires_user_approval', executedAt,
                `Action '${proposal.actionType}' requires user approval before execution.`);
        }

        // Safety gate: only auto-safe proposals may be executed without explicit bypass
        if (!proposal.autoSafe && !bypassAutoSafeCheck) {
            return this._result(proposal, 'blocked_by_policy', executedAt,
                `Action '${proposal.actionType}' is not auto-safe and requires user approval.`);
        }

        try {
            return await this._dispatch(proposal, executedAt);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            telemetry.operational('maintenance', 'maintenance_action_failed', {
                status: 'failure',
                summary: `Maintenance action failed: ${proposal.actionType}`,
                payload: { actionType: proposal.actionType, targetEntityId: proposal.targetEntityId, error: message },
            });
            return this._result(proposal, 'failed', executedAt,
                `Action '${proposal.actionType}' threw an exception.`, message);
        }
    }

    // ─── Action dispatch ──────────────────────────────────────────────────────

    private async _dispatch(
        proposal: MaintenanceActionProposal,
        executedAt: string,
    ): Promise<MaintenanceExecutionResult> {
        const { actionType, targetEntityId } = proposal;

        switch (actionType) {

            case 'reprobe_providers': {
                const result = await this.runtimeControl.probeProviders();
                return this._fromControlResult(proposal, executedAt, result.success,
                    result.success ? 'Provider reprobe completed.' : `Provider reprobe failed: ${result.error ?? 'unknown'}`);
            }

            case 'restart_provider': {
                if (!targetEntityId) {
                    return this._result(proposal, 'skipped', executedAt,
                        'restart_provider requires a targetEntityId but none was provided.');
                }
                const result = await this.runtimeControl.restartProvider(targetEntityId);
                return this._fromControlResult(proposal, executedAt, result.success,
                    result.success
                        ? `Provider '${targetEntityId}' restart completed.`
                        : `Provider '${targetEntityId}' restart failed: ${result.error ?? 'unknown'}`);
            }

            case 'reprobe_mcp_services': {
                const result = this.runtimeControl.probeMcpServices();
                return this._fromControlResult(proposal, executedAt, result.success,
                    result.success ? 'MCP service reprobe completed.' : `MCP reprobe failed: ${result.error ?? 'unknown'}`);
            }

            case 'restart_mcp_service': {
                if (!targetEntityId) {
                    return this._result(proposal, 'skipped', executedAt,
                        'restart_mcp_service requires a targetEntityId but none was provided.');
                }
                const configs = this.getMcpConfigs();
                const result = await this.runtimeControl.restartMcpService(targetEntityId, configs);
                return this._fromControlResult(proposal, executedAt, result.success,
                    result.success
                        ? `MCP service '${targetEntityId}' restart completed.`
                        : `MCP service '${targetEntityId}' restart failed: ${result.error ?? 'unknown'}`);
            }

            case 'disable_provider_temporarily': {
                // Disabling a provider requires approval — blocked at this layer
                return this._result(proposal, 'blocked_by_policy', executedAt,
                    `'disable_provider_temporarily' requires user approval and cannot be auto-executed.`);
            }

            case 'escalate_to_user': {
                // Not executable — this is a diagnostics surface action only
                return this._result(proposal, 'skipped', executedAt,
                    `'escalate_to_user' is a diagnostic action; no runtime execution performed.`);
            }

            case 'monitor_only': {
                return this._result(proposal, 'skipped', executedAt,
                    `'monitor_only' action type requires no execution.`);
            }

            default: {
                return this._result(proposal, 'blocked_by_policy', executedAt,
                    `Unknown action type '${actionType}' — blocked for safety.`);
            }
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private _fromControlResult(
        proposal: MaintenanceActionProposal,
        executedAt: string,
        success: boolean,
        message: string,
    ): MaintenanceExecutionResult {
        const status: MaintenanceExecutionStatus = success ? 'success' : 'failed';

        const event = success ? 'maintenance_action_autoexecuted' : 'maintenance_action_failed';
        telemetry.operational('maintenance', event as TelemetryEventType, {
            status: success ? 'success' : 'failure',
            summary: message,
            payload: {
                actionType: proposal.actionType,
                targetEntityId: proposal.targetEntityId,
                issueId: proposal.issueId,
            },
        });

        return {
            proposal,
            status,
            executedAt,
            message,
            cooldownUntil: proposal.cooldownUntil,
        };
    }

    private _result(
        proposal: MaintenanceActionProposal,
        status: MaintenanceExecutionStatus,
        executedAt: string,
        message: string,
        error?: string,
    ): MaintenanceExecutionResult {
        return {
            proposal,
            status,
            executedAt,
            message,
            error,
            cooldownUntil: proposal.cooldownUntil,
        };
    }
}
