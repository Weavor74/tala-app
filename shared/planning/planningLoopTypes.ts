import type { PlanningInvocationMetadata } from './PlanningTypes';
import type {
    IterationBudget,
    IterationContinuationDecision,
    IterationDecisionReasonCode,
    IterationPolicyProfile,
    IterationWorthinessClass,
} from './IterationPolicyTypes';

/**
 * planningLoopTypes.ts - Shared contracts for the Planning Loop subsystem
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

export type LoopCompletionReason =
    | 'execution_succeeded'
    | 'goal_satisfied'
    | 'operator_accepted';

export type LoopFailureReason =
    | 'max_iterations_exceeded'
    | 'replan_limit_exceeded'
    | 'replan_cooldown_active'
    | 'plan_blocked'
    | 'execution_failed'
    | 'abort_requested'
    | 'internal_error';

export type ObservationOutcome = 'succeeded' | 'failed' | 'partial' | 'blocked';

export interface LoopObservationResult {
    outcome: ObservationOutcome;
    goalSatisfied: boolean;
    summary?: string;
    reasonCodes?: string[];
    artifacts?: Record<string, unknown>;
}

export type ReplanDecision = 'complete' | 'replan' | 'abort';

export interface PlanningLoopRun {
    loopId: string;
    correlationId: string;
    goal: string;
    normalizedIntent?: string;
    phase: PlanningLoopPhase;
    createdAt: string;
    updatedAt: string;
    currentIteration: number;
    maxIterations: number;
    explicitMaxIterations?: number;
    iterationPolicyProfile?: IterationPolicyProfile;
    iterationBudget?: IterationBudget;
    taskLoopDoctrineClass?: IterationWorthinessClass;
    goalId?: string;
    currentPlanId?: string;
    executionBoundaryId?: string;
    completionReason?: LoopCompletionReason;
    failureReason?: LoopFailureReason;
    failureDetail?: string;
    lastObservation?: LoopObservationResult;
    contextSummary?: Record<string, unknown>;
    planningInvocation?: PlanningInvocationMetadata;
    iterationPolicyInput?: StartLoopInput['iterationPolicyInput'];
    replanHistory: ReplanHistoryEntry[];
    iterationDecisions?: Array<{
        iteration: number;
        outcome: ObservationOutcome;
        decision: IterationContinuationDecision;
        improved: boolean;
        reasonCodes: IterationDecisionReasonCode[];
        decidedAt: string;
    }>;
}

export interface ReplanHistoryEntry {
    iteration: number;
    decision: ReplanDecision;
    observationOutcome: ObservationOutcome;
    reasonCodes?: string[];
    decidedAt: string;
}

export interface StartLoopInput {
    goal: string;
    maxIterations?: number;
    contextSummary?: Record<string, unknown>;
    planningInvocation?: PlanningInvocationMetadata;
    iterationPolicyInput?: {
        turnMode?: 'conversational' | 'hybrid' | 'goal_execution';
        operatorMode?: 'chat' | 'goal' | 'auto';
        authorityLevel?: 'none' | 'lightweight' | 'full_authority';
        recoveryMode?: boolean;
        autonomousMode?: boolean;
        sideEffectSensitive?: boolean;
        approvalGranted?: boolean;
    };
}

export interface PlanningLoopPolicy {
    defaultMaxIterations: number;
    allowReplanOnFailure: boolean;
    allowReplanOnPartial: boolean;
}
