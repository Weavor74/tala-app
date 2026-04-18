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

import type {
    ExecutionReplanRequest,
    StructuredFailure,
} from '../runtime/failureRecoveryTypes';
import type {
    PlanningMemoryReasonCode,
    StrategyFamily,
    VerificationDepth,
    RetryPosture,
    FallbackPosture,
    StrategySelection,
} from './PlanningMemoryTypes';
import type { MemoryWriteMode, TurnAuthorityLevel, TurnMode } from '../turnArbitrationTypes';

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
    /**
     * Planning-lifecycle correlation identifier.
     * Generated at goal registration and propagated to all associated plans
     * and telemetry events.  Use this to correlate events across the full
     * goal → plan → execution lifecycle.
     */
    correlationId: string;
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
    /**
     * Number of times this goal has been replanned.
     * Starts at 0 for the initial plan; incremented on each successful replan.
     */
    replanCount: number;
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
    /**
     * Structured explanation of why approval is required.
     * Populated only when requiresApproval is true.
     */
    approvalContext?: ApprovalContext;
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
 * Plan-level failure policy.
 */
export type PlanFailurePolicy = 'stop' | 'retry' | 'degrade' | 'escalate';

/**
 * Completion strictness for a stage.
 */
export type StageCompletionPolicy = 'strict' | 'best_effort';

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
 * Typed execution handoff contract for an individual stage.
 */
export type PlanStageHandoff =
    | {
          type: 'tool';
          steps: PlannedToolInvocation[];
          sharedInputs?: Record<string, unknown>;
      }
    | {
          type: 'workflow';
          workflowId: string;
          input: Record<string, unknown>;
          failurePolicy: StageFailurePolicy;
      }
    | {
          type: 'agent';
          agentId?: string;
          input: Record<string, unknown>;
          failurePolicy: StageFailurePolicy;
      }
    | {
          type: 'none';
      };

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
    /**
     * Explicit expected output keys for deterministic output validation.
     */
    expectedOutputs?: string[];
    /**
     * Completion strictness for this stage.
     */
    completionPolicy?: StageCompletionPolicy;
    /**
     * Explicit stage dependencies. Optional; plan.dependencies remains
     * authoritative when present.
     */
    dependsOn?: string[];
    /**
     * Stage-scoped handoff contract for deterministic execution.
     * Legacy plans may omit this field.
     */
    handoff?: PlanStageHandoff;
}

// ─── Approval Context ─────────────────────────────────────────────────────────

/**
 * Machine-readable code for why approval is required.
 *
 * critical_risk           — estimated risk level is 'critical'
 * high_risk               — estimated risk level is 'high'
 * autonomy_source         — goal originated from autonomy with non-trivial risk
 * operator_source         — goal originated from an operator and requires sign-off
 * llm_non_conversation    — LLM-assisted goal that is not a conversation goal
 * config_mutation_implied — goal description implies provider/config/canonical-state changes
 */
export type ApprovalTrigger =
    | 'critical_risk'
    | 'high_risk'
    | 'autonomy_source'
    | 'operator_source'
    | 'llm_non_conversation'
    | 'config_mutation_implied';

/**
 * Structured, machine-readable explanation of why approval is required.
 *
 * Populated only when GoalAnalysis.requiresApproval is true.
 * Absent when approval is not required (approvalState: 'not_required').
 */
export interface ApprovalContext {
    /** Machine-readable trigger codes that caused approval to be required. */
    triggeredBy: ApprovalTrigger[];
    /** Human-readable reason strings, one per trigger (parallel array to triggeredBy). */
    reasons: string[];
    /** Risk level as assessed at analysis time. */
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    /** Optional mitigations that, if applied, might reduce the risk level on replan. */
    mitigations?: string[];
}

// ─── Execution Handoff Contract ───────────────────────────────────────────────

/**
 * A single, ordered, typed tool invocation within a tool-orchestrated plan.
 *
 * Each step maps to one call to ToolExecutionCoordinator.executeTool().
 * Steps are executed in array order; a step may declare a failurePolicy to
 * control what happens when execution fails.
 */
export interface PlannedToolInvocation {
    /** Stable tool identifier (e.g. 'mem0_search', 'fs_read_text'). */
    toolId: string;
    /** Tool-specific input arguments for this step. */
    input: Record<string, unknown>;
    /** Human-readable description of this step's purpose. */
    description?: string;
    /**
     * What to do if this step fails.
     * stop     — abort remaining steps
     * retry    — retry this step (governed by ToolExecutionCoordinator retry logic)
     * skip     — skip this step and continue with remaining steps
     * escalate — escalate to operator
     */
    failurePolicy: 'stop' | 'retry' | 'skip' | 'escalate';
    /** Expected output keys this step will produce (informational). */
    expectedOutputs?: string[];
    /**
     * Explicitly declared equivalent tool IDs that are safe reroute targets for this step.
     * Selection order is deterministic and follows the array order.
     */
    equivalentToolIds?: string[];
    /**
     * True when degraded continuation is allowed if this step cannot be fully recovered.
     */
    degradeAllowed?: boolean;
}

