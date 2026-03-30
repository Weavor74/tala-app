# Phase 5.6 — Code Harmonization Campaigns

## Overview

Phase 5.6 builds a deterministic, source-controlled harmonization layer that lets Tala detect implementation drift, match it to committed canon rules, and execute safe consistency campaigns through the existing planning, governance, execution, and campaign infrastructure.

This phase is **not** broad autonomous refactoring. It is bounded, rule-driven harmonization against a committed canon. Every harmonization decision flows through the same safety gates as every other improvement in Tala.

---

## Design Principles

1. **Harmonization must be rule-driven** — no pattern changes without a committed canon rule.
2. **No bypassing of planning/governance/execution** — every file touched by a harmonization campaign goes through SafeChangePlanner → GovernanceAppService → ExecutionOrchestrator.
3. **Bounded scope** — one pattern class per campaign, one subsystem per campaign, max 8 files per campaign.
4. **Protected subsystems are never targeted** — `reflection/`, `governance/`, `execution/`, and `safety/` are excluded at all layers.
5. **Deterministic detection and matching** — all drift detection uses string/regex pattern matching, no model calls.
6. **Canon trust is earned** — rule confidence starts conservatively at 0.65 and adjusts from outcomes.
7. **Fallback to defer/skip** — ambiguous drift, low-confidence rules, and protected files always result in a skipped or deferred campaign, never an error.
8. **No recursive campaigns** — harmonization campaigns may not spawn child campaigns.

---

## Architecture Layers

```
HarmonizationDriftDetector
    ↓ (HarmonizationDriftRecord)
HarmonizationMatcher
    ↓ (HarmonizationMatch + HarmonizationScope)
HarmonizationCampaignPlanner
    ↓ (HarmonizationCampaign)
HarmonizationCoordinator
    ↓ (per-file step via step executor callback)
AutonomousRunOrchestrator.executeHarmonizationStep()
    ↓
SafeChangePlanner (Phase 2)
    ↓
GovernanceAppService (Phase 3.5)
    ↓
ExecutionOrchestrator (Phase 3)
    ↓
HarmonizationOutcomeTracker
    ↓
HarmonizationCanonRegistry (confidence update)
    ↓
HarmonizationDashboardBridge → harmonization:dashboardUpdate IPC
```

---

## Subphases Implemented

### P5.6A — Harmonization Types & Contracts
**File:** `shared/harmonizationTypes.ts`

All canonical shared contracts. Key types:
- `HarmonizationCanonRule` — static definition + runtime confidence fields
- `HarmonizationDriftRecord` — detected drift with severity and per-hint results
- `HarmonizationMatch` — drift mapped to a rule with strength and scope
- `HarmonizationScope` — single-subsystem, explicit file list, single pattern class
- `HarmonizationCampaign` — bounded campaign with lifecycle status
- `HarmonizationOutcomeRecord` — immutable terminal outcome with confidence delta
- `HarmonizationDashboardState` — full dashboard state for IPC push
- `DEFAULT_HARMONIZATION_BOUNDS` — maxFiles=8, maxSteps=6, maxAgeMs=6h, cooldown=45min

### P5.6B — Canon Rule Registry
**Files:**
- `electron/services/autonomy/harmonization/defaults/harmonizationCanon.ts`
- `electron/services/autonomy/harmonization/HarmonizationCanonRegistry.ts`

Five initial conservative canon rules:
1. `canon-preload-exposure-pattern` — preload namespace/method exposure style
2. `canon-dashboard-subscription-pattern` — push subscription + cleanup in panels
3. `canon-registry-persistence-pattern` — `<dataDir>/autonomy/...` storage convention
4. `canon-telemetry-event-naming` — `telemetry.operational('autonomy', ...)` convention
5. `canon-service-wiring-pattern` — `registerIpcHandlers()` + `executeWithTelemetry()` pattern

Static rule definitions are source-controlled TypeScript constants. Only runtime fields (confidence, counts, status) are persisted to `<dataDir>/autonomy/harmonization/canon_registry.json`.

Initial confidence: `0.65`. Floor: `0.30`. Ceiling: `0.95`.
Adjustments: +0.04 on success, −0.06 on failure, −0.10 on regression.

