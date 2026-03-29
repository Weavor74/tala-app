# Phase 5: Adaptive Intelligence Layer

## Overview

Phase 5 introduces a deterministic, inspectable adaptive intelligence layer that improves Tala's autonomous decision-making over time using operational history—without modifying planning, governance, or execution behavior.

This layer sits **between** Phase 4D (AutonomyPolicyGate) and the planning pipeline in `AutonomousRunOrchestrator`. It is fully optional: when adaptive services are not injected, Phase 4 behavior is the exact fallback.

---

## Architecture

```
GoalDetectionEngine
  → GoalPrioritizationEngine (P4C + P5 blended confidence)
    → AutonomyPolicyGate (P4D — required gate)
      → [Phase 5 Adaptive Layer — optional]
          GoalValueScoringEngine    (P5B)
          → StrategySelectionEngine (P5C)
          → AdaptivePolicyGate      (P5D)
            → proceed → SafeChangePlanner (Phase 2)
            → defer   → re-queue for next cycle
            → suppress → discard for this cycle
            → escalate → human review queue
      → _executeGoalPipeline
          → [strategy hint passed to _buildPlanInput]
          → finally: SubsystemProfileRegistry.update() (P5E feedback loop)
```

---

## Component Responsibilities

### `shared/adaptiveTypes.ts` — P5A

All Phase 5 canonical type contracts. Key types:

| Type | Description |
|------|-------------|
| `GoalValueScore` | Scored output of P5B; includes baseScore, successProbability, packConfidence, valueScore (0–100), explanation |
| `StrategySelectionResult` | Selected strategy + alternativesConsidered with rejection reasons |
| `AdaptivePolicyDecision` | Final gate decision (proceed/defer/suppress/escalate) + reasonCodes + thresholdsUsed |
| `SubsystemProfile` | Per-subsystem operational profile (successRate, cooldownMultiplier, preferredStrategy, oscillationDetected) |
| `AdaptiveDashboardState` | Dashboard state (subsystemProfiles, recentDecisions, KPIs) |
| `DEFAULT_ADAPTIVE_THRESHOLDS` | Default threshold values (see below) |

---

### `GoalValueScoringEngine` — P5B

**File:** `electron/services/autonomy/adaptive/GoalValueScoringEngine.ts`

Computes a deterministic value score (0–100) for each autonomous goal.

#### Scoring Formula

```
valueScore = clamp(
    baseScore            × 0.50   (Phase 4C GoalPriorityScore.total)
  + successProbability   × 25     (0.0–1.0 blended probability)
  + packConfidence       × 10     (best matched pack confidence, 0 if none)
  + sensitivityBonus              (critical=+10, high=+5, standard/low=0)
  − executionCostScore   × 0.30   (per-source cost, 3–15)
  − rollbackLikelihood   × 15     (0.0–1.0 from SubsystemProfile)
  + governanceLikelihood × 5      (0.0–1.0, 1 − governanceBlockRate)
  + smallSamplePenalty            (−5 when totalAttempts < 3)
, 0, 100)
```

**successProbability blending:**
- 70% from `SubsystemProfile.successRate` (empirical per-subsystem success rate)
- 30% from `OutcomeLearningRegistry.getConfidenceModifier()` (per-pattern history)
- When totalAttempts = 0, defaults to initial confidence (0.7)

---

### `StrategySelectionEngine` — P5C

**File:** `electron/services/autonomy/adaptive/StrategySelectionEngine.ts`

Selects which execution strategy to use for a goal. Returns one of:
- `recovery_pack` — best-matched recovery pack selected
- `standard_planning` — standard `SafeChangePlanner` path
- `defer` — re-queue for next cycle (value score too low)
- `suppress` — discard for this cycle

**Selection algorithm (first matching rule wins):**
1. `valueScore < suppressBelow` → **suppress**
2. `valueScore < deferBelow` → **defer**
3. Pack available AND confidence ≥ floor AND pack not recently failing:
   - profile prefers standard → **standard_planning**
   - recent pack failures > pack successes → **standard_planning**
   - otherwise → **recovery_pack**
4. Pack confidence below floor → **standard_planning** (with reason `pack_confidence_below_floor`)
5. No pack → **standard_planning** (with reason `pack_unavailable`)

Standard planning is always reachable as a fallback.

---

### `AdaptivePolicyGate` — P5D

**File:** `electron/services/autonomy/adaptive/AdaptivePolicyGate.ts`

Final adaptive gate applied after Phase 4D. Returns `proceed`, `defer`, `suppress`, or `escalate`.

**Critical safety rule:** Phase 4D blocks are NEVER converted to suppress or defer. They are always escalated to human review.

**Evaluation order:**
1. Inner gate (P4D) blocked → **escalate** (preserves P4D decision)
2. Strategy is `suppress` → **suppress**
3. Strategy is `defer` → **defer** (with `deferUntil = now + BASE_DEFER_MS × cooldownMultiplier`)
4. `successProbability < minSuccessProbability` AND source ≠ `user_seeded` → **defer**
5. `oscillationDetected` AND `consecutiveFailures >= escalateAfterConsecutiveFailures` → **escalate**
6. → **proceed**

Every decision records `reasonCodes` and a snapshot of `thresholdsUsed` for audit.

---

### `SubsystemProfileRegistry` — P5F

**File:** `electron/services/autonomy/adaptive/SubsystemProfileRegistry.ts`

Maintains one `SubsystemProfile` per subsystem. Profiles are persisted to:
`<dataDir>/autonomy/adaptive/profiles/<subsystemId>.json`

**Sensitivity classifications (affects sensitivity bonus in scoring):**

