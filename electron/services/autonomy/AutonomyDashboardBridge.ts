/**
 * AutonomyDashboardBridge.ts — Phase 4 P4G
 *
 * Milestone-gated IPC push for the Autonomy Dashboard.
 *
 * Mirrors PlanningDashboardBridge (Phase 2 P2H) and ExecutionDashboardBridge (Phase 3 P3I):
 * 1. Milestone-gated emit — only permitted milestones trigger a push.
 * 2. Deduplication — identical consecutive states are not re-emitted.
 * 3. Telemetry stream — live autonomy telemetry events pushed separately.
 *
 * IPC channels:
 *   autonomy:dashboardUpdate  — full AutonomyDashboardState
 *   autonomy:telemetry        — individual AutonomyTelemetryEvent
 */

import { BrowserWindow } from 'electron';
import type {
    AutonomousRun,
    AutonomousGoal,
    AutonomyDashboardState,
    AutonomyDashboardKpis,
    AutonomyTelemetryEvent,
    LearningRecord,
    AutonomyBudget,
    AutonomousRunMilestoneName,
    AutonomousRunStatus,
} from '../../../shared/autonomyTypes';
import type { AutonomyPolicy } from '../../../shared/autonomyTypes';
import { telemetry } from '../TelemetryService';

// ─── IPC channel names ────────────────────────────────────────────────────────

export const AUTONOMY_DASHBOARD_CHANNEL = 'autonomy:dashboardUpdate';
export const AUTONOMY_TELEMETRY_CHANNEL = 'autonomy:telemetry';

// ─── Permitted dashboard-push milestones ─────────────────────────────────────

const DASHBOARD_MILESTONES = new Set<AutonomousRunMilestoneName>([
    'run_started',
    'governance_resolved',
    'execution_started',
    'execution_completed',
    'outcome_recorded',
    'run_completed',
    'run_failed',
    'run_aborted',
]);

const TERMINAL_RUN_STATUSES = new Set<AutonomousRunStatus>([
    'succeeded',
    'failed',
    'rolled_back',
    'policy_blocked',
    'governance_blocked',
    'aborted',
    'budget_exhausted',
]);

// ─── AutonomyDashboardBridge ──────────────────────────────────────────────────

export class AutonomyDashboardBridge {
    private lastEmitHash: string | null = null;

    /**
     * Emits a dashboard update if the milestone is permitted.
     * No per-run budget — dashboard updates are milestone-gated, not budget-gated.
     */
    maybeEmit(
        milestone: AutonomousRunMilestoneName,
        allRuns: AutonomousRun[],
        allGoals: AutonomousGoal[],
        learningRecords: LearningRecord[],
        recentTelemetry: AutonomyTelemetryEvent[],
        policy: AutonomyPolicy,
        budgetUsedThisPeriod: number,
    ): boolean {
        if (!DASHBOARD_MILESTONES.has(milestone)) return false;

        const state = this._buildState(
            allRuns, allGoals, learningRecords, recentTelemetry, policy, budgetUsedThisPeriod,
        );

        const hash = this._stateHash(state);
        if (hash === this.lastEmitHash) return false;
        this.lastEmitHash = hash;

        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send(AUTONOMY_DASHBOARD_CHANNEL, state);
            }
        }

        telemetry.operational(
            'autonomy',
            'operational',
            'debug',
            'AutonomyDashboardBridge',
            `Dashboard update emitted at milestone '${milestone}'`,
        );

        return true;
    }

    /**
     * Pushes the full dashboard state unconditionally (used for IPC handler responses).
     */
    emitFull(
        allRuns: AutonomousRun[],
        allGoals: AutonomousGoal[],
        learningRecords: LearningRecord[],
        recentTelemetry: AutonomyTelemetryEvent[],
        policy: AutonomyPolicy,
        budgetUsedThisPeriod: number,
    ): AutonomyDashboardState {
        const state = this._buildState(
            allRuns, allGoals, learningRecords, recentTelemetry, policy, budgetUsedThisPeriod,
        );
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send(AUTONOMY_DASHBOARD_CHANNEL, state);
            }
        }
        return state;
    }

    /**
     * Pushes a single telemetry event to the renderer.
     * Not milestone-gated — used for live streaming.
     */
    pushTelemetryEvent(event: AutonomyTelemetryEvent): void {
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send(AUTONOMY_TELEMETRY_CHANNEL, event);
            }
        }
    }

    resetDedupHash(): void {
        this.lastEmitHash = null;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _buildState(
        allRuns: AutonomousRun[],
        allGoals: AutonomousGoal[],
        learningRecords: LearningRecord[],
        recentTelemetry: AutonomyTelemetryEvent[],
        policy: AutonomyPolicy,
        budgetUsedThisPeriod: number,
    ): AutonomyDashboardState {
        const activeRuns = allRuns.filter(r => !TERMINAL_RUN_STATUSES.has(r.status));
        const pendingGoals = allGoals.filter(
            g => g.status === 'scored' || g.status === 'selected' || g.status === 'policy_approved',
        );
        const blockedGoals = allGoals.filter(
            g => g.status === 'policy_blocked' || g.status === 'governance_blocked' || g.humanReviewRequired,
        );
        const recentRuns = allRuns.slice(0, 20);

        return {
            kpis: this._computeKpis(allRuns, allGoals),
            activeRuns,
            pendingGoals,
            blockedGoals,
            recentRuns,
            recentTelemetry: recentTelemetry.slice(-50),
            learningRecords: learningRecords.slice(0, 20),
            budget: policy.budget,
            budgetUsedThisPeriod,
            globalAutonomyEnabled: policy.globalAutonomyEnabled,
            lastUpdatedAt: new Date().toISOString(),
        };
    }

    private _computeKpis(
        runs: AutonomousRun[],
        goals: AutonomousGoal[],
    ): AutonomyDashboardKpis {
        return {
            totalGoalsDetected: goals.length,
            totalRunsStarted: runs.length,
            totalRunsSucceeded: runs.filter(r => r.status === 'succeeded').length,
            totalRunsFailed: runs.filter(r => r.status === 'failed').length,
            totalRunsRolledBack: runs.filter(r => r.status === 'rolled_back').length,
            totalPolicyBlocked: goals.filter(g => g.status === 'policy_blocked').length,
            totalGovernanceBlocked: runs.filter(r => r.status === 'governance_blocked').length,
            totalSuppressed: goals.filter(g => g.status === 'suppressed').length,
            activeRuns: runs.filter(r => !TERMINAL_RUN_STATUSES.has(r.status)).length,
            pendingGoals: goals.filter(
                g => g.status === 'scored' || g.status === 'selected',
            ).length,
        };
    }

    private _stateHash(state: AutonomyDashboardState): string {
        const sig = `${state.kpis.totalRunsStarted}:${state.kpis.totalRunsSucceeded}:` +
            `${state.kpis.activeRuns}:${state.activeRuns.map(r => r.status).join(',')}`;
        let h = 0x811c9dc5;
        for (let i = 0; i < sig.length; i++) {
            h ^= sig.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16);
    }
}
