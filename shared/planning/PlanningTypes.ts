/**
 * PlanningTypes.ts — Shared contracts for the Planning subsystem
 *
 * Defines the canonical domain model for Tala's goal → plan → execution
 * lifecycle.  Lives in shared/ so both the Electron main process (PlanningService)
 * and renderer surfaces can import these types without depending on Node.js services.
 *
 * All types are plain serialisable objects — no class instances, no functions.
 *
 * Design invariants
 * ─────────────────
 * 1. PlanningService is the authority for goal/plan state.  It does NOT execute
 *    tool work, invoke operator actions, or bypass existing execution authorities.
 * 2. Plans are structured (machine-usable stages + dependencies), never prose blobs.
 * 3. Approval-required plans start in 'pending' approval state and must be
 *    explicitly approved before the service emits an execution-handoff signal.
 * 4. Replanning generates a new superseding plan; the prior plan is preserved with
 *    status 'superseded' — no silent in-place mutation of history.
 * 5. Blocked analysis produces a blocked plan honestly — no fake readiness.
 */

// ─── Goal ─────────────────────────────────────────────────────────────────────

/**
 * The originating source of a goal.
 */
export type PlanGoalSource =
    | 'user'
    | 'autonomy'
    | 'reflection'
    | 'operator'
    | 'system';

/**
 * Broad functional category of a goal.
 * Used by GoalAnalyzer to select the appropriate execution style.
 */
export type PlanGoalCategory =
    | 'conversation'
    | 'research'
    | 'maintenance'
    | 'diagnostics'
    | 'memory'
    | 'release'
    | 'workflow'
    | 'tooling';

/**
 * Scheduling priority of a goal.
 */
export type PlanGoalPriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * Lifecycle status of a goal.
 *
 * registered   — goal received; not yet analysed
 * analyzing    — GoalAnalyzer is evaluating the goal
 * planned      — plan created; awaiting approval if required, or ready to execute
 * approved     — plan has been approved and is ready for execution handoff
 * executing    — execution has been handed off to the downstream authority
 * completed    — execution completed successfully
 * failed       — execution or planning failed
 * blocked      — cannot proceed; missing capability / policy block / denial
 * cancelled    — explicitly cancelled before completion
 */
export type PlanGoalStatus =
    | 'registered'
    | 'analyzing'
    | 'planned'
    | 'approved'
    | 'executing'
    | 'completed'
    | 'failed'
    | 'blocked'
    | 'cancelled';

/**
 * A normalised goal entering the planning lifecycle.
 */
export interface PlanGoal {
    /** Unique goal identifier. */
    id: string;
    /** Human-readable title. */
    title: string;
    /** Detailed goal description. */
    description: string;
    /** Where the goal originated. */
    source: PlanGoalSource;
    /** Functional category for planner selection. */
    category: PlanGoalCategory;
    /** Scheduling priority. */
    priority: PlanGoalPriority;
    /** Optional freeform constraints on how the goal may be achieved. */
    constraints?: string[];
    /** Observable success criteria for this goal. */
    successCriteria?: string[];
    /** Current lifecycle status. */
    status: PlanGoalStatus;
    /** ISO-8601 UTC timestamp when the goal was registered. */
    registeredAt: string;
    /** ISO-8601 UTC timestamp of the last status transition. */
    updatedAt: string;
    /**
     * Optional machine-readable reason codes accompanying the current status.
     * Examples: 'missing_capability:rag', 'policy_block:operator_action_required'
     */
    reasonCodes?: string[];
    /** Optional caller-supplied metadata (must not contain raw user content). */
    metadata?: Record<string, unknown>;
}

// ─── Goal Analysis ────────────────────────────────────────────────────────────

/**
 * Estimated complexity of fulfilling the goal.
 */
export type GoalComplexity = 'trivial' | 'simple' | 'moderate' | 'complex';

/**
 * The primary execution style recommended for this goal.
 *
 * deterministic    — fully rule-based; no inference required
 * workflow         — maps to a known registered workflow
 * tool_orchestrated — multi-step tool calls governed by existing executor
 * llm_assisted     — requires model synthesis; output normalised to plan schema
 * hybrid           — combination of deterministic + model-assisted stages
 */
export type GoalExecutionStyle =
    | 'deterministic'
    | 'workflow'
    | 'tool_orchestrated'
    | 'llm_assisted'
    | 'hybrid';

/**
 * Which planning engine should build the plan for this goal.
 *
 * native              — PlanBuilder handles it natively
 * workflow-registry   — delegates to the workflow registry
 * llm-plan-builder    — model-assisted plan construction
 * operator            — requires human operator involvement
 */
