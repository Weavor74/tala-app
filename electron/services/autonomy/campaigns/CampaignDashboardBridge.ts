/**
 * CampaignDashboardBridge.ts — Phase 5.5 P5.5H
 *
 * Milestone-gated IPC push for the Campaign Dashboard.
 *
 * Mirrors AutonomyDashboardBridge (Phase 4 P4G):
 * 1. Simple hash deduplication — identical consecutive states are not re-emitted.
 * 2. emitFull() for on-demand IPC handler responses.
 * 3. emit() for milestone-triggered pushes from the coordinator.
 *
 * IPC channels:
 *   campaign:dashboardUpdate  — full CampaignDashboardState
 */

import { BrowserWindow } from 'electron';
import type {
    RepairCampaign,
    CampaignOutcomeSummary,
    CampaignDashboardState,
    CampaignDashboardKpis,
} from '../../../../shared/repairCampaignTypes';
import { telemetry } from '../../TelemetryService';

// ─── IPC channel name ─────────────────────────────────────────────────────────

export const CAMPAIGN_DASHBOARD_CHANNEL = 'campaign:dashboardUpdate';

// ─── Display limits ───────────────────────────────────────────────────────────

const MAX_RECENT_OUTCOMES = 20;

// ─── CampaignDashboardBridge ──────────────────────────────────────────────────

export class CampaignDashboardBridge {
    private lastEmitHash: string | null = null;

    /**
     * Builds and conditionally emits a dashboard update.
     * Deduplicates identical consecutive states.
     */
    emit(payload: {
        activeCampaigns: RepairCampaign[];
        deferredCampaigns: RepairCampaign[];
        recentOutcomes: CampaignOutcomeSummary[];
    }): boolean {
        const state = this.buildState(
            payload.activeCampaigns,
            payload.deferredCampaigns,
            payload.recentOutcomes,
        );
        const hash = this._stateHash(state);
        if (hash === this.lastEmitHash) return false;
        this.lastEmitHash = hash;
        this._sendToWindows(state);
        return true;
    }

    /**
     * Builds and emits the full state unconditionally (for IPC handler responses).
     */
    emitFull(
        activeCampaigns: RepairCampaign[],
        deferredCampaigns: RepairCampaign[],
        recentOutcomes: CampaignOutcomeSummary[],
    ): CampaignDashboardState {
        const state = this.buildState(activeCampaigns, deferredCampaigns, recentOutcomes);
        this._sendToWindows(state);
        return state;
    }

    /**
     * Builds a CampaignDashboardState without emitting it.
     * Used by RepairCampaignCoordinator to produce state for IPC handlers.
     */
    buildState(
        activeCampaigns: RepairCampaign[],
        deferredCampaigns: RepairCampaign[],
        recentOutcomes: CampaignOutcomeSummary[],
    ): CampaignDashboardState {
        const allOutcomes = recentOutcomes.slice(0, MAX_RECENT_OUTCOMES);

        return {
            computedAt: new Date().toISOString(),
            kpis: this._computeKpis(activeCampaigns, deferredCampaigns, allOutcomes),
            activeCampaigns,
            deferredCampaigns,
            recentOutcomes: allOutcomes,
        };
    }

    resetDedupHash(): void {
        this.lastEmitHash = null;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _computeKpis(
        activeCampaigns: RepairCampaign[],
        deferredCampaigns: RepairCampaign[],
        recentOutcomes: CampaignOutcomeSummary[],
    ): CampaignDashboardKpis {
        const total = recentOutcomes.length;
        const succeeded = recentOutcomes.filter(o => o.succeeded).length;
        const failed = recentOutcomes.filter(o => o.finalStatus === 'failed' || o.finalStatus === 'aborted').length;
        const rolledBack = recentOutcomes.filter(o => o.rolledBack).length;
        const deferred = recentOutcomes.filter(o => o.deferred).length;
        const aborted = recentOutcomes.filter(o => o.finalStatus === 'aborted').length;

        const avgSteps = total > 0
            ? Math.round(recentOutcomes.reduce((s, o) => s + o.stepCount, 0) / total * 10) / 10
            : 0;
        const avgRollback = total > 0
            ? Math.round(recentOutcomes.reduce((s, o) => s + o.rollbackFrequency, 0) / total * 100) / 100
            : 0;

        return {
            totalLaunched: total,
            totalSucceeded: succeeded,
            totalFailed: failed,
            totalRolledBack: rolledBack,
            totalDeferred: deferred,
            totalAborted: aborted,
            activeCampaigns: activeCampaigns.length,
            avgStepsPerCampaign: avgSteps,
            avgRollbackFrequency: avgRollback,
        };
    }

    private _sendToWindows(state: CampaignDashboardState): void {
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send(CAMPAIGN_DASHBOARD_CHANNEL, state);
            }
        }
        telemetry.operational(
            'autonomy',
            'operational',
            'debug',
            'CampaignDashboardBridge',
            `Campaign dashboard update emitted (active=${state.activeCampaigns.length}, ` +
            `deferred=${state.deferredCampaigns.length})`,
        );
    }

    private _stateHash(state: CampaignDashboardState): string {
        const sig = `${state.kpis.activeCampaigns}:${state.kpis.totalLaunched}:` +
            `${state.activeCampaigns.map(c => `${c.campaignId}:${c.status}:${c.currentStepIndex}`).join(',')}`;
        let h = 0x811c9dc5;
        for (let i = 0; i < sig.length; i++) {
            h ^= sig.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16);
    }
}