### P5.6C — Drift Detection Engine
**File:** `electron/services/autonomy/harmonization/HarmonizationDriftDetector.ts`

Deterministic scanner. No model calls, no file mutation.

Input: set of (filePath, content) pairs + active canon rules.
Output: `HarmonizationDriftRecord[]` for rules where drift exceeds `minDriftSeverity`.

Hint kinds supported:
- `regex_mismatch` — content must/must-not match a regex
- `ipc_naming_check` — IPC channel naming convention check
- `presence_absence` — required/forbidden substring
- `symbol_naming_check` — exported symbol name check
- `telemetry_key_check` — telemetry call pattern check

Severity formula: `(absoluteViolatedWeight × 0.7 + fileCoverage × 0.3) × 100`.
Low-weight hints produce proportionally low severity by design.

Protected path segments (`PROTECTED_PATH_SEGMENTS`):
- `electron/services/reflection/`
- `electron/services/governance/`
- `electron/services/execution/`
- `electron/services/safety`
- `electron/preload.ts` (read for pattern detection only)

### P5.6D — Harmonization Match & Scope Selection
**File:** `electron/services/autonomy/harmonization/HarmonizationMatcher.ts`

Maps a `HarmonizationDriftRecord` to a canon rule via 6 safety checks:
1. Rule exists in registry
2. Rule status is `active`
3. `confidenceCurrent >= confidenceFloor + HARMONIZATION_MIN_CONFIDENCE_MARGIN`
4. Drift does not touch a protected subsystem
5. No active harmonization campaign already exists for this subsystem
6. Drift severity >= rule's `minDriftSeverity`

Match strength:
- `strong_match` — all checks pass
- `weak_match` — soft disqualifiers only (confidence low, severity borderline)
- `no_match` — hard block (protected subsystem, active campaign, disabled rule)

Scope selection: always prefers narrowest scope. Protected files are excluded. Files truncated to `DEFAULT_HARMONIZATION_BOUNDS.maxFiles` (8).

### P5.6E — Harmonization Campaign Planning
**File:** `electron/services/autonomy/harmonization/HarmonizationCampaignPlanner.ts`

Converts a `HarmonizationCampaignInput` into a `HarmonizationCampaign`. Pure data transformation — no side effects.

Returns a **skipped campaign** (not null, for auditability) when:
- `skipIfLowConfidence=true` and confidence is below minimum margin
- All target files are protected
- No eligible files remain after filtering

Truncates target files at `maxFiles` and `maxSteps`. One file per campaign step.

Attaches `HarmonizationProposalMetadata` via `buildProposalMetadata()` so planning/governance layers have context.

### P5.6F — Governance / Execution Integration
**Files modified:**
- `electron/services/autonomy/AutonomousRunOrchestrator.ts` — `setHarmonizationServices()`, `executeHarmonizationStep()`, `_buildHarmonizationStepPlanInput()`
- `electron/main.ts` — Phase 5.6 instantiation block
- `electron/preload.ts` — `harmonization:*` namespace + `harmonization:dashboardUpdate` channel
- `electron/services/autonomy/HarmonizationAppService.ts` — IPC namespace

**New files:**
- `electron/services/autonomy/harmonization/HarmonizationCoordinator.ts` — lifecycle management

`HarmonizationCoordinator.advanceCampaign()` executes one file at a time via a `HarmonizationStepExecutor` callback that delegates to `AutonomousRunOrchestrator.executeHarmonizationStep()`.

`executeHarmonizationStep()` follows the identical path as `executeCampaignStep()` in Phase 5.5:
1. `SafeChangePlanner.plan()` — Phase 2
2. `SafeChangePlanner.promoteProposal()` — Phase 2
3. `GovernanceAppService.evaluateForProposal()` — Phase 3.5
4. `ExecutionOrchestrator.start()` — Phase 3
5. Poll for terminal state

No governance bypass. No execution bypass.

### P5.6G — Harmonization Outcome Tracking
**File:** `electron/services/autonomy/harmonization/HarmonizationOutcomeTracker.ts`

