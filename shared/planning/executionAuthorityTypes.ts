/**
 * executionAuthorityTypes.ts — Shared contracts for execution authority routing
 *
 * Defines the canonical types used to classify execution requests and determine
 * whether they must be routed through PlanningLoopService or may proceed via a
 * trivially-allowed direct path.
 *
 * Lives in shared/ so both the Electron main-process (AgentKernel, PlanningLoopService)
 * and any future renderer surfaces can import these types without depending on
 * Node.js services.
 *
 * Authority routing doctrine
 * ──────────────────────────
 * 1. Non-trivial outcome-seeking work must route through PlanningLoopService.
 * 2. Trivial direct work is explicitly allowed only for narrow, side-effect-light
 *    interactions (greetings, acknowledgements, simple factual responses with no
 *    tool/workflow invocation).
 * 3. Any retained direct path must be classified as `trivial_direct_allowed` or
 *    `doctrined_exception` and must be explicitly documented.
 * 4. Internal executor paths beneath an authorised planning loop are
 *    `implementation_detail` and are not bypasses.
 * 5. Routing decisions must be deterministic, typed, and inspectable.
 *
 * Non-trivial work definition
 * ────────────────────────────
 * Any work that meets one or more of the following criteria:
 *   - multi-step outcome seeking
 *   - requires tools or workflows
 *   - touches memory or persistent state
 *   - generates artifacts
 *   - performs external I/O
 *   - can fail in meaningful operational ways
 *   - synthesises outputs from multiple sources
 *   - performs repair, maintenance, or orchestration
 *   - notebook/search/retrieve/summarise chains
 *   - anything that reasonably needs plan/observe/replan behaviour
 *
 * Trivial allowed direct work definition
 * ───────────────────────────────────────
 * Only:
 *   - greetings and acknowledgements
 *   - purely local formatting
 *   - no-side-effect static rendering
 *   - extremely simple direct factual response with no tools/workflows
 */

// ─── Work Complexity Classification ──────────────────────────────────────────

/**
 * High-level complexity classification for a unit of work.
 *
 * trivial     — meets the narrow trivial-allowed criteria (greeting, ack, etc.)
 * non_trivial — requires planning loop authority
 */
export type WorkComplexityClassification = 'trivial' | 'non_trivial';

// ─── Non-Trivial Work Reason Codes ───────────────────────────────────────────

/**
 * Machine-readable reason codes explaining why work is classified as non-trivial.
 *
 * These are set-valued — a single request may trigger multiple codes.
 */
export type NonTrivialWorkReasonCode =
    /** Request message length exceeds the trivial threshold. */
    | 'message_length_exceeds_trivial_threshold'
    /** Message contains signals indicating tool use (file ops, code, search, etc.). */
    | 'tool_signal_detected'
    /** Message contains signals indicating workflow invocation. */
    | 'workflow_signal_detected'
    /** Message contains signals indicating memory read or write. */
    | 'memory_signal_detected'
    /** Message contains signals indicating artifact generation. */
    | 'artifact_signal_detected'
    /** Message contains action verbs that imply multi-step outcome-seeking work. */
    | 'outcome_seeking_action_verb_detected'
    /** Message explicitly requests execution (run, execute, build, deploy, etc.). */
    | 'execution_keyword_detected'
    /** Message implies multi-step orchestration. */
    | 'multi_step_signal_detected'
    /** Caller-supplied hint: non-trivial execution is expected. */
    | 'caller_hint_non_trivial'
    /** Default classification: conservative non-trivial when ambiguous. */
    | 'conservative_default';

// ─── Execution Authority Classification ──────────────────────────────────────

/**
 * Final execution authority classification for a request.
 *
 * trivial_direct_allowed
 *   Narrow trivial path is allowed.  Direct execution proceeds without
 *   PlanningLoopService.  Only greetings, acks, simple formatting allowed.
 *
 * planning_loop_required
 *   Non-trivial work.  PlanningLoopService must be the execution authority.
 *   If PlanningLoopService is unavailable, the bypass must be surfaced via
 *   a `planning.loop_routing_bypass_surfaced` telemetry event.
 *
 * doctrined_exception
 *   Narrow, explicitly documented direct path retained outside the loop.
 *   Every doctrined exception must be named and justified.
 *
 * implementation_detail
 *   Internal executor path beneath an authorised planning loop.
 *   Not a bypass — loop authority is already established upstream.
 */
export type ExecutionAuthorityClassification =
    | 'trivial_direct_allowed'
    | 'planning_loop_required'
    | 'doctrined_exception'
    | 'implementation_detail';

// ─── Planning Loop Routing Decision ──────────────────────────────────────────

