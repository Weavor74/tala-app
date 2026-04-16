# Service: PlanningService

**Source**: [electron/services/planning/PlanningService.ts](../../electron/services/planning/PlanningService.ts)

## Overview

`PlanningService` is the goal → plan → execution handoff lifecycle authority for Tala.

It owns goal intake and registration, deterministic goal analysis, structured plan construction,
approval-state handling, replan generation with traceability, and execution handoff signalling.

This service is a **planning authority, not an executor**.  It does not run workflows, invoke
tools, call LLMs, or perform operator actions.  It prepares a structured, machine-usable
`ExecutionPlan` and signals the appropriate downstream execution authority via telemetry.

## Architecture Position

```
User / Autonomy / Reflection / Operator
  → PlanningService.registerGoal(input)
    → GoalAnalyzer.analyze(goal, availableCapabilities)
      → PlanBuilder.build({ goal, analysis })
        → PlanningRepository  (goal + plan persistence)
          → TelemetryBus      (lifecycle events)

Downstream (not invoked by PlanningService — signalled only):
  WorkflowExecutionService | ToolExecutionCoordinator | AgentKernel | OperatorActionService
```

## What PlanningService Owns

| Domain | Owned |
|--------|-------|
| Goal registration | ✅ |
| Goal analysis | ✅ |
| Plan construction | ✅ |
| Approval-state handling | ✅ |
| Replan generation with traceability | ✅ |
| Planning state transitions | ✅ |
| Execution handoff metadata / signalling | ✅ |
| Correlation ID propagation | ✅ |
| Replan guardrail enforcement | ✅ |

## What PlanningService Does NOT Own

| Domain | Authority |
|--------|-----------|
| Running workflows | WorkflowExecutionService |
| Governed tool invocations | ToolExecutionCoordinator |
| LLM inference calls | AgentKernel / InferenceService |
| Operator actions | OperatorActionService |
| Canonical memory mutations | MemoryAuthorityService |
| Policy evaluation | PolicyGate |

## Subsystem Files

| File | Role |
|------|------|
| `electron/services/planning/PlanningService.ts` | Orchestration + telemetry |
| `electron/services/planning/GoalAnalyzer.ts` | Pure deterministic goal analysis |
| `electron/services/planning/PlanBuilder.ts` | Converts goal + analysis into structured plans |
| `electron/services/planning/PlanningRepository.ts` | In-memory storage seam (goal + plan records) |
| `shared/planning/PlanningTypes.ts` | Canonical domain model types |

## Class: `PlanningService`

Singleton.  Obtain via `PlanningService.getInstance()`.

### Lifecycle

| Method | Description |
|--------|-------------|
| `setAvailableCapabilities(caps)` | Inject the current runtime capability set.  Used when no provider is registered. |
| `registerCapabilityProvider(fn)` | Register a non-manual capability snapshot function.  Called on every `analyzeGoal()` invocation; takes precedence over `setAvailableCapabilities()`. |
| `setReplanPolicy(policy)` | Configure replan guardrails (`maxReplans`, `cooldownMs`). |

### Goal Management

| Method | Returns | Description |
|--------|---------|-------------|
| `registerGoal(input)` | `PlanGoal` | Register a new goal; assigns `correlationId` and `replanCount: 0`; emits `planning.goal_registered`. |
| `getGoal(goalId)` | `PlanGoal \| undefined` | Retrieve a goal by id. |

### Analysis and Plan Building

| Method | Returns | Description |
|--------|---------|-------------|
| `analyzeGoal(goalId)` | `GoalAnalysis` | Run deterministic analysis using provider-supplied capabilities (or manual fallback); emits `planning.goal_analyzed`. |
| `buildPlan(goalId)` | `ExecutionPlan` | Run analysis + build structured plan with typed `ExecutionHandoff` contract; emits `planning.plan_created` or `planning.plan_blocked`. |

### Approval

| Method | Returns | Description |
|--------|---------|-------------|
| `approvePlan(planId, actor)` | `ExecutionPlan` | Approve a pending plan; emits `planning.plan_approved`. |
| `denyPlan(planId, actor, reason)` | `ExecutionPlan` | Deny a pending plan; emits `planning.plan_denied`. |

### Plan Access

