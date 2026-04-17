/**
 * failureRecoveryTypes.ts - Canonical runtime failure normalization and recovery contracts.
 *
 * Deterministic contracts used to convert raw execution failures into
 * machine-usable recovery decisions across tool/workflow/agent handoff boundaries.
 */

export type FailureClass =
    | 'timeout'
    | 'rate_limited'
    | 'auth_required'
    | 'permission_denied'
    | 'resource_unavailable'
    | 'dependency_unreachable'
    | 'invalid_input'
    | 'policy_blocked'
    | 'partial_result'
    | 'invariant_violation'
    | 'unsupported_capability'
    | 'unknown';

export type FailureScope = 'tool' | 'workflow' | 'service' | 'plan';

export interface StructuredFailure {
    class: FailureClass;
    reasonCode: string;
    retryable: boolean;
    transient: boolean;
    recoverable: boolean;
    operatorActionRequired: boolean;
    scope: FailureScope;
    message: string;
    providerId?: string;
    toolId?: string;
    workflowId?: string;
    stepId?: string;
    rawEvidence?: unknown;
    metadata?: Record<string, unknown>;
}

export interface RecoveryPolicy {
    allowRetry: boolean;
    maxRetries: number;
    backoffMsByAttempt: number[];
    allowReroute: boolean;
    allowEscalation: boolean;
    allowReplan: boolean;
    degradeAllowed: boolean;
    cooldownMs: number;
    escalationTarget: 'operator' | 'authority' | 'none';
}

export type RecoveryActionKind =
    | 'retry'
    | 'reroute'
    | 'degrade'
    | 'escalate'
    | 'replan'
    | 'none';

export interface RecoveryActionRecord {
    action: RecoveryActionKind;
    attempt: number;
    targetId?: string;
    reasonCode: string;
    detail?: string;
}

export type RecoveryOutcomeStatus =
    | 'recovered_by_retry'
    | 'recovered_by_reroute'
    | 'degraded_but_completed'
    | 'escalation_required'
    | 'replan_required'
    | 'terminal_failure';

export interface RecoveryOutcome {
    status: RecoveryOutcomeStatus;
    attempts: number;
    actions: RecoveryActionRecord[];
    finalFailure?: StructuredFailure;
    degraded: boolean;
    antiThrashSuppressed?: boolean;
}

export interface ExecutionReplanRequest {
    goalId?: string;
    planId?: string;
    executionBoundaryId?: string;
    failedStepId?: string;
    failedTargetId?: string;
    failure: StructuredFailure;
    attemptsMade: number;
    recoveryActionsTried: RecoveryActionRecord[];
    degradedOutputsExist: boolean;
    survivingArtifacts?: Record<string, unknown>;
    remainingReachableCapabilities?: string[];
    reasonCode: string;
    suggestedAdaptation:
        | 'retry_later'
        | 'choose_alternate_path'
        | 'request_operator_action'
        | 'degrade_goal'
        | 'abandon_step_continue_plan'
        | 'full_replan';
}

export interface FailureSignature {
    key: string;
    class: FailureClass;
    reasonCode: string;
}

export interface FailureSuppressionPolicy {
    threshold: number;
    windowMs: number;
    cooldownMs: number;
}

