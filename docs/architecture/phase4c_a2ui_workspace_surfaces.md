# Phase 4C — A2UI Workspace Surfaces

## Overview

Phase 4C integrates the React A2UI (Agent-to-UI) renderer model into Tala's
document/editor pane so Tala can open structured UI surfaces showing her
current cognitive, world, and maintenance state.

**Core rule:** A2UI surfaces render exclusively in the document/editor pane.
Chat receives only lightweight textual notices.

---

## Why Document/Editor Pane, Not Chat

Chat is conversational. Injecting structured multi-section UI trees inline
in chat creates noise, breaks the conversation flow, and conflicts with
Tala's stateful workspace mental model.

The document/editor pane already hosts artifacts, files, diffs, and browser
tabs. A2UI surfaces are workspace artifacts in the same sense: Tala opens
them, the user interacts with them, they remain open across turns.

---

## A2UI Integration Approach

Phase 4C does not install an upstream `react-a2ui` package. The codebase
already has an equivalent implementation:

- `src/renderer/catalog/BasicComponents.tsx` — component catalog (Button, Card, Table, Badge, etc.)
- `src/renderer/types.ts` — `A2UIComponent`, `A2UIState`, `a2ui` TabType
- `shared/a2uiTypes.ts` — canonical surface types and payload shapes (Phase 4C)

The `A2UIWorkspaceSurface` React component (`src/renderer/A2UIWorkspaceSurface.tsx`)
acts as the renderer host:

```
A2UISurfacePayload.components  →  A2UIWorkspaceSurface  →  BasicComponents catalog
```

**Style injection:** The existing `App.css` covers all styling. No separate
`injectStyles()` call is needed because the catalog uses inline styles.

**Named surfaces:** Three named surfaces with stable tab IDs:

| Surface | Tab ID | Data Source |
|---|---|---|
| `cognition` | `a2ui:cognition` | `RuntimeDiagnosticsAggregator.getSnapshot().cognitive` |
| `world` | `a2ui:world` | `WorldModelAssembler.getCachedModel()` |
| `maintenance` | `a2ui:maintenance` | `MaintenanceLoopService.getDiagnosticsSummary()` |

---

## Architecture

```
[User talks to Tala in chat]
        │
        ▼
[Tala / backend decides a surface is useful]
        │
        ▼
[IPC: a2ui:openSurface(surfaceId)]
        │
        ▼
[A2UIWorkspaceRouter]
   - calls surface mapper (Cognition / World / Maintenance)
   - assembles A2UISurfacePayload
        │
        ▼
[webContents.send('agent-event', { type: 'a2ui-surface-open', data: payload })]
        │
        ▼
[App.tsx handleAgentEvent]
   - opens or updates stable a2ui tab in document/editor pane
   - focuses tab if payload.focus = true
        │
        ▼
[A2UIWorkspaceSurface component renders component tree]
        │
        ▼ (user action)
[onAction callback → tala.a2ui.dispatchAction(action)]
        │
        ▼
[IPC: a2ui:dispatchAction(action)]
        │
        ▼
[A2UIActionBridge — validates allowlist, executes, updates surface]
```

---

## Files Added / Changed

### New — Shared types

- **`shared/a2uiTypes.ts`**
  Canonical surface types: `A2UISurfaceId`, `A2UINode`, `A2UISurfacePayload`,
  `A2UIActionDispatch`, `A2UIActionResult`, `A2UIDiagnosticsSummary`.

### Modified — Shared telemetry

- **`shared/telemetry.ts`**
  Added 8 new `TelemetryEventType` values:
  `a2ui_surface_open_requested`, `a2ui_surface_opened`, `a2ui_surface_updated`,
  `a2ui_surface_failed`, `a2ui_action_received`, `a2ui_action_validated`,
  `a2ui_action_executed`, `a2ui_action_failed`.
  Added `A2UITelemetryPayload` interface.

### New — Surface mappers

- **`electron/services/cognitive/CognitionSurfaceMapper.ts`**
  Maps `CognitiveDiagnosticsSnapshot` → A2UI tree.
  Shows: mode, memory contributions, doc context, emotional modulation,
  reflection notes, snapshot timestamp.
  Never exposes raw prompts or raw memory contents.

- **`electron/services/world/WorldSurfaceMapper.ts`**
  Maps `TalaWorldModel` → A2UI tree.
  Shows: workspace root/classification, repo branch/dirty state, runtime
  provider and MCP summary, user goal.
  Never dumps raw file trees or large JSON blobs.

- **`electron/services/maintenance/MaintenanceSurfaceMapper.ts`**
  Maps `MaintenanceDiagnosticsSummary` → A2UI tree.
  Shows: maintenance mode, issue counts, active issues table, recent
  executions, action buttons (run check, switch mode).
  Only exposes safe actions gated by policy.

### New — Routing

- **`electron/services/A2UIWorkspaceRouter.ts`**
  Assembles surface payloads and emits them to the renderer via
  `agent-event: a2ui-surface-open`. Maintains open-surface registry for
  diagnostics. Handles failures gracefully (returns null, emits failure
  telemetry).

### New — Action bridge

- **`electron/services/A2UIActionBridge.ts`**
  Allowlisted action dispatch. Validates action name against `ALLOWED_ACTIONS`
  set before executing. Routes to runtime services. Emits telemetry for
  every step (received → validated → executed / failed).

  Allowlisted actions:
  - `open_cognition_surface` / `open_world_surface` / `open_maintenance_surface`
  - `refresh_cognition` / `refresh_world` / `refresh_maintenance`
  - `run_maintenance_check`
  - `switch_maintenance_mode` (with mode validation)
  - `restart_provider` (requires `providerId` payload)
  - `restart_mcp_service` (requires `serviceId` payload)

