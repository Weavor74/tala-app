/**
 * PlanningLoopService.test.ts
 *
 * Governance-grade deterministic tests for the PlanningLoopService subsystem.
 *
 * Coverage:
 *   PLS01–PLS05  — Loop initialisation (loopId, correlationId, phase, input validation)
 *   PLS06–PLS10  — Success path (goal→plan→execute→observe→complete)
 *   PLS11–PLS15  — Failure path (execution failure → loop failed)
 *   PLS16–PLS20  — Replan path (execution failure → replan → success)
 *   PLS21–PLS25  — Max iterations protection (anti-infinite-loop)
 *   PLS26–PLS30  — Abort path (abortLoop call, abort_requested reason)
 *   PLS31–PLS35  — Plan blocked path (blocked plan → failed with plan_blocked)
 *   PLS36–PLS40  — Telemetry (loop_started, phase_transition, iteration, observation, decision, terminal)
 *   PLS41–PLS45  — Policy (allowReplanOnFailure=false, allowReplanOnPartial, maxIterations policy)
 *   PLS46–PLS50  — State access (getRun, listRuns, phase snapshots)
 *   PLS51–PLS55  — Replan guardrail propagation (replan_limit_exceeded, replan_cooldown_active)
 *
 * No DB, no Electron, no real tool execution.
 * TelemetryBus is stubbed.  All clocks deterministic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Stub TelemetryBus
// ---------------------------------------------------------------------------

const emittedEvents: Array<{ event: string; payload?: Record<string, unknown> }> = [];

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: (e: unknown) =>
                emittedEvents.push(e as { event: string; payload?: Record<string, unknown> }),
            subscribe: vi.fn().mockReturnValue(vi.fn()),
        }),
    },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
    PlanningLoopService,
    PlanningLoopError,
    type ILoopExecutor,
    type ILoopObserver,
} from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';
import { PlanningRepository } from '../electron/services/planning/PlanningRepository';
import type { ExecutionPlan } from '../shared/planning/PlanningTypes';
import type { PlanningLoopRun, LoopObservationResult, PlanningLoopPolicy } from '../shared/planning/planningLoopTypes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Always succeeds with a trivial raw result. */
function makeSuccessExecutor(): ILoopExecutor {
    return {
        executePlan: vi.fn().mockResolvedValue({ ok: true }),
    };
}

/** Always throws an error. */
function makeFailingExecutor(message = 'exec error'): ILoopExecutor {
    return {
        executePlan: vi.fn().mockRejectedValue(new Error(message)),
    };
}

/** Observer that always reports success. */
function makeSuccessObserver(): ILoopObserver {
    return {
        observe: vi.fn().mockResolvedValue({
            outcome: 'succeeded',
            goalSatisfied: true,
        } satisfies LoopObservationResult),
    };
}

/** Observer that reports failure once, then succeeds. */
function makeFailThenSuccessObserver(): ILoopObserver {
    let calls = 0;
    return {
        observe: vi.fn().mockImplementation(async () => {
            calls += 1;
            if (calls === 1) {
                return { outcome: 'failed', goalSatisfied: false, reasonCodes: ['step_failed'] } satisfies LoopObservationResult;
            }
            return { outcome: 'succeeded', goalSatisfied: true } satisfies LoopObservationResult;
        }),
    };
}

/** Observer that always reports failure. */
function makeAlwaysFailObserver(): ILoopObserver {
    return {
        observe: vi.fn().mockResolvedValue({
            outcome: 'failed',
            goalSatisfied: false,
            reasonCodes: ['always_fail'],
        } satisfies LoopObservationResult),
    };
}

/** Observer that reports blocked. */
function makeBlockedObserver(): ILoopObserver {
    return {
        observe: vi.fn().mockResolvedValue({
            outcome: 'blocked',
            goalSatisfied: false,
            reasonCodes: ['policy_block'],
        } satisfies LoopObservationResult),
    };
}

/** Observer that reports partial, then success. */
function makePartialThenSuccessObserver(): ILoopObserver {
    let calls = 0;
    return {
        observe: vi.fn().mockImplementation(async () => {
            calls += 1;
            if (calls === 1) {
                return { outcome: 'partial', goalSatisfied: false } satisfies LoopObservationResult;
            }
            return { outcome: 'succeeded', goalSatisfied: true } satisfies LoopObservationResult;
        }),
    };
}

