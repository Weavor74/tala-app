# Contract: crossSystemTypes.ts

**Source**: [shared\crossSystemTypes.ts](../../shared/crossSystemTypes.ts)

## Interfaces

### `CrossSystemSignal`
```typescript
interface CrossSystemSignal {
    /** Stable unique ID for this signal. Prefixed `signal-`. */
    signalId: CrossSystemSignalId;
    /** The type of event that produced this signal. */
    sourceType: SignalSourceType;
    /** The subsystem that emitted this signal (e.g. 'execution', 'governance'). */
    subsystem: string;
    /** Files referenced by this signal (affected by the failure or anomaly). */
    affectedFiles: string[];
    /** Specific error or block type (e.g. 'TypeCheckFailed', 'PolicyBlocked'). */
    failureType: string;
    /** ISO-8601 timestamp when this signal was emitted. */
    timestamp: string;
    /** The goal that was active when this signal was produced, if known. */
    goalId?: string;
    /** The run ID associated with this signal, if known. */
    runId?: string;
    /** The campaign ID associated with this signal, if known. */
    campaignId?: string;
    /** Signal severity based on impact and urgency. */
    severity: 'low' | 'medium' | 'high';
    /** Additional context for this signal (non-PII, non-sensitive). */
    metadata: Record<string, unknown>;
}
```

### `IncidentCluster`
```typescript
interface IncidentCluster {
    /** Stable unique ID for this cluster. Prefixed `cluster-`. */
    clusterId: ClusterId;
    /** Human-readable label derived from the dominant failure pattern. */
    label: string;
    /** IDs of all signals that belong to this cluster. */
    signalIds: CrossSystemSignalId[];
    /** Unique subsystems represented in this cluster. */
    subsystems: string[];
    /** Files that appear in more than one signal within this cluster. */
    sharedFiles: string[];
    /** The failure type that appears most frequently across signals. */
    dominantFailureType: string;
    /** The clustering criteria that caused these signals to be grouped. */
    clusteringCriteria: ClusteringCriterion[];
    /** ISO-8601 timestamp of the oldest signal in this cluster. */
    firstSeenAt: string;
    /** ISO-8601 timestamp of the most recent signal in this cluster. */
    lastSeenAt: string;
    /** Total number of signals in this cluster. */
    signalCount: number;
    /** Cluster severity, derived from the highest-severity signal. */
    severity: 'low' | 'medium' | 'high';
    /** Lifecycle status of this cluster. */
    status: 'open' | 'addressed' | 'dismissed' | 'resolved';
    /** The root cause hypothesis linked to this cluster, if analyzed. */
    rootCauseId?: RootCauseId;
}
```

### `RootCauseScoringFactor`
```typescript
interface RootCauseScoringFactor {
    /** Human-readable name of this factor. */
    factorName: string;
    /** Raw numeric value for this factor. */
    value: number;
    /** Weighting coefficient applied to the raw value (0–1). */
    weight: number;
    /** Weighted contribution: value * weight. */
    contribution: number;
    /** Why this factor was scored the way it was. */
    rationale: string;
}
```

### `RootCauseOutcomeEntry`
```typescript
interface RootCauseOutcomeEntry {
    /** ISO-8601 timestamp when this outcome was recorded. */
    recordedAt: string;
    /** The strategy that was applied. */
    strategyUsed: CrossSystemStrategyKind;
    /** Whether the strategy resolved the cluster. */
    succeeded: boolean;
    /** Human-readable notes about this outcome. */
    notes: string;
}
```

### `RootCauseHypothesis`
```typescript
interface RootCauseHypothesis {
    /** Stable unique ID for this hypothesis. Prefixed `rc-`. */
    rootCauseId: RootCauseId;
    /** The cluster this hypothesis was generated from. */
    clusterId: ClusterId;
    /** High-level category of the root cause. */
    category: RootCauseCategory;
    /** Human-readable description of the hypothesis. */
    description: string;
    /** Composite score 0–100; higher means stronger evidence. */
    score: number;
    /** Individual factors that contributed to the score. */
    scoringFactors: RootCauseScoringFactor[];
    /** Confidence 0–1 derived from score and cluster size. */
    confidence: number;
    /** Subsystems implicated by this hypothesis. */
    subsystemsImplicated: string[];
    /** Files implicated by this hypothesis. */
    filesImplicated: string[];
    /** ISO-8601 timestamp when this hypothesis was generated. */
    generatedAt: string;
    /** Historical outcomes recorded against this hypothesis. */
    outcomeHistory: RootCauseOutcomeEntry[];
}
```

### `StrategyDecisionRecord`
```typescript
interface StrategyDecisionRecord {
    /** Stable unique ID for this decision. Prefixed `sdec-`. */
    decisionId: string;
    /** The cluster this decision addresses. */
    clusterId: ClusterId;
    /** The root cause hypothesis that informed this decision, if any. */
    rootCauseId?: RootCauseId;
    /** The strategy that was selected. */
    strategySelected: CrossSystemStrategyKind;
    /** Human-readable rationale for the decision. */
    rationale: string;
    /** ISO-8601 timestamp when this decision was made. */
    decidedAt: string;
    /** Policy constraints that were applied during selection. */
    policyConstraints: string[];
    /** Strategies considered but not selected, in priority order. */
    alternativesConsidered: CrossSystemStrategyKind[];
    /** Human-readable summary of the scope this decision targets. */
    scopeSummary: string;
    /** Goal ID this decision was routed to, if applicable. */
    routedToGoalId?: string;
    /** Campaign ID this decision was routed to, if applicable. */
    routedToCampaignId?: string;
    /** Phase 6.1: The StrategyRoutingDecision ID that processed this record, if any. */
    routedToRoutingDecisionId?: string;
}
```

