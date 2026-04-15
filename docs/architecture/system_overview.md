# Tala System Overview

## 1. System Purpose
Tala is a local-first AI companion and agent workstation. The runtime is designed around explicit authority boundaries, deterministic orchestration, and offline-capable operation.

## 2. Architecture Truths (Current Runtime)

- Storage authority is modeled through a **Storage Registry** (authoritative configuration model).
- A **Provider** is a storage backend definition in the Storage Registry.
- A **Role** is an assigned storage responsibility (for example `canonical_memory`, `vector_index`).
- Postgres is the canonical memory runtime **when configured and assigned to canonical authority**.
- `MemoryAuthorityService` is the required canonical write path for durable memory records.
- mem0, graph, vector, summaries, caches, and retrieval artifacts are derived layers only.
- Derived memory must reference canonical Postgres-backed IDs.
- Memory authority enforcement and integrity checks exist to prevent canonical/derived drift.
- Storage Providers are managed through explicit Storage Registry assignments, not implicit selection.
- Inference provider resolution is deterministic and local-first.

## 3. Canonical Memory Model

Canonical memory lifecycle:

1. Candidate memory is proposed.
2. `MemoryAuthorityService` accepts/rejects/merges/defer decisions.
3. Accepted records are committed to canonical Postgres tables.
4. Projection metadata is emitted for derived targets (`mem0`, `graph`, `vector`).
5. Integrity/rebuild flows reconcile derived layers from canonical state.

Canonical memory does not depend on derived layers being available.

## 4. pgvector Posture

- pgvector is the vector capability used inside Postgres when installed.
- Health checks report pgvector availability (`DbHealthService.pgvectorInstalled`).
- Semantic/vector retrieval depends on vector capability availability.
- If pgvector is missing, canonical Postgres memory remains active and only vector search/index capability is unavailable/degraded until an alternative assigned vector provider exists.

## 5. Inference Posture (Current)

Inference is local-first with deterministic provider selection and bounded fallback.

Current waterfall order (`ProviderSelectionService.WATERFALL_ORDER`):

1. `ollama`
2. `vllm`
3. `llamacpp`
4. `koboldcpp`
5. `embedded_vllm`
6. `embedded_llamacpp`
7. `cloud`

Notes:

- Ollama is the top-priority local provider in auto mode when ready.
- Embedded providers exist as fallback/local baseline paths, not as first choice when higher-priority local providers are ready.
- Cloud is optional and selected only when configured/ready and reached by policy or fallback.

## 6. Storage Role Assignment Model

Storage is handled by `StorageProviderRegistryService` and `StorageAssignmentPolicyService`.

- Providers are registered with capabilities, health/auth state, and supported roles.
- Roles are explicit assignments to Provider IDs in the Storage Registry.
- Role assignment is policy-validated (capability, locality, auth, reachability, and uniqueness constraints).
- Canonical assignment is restricted and guarded against removing/disabling the sole active canonical provider.
- Bootstrap performs deterministic one-time legacy import and hydration, then only fills missing Role gaps.

Deterministic precedence:
1. explicit Storage Registry assignment is preserved
2. explicit Providers are selected before bootstrap inputs
3. bootstrap fills only missing Role gaps
4. bootstrap never overwrites explicit assignments
5. capability mismatch blocks assignment
6. policy conflict blocks assignment
7. canonical conflicts are surfaced (not auto-resolved)

Stable assignment reason codes:
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

Standard roles:

- `canonical_memory`
- `vector_index`
- `blob_store`
- `document_store`
- `backup_target`
- `artifact_store`

## 7. Storage Validation Layers

`StorageValidationService` returns structured layered Validation (not a single boolean) with:
- status: `pass` / `fail` / `warn`
- reason code
- optional remediation hint

Validation dimensions:
- config/schema validity
- authentication validity
- reachability
- capability compatibility
- role eligibility
- policy compliance
- authority conflicts
- bootstrap/migration consistency
- recoverability

The validation output distinguishes:
- valid but not eligible
- reachable but unauthorized
- configured but policy-blocked
- canonical conflict state

## 8. Major Runtime Subsystems

- Electron Main (`electron/`): lifecycle, IPC, orchestration.
- React Renderer (`src/`): UI surfaces and operator workflows.
- Agent service (`electron/services/AgentService.ts`): turn execution and tool orchestration.
- DB/bootstrap services (`electron/services/db/`): bootstrap planning, health checks, canonical repository init.
- Inference services (`electron/services/inference/`): provider registry, probing, deterministic selection/fallback.
- Storage services (`electron/services/storage/`): provider registry plus role assignment policy.

## 9. Present vs Future

This document describes implemented runtime behavior only. Planned/future architecture should be documented separately in phase/roadmap documents and not mixed into present-tense system posture.
