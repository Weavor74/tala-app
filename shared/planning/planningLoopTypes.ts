import type { PlanningInvocationMetadata } from './PlanningTypes';

/**
 * planningLoopTypes.ts — Shared contracts for the Planning Loop subsystem
 *
 * Defines the canonical domain model for PlanningLoopService: the authority
 * that governs the full PLAN → EXECUTE → OBSERVE → REPLAN cycle.
 *
 * Lives in shared/ so both the Electron main-process service and any future
 * renderer surfaces can import these types without depending on Node.js services.
 *
 * All types are plain serialisable objects — no class instances, no functions.
 *
 * Design invariants
 * ─────────────────
 * 1. PlanningLoopService is the authority for loop lifecycle.  It does NOT
 *    execute tool work, invoke model inference, or bypass existing authorities.
 * 2. Each loop run is uniquely identified by a loopId and propagates a
 *    correlationId across all phases so telemetry is fully traceable.
 * 3. Replanning is explicit, typed, and bounded — no silent retry loops.
 * 4. Loop state transitions are deterministic and inspectable.
 * 5. A loop terminates only via an explicit completion reason — never silently.
 */

// ─── Phase ────────────────────────────────────────────────────────────────────

/**
 * Discrete lifecycle phase of a planning loop run.
 *
 * initializing       — loop record created; normalizing goal input
 * planning           — PlanningService is building the execution plan
 * ready_for_execution — plan built and ready; awaiting execution dispatch
 * executing          — plan dispatched; execution in progress
 * observing          — execution result received; evaluating outcome
 * replanning         — outcome requires a new plan; invoking PlanningService.replan()
 * completed          — loop reached a successful terminal state
 * aborted            — loop terminated by explicit abort request
 * failed             — loop terminated due to unrecoverable failure
 */
export type PlanningLoopPhase =
    | 'initializing'
    | 'planning'
    | 'ready_for_execution'
    | 'executing'
    | 'observing'
    | 'replanning'
    | 'completed'
    | 'aborted'
    | 'failed';

// ─── Completion / Failure Reasons ─────────────────────────────────────────────

/**
 * Machine-readable reason why a loop run completed successfully.
 */
export type LoopCompletionReason =
    | 'execution_succeeded'
    | 'goal_satisfied'
    | 'operator_accepted';

/**
 * Machine-readable reason why a loop run failed or was aborted.
 *
 * max_iterations_exceeded  — iterated beyond the configured maxIterations limit
 * replan_limit_exceeded    — PlanningService rejected replan (too many replans)
 * replan_cooldown_active   — PlanningService rejected replan (cooldown)
 * plan_blocked             — produced plan is permanently blocked (missing caps, etc.)
 * execution_failed         — execution failed and no replan is possible/allowed
 * abort_requested          — caller explicitly aborted the loop
 * internal_error           — unexpected internal error in the loop service itself
 */
export type LoopFailureReason =
    | 'max_iterations_exceeded'
    | 'replan_limit_exceeded'
    | 'replan_cooldown_active'
    | 'plan_blocked'
    | 'execution_failed'
    | 'abort_requested'
    | 'internal_error';

// ─── Observation ──────────────────────────────────────────────────────────────

/**
 * Outcome classification returned by an execution observer.
 *
 * succeeded  — execution completed successfully; loop may complete
 * failed     — execution failed; loop should evaluate replan eligibility
 * partial    — execution partially succeeded; loop should evaluate replan eligibility
 * blocked    — execution was blocked before it started (policy, approval, etc.)
 */
export type ObservationOutcome = 'succeeded' | 'failed' | 'partial' | 'blocked';

/**
 * Structured result produced by observing a single execution attempt.
 *
 * Returned by the observer callback and stored on the loop run as the last
 * observation.  PlanningLoopService uses this to decide whether to complete,
 * continue, replan, or abort.
 */
export interface LoopObservationResult {
    /** Outcome of the execution attempt. */
    outcome: ObservationOutcome;
    /**
     * Whether the loop goal has been fully satisfied regardless of outcome.
     * When true the loop must complete (even if outcome is 'partial').
     */
    goalSatisfied: boolean;
    /**
     * Optional human-readable summary of the execution result.
     * Must not contain raw user content or model prompts.
     */
    summary?: string;
    /**
     * Machine-readable reason codes explaining the observation.
     * Examples: 'step_3_failed:tool_not_found', 'output_missing:key_result'
     */
    reasonCodes?: string[];
    /**
     * Structured artifacts produced during execution.
     * Keys are artifact identifiers; values are arbitrary serialisable data.
     */
    artifacts?: Record<string, unknown>;
}

