# Service: PlanningLoopService

**Source**: [electron/services/planning/PlanningLoopService.ts](../../electron/services/planning/PlanningLoopService.ts)

## Overview

`PlanningLoopService` is the authoritative orchestrator for all non-trivial outcome-seeking work
in Tala.  It governs the full:

```
PLAN → EXECUTE → OBSERVE → REPLAN (repeat) → COMPLETE / ABORT / FAIL
```

lifecycle and is the single service responsible for driving that cycle to a deterministic
terminal state.  It is a **planning loop authority**, not an executor — it delegates
plan creation to `PlanningService` and execution to an injected `ILoopExecutor`.

## Architecture Position

```
Caller (AgentKernel / Autonomy / Operator)
  → PlanningLoopService.startLoop(input)
      [INITIALIZING]  normalize goal
      [PLANNING]      PlanningService.registerGoal + buildPlan
      [READY_FOR_EXECUTION]  (approval gate if required)
      [EXECUTING]     ILoopExecutor.executePlan(plan)
      [OBSERVING]     ILoopObserver.observe(result) → LoopObservationResult
      decision: complete | replan | abort
      [REPLANNING]    PlanningService.replan()
      (loop back to EXECUTING, bounded by maxIterations)
      [COMPLETED / ABORTED / FAILED]  → final PlanningLoopRun
```

## What PlanningLoopService Owns

| Domain | Owned |
|--------|-------|
| Loop initialisation and goal normalisation | ✅ |
| Phase state machine (9 phases) | ✅ |
| Plan acquisition (via PlanningService) | ✅ |
| Execution dispatch (via ILoopExecutor) | ✅ |
| Observation of execution results (via ILoopObserver) | ✅ |
| Replan decisions (typed, deterministic) | ✅ |
| Anti-infinite-loop protection | ✅ |
| Loop state persistence (in-memory) | ✅ |
| Telemetry emission for all phases | ✅ |

## What PlanningLoopService Does NOT Own

| Domain | Authority |
|--------|-----------|
| Tool execution | ToolExecutionCoordinator |
| Workflow execution | WorkflowExecutionService |
| LLM inference | InferenceService / AgentKernel |
| Canonical memory mutation | MemoryAuthorityService |
| Policy evaluation | PolicyGate |
| Plan construction / analysis | PlanningService |

## Subsystem Files

| File | Role |
|------|------|
| `electron/services/planning/PlanningLoopService.ts` | Loop orchestration + telemetry |
| `shared/planning/planningLoopTypes.ts` | Shared type contracts for the loop |
| `tests/PlanningLoopService.test.ts` | 55 governance-grade tests (PLS01–PLS55) |

## Loop Phase State Machine

```
initializing
  → planning
      → ready_for_execution
          → executing
              → observing
                  → completed          (decision: complete)
                  → aborted            (decision: abort)
                  → replanning
                      → ready_for_execution  (iterate)
                      → failed         (replan rejected)
      → failed                         (plan_blocked)
  → failed                             (internal_error)
```

## Telemetry Events

All events are emitted through `TelemetryBus` with `subsystem: 'planning'`.

| Event | When |
|-------|------|
| `planning.loop_started` | Loop initialised |
| `planning.loop_phase_transition` | Every phase change (carries `from`/`to`) |
| `planning.loop_iteration_started` | Start of each execute–observe cycle |
| `planning.loop_observation` | After `ILoopObserver.observe()` completes |
| `planning.loop_replan_decision` | After each decision (complete/replan/abort) |
| `planning.loop_completed` | Terminal: success |
| `planning.loop_aborted` | Terminal: abort |
| `planning.loop_failed` | Terminal: failure |

All events carry `loopId` and `correlationId` for cross-subsystem traceability.

## Design Invariants

1. **No direct execution** — PlanningLoopService never calls tools, workflows, or models
   directly.  Execution is always delegated to `ILoopExecutor`.
2. **No duplicate planning authority** — Plan creation and replanning are always delegated
   to `PlanningService`.  PlanningLoopService never constructs plans.
3. **Deterministic termination** — Every exit path sets an explicit `completionReason` or
   `failureReason`; silent exits are disallowed.
4. **Anti-infinite-loop** — `maxIterations` (per-run) and `PlanningService` replan guardrails
   (`maxReplans`, `cooldownMs`) together enforce a hard upper bound.
5. **Observable** — `getRun(loopId)` and `listRuns()` expose all loop state without requiring
   callers to maintain their own copies.
6. **Traceable** — Every event carries the `loopId` and `correlationId` generated at loop
   start, enabling full cross-subsystem telemetry correlation.

## Loop Policy

Configurable via `setPolicy(PlanningLoopPolicy)`:

| Field | Default | Description |
|-------|---------|-------------|
| `defaultMaxIterations` | 5 | Default max execute–observe cycles per run |
| `allowReplanOnFailure` | `true` | Whether execution failure triggers replan |
| `allowReplanOnPartial` | `true` | Whether partial success triggers replan |

## Failure Reasons

| Reason | Description |
|--------|-------------|
| `max_iterations_exceeded` | Loop exhausted `maxIterations` without completing |
| `replan_limit_exceeded` | PlanningService rejected replan (too many replans for goal) |
| `replan_cooldown_active` | PlanningService rejected replan (cooldown period active) |
| `plan_blocked` | Initial or replanned plan has `status: 'blocked'` |
| `execution_failed` | Execution failed and `allowReplanOnFailure` is false |
| `abort_requested` | `abortLoop()` called or `blocked` observation with no replan |
| `internal_error` | Unexpected internal error in the loop service |

## Usage

```typescript
// Inject executor and observer (implementations wrap ToolExecutionCoordinator,
// WorkflowExecutionService, or AgentKernel as appropriate).
PlanningLoopService._resetForTesting(myExecutor, myObserver, myPlanningService);
const svc = PlanningLoopService.getInstance();

const run = await svc.startLoop({
    goal: 'Run memory maintenance and verify canon health',
    maxIterations: 5,
});

if (run.phase === 'completed') {
    console.log('Loop completed:', run.completionReason);
} else {
    console.error('Loop failed:', run.failureReason, run.failureDetail);
}
```

## Test Coverage (PLS01–PLS55)

| Range | Coverage |
|-------|----------|
| PLS01–PLS05 | Loop initialisation, input validation |
| PLS06–PLS10 | Success path (goal→plan→execute→observe→complete) |
| PLS11–PLS15 | Failure path (execution failure → loop failed) |
| PLS16–PLS20 | Replan path (failure → replan → success) |
| PLS21–PLS25 | Max iterations protection |
| PLS26–PLS30 | Abort path |
| PLS31–PLS35 | Plan blocked path |
| PLS36–PLS40 | Telemetry (all loop events) |
| PLS41–PLS45 | Policy configuration |
| PLS46–PLS50 | State access (getRun, listRuns, snapshot isolation) |
| PLS51–PLS55 | Replan guardrail propagation |
