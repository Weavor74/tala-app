# Memory Repair Scheduled Loop

## Overview

This document describes the scheduled memory repair analytics and self-maintenance loop introduced alongside the existing `MemoryRepairAnalyticsService` and `MemoryRepairReflectionService`.

The loop answers: **"What does recent memory repair history say about current health, and what bounded actions should be taken on a schedule?"**

---

## Architecture

### Service Topology

```
MemoryRepairOutcomeRepository (persistent DB)
          │
          ▼
MemoryRepairAnalyticsService.generateSummary(windowHours)
          │
          ▼
MemoryRepairReflectionService.generateReport(summary)
          │
          ▼
MemorySelfMaintenanceService.evaluate(summary, report)
          │
          ▼
MemoryRepairSchedulerService (drives the loop)
  ├─ emit_escalation  → TelemetryBus (memory.maintenance_escalation)
  ├─ trigger_repair   → MemoryRepairTriggerService.emitDirect()
  ├─ prioritize_replay → DeferredMemoryReplayService.drain()
  └─ publish_report   → TelemetryBus (memory.maintenance_decision)
```

All output is expressed as telemetry events or delegated to existing bounded services.  No provider settings, integrity mode, or user configuration is changed.

---

## Files

| File | Role |
|------|------|
| `electron/services/memory/MemoryRepairSchedulerService.ts` | Periodic driver: runs analytics → reflection → decision on a fixed cadence |
| `electron/services/memory/MemorySelfMaintenanceService.ts` | Pure threshold-based decision layer |
| `shared/memory/MemoryMaintenanceState.ts` | Serialisable types: `MemoryRepairScheduledRunResult`, `MemoryMaintenanceDecision`, `MemoryMaintenancePosture`, `MemoryMaintenanceAction` |
| `tests/MemoryRepairScheduler.test.ts` | 40 unit tests (MRS01–MRS40) |

---

## Scheduled Run Cadence

| Parameter | Default | Notes |
|-----------|---------|-------|
| `intervalMs` | 10 minutes | Fixed in this pass; configurable via `SchedulerConfig` |
| `windowHours` | 24 hours | Analytics look-back window |
| Concurrency guard | One run at a time | Overlapping calls are skipped, not queued |

---

## Posture Model

`MemorySelfMaintenanceService` derives one of four postures from analytics + reflection output:

| Posture | Condition |
|---------|-----------|
| `stable` | No recurring failures, no dead-letter items, no actionable recommendations |
| `watch` | Minor signals: single recurring failure, dead-letter items, or non-informational recommendations |
| `unstable` | Recurring failures ≥ threshold (default 2) or at least one escalation candidate |
| `critical` | Report has critical findings or escalation candidates ≥ critical threshold (default 2) |

---

## Actions

Actions are taken only when patterns cross explicit thresholds:

| Action | When | Mechanism |
|--------|------|-----------|
| `emit_escalation` | Posture is `unstable` or `critical` AND escalation candidate count ≥ threshold | `TelemetryBus.emit('memory.maintenance_escalation', …)` |
| `trigger_repair` | Posture is `unstable`/`critical` AND recurring failures ≥ threshold | `MemoryRepairTriggerService.emitDirect(…)` |
| `prioritize_replay` | Dead-letter count ≥ threshold (default 1) | `DeferredMemoryReplayService.drain()` |
| `publish_report` | Always (every run) | `TelemetryBus.emit('memory.maintenance_decision', …)` |

### Strict Invariants

- Provider settings are never changed by this layer.
- Integrity mode is never changed by this layer.
- `MemoryIntegrityPolicy` remains the sole authority over capability gating.
- Strict mode is respected; no "pretend success" on partial restoration.

---

## Telemetry Events

Five new `RuntimeEventType` values added to `shared/runtimeEventTypes.ts`:

| Event | When Emitted |
|-------|-------------|
| `memory.maintenance_run_started` | At the beginning of each `runNow()` call |
| `memory.maintenance_run_completed` | After a successful run; includes posture, actionsTaken, counts |
| `memory.maintenance_run_skipped` | When a run is skipped (another in flight, or error) |
| `memory.maintenance_decision` | After every completed run; includes the full decision payload |
| `memory.maintenance_escalation` | When `shouldEscalate=true`; includes escalation candidate codes and critical recommendations |

---

## Wiring in AgentService

`MemoryRepairSchedulerService` is constructed and started inside `AgentService._wireRepairExecutor()` after the `MemoryRepairOutcomeRepository` is successfully created:

```
_wireRepairExecutor()
  └─ if pool available:
       outcomeRepo = new MemoryRepairOutcomeRepository(pool)
       this._repairScheduler = new MemoryRepairSchedulerService(outcomeRepo)
  └─ (after all repair handlers registered)
       executor.start()
       this._repairScheduler?.start()
```

`AgentService.shutdown()` calls `this._repairScheduler?.stop()` to clear the interval.

If the database pool is unavailable (canonical memory not wired), `_repairScheduler` remains `null` and the scheduler is not started.

---

## Result Model

Each run produces a `MemoryRepairScheduledRunResult`:

```typescript
type MemoryRepairScheduledRunResult = {
    startedAt: string;        // ISO-8601
    completedAt: string;      // ISO-8601
    windowHours: number;
    posture: MemoryMaintenancePosture;
    actionsTaken: string[];   // e.g. ['emit_escalation', 'trigger_repair']
    escalationCount: number;
    recommendationCount: number;
    skipped?: boolean;
    reason?: string;          // populated when skipped=true
};
```

The last run result is accessible via `MemoryRepairSchedulerService.getLastRun()`.

---

## Safety Model

| Absolute Constraints |
|---------------------|
| No auto-changing provider settings |
| No auto-changing integrity mode |
| No mutating user configuration |
| No runaway loops — concurrency guard prevents overlapping runs |
| No action on isolated single events — patterns must recur (threshold-based) |
| Analytics and decisions are deterministic — same data produces same output |
