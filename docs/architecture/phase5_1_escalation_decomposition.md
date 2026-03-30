# Phase 5.1: Model Escalation & Bounded Decomposition

## Overview

Phase 5.1 adds a deterministic decision layer that allows Tala to decide **how to execute a task given model constraints**. It sits between Phase 5 (Adaptive Intelligence) and Phase 2 (Safe Change Planning) in the `AutonomousRunOrchestrator` pipeline.

Phase 5 answers: **WHAT to do** (goal selection, strategy, value scoring).
Phase 5.1 answers: **HOW to do it** given the active model's capability limits.

This layer is fully optional: when escalation services are not injected, the orchestrator proceeds identically to Phase 5 behavior.

---

## Decision Model

For any task that reaches Phase 5.1:

```
IF active_model_can_handle:
    proceed_local (standard pipeline)

ELSE IF escalation_allowed:
    escalate_remote (when !requireHumanApprovalForRemote)
    OR escalate_human (when requireHumanApprovalForRemote=true — the default)

ELSE IF decomposition_possible:
    decompose_local (bounded step execution using first-step scope)

ELSE IF insufficiency_reasons present:
    defer (re-queue for next cycle)

ELSE:
    escalate_human (no autonomous resolution possible)
```

---

## Architecture

```
GoalDetectionEngine
  → GoalPrioritizationEngine (P4C + P5 blended confidence)
    → AutonomyPolicyGate (P4D — required gate)
      → [Phase 5 Adaptive Layer — optional]
          GoalValueScoringEngine → StrategySelectionEngine → AdaptivePolicyGate
          → proceed
      → [Phase 5.1 Escalation Layer — optional]
          ModelCapabilityEvaluator     (P5.1B — can model handle this?)
          → EscalationPolicyEngine     (P5.1C — is escalation allowed?)
          → DecompositionEngine        (P5.1D — can we decompose?)
          → ExecutionStrategySelector  (P5.1E — which strategy?)
            → proceed_local   → _executeGoalPipeline (standard path)
            → decompose_local → _executeGoalPipeline (with scopeHint from first step)
            → escalate_human  → goal → policy_blocked + humanReviewRequired=true
            → defer           → goal → scored (re-queue next cycle)
            → escalate_remote → goal → policy_blocked + humanReviewRequired=true (default)
      → _executeGoalPipeline
          finally: DecompositionOutcomeTracker.finalizePlan() (when decomposing)
          finally: EscalationAuditTracker.record() (always)
```

---

## Component Responsibilities

### `shared/escalationTypes.ts` — P5.1A

All Phase 5.1 canonical type contracts. Key types:

| Type | Description |
|------|-------------|
| `TaskCapabilityAssessment` | Evaluation result: canHandle, insufficiencyReasons, complexityScore, estimatedContextTokens |
| `EscalationPolicy` | 5 policy kinds + bounds: max depth, max steps, spam limit, human approval flag |
| `EscalationRequest` / `EscalationDecision` | Escalation request and policy decision |
| `DecompositionPlan` / `DecompositionStep` | Bounded plan; bounded=true is a safety invariant |
| `ExecutionStrategyDecision` | 5 strategy kinds: proceed_local, escalate_remote, decompose_local, defer, escalate_human |
| `EscalationAuditRecord` | Immutable audit record for all escalation/decomposition events |
| `EscalationDashboardState` | Dashboard state with KPIs, recent records, active decompositions |
| `DEFAULT_ESCALATION_POLICY` | Conservative local-first defaults |

---

### `ModelCapabilityEvaluator` — P5.1B

**File:** `electron/services/autonomy/escalation/ModelCapabilityEvaluator.ts`

Evaluates whether the active model can handle a goal. Fully deterministic: same inputs → same result. No model calls.

**Insufficiency signals** (all evaluated; any triggered → `canHandle=false`):

| Signal | Condition |
|--------|-----------|
| `context_size_exceeded` | `estimatedContextTokens / modelContextLimit >= contextSizeThresholdRatio` AND `recentFailures >= minFailuresForContextTrigger` |
| `repeated_local_failures` | `recentLocalFailures >= minLocalFailuresBeforeEscalation` |
| `high_complexity_task` | `complexityScore >= highComplexityThreshold` AND `recentFailures >= minFailuresForContextTrigger` |
| `multi_file_repair_scope` | Goal title/description contains multi-file keywords AND `recentFailures >= minFailuresForContextTrigger` |
| `recovery_pack_exhausted` | All matched recovery packs tried and failed |

**Complexity score** (0–100, clamped):
```
= min(25, floor(descriptionLength / 40))   // description length (0–25)
+ min(30, recentLocalFailures * 10)         // failure count (0–30)
+ 20 if subsystem in HIGH_COMPLEXITY_SET    // subsystem bonus (0 or 20)
+ 25 if multi-file keywords present        // multi-file bonus (0 or 25)
```

