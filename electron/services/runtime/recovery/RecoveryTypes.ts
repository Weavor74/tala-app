export type RecoveryTriggerType =
    | 'execution_failed'
    | 'tool_failed'
    | 'workflow_failed'
    | 'runtime_degraded'
    | 'retry_exhausted'
    | 'policy_blocked';

export type RecoveryDecisionType =
    | 'retry'
    | 'replan'
    | 'escalate'
    | 'degrade_and_continue'
    | 'stop';

export type RecoveryDecisionOrigin =
    | 'automatic'
    | 'operator_override'
    | 'operator_approved';

export type RecoveryApprovalState =
    | 'not_required'
    | 'pending_operator'
    | 'approved'
    | 'denied';

export type RecoveryOperatorActionType =
    | 'approve_retry'
    | 'approve_replan'
    | 'approve_degraded_continue'
    | 'force_stop'
    | 'deny';

export type FailureFamily =
    | 'timeout'
    | 'unavailable'
    | 'policy_blocked'
    | 'invalid_input'
    | 'dependency_degraded'
    | 'capability_unavailable'
    | 'authentication_failed'
    | 'rate_limited'
    | 'conflict'
    | 'unknown';

export type RecoveryScope =
    | 'step'
    | 'handoff'
    | 'execution_boundary'
    | 'execution'
    | 'plan';

export interface DegradedContinuationMode {
    disabledCapabilities: string[];
    continueMode: 'reduced_capability' | 'read_only' | 'local_only';
}

export interface RecoveryOperatorState {
    approvalState: RecoveryApprovalState;
    overrideAllowed: boolean;
    overrideApplied: boolean;
    lastOperatorAction?: RecoveryOperatorActionType;
    operatorReasonCode?: string;
}

export interface NormalizedExecutionFailure {
    family: FailureFamily;
    message: string;
    retryable: boolean;
    toolId?: string;
    workflowId?: string;
    providerId?: string;
    reasonCode?: string;
}

export interface RecoveryTrigger {
    triggerId: string;
    executionId: string;
    executionBoundaryId?: string;
    planId?: string;
    stepId?: string;
    type: RecoveryTriggerType;
    reasonCode: string;
    timestamp: string;
    failure?: NormalizedExecutionFailure;
    context: {
        handoffType?: 'tool' | 'workflow' | 'agent';
        toolId?: string;
        workflowId?: string;
        providerId?: string;
        retryCount?: number;
        maxRetries?: number;
        replanCount?: number;
        maxReplans?: number;
        canReplan?: boolean;
        canEscalate?: boolean;
        canDegradeContinue?: boolean;
        degradedCapability?: string;
        degradedModeHint?: DegradedContinuationMode['continueMode'];
        loopDetected?: boolean;
        scope?: RecoveryScope;
    };
}

export interface RecoveryDecision {
    decisionId: string;
    triggerId: string;
    executionId: string;
    executionBoundaryId?: string;
    type: RecoveryDecisionType;
    reasonCode: string;
    scope?: RecoveryScope;
    degradedMode?: DegradedContinuationMode;
    origin?: RecoveryDecisionOrigin;
    operatorState?: RecoveryOperatorState;
}

export interface RecoveryBudgetSnapshot {
    retryCount: number;
    maxRetries: number;
    replanCount: number;
    maxReplans: number;
    remainingRetries: number;
    remainingReplans: number;
    scope: RecoveryScope;
    loopDetected: boolean;
}

export interface RecoveryBudgetInput {
    executionId: string;
    executionBoundaryId?: string;
    scope?: RecoveryScope;
}

export interface RecoveryLoopSignal {
    loopDetected: boolean;
    reasonCode?: string;
}

export interface RecoveryHistoryEntry {
    historyId: string;
    timestamp: string;
    executionId: string;
    executionBoundaryId?: string;
    triggerType: RecoveryTriggerType;
    decisionType: RecoveryDecisionType;
    reasonCode: string;
    scope?: RecoveryScope;
    failureFamily?: FailureFamily;
    origin: RecoveryDecisionOrigin;
    operatorOverrideApplied: boolean;
    approvalState: RecoveryApprovalState;
    outcome: 'executed' | 'failed' | 'denied' | 'superseded';
    degradedMode?: DegradedContinuationMode;
}

export interface RecoveryAnalyticsSnapshot {
    totals: {
        retries: number;
        replans: number;
        escalations: number;
        degradedContinues: number;
        stops: number;
        overrides: number;
        loopDetections: number;
    };
    topReasonCodes: Array<{ reasonCode: string; count: number }>;
    byDecisionType: Array<{ decisionType: RecoveryDecisionType; count: number }>;
    byFailureFamily: Array<{ failureFamily: FailureFamily; count: number }>;
}

export interface RecoveryOperatorActionInput {
    executionId: string;
    executionBoundaryId?: string;
    decisionId?: string;
    action: RecoveryOperatorActionType;
    operatorReasonCode: string;
}

export interface RecoveryOperatorSnapshot {
    executionId: string;
    executionBoundaryId?: string;
    activeDecision?: RecoveryDecision;
    approvalState: RecoveryApprovalState;
    overrideAllowed: boolean;
    overrideApplied: boolean;
    lastOperatorAction?: RecoveryOperatorActionType;
    operatorReasonCode?: string;
    degradedMode?: DegradedContinuationMode;
    budget?: RecoveryBudgetSnapshot;
    exhausted?: {
        retryExhausted: boolean;
        replanExhausted: boolean;
        anyExhausted: boolean;
    };
    loopDetected: boolean;
    updatedAt: string;
}
