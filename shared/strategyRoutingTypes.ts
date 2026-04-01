/**
 * strategyRoutingTypes.ts — Phase 6.1 Canonical Strategy Routing Contracts
 *
 * P6.1A: Strategy Routing Type Contracts
 *
 * Shared between Electron main process and renderer.
 *
 * Design principles:
 * - All routing is deterministic and inspectable
 * - No bypass of planning / governance / execution / campaigns
 * - Route to the smallest effective action form
 * - Protected subsystems and low-confidence strategies fall back safely
 * - Duplicate routing per cluster is never permitted
 * - Every routing decision is auditable and persisted
 *
 * Relationship to prior phases:
 *   Phase 6  (cross-system)   — StrategyDecisionRecord is the input to routing
 *   Phase 4  (autonomy)       — AutonomousGoal is one possible routed output
 *   Phase 5.5 (campaigns)     — RepairCampaign is one possible routed output
 *   Phase 5.6 (harmonization) — HarmonizationCampaign is one possible routed output
 *   Phase 3.5 (governance)    — All routed actions still pass through governance
 *   Phase 3  (execution)      — All routed actions still pass through execution
 */

import type {
    CrossSystemStrategyKind,
    StrategyDecisionRecord,
    IncidentCluster,
    RootCauseHypothesis,
} from './crossSystemTypes';

// ─── Identity ─────────────────────────────────────────────────────────────────

/** Stable identifier for a strategy routing decision. Prefixed `sroute-`. */
export type StrategyRoutingDecisionId = string;

/** Stable identifier for a routing outcome record. Prefixed `srout-`. */
export type StrategyRoutingOutcomeId = string;

// ─── Target types ─────────────────────────────────────────────────────────────

/**
 * The action form a strategy decision routes to.
 * Ordered from narrowest to broadest scope.
 * Prefer the smallest effective form.
 */
export type StrategyRoutingTargetType =
    | 'autonomous_goal'         // targeted repair goal via normal autonomy pipeline
    | 'repair_campaign'         // multi-step repair via RepairCampaignCoordinator
    | 'harmonization_campaign'  // structural harmonization via HarmonizationCoordinator
    | 'human_review'            // requires human decision — surfaced in dashboard
    | 'deferred';               // deferred — persisted, no active action created

// ─── Routing status ───────────────────────────────────────────────────────────

/**
 * Lifecycle state of a StrategyRoutingDecision.
 */
export type StrategyRoutingStatus =
    | 'eligible'          // passed eligibility; waiting for materialization
    | 'routed'            // action created; routedActionRef is set
    | 'blocked'           // eligibility failed; blockedReason is set
    | 'deferred'          // deliberately deferred; deferredReason is set
    | 'human_review'      // requires human action; visible in dashboard
    | 'outcome_recorded'; // outcome has been tracked via StrategyRoutingOutcomeTracker

// ─── Eligibility block factors ────────────────────────────────────────────────

/**
 * The specific reason why automatic routing was blocked.
 */
export type RoutingBlockFactorKind =
    | 'confidence_too_low'      // rootCause.confidence below MIN_ROOT_CAUSE_CONFIDENCE
    | 'score_too_low'           // rootCause.score below MIN_ROOT_CAUSE_SCORE
    | 'scope_too_large'         // cluster.subsystems.length > MAX_SCOPE_SUBSYSTEMS_AUTO_ROUTE
    | 'protected_subsystem'     // cluster subsystems include a hard-blocked subsystem
    | 'no_campaign_capacity'    // campaign coordinator is at capacity
    | 'ambiguity_too_high'      // weak/ambiguous clustering criteria
    | 'cooldown_active'         // routing cooldown in effect for this cluster
    | 'duplicate_routing'       // a routing decision already exists for this cluster
    | 'concurrent_cap_reached'; // MAX_CONCURRENT_ROUTINGS limit hit

export interface RoutingBlockFactor {
    factor: RoutingBlockFactorKind;
    description: string;
}

/**
 * Result of StrategyRoutingEligibility.evaluate().
 *
 * When eligible=false the targetType reflects the safe fallback
 * (human_review for ambiguous/scope issues, deferred for low-confidence).
 */
