# Tala System Overview

## 1. System Purpose
Tala is a local-first AI companion and agent workstation. The runtime is designed around explicit authority boundaries, deterministic orchestration, and offline-capable operation.

## 2. Architecture Truths (Current Runtime)

- Postgres is the canonical memory runtime and source of durable memory truth.
- `MemoryAuthorityService` is the required canonical write path for durable memory records.
- mem0, graph, vector, summaries, caches, and retrieval artifacts are derived layers only.
- Derived memory must reference canonical Postgres-backed IDs.
- Memory authority enforcement and integrity checks exist to prevent canonical/derived drift.
- Storage providers are managed through a registry and explicit role assignments, not a single implicit provider.
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
- Roles are explicitly assigned to provider IDs.
- Role assignment is policy-validated (capability, locality, auth, health, and uniqueness constraints).
- The canonical memory role is restricted and guarded against removing/disabling the sole active canonical provider.
- Legacy bootstrap can hydrate providers from prior settings, then deterministically fill missing role assignments.

Standard roles:

- `canonical_memory`
- `vector_index`
- `blob_store`
- `document_store`
- `backup_target`
- `artifact_store`

## 7. Major Runtime Subsystems

- Electron Main (`electron/`): lifecycle, IPC, orchestration.
- React Renderer (`src/`): UI surfaces and operator workflows.
- Agent service (`electron/services/AgentService.ts`): turn execution and tool orchestration.
- DB/bootstrap services (`electron/services/db/`): bootstrap planning, health checks, canonical repository init.
- Inference services (`electron/services/inference/`): provider registry, probing, deterministic selection/fallback.
- Storage services (`electron/services/storage/`): provider registry plus role assignment policy.

## 8. Present vs Future

This document describes implemented runtime behavior only. Planned/future architecture should be documented separately in phase/roadmap documents and not mixed into present-tense system posture.
