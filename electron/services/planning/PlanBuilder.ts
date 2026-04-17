/**
 * PlanBuilder.ts — Structured execution plan construction for the Planning subsystem
 *
 * Converts a PlanGoal + GoalAnalysis into a fully structured ExecutionPlan
 * containing explicit stages, dependencies, approval state, and handoff metadata.
 *
 * Design invariants
 * ─────────────────
 * 1. Deterministic — same goal + analysis inputs produce structurally equivalent
 *    plans (stage shape, approval state, handoff target).  Stage IDs are uuid-based
 *    and therefore non-deterministic by design, but all other fields are stable.
 * 2. Pure — build() performs no I/O and emits no telemetry.
 * 3. Explicit stages — no prose-only plan blobs; every stage declares type,
 *    executionMode, failurePolicy, successCriteria, and requiredCapabilities.
 * 4. Blocked analysis → blocked plan — when GoalAnalysis has blockingIssues, the
 *    resulting plan is immediately status:'blocked' with no stages to execute.
 * 5. Approval-required plans start in 'pending' approval state with status 'draft'
 *    until PlanningService records the approval decision.
 * 6. Replanning — caller supplies replannedFromPlanId to link the new plan to the
 *    superseded plan; the new plan gets version = prior.version + 1.
 * 7. No execution — PlanBuilder does not invoke tools, workflows, or LLM calls.
 *    Stage types 'tool' / 'workflow' / 'llm' declare intent only; downstream
 *    execution authorities carry out the actual work.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    PlanGoal,
    GoalAnalysis,
    ExecutionPlan,
    PlanStage,
    PlanStageType,
    StageExecutionMode,
    StageFailurePolicy,
    ExecutionHandoff,
    PlannedToolInvocation,
    PlannedWorkflowInvocation,
    PlannedAgentInvocation,
    PlanApprovalState,
    ExecutionPlanStatus,
    GoalExecutionStyle,
} from '../../../shared/planning/PlanningTypes';
import type {
    StrategySelection,
} from '../../../shared/planning/PlanningMemoryTypes';

// ---------------------------------------------------------------------------
// Stage factory helpers
// ---------------------------------------------------------------------------

function makeStage(
    title: string,
    description: string,
    type: PlanStageType,
    executionMode: StageExecutionMode,
    failurePolicy: StageFailurePolicy,
    successCriteria: string[],
    requiredCapabilities: string[] = [],
    outputs: Record<string, string> = {},
): PlanStage {
    return {
        id: uuidv4(),
        title,
        description,
        type,
        executionMode,
        successCriteria,
        failurePolicy,
        requiredCapabilities,
        outputs,
    };
}

// ---------------------------------------------------------------------------
// Stage set builders per execution style
// ---------------------------------------------------------------------------

/**
 * Stages for deterministic goals (maintenance, diagnostics, release, memory).
 */
function buildDeterministicStages(goal: PlanGoal): PlanStage[] {
    return [
        makeStage(
            'Pre-flight checks',
            'Verify required runtime conditions and capability availability before proceeding.',
            'preflight',
            'deterministic',
            'stop',
            ['all required capabilities confirmed available'],
            [],
            { preflightResult: 'boolean' },
        ),
        makeStage(
            'Retrieve context',
            `Retrieve relevant context for goal: ${goal.title}`,
            'retrieve',
            'deterministic',
            'stop',
            ['context retrieved without error'],
            [],
            { context: 'record' },
        ),
        makeStage(
            'Execute main work',
            `Perform the primary work for goal category '${goal.category}'.`,
            goal.category === 'maintenance' || goal.category === 'diagnostics'
                ? 'tool'
                : 'workflow',
            'deterministic',
            'retry',
            ['primary work completed without error'],
            [],
            { result: 'record' },
        ),
        makeStage(
            'Verify outcome',
            'Assert that the execution outcome meets the goal success criteria.',
            'verify',
            'deterministic',
            'escalate',
            goal.successCriteria?.length
                ? goal.successCriteria
                : ['execution result is non-error and meets declared criteria'],
            [],
            { verificationPassed: 'boolean' },
        ),
        makeStage(
            'Finalise',
            'Seal the plan, record outcomes, and emit completion signal.',
            'finalize',
            'deterministic',
            'stop',
            ['plan sealed and outcome recorded'],
            [],
            { completedAt: 'string' },
        ),
    ];
}