Immutable outcome records per campaign. Stored at:
`<dataDir>/autonomy/harmonization/outcomes/<campaignId>.json`

On each `record()` call:
- Derives `succeeded`, `regressionDetected`, `driftReducedConfirmed`, `rollbackTriggered`
- Dispatches confidence delta to `HarmonizationCanonRegistry`
- Computes `learningNotes` array

`isTerminal(status)` static helper for coordinator use.

### P5.6H — Reflection Dashboard Integration
**Files:**
- `src/renderer/components/HarmonizationDashboardPanel.tsx` — standalone panel
- `src/renderer/components/AutonomyDashboardPanel.tsx` — wired as Phase 5.6 section
- `electron/services/autonomy/harmonization/HarmonizationDashboardBridge.ts` — IPC push bridge

Dashboard shows:
- KPI bar (active campaigns, succeeded, failed, skipped, avg confidence)
- Canon rule health table (confidence bar, success/failure/regression counts, status)
- Pending drift records (severity, affected files, protected flag)
- Active campaigns (progress bar, current file, risk level)
- Deferred campaigns (with resume/abort actions)
- Recent outcomes (status, files modified, confidence delta, learning notes)

Push subscription: `harmonization:dashboardUpdate` channel.
Deduplication: identical consecutive states are not re-emitted.

### P5.6I — Safety Controls, Bounds, and Protected Areas
Enforced across all layers:

| Layer | Control |
|---|---|
| HarmonizationMatcher | Protected subsystem → no_match |
| HarmonizationMatcher | Active campaign for subsystem → no_match |
| HarmonizationMatcher | Low confidence → weak_match / no_match |
| HarmonizationCampaignPlanner | Protected files filtered before steps |
| HarmonizationCampaignPlanner | maxFiles=8 hard cap |
| HarmonizationCampaignPlanner | maxSteps=6 hard cap |
| HarmonizationCoordinator | maxAgeMs=6h expiry |
| HarmonizationCoordinator | cooldownAfterFailureMs=45min |
| HarmonizationCoordinator | Re-entrant advanceCampaign() blocked per campaignId |
| AutonomousRunOrchestrator | Harmonization step → same gates as all other steps |

---

## IPC Namespace

`harmonization:*` (registered in `HarmonizationAppService`):

| Handler | Returns |
|---|---|
| `harmonization:getDashboardState` | `HarmonizationDashboardState` |
| `harmonization:listCampaigns` | `HarmonizationCampaign[]` |
| `harmonization:getCampaign` | `HarmonizationCampaign \| null` |
| `harmonization:listCanonRules` | `HarmonizationCanonRule[]` |
| `harmonization:getCanonRule` | `HarmonizationCanonRule \| null` |
| `harmonization:listOutcomes` | `HarmonizationOutcomeRecord[]` |
| `harmonization:deferCampaign` | `{ deferred: true }` |
| `harmonization:abortCampaign` | `{ aborted: true }` |
| `harmonization:resumeCampaign` | `{ resumed: true }` |

Push channel: `harmonization:dashboardUpdate` → `HarmonizationDashboardState`

Preload namespace: `tala.harmonization.*`

---

## Persistence Layout

```
<dataDir>/autonomy/harmonization/
  canon_registry.json          ← runtime confidence overrides (runtime fields only)
  campaigns.json               ← all active/deferred campaigns
  outcomes/
    <campaignId>.json          ← immutable outcome records
```

---

## Telemetry Events

All events use `telemetry.operational('autonomy', ...)` consistent with the Phase 4–5.5 pattern.

| Event key | Emitted by |
|---|---|
| `harmonization_drift_detected` | HarmonizationDriftDetector |
| `harmonization_rule_matched` | HarmonizationMatcher (strong match) |
| `harmonization_rule_weak_match` | HarmonizationMatcher (weak match) |
| `harmonization_rule_rejected` | HarmonizationMatcher (no match) |
| `harmonization_campaign_created` | HarmonizationCampaignPlanner |
| `harmonization_campaign_fallback` | HarmonizationCampaignPlanner (skipped) |
| `harmonization_campaign_succeeded` | HarmonizationCoordinator |
| `harmonization_campaign_failed` | HarmonizationCoordinator |
| `harmonization_campaign_rolled_back` | HarmonizationCoordinator |
| `harmonization_outcome_recorded` | HarmonizationOutcomeTracker |
| `harmonization_rule_confidence_adjusted` | HarmonizationCanonRegistry |
| `harmonization.dashboard.emitted` | HarmonizationDashboardBridge |