// ─── Replan Decision ──────────────────────────────────────────────────────────

/**
 * Decision made by the loop after observing an execution result.
 *
 * complete   — loop should transition to 'completed'
 * replan     — loop should trigger a replan and continue
 * abort      — loop should abort without retrying
 */
export type ReplanDecision = 'complete' | 'replan' | 'abort';

// ─── Loop Run Record ──────────────────────────────────────────────────────────

/**
 * Runtime contract and state record for a single planning loop run.
 *
 * Encapsulates all lifecycle state for one invocation of the PLAN → EXECUTE →
 * OBSERVE → REPLAN cycle.  Persisted in-memory by PlanningLoopService.
 */
export interface PlanningLoopRun {
    /** Unique loop-run identifier.  Format: `loop-<uuid>`. */
    loopId: string;
    /**
     * Loop-level correlation identifier.
     * Propagated to all telemetry events for this run.
     * Distinct from goalId, planId, and executionBoundaryId.
     */
    correlationId: string;
    /** The goal string that initiated the loop. */
    goal: string;
    /** Normalised intent derived from the goal, if produced. */
    normalizedIntent?: string;
    /** Current lifecycle phase. */
    phase: PlanningLoopPhase;
    /** ISO-8601 UTC timestamp when the loop was created. */
    createdAt: string;
    /** ISO-8601 UTC timestamp of the last state change. */
    updatedAt: string;
    /** Current iteration count (0-based; incremented on each execute–observe cycle). */
    currentIteration: number;
    /** Maximum number of execute–observe cycles before the loop aborts. */
    maxIterations: number;
    /** ID of the PlanGoal registered with PlanningService for this loop run. */
    goalId?: string;
    /** ID of the current ExecutionPlan being tracked. */
    currentPlanId?: string;
    /**
     * Execution boundary ID from the current executing plan.
     * Propagated from ExecutionPlan.executionBoundaryId to correlate
     * execution telemetry back to the loop.
     */
    executionBoundaryId?: string;
    /** Reason the loop completed successfully.  Set only when phase is 'completed'. */
    completionReason?: LoopCompletionReason;
    /** Reason the loop failed or was aborted.  Set only when phase is 'failed' or 'aborted'. */
    failureReason?: LoopFailureReason;
    /** Optional additional detail accompanying the failure reason. */
    failureDetail?: string;
    /** The last observation result from the observe phase. */
    lastObservation?: LoopObservationResult;
    /** Optional caller-supplied context (must not contain raw user content). */
    contextSummary?: Record<string, unknown>;
    /** Planning invocation authority supplied by AgentKernel at loop start. */
    planningInvocation?: PlanningInvocationMetadata;
    /**
     * History of decisions made during replanning phases.
     * Each entry records what decision was made and why.
     */
    replanHistory: ReplanHistoryEntry[];
}

/**
 * A single replanning decision recorded in the loop history.
 */
export interface ReplanHistoryEntry {
    /** Iteration number at which the replan was considered. */
    iteration: number;
    /** Decision reached. */
    decision: ReplanDecision;
    /** Observation outcome that drove the decision. */
    observationOutcome: ObservationOutcome;
    /** Reason codes from the observation. */
    reasonCodes?: string[];
    /** ISO-8601 UTC timestamp. */
    decidedAt: string;
}

// ─── Loop Input ───────────────────────────────────────────────────────────────

/**
 * Input required to start a new planning loop run.
 */
export interface StartLoopInput {
    /**
     * The goal string to pursue.
     * This is normalised and registered with PlanningService as a PlanGoal.
     */
    goal: string;
    /**
     * Optional maximum iteration count.
     * Defaults to PlanningLoopService's configured default (typically 5).
     */
    maxIterations?: number;
    /** Optional caller-supplied context. */
    contextSummary?: Record<string, unknown>;
    /** Invocation authority metadata from AgentKernel. */
    planningInvocation?: PlanningInvocationMetadata;
}

// ─── Loop Policy ──────────────────────────────────────────────────────────────

/**
 * Policy governing loop execution limits.
 */
export interface PlanningLoopPolicy {
    /**
     * Default maximum iterations per loop run.
     * Individual runs may override via StartLoopInput.maxIterations.
     */
    defaultMaxIterations: number;
    /**
     * Whether to allow replanning on execution failure.
     * When false, any execution failure immediately aborts the loop.
     */
    allowReplanOnFailure: boolean;
    /**
     * Whether to allow replanning on partial execution success.
     * When false, partial results cause immediate completion (not replan).
     */
    allowReplanOnPartial: boolean;
}