---

### `EscalationPolicyEngine` — P5.1C

**File:** `electron/services/autonomy/escalation/EscalationPolicyEngine.ts`

Applies escalation policy to an insufficiency assessment. Rules evaluated in order (first match wins):

1. `policyKind === 'local_only'` → **deny** (never escalate)
2. `recentEscalationCount >= maxEscalationRequestsPerHour` → **deny** (spam guard)
3. `recentLocalFailures < minLocalFailuresBeforeEscalation` (and no pack exhaustion) → **deny** (not justified)
4. `policyKind === 'remote_required_for_high_complexity'` AND `high_complexity_task` in reasons → **allow**
5. `policyKind === 'auto_escalate_for_allowed_classes'` AND task class in `allowedTaskClasses` → **allow**
6. `policyKind in ['remote_allowed', 'local_preferred_with_request']` → **allow** (with human approval if configured)
7. Fallback → **deny**

When `requireHumanApprovalForRemote=true` (default), allowed escalations set `requiresHumanApproval=true`, routing to `escalate_human` instead of `escalate_remote`.

---

### `DecompositionEngine` — P5.1D

**File:** `electron/services/autonomy/escalation/DecompositionEngine.ts`

Creates bounded decomposition plans. Returns `null` when depth ≥ `maxDecompositionDepth`.

**Decomposition strategies** (evaluated in order):

| Strategy | Triggered when | Step kind |
|----------|---------------|-----------|
| file_scope | `multi_file_repair_scope` in reasons AND ≥ 2 file scopes extractable | `file_scope` |
| change_type | `high_complexity_task` in reasons | `change_type` (3 steps: analyze, apply, verify) |
| verification_stage | `repeated_local_failures` AND `recentLocalFailures >= 2` | `verification_stage` (4 steps: prepare, apply, verify, finalize) |
| partial_fix | Any insufficiency reason (fallback) | `partial_fix` (1 step) |

**Safety invariants for all plans:**
- `steps.length <= policy.maxStepsPerDecomposition`
- `depth <= policy.maxDecompositionDepth`
- Every step: `independent=true`, `verifiable=true`, `rollbackable=true`
- `bounded=true` always

---

### `ExecutionStrategySelector` — P5.1E

**File:** `electron/services/autonomy/escalation/ExecutionStrategySelector.ts`

6-rule deterministic strategy selector:

1. `canHandle=true` → `proceed_local`
2. `escalationAllowed && !requiresHumanApproval` → `escalate_remote`
3. `escalationAllowed && requiresHumanApproval` → `escalate_human`
4. `decompositionPlan != null` → `decompose_local`
5. `insufficiencyReasons.length > 0` → `defer`
6. Fallback → `escalate_human`

**Critical:** Under `DEFAULT_ESCALATION_POLICY`, `requireHumanApprovalForRemote=true`, so `escalate_remote` is unreachable in default configuration. All remote escalation goes through `escalate_human` for governance.

---

### `EscalationAuditTracker` — P5.1F

**File:** `electron/services/autonomy/escalation/EscalationAuditTracker.ts`

In-memory audit trail for all escalation events. Capped at 500 records (newest first).

Events recorded: `capability_assessed`, `escalation_requested`, `escalation_allowed`, `escalation_denied`, `escalation_approved_by_human`, `decomposition_planned`, `decomposition_started`, `decomposition_step_completed`, `decomposition_completed`, `decomposition_failed`, `strategy_selected`, `fallback_applied`.

Provides `getRecentEscalationCount(windowMs)` for EscalationPolicyEngine spam guard.

---

### `DecompositionOutcomeTracker` — P5.1F

**File:** `electron/services/autonomy/escalation/DecompositionOutcomeTracker.ts`

Tracks decomposition plan lifecycle and enforces post-failure cooldown.

- `startPlan()` — registers plan as in-progress
- `recordStep()` — records individual step outcomes
- `finalizePlan()` — computes `overallOutcome`, applies cooldown when `outcome='failed'`
- `isCooldownActive(subsystemId)` — returns true during cooldown window

Cooldown applies **per-subsystem** after full failure. Prevents repeated decomposition spam.

---

## Integration Point

Phase 5.1 runs in `AutonomousRunOrchestrator._selectAndExecuteGoal()`, **after** the Phase 5 adaptive gate decision (`proceed`) and **before** `_executeGoalPipeline()`:

