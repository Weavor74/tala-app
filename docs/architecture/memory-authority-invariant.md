# Memory Authority Invariant

## Canonical Truth Boundary
- PostgreSQL `memory_records` is Tala's only canonical durable memory authority.
- No memory is authoritative unless accepted and committed to canonical Postgres with a canonical `memory_id`.
- mem0, graph, vectors, summaries, caches, and retrieval projections are derived layers only.

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
- Tombstones originate from canonical state and propagate outward.
- Authoritative recall must resolve to canonical IDs.
- Derived layers are rebuildable from canonical Postgres state.

## Operational Checks
- Integrity validation detects orphan projections, stale projections, duplicate canonical conflicts, and tombstone violations.
- Rebuild flows regenerate mem0/graph/vector projection plans from canonical state.
