# Phase 4A: World Model Foundation — Architecture Notes

**Phase**: 4A — World Model Foundation  
**Status**: Implemented  
**Branch**: `copilot/tala-phase-4a-structured-world-model`

---

## Overview

Phase 4A gives Tala a structured, canonical understanding of the environment she operates in. Before this phase, Tala had fragmented environmental awareness spread across individual services. Phase 4A unifies that into a single, coherent world model.

The world model answers:

> **"What world am I operating in right now?"**

It does this through a normalized, diagnostics-friendly snapshot that Tala can use as context before or during pre-inference orchestration.

---

## Architecture

### Type Layer — `shared/worldModelTypes.ts`

The canonical type definitions for the world model. All types are IPC-safe (no circular refs, no functions). Partial/degraded state is a first-class citizen.

**Top-level type:** `TalaWorldModel`

**Sections:**

| Type | Description |
|---|---|
| `WorkspaceState` | Workspace root, key directories, open files, classification |
| `RepoState` | Git branch, dirty/clean, project type, key directories |
| `RuntimeWorldState` | Inference readiness, provider selection, degradation |
| `ServiceWorldState` | Per-MCP-service compact state |
| `ToolWorldState` | MCP services, enabled/blocked/degraded tools |
| `ProviderWorldState` | Available, suppressed, degraded providers |
| `UserGoalState` | Immediate task, project focus, stable direction |
| `WorldModelSummary` | Rollup of all sections with alerts |
| `WorldModelDiagnosticsSummary` | IPC-safe read model for diagnostics surfaces |

**Section metadata:** Every section carries `WorldModelSectionMeta` with `assembledAt`, `freshness`, and `availability`.

**Assembly mode:** `TalaWorldModel.assemblyMode` is `full | partial | degraded` based on how many sections were unavailable during assembly.

---

### Builder Layer — `electron/services/world/`

#### `WorkspaceStateBuilder`

Builds `WorkspaceState` from a workspace root path and optional app-supplied state (active files, recent files, open artifacts).

- Probes only known candidate directory names (no recursive scanning).
- Classifies workspace as `repo | docs_project | mixed | unknown`.
- Exposes module-level singleton: `workspaceStateBuilder`.

#### `RepoStateBuilder`

Builds `RepoState` by:
- Detecting `.git` presence (cheap sync check).
- Using `GitService.getCurrentBranch()` and `GitService.getStatus()` if available.
- Probing key directories for project type classification.
- Caching results for 30 seconds (configurable) to avoid over-querying git.

Project types detected: `electron_app | node_library | python_project | docs_only | mixed | unknown`.

If `GitService` is unavailable, state is marked as `partial` rather than unavailable.

Exposes module-level singleton: `repoStateBuilder`.

#### `RuntimeWorldStateProjector`

Projects `RuntimeDiagnosticsSnapshot` → `RuntimeWorldState + ToolWorldState + ProviderWorldState`.

This is NOT a duplicate of `RuntimeDiagnosticsSnapshot` — it is a cognition-friendly projection:
- Summarizes inference and MCP state into compact cognitive fields.
- Strips raw diagnostics detail (health scores, full transition logs).
- Derives `enabledTools`, `blockedTools`, `degradedTools` from MCP service state.
- Derives `availableProviders`, `suppressedProviders`, `degradedProviders` from health scores.

Exposes module-level singleton: `runtimeWorldStateProjector`.

#### `UserGoalStateBuilder`

Builds `UserGoalState` from current turn text, recent turn summaries, and profile-derived direction:

- Extracts `immediateTask` from the current turn (first sentence or up to 120 chars).
- Detects explicit goal statements via keyword matching (outranks inferred state → `high` confidence).
- Infers `currentProjectFocus` from the most recent turn summary.
- Carries `stableDirection` from profile data.
- Marks stale state when no recent turn data is available.

**Priority rule:** Explicit user statements always outrank inferred goal state.

Exposes module-level singleton: `userGoalStateBuilder`.

---

### Assembler — `electron/services/world/WorldModelAssembler`

The single authoritative builder for `TalaWorldModel`.

```
WorldModelAssembler.assemble(
  workspaceInput,         // workspace root + optional active/recent files
  diagnosticsSnapshot,    // RuntimeDiagnosticsSnapshot (or undefined)
  goalInput,              // current turn + recent turn summaries + profile direction
  gitService?,            // for repo state (optional)
  forceRefresh?,          // bypass cache
)
```