/**
 * A single, ordered, typed workflow invocation within a workflow-orchestrated plan.
 *
 * Each invocation maps to one call to the workflow execution service.
 * Invocations are executed in array order; each may declare a failurePolicy to
 * control what happens when the workflow fails.
 */
export interface PlannedWorkflowInvocation {
    /** Stable workflow identifier (e.g. 'workflow.memory_repair', 'workflow.doc_heal'). */
    workflowId: string;
    /** Workflow-specific input arguments for this invocation. */
    input: Record<string, unknown>;
    /** Human-readable description of this invocation's purpose. */
    description?: string;
    /**
     * What to do if this invocation fails.
     * stop     — abort remaining invocations
     * retry    — retry this invocation (governed by workflow executor retry logic)
     * skip     — skip this invocation and continue with remaining ones
     * escalate — escalate to operator
     */
    failurePolicy: 'stop' | 'retry' | 'skip' | 'escalate';
    /** Expected output keys this invocation will produce (informational). */
    expectedOutputs?: string[];
    /**
     * Capabilities required for this invocation (e.g. 'workflow_engine').
     * Used by preflight validation before dispatch.
     */
    requiredCapabilities?: string[];
    /**
     * Machine-readable timeout constraint in milliseconds.
     * Absent = no explicit timeout constraint declared by the plan.
     */
    timeoutMs?: number;
    /**
     * Explicitly declared equivalent workflow IDs that are safe reroute targets.
     * Selection order is deterministic and follows the array order.
     */
    equivalentWorkflowIds?: string[];
    /**
     * True when degraded continuation is allowed if this invocation cannot be fully recovered.
     */
    degradeAllowed?: boolean;
}

/**
 * Machine-readable failure reason codes for workflow handoff dispatches.
 *
 * All codes are stable across releases so operators and tooling can act on them
 * deterministically without string matching.
 *
 * preflight:capability_missing      — a required capability is unavailable
 * preflight:invalid_workflow_id     — workflowId is empty or malformed
 * preflight:workflow_not_registered — workflowId is not registered in the registry
 * dispatch:executor_unavailable     — workflow executor returned unavailable
 * dispatch:workflow_not_found       — executor could not find the workflow at dispatch time
 * execution:workflow_failed         — workflow reached a failed terminal state
 * execution:timeout                 — workflow exceeded declared timeoutMs
 * policy:escalation_required        — failurePolicy 'escalate' reached operator gate
 */
export type WorkflowHandoffFailureCode =
    | 'preflight:capability_missing'
    | 'preflight:invalid_workflow_id'
    | 'preflight:workflow_not_registered'
    | 'dispatch:executor_unavailable'
    | 'dispatch:workflow_not_found'
    | 'execution:workflow_failed'
    | 'execution:timeout'
    | 'policy:escalation_required';

/**
 * A single, typed agent invocation within an agent-assisted plan.
 *
 * Maps to one agent kernel session opened by AgentKernel or equivalent authority.
 * Declares the execution mode, inputs, and failure contract up front.
 */
export interface PlannedAgentInvocation {
    /**
     * Stable agent identifier for this invocation session.
     * Examples: 'agent.llm_synthesis', 'agent.hybrid_decompose'.
     */
    agentId: string;
    /**
     * Execution mode for the agent kernel session.
     * Only 'llm_assisted' and 'hybrid' are valid for agent handoffs.
     */
    executionMode: GoalExecutionStyle;
    /** Inputs for the agent kernel session. */
    input: Record<string, unknown>;
    /** Human-readable description of this invocation's purpose. */
    description?: string;
    /**
     * What to do if this invocation fails.
     * stop     — mark the plan failed
     * retry    — retry the agent session (governed by coordinator retry logic)
     * skip     — skip (not recommended for agent invocations; prefer 'escalate')
     * escalate — escalate to operator
     */
    failurePolicy: 'stop' | 'retry' | 'skip' | 'escalate';
    /** Expected output keys this invocation will produce (informational). */
    expectedOutputs?: string[];
    /**
     * Capabilities required for this invocation (e.g. 'inference').
     * Used by preflight validation before dispatch.
     */
    requiredCapabilities?: string[];
    /**
     * Machine-readable timeout constraint in milliseconds.
     * Absent = no explicit timeout constraint declared by the plan.
     */
    timeoutMs?: number;
    /**
     * Explicitly declared equivalent agent IDs that are safe reroute targets.
     * Selection order is deterministic and follows the array order.
     */
    equivalentAgentIds?: string[];
    /**
     * True when degraded continuation is allowed if this invocation cannot be fully recovered.
     */
    degradeAllowed?: boolean;
}