/**
 * Stages for workflow-based goals.
 */
function buildWorkflowStages(goal: PlanGoal): PlanStage[] {
    return [
        makeStage(
            'Pre-flight checks',
            'Verify required workflows are registered and runtime is ready.',
            'preflight',
            'deterministic',
            'stop',
            ['workflow engine available', 'target workflow registered'],
            ['workflow_engine'],
            { preflightResult: 'boolean' },
        ),
        makeStage(
            'Dispatch workflow',
            `Dispatch registered workflow for goal: ${goal.title}`,
            'workflow',
            'deterministic',
            'retry',
            ['workflow dispatched without error', 'workflow run ID returned'],
            ['workflow_engine'],
            { workflowRunId: 'string' },
        ),
        makeStage(
            'Await workflow completion',
            'Monitor workflow execution and await terminal state.',
            'verify',
            'deterministic',
            'escalate',
            ['workflow reached terminal state (completed or failed)'],
            ['workflow_engine'],
            { workflowStatus: 'string', workflowResult: 'record' },
        ),
        makeStage(
            'Finalise',
            'Record workflow outcome and seal plan.',
            'finalize',
            'deterministic',
            'stop',
            ['plan sealed with workflow result'],
            [],
            { completedAt: 'string' },
        ),
    ];
}

/**
 * Stages for tool-orchestrated goals (research, tooling).
 */
function buildToolOrchestrationStages(goal: PlanGoal): PlanStage[] {
    return [
        makeStage(
            'Pre-flight checks',
            'Verify tool execution infrastructure is available.',
            'preflight',
            'deterministic',
            'stop',
            ['tool execution coordinator available'],
            ['tool_execution'],
            { preflightResult: 'boolean' },
        ),
        makeStage(
            'Retrieve relevant context',
            'Retrieve prior context and related artifacts to inform tool execution.',
            'retrieve',
            'deterministic',
            'skip',
            ['relevant context retrieved or gracefully unavailable'],
            [],
            { context: 'record' },
        ),
        makeStage(
            'Execute governed tool sequence',
            `Execute tool sequence for goal: ${goal.title}`,
            'tool',
            'deterministic',
            'retry',
            ['all required tools executed without policy block'],
            ['tool_execution'],
            { toolResults: 'array' },
        ),
        makeStage(
            'Analyse tool results',
            'Analyse and structure the outputs from the tool execution sequence.',
            'analyze',
            'deterministic',
            'stop',
            ['analysis of tool results produced', 'output is structured and machine-readable'],
            [],
            { analysisResult: 'record' },
        ),
        makeStage(
            'Verify and finalise',
            'Verify outcomes against goal success criteria and seal the plan.',
            'finalize',
            'deterministic',
            'stop',
            goal.successCriteria?.length
                ? goal.successCriteria
                : ['tool sequence completed and results are valid'],
            [],
            { completedAt: 'string' },
        ),
    ];
}

/**
 * Stages for LLM-assisted goals (conversation, novel synthesis).
 */