### New — Renderer

- **`src/renderer/A2UIWorkspaceSurface.tsx`**
  React component that renders an A2UI component tree using the existing
  `BasicComponents` catalog. Handles `data-action` props on `Button` nodes
  to wire user actions back through `onAction`. Uses `ErrorBoundary` for
  graceful failure.

### Modified — IPC

- **`electron/services/IpcRouter.ts`**
  Added Phase 4C imports and fields (`_a2uiRouter`, `_a2uiActionBridge`).
  Added initialization in `registerAll()`.
  Added IPC handlers:
  - `a2ui:openSurface(surfaceId, options?)` → opens/refreshes named surface
  - `a2ui:dispatchAction(action)` → allowlisted action dispatch
  - `a2ui:getCognitiveSnapshot()` → returns current cognitive snapshot
  - `a2ui:getDiagnostics()` → returns A2UI diagnostics summary

### Modified — Preload

- **`electron/preload.ts`**
  Added `tala.a2ui` namespace:
  - `openSurface(surfaceId, options?)` 
  - `dispatchAction(action)`
  - `getCognitiveSnapshot()`
  - `getDiagnostics()`

### Modified — App.tsx

- Added `a2ui-surface-open` agent-event handler (opens/updates stable a2ui tab).
- Added rendering for `tab.type === 'a2ui'` using `A2UIWorkspaceSurface`.
- Actions from `A2UIWorkspaceSurface.onAction` route to `tala.a2ui.dispatchAction`.

---

## Named Surfaces

### Cognition Surface (`a2ui:cognition`)

What it shows:
- Active cognitive mode (assistant / rp / hybrid)
- Memory contributions summary (total applied, by category)
- Documentation context (applied? source count)
- Emotional modulation (applied? strength? astro unavailable?)
- Reflection notes (active count, suppressed count)
- Snapshot timestamp

Data source: `RuntimeDiagnosticsAggregator.getSnapshot().cognitive`

### World Model Surface (`a2ui:world`)

What it shows:
- Workspace root, classification, key directories
- Repo branch, dirty state, git availability
- Inference provider and inventory summary
- MCP service summary
- Degraded subsystems
- User goal (immediate task, project focus, direction)
- Assembly timestamp

Data source: `WorldModelAssembler.getCachedModel()`

### Maintenance Surface (`a2ui:maintenance`)

What it shows:
- Maintenance mode
- Issue counts by severity
- Active issues table (severity, category, confidence, recommendation)
- Recent maintenance actions table
- Pending auto / approval-needed action notices
- Action buttons: run check, switch mode
- Cooldown entities (if any)

Data source: `MaintenanceLoopService.getDiagnosticsSummary()`

---

## Action Callback Safety Model

All UI actions are validated against a strict allowlist in `A2UIActionBridge`.

**Allowlist enforcement:**
1. Action name checked against `ALLOWED_ACTIONS` Set.
2. Payload schema validated per action (e.g. `mode` must be a valid `MaintenanceMode`).
3. Service availability checked — returns `service_unavailable` if service missing.
4. Execution errors are caught and returned as `A2UIActionResult.error`, never thrown.

**No destructive actions are exposed.** Archive, delete, wipe, and factory-reset
actions are not in the allowlist and cannot be added through the renderer path.

---

## Telemetry Events

| Event | When |
|---|---|
| `a2ui_surface_open_requested` | Before assembly begins |
| `a2ui_surface_opened` | First time a surface is opened |
| `a2ui_surface_updated` | Surface re-opened (update in place) |
| `a2ui_surface_failed` | Assembly or window error |
| `a2ui_action_received` | Action dispatch begins |
| `a2ui_action_validated` | Action passed allowlist check |
| `a2ui_action_executed` | Action completed successfully |
| `a2ui_action_failed` | Action rejected or threw |

All events include `surfaceId`, `targetPane: 'document_editor'`.
No raw component trees or sensitive payload data are logged.

---

## IPC Diagnostics

`tala.a2ui.getDiagnostics()` returns:

```ts
{
  openSurfaces: Array<{ surfaceId, tabId, lastUpdatedAt, dataSource }>,
  actionDispatchCount: number,
  surfaceUpdateCount: number,
  surfaceFailureCount: number,
  actionFailureCount: number,
}
```

---

## Tab Behavior Rules

- **Stable tab IDs** — `a2ui:cognition`, `a2ui:world`, `a2ui:maintenance`.
  Re-opening a surface updates the existing tab, not creates a new one.
- **Focus behavior** — `payload.focus = true` by default. Background refreshes
  can pass `focus: false` to update without stealing focus.
- **State preservation** — surface state lives in React tab state until the
  tab is closed.
- **Chat behavior** — chat receives a lightweight toast notice from the
  surface open action, not embedded A2UI trees.

---

## Known Limitations

1. **No persistence** — A2UI tabs are lost on app restart. Re-opening requires
   a new `a2ui:openSurface` call. Persistence could be added via session save
   if the existing session system is extended.

2. **No live push** — Surfaces are assembled on demand. The router does not
   push updates automatically when the underlying data changes. A polling or
   subscription mechanism could be added in a future phase.

3. **No upstream `react-a2ui` package** — The implementation uses the existing
   `BasicComponents` catalog rather than an external A2UI library. This is
   intentional to avoid external dependencies and maintain full control.

4. **Action bridge for `restart_provider` / `restart_mcp_service`** — These
   route to `RuntimeControlService` which must already be allowed by the
   runtime policy gating in place from Phase 2B.
