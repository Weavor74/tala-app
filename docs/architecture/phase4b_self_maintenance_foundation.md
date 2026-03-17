# Phase 4B: Self-Maintenance Foundation

## Overview

Phase 4B builds the first bounded self-maintenance layer on top of Tala's existing world model, runtime diagnostics, provider control, and MCP lifecycle systems.

This phase answers: **"What is unhealthy, what is safe to do about it, and when should I act versus ask?"**

---

## Architecture

### Service Topology

```
RuntimeDiagnosticsAggregator  ──┐
TalaWorldModel (WorldModelAssembler) ──┤
                                       ▼
                         MaintenanceIssueDetector
                                       │
                                       ▼
                         MaintenancePolicyEngine  (+ cooldown/suppression registry)
                                       │
                          ┌────────────┼────────────┐
                          ▼            ▼             ▼
                     auto_execute  recommend   request_approval
                          │
                          ▼
                MaintenanceActionExecutor
                  (wraps RuntimeControlService)
                          │
                          ▼
                MaintenanceLoopService  ──── TalaMaintenanceState
                          │                       │
                          ├── IPC: diagnostics:getMaintenanceState
                          ├── IPC: diagnostics:runMaintenanceCheck
                          ├── IPC: diagnostics:setMaintenanceMode
                          └── PreInferenceContextOrchestrator (selective cognitive injection)
```

---

## Canonical Types (`shared/maintenance/maintenanceTypes.ts`)

| Type | Purpose |
|------|---------|
| `TalaMaintenanceState` | Top-level internal state (mode, issues, decisions, cooldowns, suppressions) |
| `MaintenanceIssue` | A detected runtime problem (typed, bounded, no freeform strings) |
| `MaintenanceIssueCategory` | Issue classification enum |
| `MaintenanceSeverityLevel` | `critical \| high \| medium \| low \| info` |
| `MaintenanceActionProposal` | A proposed action from the policy engine |
| `MaintenanceActionType` | What action to take (bounded enum) |
| `MaintenanceDecision` | Full policy decision record linking issue → outcome → proposal |
| `MaintenanceExecutionResult` | Result of an execution attempt |
| `MaintenancePolicyOutcome` | `no_action \| monitor \| recommend_action \| request_user_approval \| auto_execute \| suppress_temporarily` |
| `MaintenanceDiagnosticsSummary` | IPC-safe read model for the renderer |
| `MaintenanceCognitiveSummary` | Compact summary for the cognitive/pre-inference path |
| `MaintenanceMode` | `observation_only \| recommend_only \| safe_auto_recovery` |

---

## Issue Detection (`MaintenanceIssueDetector`)

**File:** `electron/services/maintenance/MaintenanceIssueDetector.ts`

Detects maintenance issues from `RuntimeDiagnosticsSnapshot` and (optionally) `TalaWorldModel`.

### Detected Issues

| Rule | Category | Severity | Confidence |
|------|----------|----------|-----------|
| Selected provider is `unavailable` or `failed` | `provider_unavailable` | critical | 0.95 |
| Selected provider is `degraded` | `provider_degraded` | high | 0.90 |
| No providers ready (all unavailable) | `provider_unavailable` | critical | 0.95 |
| Provider health score ≥ 3 consecutive failures | `provider_degraded` | medium–high | 0.60–0.95 |
| Provider fallback count ≥ 3 | `provider_degraded` | medium | 0.75 |
| Suppressed selected provider | `provider_degraded` | medium | 0.85 |
| MCP service `unavailable` or `failed` | `mcp_service_unavailable` | medium–high | 0.90 |
| MCP service restarted ≥ 2 times recently | `mcp_service_flapping` | high | 0.85 |
| World model runtime section `degraded/unavailable` | `unknown_runtime_instability` | medium | 0.65 |
| World model reports active degraded subsystems | `unknown_runtime_instability` | medium | 0.70 |
| World model workspace section `unavailable` | `workspace_state_issue` | low | 0.60 |

**Safety rules:**
- Issues with `confidence < 0.40` are filtered out entirely.
- Low-confidence issues (< 0.50) are always downgraded to `monitor` by the policy engine.
- No live service calls — reads from already-maintained state only.