| Level | Subsystems |
|-------|-----------|
| `critical` | identity, soul, governance, security, auth |
| `high` | inference, memory, reflection, execution, mcp |
| `standard` | retrieval, search, context, router, cognitive |
| `low` | everything else |

**cooldownMultiplier adjustments (deterministic, bounded [1.0, 4.0]):**

| Outcome | Effect |
|---------|--------|
| `succeeded` | × 0.7 (floor: 1.0) |
| `failed` | × 1.5 (ceiling: 4.0) |
| `rolled_back` | × 1.5 (ceiling: 4.0) |
| `governance_blocked` | no change |
| `aborted` / `policy_blocked` | no change, does NOT count as attempt |

**Oscillation detection:**
- Requires `recentOutcomes.length >= 4`
- Detects ≥ 2 alternating pairs (succeed↔fail) in last 4 outcomes

**preferredStrategy inference:**
- Requires ≥ 5 attempts of each strategy type
- Requires ≥ 15 percentage-point success-rate advantage

---

### P5E — Outcome Feedback Loop

**Where:** `AutonomousRunOrchestrator._executeGoalPipeline()` finally block

After every run completes, the subsystem profile is updated via:
```typescript
this._adaptiveProfileRegistry.update(
    goal.subsystemId,
    outcome,           // succeeded | failed | rolled_back | ...
    strategyUsed,      // recovery_pack | standard_planning
    packId?,           // only when a pack was used
);
```

This is the feedback loop that makes Tala's decisions improve over time:
- Outcomes → SubsystemProfile.successRate
- SubsystemProfile.successRate → GoalValueScoringEngine.successProbability
- SubsystemProfile.cooldownMultiplier → AdaptivePolicyGate.deferUntil
- SubsystemProfile.preferredStrategy → StrategySelectionEngine selection

---

### P5G — GoalPrioritizationEngine Enhancement

**File:** `electron/services/autonomy/GoalPrioritizationEngine.ts`

When a `SubsystemProfileRegistry` is injected via `setProfileRegistry()`, the `confidenceWeight` computation blends:
- 60% from `OutcomeLearningRegistry` per-pattern confidence
- 40% from `SubsystemProfile.successRate` empirical subsystem success rate

This improves prioritization for subsystems with operational history. Backward-compatible: unchanged when no registry is set.

---

### P5G — Dashboard Integration

**File:** `src/renderer/components/AutonomyDashboardPanel.tsx`

The Adaptive Intelligence section displays:
- **KPI bar**: avg value score, pack selection rate, defer rate, suppress rate, oscillating count
- **Subsystem profiles**: per-subsystem successRate, failureCount, cooldownMultiplier, preferredStrategy, oscillation warning
- **Recent adaptive decisions**: last 10 decisions with action, strategy, and reason codes

IPC handlers:
- `autonomy:getAdaptiveDashboardState` — returns `AdaptiveDashboardState | null`
- `autonomy:listSubsystemProfiles` — returns `SubsystemProfile[]`

---

## Default Thresholds

Defined in `shared/adaptiveTypes.ts` as `DEFAULT_ADAPTIVE_THRESHOLDS`:

| Threshold | Default | Purpose |
|-----------|---------|---------|
| `suppressBelow` | 15 | Goals below this value score are suppressed (no attempt) |
| `deferBelow` | 30 | Goals below this are deferred to next cycle |
| `minSuccessProbability` | 0.30 | Non-user-seeded goals below this are deferred |
| `packConfidenceFloor` | 0.35 | Packs below this confidence are not selected |
| `escalateAfterConsecutiveFailures` | 3 | Oscillating subsystems escalate after this many consecutive failures |

Thresholds are conservative by design. They are snapshotted into every `AdaptivePolicyDecision` for audit reproducibility.

---

## Safety Invariants

1. **No bypass of Phase 4D** — `AdaptivePolicyGate` escalates P4D blocks, never suppresses or defers them.
2. **Standard planning always reachable** — every code path in `StrategySelectionEngine` has standard planning as a fallback.
3. **Bounded adjustments** — `cooldownMultiplier` clamped to [1.0, 4.0]; `valueScore` clamped to [0, 100].
4. **Small-sample guard** — `smallSamplePenalty = −5` when `totalAttempts < 3` to prevent bias from low data.
5. **Oscillation threshold** — oscillation detection requires ≥ 4 outcomes to fire.
6. **preferredStrategy threshold** — requires ≥ 5 attempts of each type to avoid premature strategy locking.
7. **Error isolation** — exceptions in the adaptive layer are caught and logged; the pipeline falls back to Phase 4 behavior.
8. **No recursion** — the adaptive layer does not trigger new cycles or goals.
9. **No model calls** — all scoring and selection is purely deterministic rule-based computation.

---

## Injection

Adaptive services are injected after construction via `AutonomousRunOrchestrator.setAdaptiveServices()`:

```typescript
orchestrator.setAdaptiveServices(
    new SubsystemProfileRegistry(dataDir),
    new GoalValueScoringEngine(learningRegistry, packRegistry),
    new StrategySelectionEngine(),
    new AdaptivePolicyGate(),
);
```

When not called, the orchestrator behaves identically to Phase 4.2.

---

## Relationship to Prior Phases

| Phase | Provides to P5 |
|-------|---------------|
| Phase 4C (`GoalPrioritizationEngine`) | `baseScore` (GoalPriorityScore.total) |
| Phase 4D (`AutonomyPolicyGate`) | Inner gate result (P4D block always respected) |
| Phase 4.3 (`RecoveryPackMatcher`) | Pack match result and pack confidence for strategy selection |
| Phase 4F (`OutcomeLearningRegistry`) | Per-pattern confidence modifier for successProbability blending |