| Method | Returns | Description |
|--------|---------|-------------|
| `getPlan(planId)` | `ExecutionPlan \| undefined` | Retrieve a plan by id. |
| `listPlansForGoal(goalId)` | `ExecutionPlan[]` | All plans for a goal, ordered by version ascending. |

### Execution Lifecycle

| Method | Returns | Description |
|--------|---------|-------------|
| `markExecutionStarted(planId)` | `ExecutionPlan` | Signal that execution has been handed off; emits `planning.execution_handoff`. |
| `markExecutionCompleted(planId)` | `ExecutionPlan` | Signal successful completion; emits `planning.plan_completed`. |
| `markExecutionFailed(planId, reason)` | `ExecutionPlan` | Signal execution failure; emits `planning.plan_failed`. |

### Replanning

| Method | Returns | Description |
|--------|---------|-------------|
| `replan(request)` | `ExecutionPlan` | Generate a new versioned plan superseding the prior plan.  Prior plan is preserved as `superseded`.  Guardrails enforced.  Emits `planning.replan_requested`, `planning.plan_superseded`, and `planning.plan_created` (or `planning.plan_blocked`). |

## Typed Execution Handoff Contract

Each `ExecutionPlan` carries a `handoff: ExecutionHandoff` discriminated union:

```typescript
type ExecutionHandoff =
  | { type: 'workflow';  contractVersion: 1; workflowId: string; inputs: ... }
  | { type: 'tool';      contractVersion: 1; toolIds: string[]; inputs: ... }
  | { type: 'agent';     contractVersion: 1; executionMode: ...; inputs: ... }
  | { type: 'operator';  contractVersion: 1; actionType: string; rationale: string }
  | { type: 'none';      contractVersion: 1; reason: string }
```

The legacy string field `handoffTarget` is preserved for backward compatibility (derived
from the typed union).

PlanningService **signals** the handoff; it does not execute it.

## Correlation IDs

Every `PlanGoal` receives a `correlationId` (prefix `corr-`) at registration time.
This identifier is:
- Stored on the goal record
- Included in all telemetry events emitted for that goal and its plans
- Preserved through replanning

Use `correlationId` to correlate all planning events across the full goal → plan → execution
lifecycle.

## Replan Guardrails

Replan calls are governed by a `ReplanPolicy` (configurable via `setReplanPolicy()`):

| Policy field | Default | Behaviour |
|---|---|---|
| `maxReplans` | 5 | Maximum replans per goal; exceeding throws `REPLAN_LIMIT_EXCEEDED`. |
| `cooldownMs` | 30 000 | Minimum ms between replans; violation throws `REPLAN_COOLDOWN_ACTIVE`. |

Goal records carry a `replanCount` field that is incremented on each successful replan.

## Approval Context

When a goal analysis determines that approval is required, the `ExecutionPlan` carries an
`approvalContext: ApprovalContext` with:

| Field | Description |
|---|---|
| `triggeredBy` | Machine-readable `ApprovalTrigger[]` codes (e.g. `critical_risk`, `autonomy_source`) |
| `reasons` | Human-readable reason strings, parallel to `triggeredBy` |
| `riskLevel` | Risk level as assessed at analysis time |
| `mitigations` | Optional suggestions for reducing risk on replan |

`GoalAnalysis` also carries `approvalContext` for early inspection before plan construction.

## Non-Manual Capability Snapshot

`registerCapabilityProvider(fn: () => ReadonlySet<string>)` registers a callback that is
invoked on every `analyzeGoal()` call.  This eliminates the need for callers to explicitly
call `setAvailableCapabilities()` on every capability change.

When a provider is registered, it takes precedence over the manually-injected set.
The manual path (`setAvailableCapabilities()`) remains available as a fallback.

## IPC Surface

The following `planning:*` IPC channels are registered in `IpcRouter.ts`:

| Channel | Method |
|---|---|
| `planning:getGoal` | `getGoal(goalId)` |
| `planning:getPlan` | `getPlan(planId)` |
| `planning:listPlansForGoal` | `listPlansForGoal(goalId)` |
| `planning:buildPlan` | `buildPlan(goalId)` |
| `planning:approvePlan` | `approvePlan(planId, actor)` |
| `planning:denyPlan` | `denyPlan(planId, actor, reason)` |
| `planning:markExecutionStarted` | `markExecutionStarted(planId)` |
| `planning:replan` | `replan(request)` |

These channels expose planning state to the renderer.  They do not execute plans.

