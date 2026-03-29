/**
 * adaptiveTypes.ts — Phase 5 Canonical Adaptive Intelligence Contracts
 *
 * P5A: Adaptive Types & Contracts
 *
 * Canonical shared contracts for the Adaptive Intelligence Layer.
 * Shared between Electron main process and renderer.
 *
 * Design principles:
 * - Deterministic-first: all scoring and selection is rule-based, no model calls
 * - Inspectable: every decision includes reason codes and thresholds used
 * - Bounded: all adjustments are clamped; no extreme swings
 * - Optional: all adaptive services are optional; Phase 4 behavior is the fallback
 * - Non-bypassing: adaptive gate never overrides Phase 4 (AutonomyPolicyGate) blocks
 *
 * Relationship to prior phases:
 *   Phase 4   (autonomy)        — GoalPrioritizationEngine base scores are inputs
 *   Phase 4.3 (recovery packs) — pack confidence influences value scoring and strategy
 *   Phase 4D  (policy gate)    — inner gate result is always respected by AdaptivePolicyGate
 */

// ─── Strategy Kind ────────────────────────────────────────────────────────────

/**
 * Which execution strategy the StrategySelectionEngine selected for a goal.
 *
 * recovery_pack      — a matched recovery pack will be used (highest confidence path)
 * standard_planning  — standard SafeChangePlanner path (always available as fallback)
 * defer              — goal is deferred to the next cycle (value score too low to act now)
 * suppress           — goal is suppressed (value score below suppress threshold)
 */
export type StrategyKind = 'recovery_pack' | 'standard_planning' | 'defer' | 'suppress';

// ─── Adaptive Policy Action ───────────────────────────────────────────────────

/**
 * Final action returned by AdaptivePolicyGate.
 *
 * proceed   — all adaptive checks passed; continue to planning pipeline
 * defer     — re-queue for the next cycle; do not execute now
 * suppress  — discard this goal for this cycle; no execution attempt
 * escalate  — route to human review; do not execute autonomously
 */
export type AdaptivePolicyAction = 'proceed' | 'defer' | 'suppress' | 'escalate';

// ─── Reason Codes ─────────────────────────────────────────────────────────────

export type AdaptiveReasonCode =
    | 'low_value_score'                  // valueScore < suppressBelow
    | 'low_value_score_defer'            // valueScore < deferBelow (but >= suppressBelow)
    | 'low_success_probability'          // successProbability < minSuccessProbability
    | 'pack_confidence_below_floor'      // best pack confidence < packConfidenceFloor
    | 'pack_unavailable'                 // no pack matched for this goal
    | 'repeated_pack_failure'            // recent pack failures exceed pack success count
    | 'standard_preferred_by_profile'   // subsystem profile prefers standard planning
    | 'recent_oscillation'              // subsystem oscillation detected
    | 'consecutive_failures'            // consecutiveFailures >= escalateAfterConsecutiveFailures
    | 'small_sample_guard'              // totalAttempts < 3 (bias guard)
    | 'inner_gate_blocked'             // Phase 4D AutonomyPolicyGate blocked the goal
    | 'user_seeded_priority'            // user_seeded goal bypasses success probability gate
    | 'pack_preferred_by_profile'       // subsystem profile prefers recovery_pack
    | 'pack_high_confidence'            // pack confidence >= packConfidenceFloor
    | 'succeeded_above_threshold';      // all adaptive checks passed

// ─── Adaptive Thresholds ──────────────────────────────────────────────────────

/**
 * Configurable thresholds for the adaptive layer.
 *
 * Every AdaptivePolicyDecision records the thresholds that were in effect at
 * decision time, so past decisions can be reproduced and audited.
 */
