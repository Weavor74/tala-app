# Phase 6 — Cross-System Intelligence

## Overview

Phase 6 enables Tala to reason beyond individual subsystems and isolated repair goals.
It aggregates signals from across the entire autonomous stack, groups related failures into incident clusters, generates deterministic root cause hypotheses, and selects system-level strategies.

This phase is **not** autonomous large-scale refactoring. It is bounded, auditable, deterministic pattern recognition that surfaces systemic issues for the existing planning, governance, and execution layers to handle.

---

## Design Principles

1. **No model calls** — all clustering, scoring, and strategy selection is rule-based.
2. **No bypassing of planning/governance/execution** — every strategy decision becomes a normal goal or proposal that flows through SafeChangePlanner → GovernanceAppService → ExecutionOrchestrator.
3. **Bounded at every layer** — signal windows, cluster sizes, root cause hypotheses, and open cluster counts all have hard caps enforced by `CROSS_SYSTEM_BOUNDS`.
4. **Deterministic and reproducible** — the same signals always produce the same clusters, hypotheses, and strategy choices.
5. **Auditable** — every cluster, hypothesis, decision, and outcome is recorded with timestamps and rationale.
6. **Local-first** — all state is persisted to disk in `<dataDir>/autonomy/cross_system/`.
7. **Incremental and safe** — Phase 6 is optional; the system degrades gracefully if its services are not injected.
8. **Prefer smallest effective scope** — `targeted_repair` beats `multi_step_campaign` beats `escalate_human`; escalation is always the safe fallback.

---

## Architecture Layers

```
Subsystems emit signals via AutonomousRunOrchestrator.ingestCrossSystemSignal()
    ↓ (CrossSystemSignal)
CrossSystemSignalAggregator (P6B)
    — bounded windowed buffer (4h, 200 signals max)
    — dedup: same sourceType+subsystem+failureType within 5 min
    ↓ (CrossSystemSignal[])
IncidentClusteringEngine (P6C)
    — 5 clustering criteria: subsystem, files, failure_type, temporal, repeated_pattern
    — MAX_CLUSTER_SIZE=20, MAX_CLUSTERS_OPEN=10
    ↓ (IncidentCluster[])
RootCauseAnalyzer (P6D)
    — 4 scoring factors: signal_frequency, subsystem_spread, failure_consistency, recurrence
    — 6 root cause categories, MAX_ROOT_CAUSES_PER_CLUSTER=3
    ↓ (RootCauseHypothesis[])
CrossSystemStrategySelector (P6E)
    — 9 deterministic rules, smallest-scope preference
    ↓ (StrategyDecisionRecord)
CrossSystemCoordinator (P6F) — routes decisions back to planning layer
    ↓ (goal/proposal via AutonomousRunOrchestrator)
SafeChangePlanner (Phase 2) → GovernanceAppService (Phase 3.5) → ExecutionOrchestrator (Phase 3)
    ↓
CrossSystemOutcomeTracker (P6G)
    ↓
CrossSystemDashboardBridge (P6H) → crossSystem:dashboardUpdate IPC
```

---

## Subphases Implemented

### P6A — Cross-System Signal Contracts
**File:** `shared/crossSystemTypes.ts`

All canonical shared contracts. Key types:
- `CrossSystemSignal` — a single signal from any subsystem
- `SignalSourceType` — 8 sources: execution_failure, verification_failure, governance_block, harmonization_drift, escalation_attempt, recovery_pack_exhausted, cooldown_breach, campaign_failure
- `IncidentCluster` — a group of correlated signals
- `ClusterId`, `CrossSystemSignalId`, `RootCauseId` — stable string ID types with prefixes
- `RootCauseHypothesis` — a scored candidate root cause for a cluster
- `RootCauseScoringFactor` — individual factor contributing to a hypothesis score
- `CrossSystemStrategyKind` — 5 strategies: targeted_repair, harmonization_campaign, multi_step_campaign, defer, escalate_human
- `StrategyDecisionRecord` — immutable record of a strategy selection decision
- `CrossSystemOutcomeRecord` — result of executing a strategy
- `CrossSystemDashboardState`, `CrossSystemKpis` — dashboard state and KPIs
- `CROSS_SYSTEM_BOUNDS` — hard safety caps

### P6B — Signal Aggregation Engine
**File:** `electron/services/autonomy/crossSystem/CrossSystemSignalAggregator.ts`

Windowed in-memory buffer for cross-system signals. Enforces `MAX_SIGNALS_PER_WINDOW` (200) and `SIGNAL_WINDOW_MS` (4h). Deduplicates signals with the same `sourceType+subsystem+failureType` within 5 minutes. Provides query methods by subsystem and source type.

