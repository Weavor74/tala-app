# Memory Authority Invariant

## Canonical Authority Boundary
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

Rejected or deferred candidates must not be surfaced as Canonical authority data.

## Enforcement
- Durable memory writes must go through `MemoryAuthorityService`.
- Derived writes require canonical anchors (`canonical_memory_id`).
- `MemoryService` Derived mutation surfaces are canonical-status validated and scoped to projection Hydration/removal only.
- Tombstones originate from canonical state and propagate outward.
- Authoritative recall must resolve to canonical IDs.
- Derived layers are rebuildable from canonical Postgres state.

## Turn-Scoped Write Eligibility (MemoryAuthorityGate)
- `MemoryAuthorityGate` is the mandatory runtime seam for all turn-originated memory and episode writes.
- `AgentKernel` decides turn mode and `memoryWriteMode`; memory writers consume that decision and cannot self-upgrade authority.
- Enforcement matrix:
  - `conversation_only`: conversation categories only (`conversation_summary`, `conversation_memory`).
  - `episodic`: conversation + episodic categories.
  - `goal_episode`: conversation + episodic + planning/execution/recovery/goal-state categories.
- Durable categories (`planning_episode`, `execution_episode`, `recovery_episode`, `goal_state`) require:
  - `authorityEnvelope.canCreateDurableState=true`
  - `authorityLevel='full_authority'`
  - goal execution turn mode and goal linkage where required.
- Denials are deterministic and reason-coded (`invalid_category_for_write_mode`, `goal_linkage_required`, `durable_state_not_permitted`, etc.).
- The gate governs write eligibility only; canonical truth authority remains PostgreSQL via `MemoryAuthorityService`.

## Operational Checks
- Integrity validation detects orphan projections, stale projections, duplicate canonical conflicts, and tombstone violations.
- Rebuild flows execute canonical-to-Derived Hydration for `mem0`, `graph`, and `vector` projection metadata in `memory_projections`.
- Rebuild supports scoped execution by canonical ID, canonical ID list, stale-only mode, and full rebuild mode.
- Tombstoned/superseded canonical records are propagated as stale Derived projections and are never restored as active Canonical authority data.
- Cleanup flows are canonical-driven: `MemoryAuthorityService.cleanupDerivedState()` invalidates `memory_projections`, and `DerivedMemoryCleanupService` removes local derived projections from `MemoryService` for inactive canonical IDs.

## Legacy Bootstrap Recovery
- Legacy/local memory records without canonical IDs are suppressed from authoritative recall until backfilled.
- Canonical backfill runs through `LegacyMemoryBackfillService` and must canonicalize via `MemoryAuthorityService`.
- Bootstrap supports scoped execution (`legacyMemoryId`, `legacyMemoryIds`, `fullBackfill`) and optional `dryRun`.
- Eligible legacy records are canonicalized or linked to existing canonical records, then re-anchored with `canonical_memory_id`.
- Ambiguous/invalid/inactive legacy records are skipped or quarantined with explicit reasons; they are never silently promoted.
- Bootstrap produces a machine-usable report with per-item outcomes (`migrated`, `linked_existing`, `skipped`, `quarantined`, `failed`).

## Storage Registry Authority UX Model
- Settings and diagnostics surfaces expose a `Storage Authority Summary` view model that reports:
  - canonical runtime authority provider
  - derived provider set
  - Storage Registry health state (`healthy`, `degraded`, `conflict`)
  - bootstrap state (completed flag, outcome, run count, timestamps, plus bootstrapped/detected/explicit counts)
  - authority degradation and conflict reasons
  - recovery actions
- Provider-level visibility is modeled structurally and includes Provider type, reachability/auth/capability status, assigned Roles, authority class (`canonical` or `derived`), origin (`explicit_registry`, `bootstrapped_legacy`, `detected`), and layered Validation status.
- Role-level visibility is modeled structurally and includes assigned Provider, assignment type (`explicit`, `bootstrap`, `inferred`, `unassigned`), eligibility reasoning, and blocked alternatives.
- Assignment explanations are modeled as deterministic records with outcome, reason code, reason summary, blocked alternatives, and actionable next steps so assignment success/failure is inspectable and self-explanatory.

## Storage Assignment Law
- Assignment precedence is deterministic and centralized in `StorageAssignmentPolicyService` and `StorageProviderRegistryService`:
  1. explicit registry assignment is preserved
  2. explicit Providers are selected before bootstrap candidates
  3. bootstrap fills missing Role gaps only
  4. bootstrap never overwrites explicit assignments
  5. capability mismatch blocks assignment
  6. policy conflicts block assignment
  7. canonical conflicts are surfaced as recovery suggestions and are not auto-resolved
- Assignment decisions emit stable reason codes and are persisted as assignment decision diagnostics for UI, diagnostics, and test assertions.

Stable reason codes:
- `explicit_assignment_preserved`
- `filled_missing_role_from_bootstrap`
- `blocked_capability_mismatch`
- `blocked_auth_invalid`
- `blocked_policy_conflict`
- `blocked_canonical_conflict`
- `provider_unreachable`
- `provider_not_registered`
- `legacy_import_skipped_existing_registry`
- `recovery_suggestion_only`

## Storage Validation Layers
- Validation is layered and typed (`pass` / `fail` / `warn`) with reason code and optional remediation hint.
- Implemented dimensions:
  - `config_schema`
  - `authentication`
  - `reachability`
  - `capability_compatibility`
  - `role_eligibility`
  - `policy_compliance`
  - `authority_conflicts`
  - `bootstrap_migration_consistency`
  - `recoverability`
- Classification flags expose:
  - valid but not eligible
  - reachable but unauthorized
  - configured but policy blocked
  - canonical conflict state

## Bootstrap and Recovery Guarantees
- Bootstrap is deterministic and idempotent.
- First run with legacy config hydrates Providers and fills missing Role gaps only.
- Partial/broken legacy input imports valid Providers and marks invalid legacy entries as blocked Providers.
- Blocked Providers are not assigned.
- Canonical Provider failure is surfaced as degraded authority; assignment is preserved with no silent reassignment.
- Capability mismatch marks assignment invalid via diagnostics/reason codes; explicit reassignment or Provider fix is required.
- Legacy config never silently overrides Storage Registry after bootstrap completion.
- Re-import is explicit (`storage:reimportLegacy`) and remains deterministic.

## Current Rebuild Coverage
- Executable now:
- `memory_projections` Hydration for `mem0`, `graph`, and `vector`
- stale marker clearing on successful projection Hydration
  - tombstone/superseded propagation to derived projection state
  - canonical inactive cleanup (`tombstoned`/`superseded`) for:
    - `memory_projections` invalidation (`projection_status='stale'`, `projected_version=NULL`)
    - local `MemoryService` derived projection removal (canonical-ID anchored)
- Still no-op/reporting only:
  - external adapter writes beyond `memory_projections` metadata (for example, external vector service writes)
  - external cleanup adapters for `mem0`, graph, and vector services (not configured as concrete writers in this repository)
  - non-existent derived sinks that do not yet have concrete repository writers