export interface AdaptiveThresholds {
    /**
     * Value scores below this are suppressed (no execution, no retry).
     * Default: 15
     */
    suppressBelow: number;
    /**
     * Value scores below this (but >= suppressBelow) are deferred to the next cycle.
     * Default: 30
     */
    deferBelow: number;
    /**
     * Minimum success probability required to proceed (for non-user-seeded goals).
     * Below this → defer.
     * Default: 0.30
     */
    minSuccessProbability: number;
    /**
     * Pack confidence floor. Packs below this are not selected; standard planning is used.
     * Default: 0.35
     */
    packConfidenceFloor: number;
    /**
     * When consecutiveFailures >= this, escalate to human review.
     * Default: 3
     */
    escalateAfterConsecutiveFailures: number;
}

/**
 * Default thresholds used when no override is provided.
 * These are the safe, conservative defaults for production use.
 */
export const DEFAULT_ADAPTIVE_THRESHOLDS: AdaptiveThresholds = {
    suppressBelow: 15,
    deferBelow: 30,
    minSuccessProbability: 0.30,
    packConfidenceFloor: 0.35,
    escalateAfterConsecutiveFailures: 3,
};

// ─── Goal Value Score ─────────────────────────────────────────────────────────

/**
 * Human-readable explanation of a GoalValueScore.
 *
 * dominantFactors: top 1–3 factors that most increased the score
 * suppressionFactors: factors that most decreased the score
 */
export interface GoalValueScoreExplanation {
    dominantFactors: string[];
    suppressionFactors: string[];
    notes?: string;
}

/**
 * Scored output of GoalValueScoringEngine.score().
 *
 * valueScore is the primary output (0–100).
 * All component values are stored for auditability.
 */
export interface GoalValueScore {
    goalId: string;
    computedAt: string;
    /** Phase 4C base score from GoalPriorityScore.total (0–100). */
    baseScore: number;
    /**
     * Estimated probability that an execution attempt on this goal will succeed.
     * Blended from SubsystemProfile.successRate (70%) and learning registry confidence (30%).
     * Range: 0.0–1.0.
     */
    successProbability: number;
    /**
     * Confidence of the best matched recovery pack. 0 when no pack is available.
     * Range: 0.0–1.0.
     */
    packConfidence: number;
    /** Whether a recovery pack is available for this goal. */
    packAvailable: boolean;
    /** Estimated rollback likelihood from SubsystemProfile. Range: 0.0–1.0. */
    rollbackLikelihood: number;
    /** Estimated governance approval likelihood from SubsystemProfile. Range: 0.0–1.0. */
    governanceLikelihood: number;
    /** −5 when SubsystemProfile.totalAttempts < 3 (bias guard for new subsystems). */
    smallSamplePenalty: number;
    /**
     * Final normalized value score. Range: 0–100.
     * Higher = more valuable and likely to succeed.
     */
    valueScore: number;
    explanation: GoalValueScoreExplanation;
}

// ─── Strategy Selection Result ────────────────────────────────────────────────

/**
 * Output of StrategySelectionEngine.select().
 *
 * strategy is the primary output.
 * alternativesConsidered lists all strategies that were evaluated and why they were/were not chosen.
 */
export interface StrategyAlternative {
    strategy: StrategyKind;
    packId?: string;
    packConfidence?: number;
    rejectionReason: string;
}

export interface StrategySelectionResult {
    goalId: string;
    selectedAt: string;
    strategy: StrategyKind;
    /** Pack ID selected when strategy === 'recovery_pack'. */
    selectedPackId?: string;
    /** Confidence of the selected pack. */
    packConfidence?: number;
    reason: string;
    reasonCodes: AdaptiveReasonCode[];
    alternativesConsidered: StrategyAlternative[];
}

// ─── Adaptive Policy Decision ─────────────────────────────────────────────────

/**
 * Output of AdaptivePolicyGate.evaluate().
 *
 * This is the final adaptive-layer decision for a goal.
 * When action === 'proceed', the goal continues to the planning pipeline.
 */
export interface AdaptivePolicyDecision {
    goalId: string;
    decidedAt: string;
    action: AdaptivePolicyAction;
    reason: string;
    reasonCodes: AdaptiveReasonCode[];
    /** The thresholds that were in effect when this decision was made. */
    thresholdsUsed: AdaptiveThresholds;
    /**
     * ISO timestamp until which the goal should be deferred.
     * Only set when action === 'defer'.
     */
    deferUntil?: string;
}