function buildLlmAssistedStages(goal: PlanGoal): PlanStage[] {
    return [
        makeStage(
            'Pre-flight checks',
            'Verify inference capability is available.',
            'preflight',
            'deterministic',
            'stop',
            ['inference provider available'],
            ['inference'],
            { preflightResult: 'boolean' },
        ),
        makeStage(
            'Retrieve supporting context',
            'Retrieve relevant memories and context before model synthesis.',
            'retrieve',
            'deterministic',
            'skip',
            ['context retrieved or gracefully unavailable'],
            [],
            { context: 'record' },
        ),
        makeStage(
            'Model-assisted synthesis',
            `Generate LLM-assisted output for goal: ${goal.title}`,
            'llm',
            'assisted',
            'retry',
            ['model output produced', 'output normalised into plan schema'],
            ['inference'],
            { synthesisResult: 'record' },
        ),
        makeStage(
            'Normalise and validate output',
            'Normalise model output into structured schema; reject if schema violations exist.',
            'verify',
            'deterministic',
            'stop',
            ['output conforms to required schema', 'no unsafe content in output'],
            [],
            { normalised: 'record', valid: 'boolean' },
        ),
        makeStage(
            'Finalise',
            'Seal the plan and record the synthesis outcome.',
            'finalize',
            'deterministic',
            'stop',
            ['plan sealed with synthesis result'],
            [],
            { completedAt: 'string' },
        ),
    ];
}

/**
 * Hybrid stages — deterministic scaffolding + one LLM synthesis step.
 */
function buildHybridStages(goal: PlanGoal): PlanStage[] {
    return [
        makeStage(
            'Pre-flight checks',
            'Verify required capabilities (tool + inference) are available.',
            'preflight',
            'deterministic',
            'stop',
            ['tool execution available', 'inference available'],
            ['tool_execution', 'inference'],
            { preflightResult: 'boolean' },
        ),
        makeStage(
            'Deterministic data gathering',
            'Gather structured data using deterministic tool execution.',
            'tool',
            'deterministic',
            'retry',
            ['data gathered without tool error'],
            ['tool_execution'],
            { gatheredData: 'record' },
        ),
        makeStage(
            'LLM synthesis over gathered data',
            'Use model to synthesise the gathered data into the required output form.',
            'llm',
            'assisted',
            'retry',
            ['synthesis produced from gathered data', 'output normalised to schema'],
            ['inference'],
            { synthesisResult: 'record' },
        ),
        makeStage(
            'Verify and finalise',
            'Validate synthesis output and seal the plan.',
            'finalize',
            'deterministic',
            'stop',
            goal.successCriteria?.length
                ? goal.successCriteria
                : ['synthesis validated and plan sealed'],
            [],
            { completedAt: 'string' },
        ),
    ];
}

/**
 * A single-stage blocked plan.  Emitted when analysis has blockingIssues.
 */
function buildBlockedStages(blockingIssues: string[]): PlanStage[] {
    return [
        makeStage(
            'Blocked — cannot proceed',
            `Plan blocked due to: ${blockingIssues.join('; ')}`,
            'preflight',
            'deterministic',
            'stop',
            ['blocking issues must be resolved before plan can proceed'],
            [],
            {},
        ),
    ];
}

// ---------------------------------------------------------------------------
// Handoff contract construction
// ---------------------------------------------------------------------------

/**
 * Prefix for workflow IDs on workflow-style goals.
 * @internal
 */
const WORKFLOW_ID_PREFIX = 'workflow';

/**
 * Prefix for deterministic workflow IDs.
 * @internal
 */
const DETERMINISTIC_WORKFLOW_ID_PREFIX = 'workflow.deterministic';

/**
 * Builds the typed ExecutionHandoff discriminated union from a GoalAnalysis.
 */
