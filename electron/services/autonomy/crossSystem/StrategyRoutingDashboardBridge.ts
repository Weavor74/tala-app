/**
 * StrategyRoutingDashboardBridge.ts — Phase 6.1 P6.1G
 *
 * Milestone-gated IPC push for the Strategy Routing Dashboard.
 *
 * Mirrors CrossSystemDashboardBridge (Phase 6 P6H):
 * 1. Milestone-gated emit — only permitted milestones trigger a push.
 * 2. Deduplication — identical consecutive states are not re-emitted.
 *
 * IPC channel:
 *   strategyRouting:dashboardUpdate — full StrategyRoutingDashboardState
 */

import { BrowserWindow } from 'electron';
import type {
    StrategyRoutingDashboardState,
    StrategyRoutingDecision,
    StrategyRoutingOutcomeRecord,
    StrategyRoutingKpis,
    RoutedActionReference,
} from '../../../../shared/strategyRoutingTypes';
import { telemetry } from '../../TelemetryService';

// ─── IPC channel name ─────────────────────────────────────────────────────────

export const STRATEGY_ROUTING_DASHBOARD_CHANNEL = 'strategyRouting:dashboardUpdate';

// ─── Permitted dashboard-push milestones ─────────────────────────────────────

const DASHBOARD_MILESTONES = new Set<string>([
    'routing_evaluated',
    'routing_blocked',
    'routing_routed',
    'routing_deferred',
    'routing_human_review',
    'outcome_recorded',
]);

// ─── StrategyRoutingDashboardBridge ──────────────────────────────────────────

export class StrategyRoutingDashboardBridge {
    private lastEmitHash: string | null = null;

    /**
     * Emits a dashboard update if the milestone is in the permitted set.
     * Deduplicates consecutive identical states — returns false if suppressed.
     */
    maybeEmit(milestone: string, state: StrategyRoutingDashboardState): boolean {
        if (!DASHBOARD_MILESTONES.has(milestone)) return false;

        const hash = this._stateHash(state);
        if (hash === this.lastEmitHash) return false;
        this.lastEmitHash = hash;

        this._broadcast(state);

        telemetry.operational(
            'autonomy',
            'operational',
            'debug',
            'StrategyRoutingDashboardBridge',
            `Dashboard update emitted at milestone '${milestone}' ` +
            `(decisions=${state.routingDecisions.length}, ` +
            `humanReview=${state.humanReviewItems.length})`,
        );

        return true;
    }

    /**
     * Builds a StrategyRoutingDashboardState from raw engine outputs.
     */
    buildState(
        decisions: StrategyRoutingDecision[],
        outcomes: StrategyRoutingOutcomeRecord[],
        trustScore: number,
    ): StrategyRoutingDashboardState {
        const blocked = decisions.filter(d => d.status === 'blocked');
        const deferred = decisions.filter(d => d.status === 'deferred');
        const humanReview = decisions.filter(d => d.status === 'human_review');
        const activeRefs: RoutedActionReference[] = decisions
            .filter(d => d.routedActionRef &&
                (d.routedActionRef.status === 'pending' || d.routedActionRef.status === 'active'))
            .map(d => d.routedActionRef!);

        const recentOutcomes = [...outcomes]
            .sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime())
            .slice(0, 20);

        const kpis = this._computeKpis(decisions, outcomes, trustScore);

        return {
            routingDecisions: [...decisions],
            blockedDecisions: blocked,
            deferredDecisions: deferred,
            humanReviewItems: humanReview,
            activeRoutedActions: activeRefs,
            recentOutcomes,
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

    private _broadcast(state: StrategyRoutingDashboardState): void {
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send(STRATEGY_ROUTING_DASHBOARD_CHANNEL, state);
            }
        }
    }

    private _computeKpis(
        decisions: StrategyRoutingDecision[],
        outcomes: StrategyRoutingOutcomeRecord[],
        trustScore: number,
    ): StrategyRoutingKpis {
        return {
            totalDecisionsEvaluated: decisions.length,
            totalRoutedToGoal: decisions.filter(d => d.routingTargetType === 'autonomous_goal').length,
            totalRoutedToRepairCampaign: decisions.filter(d => d.routingTargetType === 'repair_campaign').length,
            totalRoutedToHarmonizationCampaign: decisions.filter(d => d.routingTargetType === 'harmonization_campaign').length,
            totalRoutedToHumanReview: decisions.filter(d => d.routingTargetType === 'human_review').length,
            totalDeferred: decisions.filter(d => d.status === 'deferred').length,
            totalBlocked: decisions.filter(d => d.status === 'blocked').length,
            totalOutcomesRecorded: outcomes.length,
            totalRoutingsCorrect: outcomes.filter(o => o.routingCorrect === true).length,
            overallTrustScore: trustScore,
        };
    }

    /**
     * Produces a lightweight hash of the dashboard state for deduplication.
     */
    private _stateHash(state: StrategyRoutingDashboardState): string {
        const sig = [
            state.kpis.totalDecisionsEvaluated,
            state.kpis.totalRoutedToGoal,
            state.kpis.totalBlocked,
            state.kpis.totalDeferred,
            state.kpis.totalRoutedToHumanReview,
            state.kpis.totalOutcomesRecorded,
            state.humanReviewItems.length,
            state.activeRoutedActions.map(r => `${r.actionId}:${r.status}`).join(','),
        ].join('|');

        let h = 0x811c9dc5;
        for (let i = 0; i < sig.length; i++) {
            h ^= sig.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16);
    }
}