```typescript
// Phase 5.1 gate (runs only when escalation services are injected)
const recentFailures = this._getRecentFailuresForSubsystem(goal.subsystemId);
const assessment = capabilityEvaluator.evaluate(goal, recentFailures, policy);

if (!assessment.canHandle) {
    const { decision } = escalationPolicyEngine.evaluate(assessment, policy, ...);
    const plan = decompositionEngine.decompose(goal, assessment, policy, 0);
    const strategy = strategySelector.select(assessment, decision, plan, policy);

    // Act on strategy: proceed_local | escalate_human | defer | decompose_local | escalate_remote
    ...
}
// falls through to _executeGoalPipeline normally when canHandle=true or strategy=proceed_local
```

Decomposition execution passes the first step's `scopeHint` as a scope modifier to `_buildPlanInput()`, narrowing the planning description to the reduced scope.

---

## Injection

Escalation services are injected after construction and after `setAdaptiveServices()` (if used):

```typescript
orchestrator.setEscalationServices(
    new ModelCapabilityEvaluator(),
    new EscalationPolicyEngine(),
    new DecompositionEngine(),
    new ExecutionStrategySelector(),
    new EscalationAuditTracker(),
    new DecompositionOutcomeTracker(),
    policy?, // optional override of DEFAULT_ESCALATION_POLICY
);
```

When not called, the orchestrator behaves identically to Phase 5.

---

## Dashboard Integration

`AutonomousRunOrchestrator.getEscalationDashboardState()` returns `EscalationDashboardState | null`.

`getDashboardState()` augments the returned `AutonomyDashboardState` with `state.escalationState` when services are active.

**KPIs tracked:**

| KPI | Description |
|-----|-------------|
| `totalAssessments` | All capability assessments performed |
| `totalCapableAssessments` | Assessments where `canHandle=true` |
| `totalIncapableAssessments` | Assessments where `canHandle=false` |
| `totalEscalationRequests` | Escalation requests generated |
| `totalEscalationsAllowed/Denied` | Policy outcome counts |
| `totalDecompositions` | Decomposition plans created |
| `totalDecompositionsSucceeded/Failed` | Decomposition outcomes |
| `totalDeferredByEscalation` | Goals deferred by this layer |
| `totalHumanEscalations` | Goals routed to human review by this layer |

---

## Safety Invariants

1. **No silent remote escalation** — `requireHumanApprovalForRemote=true` by default. Escalate_remote is unreachable in default configuration.
2. **No bypass of governance** — escalated goals use existing `policy_blocked + humanReviewRequired=true` mechanism.
3. **No infinite decomposition** — `maxDecompositionDepth` hard cap (default: 2). Returns null beyond depth.
4. **Bounded step count** — `maxStepsPerDecomposition` hard cap (default: 5).
5. **Decomposition cooldown** — per-subsystem cooldown after failed decomposition (default: 30 min).
6. **Escalation spam guard** — maximum `maxEscalationRequestsPerHour` (default: 3).
7. **Error isolation** — exceptions in the escalation layer are caught and logged. Pipeline falls back to standard execution.
8. **No recursion** — decomposition does not trigger new detection cycles.
9. **No model calls** — all assessment and selection is deterministic rule-based computation.
10. **Phase 5 gate respected** — Phase 5.1 only runs when Phase 5 adaptive gate returned `proceed`. Phase 5 escalate/defer/suppress are never overridden.

---

## Default Policy

Defined in `shared/escalationTypes.ts` as `DEFAULT_ESCALATION_POLICY`:

| Setting | Default | Purpose |
|---------|---------|---------|
| `policyKind` | `local_preferred_with_request` | Prefer local; allow requesting remote |
| `maxEscalationRequestsPerHour` | 3 | Anti-spam guard |
| `minLocalFailuresBeforeEscalation` | 2 | Require evidence of local failure first |
| `maxDecompositionDepth` | 2 | Prevent infinite decomposition recursion |
| `maxStepsPerDecomposition` | 5 | Bound step count per plan |
| `decompositionCooldownMs` | 30 min | Cooldown after failed decomposition |
| `requireHumanApprovalForRemote` | true | No silent remote escalation |
| `highComplexityThreshold` | 70 | Complexity score trigger (0–100) |
| `contextSizeThresholdRatio` | 0.85 | Context utilization trigger |
| `minFailuresForContextTrigger` | 1 | Min failures to trigger context/complexity signals |

---

## Relationship to Prior Phases

| Phase | Provides to P5.1 |
|-------|-----------------|
| Phase 4C (`GoalPrioritizationEngine`) | Goal context (subsystemId, description, title) |
| Phase 4D (`AutonomyPolicyGate`) | Phase 5.1 only runs when P4D permitted |
| Phase 4.3 (`RecoveryPackOutcomeTracker`) | Pack exhaustion signal (optional) |
| Phase 5 (`AdaptivePolicyGate`) | Phase 5.1 only runs when Phase 5 returned `proceed` |
| Phase 2 (`SafeChangePlanner`) | Receives narrowed description from decompositionScopeHint |