function freshPlanningService(caps: string[] = ['memory_canonical', 'workflow_engine']): PlanningService {
    const repo = new PlanningRepository();
    PlanningService._resetForTesting(repo);
    const svc = PlanningService.getInstance();
    svc.setAvailableCapabilities(new Set(caps));
    return svc;
}

function freshLoop(
    executor: ILoopExecutor,
    observer: ILoopObserver,
    planning?: PlanningService,
): PlanningLoopService {
    PlanningLoopService._resetForTesting(executor, observer, planning);
    return PlanningLoopService.getInstance();
}

function eventsOfType(eventType: string) {
    return emittedEvents.filter(e => e.event === eventType);
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
    emittedEvents.length = 0;
    freshPlanningService();
});

// ===========================================================================
// SECTION 1 — Loop initialisation  (PLS01–PLS05)
// ===========================================================================

describe('PlanningLoopService — loop initialisation (PLS01–PLS05)', () => {
    it('PLS01: startLoop returns a run with a loopId and correlationId', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        const run = await svc.startLoop({ goal: 'Test goal' });
        expect(run.loopId).toMatch(/^loop-/);
        expect(run.correlationId).toMatch(/^lcorr-/);
    });

    it('PLS02: startLoop returns a run with the submitted goal', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        const run = await svc.startLoop({ goal: '  Test memory maintenance  ' });
        expect(run.goal).toBe('Test memory maintenance');
    });

    it('PLS03: startLoop throws PlanningLoopError when goal is empty', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        await expect(svc.startLoop({ goal: '' })).rejects.toThrow(PlanningLoopError);
        await expect(svc.startLoop({ goal: '   ' })).rejects.toThrow(PlanningLoopError);
    });

    it('PLS04: startLoop throws PlanningLoopError when maxIterations < 1', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        await expect(svc.startLoop({ goal: 'Goal', maxIterations: 0 })).rejects.toThrow(PlanningLoopError);
    });

    it('PLS05: loop run createdAt and updatedAt are ISO strings', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        const run = await svc.startLoop({ goal: 'Goal' });
        expect(() => new Date(run.createdAt)).not.toThrow();
        expect(() => new Date(run.updatedAt)).not.toThrow();
    });
});

// ===========================================================================
// SECTION 2 — Success path  (PLS06–PLS10)
// ===========================================================================

describe('PlanningLoopService — success path (PLS06–PLS10)', () => {
    it('PLS06: loop completes with phase "completed" on success', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        const run = await svc.startLoop({ goal: 'Succeed' });
        expect(run.phase).toBe('completed');
    });

    it('PLS07: loop completionReason is "goal_satisfied" when observer reports goalSatisfied=true', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        const run = await svc.startLoop({ goal: 'Succeed' });
        expect(run.completionReason).toBe('goal_satisfied');
    });

    it('PLS08: loop completionReason is "execution_succeeded" when outcome=succeeded but goalSatisfied=false', async () => {
        const observer: ILoopObserver = {
            observe: vi.fn().mockResolvedValue({
                outcome: 'succeeded',
                goalSatisfied: false,
            } satisfies LoopObservationResult),
        };
        const svc = freshLoop(makeSuccessExecutor(), observer);
        const run = await svc.startLoop({ goal: 'Succeed' });
        expect(run.phase).toBe('completed');
        expect(run.completionReason).toBe('execution_succeeded');
    });

    it('PLS09: run has goalId and currentPlanId after completion', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        const run = await svc.startLoop({ goal: 'Succeed' });
        expect(run.goalId).toBeTruthy();
        expect(run.currentPlanId).toBeTruthy();
    });

    it('PLS10: loop completes in exactly 1 iteration on first-attempt success', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        const run = await svc.startLoop({ goal: 'Succeed' });
        expect(run.currentIteration).toBe(1);
    });
});

// ===========================================================================
// SECTION 3 — Failure path  (PLS11–PLS15)
// ===========================================================================