## How Approval Works

Plans that require approval (high/critical risk, operator-sourced goals, LLM-assisted
non-conversation goals, or provider/config-changing goals) are constructed with:

```
status:        'draft'
approvalState: 'pending'
approvalContext: { triggeredBy: [...], reasons: [...], riskLevel: '...' }
```

The plan cannot transition to `executing` until `approvePlan()` is called.
`denyPlan()` marks the plan `status:'blocked', approvalState:'denied'` and transitions the
goal to `blocked`.

Calling `markExecutionStarted()` on a plan that requires approval but is not yet approved
raises a `PlanningError` with code `APPROVAL_REQUIRED`.

## How Replanning Works

```
svc.replan({ goalId, priorPlanId, trigger: 'capability_loss', triggerDetails: '...' })
```

1. Guardrails are checked first (`maxReplans`, `cooldownMs`).  Violations throw immediately.
2. Prior plan is preserved in the repository with `status:'superseded'` and a forward link
   `supersededByPlanId` pointing to the new plan.
3. Goal status is reset to `'registered'` for a fresh analysis cycle.
4. A new `GoalAnalysis` is produced using provider-supplied capabilities (or manual fallback).
5. `PlanBuilder.build({ goal, analysis, priorPlan })` produces a new plan with:
   - `version = priorPlan.version + 1`
   - `replannedFromPlanId = priorPlan.id`
6. `goal.replanCount` is incremented.
7. Events emitted: `planning.replan_requested`, `planning.plan_superseded`,
   `planning.plan_created` (or `planning.plan_blocked`).

**No silent overwrite** — the prior plan record is always preserved.

## Telemetry Events

All events include `correlationId` in the payload when available.

| Event | When | Key Payload Fields |
|-------|------|--------------------|
| `planning.goal_registered` | Goal registered | `goalId`, `correlationId`, `source`, `category`, `priority` |
| `planning.goal_analyzed` | Analysis complete | `goalId`, `correlationId`, `executionStyle`, `requiresApproval`, `blocked`, `missingCapabilities`, `risk`, `confidence`, `durationMs` |
| `planning.plan_created` | Plan built successfully | `goalId`, `correlationId`, `planId`, `plannerType`, `version`, `stageCount`, `requiresApproval`, `approvalState`, `handoffTarget` |
| `planning.plan_blocked` | Plan blocked (missing cap / policy) | `goalId`, `correlationId`, `planId`, `reasonCodes` |
| `planning.plan_approved` | Plan approved | `goalId`, `correlationId`, `planId`, `actor`, `approvedAt` |
| `planning.plan_denied` | Plan denied | `goalId`, `correlationId`, `planId`, `actor`, `reason` |
| `planning.execution_handoff` | Execution handed off | `goalId`, `correlationId`, `planId`, `handoffTarget`, `handoffType`, `plannerType`, `version` |
| `planning.replan_requested` | Replan triggered | `goalId`, `correlationId`, `priorPlanId`, `trigger`, `triggerDetails`, `replanCount` |
| `planning.plan_superseded` | Prior plan superseded | `goalId`, `correlationId`, `supersededPlanId`, `newPlanId` |
| `planning.plan_completed` | Execution completed | `goalId`, `correlationId`, `planId`, `version` |
| `planning.plan_failed` | Execution failed | `goalId`, `correlationId`, `planId`, `reason`, `version` |

## Doctrine Preserved

This service preserves the following Tala architectural invariants:

1. **Postgres is canonical authority** — PlanningService uses an in-memory repository
   (seam-ready for future DB backing) and does not directly mutate canonical memory.
2. **Policy-gated actions remain gated** — approval-required plans cannot proceed to
   execution without explicit sign-off; this mirrors PolicyGate semantics for planning.
3. **Tool execution remains governed** — `ExecutionPlan.handoff` names the downstream
   executor but PlanningService never invokes it.
4. **No fake readiness** — blocked analysis produces a blocked plan; missing capabilities
   are surfaced explicitly.
5. **No silent history mutation** — replanning preserves the prior plan with status
   `superseded` and bidirectional links.
6. **Deterministic first** — GoalAnalyzer uses rule-based heuristics; LLM-assisted
   execution style is only selected for genuinely novel or conversation goals.
7. **No loopy autonomous replanning** — replan guardrails (`maxReplans`, `cooldownMs`)
   prevent runaway replanning cycles.
