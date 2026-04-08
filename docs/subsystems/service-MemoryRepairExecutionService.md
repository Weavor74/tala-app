# Service: MemoryRepairExecutionService.ts

**Source**: [electron/services/memory/MemoryRepairExecutionService.ts](../../electron/services/memory/MemoryRepairExecutionService.ts)

## Overview

`MemoryRepairExecutionService` is the memory repair execution layer for Tala.  It consumes
`memory.repair_trigger` events from `TelemetryBus` and attempts bounded, deterministic recovery
actions when the memory subsystem enters a degraded or critical state.

This service is a **repair executor, not a rewriter**.  It does not redesign the memory
architecture, move provider selection into mem0, or create a free-running autonomous process.
It executes one repair action at a time, re-evaluates health after each action, and stops when
the subsystem returns to an acceptable state (`healthy` or `reduced`).

## Architecture Position

```
MemoryRepairTriggerService  →  memory.repair_trigger (TelemetryBus)
                                          ↓
                          MemoryRepairExecutionService
                                          ↓
                       _buildRepairPlan(MemoryHealthStatus)
                                          ↓
                       execute actions serially (registered handlers)
                                          ↓
                       re-evaluate via setHealthStatusProvider
                                          ↓
              emit: repair_started / repair_action_* / repair_completed
                                          ↓
                       drain deferred work (if canonical healthy)
```

## Class: `MemoryRepairExecutionService`

Singleton.  Obtain via `MemoryRepairExecutionService.getInstance()`.

### Lifecycle

| Method | Description |
|--------|-------------|
| `start()` | Subscribe to `memory.repair_trigger` events.  Idempotent — safe to call multiple times. |
| `stop()` | Unsubscribe from `TelemetryBus`.  Does not abort an in-progress cycle. |
| `reset()` | Clear all state, handlers, and provider references.  Intended for tests. |

### Configuration (must be wired before first cycle)

| Method | Description |
|--------|-------------|
| `setHealthStatusProvider(provider)` | Inject `() => MemoryHealthStatus` (typically `() => memoryService.getHealthStatus()`). |
| `registerRepairHandler(action, handler)` | Register `async () => Promise<boolean>` for a specific `RepairActionKind`.  Actions without a registered handler are skipped. |
| `setDeferredWorkDrainCallback(cb)` | Optional.  Called after recovery when canonical is healthy to drain the deferred-work backlog. |

### Public API

| Method | Returns | Description |
|--------|---------|-------------|
| `handleRepairTrigger(trigger)` | `Promise<MemoryRepairCycleResult>` | Entry point from TelemetryBus subscription.  Applies cooldown guard before starting a cycle. |
| `runRepairCycle(reason?)` | `Promise<MemoryRepairCycleResult>` | Directly run a repair cycle.  Bypasses cooldown (but respects storm prevention). |
| `getState()` | `MemoryRepairExecutorState` | Snapshot of executor state: `isRunning`, `cycleCount`, `lastOutcome`, `attemptCounters`. |

## Repair Action Kinds

| Action | Triggered by |
|--------|-------------|
| `reconnect_canonical` | `canonical_unavailable` |
| `reinit_canonical` | `canonical_init_failed` |
| `reconnect_mem0` | `mem0_unavailable`, `mem0_mode_canonical_only` |
| `re_resolve_providers` | `extraction_provider_unavailable`, `embedding_provider_unavailable`, `runtime_mismatch` |
| `reconnect_graph` | `graph_projection_unavailable` |
| `reconnect_rag` | `rag_logging_unavailable` |
| `drain_deferred_work` | Built-in — drains backlog when canonical is healthy (no handler needed) |
| `re_evaluate_health` | Built-in — forces health re-evaluation (no handler needed) |

## Repair Plan

The plan is deterministic: the same `MemoryHealthStatus` always produces the same ordered action list.

**Priority order:**
1. Canonical failures (`reconnect_canonical`, `reinit_canonical`)
2. mem0 failures (`reconnect_mem0`)
3. Provider resolution failures (`re_resolve_providers`)
4. Auxiliary failures (`reconnect_graph`, `reconnect_rag`)
5. Always appended: `re_evaluate_health` (when plan has real actions)
6. Always appended: `drain_deferred_work` (when canonical is available)

## Invariants

| Invariant | Detail |
|-----------|--------|
| **Bounded** | Max 3 attempts per action kind (session total).  30s cooldown per reason.  Max 10 cycles / hour. |
| **Canonical authority** | Deferred-work drain runs only when `capabilities.canonical = true`. |
| **Deterministic** | Same failure state → same action order. |
| **Observable** | Structured telemetry events emitted before and after each action and cycle. |
| **Strict-mode aware** | `hardDisabled = true` + `state = disabled` + non-canonical reason → cycle returns `failed` immediately without attempting partial recovery. |

## Telemetry Events Emitted

| Event | Payload |
|-------|---------|
| `memory.repair_started` | `cycleId`, `reason`, `initialState`, `initialMode`, `reasons`, `hardDisabled` |
| `memory.repair_action_started` | `cycleId`, `action` |
| `memory.repair_action_completed` | `cycleId`, `action`, `success`, `durationMs`, `error?` |
| `memory.repair_completed` | `cycleId`, `outcome`, `reason`, `finalState`, `durationMs`, `actionsCount`, `actionsSucceeded` |

## Result Types

### `MemoryRepairCycleResult`

```typescript
{
  cycleId: string;
  outcome: 'recovered' | 'partial' | 'failed' | 'skipped';
  reason: string;
  actionsExecuted: RepairActionResult[];
  finalState: MemorySubsystemState;
  durationMs: number;
}
```

### `MemoryRepairExecutorState`

```typescript
{
  isRunning: boolean;
  lastRunAt?: string;
  lastOutcome?: MemoryRepairCycleOutcome;
  activeReason?: string;
  attemptCounters: Record<string, number>;
  cycleCount: number;
  lastCycleId?: string;
}
```

## Integration Example (AgentService / main.ts)

```typescript
const repairSvc = MemoryRepairExecutionService.getInstance();
repairSvc.setHealthStatusProvider(() => memoryService.getHealthStatus());
repairSvc.registerRepairHandler('reconnect_canonical', async () => {
    // attempt Postgres reconnection; return true on success
});
repairSvc.registerRepairHandler('reconnect_mem0', async () => {
    // attempt mem0 MCP client reconnection; return true on success
});
repairSvc.setDeferredWorkDrainCallback(() => {
    memoryService.resetDeferredWork({ extraction: true, embedding: true, projection: true });
    // re-queue deferred work items here
});
repairSvc.start(); // subscribe to memory.repair_trigger
```

## Tests

`tests/MemoryRepairExecutionService.test.ts` — 40 tests (MRE01–MRE40)

Covers: singleton/lifecycle, plan building (deterministic/capability-aware), cycle execution
(bounded/observable), cooldown and storm prevention, deferred work drain, strict-mode handling,
and telemetry emission.