### P6C — Incident Clustering Engine
**File:** `electron/services/autonomy/crossSystem/IncidentClusteringEngine.ts`

Groups signals into bounded clusters using 5 criteria (applied in order, union):
1. `shared_subsystem` — same subsystem
2. `shared_files` — overlapping `affectedFiles`
3. `shared_failure_type` — same `failureType`
4. `temporal_proximity` — within `TEMPORAL_PROXIMITY_MS` (30 min)
5. `repeated_pattern` — same `sourceType+subsystem` appears ≥3 times

Safety bounds: `MAX_CLUSTER_SIZE=20`, `MAX_CLUSTERS_OPEN=10`, `MIN_SIGNALS_TO_CLUSTER=2`.
Merges new signals into existing open clusters before creating new ones. Overflow signals are dropped.
Every cluster records its `clusteringCriteria` for explainability.

### P6D — Root Cause Analysis Engine
**File:** `electron/services/autonomy/crossSystem/RootCauseAnalyzer.ts`

Deterministic root cause analysis using 4 scoring factors:

| Factor | Max Contribution | Description |
|--------|-----------------|-------------|
| `signal_frequency` | 40 | Normalized signal count vs MAX_CLUSTER_SIZE |
| `subsystem_spread` | 20 | Number of distinct subsystems |
| `failure_consistency` | 20 | Fraction of signals with the same failureType |
| `recurrence` | 20 | Signals span > TEMPORAL_PROXIMITY_MS |

Six root cause categories with heuristic classification rules:
- `structural_drift` — dominant source is `harmonization_drift`
- `repeated_execution_error` — same subsystem + same failure type + high frequency
- `cross_subsystem_dependency` — >1 subsystem AND same failure type
- `policy_boundary_gap` — dominant source is `governance_block` AND frequency ≥ 3
- `campaign_scope_mismatch` — dominant source is `campaign_failure`
- `unknown` — default when no rule matches

Confidence is `score / 100`. Output is sorted by score descending and capped at `MAX_ROOT_CAUSES_PER_CLUSTER=3`.

### P6E — System-Level Strategy Selection
**File:** `electron/services/autonomy/crossSystem/CrossSystemStrategySelector.ts`

Maps root cause hypotheses to system-level strategies using 9 deterministic rules (in priority order):

1. confidence < 0.30 → `defer`
2. score < 25 → `defer`
3. severity=high AND subsystems > 2 → `escalate_human`
4. category=`structural_drift` → `harmonization_campaign`
5. category=`campaign_scope_mismatch` → `multi_step_campaign`
6. category=`policy_boundary_gap` → `escalate_human`
7. category=`cross_subsystem_dependency` AND subsystems > 1 → `multi_step_campaign`
8. category=`repeated_execution_error` AND score ≥ 50 → `targeted_repair`
9. Default → `defer`

Produces a `StrategyDecisionRecord` with rationale, alternatives considered, and policy constraints.

### P6F — Integration / Coordinator
**File:** `electron/services/autonomy/crossSystem/CrossSystemCoordinator.ts`

Orchestrates the full pipeline. Responsibilities:
- Accept signals from `AutonomousRunOrchestrator.ingestCrossSystemSignal()`
- Persist cluster, root cause, and decision state to disk
- Run analysis pipeline (cluster → root cause → strategy) on a 10-minute loop
- Re-entrancy guarded — only one analysis pass runs at a time
- Serves `getDashboardState()` for IPC queries

Disk storage:
- `<dataDir>/autonomy/cross_system/clusters.json`
- `<dataDir>/autonomy/cross_system/root_causes.json`
- `<dataDir>/autonomy/cross_system/decisions.json`

### P6G — Outcome Tracking
**File:** `electron/services/autonomy/crossSystem/CrossSystemOutcomeTracker.ts`

Append-only disk-persisted outcome records. Each `CrossSystemOutcomeRecord` captures the strategy used, whether it succeeded, and whether the cluster recurred. `markRecurred(clusterId)` updates the most recent outcome for a cluster when re-occurrence is detected. Records older than `OUTCOME_RETENTION_MS` (30d) are purged.

Storage: `<dataDir>/autonomy/cross_system/outcomes/<outcomeId>.json`

### P6H — Reflection Dashboard Integration
**File:** `electron/services/autonomy/crossSystem/CrossSystemDashboardBridge.ts`

Milestone-gated IPC push. Permitted milestones: `signals_ingested`, `cluster_formed`, `root_cause_analyzed`, `strategy_decided`, `outcome_recorded`. Deduplicates pushes using a state hash. Channel: `crossSystem:dashboardUpdate`.

### IPC App Service
**File:** `electron/services/autonomy/CrossSystemAppService.ts`

