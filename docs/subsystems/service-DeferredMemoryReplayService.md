# Service: DeferredMemoryReplayService.ts

**Source**: [electron/services/memory/DeferredMemoryReplayService.ts](../../electron/services/memory/DeferredMemoryReplayService.ts)

## Overview

`DeferredMemoryReplayService` manages the lifecycle of deferred memory tasks that could not
execute immediately because a required capability (extraction, embeddings, graph projection) was
unavailable at write time.

It is the replay counterpart to `DeferredMemoryWorkRepository`.  The repository handles raw SQL
CRUD; this service handles bounded batching, health-gated routing, and telemetry.

## Architecture Position

```
AgentService.storeMemories() — suppressed write paths
        ↓ enqueue(kind, canonicalMemoryId, payload)
DeferredMemoryReplayService
        ↓ persists to deferred_memory_work (via DeferredMemoryWorkRepository)

MemoryRepairExecutionService.drain_deferred_work action
        ↓ invokes drain_callback → DeferredMemoryReplayService.drain()
DeferredMemoryReplayService
        ↓ checks health (MemoryHealthStatus.capabilities)
        ↓ claimBatch(batchSize, eligibleKinds)
        ↓ per-kind handler (registered via registerHandler)
        ↓ markCompleted / markFailed (with exponential backoff)
        ↓ telemetry events
```

## Class: `DeferredMemoryReplayService`

Singleton.  Obtain via `DeferredMemoryReplayService.getInstance()`.

### Configuration

| Method | Description |
|--------|-------------|
| `setRepository(repo)` | Inject `DeferredMemoryWorkRepository`.  Must be set before enqueue or drain. |
| `setHealthStatusProvider(provider)` | Inject `() => MemoryHealthStatus`. |
| `registerHandler(kind, handler)` | Register `async (item) => Promise<boolean>` for a work kind.  If no handler is registered for a claimed item, it is failed with `no_handler_registered`. |

### Public API

| Method | Returns | Description |
|--------|---------|-------------|
| `enqueue(input)` | `Promise<string \| null>` | Persist a new pending work item.  Returns the generated UUID or null on error / missing repository. |
| `drain(batchSize?)` | `Promise<void>` | Drain up to `batchSize` (default 25) eligible pending items.  Health-gated — no-op when canonical is unhealthy or no eligible kinds remain. |
| `getStats()` | `Promise<DeferredWorkStats \| null>` | Aggregate queue counts by kind and status.  Returns null when repository is unavailable. |

### Drain Health Gates

| Capability | Controls |
|------------|---------|
| `capabilities.canonical` | Drain blocked entirely when false |
| `capabilities.extraction` | Only `extraction` items eligible when true |
| `capabilities.embeddings` | Only `embedding` items eligible when true |
| `capabilities.graphProjection` | Only `graph_projection` items eligible when true |

## Work Kinds

| Kind | Deferred when | Replays by calling |
|------|--------------|-------------------|
| `extraction` | `!memHealth.capabilities.extraction` during mem0 write suppression | Registered `extraction` handler |
| `embedding` | `!memHealth.capabilities.embeddings` after canonical write | Registered `embedding` handler |
| `graph_projection` | `!allowGraphWrite` during graph write suppression | Registered `graph_projection` handler |

## Invariants

| Invariant | Detail |
|-----------|--------|
| **Persistent** | Work items stored in Postgres — survive crash/restart. |
| **Bounded** | Max `DRAIN_BATCH_SIZE` (25) items per drain call. |
| **Policy-gated** | Capability flags from `MemoryHealthStatus` gate each work kind. |
| **No canonical bypass** | Drain halts when `capabilities.canonical = false`. |
| **Idempotent** | Completed items are never re-processed.  Atomic `FOR UPDATE SKIP LOCKED` prevents double-claim. |
| **Backoff** | Failed items: next_attempt_at = NOW() + min(3600s, 30s × 2^attempt_count).  After maxAttempts (default 3): promoted to `dead_letter`. |
| **Concurrency** | Internal `_draining` flag prevents overlapping drain calls. |

## Telemetry Events Emitted

| Event | Payload |
|-------|---------|
| `memory.deferred_work_enqueued` | `id`, `kind`, `canonicalMemoryId`, `sessionId`, `turnId` |
| `memory.deferred_work_drain_started` | `eligibleKinds`, `batchSize`, `healthState` |
| `memory.deferred_work_item_completed` | `id`, `kind`, `canonicalMemoryId`, `attemptCount` |
| `memory.deferred_work_item_failed` | `id`, `kind`, `canonicalMemoryId`, `attemptCount`, `maxAttempts`, `error` |
| `memory.deferred_work_drain_completed` | `eligibleKinds`, `completed`, `failed`, `healthState` |

## Database

Table: `deferred_memory_work` — created by migration `012_deferred_memory_work.sql`.

Key columns: `id` (UUID PK), `kind`, `status`, `canonical_memory_id`, `session_id`, `turn_id`,
`payload` (JSONB), `attempt_count`, `max_attempts`, `last_error`, `next_attempt_at`, `created_at`,
`updated_at`, `completed_at`, `dead_lettered_at`.

## Tests

`tests/DeferredMemoryReplay.test.ts` — 29 tests (DMR01–DMR40)

Covers: singleton/lifecycle, enqueue (persistence, telemetry, error handling), drain health gating
(canonical check, per-kind eligibility, concurrent drain guard), item completion/failure/dead-letter,
telemetry emission, and stats/observability.