**Partial build behavior:** If any section fails, other sections still populate. Failure of one section does not collapse the assembly.

**Assembly mode:**
- `full` — all 6 sections available, no errors.
- `partial` — some sections unavailable (< 5 unavailable).
- `degraded` — 5 or more sections unavailable.

**Freshness cache:** Default 30-second cache prevents expensive rebuilds on every minor event. `invalidateCache()` forces rebuild.

**Telemetry:**
- `world_model_build_started` — assembly started.
- `world_model_build_completed` — full assembly succeeded.
- `world_model_build_partial` — partial assembly.
- `world_model_build_failed` — degraded assembly.

**Diagnostics summary:** `buildDiagnosticsSummary(model)` → `WorldModelDiagnosticsSummary` — IPC-safe read model with no raw file contents.

Exposes module-level singleton: `worldModelAssembler`.

---

### Live Cognitive Integration — `PreInferenceContextOrchestrator`

The world model is integrated into `PreInferenceContextOrchestrator.orchestrate()` as a selective context source.

**Selective contribution policy:**
- World state is NOT contributed on every turn — only when situationally relevant.
- RP mode: world state suppressed (no environmental grounding in RP).
- Greeting/conversation intents: world state suppressed (no overhead).
- Technical/coding/task/workspace/repo intents: world state contributed.

**Contribution format:** `worldStateSummary` — a compact single-line string (e.g., `Repo: electron_app (main) | Runtime: inference=ready provider=Ollama | Active task: Fix the world model tests`).

The full `TalaWorldModel` is never dumped into prompts. Only a selective, intent-matched summary is contributed.

**Telemetry:**
- `world_state_applied` — world state summary contributed.
- `world_state_skipped` — world state suppressed for this turn.

---

### IPC / Diagnostics Surface

**IPC handler:** `diagnostics:getWorldModel`

Returns `WorldModelDiagnosticsSummary | null`.

- Read-only — renderer never drives world-model assembly.
- Returns null if no model has been assembled yet.
- Safe: no raw file contents, no full prompts, no excessive user data.

---

### Telemetry Schema — `shared/telemetry.ts`

New event types added:

```typescript
| 'world_model_build_started'
| 'world_model_build_completed'
| 'world_model_build_partial'
| 'world_model_build_failed'
| 'world_state_applied'
| 'world_state_skipped'
```

New subsystem added:

```typescript
| 'world_model'
```

---

## Service Wiring

`electron/main.ts` instantiates `WorldModelAssembler` and passes it to `IpcRouter` context:

```typescript
const worldModelAssembler = new WorldModelAssembler({ includeRepoState: true });
// ... passed to IpcRouter({ ..., worldModelAssembler })
```

`IpcRouterContext` has `worldModelAssembler?: WorldModelAssembler` (optional for backward compatibility).

---

## TALA Alignment

| Alignment Check | Status |
|---|---|
| Improves Tala's coherence | ✅ One structured view of environment, reduces fragmentation |
| Improves Tala's trustworthiness | ✅ Environmental assumptions are explicit and diagnosable |
| Improves usability in workspace | ✅ Repo, workspace, tools, and goals are all modeled |
| Improves Tala's intelligence loop | ✅ World state available before inference; bounded for small models |
| Avoids platform drift | ✅ Not a generic CMDB; only what directly supports Tala cognition |

---

## Tests

`tests/WorldModel.test.ts` — 40 tests covering:

1. World model type shape and partial/degraded support.
2. WorkspaceStateBuilder — correct build, missing workspace, classification.
3. RepoStateBuilder — git detection, directory probing, caching, partial state.
4. RuntimeWorldStateProjector — inference projection, MCP tool state, provider state.
5. UserGoalStateBuilder — explicit vs inferred goals, staleness, goal confidence.
6. WorldModelAssembler — full build, partial build (missing diagnostics), caching, telemetry.
7. Diagnostics summary — IPC-safe read model, no raw data leakage.

---

## Known Limitations

- `WorldModelAssembler.assemble()` is not yet called automatically on session start or at a regular cadence — callers must invoke it explicitly before inference when world state is needed.
- `UserGoalState` derives project focus from the first recent turn summary only — no NLP-based focus extraction.
- `ToolWorldState.blockedTools` is always empty — policy-blocked tools are not yet tracked in MCP diagnostics.
- World model is not yet used in `CognitiveTurnAssembler` directly — integration point is at the orchestration layer only.
