/**
 * RuntimeDiagnosticsAggregator — Unified Runtime Diagnostics Snapshot Producer
 *
 * Assembles a RuntimeDiagnosticsSnapshot from:
 * - InferenceDiagnosticsService (inference provider + stream state)
 * - McpLifecycleManager (MCP service inventory + lifecycle state)
 *
 * This is the single point of truth for app-facing runtime diagnostics.
 * IPC handlers call getSnapshot() to retrieve the current operational picture.
 *
 * Design rules:
 * - All returned data is safe for IPC serialization.
 * - No probing or live service calls — reads from already-maintained state.
 * - Snapshot is assembled on demand; no background aggregation loop needed.
 * - Degraded subsystem list is derived from normalized status, not raw booleans.
 */

import type {
    RuntimeDiagnosticsSnapshot,
    RuntimeFailureSummary,
    InferenceDiagnosticsState,
    McpInventoryDiagnostics,
} from '../../shared/runtimeDiagnosticsTypes';
import type { InferenceDiagnosticsService } from './InferenceDiagnosticsService';
import type { McpLifecycleManager } from './McpLifecycleManager';

export class RuntimeDiagnosticsAggregator {
    constructor(
        private readonly inferenceDiagnostics: InferenceDiagnosticsService,
        private readonly mcpLifecycle: McpLifecycleManager,
    ) {}

    /**
     * Returns the current normalized runtime diagnostics snapshot.
     * Safe to call from IPC handlers.
     *
     * @param sessionId - Optional session ID to include in the snapshot.
     */
    public getSnapshot(sessionId?: string): RuntimeDiagnosticsSnapshot {
        const now = new Date().toISOString();
        const inferenceState = this.inferenceDiagnostics.getState();
        const mcpInventory = this.mcpLifecycle.getDiagnosticsInventory();

        const degradedSubsystems = this._computeDegradedSubsystems(inferenceState, mcpInventory);
        const recentFailures = this._computeRecentFailures(inferenceState, mcpInventory);

        return {
            timestamp: now,
            sessionId,
            inference: inferenceState,
            mcp: mcpInventory,
            degradedSubsystems,
            recentFailures,
            lastUpdatedPerSubsystem: {
                inference: inferenceState.lastUpdated,
                mcp: mcpInventory.lastUpdated,
            },
        };
    }

    /**
     * Returns only the normalized inference diagnostics state.
     * Used by the diagnostics:getInferenceStatus IPC handler.
     */
    public getInferenceStatus(): InferenceDiagnosticsState {
        return this.inferenceDiagnostics.getState();
    }

    /**
     * Returns only the normalized MCP inventory diagnostics.
     * Used by the diagnostics:getMcpStatus IPC handler.
     */
    public getMcpStatus(): McpInventoryDiagnostics {
        return this.mcpLifecycle.getDiagnosticsInventory();
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private _computeDegradedSubsystems(
        inference: InferenceDiagnosticsState,
        mcp: McpInventoryDiagnostics,
    ): string[] {
        const degraded: string[] = [];

        // Inference: degraded if selected provider is not ready and stream is not idle
        if (!inference.selectedProviderReady && inference.streamStatus !== 'idle') {
            degraded.push('inference');
        }

        // Inference: degraded if last stream failed/timed-out
        if (inference.lastStreamStatus === 'failed' || inference.lastStreamStatus === 'timed_out') {
            if (!degraded.includes('inference')) degraded.push('inference');
        }

        // MCP: degraded if any service is degraded or unavailable
        if (mcp.totalDegraded > 0 || mcp.totalUnavailable > 0) {
            degraded.push('mcp');
        }

        return degraded;
    }

    private _computeRecentFailures(
        inference: InferenceDiagnosticsState,
        mcp: McpInventoryDiagnostics,
    ): RuntimeFailureSummary {
        const failedEntityIds: string[] = [];
        let count = 0;
        let lastFailureTime: string | undefined;
        let lastFailureReason: string | undefined;

        // Inference failures
        if (inference.lastFailureTime) {
            count++;
            failedEntityIds.push(inference.lastUsedProviderId ?? 'inference');
            if (!lastFailureTime || inference.lastFailureTime > lastFailureTime) {
                lastFailureTime = inference.lastFailureTime;
                lastFailureReason = inference.lastFailureReason;
            }
        }

        // MCP failures
        for (const svc of mcp.services) {
            if (svc.status === 'failed' || svc.status === 'unavailable') {
                count++;
                failedEntityIds.push(svc.serviceId);
                if (svc.lastTransitionTime && (!lastFailureTime || svc.lastTransitionTime > lastFailureTime)) {
                    lastFailureTime = svc.lastTransitionTime;
                    lastFailureReason = svc.lastFailureReason;
                }
            }
        }

        return { count, lastFailureTime, lastFailureReason, failedEntityIds };
    }
}