export interface RoutingEligibilityResult {
    eligible: boolean;
    /** The safe target type determined by the eligibility check. */
    targetType: StrategyRoutingTargetType;
    reason: string;
    blockedFactors: RoutingBlockFactor[];
    /** Composite confidence 0–1: (rootCause.confidence * 0.6) + (rootCause.score/100 * 0.4). */
    confidenceScore: number;
    checkedAt: string; // ISO-8601
}

// ─── Routed action reference ──────────────────────────────────────────────────

export type RoutedActionStatus =
    | 'pending'
    | 'active'
    | 'completed'
    | 'failed'
    | 'blocked'
    | 'deferred'
    | 'human_review_pending';

/**
 * A reference to the concrete action created by routing.
 * Mutated as the action progresses through governance/execution/campaigns.
 */
export interface RoutedActionReference {
    actionType: StrategyRoutingTargetType;
    /** goalId, campaignId, or routingDecisionId for human_review/deferred. */
    actionId: string;
    createdAt: string; // ISO-8601
    status: RoutedActionStatus;
}

// ─── Routing context ──────────────────────────────────────────────────────────

/**
 * Runtime context provided to the routing engine for eligibility evaluation.
 * Injected by CrossSystemCoordinator at routing time.
 */
export interface StrategyRoutingContext {
    /** Subsystem IDs that are hard-blocked by AutonomyPolicy.hardBlockedSubsystems. */
    protectedSubsystems: string[];
    /** Whether there is available capacity for new campaigns. */
    campaignCapacityAvailable: boolean;
    /** Number of routing decisions currently in 'eligible' or 'routed' status. */
    activeRoutingCount: number;
}

// ─── Routing input ────────────────────────────────────────────────────────────

/**
 * Full input to StrategyRoutingEngine.route().
 */
export interface StrategyRoutingInput {
    sourceDecision: StrategyDecisionRecord;
    cluster: IncidentCluster;
    /** The top root cause hypothesis for this cluster, if any. */
    rootCause: RootCauseHypothesis | undefined;
    context: StrategyRoutingContext;
}

// ─── Routing decision ─────────────────────────────────────────────────────────

/**
 * An immutable (except status/ref/timestamp) record produced when a
 * StrategyDecisionRecord is evaluated for routing.
 *
 * Persisted to disk in `autonomy/strategy_routing/routing_decisions.json`.
 */
export interface StrategyRoutingDecision {
    // ── Identity ──────────────────────────────────────────────────────────────
    readonly routingDecisionId: StrategyRoutingDecisionId;
    /** Links back to StrategyDecisionRecord.decisionId (Phase 6). */
    readonly sourceDecisionId: string;
    readonly clusterId: string;
    readonly rootCauseId: string | undefined;

    // ── Routing outcome ───────────────────────────────────────────────────────
    readonly strategyKind: CrossSystemStrategyKind;
    readonly routingTargetType: StrategyRoutingTargetType;
    readonly eligibilityResult: RoutingEligibilityResult;

    // ── Mutable state ─────────────────────────────────────────────────────────
    status: StrategyRoutingStatus;
    routedActionRef: RoutedActionReference | undefined;

    // ── Rationale ─────────────────────────────────────────────────────────────
    readonly rationale: string;
    readonly confidence: number; // 0–1, from eligibilityResult.confidenceScore
    readonly scopeSummary: string;
    readonly decidedAt: string;  // ISO-8601
    lastUpdatedAt: string;       // ISO-8601

    // ── Block / defer reasons ─────────────────────────────────────────────────
    blockedReason: string | undefined;
    deferredReason: string | undefined;
}

// ─── Outcome record ───────────────────────────────────────────────────────────

/**
 * An immutable record of the outcome of a routing decision and its routed action.
 *
 * Persisted to disk in `autonomy/strategy_routing/routing_outcomes.json`.
 */
