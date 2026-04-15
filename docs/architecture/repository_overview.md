# Repository Overview: Tala

Tala is a local-first autonomous agent platform with explicit authority boundaries for memory, inference, and storage.

## Root Architecture

| Directory | Responsibility |
|---|---|
| `electron/` | Main process orchestration, IPC routing, runtime services |
| `src/renderer/` | React UI and workspace surfaces |
| `shared/` | Cross-process contracts and pure types |
| `mcp-servers/` | MCP service implementations |
| `docs/` | Architecture, interfaces, operations, and policy docs |
| `scripts/` | Build, diagnostics, and documentation automation |
| `tests/` | Unit and integration verification suites |

## Runtime Posture (Current)

- Postgres is the canonical memory runtime and source of truth for canonical memory state.
- Canonical durable memory writes go through `MemoryAuthorityService`.
- mem0, graph, vector stores, summaries, and caches are derived/read-side layers.
- pgvector is used inside Postgres for vector capability when installed and available.
- Missing pgvector is a vector capability availability condition, not loss of canonical memory.

Storage authority posture:
- Storage Registry is the authoritative storage configuration model.
- Provider records define backend connection/auth/capability facts.
- Role assignments bind responsibilities to Providers.
- Canonical authority and Derived layers are explicit and inspectable in settings/diagnostics.

## Inference Posture (Current)

Inference provider selection is deterministic and local-first (`ProviderSelectionService`):

1. `ollama`
2. `vllm`
3. `llamacpp`
4. `koboldcpp`
5. `embedded_vllm`
6. `embedded_llamacpp`
7. `cloud`

Cloud is optional and used only when configured and selected by routing/fallback policy.

## Storage Role Assignment Model

Storage providers and assignments are managed by registry services in `electron/services/storage/`:

- `StorageProviderRegistryService` persists provider records and role assignments.
- `StorageAssignmentPolicyService` enforces deterministic eligibility and safety rules.
- Roles are explicit assignments, not implicit provider behavior.
- Bootstrap is deterministic and idempotent:
  - imports legacy signals once into the Storage Registry
  - hydrates deterministic Provider IDs
  - fills missing role gaps only
  - never overwrites explicit assignments
  - records reasoned outcomes in assignment diagnostics
- Post-bootstrap behavior does not silently re-import legacy config; re-import is explicit.

Supported roles:

- `canonical_memory`
- `vector_index`
- `blob_store`
- `document_store`
- `backup_target`
- `artifact_store`

## Documentation and Validation Gates

- Regenerate deterministic docs: `npm run docs:regen`
- Heal doclock impact output: `npm run docs:heal`
- Validate docs: `npm run docs:validate`
- Canonical completion gate: `npm run docs:heal-and-validate`

This document is maintained as a top-level runtime summary and should stay aligned with implementation services under `electron/services/`.
