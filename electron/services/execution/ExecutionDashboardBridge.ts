/**
 * ExecutionDashboardBridge.ts — Phase 3 P3I
 *
 * Milestone-gated IPC push for the Execution Dashboard.
 *
 * Mirrors PlanningDashboardBridge (Phase 2 P2H):
 * 1. Milestone-gated emit — only permitted milestones trigger a push.
 * 2. Budget tracking — each push counts against maxDashboardUpdates.
 * 3. Deduplication — identical consecutive states are not re-emitted.
 *
 * IPC channels:
 *   execution:dashboardUpdate  — full ExecutionDashboardState
 *   execution:telemetry        — individual ExecutionTelemetryEvent
 */

import { BrowserWindow } from 'electron';
import type {
    ExecutionRun,
    ExecutionMilestoneName,
    ExecutionDashboardState,
    ExecutionDashboardKpis,
    ExecutionTelemetryEvent,
    ExecutionStatus,
} from '../../../shared/executionTypes';
import { telemetry } from '../TelemetryService';

// ─── IPC channel names ────────────────────────────────────────────────────────

export const EXECUTION_DASHBOARD_CHANNEL = 'execution:dashboardUpdate';
export const EXECUTION_TELEMETRY_CHANNEL = 'execution:telemetry';

// ─── Permitted milestones ─────────────────────────────────────────────────────

const DASHBOARD_MILESTONES = new Set<ExecutionMilestoneName>([
    'execution_created',
    'eligibility_passed',
    'snapshot_ready',
    'patch_plan_ready',
    'dry_run_complete',
    'apply_complete',
    'verification_complete',
    'rollback_complete',
    'outcome_recorded',
]);

const TERMINAL_STATUSES = new Set<ExecutionStatus>([
    'succeeded',
    'rolled_back',
    'aborted',
    'execution_blocked',
]);

// ─── ExecutionDashboardBridge ─────────────────────────────────────────────────

export class ExecutionDashboardBridge {
    private lastEmitHash: string | null = null;

    /**
     * Emits a dashboard update if the milestone is permitted and budget allows.
     */
    maybeEmit(
        milestone: ExecutionMilestoneName,
        activeRun: ExecutionRun,
        allRuns: ExecutionRun[],
        promotedProposalsReady: number,
        budgetUsed: number,
        maxUpdates: number,
    ): boolean {
        if (!DASHBOARD_MILESTONES.has(milestone)) return false;

        if (budgetUsed >= maxUpdates) {
            telemetry.operational(
                'execution',
                'execution.dashboard.budget_suppressed',
                'debug',
                'ExecutionDashboardBridge',
                `Run ${activeRun.executionId}: dashboard update suppressed — budget exhausted`,
            );
            return false;
        }

        const state = this._buildState(activeRun, allRuns, promotedProposalsReady);
        const hash = this._stateHash(state);
        if (hash === this.lastEmitHash) return false;
        this.lastEmitHash = hash;

        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send(EXECUTION_DASHBOARD_CHANNEL, state);
            }
        }

        telemetry.operational(
            'execution',
            `execution.dashboard.emitted.${milestone}`,
            'debug',
            'ExecutionDashboardBridge',
            `Dashboard update emitted at milestone '${milestone}' for ${activeRun.executionId}`,
        );

        return true;
    }

    /**
     * Pushes a single telemetry event to the renderer.
     * Not milestone-gated — used for live streaming.
     */
    pushTelemetryEvent(event: ExecutionTelemetryEvent): void {
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send(EXECUTION_TELEMETRY_CHANNEL, event);
            }
        }
    }

    resetDedupHash(): void {
        this.lastEmitHash = null;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _buildState(
        activeRun: ExecutionRun,
        allRuns: ExecutionRun[],
        promotedProposalsReady: number,
    ): ExecutionDashboardState {
        return {
            kpis: this._computeKpis(allRuns),
            activeRun: TERMINAL_STATUSES.has(activeRun.status) ? undefined : activeRun,
            recentRuns: allRuns.slice(0, 10),
            promotedProposalsReady,
            lastUpdatedAt: new Date().toISOString(),
        };
    }

    private _computeKpis(allRuns: ExecutionRun[]): ExecutionDashboardKpis {
        const total = allRuns.length;
        const succeeded = allRuns.filter(r => r.status === 'succeeded').length;
        const failedVerification = allRuns.filter(r => r.status === 'failed_verification').length;
        const rolledBack = allRuns.filter(r => r.status === 'rolled_back').length;
        const aborted = allRuns.filter(r => r.status === 'aborted').length;
        const active = allRuns.filter(r => !TERMINAL_STATUSES.has(r.status) && r.status !== 'execution_blocked').length;
        const successRate = total > 0 ? Math.round((succeeded / total) * 100) / 100 : 0;

        return { totalExecutions: total, succeeded, failedVerification, rolledBack, aborted, activeExecutions: active, successRate };
    }

    private _stateHash(state: ExecutionDashboardState): string {
        const sig = `${state.kpis.totalExecutions}:${state.kpis.succeeded}:` +
            `${state.activeRun?.executionId ?? 'none'}:${state.activeRun?.status ?? 'none'}`;
        let h = 0x811c9dc5;
        for (let i = 0; i < sig.length; i++) {
            h ^= sig.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16);
    }
}