export interface StrategyRoutingOutcomeRecord {
    readonly outcomeId: StrategyRoutingOutcomeId;
    readonly routingDecisionId: StrategyRoutingDecisionId;
    readonly clusterId: string;
    readonly targetType: StrategyRoutingTargetType;
    readonly actionId: string;
    /** Whether the route chosen was appropriate in hindsight. */
    routingCorrect: boolean | undefined;
    actionCompleted: boolean;
    actionSucceeded: boolean | undefined;
    /** Whether the original strategy hypothesis was validated by the outcome. */
    strategyValidated: boolean | undefined;
    /**
     * Trust adjustment for this routing class.
     * Positive = routing class proved effective, increase trust.
     * Negative = routing class proved ineffective, decrease trust.
     * Range: -1 to +1.
     */
    trustDelta: number;
    readonly recordedAt: string; // ISO-8601
    notes: string;
}

// ─── KPIs ─────────────────────────────────────────────────────────────────────

export interface StrategyRoutingKpis {
    totalDecisionsEvaluated: number;
    totalRoutedToGoal: number;
    totalRoutedToRepairCampaign: number;
    totalRoutedToHarmonizationCampaign: number;
    totalRoutedToHumanReview: number;
    totalDeferred: number;
    totalBlocked: number;
    totalOutcomesRecorded: number;
    totalRoutingsCorrect: number;
    /** Overall routing trust score 0–1. 0.5 = neutral (no history). */
    overallTrustScore: number;
}

// ─── Dashboard state ──────────────────────────────────────────────────────────

/**
 * Full strategy routing dashboard state.
 * Pushed to the renderer via IPC channel strategyRouting:dashboardUpdate.
 */
export interface StrategyRoutingDashboardState {
    /** All non-purged routing decisions (all statuses). */
    routingDecisions: StrategyRoutingDecision[];
    /** Decisions in 'blocked' status. */
    blockedDecisions: StrategyRoutingDecision[];
    /** Decisions in 'deferred' status. */
    deferredDecisions: StrategyRoutingDecision[];
    /** Decisions in 'human_review' status (require human action). */
    humanReviewItems: StrategyRoutingDecision[];
    /** Active routed action references (status: 'pending' or 'active'). */
    activeRoutedActions: RoutedActionReference[];
    /** Recent outcome records, newest first (up to 20). */
    recentOutcomes: StrategyRoutingOutcomeRecord[];
    kpis: StrategyRoutingKpis;
    lastUpdatedAt: string; // ISO-8601
}

// ─── Bounds ───────────────────────────────────────────────────────────────────

/**
 * Hard safety limits for the Strategy Routing Layer.
 * All limits are enforced by StrategyRoutingEligibility.evaluate().
 */
export const STRATEGY_ROUTING_BOUNDS = {
    /** Maximum routing decisions concurrently in 'eligible' or 'routed' status. */
    MAX_CONCURRENT_ROUTINGS: 3,
    /** One routing decision per cluster — ever (no re-routing without cooldown expiry). */
    MAX_ROUTINGS_PER_CLUSTER: 1,
    /** Cooldown after a failed routing before re-routing the same cluster. */
    ROUTING_COOLDOWN_AFTER_FAILURE_MS: 60 * 60 * 1000,   // 1 hour
    /** Maximum cluster subsystem count for automatic routing (above → human_review). */
    MAX_SCOPE_SUBSYSTEMS_AUTO_ROUTE: 3,
    /** Minimum root cause confidence for any automatic routing. */
    MIN_ROOT_CAUSE_CONFIDENCE: 0.40,
    /** Minimum root cause score for automatic routing. */
    MIN_ROOT_CAUSE_SCORE: 50,
    /** Stricter confidence threshold for autonomous_goal specifically. */
    MIN_CONFIDENCE_FOR_GOAL: 0.65,
    /** Maximum shared files for autonomous_goal routing (above → campaign or human_review). */
    MAX_FILES_FOR_GOAL: 5,
    /** Maximum steps for a strategy-routed repair campaign. */
    MAX_STRATEGY_CAMPAIGN_STEPS: 4,
    /** Retention window for outcome records. */
    OUTCOME_RETENTION_MS: 30 * 24 * 60 * 60 * 1000, // 30 days
} as const;
