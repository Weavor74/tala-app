/**
 * A2UIActionBridge — Phase 4C/4D: A2UI Workspace Surfaces & Coordination
 *
 * Validates and executes actions dispatched from A2UI renderer surfaces.
 * Enforces an allowlist of safe actions and normalizes payloads before
 * routing to runtime services.
 *
 * Phase 4D additions:
 * - UI → cognition feedback loop via CognitiveInteractionEvent.
 * - Structured interaction summaries fed into short-term memory context.
 * - All feedback is bounded and sanitized — no raw UI payloads injected.
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
import type { CognitiveInteractionEvent } from '../../shared/coordinationTypes';
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
    /**
     * Optional callback for feeding structured interaction events into cognition.
     * Called after every successful action — receives a bounded summary.
     * Phase 4D: UI → cognition feedback loop.
     */
    onCognitiveInteraction?: (event: CognitiveInteractionEvent) => void;
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

        telemetry.event('a2ui_action_received', {
            surfaceId: action.surfaceId,
            actionName: action.actionName,
            targetPane: 'document_editor',
        });

        // Step 1: Validate action name against allowlist
        if (!ALLOWED_ACTIONS.has(action.actionName)) {
            this._failureCount++;
            telemetry.event('a2ui_action_failed', {
                surfaceId: action.surfaceId,
                actionName: action.actionName,
                outcome: 'rejected',
                reason: `Action '${action.actionName}' is not in the allowlist.`,
            });
            return {
                success: false,
                message: `Action '${action.actionName}' is not permitted.`,
                error: 'not_in_allowlist',
            };
        }

        telemetry.event('a2ui_action_validated', {
            surfaceId: action.surfaceId,
            actionName: action.actionName,
            targetPane: 'document_editor',
        });

        // Step 2: Execute
        try {
            const result = await this._execute(action);
            if (result.success) {
                telemetry.event('a2ui_action_executed', {
                    surfaceId: action.surfaceId,
                    actionName: action.actionName,
                    outcome: 'success',
                    targetPane: 'document_editor',
                });
                // Phase 4D: Feed structured interaction summary into cognition
                this._emitCognitiveInteraction(action, true);
            } else {
                this._failureCount++;
                telemetry.event('a2ui_action_failed', {
                    surfaceId: action.surfaceId,
                    actionName: action.actionName,
                    outcome: 'failure',
                    reason: result.error,
                });
            }
            return result;
        } catch (err) {
            this._failureCount++;
            const errMsg = err instanceof Error ? err.message : String(err);
            telemetry.event('a2ui_action_failed', {
                surfaceId: action.surfaceId,
                actionName: action.actionName,
                outcome: 'failure',
                reason: errMsg,
            });
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

    // ─── Phase 4D: Cognitive interaction feedback ─────────────────────────────

    /**
     * Emits a structured CognitiveInteractionEvent to the cognition loop.
     * Only bounded, sanitized summaries are passed — never raw UI payloads.
     */
    private _emitCognitiveInteraction(action: A2UIActionDispatch, success: boolean): void {
        const cb = this._deps.onCognitiveInteraction;
        if (!cb) return;

        const summary = _buildInteractionSummary(action.actionName, success);
        const event: CognitiveInteractionEvent = {
            timestamp: new Date().toISOString(),
            actionName: action.actionName,
            surfaceId: action.surfaceId,
            summary,
            success,
        };

        cb(event);
        telemetry.event('surface_feedback_accepted', {
            surfaceId: action.surfaceId,
            actionName: action.actionName,
            reason: summary,
        });
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
                // Snapshot is optional — maintenance cycle can run with partial context
                if (snapshot) {
                    await svc.runCycle(snapshot, worldModel ?? undefined);
                } else {
                    // No snapshot available: still run cycle if the maintenance service
                    // can operate independently (e.g. world-model-only check).
                    await svc.runCycle(
                        { timestamp: new Date().toISOString(), degradedSubsystems: [], recentFailures: { count: 0, failedEntityIds: [] } } as any,
                        worldModel ?? undefined,
                    );
                }
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

// ─── Interaction summary builder ──────────────────────────────────────────────

/**
 * Builds a bounded, sanitized human-readable summary of an A2UI action.
 * Used to feed structured context into the cognition loop.
 * Max length: ~150 chars.
 */
function _buildInteractionSummary(actionName: A2UIActionName, success: boolean): string {
    const status = success ? 'completed' : 'failed';
    const summaries: Partial<Record<A2UIActionName, string>> = {
        restart_provider: `User initiated provider restart action — ${status}.`,
        restart_mcp_service: `User initiated MCP service restart — ${status}.`,
        run_maintenance_check: `User initiated maintenance check — ${status}.`,
        switch_maintenance_mode: `User changed maintenance mode — ${status}.`,
        open_maintenance_surface: `User opened maintenance panel.`,
        open_cognition_surface: `User opened cognition panel.`,
        open_world_surface: `User opened world model panel.`,
        refresh_maintenance: `User refreshed maintenance view.`,
        refresh_cognition: `User refreshed cognition view.`,
        refresh_world: `User refreshed world model view.`,
    };
    return summaries[actionName] ?? `User performed action '${actionName}' — ${status}.`;
}