Registers 6 IPC handlers under the `crossSystem:*` namespace:
- `crossSystem:getDashboardState`
- `crossSystem:getClusters`
- `crossSystem:getCluster` (clusterId)
- `crossSystem:getRootCauses` (clusterId)
- `crossSystem:getRecentDecisions`
- `crossSystem:recordOutcome` (outcomeId, clusterId, succeeded, notes)

---

## Integration Points

### Signal ingestion
Signals are ingested via `AutonomousRunOrchestrator.ingestCrossSystemSignal(signal)`. This is called:
- At the end of each autonomous run (in the `finally` block) if a failure occurred
- From harmonization and campaign hooks when drift or failures are detected

### Strategy routing
`CrossSystemStrategySelector` decisions become standard goals/proposals that flow through the existing Phase 2/3.5/3 pipeline — there is no bypass.

### main.ts wiring
```
// Phase 6: Cross-System Intelligence
try {
    const crossSystemCoordinator = new CrossSystemCoordinator(
        USER_DATA_DIR, aggregator, clusteringEngine, rootCauseAnalyzer,
        strategySelector, outcomeTracker, dashboardBridge,
    );
    autonomousRunOrchestrator.setCrossSystemServices(crossSystemCoordinator);
    new CrossSystemAppService(crossSystemCoordinator);
    setInterval(() => crossSystemCoordinator.runAnalysis(), 10 * 60 * 1000);
} catch (err) { ... }
```

### preload.ts
The `tala.crossSystem.*` namespace is exposed to the renderer with `crossSystem:dashboardUpdate` registered in the valid IPC channels.

---

## Safety Bounds

| Bound | Value | Enforced By |
|-------|-------|-------------|
| MAX_SIGNALS_PER_WINDOW | 200 | CrossSystemSignalAggregator |
| SIGNAL_WINDOW_MS | 4 hours | CrossSystemSignalAggregator |
| DEDUP_WINDOW_MS | 5 minutes | CrossSystemSignalAggregator |
| MAX_CLUSTER_SIZE | 20 signals | IncidentClusteringEngine |
| MAX_CLUSTERS_OPEN | 10 clusters | IncidentClusteringEngine |
| MIN_SIGNALS_TO_CLUSTER | 2 | IncidentClusteringEngine |
| TEMPORAL_PROXIMITY_MS | 30 minutes | IncidentClusteringEngine |
| MAX_ROOT_CAUSES_PER_CLUSTER | 3 | RootCauseAnalyzer |
| OUTCOME_RETENTION_MS | 30 days | CrossSystemOutcomeTracker |
| Analysis interval | 10 minutes | electron/main.ts |

---

## Test Coverage

**File:** `tests/autonomy/CrossSystemPhase6.test.ts`

76 tests covering:
- P6A: Type shapes and bounds constants
- P6B: Signal ingestion, dedup, windowing, subsystem/source filtering, bounds enforcement
- P6C: All 5 clustering criteria, cluster merging, MIN/MAX bounds, label generation, dedup
- P6D: Hypothesis generation, score range, sorting, category heuristics, scoring factors
- P6E: All 9 strategy rules, rationale, alternatives, smallest-scope preference, empty-hypothesis fallback
- P6G: Record, retrieve, persist, markRecurred, purgeExpired, cross-instance persistence
- P6H: buildState, KPI computation, deduplication, resetDedupHash, milestone gating
- P6F: Full pipeline, re-entrancy guard, cluster persistence, getRootCauses, getRecentDecisions
- P6I: All safety bounds enforced

---

## Relationship to Prior Phases

| Phase | Relationship |
|-------|-------------|
| Phase 4 (autonomy) | Run failures emit `execution_failure` signals |
| Phase 4.3 (recovery packs) | Pack exhaustion emits `recovery_pack_exhausted` signals |
| Phase 5.1 (escalation) | Escalation attempts emit `escalation_attempt` signals |
| Phase 5.5 (repair campaigns) | Campaign failures emit `campaign_failure` signals |
| Phase 5.6 (harmonization) | Drift records emit `harmonization_drift` signals |
| Phase 3.5 (governance) | Repeated blocks emit `governance_block` signals |
| Phase 2 (planning) | Strategy decisions route through SafeChangePlanner |
| Phase 3 (execution) | All strategy executions require execution eligibility |

---

## Current Limitations

- Signal emission from individual subsystems (Phase 4/4.3/5.1/5.5/5.6) is not yet wired at the call site — `ingestCrossSystemSignal()` is available but the upstream hooks need to be added per-subsystem in a follow-up task.
- Strategy decisions do not yet automatically create `AutonomousGoal` instances; this routing is deferred to a follow-up integration task.
- The `repeated_pattern` clustering criterion (same sourceType+subsystem appearing ≥3 times) is based on simple frequency counting and does not yet account for inter-signal time gaps within the cluster.
