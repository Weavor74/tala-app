/**
 * A2UIWorkspaceRouter — Phase 4C: A2UI Workspace Surfaces
 *
 * Routes A2UI surface payloads to the document/editor pane workspace tabs.
 * Assembles surface content from existing diagnostic/read models and emits
 * normalized payloads to the renderer via the 'agent-event' channel.
 *
 * Architecture rules:
 * - Surfaces always target the document/editor pane (never chat inline).
 * - Stable tab IDs prevent duplicate tab creation on re-open.
 * - Lightweight chat notices are emitted separately, not surface content.
 * - All surface assembly is done main-side; the renderer is a host only.
 * - Failures degrade gracefully to textual summaries.
 *
 * Data sources:
 * - Cognition  → RuntimeDiagnosticsAggregator.getSnapshot().cognitive
 * - World      → WorldModelAssembler.getCachedModel()
 * - Maintenance → MaintenanceLoopService.getDiagnosticsSummary()
 */

import type { BrowserWindow } from 'electron';
import type { A2UISurfaceId, A2UISurfacePayload, A2UISurfaceRegistryEntry, A2UIDiagnosticsSummary } from '../../shared/a2uiTypes';
import type { RuntimeDiagnosticsAggregator } from './RuntimeDiagnosticsAggregator';
import type { WorldModelAssembler } from './world/WorldModelAssembler';
import type { MaintenanceLoopService } from './maintenance/MaintenanceLoopService';
import { mapCognitionSurface } from './cognitive/CognitionSurfaceMapper';
import { mapWorldSurface } from './world/WorldSurfaceMapper';
import { mapMaintenanceSurface } from './maintenance/MaintenanceSurfaceMapper';
import { telemetry } from './TelemetryService';

/**
 * Dependencies injected at construction time.
 */
export interface A2UIWorkspaceRouterDeps {
    getMainWindow: () => BrowserWindow | null;
    diagnosticsAggregator: RuntimeDiagnosticsAggregator;
    worldModelAssembler?: WorldModelAssembler;
    maintenanceLoopService?: MaintenanceLoopService;
}

/**
 * A2UIWorkspaceRouter
 *
 * Singleton-friendly router that assembles and delivers A2UI surface payloads
 * to the renderer's document/editor pane. Maintains a bounded registry of
 * open surfaces for diagnostics visibility.
 */
export class A2UIWorkspaceRouter {
    private readonly _deps: A2UIWorkspaceRouterDeps;

    /** Registry of currently-open surfaces. */
    private readonly _openSurfaces = new Map<A2UISurfaceId, A2UISurfaceRegistryEntry>();

    /** Session-level counters for diagnostics. */
    private _updateCount = 0;
    private _failureCount = 0;

    constructor(deps: A2UIWorkspaceRouterDeps) {
        this._deps = deps;
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Opens or updates a named A2UI surface in the document/editor pane.
     * Assembles the surface payload, emits it to the renderer, and registers
     * the surface for diagnostics visibility.
     *
     * @returns The assembled surface payload, or null on failure.
     */
    public async openSurface(
        surfaceId: A2UISurfaceId,
        opts: { focus?: boolean } = {}
    ): Promise<A2UISurfacePayload | null> {
        const focus = opts.focus ?? true;

        telemetry.emit('system', 'a2ui_surface_open_requested', 'info', 'A2UIWorkspaceRouter',
            `A2UI surface open requested: ${surfaceId}`, 'success',
            { payload: { surfaceId, surfaceType: surfaceId, targetPane: 'document_editor' } });

        let payload: A2UISurfacePayload | null = null;
        try {
            payload = await this._assemblePayload(surfaceId, focus);
        } catch (err) {
            this._failureCount++;
            telemetry.emit('system', 'a2ui_surface_failed', 'warn', 'A2UIWorkspaceRouter',
                `A2UI surface assembly failed: ${surfaceId}`, 'failure',
                { payload: { surfaceId, surfaceType: surfaceId, targetPane: 'document_editor', outcome: 'failure', reason: err instanceof Error ? err.message : String(err) } });
            console.error(`[A2UIWorkspaceRouter] Failed to assemble surface '${surfaceId}':`, err);
            return null;
        }

        const win = this._deps.getMainWindow();
        if (!win || win.isDestroyed()) {
            this._failureCount++;
            telemetry.emit('system', 'a2ui_surface_failed', 'warn', 'A2UIWorkspaceRouter',
                `A2UI surface failed — no window: ${surfaceId}`, 'failure',
                { payload: { surfaceId, surfaceType: surfaceId, targetPane: 'document_editor', outcome: 'failure', reason: 'No active BrowserWindow' } });
            return null;
        }

        // Emit surface payload to renderer via agent-event channel
        win.webContents.send('agent-event', {
            type: 'a2ui-surface-open',
            data: payload,
        });

        // Update registry
        const registryEntry: A2UISurfaceRegistryEntry = {
            surfaceId,
            tabId: payload.tabId,
            lastUpdatedAt: payload.assembledAt,
            dataSource: payload.dataSource,
        };
        this._openSurfaces.set(surfaceId, registryEntry);
        this._updateCount++;

        const isUpdate = this._openSurfaces.has(surfaceId);
        const eventType = isUpdate ? 'a2ui_surface_updated' : 'a2ui_surface_opened';
        telemetry.emit('system', eventType, 'info', 'A2UIWorkspaceRouter',
            `A2UI surface ${isUpdate ? 'updated' : 'opened'}: ${surfaceId}`, 'success',
            { payload: { surfaceId, surfaceType: surfaceId, targetPane: 'document_editor', focused: focus, outcome: 'success' } });

        console.log(`[A2UIWorkspaceRouter] Surface '${surfaceId}' opened/updated. Tab: ${payload.tabId}`);
        return payload;
    }

    /**
     * Returns the current diagnostics summary for all A2UI surfaces.
     */
    public getDiagnosticsSummary(): A2UIDiagnosticsSummary {
        return {
            openSurfaces: Array.from(this._openSurfaces.values()),
            actionDispatchCount: 0, // tracked by A2UIActionBridge
            surfaceUpdateCount: this._updateCount,
            surfaceFailureCount: this._failureCount,
            actionFailureCount: 0, // tracked by A2UIActionBridge
        };
    }

    /**
     * Checks whether a surface is currently registered as open.
     */
    public isSurfaceOpen(surfaceId: A2UISurfaceId): boolean {
        return this._openSurfaces.has(surfaceId);
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    /**
     * Assembles the A2UI surface payload for the given surface ID.
     */
    private async _assemblePayload(
        surfaceId: A2UISurfaceId,
        focus: boolean
    ): Promise<A2UISurfacePayload> {
        switch (surfaceId) {
            case 'cognition': {
                const snapshot = this._deps.diagnosticsAggregator.getSnapshot().cognitive ?? null;
                const payload = mapCognitionSurface(snapshot);
                payload.focus = focus;
                return payload;
            }
            case 'world': {
                const world = this._deps.worldModelAssembler?.getCachedModel() ?? null;
                const payload = mapWorldSurface(world ?? null);
                payload.focus = focus;
                return payload;
            }
            case 'maintenance': {
                const summary = this._deps.maintenanceLoopService?.getDiagnosticsSummary() ?? null;
                const payload = mapMaintenanceSurface(summary);
                payload.focus = focus;
                return payload;
            }
            default: {
                // TypeScript exhaustiveness guard
                const _exhaustive: never = surfaceId;
                throw new Error(`[A2UIWorkspaceRouter] Unknown surface ID: ${String(_exhaustive)}`);
            }
        }
    }
}
