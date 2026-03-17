/**
 * A2UIActionBridge — Phase 4C: A2UI Workspace Surfaces
 *
 * Validates and executes actions dispatched from A2UI renderer surfaces.
 * Enforces an allowlist of safe actions and normalizes payloads before
 * routing to runtime services.
 *
 * Safety model:
 * - Only allowlisted action names are accepted.
 * - Each action's payload schema is validated before execution.
 * - No arbitrary code execution or untyped dispatch is possible.
 * - All actions emit telemetry for full observability.
 * - Destructive actions are not exposed in the allowlist.
 */

import type { A2UIActionDispatch, A2UIActionName, A2UIActionResult } from '../../shared/a2uiTypes';
import type { A2UIWorkspaceRouter } from './A2UIWorkspaceRouter';
import type { MaintenanceLoopService } from './maintenance/MaintenanceLoopService';
import type { RuntimeControlService } from './RuntimeControlService';
import type { RuntimeDiagnosticsAggregator } from './RuntimeDiagnosticsAggregator';
import type { WorldModelAssembler } from './world/WorldModelAssembler';
import type { MaintenanceMode } from '../../shared/maintenance/maintenanceTypes';
import { telemetry } from './TelemetryService';

/**
 * Set of allowlisted action names.
 * Only these may be dispatched from the renderer.
 */
const ALLOWED_ACTIONS: Set<A2UIActionName> = new Set([
    'open_cognition_surface',
    'open_world_surface',
    'open_maintenance_surface',
    'refresh_cognition',
    'refresh_world',
    'refresh_maintenance',
    'run_maintenance_check',
    'switch_maintenance_mode',
    'restart_provider',
    'restart_mcp_service',
]);

/**
 * Valid maintenance mode values for the switch_maintenance_mode action.
 */
const VALID_MAINTENANCE_MODES: Set<MaintenanceMode> = new Set([
    'observation_only',
    'recommend_only',
    'safe_auto_recovery',
]);

export interface A2UIActionBridgeDeps {
    router: A2UIWorkspaceRouter;
    maintenanceLoopService?: MaintenanceLoopService;
    runtimeControlService?: RuntimeControlService;
    diagnosticsAggregator?: RuntimeDiagnosticsAggregator;
    worldModelAssembler?: WorldModelAssembler;
}

/**
 * A2UIActionBridge
 *
 * Validates and dispatches actions from the A2UI renderer to runtime services.
 * Maintains counters for diagnostics visibility.
 */
export class A2UIActionBridge {
    private readonly _deps: A2UIActionBridgeDeps;

    private _dispatchCount = 0;
    private _failureCount = 0;