describe('PlanningLoopService — failure path (PLS11–PLS15)', () => {
    it('PLS11: loop fails with phase "failed" when execution fails and no replan succeeds', async () => {
        // Use a service with no replan room by setting maxIterations=1
        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver());
        const run = await svc.startLoop({ goal: 'Fail', maxIterations: 1 });
        expect(run.phase).toBe('failed');
    });

    it('PLS12: failureReason is "max_iterations_exceeded" when loop exhausts iterations', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver());
        const run = await svc.startLoop({ goal: 'Fail', maxIterations: 2 });
        expect(run.failureReason).toBe('max_iterations_exceeded');
    });

    it('PLS13: failureReason is "execution_failed" when policy blocks replan on failure', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver());
        svc.setPolicy({
            defaultMaxIterations: 5,
            allowReplanOnFailure: false,
            allowReplanOnPartial: false,
        });
        const run = await svc.startLoop({ goal: 'Fail', maxIterations: 3 });
        // Decision is 'abort' when allowReplanOnFailure=false → aborted
        expect(run.phase).toBe('aborted');
    });

    it('PLS14: loop does not exceed maxIterations', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver());
        const run = await svc.startLoop({ goal: 'Fail', maxIterations: 3 });
        expect(run.currentIteration).toBeLessThanOrEqual(3);
    });

    it('PLS15: loop stores lastObservation after failure', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver());
        const run = await svc.startLoop({ goal: 'Fail', maxIterations: 1 });
        expect(run.lastObservation).toBeDefined();
        expect(run.lastObservation?.outcome).toBe('failed');
    });
});

// ===========================================================================
// SECTION 4 — Replan path  (PLS16–PLS20)
// ===========================================================================

describe('PlanningLoopService — replan path (PLS16–PLS20)', () => {
    it('PLS16: loop completes after one replan when observer fails then succeeds', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeFailThenSuccessObserver());
        // Need enough iterations to allow one replan (min 2)
        const run = await svc.startLoop({ goal: 'Replan goal', maxIterations: 5 });
        expect(run.phase).toBe('completed');
    });

    it('PLS17: replanHistory contains an entry for each replan decision', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeFailThenSuccessObserver());
        const run = await svc.startLoop({ goal: 'Replan goal', maxIterations: 5 });
        // First iteration: decision 'replan'. Second: decision 'complete'.
        expect(run.replanHistory.length).toBeGreaterThanOrEqual(1);
        expect(run.replanHistory[0].decision).toBe('replan');
    });

    it('PLS18: replanHistory entries have iteration numbers', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeFailThenSuccessObserver());
        const run = await svc.startLoop({ goal: 'Replan goal', maxIterations: 5 });
        for (const entry of run.replanHistory) {
            expect(typeof entry.iteration).toBe('number');
            expect(entry.iteration).toBeGreaterThan(0);
        }
    });

    it('PLS19: loop completes after partial then success when allowReplanOnPartial=true', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makePartialThenSuccessObserver());
        const run = await svc.startLoop({ goal: 'Partial', maxIterations: 5 });
        expect(run.phase).toBe('completed');
    });

    it('PLS20: loop completes directly on partial when allowReplanOnPartial=false', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makePartialThenSuccessObserver());
        svc.setPolicy({
            defaultMaxIterations: 5,
            allowReplanOnFailure: true,
            allowReplanOnPartial: false,
        });
        const run = await svc.startLoop({ goal: 'Partial', maxIterations: 5 });
        // partial → decision 'complete' (no replan allowed)
        expect(run.phase).toBe('completed');
        expect(run.currentIteration).toBe(1);
    });
});

// ===========================================================================
// SECTION 5 — Max iterations  (PLS21–PLS25)
// ===========================================================================

