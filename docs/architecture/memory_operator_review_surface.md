# Memory Operator Review Surface

## Purpose

The Memory Operator Review surface is a read-focused, operator-facing panel in the Reflection Dashboard that exposes the full memory maintenance intelligence stack in one unified view.

It answers these questions clearly, without requiring the operator to inspect logs or raw telemetry:

- What is Tala's current memory posture?
- What recently went wrong?
- What repair actions happened and how effective were they?
- What is Tala currently prioritising?
- What does Tala recommend a human review or change?
- What backlog/dead-letter risks exist right now?
- Which subsystems are unstable?

---

## Architecture

### Data Flow

```
MemoryService.getHealthStatus()             → OperatorReviewHealth
MemoryRepairSchedulerService.getLastRun()   → recentRepair.lastRunAt, posture
MemoryRepairSchedulerService.getRecentRuns() → recentRepair.recentCycles (last 5)
MemoryRepairSchedulerService.getLatestInsightSummary()
    → summary.topFailureReasons
    → summary.unstableSubsystems
    → summary.keyFindings
    → recentRepair.actionEffectiveness
    → queues.deadLetters
MemoryRepairSchedulerService.getLatestAdaptivePlan() → adaptivePlan
MemoryRepairSchedulerService.getLatestSuggestionReport() → optimizationSuggestions
MemoryService.getDeferredWorkCounts()       → queues.extractionPending / embeddingPending / graphPending
          │
          ▼
MemoryOperatorReviewService.getModel()
    → MemoryOperatorReviewModel (serialisable, bounded, deterministic)
          │
          ▼
IPC: memory:getOperatorReviewModel
          │
          ▼
MemoryOperatorReviewPanel (renderer)
    A. Current Posture card
    B. Key Findings
    C. Adaptive Plan
    D. Optimization Suggestions (advisory only)
    E. Queue / Deferred Work
    F. Recent Repair Activity
    G. Notes / Safety
```

---

## Files

| File | Role |
|------|------|
| `shared/memory/MemoryOperatorReviewModel.ts` | Serialisable shared type for the operator review payload |
| `electron/services/memory/MemoryOperatorReviewService.ts` | Backend aggregator — assembles the model from existing service caches |
| `electron/services/memory/MemoryRepairSchedulerService.ts` | Now caches `_latestInsightSummary`, `_latestReflectionReport`, `_latestAdaptivePlan`, `_latestSuggestionReport`, and `_recentRuns` (ring buffer of last 5) |
| `electron/services/AgentService.ts` | Wires `MemoryOperatorReviewService`; exposes `getMemoryOperatorReviewModel()` and `runMemoryMaintenanceNow()` |
| `electron/services/IpcRouter.ts` | Registers `memory:getOperatorReviewModel` and `memory:runMaintenanceNow` IPC handlers |
| `electron/preload.ts` | Exposes `getMemoryOperatorReviewModel` and `runMemoryMaintenanceNow` on the `tala` bridge |
| `src/renderer/components/MemoryOperatorReviewPanel.tsx` | Operator review UI panel |
| `src/renderer/components/ReflectionPanel.tsx` | Hosts the panel as the `memory-health` engineering sub-tab |
| `tests/MemoryOperatorReviewModel.test.ts` | 16 unit tests (MOR-01 through MOR-10 + bonus cases) |

---

## MemoryOperatorReviewModel

The single payload type assembled on the backend and consumed by the renderer.

```typescript
type MemoryOperatorReviewModel = {
    generatedAt: string;                          // ISO-8601 UTC
    posture: 'stable' | 'watch' | 'unstable' | 'critical';

    health: {
        state: string;                            // MemorySubsystemState
        mode: string;                             // resolved runtime mode
        reasons: string[];                        // MemoryFailureReason[]
        hardDisabled: boolean;
        shouldTriggerRepair: boolean;
        shouldEscalate: boolean;
    };

    summary: {
        headline: string;                         // posture-derived one-liner
        keyFindings: string[];                    // from escalationCandidates
        topFailureReasons: Array<{ reason: string; count: number }>;  // top 5
        unstableSubsystems: Array<{ subsystem: string; count: number }>; // top 5
    };

    adaptivePlan: {                               // null if no run yet
        recommendedPrimaryAction: string;
        escalationBias: string;
        cadenceRecommendationMinutes: number;
        topPriorities: Array<{ target; score; reason }>;  // top 5
    } | null;

    optimizationSuggestions: {
        totalSuggestions: number;
        topSuggestions: Array<{                   // top 8, sorted by priorityScore desc
            id; category; title; summary; severity; priorityScore;
            recommendedHumanAction;               // from suggestion.rationale
            affectedSubsystems;
        }>;
    };

    queues: {
        extractionPending: number;
        embeddingPending: number;
        graphPending: number;
        deadLetters: Array<{ kind: string; count: number }>;
    };

    recentRepair: {
        lastRunAt?: string | null;
        recentCycles: Array<{                     // last 5, most recent first
            outcome; startedAt; completedAt; attemptedActions; skipped;
        }>;
        actionEffectiveness: Array<{              // top 5 by totalExecutions
            action; successRate; totalExecutions;
        }>;
    };

    notes: string[];                              // advisory-only reminders
};
```

