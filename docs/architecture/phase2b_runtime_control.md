# Phase 2B Runtime Control and Diagnostics

**Status**: Implemented
**Source files**:
- `shared/runtimeDiagnosticsTypes.ts` — canonical type model (extended with 2B fields)
- `shared/telemetry.ts` — telemetry event types (extended with 2B events)
- `electron/services/inference/ProviderHealthScorer.ts` — provider auto-recovery scoring
- `electron/services/RuntimeControlService.ts` — operational control API
- `electron/services/RuntimeDiagnosticsAggregator.ts` — snapshot producer (extended)
- `electron/services/IpcRouter.ts` — IPC handlers for runtime control
- `electron/services/reflection/ReflectionEngine.ts` — signal categories (extended)
- `src/renderer/components/RuntimeDiagnosticsPanel.tsx` — minimal diagnostics UI

---

## Overview

Phase 2B extends the Phase 2A runtime diagnostics read model into an **operational control surface**. It adds:

1. **Provider auto-recovery scoring** — automatic health-based demotion and conservative recovery
2. **Runtime control IPC** — operator-initiated provider and MCP lifecycle controls
3. **Diagnostics panel** — snapshot-driven UI (no probing in renderer)
4. **Reflection operational signals** — instability pattern detection from runtime control events
5. **Snapshot extensions** — operator actions, health scores, and recovery history in the snapshot

All Phase 2B capabilities support Tala's alignment checklist:
- Reduces fragmented execution paths through centralized health scoring
- Failures are visible and diagnosable via snapshot and telemetry
- Fallback behavior is explicit through provider suppression/recovery lifecycle
- Contributes evidence to the reflection engine through instability signals

---

## Provider Health Model

Implemented in `electron/services/inference/ProviderHealthScorer.ts`.

### Per-provider tracking fields

| Field | Description |
|-------|-------------|
| `failureStreak` | Consecutive inference failure count |
| `timeoutCount` | Total timeout count in the session |
| `fallbackCount` | Total fallback count in the session |
| `lastSuccess` | ISO timestamp of last successful inference |
| `lastFailure` | ISO timestamp of last failure |
| `suppressed` | Whether suppressed from auto-selection |
| `suppressedUntil` | When suppression expires (5-minute window) |
| `effectivePriority` | Current selection priority (elevated during demotion) |

### Demotion rules

```
failureStreak >= 3  →  effectivePriority += 10  (emit provider_health_demoted)
failureStreak >= 5  →  suppressed = true, suppressedUntil = now + 5min (emit provider_health_demoted as suppression)
```

### Recovery rules

```
success recorded  →  failureStreak = 0, suppressed = false, effectivePriority = basePriority
                     (emit provider_health_recovered, reportSignal provider_instability_pattern with recovered=true)
```

### Suppression

Suppression is **always time-bounded** (5-minute window). The scorer automatically lifts expired suppressions on the next `isSuppressed()` or `getAllScores()` call. Providers are never permanently removed.

### Instability detection

`recordRestart(providerId)` tracks operator-triggered restarts within a 10-minute window. If 3+ restarts occur within the window, a `repeated_provider_restart` thresholded signal is emitted to the reflection engine.

---

## Runtime Control IPC

Implemented in `electron/services/RuntimeControlService.ts` and registered in `electron/services/IpcRouter.ts`.

### Provider controls

| IPC channel | Description |
|-------------|-------------|
| `diagnostics:restartProvider` | Re-probes and refreshes a single provider |
| `diagnostics:probeProviders` | Re-probes all providers (debounced 5s) |
| `diagnostics:disableProvider` | Suppresses a provider from auto-selection (session-scoped) |
| `diagnostics:enableProvider` | Re-enables a suppressed provider |
| `diagnostics:forceProviderSelection` | Forces a specific provider for the session |

### MCP controls

| IPC channel | Description |
|-------------|-------------|
| `diagnostics:restartMcpService` | Disconnect + reconnect an MCP service |
| `diagnostics:disableMcpService` | Disconnects an MCP service |
| `diagnostics:enableMcpService` | Reconnects a disabled MCP service |
| `diagnostics:probeMcpServices` | Triggers health inventory refresh (debounced 5s) |

### Safety constraints

- No destructive operations (no provider removal, no forced shutdown without telemetry)
- All actions are reversible
- Debouncing prevents runaway probe storms
- Probing operations use existing health check infrastructure

---

## Telemetry Events (Phase 2B)