---

## Policy Engine (`MaintenancePolicyEngine`)

**File:** `electron/services/maintenance/MaintenancePolicyEngine.ts`

Single canonical decision engine. For each issue, returns one of:

| Outcome | When |
|---------|------|
| `no_action` | (reserved; currently unused — issues resolve to `monitor` minimum) |
| `monitor` | Low-confidence, `observation_only` mode, or severity `info/low` |
| `recommend_action` | Safe action identified but mode is `recommend_only` |
| `request_user_approval` | Flapping, memory issues, suppressed providers, approval-needed |
| `auto_execute` | Safe + reversible action in `safe_auto_recovery` mode |
| `suppress_temporarily` | Entity/category under active cooldown |

### Policy Rules Summary

| Issue Category | `observation_only` | `recommend_only` | `safe_auto_recovery` |
|----------------|-------------------|-----------------|---------------------|
| `provider_unavailable` | monitor | recommend (reprobe/restart) | auto_execute (reprobe/restart) |
| `provider_degraded` | monitor | recommend (restart) | auto_execute or approval |
| `mcp_service_unavailable` | monitor | recommend (restart) | auto_execute (restart) |
| `mcp_service_flapping` | monitor | approval needed | approval needed |
| `memory_health_issue` | monitor | approval needed | approval needed |
| `workspace_state_issue` | monitor | approval needed | approval needed |
| `unknown_runtime_instability` | monitor | monitor/recommend | monitor/recommend |

### Cooldown Durations

| Trigger | Cooldown |
|---------|---------|
| Auto-executed safe action | 5 minutes |
| Recommended action surfaced | 10 minutes |
| Flapping detected | 30 minutes |

---

## Action Executor (`MaintenanceActionExecutor`)

**File:** `electron/services/maintenance/MaintenanceActionExecutor.ts`

Wraps `RuntimeControlService` with structured result objects, telemetry, and safety gates.

### Auto-Safe Actions (may be executed in `safe_auto_recovery`)

| Action Type | Implementation |
|-------------|---------------|
| `reprobe_providers` | `RuntimeControlService.probeProviders()` |
| `restart_provider` | `RuntimeControlService.restartProvider(id)` |
| `reprobe_mcp_services` | `RuntimeControlService.probeMcpServices()` |
| `restart_mcp_service` | `RuntimeControlService.restartMcpService(id, configs)` |

### Blocked Actions (never auto-executed)

| Action Type | Why Blocked |
|-------------|-------------|
| `disable_provider_temporarily` | Requires user approval |
| `escalate_to_user` | Diagnostic surface only — no runtime side effect |
| Approval-needed proposals | `policyOutcome === 'request_user_approval'` |
| Non-`autoSafe` proposals | Safety gate prevents execution |

### Execution Result Status

| Status | Meaning |
|--------|---------|
| `success` | Action completed successfully |
| `failed` | Action threw or returned failure |
| `skipped` | Action type has no runtime execution |
| `blocked_by_policy` | Safety gate prevented execution |
| `requires_user_approval` | Policy outcome requires approval |

---

## Maintenance Loop (`MaintenanceLoopService`)

**File:** `electron/services/maintenance/MaintenanceLoopService.ts`

The bounded maintenance state manager and loop coordinator.

### Modes

| Mode | Behavior |
|------|---------|
| `observation_only` | Detect and record issues; no actions proposed or executed. |
| `recommend_only` | Detect issues and propose actions; **never** auto-execute. (Default) |
| `safe_auto_recovery` | Detect, propose, and auto-execute only safe/reversible actions. |

**Default mode:** `recommend_only`

### Invocation Strategy (Event-Driven)

The loop is **not** a background polling loop. It is invoked at bounded points:
- After provider failure events
- After world model builds
- After MCP service lifecycle transitions
- Manual check via IPC: `diagnostics:runMaintenanceCheck`

### Anti-Flapping

