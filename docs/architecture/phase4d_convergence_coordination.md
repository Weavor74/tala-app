# Phase 4D — Convergence & Coordination

## Overview

Phase 4D connects Tala's cognition, world model, self-maintenance, and A2UI
workspace surfaces into a unified, low-noise, intent-aware system.

The core question Phase 4D answers:

> "What should Tala show, update, or act on right now?"

---

## What Changed

### New subsystems

| Component | Location | Role |
|---|---|---|
| `SurfacePolicyEngine` | `electron/services/coordination/` | Deterministic authority: open / update / focus / suppress |
| `SurfaceStateRegistry` | `electron/services/coordination/` | Tracks open surfaces, cooldown windows, data hashes |
| `A2UISurfaceCoordinator` | `electron/services/coordination/` | Central orchestrator: receives policy, drives surface lifecycle |

### Extended systems

| File | Change |
|---|---|
| `A2UIActionBridge` | Added UI → cognition feedback loop (`onCognitiveInteraction` callback) |
| `PreInferenceContextOrchestrator` | Wired `A2UISurfaceCoordinator` as optional constructor arg; fires `coordinate()` after every turn |
| `MaintenanceLoopService` | Added `setSurfaceCoordinator()`; notifies coordinator after every maintenance cycle |
| `WorldModelAssembler` | Added `setSurfaceCoordinator()`; notifies coordinator after every world model rebuild |
| `shared/telemetry.ts` | Added 9 Phase 4D telemetry event types |
| `shared/coordinationTypes.ts` | New canonical coordination type model |

---

## Architecture

```
[Turn starts in AgentService]
        │
        ▼
[PreInferenceContextOrchestrator.orchestrate()]
   - gathers intent, mode, world state, maintenance state
        │
        ▼ (fire-and-forget)
[A2UISurfaceCoordinator.coordinate(SurfacePolicyInput)]
        │
        ▼
[SurfacePolicyEngine.evaluate(input)]
   - returns: SurfaceDecision[] per surface
        │
        ▼
[A2UISurfaceCoordinator executes decisions]
   - open: A2UIWorkspaceRouter.openSurface() + SurfaceStateRegistry.markOpened()
   - update: openSurface(focus=false) + hash comparison (skip if unchanged)
   - focus: openSurface(focus=true) + markUpdated(isFocused=true)
   - suppress: telemetry only
        │
        ▼
[BrowserWindow.webContents.send('agent-event', { type: 'a2ui-chat-notice' })]
   - lightweight notice to chat (e.g. "Opened maintenance panel")
   - never sends component trees to chat
```

### Event-driven surface triggers

In addition to per-turn triggering, two service hooks fire independently:

```
MaintenanceLoopService.runCycle()
   → coordinator.coordinate({ triggerType: 'maintenance_event' })

WorldModelAssembler.assemble()
   → coordinator.coordinate({ triggerType: 'world_event' })
```

---

## SurfacePolicyEngine Rules

### Mode suppression
- `rp` mode → suppress all surfaces
- `isGreeting = true` → suppress all surfaces

### Intent → surface mapping

| Intent class | Surface |
|---|---|
| `technical`, `coding`, `task` | `cognition` |
| `troubleshooting`, `diagnostic` | `maintenance` |
| `repo`, `workspace` | `world` |

### Event-based rules
- Critical/high maintenance issues → open/update `maintenance`
- `hasApprovalNeededAction = true` → focus `maintenance`
- `world_event` trigger → open/update `world`

### Anti-noise rules
- Cooldown window (default: 30 seconds) prevents repeated surface opens
- Data hash comparison skips no-op updates when payload is unchanged
- Surfaces not mapped to intent are simply omitted from decisions

---

## SurfaceStateRegistry

Tracks per-surface state:

```ts
interface SurfaceStateEntry {
    surfaceId: A2UISurfaceId;
    isOpen: boolean;
    lastUpdatedAt: string;
    lastDataHash: string;
    isFocused: boolean;
    openCount: number;
    lastFocusedAt?: string;
}
```