Added to `TelemetryEventType` in `shared/telemetry.ts`:

### Provider control events

| Event type | When emitted |
|-----------|--------------|
| `provider_restart_requested` | Operator triggers provider restart |
| `provider_restart_completed` | Provider restart probe finishes |
| `provider_disabled` | Operator disables/suppresses a provider |
| `provider_enabled` | Operator re-enables a provider |
| `provider_health_demoted` | Auto-demotion at failure streak threshold |
| `provider_health_recovered` | Provider recovers after demotion/suppression |

### MCP control events

| Event type | When emitted |
|-----------|--------------|
| `mcp_service_restart_requested` | Operator triggers MCP restart |
| `mcp_service_restart_completed` | MCP restart finishes |
| `mcp_service_disabled` | Operator disables MCP service |
| `mcp_service_enabled` | Operator enables MCP service |

### Telemetry payload fields

Every control action event carries:

```ts
{
    entityId: string;       // Provider or service ID
    entityType: string;     // 'provider' | 'mcp_service'
    priorState: string;     // State before action
    newState: string;       // State after action
    reason: string;         // Human-readable reason
    timestamp: string;      // ISO 8601
    correlationId: string;  // UUID for multi-step correlation
}
```

---

## Reflection Operational Signals

New signal categories added to `TelemetrySignal.category` in `ReflectionEngine.ts`:

| Category | Trigger |
|----------|---------|
| `provider_instability_pattern` | Provider demoted, suppressed, or recovered |
| `repeated_provider_restart` | 3+ restarts within 10 minutes |
| `mcp_service_flapping` | 3+ MCP restarts within 10 minutes |
| `persistent_degraded_subsystem` | (Available for external reporters) |
| `operator_intervention_required` | 5+ MCP restarts (persistent loop) |

Signals follow the existing threshold model:
- `reportSignal()` for immediate signals (recovery, intervention required)
- `reportThresholdedSignal()` for streak-based signals (repeated restarts, flapping)

Single transient events never trigger reflection signals — only patterns do.

---

## Snapshot Extensions (Phase 2B)

`RuntimeDiagnosticsSnapshot` in `shared/runtimeDiagnosticsTypes.ts` now includes:

| Field | Type | Description |
|-------|------|-------------|
| `operatorActions` | `OperatorActionRecord[]` | Last 50 operator-triggered actions |
| `providerHealthScores` | `ProviderHealthScore[]` | Health score per provider |
| `suppressedProviders` | `string[]` | Currently suppressed provider IDs |
| `recentProviderRecoveries` | `Array<{providerId, timestamp, reason}>` | Last 20 recoveries |
| `recentMcpRestarts` | `Array<{serviceId, timestamp, reason}>` | Last 20 MCP restarts |

The aggregator (`RuntimeDiagnosticsAggregator`) reads these from `ProviderHealthScorer` (singleton) and `RuntimeControlService` on demand. No background loop is needed.

---

## Diagnostics Panel

Implemented in `src/renderer/components/RuntimeDiagnosticsPanel.tsx`.

The panel:
- Reads exclusively from `diagnostics:getRuntimeSnapshot` (auto-refreshes every 5 seconds)
- Never performs provider probing or service health checks
- Dispatches control actions via `diagnostics:*` IPC calls
- Displays: inference summary, provider inventory with controls, MCP service list with controls, recent failures, operator action log, provider recoveries

---

## Architecture Flow

```
Operator action
  ↓ IPC (diagnostics:restartProvider etc.)
  ↓ IpcRouter.ts handler
  ↓ RuntimeControlService.restartProvider()
  ↓ InferenceService.refreshProviders()  /  McpService.disconnect()+connect()
  ↓ TelemetryService.operational(...)    — structured telemetry
  ↓ ProviderHealthScorer.resetScore()    — health state update
  ↓ ReflectionEngine.reportSignal()      — optional instability signal
  ↓ OperatorActionRecord pushed to ring buffer
  ↓ diagnostics:getRuntimeSnapshot       — aggregator includes all state
  ↓ RuntimeDiagnosticsPanel              — snapshot displayed to user
```

---

## Known Limitations

- Provider force-selection persists for the session but does not survive app restart (settings-level persistence is out of scope for this phase).
- MCP restart config is loaded from current settings at restart time — dynamic config changes between disable and re-enable may result in the last-known config being used.
- Provider health scoring is session-scoped (resets on app restart).
- The diagnostics panel is a standalone component; integration into the main workspace tab bar is a follow-up UX task.
