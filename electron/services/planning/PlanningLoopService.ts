/**
 * PlanningLoopService.ts — Planning Loop Authority
 *
 * PlanningLoopService is the authoritative orchestrator for all non-trivial
 * outcome-seeking work in Tala.  It governs the full:
 *
 *   PLAN → EXECUTE → OBSERVE → REPLAN (repeat) → COMPLETE / ABORT / FAIL
 *
 * cycle and is the single service responsible for driving that lifecycle to
 * a deterministic terminal state.
 *
 * Architecture position
 * ─────────────────────
 *   Caller (AgentKernel / Autonomy / Operator)
 *     → PlanningLoopService.startLoop(input)
 *         → INITIALIZING: normalize goal
 *         → PLANNING:     PlanningService.registerGoal + buildPlan
 *         → READY_FOR_EXECUTION: (approval gate if required)
 *         → EXECUTING:    dispatch via ILoopExecutor
 *         → OBSERVING:    ILoopObserver.observe(result) → LoopObservationResult
 *         → decision: complete | replan | abort
 *         → REPLANNING:   PlanningService.replan()
 *         → (back to EXECUTING, bounded by maxIterations)
 *         → COMPLETED / ABORTED / FAILED → final PlanningLoopRun
 *
 * Design invariants
 * ─────────────────
 * 1. PlanningLoopService does NOT invoke tools, run workflows, or call models.
 *    Execution is delegated entirely to the injected ILoopExecutor.
 * 2. Plan creation and replanning are delegated entirely to PlanningService.
 *    PlanningLoopService never constructs or mutates plans directly.
 * 3. Loop termination is always deterministic: every exit path sets an explicit
 *    completionReason or failureReason; silent exits are disallowed.
 * 4. Anti-infinite-loop: maxIterations and replan guardrails in PlanningService
 *    together enforce a hard upper bound on loop iterations.
 * 5. Telemetry: every phase transition and decision emits a structured event
 *    correlated to the loopId and correlationId.
 * 6. No duplicate authority: PlanningLoopService does not shadow
 *    ToolExecutionCoordinator, MemoryAuthorityService, or any other authority.
 *
 * What PlanningLoopService owns
 * ─────────────────────────────
 *   - Loop initialisation and goal normalisation
 *   - Phase management (state machine)
 *   - Plan acquisition (via PlanningService)
 *   - Execution dispatch (via ILoopExecutor)
 *   - Observation of execution results (via ILoopObserver)
 *   - Replan decisions (explicit, typed, deterministic)
 *   - Loop state persistence (in-memory seam, rebuildable)
 *   - Telemetry emission for all phases
 *   - Anti-infinite-loop protection (maxIterations + replan bounds)
 *
 * What PlanningLoopService does NOT own
 * ──────────────────────────────────────
 *   - Tool execution (ToolExecutionCoordinator)
 *   - Workflow execution (WorkflowExecutionService)
 *   - LLM inference (InferenceService / AgentKernel)
 *   - Canonical memory mutation (MemoryAuthorityService)
 *   - Policy evaluation (PolicyGate)
 *   - Plan construction / analysis (PlanningService)
 */

import { v4 as uuidv4 } from 'uuid';
import { TelemetryBus } from '../telemetry/TelemetryBus';
import { PlanningService } from './PlanningService';
import type { RegisterGoalInput } from './PlanningService';
import type {
    ExecutionPlan,
    PlanningInvocationMetadata,
    ReplanTrigger,
} from '../../../shared/planning/PlanningTypes';
import type {
    PlanningLoopPhase,
    PlanningLoopRun,
    PlanningLoopPolicy,
    StartLoopInput,
    LoopObservationResult,
    ReplanDecision,
    ReplanHistoryEntry,
    LoopCompletionReason,
    LoopFailureReason,
} from '../../../shared/planning/planningLoopTypes';

// ─── Executor interface ───────────────────────────────────────────────────────

/**
 * Minimal interface for the execution authority that runs a plan.
 *
 * Implementations wrap ToolExecutionCoordinator, WorkflowExecutionService, or
 * AgentKernel as appropriate.  Only the contract surface needed by the loop is
 * expressed here.
 */
export interface ILoopExecutor {
    /**
     * Executes the given plan and returns a raw execution result.
     * The result is passed to ILoopObserver.observe() for interpretation.
     */
    executePlan(plan: ExecutionPlan): Promise<unknown>;
}

// ─── Observer interface ───────────────────────────────────────────────────────

/**
 * Interprets the raw result of an execution attempt and returns a structured
 * observation that the loop uses to drive its next-phase decision.
 *
 * Separating the observer from the executor allows the same observation logic
 * to be shared across different execution backends.
 */