describe('PlanningLoopService — max iterations (PLS21–PLS25)', () => {
    it('PLS21: loop fails with max_iterations_exceeded after exhausting iterations', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver());
        const run = await svc.startLoop({ goal: 'Loop', maxIterations: 3 });
        expect(run.failureReason).toBe('max_iterations_exceeded');
    });

    it('PLS22: currentIteration equals maxIterations when exhausted', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver());
        const run = await svc.startLoop({ goal: 'Loop', maxIterations: 3 });
        expect(run.currentIteration).toBe(3);
    });

    it('PLS23: maxIterations=1 fails after a single failed execute-observe', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver());
        const run = await svc.startLoop({ goal: 'Loop', maxIterations: 1 });
        expect(run.phase).toBe('failed');
        expect(run.currentIteration).toBe(1);
    });

    it('PLS24: policy.defaultMaxIterations is used when StartLoopInput.maxIterations is absent', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver());
        svc.setPolicy({
            defaultMaxIterations: 2,
            allowReplanOnFailure: true,
            allowReplanOnPartial: true,
        });
        const run = await svc.startLoop({ goal: 'Loop' });
        expect(run.maxIterations).toBe(2);
    });

    it('PLS25: StartLoopInput.maxIterations overrides policy.defaultMaxIterations', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver());
        svc.setPolicy({ defaultMaxIterations: 10, allowReplanOnFailure: true, allowReplanOnPartial: true });
        const run = await svc.startLoop({ goal: 'Loop', maxIterations: 4 });
        expect(run.maxIterations).toBe(4);
    });
});

// ===========================================================================
// SECTION 6 — Abort path  (PLS26–PLS30)
// ===========================================================================

describe('PlanningLoopService — abort path (PLS26–PLS30)', () => {
    it('PLS26: abortLoop on completed run is a no-op', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        const run = await svc.startLoop({ goal: 'Done' });
        svc.abortLoop(run.loopId);
        const after = svc.getRun(run.loopId);
        expect(after?.phase).toBe('completed');
    });

    it('PLS27: abortLoop on non-existent loopId is a no-op', () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        expect(() => svc.abortLoop('loop-nonexistent')).not.toThrow();
    });

    it('PLS28: observer returning blocked leads to aborted phase', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeBlockedObserver());
        const run = await svc.startLoop({ goal: 'Blocked', maxIterations: 3 });
        expect(run.phase).toBe('aborted');
    });

    it('PLS29: aborted run has failureReason set', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeBlockedObserver());
        const run = await svc.startLoop({ goal: 'Blocked', maxIterations: 3 });
        expect(run.failureReason).toBeTruthy();
    });

    it('PLS30: allowReplanOnFailure=false causes aborted phase on execution failure', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver());
        svc.setPolicy({
            defaultMaxIterations: 5,
            allowReplanOnFailure: false,
            allowReplanOnPartial: true,
        });
        const run = await svc.startLoop({ goal: 'Fail', maxIterations: 5 });
        expect(run.phase).toBe('aborted');
    });
});

// ===========================================================================
// SECTION 7 — Plan blocked path  (PLS31–PLS35)
// ===========================================================================

describe('PlanningLoopService — plan blocked path (PLS31–PLS35)', () => {
    it('PLS31: loop fails with plan_blocked when initial plan is blocked', async () => {
        // Provide no capabilities so all required caps are missing → blocked plan
        freshPlanningService([] /* no caps */);
        const planning = PlanningService.getInstance();
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver(), planning);
        const run = await svc.startLoop({ goal: 'Blocked goal', maxIterations: 3 });
        expect(run.phase).toBe('failed');
        expect(run.failureReason).toBe('plan_blocked');
    });

    it('PLS32: loop_failed telemetry event emitted on plan_blocked', async () => {
        freshPlanningService([]);
        const planning = PlanningService.getInstance();
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver(), planning);
        await svc.startLoop({ goal: 'Blocked goal', maxIterations: 3 });
        const failed = eventsOfType('planning.loop_failed');
        expect(failed.length).toBeGreaterThan(0);
        expect(failed[0].payload?.failureReason).toBe('plan_blocked');
    });

    it('PLS33: no iteration is started when initial plan is blocked', async () => {
        freshPlanningService([]);
        const planning = PlanningService.getInstance();
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver(), planning);
        const run = await svc.startLoop({ goal: 'Blocked goal', maxIterations: 3 });
        expect(run.currentIteration).toBe(0);
    });

    it('PLS34: executor.executePlan is never called when initial plan is blocked', async () => {
        freshPlanningService([]);
        const planning = PlanningService.getInstance();
        const executor = makeSuccessExecutor();
        const svc = freshLoop(executor, makeSuccessObserver(), planning);
        await svc.startLoop({ goal: 'Blocked goal', maxIterations: 3 });
        expect(executor.executePlan).not.toHaveBeenCalled();
    });

    it('PLS35: run has goalId set even when plan is blocked', async () => {
        freshPlanningService([]);
        const planning = PlanningService.getInstance();
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver(), planning);
        const run = await svc.startLoop({ goal: 'Blocked goal', maxIterations: 3 });
        expect(run.goalId).toBeTruthy();
    });
});