Cooldown is based on the last `markOpened()` call. `markUpdated()` does not
reset the cooldown.

---

## UI → Cognition Feedback Loop

When a user interacts with an A2UI surface (e.g. clicks "restart provider"),
the `A2UIActionBridge` now emits a structured `CognitiveInteractionEvent`:

```ts
interface CognitiveInteractionEvent {
    timestamp: string;
    actionName: string;
    surfaceId: A2UISurfaceId;
    summary: string;   // bounded, sanitized — e.g. "User initiated provider restart action — completed."
    success: boolean;
}
```

The caller injects this via `onCognitiveInteraction` callback, which can:
- Write to short-term memory
- Inject into next-turn cognitive context
- Report a reflection signal

**Safety rules:**
- No raw UI payload is injected.
- Only sanitized string summaries.
- Max summary length ~150 chars.
- Callback is optional — bridge works without it.

---

## Telemetry Events

| Event | When emitted |
|---|---|
| `surface_policy_evaluated` | Every `coordinate()` call |
| `surface_decision_open` | Surface open decision executed |
| `surface_decision_update` | Surface update decision executed |
| `surface_decision_suppress` | Surface suppression decision executed |
| `surface_focus_requested` | Surface focus decision executed |
| `surface_update_skipped` | Update suppressed (data unchanged) |
| `surface_auto_triggered` | Surface opened/updated by system event (not user) |
| `surface_user_triggered` | Surface opened by explicit user request |
| `surface_feedback_accepted` | CognitiveInteractionEvent emitted to cognition |

---

## Chat Behavior

Chat receives only lightweight notices — never surface content:

```ts
// A2UISurfaceCoordinator emits to chat channel:
win.webContents.send('agent-event', {
    type: 'a2ui-chat-notice',
    data: { surfaceId: 'cognition', message: 'Opened cognition panel' },
});
```

Surface payloads (component trees) are sent via `a2ui-surface-open` events
which target the document/editor pane — never chat.

---

## Integration Points

| System | How wired |
|---|---|
| `PreInferenceContextOrchestrator` | Optional 7th constructor arg: `A2UISurfaceCoordinator \| null` |
| `MaintenanceLoopService` | `setSurfaceCoordinator(coordinator)` call at boot |
| `WorldModelAssembler` | `setSurfaceCoordinator(coordinator)` call at boot |
| `A2UIActionBridge` | `onCognitiveInteraction?: (evt) => void` in deps |

All wiring is optional and fail-safe. A missing coordinator never breaks
inference, maintenance, or world model assembly.

---

## Diagnostics

`A2UISurfaceCoordinator.getDiagnosticsSummary()` exposes:

```ts
interface CoordinatorDiagnosticsSummary {
    policyEvaluationCount: number;
    surfacesOpened: number;
    surfacesUpdated: number;
    surfacesSuppressed: number;
    feedbackEventsAccepted: number;
    autoTriggeredCount: number;
    openSurfaces: Array<{ surfaceId, lastUpdatedAt, openCount }>;
}
```

---

## Known Limitations

1. **Data hash is coarse** — the hash uses `assembledAt + component count`
   as a proxy. A proper content hash would reduce false updates when data
   changes minimally. Acceptable for Phase 4D.

2. **Coordinator is not exposed via IPC** — diagnostics are available to main
   process consumers but not yet surfaced to the renderer diagnostics panel.
   Follow-up: wire into `diagnostics:getCoordinatorState` IPC.

3. **Feedback loop is fire-and-release** — the `onCognitiveInteraction`
   callback returns void. No acknowledgement or retry logic. Acceptable for
   Phase 4D; a bounded ring buffer could be added later.

4. **World surface trigger on every assemble** — the coordinator is notified
   on every `WorldModelAssembler.assemble()` call. A freshness check
   (was the previous model fresh/unchanged?) could reduce unnecessary
   `world_event` triggers. Acceptable for Phase 4D.