export type RecommendedPlanner =
    | 'native'
    | 'workflow-registry'
    | 'llm-plan-builder'
    | 'operator';

/**
 * Deterministic analysis of a goal.  Produced by GoalAnalyzer.
 *
 * This record is immutable once produced — if circumstances change, a new
 * analysis is generated as part of a replan request.
 */
export interface GoalAnalysis {
    /** Goal this analysis belongs to. */
    goalId: string;
    /** ISO-8601 UTC timestamp when the analysis was produced. */
    analyzedAt: string;
    /** Estimated complexity. */
    complexity: GoalComplexity;
    /** Recommended primary execution style. */
    executionStyle: GoalExecutionStyle;
    /** Whether the resulting plan must be approved before execution. */
    requiresApproval: boolean;
    /**
     * Human-readable reason why approval is required, if applicable.
     * Absent when requiresApproval is false.
     */
    approvalReason?: string;
    /** Capabilities required by this goal (e.g. 'rag', 'workflow_engine'). */
    requiredCapabilities: string[];
    /** Capabilities from requiredCapabilities that are not currently available. */
    missingCapabilities: string[];
    /**
     * Structured blocking issues that prevent planning from proceeding.
     * Empty when planning can proceed.
     */
    blockingIssues: string[];
    /** Which planner should build the execution plan. */
    recommendedPlanner: RecommendedPlanner;
    /**
     * Analyser confidence in its recommendations.
     * 0.0 (none) to 1.0 (high).
     */
    confidence: number;
    /**
     * Estimated risk level of executing this goal.
     */
    risk: 'low' | 'medium' | 'high' | 'critical';
    /**
     * Machine-readable reason codes explaining key analysis decisions.
     * Examples: 'category:maintenance→deterministic', 'missing_cap:rag→blocked'
     */
    reasonCodes: string[];
}

// ─── Plan Stage ───────────────────────────────────────────────────────────────

/**
 * Functional type of a plan stage.
 *
 * preflight  — pre-condition checks before substantive work
 * lookup     — read-only data lookup
 * retrieve   — retrieval from memory or external source
 * analyze    — analysis or classification step
 * tool       — governed tool invocation (via ToolExecutionCoordinator)
 * workflow   — delegation to a registered workflow
 * llm        — model-assisted synthesis step
 * operator   — step that requires human operator action
 * write      — write to a governed canonical surface
 * verify     — verification / assertion step
 * finalize   — cleanup, summarise, and seal
 */
export type PlanStageType =
    | 'preflight'
    | 'lookup'
    | 'retrieve'
    | 'analyze'
    | 'tool'
    | 'workflow'
    | 'llm'
    | 'operator'
    | 'write'
    | 'verify'
    | 'finalize';

/**
 * How the stage is intended to be executed.
 *
 * deterministic — no model involvement; pure rule-based or tool-based
 * assisted      — model-assisted synthesis
 * manual        — requires a human
 */
export type StageExecutionMode = 'deterministic' | 'assisted' | 'manual';

/**
 * What happens when a stage fails.
 *
 * stop     — abort the plan
 * retry    — retry the stage (subject to retryPolicy)
 * skip     — skip this stage and continue
 * escalate — escalate to operator
 */
export type StageFailurePolicy = 'stop' | 'retry' | 'skip' | 'escalate';

/**
 * Optional retry configuration for a stage.
 */
export interface StageRetryPolicy {
    /** Maximum number of attempts (including the first). */
    maxAttempts: number;
    /** Base delay in milliseconds between attempts. */
    delayMs: number;
}

/**
 * A single structured stage within an execution plan.
 */
export interface PlanStage {
    /** Unique stage identifier within the plan. */
    id: string;
    /** Human-readable stage title. */
    title: string;
    /** Description of what this stage does and why. */
    description: string;
    /** Functional type. */
    type: PlanStageType;
    /** Execution mode. */
    executionMode: StageExecutionMode;
    /** Observable success criteria for this stage. */
    successCriteria: string[];
    /** What to do if this stage fails. */
    failurePolicy: StageFailurePolicy;
    /** Optional retry configuration; only meaningful when failurePolicy is 'retry'. */
    retryPolicy?: StageRetryPolicy;
    /** Capabilities this stage requires (e.g. 'tool:web_search', 'workflow:memory_repair'). */
    requiredCapabilities: string[];
    /**
     * Structured outputs this stage is expected to produce.
     * Keys are output identifiers; values describe the expected artifact type.
     */
    outputs: Record<string, string>;
}

// ─── Execution Plan ───────────────────────────────────────────────────────────

