/**
 * StrategyRoutingEligibility.ts — Phase 6.1 P6.1B
 *
 * Deterministic eligibility gate for strategy routing.
 *
 * Evaluates whether a strategy decision may be automatically routed into a
 * concrete action form (goal, campaign, etc.).
 *
 * All checks are rule-based and deterministic — same inputs produce the same result.
 *
 * Check order (first failure returns immediately):
 *   1. duplicate_routing    — cluster already has a routing decision
 *   2. cooldown_active      — within failure cooldown window for this cluster
 *   3. concurrent_cap_reached — MAX_CONCURRENT_ROUTINGS limit hit
 *   4. confidence_too_low   — rootCause absent or confidence < MIN_ROOT_CAUSE_CONFIDENCE
 *   5. score_too_low        — rootCause.score < MIN_ROOT_CAUSE_SCORE
 *   6. scope_too_large      — subsystems.length > MAX_SCOPE_SUBSYSTEMS_AUTO_ROUTE
 *                             (escalate_human bypasses this — always routes to human_review)
 *   7. protected_subsystem  — hard-blocked subsystem in cluster
 *                             (escalate_human bypasses this — always routes to human_review)
 *   8. no_campaign_capacity — campaign coordinator at capacity (for campaign targets only)
 *   9. ambiguity_too_high   — only temporal_proximity clustering criterion present
 *
 * When strategyKind === 'defer': bypasses all checks, always returns eligible=true targetType='deferred'.
 * When strategyKind === 'escalate_human': bypasses checks 4–9, returns eligible=true targetType='human_review'.
 */

import type {
    RoutingEligibilityResult,
    RoutingBlockFactor,
    RoutingBlockFactorKind,
    StrategyRoutingInput,
    StrategyRoutingTargetType,
} from '../../../../shared/strategyRoutingTypes';
import { STRATEGY_ROUTING_BOUNDS } from '../../../../shared/strategyRoutingTypes';
import type { StrategyRoutingEngine } from './StrategyRoutingEngine';

// ─── StrategyRoutingEligibility ───────────────────────────────────────────────

export class StrategyRoutingEligibility {

    /**
     * Evaluates routing eligibility for the given input.
     *
     * @param input    Full routing input (decision, cluster, rootCause, context).
     * @param engine   The routing engine — used to check duplicate/cooldown status.
     * @returns        RoutingEligibilityResult with eligible, targetType, reasons.
     */
    evaluate(
        input: StrategyRoutingInput,
        engine: StrategyRoutingEngine,
    ): RoutingEligibilityResult {
        const now = new Date().toISOString();
        const { sourceDecision, cluster, rootCause, context } = input;
        const strategyKind = sourceDecision.strategySelected;

        // ── Fast path: defer strategy always routes to deferred ───────────────
        if (strategyKind === 'defer') {
            return {
                eligible: true,
                targetType: 'deferred',
                reason: 'Strategy is defer — routing to deferred record without eligibility checks.',
                blockedFactors: [],
                confidenceScore: 0,
                checkedAt: now,
            };
        }

        // ── Fast path: escalate_human always routes to human_review ──────────
        if (strategyKind === 'escalate_human') {
            return {
                eligible: true,
                targetType: 'human_review',
                reason: 'Strategy is escalate_human — routing to human review without scope/confidence checks.',
                blockedFactors: [],
                confidenceScore: this._computeConfidenceScore(rootCause),
                checkedAt: now,
            };
        }

        // ── Check 1: duplicate routing ────────────────────────────────────────
        if (engine.hasRoutingForCluster(cluster.clusterId)) {
            return this._blocked(
                'duplicate_routing',
                `Cluster ${cluster.clusterId} already has a routing decision.`,
                now,
            );
        }

        // ── Check 2: cooldown ─────────────────────────────────────────────────
        if (engine.isCooldownActive(cluster.clusterId)) {
            return this._blocked(
                'cooldown_active',
                `Routing cooldown is active for cluster ${cluster.clusterId}.`,
                now,
            );
        }

        // ── Check 3: concurrent routing cap ───────────────────────────────────
        if (context.activeRoutingCount >= STRATEGY_ROUTING_BOUNDS.MAX_CONCURRENT_ROUTINGS) {
            return this._blocked(
                'concurrent_cap_reached',
                `Active routing count (${context.activeRoutingCount}) has reached ` +
                `MAX_CONCURRENT_ROUTINGS (${STRATEGY_ROUTING_BOUNDS.MAX_CONCURRENT_ROUTINGS}).`,
                now,
            );
        }

        // ── Check 4: root cause confidence ────────────────────────────────────
        if (!rootCause || rootCause.confidence < STRATEGY_ROUTING_BOUNDS.MIN_ROOT_CAUSE_CONFIDENCE) {
            const conf = rootCause?.confidence ?? 0;
            return this._blocked(
                'confidence_too_low',
                `Root cause confidence (${conf.toFixed(2)}) is below ` +
                `MIN_ROOT_CAUSE_CONFIDENCE (${STRATEGY_ROUTING_BOUNDS.MIN_ROOT_CAUSE_CONFIDENCE}).`,
                now,
            );
        }

        // ── Check 5: root cause score ─────────────────────────────────────────
        if (rootCause.score < STRATEGY_ROUTING_BOUNDS.MIN_ROOT_CAUSE_SCORE) {
            return this._blocked(
                'score_too_low',
                `Root cause score (${rootCause.score}) is below ` +
                `MIN_ROOT_CAUSE_SCORE (${STRATEGY_ROUTING_BOUNDS.MIN_ROOT_CAUSE_SCORE}).`,
                now,
            );
        }

        // ── Check 6: scope size ───────────────────────────────────────────────
        if (cluster.subsystems.length > STRATEGY_ROUTING_BOUNDS.MAX_SCOPE_SUBSYSTEMS_AUTO_ROUTE) {
            // Too wide to auto-route — fall back to human_review (eligible, but routed there)
            return this._fallback(
                'scope_too_large',
                `Cluster spans ${cluster.subsystems.length} subsystems, exceeding ` +
                `MAX_SCOPE_SUBSYSTEMS_AUTO_ROUTE (${STRATEGY_ROUTING_BOUNDS.MAX_SCOPE_SUBSYSTEMS_AUTO_ROUTE}). ` +
                `Routing to human review.`,
                'human_review',
                this._computeConfidenceScore(rootCause),
                now,
            );
        }

        // ── Check 7: protected subsystem ──────────────────────────────────────
        const hasProtectedSubsystem = cluster.subsystems.some(
            s => context.protectedSubsystems.includes(s),
        );
        if (hasProtectedSubsystem) {
            return this._fallback(
                'protected_subsystem',
                `Cluster involves a hard-blocked protected subsystem. Routing to human review.`,
                'human_review',
                this._computeConfidenceScore(rootCause),
                now,
            );
        }

        // ── Check 8: campaign capacity ────────────────────────────────────────
        const needsCampaign = strategyKind === 'harmonization_campaign' ||
            strategyKind === 'multi_step_campaign';
        if (needsCampaign && !context.campaignCapacityAvailable) {
            return this._fallback(
                'no_campaign_capacity',
                `No campaign capacity available for '${strategyKind}'. Routing to human review.`,
                'human_review',
                this._computeConfidenceScore(rootCause),
                now,
            );
        }

        // ── Check 9: ambiguity (weak sole criterion) ──────────────────────────
        const isAmbiguousOnly = cluster.clusteringCriteria.length === 1 &&
            cluster.clusteringCriteria[0] === 'temporal_proximity';
        if (isAmbiguousOnly) {
            return this._blocked(
                'ambiguity_too_high',
                `Cluster is based solely on temporal_proximity (weakest criterion). ` +
                `Insufficient evidence for automatic routing.`,
                now,
            );
        }

        // ── All checks passed — eligible ──────────────────────────────────────
        const confidenceScore = this._computeConfidenceScore(rootCause);
        const targetType = this._mapStrategyToTarget(
            strategyKind,
            cluster,
            rootCause,
        );

        return {
            eligible: true,
            targetType,
            reason: `All eligibility checks passed. Routing to '${targetType}'.`,
            blockedFactors: [],
            confidenceScore,
            checkedAt: now,
        };
    }