export interface ILoopObserver {
    /**
     * Observes the raw execution result and produces a structured
     * LoopObservationResult that the loop uses for decision-making.
     *
     * @param rawResult - The value returned by ILoopExecutor.executePlan().
     * @param plan - The plan that was executed.
     * @param loopRun - Current loop run state (read-only snapshot).
     */
    observe(
        rawResult: unknown,
        plan: ExecutionPlan,
        loopRun: Readonly<PlanningLoopRun>,
    ): Promise<LoopObservationResult>;
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class PlanningLoopError extends Error {
    constructor(
        message: string,
        public readonly code: string,
    ) {
        super(message);
        this.name = 'PlanningLoopError';
    }
}

// ─── Default policy ───────────────────────────────────────────────────────────

const DEFAULT_POLICY: PlanningLoopPolicy = {
    defaultMaxIterations: 5,
    allowReplanOnFailure: true,
    allowReplanOnPartial: true,
};

// ─── PlanningLoopService ─────────────────────────────────────────────────────

export class PlanningLoopService {
    private static _instance: PlanningLoopService | null = null;

    private readonly _bus: TelemetryBus;
    private readonly _planning: PlanningService;

    /** In-memory loop run store.  Maps loopId → PlanningLoopRun. */
    private readonly _runs = new Map<string, PlanningLoopRun>();

    /** Active policy configuration. */
    private _policy: PlanningLoopPolicy = { ...DEFAULT_POLICY };

    private constructor(
        private readonly _executor: ILoopExecutor,
        private readonly _observer: ILoopObserver,
        planning?: PlanningService,
    ) {
        this._bus = TelemetryBus.getInstance();
        this._planning = planning ?? PlanningService.getInstance();
    }

    /**
     * Returns the process-wide singleton.
     * Must be initialised via resetForTesting() or a custom factory in tests.
     */
    static getInstance(): PlanningLoopService {
        if (!PlanningLoopService._instance) {
            throw new PlanningLoopError(
                'PlanningLoopService has not been initialised. ' +
                'Call PlanningLoopService._resetForTesting(executor, observer) in tests, ' +
                'or wire the singleton in application startup.',
                'NOT_INITIALISED',
            );
        }
        return PlanningLoopService._instance;
    }

    /**
     * Initialises (or replaces) the singleton for production runtime use.
     *
     * Call this during application startup to wire PlanningLoopService with
     * the real executor and observer before the first chat turn is processed.
     * Subsequent calls replace the existing singleton (use only during startup).
     *
     * @param executor - ILoopExecutor implementation (e.g. ChatLoopExecutor).
     * @param observer - ILoopObserver implementation (e.g. ChatLoopObserver).
     * @param planning - Optional PlanningService override; defaults to singleton.
     */
    static initialize(
        executor: ILoopExecutor,
        observer: ILoopObserver,
        planning?: PlanningService,
    ): void {
        PlanningLoopService._instance = new PlanningLoopService(executor, observer, planning);
    }

    /**
     * Returns true if the singleton has been initialised.
     * Use this to check whether PlanningLoopService is available before routing
     * non-trivial work through it.
     */
    static isInitialized(): boolean {
        return PlanningLoopService._instance !== null;
    }

    /**
     * Initialises (or replaces) the singleton.
     * Intended for test isolation and application-startup wiring.
     */
    static _resetForTesting(
        executor: ILoopExecutor,
        observer: ILoopObserver,
        planning?: PlanningService,
    ): void {
        PlanningLoopService._instance = new PlanningLoopService(executor, observer, planning);
    }

    // ── Configuration ─────────────────────────────────────────────────────────

    /** Replaces the active loop policy. */
    setPolicy(policy: PlanningLoopPolicy): void {
        this._policy = { ...policy };
    }

    /** Returns a copy of the current policy. */
    getPolicy(): PlanningLoopPolicy {
        return { ...this._policy };
    }

    // ── State access ──────────────────────────────────────────────────────────

    /** Returns the loop run with the given id, or undefined. */
    getRun(loopId: string): PlanningLoopRun | undefined {
        const run = this._runs.get(loopId);
        return run ? { ...run, replanHistory: [...run.replanHistory] } : undefined;
    }

    /** Returns all loop runs currently held in memory (copy). */
    listRuns(): PlanningLoopRun[] {
        return Array.from(this._runs.values()).map(r => ({
            ...r,
            replanHistory: [...r.replanHistory],
        }));
    }

    // ── Loop lifecycle ────────────────────────────────────────────────────────