// ─── Subsystem Adaptive Profile ───────────────────────────────────────────────

/**
 * Sensitivity tier for a subsystem.
 *
 * critical — identity, soul, governance, security, auth
 * high     — inference, memory, reflection, execution, mcp
 * standard — retrieval, search, context, router, cognitive
 * low      — everything else
 */
export type SubsystemSensitivity = 'critical' | 'high' | 'standard' | 'low';

/**
 * Per-subsystem operational profile maintained by SubsystemProfileRegistry.
 *
 * Tracks empirical success/failure rates and strategy preferences.
 * All rates are recomputed from raw counts, never stored directly as rates
 * to avoid floating-point drift.
 *
 * cooldownMultiplier: scales the base defer duration; bounded to [1.0, 4.0].
 * preferredStrategy: only set after ≥5 attempts of each strategy type.
 * oscillationDetected: only set after ≥4 recorded outcomes.
 * recentOutcomes: rolling ring buffer of last 8 outcomes (for oscillation detection).
 */
export interface SubsystemProfile {
    subsystemId: string;
    updatedAt: string;
    totalAttempts: number;
    successCount: number;
    failureCount: number;
    rollbackCount: number;
    governanceBlockCount: number;
    /** successCount / max(1, totalAttempts). Recomputed on every update. */
    successRate: number;
    /** failureCount / max(1, totalAttempts). Recomputed on every update. */
    failureRate: number;
    /** rollbackCount / max(1, totalAttempts). Recomputed on every update. */
    rollbackLikelihood: number;
    /**
     * Multiplier applied to the base defer duration. Range: [1.0, 4.0].
     * Increases on failure/rollback (× 1.5, capped at 4.0).
     * Decreases on success (× 0.7, floor at 1.0).
     */
    cooldownMultiplier: number;
    /**
     * Preferred execution strategy inferred from historical outcomes.
     * null until at least 5 attempts of each strategy type have been recorded.
     * Requires a ≥ 15% success-rate advantage to set a preference.
     */
    preferredStrategy: StrategyKind | null;
    packSuccessCount: number;
    packFailureCount: number;
    standardSuccessCount: number;
    standardFailureCount: number;
    sensitivityLevel: SubsystemSensitivity;
    /**
     * True when alternating outcomes (e.g. succeed/fail/succeed/fail) are detected
     * in the last 8 outcomes. Requires at least 4 outcomes to evaluate.
     */
    oscillationDetected: boolean;
    /** Number of consecutive non-success outcomes (failure or rollback). */
    consecutiveFailures: number;
    /**
     * Rolling ring buffer of last 8 outcomes.
     * Used for oscillation detection. Newest outcome is last.
     */
    recentOutcomes: Array<'succeeded' | 'failed' | 'rolled_back' | 'governance_blocked'>;
}

// ─── Adaptive Dashboard State ─────────────────────────────────────────────────

export interface AdaptiveKpis {
    avgValueScore: number;
    avgSuccessProbability: number;
    /** Fraction of recent strategy selections that chose recovery_pack. */
    packSelectionRate: number;
    deferRate: number;
    suppressRate: number;
    escalateRate: number;
    /** Number of subsystems with oscillationDetected === true. */
    oscillatingSubsystemCount: number;
}

/**
 * Full adaptive intelligence dashboard state.
 *
 * Present in AutonomyDashboardState.adaptiveState when the adaptive layer is active.
 * All lists are capped at 20 entries (most recent first).
 */
export interface AdaptiveDashboardState {
    computedAt: string;
    recentValueScores: GoalValueScore[];
    recentPolicyDecisions: AdaptivePolicyDecision[];
    recentStrategySelections: StrategySelectionResult[];
    subsystemProfiles: SubsystemProfile[];
    kpis: AdaptiveKpis;
}
