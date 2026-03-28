/**
 * PlanningDashboardBridge.ts — Phase 2 P2H
 *
 * Throttled Reflection Dashboard Integration.
 *
 * Dashboard updates are emitted ONLY at milestone boundaries:
 *   run_started | snapshot_ready | proposal_created |
 *   proposal_classified | run_complete | run_failed
 *
 * Internal pipeline steps MUST NOT trigger dashboard pushes.
 * The bridge enforces this via:
 *   1. Milestone-gated emit — callers pass a milestone name, and the
 *      bridge checks it against the list of permitted update points.
 *   2. Budget tracking — each push counts against the run's
 *      `maxDashboardUpdates` budget.
 *   3. Deduplication — identical consecutive states are not re-emitted.
 *
 * Transport: IPC push via BrowserWindow.webContents.send().
 */

import { BrowserWindow } from 'electron';
import type {
    PlanRun,
    PlanRunMilestone,
    SafeChangeProposal,
    PlanningDashboardState,
    PlanningDashboardKpis,
    PlanningPipelineState,
} from '../../../shared/reflectionPlanTypes';
import { telemetry } from '../TelemetryService';

// ─── IPC channel names ────────────────────────────────────────────────────────

export const PLANNING_DASHBOARD_CHANNEL = 'planning:dashboardUpdate';
export const PLANNING_PROPOSAL_CREATED_CHANNEL = 'planning:proposalCreated';

// ─── Permitted milestone names for dashboard push ─────────────────────────────

const DASHBOARD_MILESTONES = new Set<PlanRunMilestone['name']>([
    'run_started',
    'snapshot_ready',
    'proposal_created',
    'proposal_classified',
    'run_complete',
    'run_failed',
]);

// ─── PlanningDashboardBridge ──────────────────────────────────────────────────

export class PlanningDashboardBridge {
    /** Fingerprint of last emitted state to suppress redundant pushes. */
    private lastEmitHash: string | null = null;

    /**
     * Emits a dashboard update if the given milestone is a permitted
     * push point and the budget allows it.
     *
     * @param milestone  The milestone that just completed.
     * @param activeRun  The current planning run.
     * @param allRuns    All recent runs (for KPI computation).
     * @param proposals  Proposals produced so far.
     * @param budgetUsed Number of dashboard updates already used this run.
     * @param maxUpdates Dashboard update budget for this run.
     */
    maybeEmit(
        milestone: PlanRunMilestone['name'],
        activeRun: PlanRun,
        allRuns: PlanRun[],
        proposals: SafeChangeProposal[],
        budgetUsed: number,
        maxUpdates: number,
    ): boolean {
        // Gate 1: only permitted milestones trigger a push
        if (!DASHBOARD_MILESTONES.has(milestone)) {
            return false;
        }

        // Gate 2: respect dashboard update budget
        if (budgetUsed >= maxUpdates) {
            telemetry.operational(
                'planning',
                'planning.dashboard.budget_suppressed',
                'debug',
                'PlanningDashboardBridge',
                `Run ${activeRun.runId}: dashboard update suppressed — budget exhausted`,
            );
            return false;
        }

        const state = this._buildState(activeRun, allRuns, proposals);

        // Gate 3: suppress duplicate consecutive states
        const hash = this._stateHash(state);
        if (hash === this.lastEmitHash) {
            return false;
        }
        this.lastEmitHash = hash;

        // Emit to all focused windows
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send(PLANNING_DASHBOARD_CHANNEL, state);
            }
        }

        // If a proposal was just created, also emit the targeted event
        if (milestone === 'proposal_created') {
            const latest = proposals[proposals.length - 1];
            if (latest) {
                for (const win of windows) {
                    if (!win.isDestroyed()) {
                        win.webContents.send(PLANNING_PROPOSAL_CREATED_CHANNEL, latest);
                    }
                }
            }
        }

        telemetry.operational(
            'planning',
            `planning.dashboard.emitted.${milestone}`,
            'debug',
            'PlanningDashboardBridge',
            `Run ${activeRun.runId}: dashboard update emitted at milestone '${milestone}'`,
        );

        return true;
    }

    /** Resets the dedup hash (e.g., on renderer reload). */
    resetDedupHash(): void {
        this.lastEmitHash = null;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _buildState(
        activeRun: PlanRun,
        allRuns: PlanRun[],
        proposals: SafeChangeProposal[],
    ): PlanningDashboardState {
        const kpis = this._computeKpis(allRuns, proposals);
        const pipeline = this._buildPipelineState(activeRun, allRuns, proposals);

        return {
            kpis,
            pipeline,
            recentProposals: proposals.slice(-10),
            lastUpdatedAt: new Date().toISOString(),
        };
    }

    private _computeKpis(
        allRuns: PlanRun[],
        proposals: SafeChangeProposal[],
    ): PlanningDashboardKpis {
        const totalRuns = allRuns.length;
        const promoted = proposals.filter(p => p.status === 'promoted').length;
        const successRate = proposals.length > 0 ? promoted / proposals.length : 0;
        const activeRuns = allRuns.filter(
            r => r.status === 'running' || r.status === 'pending',
        ).length;
        const proposalsReady = proposals.filter(
            p => p.status === 'classified' || p.status === 'approved',
        ).length;
        const budgetExhaustedRuns = allRuns.filter(r => r.status === 'budget_exhausted').length;
        const dedupedRuns = allRuns.filter(r => r.status === 'deduped').length;
        const cooldownBlockedRuns = allRuns.filter(r => r.status === 'cooldown_blocked').length;

        return {
            totalRuns,
            totalProposals: proposals.length,
            promotedProposals: promoted,
            successRate: Math.round(successRate * 100) / 100,
            activeRuns,
            proposalsReady,
            budgetExhaustedRuns,
            dedupedRuns,
            cooldownBlockedRuns,
        };
    }

    private _buildPipelineState(
        activeRun: PlanRun,
        allRuns: PlanRun[],
        proposals: SafeChangeProposal[],
    ): PlanningPipelineState {
        const isActive =
            activeRun.status === 'running' || activeRun.status === 'pending';
        const lastMilestone =
            activeRun.milestones.length > 0
                ? activeRun.milestones[activeRun.milestones.length - 1]
                : undefined;

        const startedAt = activeRun.milestones.find(m => m.name === 'run_started')?.timestamp;
        const elapsedMs = startedAt ? Date.now() - new Date(startedAt).getTime() : undefined;

        return {
            isActive,
            currentRunId: activeRun.runId,
            currentSubsystem: activeRun.subsystemId,
            startedAt,
            elapsedMs,
            lastMilestone: lastMilestone?.name,
            lastMilestoneAt: lastMilestone?.timestamp,
            pendingProposals: proposals.filter(p => p.status === 'draft').length,
            recentRuns: allRuns.slice(0, 5).map(r => ({
                runId: r.runId,
                status: r.status,
                subsystemId: r.subsystemId,
                completedAt: r.milestones.find(m => m.name === 'run_complete')?.timestamp,
            })),
        };
    }

    private _stateHash(state: PlanningDashboardState): string {
        // Lightweight fingerprint — not cryptographic
        const sig = `${state.kpis.totalRuns}:${state.kpis.totalProposals}:` +
            `${state.pipeline.currentRunId}:${state.pipeline.lastMilestone}`;
        let h = 0x811c9dc5;
        for (let i = 0; i < sig.length; i++) {
            h ^= sig.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16);
    }
}