8. **No hidden side effects** — all planning mutations are explicit, observable via
   telemetry events, and include a stable `correlationId` for cross-lifecycle tracing.


**Source**: [electron/services/planning/PlanningService.ts](../../electron/services/planning/PlanningService.ts)

## Overview

`PlanningService` is the goal → plan → execution handoff lifecycle authority for Tala.

It owns goal intake and registration, deterministic goal analysis, structured plan construction,
approval-state handling, replan generation with traceability, and execution handoff signalling.

This service is a **planning authority, not an executor**.  It does not run workflows, invoke
tools, call LLMs, or perform operator actions.  It prepares a structured, machine-usable
`ExecutionPlan` and signals the appropriate downstream execution authority via telemetry.

## Architecture Position

```
User / Autonomy / Reflection / Operator
  → PlanningService.registerGoal(input)
    → GoalAnalyzer.analyze(goal, availableCapabilities)
      → PlanBuilder.build({ goal, analysis })
        → PlanningRepository  (goal + plan persistence)
          → TelemetryBus      (lifecycle events)

Downstream (not invoked by PlanningService — signalled only):
  WorkflowExecutionService | ToolExecutionCoordinator | AgentKernel | OperatorActionService
```

## What PlanningService Owns

| Domain | Owned |
|--------|-------|
| Goal registration | ✅ |
| Goal analysis | ✅ |
| Plan construction | ✅ |
| Approval-state handling | ✅ |
| Replan generation with traceability | ✅ |
| Planning state transitions | ✅ |
| Execution handoff metadata / signalling | ✅ |

## What PlanningService Does NOT Own

| Domain | Authority |
|--------|-----------|
| Running workflows | WorkflowExecutionService |
| Governed tool invocations | ToolExecutionCoordinator |
| LLM inference calls | AgentKernel / InferenceService |
| Operator actions | OperatorActionService |
| Canonical memory mutations | MemoryAuthorityService |
| Policy evaluation | PolicyGate |

## Subsystem Files

| File | Role |
|------|------|
| `electron/services/planning/PlanningService.ts` | Orchestration + telemetry |
| `electron/services/planning/GoalAnalyzer.ts` | Pure deterministic goal analysis |
| `electron/services/planning/PlanBuilder.ts` | Converts goal + analysis into structured plans |
| `electron/services/planning/PlanningRepository.ts` | In-memory storage seam (goal + plan records) |
| `shared/planning/PlanningTypes.ts` | Canonical domain model types |

## Class: `PlanningService`

Singleton.  Obtain via `PlanningService.getInstance()`.

### Lifecycle

| Method | Description |
|--------|-------------|
| `setAvailableCapabilities(caps)` | Inject the current runtime capability set.  Must be called before `analyzeGoal()` for accurate missing-capability detection. |

### Goal Management

| Method | Returns | Description |
|--------|---------|-------------|
| `registerGoal(input)` | `PlanGoal` | Register a new goal; emits `planning.goal_registered`. |
| `getGoal(goalId)` | `PlanGoal \| undefined` | Retrieve a goal by id. |

### Analysis and Plan Building

| Method | Returns | Description |
|--------|---------|-------------|
| `analyzeGoal(goalId)` | `GoalAnalysis` | Run deterministic analysis; emits `planning.goal_analyzed`. |
| `buildPlan(goalId)` | `ExecutionPlan` | Run analysis + build structured plan; emits `planning.plan_created` or `planning.plan_blocked`. |

### Approval

| Method | Returns | Description |
|--------|---------|-------------|
| `approvePlan(planId, actor)` | `ExecutionPlan` | Approve a pending plan; emits `planning.plan_approved`. |
| `denyPlan(planId, actor, reason)` | `ExecutionPlan` | Deny a pending plan; emits `planning.plan_denied`. |

### Plan Access

| Method | Returns | Description |
|--------|---------|-------------|
| `getPlan(planId)` | `ExecutionPlan \| undefined` | Retrieve a plan by id. |
| `listPlansForGoal(goalId)` | `ExecutionPlan[]` | All plans for a goal, ordered by version ascending. |

### Execution Lifecycle