    constructor(deps: A2UIActionBridgeDeps) {
        this._deps = deps;
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Dispatches an A2UI action after validation.
     * Returns a result object indicating success or failure.
     */
    public async dispatch(action: A2UIActionDispatch): Promise<A2UIActionResult> {
        this._dispatchCount++;

        telemetry.emit('system', 'a2ui_action_received', 'info', 'A2UIActionBridge',
            `A2UI action received: ${action.actionName}`, 'success',
            { payload: { surfaceId: action.surfaceId, actionName: action.actionName, targetPane: 'document_editor' } });

        // Step 1: Validate action name against allowlist
        if (!ALLOWED_ACTIONS.has(action.actionName)) {
            this._failureCount++;
            telemetry.emit('system', 'a2ui_action_failed', 'warn', 'A2UIActionBridge',
                `A2UI action rejected: ${action.actionName}`, 'failure',
                { payload: { surfaceId: action.surfaceId, actionName: action.actionName, outcome: 'rejected', reason: `Action '${action.actionName}' is not in the allowlist.` } });
            return {
                success: false,
                message: `Action '${action.actionName}' is not permitted.`,
                error: 'not_in_allowlist',
            };
        }

        telemetry.emit('system', 'a2ui_action_validated', 'info', 'A2UIActionBridge',
            `A2UI action validated: ${action.actionName}`, 'success',
            { payload: { surfaceId: action.surfaceId, actionName: action.actionName, targetPane: 'document_editor' } });

        // Step 2: Execute
        try {
            const result = await this._execute(action);
            if (result.success) {
                telemetry.emit('system', 'a2ui_action_executed', 'info', 'A2UIActionBridge',
                    `A2UI action executed: ${action.actionName}`, 'success',
                    { payload: { surfaceId: action.surfaceId, actionName: action.actionName, outcome: 'success', targetPane: 'document_editor' } });
            } else {
                this._failureCount++;
                telemetry.emit('system', 'a2ui_action_failed', 'warn', 'A2UIActionBridge',
                    `A2UI action failed: ${action.actionName}`, 'failure',
                    { payload: { surfaceId: action.surfaceId, actionName: action.actionName, outcome: 'failure', reason: result.error } });
            }
            return result;
        } catch (err) {
            this._failureCount++;
            const errMsg = err instanceof Error ? err.message : String(err);
            telemetry.emit('system', 'a2ui_action_failed', 'warn', 'A2UIActionBridge',
                `A2UI action threw: ${action.actionName}`, 'failure',
                { payload: { surfaceId: action.surfaceId, actionName: action.actionName, outcome: 'failure', reason: errMsg } });
            console.error(`[A2UIActionBridge] Action '${action.actionName}' threw:`, err);
            return {
                success: false,
                message: `Action '${action.actionName}' failed with an error.`,
                error: errMsg,
            };
        }
    }

    /** Returns session-level action counters for diagnostics. */
    public getActionCounts(): { dispatched: number; failed: number } {
        return { dispatched: this._dispatchCount, failed: this._failureCount };
    }

    // ─── Private execution logic ──────────────────────────────────────────────

    private async _execute(action: A2UIActionDispatch): Promise<A2UIActionResult> {
        const { actionName, payload } = action;

        switch (actionName) {
            // ── Surface navigation ───────────────────────────────────────────
            case 'open_cognition_surface': {
                const updated = await this._deps.router.openSurface('cognition');
                return { success: true, message: 'Cognition surface opened.', updatedSurface: updated ?? undefined };
            }

            case 'open_world_surface': {
                const updated = await this._deps.router.openSurface('world');
                return { success: true, message: 'World model surface opened.', updatedSurface: updated ?? undefined };
            }

            case 'open_maintenance_surface': {
                const updated = await this._deps.router.openSurface('maintenance');
                return { success: true, message: 'Maintenance surface opened.', updatedSurface: updated ?? undefined };
            }

            // ── Surface refresh ──────────────────────────────────────────────
            case 'refresh_cognition': {
                const updated = await this._deps.router.openSurface('cognition');
                return { success: true, message: 'Cognition surface refreshed.', updatedSurface: updated ?? undefined };
            }

            case 'refresh_world': {
                const updated = await this._deps.router.openSurface('world');
                return { success: true, message: 'World surface refreshed.', updatedSurface: updated ?? undefined };
            }

            case 'refresh_maintenance': {
                const updated = await this._deps.router.openSurface('maintenance');
                return { success: true, message: 'Maintenance surface refreshed.', updatedSurface: updated ?? undefined };
            }

            // ── Maintenance actions ──────────────────────────────────────────
            case 'run_maintenance_check': {
                const svc = this._deps.maintenanceLoopService;
                if (!svc) {
                    return { success: false, message: 'Maintenance service not available.', error: 'service_unavailable' };
                }
                const snapshot = this._deps.diagnosticsAggregator?.getSnapshot();
                const worldModel = this._deps.worldModelAssembler?.getCachedModel() ?? undefined;
                if (!snapshot) {
                    return { success: false, message: 'Diagnostics snapshot not available for maintenance check.', error: 'no_snapshot' };
                }
                await svc.runCycle(snapshot, worldModel ?? undefined);
                const updated = await this._deps.router.openSurface('maintenance');
                return {
                    success: true,
                    message: 'Maintenance check completed.',
                    updatedSurface: updated ?? undefined,
                };
            }

            case 'switch_maintenance_mode': {
                const svc = this._deps.maintenanceLoopService;
                if (!svc) {
                    return { success: false, message: 'Maintenance service not available.', error: 'service_unavailable' };
                }
                const newMode = payload?.mode as MaintenanceMode | undefined;
                if (!newMode || !VALID_MAINTENANCE_MODES.has(newMode)) {
                    return {
                        success: false,
                        message: `Invalid maintenance mode: '${String(newMode)}'.`,
                        error: 'invalid_mode',
                    };
                }
                svc.setMode(newMode);
                const updated = await this._deps.router.openSurface('maintenance');
                return {
                    success: true,
                    message: `Maintenance mode switched to '${newMode}'.`,
                    updatedSurface: updated ?? undefined,
                };
            }

            // ── Runtime controls ─────────────────────────────────────────────
            case 'restart_provider': {
                const rcs = this._deps.runtimeControlService;
                if (!rcs) {
                    return { success: false, message: 'Runtime control service not available.', error: 'service_unavailable' };
                }
                const providerId = payload?.providerId as string | undefined;
                if (!providerId || typeof providerId !== 'string') {
                    return { success: false, message: 'providerId required for restart_provider.', error: 'missing_payload' };
                }
                const result = await rcs.restartProvider(providerId);
                return {
                    success: result.success,
                    message: `Provider restart ${result.success ? 'completed' : 'failed'} for '${providerId}'.`,
                    error: result.success ? undefined : (result.error ?? 'unknown'),
                };
            }

            case 'restart_mcp_service': {
                const rcs = this._deps.runtimeControlService;
                if (!rcs) {
                    return { success: false, message: 'Runtime control service not available.', error: 'service_unavailable' };
                }
                const serviceId = payload?.serviceId as string | undefined;
                if (!serviceId || typeof serviceId !== 'string') {
                    return { success: false, message: 'serviceId required for restart_mcp_service.', error: 'missing_payload' };
                }
                // MCP restart requires mcpConfigs — provide empty array as safe default
                const result = await rcs.restartMcpService(serviceId, []);
                return {
                    success: result.success,
                    message: `MCP service restart ${result.success ? 'completed' : 'failed'} for '${serviceId}'.`,
                    error: result.success ? undefined : (result.error ?? 'unknown'),
                };
            }

            default: {
                // TypeScript exhaustiveness check
                const _exhaustive: never = actionName;
                return {
                    success: false,
                    message: `Unhandled action: ${String(_exhaustive)}`,
                    error: 'unhandled_action',
                };
            }
        }
    }
}