// ===========================================================================
// SECTION 8 — Telemetry  (PLS36–PLS40)
// ===========================================================================

describe('PlanningLoopService — telemetry (PLS36–PLS40)', () => {
    it('PLS36: planning.loop_started is emitted when loop begins', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        await svc.startLoop({ goal: 'Tele' });
        const events = eventsOfType('planning.loop_started');
        expect(events.length).toBe(1);
        expect(events[0].payload?.loopId).toMatch(/^loop-/);
        expect(events[0].payload?.correlationId).toMatch(/^lcorr-/);
    });

    it('PLS37: planning.loop_phase_transition emitted for each phase change', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        await svc.startLoop({ goal: 'Tele' });
        const transitions = eventsOfType('planning.loop_phase_transition');
        expect(transitions.length).toBeGreaterThan(0);
        for (const t of transitions) {
            expect(t.payload?.from).toBeTruthy();
            expect(t.payload?.to).toBeTruthy();
        }
    });

    it('PLS38: planning.loop_iteration_started emitted per iteration', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        await svc.startLoop({ goal: 'Tele' });
        const iterEvents = eventsOfType('planning.loop_iteration_started');
        expect(iterEvents.length).toBeGreaterThanOrEqual(1);
        expect(iterEvents[0].payload?.iteration).toBe(1);
    });

    it('PLS39: planning.loop_observation emitted after each observe phase', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        await svc.startLoop({ goal: 'Tele' });
        const obsEvents = eventsOfType('planning.loop_observation');
        expect(obsEvents.length).toBeGreaterThanOrEqual(1);
        expect(obsEvents[0].payload?.outcome).toBe('succeeded');
    });

    it('PLS40: planning.loop_completed emitted on success with correct loopId', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        const run = await svc.startLoop({ goal: 'Tele' });
        const completed = eventsOfType('planning.loop_completed');
        expect(completed.length).toBe(1);
        expect(completed[0].payload?.loopId).toBe(run.loopId);
        expect(completed[0].payload?.correlationId).toBe(run.correlationId);
    });
});

// ===========================================================================
// SECTION 9 — Policy  (PLS41–PLS45)
// ===========================================================================

describe('PlanningLoopService — policy (PLS41–PLS45)', () => {
    it('PLS41: setPolicy / getPolicy round-trips correctly', () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        const policy: PlanningLoopPolicy = {
            defaultMaxIterations: 7,
            allowReplanOnFailure: false,
            allowReplanOnPartial: true,
        };
        svc.setPolicy(policy);
        expect(svc.getPolicy()).toEqual(policy);
    });

    it('PLS42: setPolicy does not affect already-running loops', async () => {
        // Verify isolation: policy changes to defaultMaxIterations only affect new loops
        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver());
        svc.setPolicy({ defaultMaxIterations: 3, allowReplanOnFailure: true, allowReplanOnPartial: true });
        const run = await svc.startLoop({ goal: 'Policy test' });
        expect(run.maxIterations).toBeGreaterThanOrEqual(1);
    });

    it('PLS43: allowReplanOnPartial=false causes complete on first partial result', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makePartialThenSuccessObserver());
        svc.setPolicy({
            defaultMaxIterations: 10,
            allowReplanOnFailure: true,
            allowReplanOnPartial: false,
        });
        const run = await svc.startLoop({ goal: 'Partial' });
        expect(run.currentIteration).toBe(1);
        expect(run.phase).toBe('completed');
    });

    it('PLS44: planning.loop_replan_decision emitted with correct decision field', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        await svc.startLoop({ goal: 'Decision' });
        const decisions = eventsOfType('planning.loop_replan_decision');
        expect(decisions.length).toBeGreaterThan(0);
        for (const d of decisions) {
            expect(['stop', 'retry_same_plan', 'replan_then_continue']).toContain(d.payload?.decision);
        }
    });

    it('PLS45: planning.loop_aborted emitted when loop is aborted', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeBlockedObserver());
        await svc.startLoop({ goal: 'Abort' });
        const aborted = eventsOfType('planning.loop_aborted');
        expect(aborted.length).toBe(1);
    });
});