/**
 * Machine-readable failure reason codes for agent handoff dispatches.
 *
 * All codes are stable across releases so operators and tooling can act on them
 * deterministically without string matching.
 *
 * preflight:capability_missing      — a required capability (e.g. 'inference') is unavailable
 * preflight:invalid_agent_id        — agentId is empty or malformed
 * preflight:invalid_execution_mode  — executionMode is not valid for agent handoffs
 * dispatch:executor_unavailable     — agent executor returned unavailable
 * execution:agent_failed            — agent invocation reached a failed terminal state
 * execution:timeout                 — agent invocation exceeded declared timeoutMs
 * policy:escalation_required        — failurePolicy 'escalate' reached operator gate
 */
export type AgentHandoffFailureCode =
    | 'preflight:capability_missing'
    | 'preflight:invalid_agent_id'
    | 'preflight:invalid_execution_mode'
    | 'dispatch:executor_unavailable'
    | 'execution:agent_failed'
    | 'execution:timeout'
    | 'policy:escalation_required';

/**
 * Typed execution handoff contract.
 *
 * Discriminated union describing exactly which downstream execution authority
 * should receive the handoff and what inputs it expects.
 *
 * PlanningService does NOT invoke these authorities.  It only records the
 * intended handoff so downstream systems can discover, validate, and act on it.
 *
 * All variants carry contractVersion: 1 to support future schema evolution.
 */
export type ExecutionHandoff =
    | {
          /** Delegate to the workflow execution service. */
          type: 'workflow';
          contractVersion: 1;
          /**
           * Ordered list of workflow invocations to execute.
           * Each invocation maps to one workflow execution service dispatch.
           * Invocations are executed in array order.
           */
          invocations: PlannedWorkflowInvocation[];
          /** Inputs shared across all invocations (merged with per-invocation input). */
          sharedInputs: Record<string, unknown>;
      }
    | {
          /** Delegate to the tool execution coordinator. */
          type: 'tool';
          contractVersion: 1;
          /**
           * Ordered list of tool invocations to execute.
           * Each step maps to one ToolExecutionCoordinator.executeTool() call.
           * Steps are executed in array order.
           */
          steps: PlannedToolInvocation[];
          /** Inputs shared across all steps (merged with per-step input). */
          sharedInputs: Record<string, unknown>;
      }
    | {
          /** Delegate to the agent kernel for model-assisted execution. */
          type: 'agent';
          contractVersion: 1;
          /**
           * Typed agent invocation contract.
           * Declares execution mode, inputs, and failure contract up front.
           */
          invocation: PlannedAgentInvocation;
          /** Shared inputs for the agent invocation (merged with per-invocation input). */
          sharedInputs: Record<string, unknown>;
      }
    | {
          /** Requires human operator action. */
          type: 'operator';
          contractVersion: 1;
          /** Classification of the operator action required. */
          actionType: string;
          /** Human-readable rationale for why operator action is needed. */
          rationale: string;
      }
    | {
          /** No handoff possible — plan is blocked or analysis failed. */
          type: 'none';
          contractVersion: 1;
          /** Machine-readable reason why no handoff can be made. */
          reason: string;
      };

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
    /**
     * Typed execution handoff contract.
     * Discriminated union describing exactly which downstream authority should
     * receive the handoff and what inputs it expects.
     * This is the single source of truth for execution handoff targeting.
     */
    handoff: ExecutionHandoff;
    /**
     * Plan-level expected outcome summary used by execution diagnostics.
     */
    expectedOutcome?: string;
    /**
     * Plan-level failure policy for stage-runner behavior.
     */
    failurePolicy?: PlanFailurePolicy;
    /**
     * Unique identifier for the current execution boundary.
     * Generated when markExecutionStarted() is called; absent before execution.
     * Distinct from the goal correlationId (which spans the full lifecycle) and
     * from the plan id (which identifies the plan version).
     * Used for correlating tool and workflow telemetry to a specific execution attempt.
     */
    executionBoundaryId?: string;
    /**
     * Structured approval context.
     * Populated only when requiresApproval is true.
     */
    approvalContext?: ApprovalContext;
    /**
     * Machine-readable reason codes for the current status.
     * Examples: 'blocked:missing_capability:rag', 'approved:operator:user-123'
     */
    reasonCodes: string[];
    /**
     * Deterministic planning-memory strategy metadata selected prior to plan construction.
     * Present on all newly-built plans; absent on legacy persisted plans.
     */
    strategySelection?: StrategySelection;
    /**
     * Flattened strategy metadata for diagnostics/read surfaces that avoid nested reads.
     * Mirrors strategySelection fields at plan seal time.
     */
    selectedLane?: 'trivial' | 'planning_loop' | 'workflow' | 'agent';
    strategyFamily?: StrategyFamily;
    verificationDepth?: VerificationDepth;
    retryPosture?: RetryPosture;
    fallbackPosture?: FallbackPosture;
    artifactFirst?: boolean;
    planningMemoryConfidence?: number;
    planningMemoryReasonCodes?: PlanningMemoryReasonCode[];
    /**
     * Invocation authority metadata supplied by AgentKernel/planning loop.
     * PlanningService uses this metadata for diagnostics and governance traces.
     */
    planningInvocation?: PlanningInvocationMetadata;
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