/**
 * Fully typed routing decision produced by PlanningLoopAuthorityRouter.
 *
 * Contains all information needed to:
 *   - determine whether PlanningLoopService is required
 *   - emit structured telemetry about the routing choice
 *   - audit the routing decision deterministically
 */
export interface PlanningLoopRoutingDecision {
    /** High-level complexity classification. */
    complexity: WorkComplexityClassification;
    /** Final authority classification. */
    classification: ExecutionAuthorityClassification;
    /** Whether PlanningLoopService is required for this request. */
    requiresLoop: boolean;
    /**
     * Machine-readable codes explaining the routing decision.
     * Always non-empty.
     */
    reasonCodes: NonTrivialWorkReasonCode[];
    /**
     * Human-readable one-line summary (for logs and telemetry payloads).
     * Must not contain raw user content.
     */
    summary: string;
}

// ─── Degraded Execution Contract ──────────────────────────────────────────────

/**
 * Reason codes that trigger a degraded execution decision.
 *
 * loop_unavailable
 *   PlanningLoopService has not been initialised (e.g. early startup).
 *
 * capability_unregistered
 *   The planning loop is initialised but has no executor registered for the
 *   requested capability type.
 *
 * plan_blocked
 *   Planning ran but the resulting plan carries status 'blocked' (missing
 *   capabilities or policy rejection at the planning layer).
 *
 * policy_blocked
 *   PolicyGate denied execution before or during the loop.
 */
export type DegradedExecutionReason =
    | 'loop_unavailable'
    | 'capability_unregistered'
    | 'plan_blocked'
    | 'policy_blocked';

/**
 * Outcome code for a degraded execution decision.
 *
 * degraded_direct_allowed
 *   Direct execution is permitted in this degraded state.
 *   Only set when an explicit doctrine justifies the exception
 *   (e.g. chat_continuity, trivial_path).
 *
 * degraded_execution_blocked
 *   Direct execution must NOT proceed.
 *   The caller must surface the failure and halt.
 */
export type DegradedModeCode =
    | 'degraded_direct_allowed'
    | 'degraded_execution_blocked';

/**
 * Fully typed degraded execution decision.
 *
 * Produced by PlanningLoopAuthorityRouter.classifyDegradedExecution() whenever
 * a non-trivial routing decision cannot be honoured (loop unavailable, plan blocked,
 * etc.).  Replaces silent "fall through to direct" with an explicit, typed,
 * auditable policy record.
 *
 * Callers MUST:
 *   1. Emit a `planning.degraded_execution_decision` telemetry event.
 *   2. Respect `directAllowed`: if false, halt execution and surface the failure.
 *   3. If `directAllowed` is true, document the doctrined exception inline.
 */
export interface DegradedExecutionDecision {
    /** Machine-readable reason for the degraded state. */
    reason: DegradedExecutionReason;
    /**
     * Whether direct execution is permitted in this degraded state.
     * Only true for explicitly doctrined exceptions.
     */
    directAllowed: boolean;
    /** Final degraded mode outcome code. */
    degradedModeCode: DegradedModeCode;
    /**
     * Human-readable doctrine justifying this decision.
     * Explains WHY direct execution is (or is not) allowed.
     * Must not contain raw user content.
     */
    doctrine: string;
    /** Where in the runtime the degraded state was detected. */
    detectedIn: string;
    /** ISO-8601 UTC timestamp when the decision was produced. */
    detectedAt: string;
}

// ─── Authority Bypass Record ──────────────────────────────────────────────────

/**
 * Bypass severity classification.
 *
 * critical_bypass — non-trivial work executing without any loop authority
 * soft_bypass     — default path is direct but could be rerouted
 * doctrined_exception — narrow, explicitly justified direct path
 * implementation_detail — not a real bypass; executor beneath authorised loop
 */
export type AuthorityBypassSeverity =
    | 'critical_bypass'
    | 'soft_bypass'
    | 'doctrined_exception'
    | 'implementation_detail';

/**
 * Record of a detected or surfaced authority bypass event.
 *
 * Emitted when a non-trivial request cannot be routed through PlanningLoopService
 * (e.g. the loop service is not yet initialised in the current runtime).
 */
export interface AuthorityBypassRecord {
    /** The routing decision that triggered this bypass record. */
    decision: PlanningLoopRoutingDecision;
    /** Severity of this bypass. */
    severity: AuthorityBypassSeverity;
    /** ISO-8601 UTC timestamp when the bypass was detected. */
    detectedAt: string;
    /** Where in the runtime the bypass was detected. */
    detectedIn: string;
    /**
     * Whether the bypass was blocked (execution halted) or only surfaced
     * (execution allowed to continue with telemetry emission).
     */
    disposition: 'blocked' | 'surfaced';
}
