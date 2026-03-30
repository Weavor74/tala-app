/**
 * CrossSystemDashboardBridge.ts — Phase 6 P6H
 *
 * Milestone-gated IPC push for the Cross-System Intelligence Dashboard.
 *
 * Mirrors AutonomyDashboardBridge (Phase 4 P4G):
 * 1. Milestone-gated emit — only permitted milestones trigger a push.
 * 2. Deduplication — identical consecutive states are not re-emitted.
 *
 * IPC channel:
 *   crossSystem:dashboardUpdate — full CrossSystemDashboardState
 */

import { BrowserWindow } from 'electron';
import type {
    CrossSystemDashboardState,
    CrossSystemKpis,
    IncidentCluster,
    RootCauseHypothesis,
    StrategyDecisionRecord,
    CrossSystemOutcomeRecord,
} from '../../../../shared/crossSystemTypes';
import { telemetry } from '../../TelemetryService';

// ─── IPC channel name ─────────────────────────────────────────────────────────

export const CROSS_SYSTEM_DASHBOARD_CHANNEL = 'crossSystem:dashboardUpdate';

// ─── Permitted dashboard-push milestones ─────────────────────────────────────

const DASHBOARD_MILESTONES = new Set<string>([
    'signals_ingested',
    'cluster_formed',
    'root_cause_analyzed',
    'strategy_decided',
    'outcome_recorded',
]);

// ─── CrossSystemDashboardBridge ───────────────────────────────────────────────

export class CrossSystemDashboardBridge {
    private lastEmitHash: string | null = null;

    /**
     * Emits a dashboard update if the milestone is in the permitted set.
     * Deduplicates consecutive identical states — returns false if suppressed.
     */
    maybeEmit(milestone: string, state: CrossSystemDashboardState): boolean {
        if (!DASHBOARD_MILESTONES.has(milestone)) return false;

        const hash = this._stateHash(state);
        if (hash === this.lastEmitHash) return false;
        this.lastEmitHash = hash;

        this._broadcast(state);

        telemetry.operational(
            'autonomy',
            'operational',
            'debug',
            'CrossSystemDashboardBridge',
            `Dashboard update emitted at milestone '${milestone}' ` +
            `(openClusters=${state.openClusters.length}, signalWindow=${state.signalWindowCount})`,
        );

        return true;
    }

    /**
     * Pushes the full dashboard state unconditionally (used for IPC handler responses).
     */
    emitFull(state: CrossSystemDashboardState): CrossSystemDashboardState {
        this._broadcast(state);
        return state;
    }

    /**
     * Builds a CrossSystemDashboardState from raw engine outputs.
     *
     * @param clusters     All known clusters (open + closed).
     * @param rootCauses   Root cause hypotheses for open clusters.
     * @param decisions    All strategy decision records.
     * @param outcomes     All outcome records.
     * @param signalCount  Current in-window signal count from the aggregator.
     */
    buildState(
        clusters: IncidentCluster[],
        rootCauses: RootCauseHypothesis[],
        decisions: StrategyDecisionRecord[],
        outcomes: CrossSystemOutcomeRecord[],
        signalCount: number,
    ): CrossSystemDashboardState {
        const openClusters = clusters.filter(c => c.status === 'open');
        const recentClusters = clusters
            .filter(c => c.status === 'open' || c.status === 'addressed')
            .sort(
                (a, b) =>
                    new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime(),
            )
            .slice(0, 20);

        const recentDecisions = [...decisions]
            .sort(
                (a, b) =>
                    new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime(),
            )
            .slice(0, 20);

        const recentOutcomes = [...outcomes]
            .sort(
                (a, b) =>
                    new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime(),
            )
            .slice(0, 20);

        const kpis = this._computeKpis(clusters, rootCauses, decisions, outcomes, signalCount);

        return {
            openClusters,
            recentClusters,
            rootCauses,
            recentDecisions,
            recentOutcomes,
            signalWindowCount: signalCount,
            kpis,
            lastUpdatedAt: new Date().toISOString(),
        };
    }

    /**
     * Resets the deduplication hash so the next emit is always sent.
     */
    resetDedupHash(): void {
        this.lastEmitHash = null;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _broadcast(state: CrossSystemDashboardState): void {
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send(CROSS_SYSTEM_DASHBOARD_CHANNEL, state);
            }
        }
    }

    private _computeKpis(
        clusters: IncidentCluster[],
        rootCauses: RootCauseHypothesis[],
        decisions: StrategyDecisionRecord[],
        outcomes: CrossSystemOutcomeRecord[],
        signalCount: number,
    ): CrossSystemKpis {
        return {
            totalSignalsIngested: signalCount,
            totalClustersFormed: clusters.length,
            totalRootCausesGenerated: rootCauses.length,
            totalStrategiesSelected: decisions.length,
            totalSucceeded: outcomes.filter(o => o.succeeded).length,
            totalRecurred: outcomes.filter(o => o.recurred).length,
            openClusterCount: clusters.filter(c => c.status === 'open').length,
        };
    }

    /**
     * Produces a lightweight hash of the dashboard state for deduplication.
     * Hashes the shape of open clusters and KPI values — not the full state.
     */
    private _stateHash(state: CrossSystemDashboardState): string {
        const sig = [
            state.kpis.openClusterCount,
            state.kpis.totalClustersFormed,
            state.kpis.totalStrategiesSelected,
            state.kpis.totalSucceeded,
            state.signalWindowCount,
            state.openClusters.map(c => `${c.clusterId}:${c.signalCount}:${c.status}`).join(','),
        ].join('|');

        let h = 0x811c9dc5;
        for (let i = 0; i < sig.length; i++) {
            h ^= sig.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16);
    }
}