/**
 * Stage-level terminal status emitted by plan execution.
 */
export type PlanStageExecutionStatus =
    | 'completed'
    | 'failed'
    | 'degraded'
    | 'skipped'
    | 'blocked';

/**
 * Structured execution result for one stage.
 */
export interface PlanStageExecutionResult {
    stageId: string;
    handoffType: 'tool' | 'workflow' | 'agent' | 'none';
    status: PlanStageExecutionStatus;
    startedAt: string;
    completedAt: string;
    outputs?: Record<string, unknown>;
    expectedOutputsSatisfied?: boolean;
    failureReason?: string;
    reasonCodes: string[];
    attempts: number;
}

/**
 * Structured terminal result for an execution-plan run.
 */
export interface PlanExecutionResult {
    planId: string;
    executionBoundaryId?: string;
    status: 'completed' | 'failed' | 'degraded' | 'partial';
    stageResults: PlanStageExecutionResult[];
    completedStageCount: number;
    failedStageCount: number;
    degradedStageCount: number;
    finalOutputs?: Record<string, unknown>;
    reasonCodes: string[];
}

// ─── Replan Request ───────────────────────────────────────────────────────────

/**
 * Policy governing replanning for a goal.
 */
export interface ReplanPolicy {
    /**
     * Maximum number of replans allowed per goal before the service throws
     * REPLAN_LIMIT_EXCEEDED.  Defaults to 5.
     */
    maxReplans: number;
    /**
     * Minimum milliseconds that must elapse between replan calls for the same
     * goal.  Defaults to 30 000 (30 seconds).
     */
    cooldownMs: number;
}

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

export type PlanningInvocationActor =
    | 'agent_kernel'
    | 'planning_loop'
    | 'operator'
    | 'autonomy'
    | 'system';

export type PlanningInvocationReason =
    | 'goal_execution_turn'
    | 'hybrid_goal_commit'
    | 'replan_after_execution_failure'
    | 'operator_requested'
    | 'autonomy_requested'
    | 'legacy_unspecified';

export interface PlanningInvocationMetadata {
    invokedBy: PlanningInvocationActor;
    invocationReason: PlanningInvocationReason;
    turnId?: string;
    turnMode?: TurnMode;
    authorityLevel?: TurnAuthorityLevel;
    memoryWriteMode?: MemoryWriteMode;
}

/**
 * Suggested adaptation mode emitted by execution boundaries when local recovery is exhausted.
 */
export type ExecutionAdaptationMode =
    | 'retry_later'
    | 'choose_alternate_path'
    | 'request_operator_action'
    | 'degrade_goal'
    | 'abandon_step_continue_plan'
    | 'full_replan';

/**
 * Structured execution failure escalation payload emitted by handoff coordinators.
 * Carries deterministic evidence for planner-level adaptation.
 */
export interface ExecutionFailureEscalation {
    planId: string;
    goalId: string;
    executionBoundaryId: string;
    failedStepId?: string;
    failure: StructuredFailure;
    reasonCode: string;
    attemptsMade: number;
    recoveryActionsTried: Array<{
        action: 'retry' | 'reroute' | 'degrade' | 'escalate' | 'replan' | 'none';
        attempt: number;
        targetId?: string;
        reasonCode: string;
        detail?: string;
    }>;
    degradedOutputsExist: boolean;
    survivingArtifacts?: Record<string, unknown>;
    remainingReachableCapabilities?: string[];
    suggestedAdaptation: ExecutionAdaptationMode;
}

/**
 * Alias exposed from planning contracts so planning callers can consume the same
 * canonical replan request payload emitted by execution boundaries.
 */
export type PlanAdaptationInput = ExecutionReplanRequest;