    /**
     * Starts a new planning loop run for the given goal.
     *
     * This method drives the full PLAN → EXECUTE → OBSERVE → REPLAN cycle to
     * completion, returning the final PlanningLoopRun when the loop terminates.
     *
     * The method is asynchronous because execution and observation are async.
     * The returned run will have phase 'completed', 'aborted', or 'failed'.
     *
     * Emits: planning.loop_started, planning.loop_phase_transition (per transition),
     *        planning.loop_iteration_started, planning.loop_observation,
     *        planning.loop_replan_decision, and one of:
     *        planning.loop_completed | planning.loop_aborted | planning.loop_failed
     *
     * @throws PlanningLoopError if the loop cannot be initialised (e.g. invalid input).
     */
    async startLoop(input: StartLoopInput): Promise<PlanningLoopRun> {
        if (!input.goal || !input.goal.trim()) {
            throw new PlanningLoopError('Loop goal must be a non-empty string', 'INVALID_GOAL');
        }

        const now = new Date().toISOString();
        const loopId = `loop-${uuidv4()}`;
        const correlationId = `lcorr-${uuidv4()}`;
        const maxIterations = input.maxIterations ?? this._policy.defaultMaxIterations;

        if (maxIterations < 1) {
            throw new PlanningLoopError(
                `maxIterations must be at least 1 (got ${maxIterations})`,
                'INVALID_MAX_ITERATIONS',
            );
        }

        const run: PlanningLoopRun = {
            loopId,
            correlationId,
            goal: input.goal.trim(),
            phase: 'initializing',
            createdAt: now,
            updatedAt: now,
            currentIteration: 0,
            maxIterations,
            contextSummary: input.contextSummary,
            planningInvocation: input.planningInvocation,
            replanHistory: [],
        };

        this._runs.set(loopId, run);

        this._bus.emit({
            executionId: loopId,
            correlationId,
            subsystem: 'planning',
            event: 'planning.loop_started',
            payload: {
                loopId,
                correlationId,
                goal: run.goal,
                maxIterations,
            },
        });

        return this._driveLoop(run);
    }

    /**
     * Requests an abort of the running loop.
     * If the loop has already reached a terminal phase, this is a no-op.
     *
     * Note: because _driveLoop is synchronous between awaits, the abort
     * is honoured at the next phase boundary check.
     */
    abortLoop(loopId: string): void {
        const run = this._runs.get(loopId);
        if (!run) return;
        if (this._isTerminal(run.phase)) return;
        this._transitionPhase(run, 'aborted');
        this._finalizeAborted(run, 'abort_requested');
    }

    // ── Private loop driver ───────────────────────────────────────────────────