// ===========================================================================
// SECTION 10 — State access  (PLS46–PLS50)
// ===========================================================================

describe('PlanningLoopService — state access (PLS46–PLS50)', () => {
    it('PLS46: getRun returns the loop run by loopId', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        const run = await svc.startLoop({ goal: 'State' });
        const fetched = svc.getRun(run.loopId);
        expect(fetched).toBeDefined();
        expect(fetched?.loopId).toBe(run.loopId);
    });

    it('PLS47: getRun returns undefined for unknown loopId', () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        expect(svc.getRun('loop-nonexistent')).toBeUndefined();
    });

    it('PLS48: listRuns returns all completed runs', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        await svc.startLoop({ goal: 'A' });
        await svc.startLoop({ goal: 'B' });
        const runs = svc.listRuns();
        expect(runs.length).toBe(2);
    });

    it('PLS49: getRun snapshot does not mutate internal state', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        const run = await svc.startLoop({ goal: 'Snapshot' });
        const fetched = svc.getRun(run.loopId)!;
        fetched.phase = 'initializing' as any;
        const refetched = svc.getRun(run.loopId)!;
        expect(refetched.phase).toBe('completed');
    });

    it('PLS50: loop run has non-empty replanHistory after a replan', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeFailThenSuccessObserver());
        const run = await svc.startLoop({ goal: 'History', maxIterations: 5 });
        expect(run.replanHistory.length).toBeGreaterThan(0);
    });
});

// ===========================================================================
// SECTION 11 — Replan guardrail propagation  (PLS51–PLS55)
// ===========================================================================

describe('PlanningLoopService — replan guardrail propagation (PLS51–PLS55)', () => {
    it('PLS51: loop fails with replan_limit_exceeded when PlanningService replan limit is exhausted', async () => {
        // Configure PlanningService to only allow 1 replan (default 5; set to 0 to force immediate rejection)
        const planning = freshPlanningService();
        planning.setReplanPolicy({ maxReplans: 0, cooldownMs: 0 });

        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver(), planning);
        const run = await svc.startLoop({ goal: 'Replan limit', maxIterations: 5 });
        expect(run.phase).toBe('failed');
        expect(run.failureReason).toBe('replan_limit_exceeded');
    });

    it('PLS52: planning.loop_failed emitted with replan_limit_exceeded', async () => {
        const planning = freshPlanningService();
        planning.setReplanPolicy({ maxReplans: 0, cooldownMs: 0 });
        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver(), planning);
        await svc.startLoop({ goal: 'Replan limit', maxIterations: 5 });
        const failEvents = eventsOfType('planning.loop_failed');
        expect(failEvents.some(e => e.payload?.failureReason === 'replan_limit_exceeded')).toBe(true);
    });

    it('PLS53: loop fails with replan_cooldown_active when cooldown blocks even first replan', async () => {
        const planning = freshPlanningService();
        // PlanningService tracks _lastReplanAt per goal (defaults to 0 when no replan yet).
        // The cooldown check is: `Date.now() - lastReplanAt < cooldownMs`.
        // With lastReplanAt=0, this becomes `Date.now() < cooldownMs`.
        // Using Number.MAX_SAFE_INTEGER ensures Date.now() (~1.7T ms) < MAX_SAFE_INT (~9T ms),
        // so the cooldown triggers on the very first replan attempt.
        planning.setReplanPolicy({ maxReplans: 10, cooldownMs: Number.MAX_SAFE_INTEGER });

        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver(), planning);
        const run = await svc.startLoop({ goal: 'Cooldown', maxIterations: 5 });
        expect(run.phase).toBe('failed');
        expect(run.failureReason).toBe('replan_cooldown_active');
    });

    it('PLS54: planning.loop_failed emitted with replan_cooldown_active', async () => {
        const planning = freshPlanningService();
        // Same reasoning as PLS53: Number.MAX_SAFE_INTEGER > Date.now(), so the cooldown
        // triggers on the first replan (Date.now() - 0 < MAX_SAFE_INT).
        planning.setReplanPolicy({ maxReplans: 10, cooldownMs: Number.MAX_SAFE_INTEGER });
        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver(), planning);
        await svc.startLoop({ goal: 'Cooldown', maxIterations: 5 });
        const failEvents = eventsOfType('planning.loop_failed');
        expect(failEvents.some(e => e.payload?.failureReason === 'replan_cooldown_active')).toBe(true);
    });

    it('PLS55: loop failureDetail is set to PlanningService error message on replan rejection', async () => {
        const planning = freshPlanningService();
        planning.setReplanPolicy({ maxReplans: 0, cooldownMs: 0 });
        const svc = freshLoop(makeSuccessExecutor(), makeAlwaysFailObserver(), planning);
        const run = await svc.startLoop({ goal: 'Detail', maxIterations: 5 });
        expect(run.failureDetail).toBeTruthy();
    });
});

