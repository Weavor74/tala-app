/**
 * HarmonizationDashboardBridge.ts — Phase 5.6 P5.6H
 *
 * Milestone-gated IPC push for the Harmonization Dashboard.
 *
 * Mirrors CampaignDashboardBridge (Phase 5.5 P5.5H) exactly:
 * 1. Hash deduplication — identical consecutive states not re-emitted.
 * 2. emitFull() for on-demand IPC handler responses.
 * 3. emit() for milestone-triggered pushes.
 *
 * IPC channel:
 *   harmonization:dashboardUpdate — full HarmonizationDashboardState
 */

import { BrowserWindow } from 'electron';
import type {
    HarmonizationCampaign,
    HarmonizationDriftRecord,
    HarmonizationOutcomeRecord,
    HarmonizationDashboardState,
    HarmonizationDashboardKpis,
    HarmonizationRuleConfidenceSummary,
    HarmonizationCanonRule,
} from '../../../../shared/harmonizationTypes';
import { telemetry } from '../../TelemetryService';

// ─── IPC channel ──────────────────────────────────────────────────────────────

export const HARMONIZATION_DASHBOARD_CHANNEL = 'harmonization:dashboardUpdate';

// ─── Display limits ───────────────────────────────────────────────────────────

const MAX_RECENT_OUTCOMES = 20;
const MAX_PENDING_DRIFT = 50;

// ─── HarmonizationDashboardBridge ────────────────────────────────────────────

export class HarmonizationDashboardBridge {
    private lastEmitHash: string | null = null;

    /**
     * Builds and conditionally emits a dashboard update.
     * Deduplicates identical consecutive states.
     */
    emit(payload: {
        pendingDriftRecords: HarmonizationDriftRecord[];
        activeCampaigns: HarmonizationCampaign[];
        deferredCampaigns: HarmonizationCampaign[];
        recentOutcomes: HarmonizationOutcomeRecord[];
        canonRules: HarmonizationCanonRule[];
    }): boolean {
        const state = this.buildState(
            payload.pendingDriftRecords,
            payload.activeCampaigns,
            payload.deferredCampaigns,
            payload.recentOutcomes,
            payload.canonRules,
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
        pendingDriftRecords: HarmonizationDriftRecord[],
        activeCampaigns: HarmonizationCampaign[],
        deferredCampaigns: HarmonizationCampaign[],
        recentOutcomes: HarmonizationOutcomeRecord[],
        canonRules: HarmonizationCanonRule[],
    ): HarmonizationDashboardState {
        const state = this.buildState(
            pendingDriftRecords,
            activeCampaigns,
            deferredCampaigns,
            recentOutcomes,
            canonRules,
        );
        this._sendToWindows(state);
        return state;
    }

    /**
     * Builds a HarmonizationDashboardState without emitting.
     */
    buildState(
        pendingDriftRecords: HarmonizationDriftRecord[],
        activeCampaigns: HarmonizationCampaign[],
        deferredCampaigns: HarmonizationCampaign[],
        recentOutcomes: HarmonizationOutcomeRecord[],
        canonRules: HarmonizationCanonRule[],
    ): HarmonizationDashboardState {
        const cappedDrift = pendingDriftRecords.slice(0, MAX_PENDING_DRIFT);
        const cappedOutcomes = recentOutcomes.slice(0, MAX_RECENT_OUTCOMES);

        const allOutcomes = recentOutcomes;
        const kpis = this._computeKpis(activeCampaigns, allOutcomes, canonRules);
        const ruleSummaries = this._buildRuleSummaries(canonRules);

        return {
            computedAt: new Date().toISOString(),
            kpis,
            pendingDriftRecords: cappedDrift,
            activeCampaigns,
            deferredCampaigns,
            recentOutcomes: cappedOutcomes,
            canonRuleSummaries: ruleSummaries,
        };
    }

    // ─── Private helpers ───────────────────────────────────────────────────────

    private _computeKpis(
        activeCampaigns: HarmonizationCampaign[],
        outcomes: HarmonizationOutcomeRecord[],
        canonRules: HarmonizationCanonRule[],
    ): HarmonizationDashboardKpis {
        return {
            totalDriftDetected: outcomes.length + activeCampaigns.length,
            totalMatched: outcomes.length + activeCampaigns.length,
            totalCampaignsLaunched: outcomes.length + activeCampaigns.length,
            totalSucceeded: outcomes.filter(o => o.succeeded).length,
            totalFailed: outcomes.filter(o => o.finalStatus === 'failed').length,
            totalRolledBack: outcomes.filter(o => o.rollbackTriggered).length,
            totalDeferred: outcomes.filter(o => o.finalStatus === 'deferred').length,
            totalSkipped: outcomes.filter(o => o.finalStatus === 'skipped').length,
            activeCampaigns: activeCampaigns.length,
            avgConfidenceAcrossRules: this._avgConfidence(canonRules),
        };
    }

    private _buildRuleSummaries(rules: HarmonizationCanonRule[]): HarmonizationRuleConfidenceSummary[] {
        return rules.map(r => ({
            ruleId: r.ruleId,
            label: r.label,
            patternClass: r.patternClass,
            confidenceCurrent: r.confidenceCurrent,
            status: r.status,
            successCount: r.successCount,
            failureCount: r.failureCount,
            regressionCount: r.regressionCount,
        }));
    }

    private _avgConfidence(rules: HarmonizationCanonRule[]): number {
        if (rules.length === 0) return 0;
        const sum = rules.reduce((acc, r) => acc + r.confidenceCurrent, 0);
        return Math.round((sum / rules.length) * 1000) / 1000;
    }

    private _stateHash(state: HarmonizationDashboardState): string {
        return JSON.stringify({
            activeCampaignIds: state.activeCampaigns.map(c => `${c.campaignId}:${c.status}:${c.currentFileIndex}`),
            deferredCampaignIds: state.deferredCampaigns.map(c => c.campaignId),
            pendingDriftIds: state.pendingDriftRecords.map(d => d.driftId),
            recentOutcomeIds: state.recentOutcomes.map(o => o.outcomeId),
            kpis: state.kpis,
        });
    }

    private _sendToWindows(state: HarmonizationDashboardState): void {
        try {
            const windows = BrowserWindow.getAllWindows();
            for (const win of windows) {
                if (!win.isDestroyed()) {
                    win.webContents.send(HARMONIZATION_DASHBOARD_CHANNEL, state);
                }
            }
            telemetry.operational(
                'autonomy',
                'harmonization.dashboard.emitted',
                'debug',
                'HarmonizationDashboardBridge',
                `Dashboard update sent to ${windows.length} window(s)`,
            );
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'HarmonizationDashboardBridge',
                `Failed to send dashboard update: ${err.message}`,
            );
        }
    }
}