---

## MemoryRepairSchedulerService — New Caching

`MemoryRepairSchedulerService.runNow()` now caches:

| Field | Type | Populated by |
|-------|------|-------------|
| `_latestInsightSummary` | `MemoryRepairInsightSummary \| null` | `analytics.generateSummary()` in each run |
| `_latestReflectionReport` | `MemoryRepairReflectionReport \| null` | `reflection.generateReport(summary)` |
| `_latestAdaptivePlan` | `MemoryAdaptivePlan \| null` | `planner.generatePlan(summary)` |
| `_latestSuggestionReport` | `MemoryOptimizationSuggestionReport \| null` | `suggestionSvc.generateReport(summary, plan)` |
| `_recentRuns` | `MemoryRepairScheduledRunResult[]` (ring buffer, max 5) | each completed run result |

**New public getters**: `getRecentRuns()`, `getLatestInsightSummary()`, `getLatestReflectionReport()`, `getLatestAdaptivePlan()`, `getLatestSuggestionReport()`.

---

## IPC Channels

| Channel | Direction | Description |
|---------|-----------|-------------|
| `memory:getOperatorReviewModel` | invoke | Returns the current `MemoryOperatorReviewModel`. Read-only, safe to call repeatedly. |
| `memory:runMaintenanceNow` | invoke | Triggers an immediate memory maintenance analytics run. Human-gated; does not change any settings. |

---

## UI Panel

Accessible via the **🧠 Memory Health** sub-tab in the Engineering panel of the Reflection Dashboard.

### Sections

| Section | Data source | Description |
|---------|-------------|-------------|
| A. Current Posture | `model.posture`, `model.health`, `model.summary.headline` | Prominent posture badge + hard-disabled indicator + one-line headline |
| B. Key Findings | `model.summary` | Top failure reasons, unstable subsystems, escalation candidate bullets |
| C. Adaptive Plan | `model.adaptivePlan` | Primary action, escalation bias, cadence, priority targets with scores |
| D. Optimization Suggestions | `model.optimizationSuggestions` | Advisory-only; clearly labeled; no auto-apply controls |
| E. Queue / Deferred Work | `model.queues` | Pending counts per kind, dead-letter counts |
| F. Recent Repair Activity | `model.recentRepair` | Last 5 scheduler cycles, action effectiveness summary |
| G. Notes / Safety | `model.notes` | Advisory-only reminders at the bottom of the panel |

### Controls

- **↻ Refresh Review** — re-fetches the current model from the backend (reads cached state, no re-analysis).
- **⚡ Run Analysis Now** — triggers an immediate `MemoryRepairSchedulerService.runNow('operator_manual')` then refreshes the view. Human-gated.

No controls auto-apply suggestions, change provider settings, change integrity mode, or modify thresholds.

---

## Bounding Rules

| Data | Limit |
|------|-------|
| Top failure reasons | 5 |
| Unstable subsystems | 5 |
| Optimization suggestions | 8 |
| Adaptive priority targets | 5 |
| Recent repair cycles | 5 (most recent first) |
| Action effectiveness entries | 5 (by total executions desc) |

Sorting is stable and deterministic: primary key first, then lexical tie-break on IDs/names.

---

## Invariants

1. **Read-only** — no mutations occur when assembling or displaying the model.
2. **Advisory** — all optimization suggestions are human-gated recommendations only.
3. **Bounded** — no raw telemetry dumps; all lists are capped.
4. **No architecture bypass** — the UI consumes existing scheduler/analytics outputs; no analytics logic is embedded in the renderer.
5. **Deterministic** — same backend state → same rendered model (excluding `generatedAt`).
6. **Graceful degradation** — if no scheduled run has completed yet, all optional sections render a safe empty state.

---

## Tests

Tests live in `tests/MemoryOperatorReviewModel.test.ts` (16 tests).

| Test ID | Coverage |
|---------|----------|
| MOR-01 | Critical posture assembles correctly with headline, reasons, hard-disabled flag |
| MOR-02 | Adaptive plan included and priorities preserved in plan order |
| MOR-03 | Optimization suggestions capped at 8, sorted by priorityScore desc then id asc |
| MOR-04 | Queue stats and dead-letter counts appear correctly |
| MOR-05 | Recent cycles bounded to 5, most recent first |
| MOR-06 | Stable posture renders with low-noise state |
| MOR-07 | Advisory notes present and contain advisory language |
| MOR-08 | Missing optional sections degrade gracefully |
| MOR-08b | Model assembles safely when scheduler is null |
| MOR-09 | `getModel()` called twice returns independent objects |
| MOR-10 | Same inputs produce same ordering |
| MOR-BOUND | Failure reasons bounded to top 5 and sorted correctly |
| MOR-EFF | Action effectiveness bounded to top 5 and sorted correctly |
| MOR-SCHED-01 | Scheduler getters return null before first run |
| MOR-SCHED-02 | Ring buffer caps at 5 entries |
| MOR-SCHED-03 | `getRecentRuns()` returns a copy (mutation-safe) |
