/**
 * StrategyRoutingEngine.ts — Phase 6.1 P6.1C / P6.1D / P6.1E / P6.1H
 *
 * Main Strategy Routing Orchestrator.
 *
 * Responsibilities:
 * - Accept a StrategyRoutingInput from CrossSystemCoordinator.runAnalysis()
 * - Run eligibility check via StrategyRoutingEligibility
 * - Create a StrategyRoutingDecision (eligible / blocked / deferred / human_review)
 * - Persist decisions to disk (routing_decisions.json)
 * - Serve decisions to AutonomousRunOrchestrator for materialization
 * - Emit dashboard updates via StrategyRoutingDashboardBridge
 * - Enforce duplicate-routing and cooldown invariants
 *
 * The engine does NOT:
 * - Create AutonomousGoals directly
 * - Create RepairCampaigns directly
 * - Create HarmonizationCampaigns directly
 * - Call SafeChangePlanner, GovernanceAppService, or ExecutionOrchestrator
 *
 * Materialization (creating actual goals/campaigns) is delegated to
 * AutonomousRunOrchestrator._processStrategyRoutingQueue() which uses
 * the existing planning → governance → execution / campaign pipelines.
 *
 * Safety invariants:
 *   1. One routing decision per cluster (duplicate_routing guard)
 *   2. Cooldown after failed routing (cooldown_active guard)
 *   3. MAX_CONCURRENT_ROUTINGS enforced (concurrent_cap_reached guard)
 *   4. Protected subsystems always route to human_review
 *   5. Low-confidence strategies always blocked (not silently deferred)
 *   6. Ambiguous clusters always blocked
 *   7. No recursive routing from routed actions
 *
 * Storage:
 *   {dataDir}/autonomy/strategy_routing/routing_decisions.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    StrategyRoutingDecision,
    StrategyRoutingDecisionId,
    StrategyRoutingInput,
    StrategyRoutingStatus,
    StrategyRoutingDashboardState,
    RoutedActionReference,
} from '../../../../shared/strategyRoutingTypes';
import { STRATEGY_ROUTING_BOUNDS } from '../../../../shared/strategyRoutingTypes';
import { StrategyRoutingEligibility } from './StrategyRoutingEligibility';
import type { StrategyRoutingOutcomeTracker } from './StrategyRoutingOutcomeTracker';
import type { StrategyRoutingDashboardBridge } from './StrategyRoutingDashboardBridge';
import { telemetry } from '../../TelemetryService';

// ─── Storage ──────────────────────────────────────────────────────────────────

const DECISIONS_FILE = 'routing_decisions.json';

// ─── Cooldown tracking ────────────────────────────────────────────────────────

interface CooldownEntry {
    clusterId: string;
    failedAt: number; // epoch ms
}

// ─── StrategyRoutingEngine ────────────────────────────────────────────────────

export class StrategyRoutingEngine {
    private readonly storageDir: string;
    private decisions: StrategyRoutingDecision[] = [];
    private cooldowns: CooldownEntry[] = [];
    private loaded = false;

    private readonly eligibility = new StrategyRoutingEligibility();

    constructor(
        dataDir: string,
        private readonly outcomeTracker: StrategyRoutingOutcomeTracker,
        private readonly dashboardBridge: StrategyRoutingDashboardBridge,
    ) {
        this.storageDir = path.join(dataDir, 'autonomy', 'strategy_routing');
        this._ensureDir(this.storageDir);
    }

    // ── Main routing entry point ──────────────────────────────────────────────

    /**
     * Routes a strategy decision to the appropriate action form.
     *
     * If a routing decision already exists for this cluster, the existing
     * decision is returned unchanged (idempotent).
     *
     * Returns a StrategyRoutingDecision in one of these statuses:
     *   - 'eligible'      — passed all checks, waiting for materialization
     *   - 'routed'        — already materialized (returned from prior call)
     *   - 'blocked'       — failed eligibility checks
     *   - 'deferred'      — strategy kind is 'defer' or eligibility blocked
     *   - 'human_review'  — strategy kind is 'escalate_human' or safety fallback
     */
    route(input: StrategyRoutingInput): StrategyRoutingDecision {
        this._ensureLoaded();

        const { sourceDecision, cluster, rootCause } = input;

        // ── Idempotency: return existing decision for this cluster ─────────────
        const existing = this.decisions.find(
            d => d.clusterId === cluster.clusterId,
        );
        if (existing) {
            telemetry.operational(
                'autonomy',
                'operational',
                'debug',
                'StrategyRoutingEngine',
                `route() idempotent: returning existing decision ` +
                `${existing.routingDecisionId} for cluster ${cluster.clusterId}`,
            );
            return existing;
        }

        // ── Evaluate eligibility ──────────────────────────────────────────────
        const eligibilityResult = this.eligibility.evaluate(input, this);

        const routingDecisionId: StrategyRoutingDecisionId = `sroute-${uuidv4()}`;
        const now = new Date().toISOString();

        // ── Determine status from eligibility result ──────────────────────────
        let status: StrategyRoutingStatus;
        let blockedReason: string | undefined;
        let deferredReason: string | undefined;

        if (!eligibilityResult.eligible) {
            // Blocked — eligibility hard-failed (not a safe fallback)
            status = 'blocked';
            blockedReason = eligibilityResult.reason;
        } else {
            switch (eligibilityResult.targetType) {
                case 'deferred':
                    status = 'deferred';
                    deferredReason = eligibilityResult.reason;
                    break;
                case 'human_review':
                    status = 'human_review';
                    break;
                default:
                    // autonomous_goal / repair_campaign / harmonization_campaign
                    status = 'eligible';
            }
        }

        // ── Build the routing decision ────────────────────────────────────────
        const decision: StrategyRoutingDecision = {
            routingDecisionId,
            sourceDecisionId: sourceDecision.decisionId,
            clusterId: cluster.clusterId,
            rootCauseId: rootCause?.rootCauseId,
            strategyKind: sourceDecision.strategySelected,
            routingTargetType: eligibilityResult.targetType,
            eligibilityResult,
            status,
            routedActionRef: undefined,
            rationale: this._buildRationale(input, eligibilityResult),
            confidence: eligibilityResult.confidenceScore,
            scopeSummary: sourceDecision.scopeSummary,
            decidedAt: now,
            lastUpdatedAt: now,
            blockedReason,
            deferredReason,
        };

        // ── Persist and emit ──────────────────────────────────────────────────
        this.decisions.push(decision);
        this._persist();

        const milestone = this._milestoneForStatus(status);
        const state = this._buildCurrentState();
        this.dashboardBridge.maybeEmit(milestone, state);

        // ── Telemetry ─────────────────────────────────────────────────────────
        telemetry.operational(
            'autonomy',
            'operational',
            status === 'blocked' ? 'warn' : 'info',
            'StrategyRoutingEngine',
            `Strategy routing evaluated: cluster=${cluster.clusterId} ` +
            `strategy=${sourceDecision.strategySelected} ` +
            `status=${status} targetType=${eligibilityResult.targetType}`,
        );

        return decision;
    }

    // ── Materialization update ────────────────────────────────────────────────

    /**
     * Marks a routing decision as 'routed' after the action has been created.
     * Called by AutonomousRunOrchestrator after creating the goal/campaign.
     */
    markRouted(
        routingDecisionId: StrategyRoutingDecisionId,
        actionRef: RoutedActionReference,
    ): void {
        this._ensureLoaded();
        const decision = this.decisions.find(d => d.routingDecisionId === routingDecisionId);
        if (!decision) return;

        decision.status = 'routed';
        decision.routedActionRef = actionRef;
        decision.lastUpdatedAt = new Date().toISOString();
        this._persist();

        this.dashboardBridge.maybeEmit('routing_routed', this._buildCurrentState());

        telemetry.operational(
            'autonomy',
            'operational',
            'info',
            'StrategyRoutingEngine',
            `Routing decision ${routingDecisionId} marked as routed: ` +
            `actionType=${actionRef.actionType} actionId=${actionRef.actionId}`,
        );
    }

    /**
     * Marks a routing decision as 'outcome_recorded' and sets a cooldown
     * if the action failed, to prevent immediate re-routing.
     */
    markOutcomeRecorded(
        routingDecisionId: StrategyRoutingDecisionId,
        actionSucceeded: boolean,
    ): void {
        this._ensureLoaded();
        const decision = this.decisions.find(d => d.routingDecisionId === routingDecisionId);
        if (!decision) return;

        decision.status = 'outcome_recorded';
        decision.lastUpdatedAt = new Date().toISOString();

        if (!actionSucceeded) {
            this._setCooldown(decision.clusterId);
        }

        this._persist();
        this.dashboardBridge.maybeEmit('outcome_recorded', this._buildCurrentState());
    }

    /**
     * Updates the routedActionRef status for a given routing decision.
     * Called by AutonomousRunOrchestrator as action status changes.
     */
    updateActionRefStatus(
        routingDecisionId: StrategyRoutingDecisionId,
        newStatus: import('../../../../shared/strategyRoutingTypes').RoutedActionStatus,
    ): void {
        this._ensureLoaded();
        const decision = this.decisions.find(d => d.routingDecisionId === routingDecisionId);
        if (!decision?.routedActionRef) return;

        decision.routedActionRef.status = newStatus;
        decision.lastUpdatedAt = new Date().toISOString();
        this._persist();
    }

    // ── Query methods ─────────────────────────────────────────────────────────

    /**
     * Returns true if a routing decision already exists for the given cluster.
     * Used by StrategyRoutingEligibility to prevent duplicate routing.
     */
    hasRoutingForCluster(clusterId: string): boolean {
        this._ensureLoaded();
        return this.decisions.some(d => d.clusterId === clusterId);
    }

    /**
     * Returns true if a routing cooldown is active for the given cluster.
     * Cooldown is set when a routed action fails.
     */
    isCooldownActive(clusterId: string): boolean {
        this._ensureLoaded();
        this._purgeStaleCooldowns();
        return this.cooldowns.some(c => c.clusterId === clusterId);
    }

    /**
     * Returns all routing decisions with the given status filter.
     */
    listDecisions(filter?: { status?: StrategyRoutingStatus[] }): StrategyRoutingDecision[] {
        this._ensureLoaded();
        if (!filter?.status) return [...this.decisions];
        return this.decisions.filter(d => filter.status!.includes(d.status));
    }

    /**
     * Returns a specific routing decision by ID.
     */
    getDecision(id: StrategyRoutingDecisionId): StrategyRoutingDecision | null {
        this._ensureLoaded();
        return this.decisions.find(d => d.routingDecisionId === id) ?? null;
    }

    /**
     * Returns the number of decisions in 'eligible' or 'routed' status.
     * Used by StrategyRoutingEligibility for concurrent cap check.
     */
    getActiveRoutingCount(): number {
        this._ensureLoaded();
        return this.decisions.filter(
            d => d.status === 'eligible' || d.status === 'routed',
        ).length;
    }

    /**
     * Builds and returns the full dashboard state.
     */
    getDashboardState(): StrategyRoutingDashboardState {
        this._ensureLoaded();
        return this._buildCurrentState();
    }

    // ── Private: state builder ────────────────────────────────────────────────

    private _buildCurrentState(): StrategyRoutingDashboardState {
        const outcomes = this.outcomeTracker.listOutcomes();
        const trustScore = this.outcomeTracker.computeOverallTrustScore();
        return this.dashboardBridge.buildState(this.decisions, outcomes, trustScore);
    }

    // ── Private: cooldowns ────────────────────────────────────────────────────

    private _setCooldown(clusterId: string): void {
        this.cooldowns.push({ clusterId, failedAt: Date.now() });
    }

    private _purgeStaleCooldowns(): void {
        const cutoff = Date.now() - STRATEGY_ROUTING_BOUNDS.ROUTING_COOLDOWN_AFTER_FAILURE_MS;
        this.cooldowns = this.cooldowns.filter(c => c.failedAt >= cutoff);
    }

    // ── Private: rationale builder ────────────────────────────────────────────

    private _buildRationale(
        input: StrategyRoutingInput,
        result: import('../../../../shared/strategyRoutingTypes').RoutingEligibilityResult,
    ): string {
        const { sourceDecision, cluster, rootCause } = input;
        const parts: string[] = [
            `Strategy: ${sourceDecision.strategySelected}`,
            `Cluster: ${cluster.label} (${cluster.subsystems.join(', ')})`,
        ];
        if (rootCause) {
            parts.push(
                `Root cause: ${rootCause.category} ` +
                `(confidence=${rootCause.confidence.toFixed(2)}, score=${rootCause.score})`,
            );
        }
        parts.push(`Routing target: ${result.targetType}`);
        if (result.blockedFactors.length > 0) {
            parts.push(`Blocked factors: ${result.blockedFactors.map(f => f.factor).join(', ')}`);
        }
        return parts.join(' | ');
    }

    private _milestoneForStatus(status: StrategyRoutingStatus): string {
        switch (status) {
            case 'eligible':   return 'routing_evaluated';
            case 'blocked':    return 'routing_blocked';
            case 'deferred':   return 'routing_deferred';
            case 'human_review': return 'routing_human_review';
            case 'routed':     return 'routing_routed';
            default:           return 'routing_evaluated';
        }
    }

    // ── Private: persistence ──────────────────────────────────────────────────

    private _ensureLoaded(): void {
        if (!this.loaded) {
            this._load();
            this.loaded = true;
        }
    }

    private _load(): void {
        const file = path.join(this.storageDir, DECISIONS_FILE);
        if (!fs.existsSync(file)) {
            this.decisions = [];
            return;
        }
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as StrategyRoutingDecision[];
            // Purge old outcome_recorded decisions on load (retention cap)
            const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
            this.decisions = raw.filter(d =>
                d.status !== 'outcome_recorded' ||
                new Date(d.decidedAt).getTime() >= cutoff,
            );
        } catch {
            this.decisions = [];
        }
    }

    private _persist(): void {
        const file = path.join(this.storageDir, DECISIONS_FILE);
        try {
            fs.writeFileSync(file, JSON.stringify(this.decisions, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'StrategyRoutingEngine',
                `Failed to persist routing decisions: ${err.message}`,
            );
        }
    }

    private _ensureDir(dir: string): void {
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        } catch {
            // non-fatal
        }
    }
}
