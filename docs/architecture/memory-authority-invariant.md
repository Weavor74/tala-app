# Memory Authority Invariant

## Canonical Truth Boundary
- PostgreSQL `memory_records` is Tala's only canonical durable memory authority.
- No memory is authoritative unless accepted and committed to canonical Postgres with a canonical `memory_id`.
- mem0, graph, vectors, summaries, caches, and retrieval projections are derived layers only.
- `MemoryAuthorityService` is the only allowed durable mutation boundary.
- `MemoryService` is hard-locked against legacy durable mutation APIs (`add`, `update`, `delete`).

## Lifecycle
1. Event observed.
2. Candidate memory proposed.
3. `MemoryAuthorityService` decides: accept, reject, merge, or defer.
4. Accepted memory is committed canonically in Postgres.
5. Derived projections are updated from canonical state.

Rejected or deferred candidates must not be surfaced as durable truth.

## Enforcement
- Durable memory writes must go through `MemoryAuthorityService`.
- Derived writes require canonical anchors (`canonical_memory_id`).
- `MemoryService` derived mutation surfaces are canonical-status validated and scoped to projection sync/removal only.
- Tombstones originate from canonical state and propagate outward.
- Authoritative recall must resolve to canonical IDs.
- Derived layers are rebuildable from canonical Postgres state.

## Operational Checks
- Integrity validation detects orphan projections, stale projections, duplicate canonical conflicts, and tombstone violations.
- Rebuild flows execute canonical-to-derived synchronization for `mem0`, `graph`, and `vector` projection metadata in `memory_projections`.
- Rebuild supports scoped execution by canonical ID, canonical ID list, stale-only mode, and full rebuild mode.
- Tombstoned/superseded canonical records are propagated as stale derived projections and are never restored as active truth.

## Legacy Backfill Recovery
- Legacy/local memory records without canonical IDs are suppressed from authoritative recall until backfilled.
- Canonical backfill runs through `LegacyMemoryBackfillService` and must canonicalize via `MemoryAuthorityService`.
- Backfill supports scoped execution (`legacyMemoryId`, `legacyMemoryIds`, `fullBackfill`) and optional `dryRun`.
- Eligible legacy records are canonicalized or linked to existing canonical records, then re-anchored with `canonical_memory_id`.
- Ambiguous/invalid/inactive legacy records are skipped or quarantined with explicit reasons; they are never silently promoted.
- Backfill produces a machine-usable report with per-item outcomes (`migrated`, `linked_existing`, `skipped`, `quarantined`, `failed`).

## Current Rebuild Coverage
- Executable now:
  - `memory_projections` synchronization for `mem0`, `graph`, and `vector`
  - stale marker clearing on successful projection synchronization
  - tombstone/superseded propagation to derived projection state
- Still no-op/reporting only:
  - external adapter writes beyond `memory_projections` metadata (for example, external vector service writes)
  - non-existent derived sinks that do not yet have concrete repository writers
