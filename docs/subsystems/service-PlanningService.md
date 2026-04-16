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
