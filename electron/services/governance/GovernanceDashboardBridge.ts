/**
 * GovernanceDashboardBridge.ts — Phase 3.5 P3.5H
 *
 * Milestone-gated IPC push for governance dashboard state.
 *
 * Mirrors ExecutionDashboardBridge (Phase 3 P3I):
 * 1. Milestone-gated emit — only permitted events trigger a push.
 * 2. Deduplication — identical consecutive states are not re-emitted.
 *
 * IPC channels:
 *   governance:dashboardUpdate  — full GovernanceDashboardState
 */

import { BrowserWindow } from 'electron';
import type {
    GovernanceDashboardState,
} from '../../../shared/governanceTypes';
import { telemetry } from '../TelemetryService';

// ─── Permitted milestone event names ─────────────────────────────────────────

export type GovernanceMilestoneName =
    | 'decision_created'
    | 'approval_recorded'
    | 'rejection_recorded'
    | 'deferral_recorded'
    | 'self_authorization_applied'
    | 'confirmation_satisfied'
    | 'escalation_triggered'
    | 'execution_authorized'
    | 'decision_expired';

export const GOVERNANCE_DASHBOARD_CHANNEL = 'governance:dashboardUpdate';

const DASHBOARD_MILESTONES = new Set<GovernanceMilestoneName>([
    'decision_created',
    'approval_recorded',
    'rejection_recorded',
    'deferral_recorded',
    'self_authorization_applied',
    'confirmation_satisfied',
    'escalation_triggered',
    'execution_authorized',
    'decision_expired',
]);

// ─── GovernanceDashboardBridge ────────────────────────────────────────────────

export class GovernanceDashboardBridge {
    private lastEmitHash: string | null = null;

    /**
     * Emits a governance dashboard update if the milestone is permitted
     * and the state has changed since the last emission.
     */
    maybeEmit(milestone: GovernanceMilestoneName, state: GovernanceDashboardState): boolean {
        if (!DASHBOARD_MILESTONES.has(milestone)) return false;

        const stateHash = JSON.stringify(state);
        if (stateHash === this.lastEmitHash) return false;
        this.lastEmitHash = stateHash;

        const windows = BrowserWindow.getAllWindows();
        if (windows.length === 0) return false;

        for (const win of windows) {
            try {
                win.webContents.send(GOVERNANCE_DASHBOARD_CHANNEL, state);
            } catch {
                // Window may have been closed — non-fatal
            }
        }

        telemetry.operational(
            'governance',
            'governance.dashboard.emitted',
            'debug',
            'GovernanceDashboardBridge',
            `Dashboard update emitted on milestone: ${milestone}`,
        );

        return true;
    }
}