function buildHandoff(
    analysis: GoalAnalysis,
    strategySelection?: StrategySelection,
): ExecutionHandoff {
    if (analysis.blockingIssues.length > 0) {
        return {
            type: 'none',
            contractVersion: 1,
            reason: analysis.blockingIssues[0] ?? 'blocked',
        };
    }

    if (strategySelection) {
        if (strategySelection.selectedLane === 'agent') {
            const agentInvocation: PlannedAgentInvocation = {
                agentId: `agent.strategy.${analysis.goalId}`,
                executionMode: analysis.executionStyle === 'deterministic'
                    ? 'hybrid'
                    : analysis.executionStyle,
                input: { goalId: analysis.goalId },
                description: 'Invoke agent kernel according to selected planning strategy',
                failurePolicy: strategySelection.retryPosture === 'none' ? 'stop' : 'retry',
                requiredCapabilities: ['inference'],
                degradeAllowed: strategySelection.fallbackPosture === 'degrade',
            };
            return {
                type: 'agent',
                contractVersion: 1,
                invocation: agentInvocation,
                sharedInputs: { goalId: analysis.goalId },
            };
        }
        if (strategySelection.selectedLane === 'workflow') {
            const invocations: PlannedWorkflowInvocation[] = [
                {
                    workflowId: `${WORKFLOW_ID_PREFIX}.${analysis.goalId}`,
                    input: { goalId: analysis.goalId },
                    description: 'Dispatch strategy-selected workflow for goal',
                    failurePolicy: strategySelection.retryPosture === 'none' ? 'stop' : 'retry',
                    requiredCapabilities: ['workflow_engine'],
                    degradeAllowed: strategySelection.fallbackPosture === 'degrade',
                },
            ];
            return {
                type: 'workflow',
                contractVersion: 1,
                invocations,
                sharedInputs: { goalId: analysis.goalId },
            };
        }
        if (strategySelection.strategyFamily === 'direct_tool') {
            const steps: PlannedToolInvocation[] = [
                {
                    toolId: 'tool_execution_preflight',
                    input: { goalId: analysis.goalId },
                    description: 'Verify tool execution infrastructure is available',
                    failurePolicy: strategySelection.retryPosture === 'none' ? 'stop' : 'retry',
                    degradeAllowed: strategySelection.fallbackPosture === 'degrade',
                },
            ];
            return {
                type: 'tool',
                contractVersion: 1,
                steps,
                sharedInputs: { goalId: analysis.goalId },
            };
        }
    }

    switch (analysis.executionStyle as GoalExecutionStyle) {
        case 'workflow': {
            const invocations: PlannedWorkflowInvocation[] = [
                {
                    workflowId: `${WORKFLOW_ID_PREFIX}.${analysis.goalId}`,
                    input: { goalId: analysis.goalId },
                    description: 'Dispatch primary workflow for goal',
                    failurePolicy: 'stop',
                    requiredCapabilities: ['workflow_engine'],
                },
            ];
            return {
                type: 'workflow',
                contractVersion: 1,
                invocations,
                sharedInputs: { goalId: analysis.goalId },
            };
        }
        case 'tool_orchestrated': {
            const steps: PlannedToolInvocation[] = [
                {
                    toolId: 'tool_execution_preflight',
                    input: { goalId: analysis.goalId },
                    description: 'Verify tool execution infrastructure is available',
                    failurePolicy: 'stop',
                },
            ];
            return {
                type: 'tool',
                contractVersion: 1,
                steps,
                sharedInputs: { goalId: analysis.goalId },
            };
        }
        case 'llm_assisted':
        case 'hybrid': {
            const agentInvocation: PlannedAgentInvocation = {
                agentId: `agent.${analysis.executionStyle}.${analysis.goalId}`,
                executionMode: analysis.executionStyle,
                input: { goalId: analysis.goalId },
                description: 'Invoke agent kernel for model-assisted execution',
                failurePolicy: 'stop',
                requiredCapabilities: ['inference'],
            };
            return {
                type: 'agent',
                contractVersion: 1,
                invocation: agentInvocation,
                sharedInputs: { goalId: analysis.goalId },
            };
        }
        case 'deterministic':
        default: {
            const invocations: PlannedWorkflowInvocation[] = [
                {
                    workflowId: `${DETERMINISTIC_WORKFLOW_ID_PREFIX}.${analysis.goalId}`,
                    input: { goalId: analysis.goalId },
                    description: 'Dispatch deterministic workflow for goal',
                    failurePolicy: 'stop',
                    requiredCapabilities: ['workflow_engine'],
                },
            ];
            return {
                type: 'workflow',
                contractVersion: 1,
                invocations,
                sharedInputs: { goalId: analysis.goalId },
            };
        }
    }
}