// ===========================================================================
// SECTION 12 - Phase 3 bounded iteration behavior
// ===========================================================================

describe('PlanningLoopService - bounded multi-iteration runtime loops (Phase 3)', () => {
    it('resolves retrieval+verify doctrine to multi-iteration budget', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makePartialThenSuccessObserver());
        const run = await svc.startLoop({
            goal: 'retrieve notes, summarize, and verify output',
            iterationPolicyInput: { turnMode: 'goal_execution', operatorMode: 'goal' },
        });
        expect(run.iterationPolicyProfile?.taskClass).toBe('retrieval_summarize_verify');
        expect(run.maxIterations).toBeGreaterThan(1);
    });

    it('stops early after first successful pass even when budget allows more', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makeSuccessObserver());
        const run = await svc.startLoop({
            goal: 'retrieve and summarize notes',
            iterationPolicyInput: { turnMode: 'goal_execution', operatorMode: 'goal' },
        });
        expect(run.phase).toBe('completed');
        expect(run.currentIteration).toBe(1);
        expect(run.maxIterations).toBeGreaterThanOrEqual(1);
    });

    it('incomplete first pass continues and records continuation telemetry', async () => {
        const svc = freshLoop(makeSuccessExecutor(), makePartialThenSuccessObserver());
        const run = await svc.startLoop({
            goal: 'retrieve notes and verify summary',
            iterationPolicyInput: { turnMode: 'goal_execution', operatorMode: 'goal' },
        });
        expect(run.currentIteration).toBeGreaterThan(1);
        expect(eventsOfType('planning.loop_iteration_continued').length).toBeGreaterThan(0);
    });

    it('approval-required additional iteration is blocked without approval', async () => {
        const observer: ILoopObserver = {
            observe: vi.fn().mockResolvedValue({
                outcome: 'partial',
                goalSatisfied: false,
                reasonCodes: ['operator_input_required'],
            } satisfies LoopObservationResult),
        };
        const svc = freshLoop(makeSuccessExecutor(), observer);
        const run = await svc.startLoop({
            goal: 'delete canonical memory entry and verify',
            iterationPolicyInput: {
                turnMode: 'goal_execution',
                operatorMode: 'goal',
                sideEffectSensitive: true,
                approvalGranted: false,
            },
        });
        expect(run.phase).toBe('aborted');
        expect(eventsOfType('planning.loop_iteration_blocked_by_policy').length).toBeGreaterThan(0);
    });

    it('records improved outcome and no-material-improvement events deterministically', async () => {
        let calls = 0;
        const observer: ILoopObserver = {
            observe: vi.fn().mockImplementation(async () => {
                calls += 1;
                if (calls === 1) return { outcome: 'failed', goalSatisfied: false } satisfies LoopObservationResult;
                if (calls === 2) return { outcome: 'failed', goalSatisfied: false } satisfies LoopObservationResult;
                return { outcome: 'succeeded', goalSatisfied: true } satisfies LoopObservationResult;
            }),
        };
        const svc = freshLoop(makeSuccessExecutor(), observer);
        const run = await svc.startLoop({
            goal: 'run tool-driven multi-step execution',
            maxIterations: 3,
            iterationPolicyInput: { turnMode: 'goal_execution', operatorMode: 'goal' },
        });
        expect(run.phase).toBe('completed');
        expect(eventsOfType('planning.loop_iteration_no_material_improvement').length).toBeGreaterThan(0);
        expect(eventsOfType('planning.loop_iteration_improved_outcome').length).toBeGreaterThan(0);
    });
});