---

## Initialization Order (main.ts)

```
Phase 5.5 campaign services
  ↓
Phase 5.6 harmonization services (in try/catch):
  HarmonizationCanonRegistry      ← loads built-in rules + overrides
  HarmonizationDriftDetector      ← stateless scanner
  HarmonizationMatcher            ← stateless matcher
  HarmonizationCampaignPlanner    ← stateless planner
  HarmonizationDashboardBridge    ← IPC push bridge
  HarmonizationOutcomeTracker     ← disk-backed outcome store
  HarmonizationCoordinator        ← campaign lifecycle manager
    → recoverStaleCampaigns()
  AutonomousRunOrchestrator.setHarmonizationServices(coordinator)
  new HarmonizationAppService(coordinator, canonRegistry, outcomeTracker)
```

Failure in the Phase 5.6 block leaves the system fully operational on Phase 5.5 behavior.

---

## Operational Constraints

- Maximum 8 files per harmonization campaign (hard cap, not configurable at runtime).
- Maximum 6 steps per harmonization campaign.
- One active harmonization campaign per subsystem at a time.
- Campaigns expire after 6 hours. Stale campaigns are expired at startup.
- 45-minute cooldown after any campaign failure or rollback.
- Protected subsystem exclusions cannot be overridden at runtime.
- Canon rules cannot be added or modified at runtime — only source changes.

---

## Phase 5.6.1 — Harmonization Activation (implemented)

Added in `electron/main.ts` inside the Phase 5.6 try/catch block, as a nested
try/catch that degrades safely if activation itself fails.

### Drift scan loop (8-minute interval)

Every 8 minutes:
1. `gatherHarmonizationFiles()` walks `EFFECTIVE_WORKSPACE_ROOT`, collecting at most
   200 `.ts`, `.tsx`, `.js`, `.json` files into a `Map<filePath, content>`.
   `node_modules`, `dist`, `.git`, `out`, `build`, and similar directories are
   skipped.  Unreadable files are silently skipped.
2. `harmonizationDriftDetector.scan(rules, contentMap)` runs the deterministic
   detector and returns `HarmonizationDriftRecord[]`.
3. `harmonizationCoordinator.storeDriftRecords(records)` merges the results into
   the dashboard-visible pending drift store.
4. For each record that yields a `strong_match` from `HarmonizationMatcher`:
   - `verificationRequirements` are derived from `rule.riskLevel`
     (`low` → `['no_regression']`, `medium` → adds `governance_approved`,
      `high` → adds `human_review`).
   - `HarmonizationCampaignPlanner.plan(input, rule)` builds a bounded campaign.
   - `harmonizationCoordinator.registerCampaign(campaign)` persists it.

### Campaign advancement loop (3-minute interval)

Every 3 minutes:
1. `harmonizationCoordinator.getActiveCampaigns()` returns all non-terminal,
   non-deferred campaigns.
2. For each, `harmonizationCoordinator.advanceCampaign(campaignId)` is called
   exactly once — no inner looping.  The coordinator's own state machine decides
   whether to continue, defer, or complete.

### Safety invariants preserved

- **Re-entrancy guards**: `harmonizationScanInProgress` and
  `harmonizationAdvanceInProgress` boolean flags prevent overlapping ticks.
- **No file mutation in scan**: `gatherHarmonizationFiles()` is read-only.
- **All safety gates intact**: every campaign step still flows through
  `SafeChangePlanner` → `GovernanceAppService` → `ExecutionOrchestrator`.
- **Startup safe**: both loops are wrapped in a nested try/catch; failure
  leaves harmonization in latent/manual mode without crashing the app.
- **Local-first**: no network or model calls; all inputs are local filesystem reads.