| Method | Returns | Description |
|--------|---------|-------------|
| `markExecutionStarted(planId)` | `ExecutionPlan` | Signal that execution has been handed off; emits `planning.execution_handoff`. |
| `markExecutionCompleted(planId)` | `ExecutionPlan` | Signal successful completion; emits `planning.plan_completed`. |
| `markExecutionFailed(planId, reason)` | `ExecutionPlan` | Signal execution failure; emits `planning.plan_failed`. |

### Replanning

| Method | Returns | Description |
|--------|---------|-------------|
| `replan(request)` | `ExecutionPlan` | Generate a new versioned plan superseding the prior plan.  Prior plan is preserved as `superseded`.  Emits `planning.replan_requested`, `planning.plan_superseded`, and `planning.plan_created` (or `planning.plan_blocked`). |

## How Approval Works

Plans that require approval (high/critical risk, operator-sourced goals, LLM-assisted
non-conversation goals, or provider/config-changing goals) are constructed with:

```
status:        'draft'
approvalState: 'pending'
```

The plan cannot transition to `executing` until `approvePlan()` is called.
`denyPlan()` marks the plan `status:'blocked', approvalState:'denied'` and transitions the
goal to `blocked`.

Calling `markExecutionStarted()` on a plan that requires approval but is not yet approved
raises a `PlanningError` with code `APPROVAL_REQUIRED`.

## How Replanning Works

```
svc.replan({ goalId, priorPlanId, trigger: 'capability_loss', triggerDetails: '...' })
```

1. Prior plan is preserved in the repository with `status:'superseded'` and a forward link
   `supersededByPlanId` pointing to the new plan.
2. Goal status is reset to `'registered'` for a fresh analysis cycle.
3. A new `GoalAnalysis` is produced with the current capability set.
4. `PlanBuilder.build({ goal, analysis, priorPlan })` produces a new plan with:
   - `version = priorPlan.version + 1`
   - `replannedFromPlanId = priorPlan.id`
5. Events emitted: `planning.replan_requested`, `planning.plan_superseded`,
   `planning.plan_created` (or `planning.plan_blocked`).

**No silent overwrite** — the prior plan record is always preserved.

## Telemetry Events

| Event | When | Key Payload Fields |
|-------|------|--------------------|
| `planning.goal_registered` | Goal registered | `goalId`, `source`, `category`, `priority` |
| `planning.goal_analyzed` | Analysis complete | `goalId`, `executionStyle`, `requiresApproval`, `blocked`, `missingCapabilities`, `risk`, `confidence`, `durationMs` |
| `planning.plan_created` | Plan built successfully | `goalId`, `planId`, `plannerType`, `version`, `stageCount`, `requiresApproval`, `approvalState`, `handoffTarget` |
| `planning.plan_blocked` | Plan blocked (missing cap / policy) | `goalId`, `planId`, `reasonCodes` |
| `planning.plan_approved` | Plan approved | `goalId`, `planId`, `actor`, `approvedAt` |
| `planning.plan_denied` | Plan denied | `goalId`, `planId`, `actor`, `reason` |
| `planning.execution_handoff` | Execution handed off | `goalId`, `planId`, `handoffTarget`, `plannerType`, `version` |
| `planning.replan_requested` | Replan triggered | `goalId`, `priorPlanId`, `trigger`, `triggerDetails` |
| `planning.plan_superseded` | Prior plan superseded | `goalId`, `supersededPlanId`, `newPlanId` |
| `planning.plan_completed` | Execution completed | `goalId`, `planId`, `version` |
| `planning.plan_failed` | Execution failed | `goalId`, `planId`, `reason`, `version` |

## Doctrine Preserved

This service preserves the following Tala architectural invariants:

1. **Postgres is canonical authority** — PlanningService uses an in-memory repository
   (seam-ready for future DB backing) and does not directly mutate canonical memory.
2. **Policy-gated actions remain gated** — approval-required plans cannot proceed to
   execution without explicit sign-off; this mirrors PolicyGate semantics for planning.
3. **Tool execution remains governed** — `ExecutionPlan.handoffTarget` names the downstream
   executor but PlanningService never invokes it.
4. **No fake readiness** — blocked analysis produces a blocked plan; missing capabilities
   are surfaced explicitly.
5. **No silent history mutation** — replanning preserves the prior plan with status
   `superseded` and bidirectional links.
6. **Deterministic first** — GoalAnalyzer uses rule-based heuristics; LLM-assisted
   execution style is only selected for genuinely novel or conversation goals.