/**
 * Approval state for plans that require explicit operator sign-off.
 *
 * not_required — plan does not require approval (can proceed immediately)
 * pending      — plan requires approval; awaiting decision
 * approved     — plan approved; execution handoff may proceed
 * denied       — plan denied; replanning or cancellation required
 */
export type PlanApprovalState =
    | 'not_required'
    | 'pending'
    | 'approved'
    | 'denied';

/**
 * Lifecycle status of an execution plan.
 *
 * draft      — plan is being constructed
 * ready      — plan constructed and ready (no approval required)
 * approved   — plan has received required approval
 * executing  — plan has been handed off for execution
 * completed  — execution completed successfully
 * failed     — execution failed
 * blocked    — plan cannot proceed (missing cap, policy block, etc.)
 * superseded — this plan has been superseded by a newer replan version
 */
export type ExecutionPlanStatus =
    | 'draft'
    | 'ready'
    | 'approved'
    | 'executing'
    | 'completed'
    | 'failed'
    | 'blocked'
    | 'superseded';

/**
 * The downstream execution authority the plan targets.
 * PlanningService does NOT invoke these — it only records the intended handoff.
 */
export type ExecutionHandoffTarget =
    | 'WorkflowExecutionService'
    | 'ToolExecutionCoordinator'
    | 'AgentKernel'
    | 'OperatorActionService'
    | 'none';

/**
 * A fully structured, machine-usable execution plan.
 *
 * Plans are immutable once sealed (status transitions from 'draft').
 * Replanning creates a new plan with a new id; the prior plan is marked
 * 'superseded' and its id is recorded in this plan's replannedFromPlanId.
 */
export interface ExecutionPlan {
    /** Unique plan identifier. */
    id: string;
    /** Goal this plan addresses. */
    goalId: string;
    /**
     * Version counter.  1 for the initial plan; incremented with each replan
     * that supersedes this one.
     */
    version: number;
    /** ISO-8601 UTC timestamp when this plan was created. */
    createdAt: string;
    /** ISO-8601 UTC timestamp of the last plan state change. */
    updatedAt: string;
    /** Which planner constructed this plan. */
    plannerType: RecommendedPlanner;
    /** Human-readable one-line summary of the plan. */
    summary: string;
    /** Ordered list of execution stages. */
    stages: PlanStage[];
    /**
     * Explicit inter-stage dependencies as a map from stage id → list of
     * prerequisite stage ids.  Empty map is valid (linear execution).
     */
    dependencies: Record<string, string[]>;
    /** Estimated risk of executing this plan. */
    estimatedRisk: 'low' | 'medium' | 'high' | 'critical';
    /** Whether this plan requires explicit approval before execution handoff. */
    requiresApproval: boolean;
    /** Current approval state. */
    approvalState: PlanApprovalState;
    /** ISO-8601 UTC timestamp when the plan was approved or denied, if applicable. */
    approvalDecidedAt?: string;
    /** Actor (user id, system id, etc.) who made the approval decision. */
    approvalActor?: string;
    /** Reason for denial, if denied. */
    denialReason?: string;
    /** Current plan lifecycle status. */
    status: ExecutionPlanStatus;
    /** Intended downstream execution authority. PlanningService does not invoke it. */
    handoffTarget: ExecutionHandoffTarget;
    /**
     * Machine-readable reason codes for the current status.
     * Examples: 'blocked:missing_capability:rag', 'approved:operator:user-123'
     */
    reasonCodes: string[];
    /**
     * If this plan supersedes a prior plan, the prior plan's id.
     * Absent for initial plans.
     */
    replannedFromPlanId?: string;
    /**
     * If this plan was superseded, the id of the superseding plan.
     * Absent until superseded.
     */
    supersededByPlanId?: string;
}

// ─── Replan Request ───────────────────────────────────────────────────────────

/**
 * What triggered the replanning request.
 */
export type ReplanTrigger =
    | 'dependency_failure'
    | 'capability_loss'
    | 'operator_denied'
    | 'new_evidence'
    | 'policy_block'
    | 'timeout'
    | 'manual';

/**
 * A request to generate a new plan superseding an existing one.
 *
 * The prior plan is preserved with status 'superseded'.
 * The new plan carries replannedFromPlanId linking it to the prior plan.
 */
export interface ReplanRequest {
    /** Goal to replan. */
    goalId: string;
    /** ID of the plan being superseded. */
    priorPlanId: string;
    /** What triggered the replan. */
    trigger: ReplanTrigger;
    /** Optional human-readable details about the trigger event. */
    triggerDetails?: string;
}