1. **Cooldown registry** — per-entity ISO timestamp. No re-action until expiry.
2. **Category suppression registry** — per-category suppression window.
3. **Ring buffers** — recent decisions (max 20) and executions (max 10) prevent unbounded growth.

---

## World / Cognitive Integration

**File:** `electron/services/cognitive/PreInferenceContextOrchestrator.ts`

Maintenance summary is selectively injected into the cognitive path via `maintenanceSummary` field on `PreInferenceOrchestrationResult`.

### When Maintenance Context Is Injected

| Condition | Maintenance Injected |
|-----------|---------------------|
| RP mode | ❌ Never |
| Greeting / conversation intent | ❌ Never |
| No actionable issues (critical/high) | ❌ Suppressed |
| `technical`, `task`, `troubleshooting`, `coding`, `workspace` intent | ✅ If issues present |

### Compact Summary Format

```
[Maintenance] Selected inference provider 'ollama' is unavailable. +1 more issue(s). Recommended: restart_provider for 'ollama'
```

Only the top issue description, issue count, and recommended action are injected — never raw logs or full execution history.

---

## IPC Surface

Three new IPC handlers added to `IpcRouter.ts`:

| Channel | Description |
|---------|-------------|
| `diagnostics:getMaintenanceState` | Returns `MaintenanceDiagnosticsSummary \| null`. Read-only. |
| `diagnostics:runMaintenanceCheck` | Triggers a manual maintenance cycle. Returns summary. |
| `diagnostics:setMaintenanceMode` | Changes the maintenance mode. Returns `{ success, mode }`. |

`IpcRouterContext` extended with `maintenanceLoopService?: MaintenanceLoopService`.

---

## Telemetry Events

Nine new events added to `shared/telemetry.ts`:

| Event | When Emitted |
|-------|-------------|
| `maintenance_issue_detected` | New issue detected (not seen in prior state) |
| `maintenance_issue_cleared` | Previously active issue no longer detected |
| `maintenance_policy_evaluated` | Policy evaluation completed for a cycle |
| `maintenance_action_recommended` | `recommend_action` or `request_user_approval` outcome |
| `maintenance_action_autoexecuted` | Successful auto-execution in `safe_auto_recovery` mode |
| `maintenance_action_skipped` | Action type has no runtime execution |
| `maintenance_action_failed` | Execution threw or failed |
| `maintenance_cooldown_applied` | Cooldown applied after action or proposal |
| `maintenance_mode_changed` | Mode changed via `setMode()` |

`'maintenance'` added as a canonical `TelemetrySubsystem` value.

**Safe payload fields:** `issueId`, `category`, `severity`, `confidence`, `actionType`, `targetEntityId`, `outcome`, `durationMs`, `mode`. No raw user content, prompts, or filesystem paths.

---

## Safety Model

### Absolute Constraints

- No destructive actions (no memory deletion, no repo mutation, no provider permanent removal)
- No auto-actions that touch user data or memory integrity
- No restart storms (cooldown enforced after every auto-action)
- No silent repeated retries
- Flapping services always require user approval

### Auto-Safe vs Approval-Needed

| Auto-Safe (may auto-execute) | Approval Needed |
|-----------------------------|----------------|
| Re-probe providers | Disable provider |
| Restart unavailable/degraded provider | Repeated restart loops |
| Re-probe MCP services | Flapping MCP restart |
| Restart unavailable MCP service (non-flapping) | Memory subsystem changes |
| | Workspace/repo state changes |
| | Any action during active user work |

---

## Known Limitations

1. **No setup/environment detection yet** — `setup_environment_issue` and `missing_dependency` categories are defined in types but detection rules are deferred.
2. **Memory health detection is world-model-only** — direct memory subsystem health probing is not implemented; only world model signals are used.
3. **No persistence** — maintenance state is in-memory and resets on Electron restart.
4. **MaintenanceLoopService is not yet wired into bootstrap.ts** — it is exposed as an optional context field on `IpcRouterContext` but the wiring to `bootstrap.ts` depends on the Electron entry point refactoring outside this phase.
5. **`safe_auto_recovery` mode is not the default** — callers must explicitly opt in; the system defaults to `recommend_only` to be conservative.
