# Contract: strategyRoutingTypes.ts

**Source**: [shared\strategyRoutingTypes.ts](../../shared/strategyRoutingTypes.ts)

## Interfaces

### `RoutingBlockFactor`
```typescript
interface RoutingBlockFactor {
    factor: RoutingBlockFactorKind;
    description: string;
}
```

### `RoutingEligibilityResult`
```typescript
interface RoutingEligibilityResult {
    eligible: boolean;
    /** The safe target type determined by the eligibility check. */
    targetType: StrategyRoutingTargetType;
    reason: string;
    blockedFactors: RoutingBlockFactor[];
    /** Composite confidence 0–1: (rootCause.confidence * 0.6) + (rootCause.score/100 * 0.4). */
    confidenceScore: number;
    checkedAt: string; // ISO-8601
}
```

### `RoutedActionReference`
```typescript
interface RoutedActionReference {
    actionType: StrategyRoutingTargetType;
    /** goalId, campaignId, or routingDecisionId for human_review/deferred. */
    actionId: string;
    createdAt: string; // ISO-8601
    status: RoutedActionStatus;
}
```

### `StrategyRoutingContext`
```typescript
interface StrategyRoutingContext {
    /** Subsystem IDs that are hard-blocked by AutonomyPolicy.hardBlockedSubsystems. */
    protectedSubsystems: string[];
    /** Whether there is available capacity for new campaigns. */
    campaignCapacityAvailable: boolean;
    /** Number of routing decisions currently in 'eligible' or 'routed' status. */
    activeRoutingCount: number;
}
```

### `StrategyRoutingInput`
```typescript
interface StrategyRoutingInput {
    sourceDecision: StrategyDecisionRecord;
    cluster: IncidentCluster;
    /** The top root cause hypothesis for this cluster, if any. */
    rootCause: RootCauseHypothesis | undefined;
    context: StrategyRoutingContext;
}
```

### `StrategyRoutingDecision`
```typescript
interface StrategyRoutingDecision {
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
```

### `StrategyRoutingOutcomeRecord`
```typescript
interface StrategyRoutingOutcomeRecord {
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
```

### `StrategyRoutingKpis`
```typescript
interface StrategyRoutingKpis {
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
```

### `StrategyRoutingDashboardState`
```typescript
interface StrategyRoutingDashboardState {
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
```

### `StrategyRoutingDecisionId`
```typescript
type StrategyRoutingDecisionId =  string;
```

### `StrategyRoutingOutcomeId`
```typescript
type StrategyRoutingOutcomeId =  string;
```

### `StrategyRoutingTargetType`
```typescript
type StrategyRoutingTargetType = 
    | 'autonomous_goal'         // targeted repair goal via normal autonomy pipeline
    | 'repair_campaign'         // multi-step repair via RepairCampaignCoordinator
    | 'harmonization_campaign'  // structural harmonization via HarmonizationCoordinator
    | 'human_review'            // requires human decision — surfaced in dashboard
    | 'deferred';
```

### `StrategyRoutingStatus`
```typescript
type StrategyRoutingStatus = 
    | 'eligible'          // passed eligibility;
```

### `RoutingBlockFactorKind`
```typescript
type RoutingBlockFactorKind = 
    | 'confidence_too_low'      // rootCause.confidence below MIN_ROOT_CAUSE_CONFIDENCE
    | 'score_too_low'           // rootCause.score below MIN_ROOT_CAUSE_SCORE
    | 'scope_too_large'         // cluster.subsystems.length > MAX_SCOPE_SUBSYSTEMS_AUTO_ROUTE
    | 'protected_subsystem'     // cluster subsystems include a hard-blocked subsystem
    | 'no_campaign_capacity'    // campaign coordinator is at capacity
    | 'ambiguity_too_high'      // weak/ambiguous clustering criteria
    | 'cooldown_active'         // routing cooldown in effect for this cluster
    | 'duplicate_routing'       // a routing decision already exists for this cluster
    | 'concurrent_cap_reached';
```

### `RoutedActionStatus`
```typescript
type RoutedActionStatus = 
    | 'pending'
    | 'active'
    | 'completed'
    | 'failed'
    | 'blocked'
    | 'deferred'
    | 'human_review_pending';
```