### `CrossSystemOutcomeRecord`
```typescript
interface CrossSystemOutcomeRecord {
    /** Stable unique ID for this outcome. Prefixed `csout-`. */
    outcomeId: string;
    /** The cluster this outcome is associated with. */
    clusterId: ClusterId;
    /** The root cause hypothesis associated with this outcome, if any. */
    rootCauseId?: RootCauseId;
    /** The strategy that was applied. */
    strategyUsed: CrossSystemStrategyKind;
    /** The decision record that triggered this outcome. */
    decisionId: string;
    /** ISO-8601 timestamp when the strategy was executed. */
    executedAt: string;
    /** ISO-8601 timestamp when the cluster was confirmed resolved, if known. */
    resolvedAt?: string;
    /** Whether the strategy resolved the cluster. */
    succeeded: boolean;
    /** Whether the cluster recurred after being addressed. */
    recurred: boolean;
    /** Human-readable notes about the outcome. */
    notes: string;
}
```

### `CrossSystemKpis`
```typescript
interface CrossSystemKpis {
    /** Total number of signals ingested across all windows. */
    totalSignalsIngested: number;
    /** Total number of clusters ever formed. */
    totalClustersFormed: number;
    /** Total number of root cause hypotheses generated. */
    totalRootCausesGenerated: number;
    /** Total number of strategy decisions made. */
    totalStrategiesSelected: number;
    /** Total outcomes that resolved the cluster (succeeded=true). */
    totalSucceeded: number;
    /** Total clusters that recurred after being addressed. */
    totalRecurred: number;
    /** Number of clusters currently in 'open' status. */
    openClusterCount: number;
}
```

### `CrossSystemDashboardState`
```typescript
interface CrossSystemDashboardState {
    /** Clusters currently in 'open' status. */
    openClusters: IncidentCluster[];
    /** Most recently updated clusters (open + addressed), newest first. */
    recentClusters: IncidentCluster[];
    /** Root cause hypotheses for open clusters. */
    rootCauses: RootCauseHypothesis[];
    /** Most recent strategy decision records, newest first. */
    recentDecisions: StrategyDecisionRecord[];
    /** Most recent outcome records, newest first. */
    recentOutcomes: CrossSystemOutcomeRecord[];
    /** Number of signals in the current in-memory window. */
    signalWindowCount: number;
    /** Aggregate KPI metrics. */
    kpis: CrossSystemKpis;
    /** ISO-8601 timestamp when this state was computed. */
    lastUpdatedAt: string;
}
```

### `CrossSystemSignalId`
```typescript
type CrossSystemSignalId =  string;
```

### `ClusterId`
```typescript
type ClusterId =  string;
```

### `RootCauseId`
```typescript
type RootCauseId =  string;
```

### `SignalSourceType`
```typescript
type SignalSourceType = 
    | 'execution_failure'       // failed execution run (Phase 4 AutonomousRunOrchestrator)
    | 'verification_failure'    // failed verification step
    | 'governance_block'        // repeated governance block (Phase 3.5 governance layer)
    | 'harmonization_drift'     // drift detected by harmonization engine (Phase 5.6)
    | 'escalation_attempt'      // escalation was triggered (Phase 5.1)
    | 'recovery_pack_exhausted' // all packs tried and failed (Phase 4.3)
    | 'cooldown_breach'         // repeated cooldown hits
    | 'campaign_failure';
```

### `ClusteringCriterion`
```typescript
type ClusteringCriterion = 
    | 'shared_subsystem'    // signals from the same subsystem
    | 'shared_files'        // signals referencing overlapping affected files
    | 'shared_failure_type' // signals with the same failureType
    | 'temporal_proximity'  // signals within TEMPORAL_PROXIMITY_MS of each other
    | 'repeated_pattern';
```

### `RootCauseCategory`
```typescript
type RootCauseCategory = 
    | 'structural_drift'              // pattern inconsistency across files
    | 'repeated_execution_error'      // same error recurs in same subsystem
    | 'cross_subsystem_dependency'    // one subsystem's failure triggers others
    | 'policy_boundary_gap'           // policy/governance repeatedly blocks a needed change
    | 'campaign_scope_mismatch'       // campaigns repeatedly insufficient for the problem
    | 'unknown';
```

### `CrossSystemStrategyKind`
```typescript
type CrossSystemStrategyKind = 
    | 'targeted_repair'          // a targeted single-goal repair
    | 'harmonization_campaign'   // trigger a harmonization campaign (Phase 5.6)
    | 'multi_step_campaign'      // trigger a multi-step repair campaign (Phase 5.5)
    | 'defer'                    // defer until more signals accumulate
    | 'escalate_human';
```