    // ── Private: target mapping ───────────────────────────────────────────────

    /**
     * Maps a CrossSystemStrategyKind to the correct StrategyRoutingTargetType.
     *
     * Rules (prefer smallest effective scope):
     *   targeted_repair:
     *     - confidence >= MIN_CONFIDENCE_FOR_GOAL AND subsystems.length === 1
     *       AND sharedFiles.length <= MAX_FILES_FOR_GOAL → autonomous_goal
     *     - else → human_review (too broad for targeted goal)
     *   harmonization_campaign → harmonization_campaign
     *   multi_step_campaign    → repair_campaign
     */
    private _mapStrategyToTarget(
        strategyKind: string,
        cluster: import('../../../../shared/crossSystemTypes').IncidentCluster,
        rootCause: import('../../../../shared/crossSystemTypes').RootCauseHypothesis,
    ): StrategyRoutingTargetType {
        switch (strategyKind) {
            case 'targeted_repair': {
                const canBeGoal =
                    rootCause.confidence >= STRATEGY_ROUTING_BOUNDS.MIN_CONFIDENCE_FOR_GOAL &&
                    cluster.subsystems.length === 1 &&
                    cluster.sharedFiles.length <= STRATEGY_ROUTING_BOUNDS.MAX_FILES_FOR_GOAL;
                return canBeGoal ? 'autonomous_goal' : 'human_review';
            }
            case 'harmonization_campaign':
                return 'harmonization_campaign';
            case 'multi_step_campaign':
                return 'repair_campaign';
            default:
                return 'human_review';
        }
    }

    // ── Private: helpers ──────────────────────────────────────────────────────

    /**
     * Computes composite confidence score from root cause data.
     * Formula: (confidence * 0.6) + (score/100 * 0.4)
     * Returns 0 when rootCause is absent.
     */
    private _computeConfidenceScore(
        rootCause: import('../../../../shared/crossSystemTypes').RootCauseHypothesis | undefined,
    ): number {
        if (!rootCause) return 0;
        return (rootCause.confidence * 0.6) + (rootCause.score / 100 * 0.4);
    }

    /** Builds a blocked (eligible=false, no active target) result. */
    private _blocked(
        factor: RoutingBlockFactorKind,
        description: string,
        checkedAt: string,
    ): RoutingEligibilityResult {
        const blockFactor: RoutingBlockFactor = { factor, description };
        return {
            eligible: false,
            targetType: 'deferred',
            reason: description,
            blockedFactors: [blockFactor],
            confidenceScore: 0,
            checkedAt,
        };
    }

    /**
     * Builds a fallback result — still eligible but routed to a safe conservative target.
     * Used when a safety guard forces human_review even though the strategy passed
     * the basic confidence checks.
     */
    private _fallback(
        factor: RoutingBlockFactorKind,
        description: string,
        targetType: StrategyRoutingTargetType,
        confidenceScore: number,
        checkedAt: string,
    ): RoutingEligibilityResult {
        const blockFactor: RoutingBlockFactor = { factor, description };
        return {
            eligible: true,
            targetType,
            reason: description,
            blockedFactors: [blockFactor],
            confidenceScore,
            checkedAt,
        };
    }
}
