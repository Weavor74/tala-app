/**
 * crossSystemTypes.ts — Phase 6 Canonical Cross-System Intelligence Contracts
 *
 * P6A: Cross-System Signal Contracts
 *
 * Canonical shared contracts for the Cross-System Intelligence Layer.
 * Shared between Electron main process and renderer.
 *
 * Design principles:
 * - Local-first: no network, no cloud state
 * - Deterministic-first: all clustering, scoring, and strategy selection is rule-based
 * - Bounded: signal windows, cluster sizes, and root cause hypotheses have hard caps
 * - Auditable: every signal, cluster, hypothesis, decision, and outcome is recorded
 * - Non-bypassing: strategy decisions still route through planning, governance, execution
 * - Cross-subsystem visibility: surfaces patterns not visible within any single subsystem
 *
 * Relationship to prior phases:
 *   Phase 4   (autonomy)          — AutonomousRun failures emit signals
 *   Phase 4.3 (recovery packs)    — RecoveryPack exhaustion emits signals
 *   Phase 5.1 (decomposition)     — escalation attempts emit signals
 *   Phase 5.5 (repair campaigns)  — campaign failures emit signals
 *   Phase 5.6 (harmonization)     — drift detection emits signals
 *   Phase 3.5 (governance)        — repeated governance blocks emit signals
 */

// ─── Identity ─────────────────────────────────────────────────────────────────

/** Stable identifier for a cross-system signal. Prefixed `signal-`. */
export type CrossSystemSignalId = string;

/** Stable identifier for an incident cluster. Prefixed `cluster-`. */
export type ClusterId = string;

/** Stable identifier for a root cause hypothesis. Prefixed `rc-`. */
export type RootCauseId = string;

// ─── Signal source types ──────────────────────────────────────────────────────

/**
 * The subsystem event that originated a cross-system signal.
 */
export type SignalSourceType =
    | 'execution_failure'       // failed execution run (Phase 4 AutonomousRunOrchestrator)
    | 'verification_failure'    // failed verification step
    | 'governance_block'        // repeated governance block (Phase 3.5 governance layer)
    | 'harmonization_drift'     // drift detected by harmonization engine (Phase 5.6)
    | 'escalation_attempt'      // escalation was triggered (Phase 5.1)
    | 'recovery_pack_exhausted' // all packs tried and failed (Phase 4.3)
    | 'cooldown_breach'         // repeated cooldown hits
    | 'campaign_failure';       // repair campaign failed (Phase 5.5)

// ─── Cross-System Signal ──────────────────────────────────────────────────────

/**
 * An observable failure or anomaly signal from any subsystem.
 *
 * Signals are the raw inputs to the cross-system intelligence pipeline.
 * They are ephemeral and buffered in a bounded time window before clustering.
 */
export interface CrossSystemSignal {
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

// ─── Clustering ───────────────────────────────────────────────────────────────

/**
 * The criterion by which signals were grouped into an incident cluster.
 */
export type ClusteringCriterion =
    | 'shared_subsystem'    // signals from the same subsystem
    | 'shared_files'        // signals referencing overlapping affected files
    | 'shared_failure_type' // signals with the same failureType
    | 'temporal_proximity'  // signals within TEMPORAL_PROXIMITY_MS of each other
    | 'repeated_pattern';   // same sourceType+subsystem appears ≥3 times

/**
 * A bounded group of related signals that share one or more clustering criteria.
 *
 * Clusters are the unit of analysis for root cause analysis and strategy selection.
 * A cluster may not exceed MAX_CLUSTER_SIZE signals.
 */
export interface IncidentCluster {
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

// ─── Root Cause Analysis ──────────────────────────────────────────────────────

/**
 * High-level category of a root cause hypothesis.
 */
export type RootCauseCategory =
    | 'structural_drift'              // pattern inconsistency across files
    | 'repeated_execution_error'      // same error recurs in same subsystem
    | 'cross_subsystem_dependency'    // one subsystem's failure triggers others
    | 'policy_boundary_gap'           // policy/governance repeatedly blocks a needed change
    | 'campaign_scope_mismatch'       // campaigns repeatedly insufficient for the problem
    | 'unknown';

/**
 * A single contributing factor in the root cause scoring computation.
 */
export interface RootCauseScoringFactor {
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

/**
 * An entry recording the outcome of applying a strategy to a cluster
 * where this root cause was implicated.
 */
export interface RootCauseOutcomeEntry {
    /** ISO-8601 timestamp when this outcome was recorded. */
    recordedAt: string;
    /** The strategy that was applied. */
    strategyUsed: CrossSystemStrategyKind;
    /** Whether the strategy resolved the cluster. */
    succeeded: boolean;
    /** Human-readable notes about this outcome. */
    notes: string;
}

/**
 * A deterministically generated hypothesis about the root cause of an incident cluster.
 *
 * Up to MAX_ROOT_CAUSES_PER_CLUSTER hypotheses may be produced per cluster.
 * Hypotheses are ranked by score descending.
 */
export interface RootCauseHypothesis {
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

// ─── Strategy Selection ───────────────────────────────────────────────────────

/**
 * The type of system-level strategy selected for a cluster.
 *
 * Ordered from most targeted to most escalatory (smaller scope preferred).
 */
export type CrossSystemStrategyKind =
    | 'targeted_repair'          // a targeted single-goal repair
    | 'harmonization_campaign'   // trigger a harmonization campaign (Phase 5.6)
    | 'multi_step_campaign'      // trigger a multi-step repair campaign (Phase 5.5)
    | 'defer'                    // defer until more signals accumulate
    | 'escalate_human';          // require human review

/**
 * An immutable record of a system-level strategy decision for an incident cluster.
 */
export interface StrategyDecisionRecord {
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

// ─── Outcome Records ──────────────────────────────────────────────────────────

/**
 * An immutable record of the outcome of a cross-system strategy execution.
 *
 * Persisted to disk for retention and dashboard display.
 */
export interface CrossSystemOutcomeRecord {
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

// ─── Dashboard State ──────────────────────────────────────────────────────────

/**
 * KPI metrics for the Cross-System Intelligence Dashboard.
 */
export interface CrossSystemKpis {
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

/**
 * Full Cross-System Intelligence Dashboard state.
 * Pushed to the renderer via IPC channel crossSystem:dashboardUpdate.
 */
export interface CrossSystemDashboardState {
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

// ─── Bounds ───────────────────────────────────────────────────────────────────

/**
 * Hard limits for the Cross-System Intelligence Layer.
 * All limits are enforced at ingestion, clustering, and analysis time.
 */
export const CROSS_SYSTEM_BOUNDS = {
    /** Maximum signals retained in the active time window. */
    MAX_SIGNALS_PER_WINDOW: 200,
    /** Duration of the rolling signal window in milliseconds (4 hours). */
    SIGNAL_WINDOW_MS: 4 * 60 * 60 * 1000,
    /** Maximum number of signals in a single cluster. */
    MAX_CLUSTER_SIZE: 20,
    /** Maximum number of open clusters at any time. */
    MAX_CLUSTERS_OPEN: 10,
    /** Maximum root cause hypotheses generated per cluster. */
    MAX_ROOT_CAUSES_PER_CLUSTER: 3,
    /** Minimum signals required to form a cluster. */
    MIN_SIGNALS_TO_CLUSTER: 2,
    /** Maximum time gap between signals to consider them temporally proximate (30 min). */
    TEMPORAL_PROXIMITY_MS: 30 * 60 * 1000,
    /** Retention window for outcome records on disk (30 days). */
    OUTCOME_RETENTION_MS: 30 * 24 * 60 * 60 * 1000,
} as const;
