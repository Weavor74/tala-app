import type { SuccessCriterionResult } from '../planning/SuccessCriteriaTypes';

export type StepCompletionStatus =
    | 'succeeded'
    | 'failed'
    | 'partial'
    | 'blocked'
    | 'requires_operator_input';

export interface ArtifactEvidence {
    id: string;
    artifactType: 'file' | 'summary' | 'search_results' | 'notebook_entry' | 'workflow_output' | 'other';
    reference: string;
    persisted: boolean;
    validated?: boolean;
    reasonCodes: string[];
}

export interface StateMutationEvidence {
    mutationType: 'memory' | 'notebook' | 'search_results' | 'settings' | 'workflow_state' | 'other';
    targetRef?: string;
    attempted: boolean;
    persisted: boolean;
    rejected?: boolean;
    reasonCodes: string[];
}

export interface ValidationEvidence {
    method: string;
    performed: boolean;
    passed?: boolean;
    reasonCodes: string[];
}

export interface StepCompletionEvidence {
    stepId: string;
    status: StepCompletionStatus;
    validationPerformed: boolean;
    validationPassed?: boolean;
    operatorInputRequired: boolean;
    artifacts: ArtifactEvidence[];
    stateMutations: StateMutationEvidence[];
    criterionResults: SuccessCriterionResult[];
    reasonCodes: string[];
}

export type ExecutionQuality = 'successful' | 'partial' | 'blocked' | 'failed' | 'not_applicable';
export type ResponseQuality = 'produced' | 'suppressed' | 'empty' | 'not_produced';

export interface OutcomeEvaluationResult {
    executionId: string;
    planId?: string;
    executionQuality: ExecutionQuality;
    criteriaSatisfiedCount: number;
    criteriaUnmetCount: number;
    requiredCriteriaSatisfied: boolean;
    unmetRequiredCriteria: string[];
    operatorInputRequired: boolean;
    responseProduced: boolean;
    responseQuality?: ResponseQuality;
    reasonCodes: string[];
}

export interface TurnCompletionAssessment {
    responseQuality: ResponseQuality;
    executionQuality: ExecutionQuality;
    responseProduced: boolean;
    taskAttempted: boolean;
    userVisibleCompletion: boolean;
    outcomeVerified: boolean;
    reasonCodes: string[];
}