    private async _driveLoop(run: PlanningLoopRun): Promise<PlanningLoopRun> {
        try {
            // ── Phase: PLANNING ───────────────────────────────────────────────
            this._transitionPhase(run, 'planning');

            let plan: ExecutionPlan;
            try {
                plan = this._buildInitialPlan(run);
            } catch (err) {
                return this._finalizeFailure(
                    run,
                    'internal_error',
                    err instanceof Error ? err.message : String(err),
                );
            }

            if (plan.status === 'blocked') {
                return this._finalizeFailure(run, 'plan_blocked', plan.reasonCodes.join(', '));
            }

            // ── Iteration loop ────────────────────────────────────────────────
            while (run.currentIteration < run.maxIterations) {
                // Abort check (external abort() call sets phase to 'aborted')
                if (run.phase === 'aborted') {
                    return this._finalizeAborted(run, 'abort_requested');
                }

                run.currentIteration += 1;
                run.updatedAt = new Date().toISOString();

                this._bus.emit({
                    executionId: run.loopId,
                    correlationId: run.correlationId,
                    subsystem: 'planning',
                    event: 'planning.loop_iteration_started',
                    payload: {
                        loopId: run.loopId,
                        correlationId: run.correlationId,
                        iteration: run.currentIteration,
                        maxIterations: run.maxIterations,
                        planId: run.currentPlanId,
                    },
                });

                // ── READY_FOR_EXECUTION ───────────────────────────────────────
                this._transitionPhase(run, 'ready_for_execution');
                run.currentPlanId = plan.id;
                run.executionBoundaryId = plan.executionBoundaryId;
                this._saveRun(run);

                // ── EXECUTING ─────────────────────────────────────────────────
                this._transitionPhase(run, 'executing');

                let rawResult: unknown;
                try {
                    // Mark plan as started in PlanningService
                    const executingPlan = this._planning.markExecutionStarted(plan.id);
                    run.executionBoundaryId = executingPlan.executionBoundaryId;
                    this._saveRun(run);
                    rawResult = await this._executor.executePlan(executingPlan);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    try {
                        this._planning.markExecutionFailed(plan.id, message);
                    } catch {
                        // best-effort — plan may already be in failed state
                    }
                    rawResult = { _loopExecutorError: message };
                }

                // ── OBSERVING ─────────────────────────────────────────────────
                this._transitionPhase(run, 'observing');

                let observation: LoopObservationResult;
                try {
                    // Refresh plan state before observing (may have been updated during execution)
                    const currentPlan = this._planning.getPlan(plan.id) ?? plan;
                    observation = await this._observer.observe(rawResult, currentPlan, { ...run });
                } catch (err) {
                    observation = {
                        outcome: 'failed',
                        goalSatisfied: false,
                        summary: `Observer threw: ${err instanceof Error ? err.message : String(err)}`,
                        reasonCodes: ['observer_error'],
                    };
                }

                run.lastObservation = observation;
                this._saveRun(run);

                this._bus.emit({
                    executionId: run.loopId,
                    correlationId: run.correlationId,
                    subsystem: 'planning',
                    event: 'planning.loop_observation',
                    payload: {
                        loopId: run.loopId,
                        correlationId: run.correlationId,
                        iteration: run.currentIteration,
                        outcome: observation.outcome,
                        goalSatisfied: observation.goalSatisfied,
                        reasonCodes: observation.reasonCodes,
                    },
                });

                // Synchronise plan completion state with PlanningService based on observation
                this._syncPlanOutcome(plan.id, observation);

                // ── Decision ──────────────────────────────────────────────────
                const decision = this._makeReplanDecision(run, observation);

                const historyEntry: ReplanHistoryEntry = {
                    iteration: run.currentIteration,
                    decision,
                    observationOutcome: observation.outcome,
                    reasonCodes: observation.reasonCodes,
                    decidedAt: new Date().toISOString(),
                };
                run.replanHistory.push(historyEntry);
                this._saveRun(run);

                this._bus.emit({
                    executionId: run.loopId,
                    correlationId: run.correlationId,
                    subsystem: 'planning',
                    event: 'planning.loop_replan_decision',
                    payload: {
                        loopId: run.loopId,
                        correlationId: run.correlationId,
                        iteration: run.currentIteration,
                        decision,
                        observationOutcome: observation.outcome,
                        goalSatisfied: observation.goalSatisfied,
                    },
                });

                if (decision === 'complete') {
                    const completionReason: LoopCompletionReason = observation.goalSatisfied
                        ? 'goal_satisfied'
                        : 'execution_succeeded';
                    return this._finalizeCompleted(run, completionReason);
                }

                if (decision === 'abort') {
                    return this._finalizeAborted(run, 'abort_requested');
                }

                // decision === 'replan' — transition and rebuild plan
                this._transitionPhase(run, 'replanning');

                const trigger = this._observationToReplanTrigger(observation);
                try {
                    plan = this._planning.replan({
                        goalId: run.goalId!,
                        priorPlanId: plan.id,
                        trigger,
                        triggerDetails: observation.summary,
                    }, {
                        ...(run.planningInvocation ?? {
                            invokedBy: 'planning_loop',
                            invocationReason: 'legacy_unspecified',
                        }),
                        invocationReason: 'replan_after_execution_failure',
                    });
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    // Map known PlanningError codes to loop failure reasons
                    const code = (err as { code?: string }).code ?? '';
                    const reason: LoopFailureReason =
                        code === 'REPLAN_LIMIT_EXCEEDED' ? 'replan_limit_exceeded' :
                        code === 'REPLAN_COOLDOWN_ACTIVE' ? 'replan_cooldown_active' :
                        'internal_error';
                    return this._finalizeFailure(run, reason, errMsg);
                }

                if (plan.status === 'blocked') {
                    return this._finalizeFailure(run, 'plan_blocked', plan.reasonCodes.join(', '));
                }

                // Continue iteration with new plan
            }

            // maxIterations exhausted
            return this._finalizeFailure(
                run,
                'max_iterations_exceeded',
                `Reached maxIterations (${run.maxIterations})`,
            );
        } catch (err) {
            return this._finalizeFailure(
                run,
                'internal_error',
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private _buildInitialPlan(run: PlanningLoopRun): ExecutionPlan {
        const goalInput: RegisterGoalInput = {
            title: run.goal,
            description: run.goal,
            source: 'user',
            category: 'workflow',
            priority: 'normal',
            metadata: run.contextSummary,
        };
        const invocation: PlanningInvocationMetadata = run.planningInvocation ?? {
            invokedBy: 'planning_loop',
            invocationReason: 'legacy_unspecified',
        };
        const goal = this._planning.registerGoal(goalInput, invocation);
        run.goalId = goal.id;
        run.normalizedIntent = goal.title;
        this._saveRun(run);
        return this._planning.buildPlan(goal.id, invocation);
    }

    private _makeReplanDecision(
        run: PlanningLoopRun,
        observation: LoopObservationResult,
    ): ReplanDecision {
        if (observation.goalSatisfied) return 'complete';
        if (observation.outcome === 'succeeded') return 'complete';

        if (observation.outcome === 'failed') {
            if (!this._policy.allowReplanOnFailure) return 'abort';
            return 'replan';
        }

        if (observation.outcome === 'partial') {
            if (!this._policy.allowReplanOnPartial) return 'complete';
            return 'replan';
        }

        // 'blocked'
        return 'abort';
    }

    private _observationToReplanTrigger(observation: LoopObservationResult): ReplanTrigger {
        if (observation.outcome === 'blocked') return 'policy_block';
        if (observation.outcome === 'partial') return 'new_evidence';
        return 'dependency_failure';
    }

    private _syncPlanOutcome(planId: string, observation: LoopObservationResult): void {
        const plan = this._planning.getPlan(planId);
        if (!plan) return;
        if (plan.status !== 'executing') return;
        if (observation.outcome === 'succeeded') {
            try { this._planning.markExecutionCompleted(planId); } catch { /* best-effort */ }
        } else if (observation.outcome === 'failed' || observation.outcome === 'blocked') {
            try {
                this._planning.markExecutionFailed(planId, observation.summary ?? observation.outcome);
            } catch { /* best-effort */ }
        }
        // 'partial' — leave as executing; replan will supersede
    }

    private _transitionPhase(run: PlanningLoopRun, phase: PlanningLoopPhase): void {
        const prior = run.phase;
        run.phase = phase;
        run.updatedAt = new Date().toISOString();
        this._saveRun(run);
        this._bus.emit({
            executionId: run.loopId,
            correlationId: run.correlationId,
            subsystem: 'planning',
            event: 'planning.loop_phase_transition',
            payload: {
                loopId: run.loopId,
                correlationId: run.correlationId,
                from: prior,
                to: phase,
                iteration: run.currentIteration,
            },
        });
    }

    private _finalizeCompleted(
        run: PlanningLoopRun,
        reason: LoopCompletionReason,
    ): PlanningLoopRun {
        run.completionReason = reason;
        this._transitionPhase(run, 'completed');
        this._bus.emit({
            executionId: run.loopId,
            correlationId: run.correlationId,
            subsystem: 'planning',
            event: 'planning.loop_completed',
            payload: {
                loopId: run.loopId,
                correlationId: run.correlationId,
                completionReason: reason,
                iterations: run.currentIteration,
                goalId: run.goalId,
                finalPlanId: run.currentPlanId,
            },
        });
        return this._snapshot(run);
    }

    private _finalizeAborted(
        run: PlanningLoopRun,
        reason: LoopFailureReason,
    ): PlanningLoopRun {
        if (!this._isTerminal(run.phase)) {
            run.failureReason = reason;
            this._transitionPhase(run, 'aborted');
        }
        this._bus.emit({
            executionId: run.loopId,
            correlationId: run.correlationId,
            subsystem: 'planning',
            event: 'planning.loop_aborted',
            payload: {
                loopId: run.loopId,
                correlationId: run.correlationId,
                failureReason: reason,
                iterations: run.currentIteration,
                goalId: run.goalId,
            },
        });
        return this._snapshot(run);
    }

    private _finalizeFailure(
        run: PlanningLoopRun,
        reason: LoopFailureReason,
        detail?: string,
    ): PlanningLoopRun {
        run.failureReason = reason;
        run.failureDetail = detail;
        this._transitionPhase(run, 'failed');
        this._bus.emit({
            executionId: run.loopId,
            correlationId: run.correlationId,
            subsystem: 'planning',
            event: 'planning.loop_failed',
            payload: {
                loopId: run.loopId,
                correlationId: run.correlationId,
                failureReason: reason,
                failureDetail: detail,
                iterations: run.currentIteration,
                goalId: run.goalId,
            },
        });
        return this._snapshot(run);
    }

    private _isTerminal(phase: PlanningLoopPhase): boolean {
        return phase === 'completed' || phase === 'aborted' || phase === 'failed';
    }

    private _saveRun(run: PlanningLoopRun): void {
        this._runs.set(run.loopId, run);
    }

    private _snapshot(run: PlanningLoopRun): PlanningLoopRun {
        return { ...run, replanHistory: [...run.replanHistory] };
    }
}
