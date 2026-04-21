# Contract: adaptiveTypes.ts

**Source**: [shared\adaptiveTypes.ts](../../shared/adaptiveTypes.ts)

## Interfaces

### `AdaptiveThresholds`
```typescript
interface AdaptiveThresholds {
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
```

### `GoalValueScoreExplanation`
```typescript
interface GoalValueScoreExplanation {
    dominantFactors: string[];
    suppressionFactors: string[];
    notes?: string;
}
```

### `GoalValueScore`
```typescript
interface GoalValueScore {
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
```

### `StrategyAlternative`
```typescript
interface StrategyAlternative {
    strategy: StrategyKind;
    packId?: string;
    packConfidence?: number;
    rejectionReason: string;
}
```

### `StrategySelectionResult`
```typescript
interface StrategySelectionResult {
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
```

### `AdaptivePolicyDecision`
```typescript
interface AdaptivePolicyDecision {
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
```

### `SubsystemProfile`
```typescript
interface SubsystemProfile {
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
```

### `AdaptiveKpis`
```typescript
interface AdaptiveKpis {
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
```

### `AdaptiveDashboardState`
```typescript
interface AdaptiveDashboardState {
    computedAt: string;
    recentValueScores: GoalValueScore[];
    recentPolicyDecisions: AdaptivePolicyDecision[];
    recentStrategySelections: StrategySelectionResult[];
    subsystemProfiles: SubsystemProfile[];
    kpis: AdaptiveKpis;
}
```

### `StrategyKind`
```typescript
type StrategyKind =  'recovery_pack' | 'standard_planning' | 'defer' | 'suppress';
```

### `AdaptivePolicyAction`
```typescript
type AdaptivePolicyAction =  'proceed' | 'defer' | 'suppress' | 'escalate';
```

### `AdaptiveReasonCode`
```typescript
type AdaptiveReasonCode = 
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
    | 'succeeded_above_threshold';
```

### `SubsystemSensitivity`
```typescript
type SubsystemSensitivity =  'critical' | 'high' | 'standard' | 'low';
```