// ---------------------------------------------------------------------------
// PlanBuilder
// ---------------------------------------------------------------------------

/** Input for building an initial plan. */
export interface PlanBuildInput {
    goal: PlanGoal;
    analysis: GoalAnalysis;
    strategySelection?: StrategySelection;
    /** If this plan supersedes an existing plan, pass the prior plan here. */
    priorPlan?: ExecutionPlan;
}

/**
 * Pure static plan builder.
 *
 * Usage:
 *   const plan = PlanBuilder.build({ goal, analysis });
 *   const replan = PlanBuilder.build({ goal, analysis, priorPlan });
 */
export class PlanBuilder {
    /**
     * Builds a structured ExecutionPlan from a goal and its analysis.
     *
     * When priorPlan is provided, the resulting plan has:
     *   - version = priorPlan.version + 1
     *   - replannedFromPlanId = priorPlan.id
     *
     * The caller (PlanningService) is responsible for marking priorPlan as
     * 'superseded' — PlanBuilder does not mutate the prior plan.
     */
    static build({ goal, analysis, strategySelection, priorPlan }: PlanBuildInput): ExecutionPlan {
        const now = new Date().toISOString();
        const planId = uuidv4();
        const version = priorPlan ? priorPlan.version + 1 : 1;

        const isBlocked = analysis.blockingIssues.length > 0;

        const stages: PlanStage[] = isBlocked
            ? buildBlockedStages(analysis.blockingIssues)
            : PlanBuilder._buildStages(goal, analysis, strategySelection);

        const dependencies = PlanBuilder._buildDependencies(stages);

        const handoff = buildHandoff(analysis, strategySelection);

        const approvalState: PlanApprovalState = isBlocked
            ? 'not_required'
            : analysis.requiresApproval
                ? 'pending'
                : 'not_required';

        const status: ExecutionPlanStatus = isBlocked
            ? 'blocked'
            : analysis.requiresApproval
                ? 'draft'
                : 'ready';

        const reasonCodes: string[] = [
            ...analysis.reasonCodes,
            isBlocked ? 'plan:blocked' : 'plan:constructed',
            `handoff:${handoff.type}`,
        ];
        if (strategySelection) {
            reasonCodes.push(`strategy:${strategySelection.strategyFamily}`);
            reasonCodes.push(`verification:${strategySelection.verificationDepth}`);
            reasonCodes.push(`retry:${strategySelection.retryPosture}`);
            reasonCodes.push(`fallback:${strategySelection.fallbackPosture}`);
            reasonCodes.push(...strategySelection.reasonCodes);
        }
        if (priorPlan) {
            reasonCodes.push(`replan_from:${priorPlan.id}`);
        }

        const summary = isBlocked
            ? `Blocked: ${analysis.blockingIssues[0] ?? 'unknown issue'}`
            : `${analysis.executionStyle} plan for ${goal.category} goal "${goal.title}"`;

        const plan: ExecutionPlan = {
            id: planId,
            goalId: goal.id,
            version,
            createdAt: now,
            updatedAt: now,
            plannerType: analysis.recommendedPlanner,
            summary,
            stages,
            dependencies,
            estimatedRisk: analysis.risk,
            requiresApproval: analysis.requiresApproval,
            approvalState,
            status,
            handoff,
            ...(analysis.approvalContext && { approvalContext: analysis.approvalContext }),
            reasonCodes,
            strategySelection,
            selectedLane: strategySelection?.selectedLane,
            strategyFamily: strategySelection?.strategyFamily,
            verificationDepth: strategySelection?.verificationDepth,
            retryPosture: strategySelection?.retryPosture,
            fallbackPosture: strategySelection?.fallbackPosture,
            artifactFirst: strategySelection?.artifactFirst,
            planningMemoryConfidence: strategySelection?.confidence,
            planningMemoryReasonCodes: strategySelection?.reasonCodes,
            ...(priorPlan && { replannedFromPlanId: priorPlan.id }),
        };

        return plan;
    }

    /**
     * Selects and builds the stage list for a given goal + analysis.
     */
    static _buildStages(
        goal: PlanGoal,
        analysis: GoalAnalysis,
        strategySelection?: StrategySelection,
    ): PlanStage[] {
        const baseStages = (() => {
            switch (analysis.executionStyle) {
                case 'deterministic':    return buildDeterministicStages(goal);
                case 'workflow':         return buildWorkflowStages(goal);
                case 'tool_orchestrated':return buildToolOrchestrationStages(goal);
                case 'llm_assisted':     return buildLlmAssistedStages(goal);
                case 'hybrid':           return buildHybridStages(goal);
                default:                 return buildDeterministicStages(goal);
            }
        })();
        if (!strategySelection) {
            return baseStages;
        }
        return PlanBuilder._applyStrategySelection(baseStages, strategySelection);
    }

    private static _applyStrategySelection(
        stages: PlanStage[],
        strategySelection: StrategySelection,
    ): PlanStage[] {
        const adapted = stages.map(stage => ({ ...stage }));

        if (strategySelection.artifactFirst) {
            adapted.unshift(
                makeStage(
                    'Create artifact workspace',
                    'Prepare artifact-first workspace before primary execution.',
                    'write',
                    'deterministic',
                    'stop',
                    ['artifact workspace prepared'],
                    [],
                    { artifactWorkspace: 'record' },
                ),
            );
        }

        if (strategySelection.verificationDepth === 'elevated' || strategySelection.verificationDepth === 'strict') {
            adapted.push(
                makeStage(
                    'Deep verification',
                    strategySelection.verificationDepth === 'strict'
                        ? 'Run strict verification over outputs and invariants.'
                        : 'Run elevated verification over outputs and invariants.',
                    'verify',
                    'deterministic',
                    'escalate',
                    ['verification evidence complete', 'no invariant violations detected'],
                    [],
                    { verificationEvidence: 'record' },
                ),
            );
        }

        for (const stage of adapted) {
            if (strategySelection.retryPosture === 'none' && stage.failurePolicy === 'retry') {
                stage.failurePolicy = 'stop';
                stage.retryPolicy = { maxAttempts: 1, delayMs: 0 };
            } else if (strategySelection.retryPosture === 'light' && stage.failurePolicy === 'retry') {
                stage.retryPolicy = { maxAttempts: 2, delayMs: 250 };
            } else if (strategySelection.retryPosture === 'conservative' && stage.failurePolicy === 'retry') {
                stage.retryPolicy = { maxAttempts: 2, delayMs: 1000 };
            } else if (strategySelection.retryPosture === 'standard' && stage.failurePolicy === 'retry') {
                stage.retryPolicy = { maxAttempts: 3, delayMs: 500 };
            }

            if (
                strategySelection.fallbackPosture === 'degrade' &&
                (stage.type === 'retrieve' || stage.type === 'tool' || stage.type === 'workflow')
            ) {
                stage.failurePolicy = 'skip';
            }
        }

        return adapted;
    }

    /**
     * Builds a linear dependency map from an ordered stage list.
     * Each stage (except the first) depends on the preceding stage.
     * Returns an empty map for single-stage plans.
     */
    static _buildDependencies(stages: PlanStage[]): Record<string, string[]> {
        const deps: Record<string, string[]> = {};
        for (let i = 0; i < stages.length; i++) {
            deps[stages[i].id] = i === 0 ? [] : [stages[i - 1].id];
        }
        return deps;
    }
}
