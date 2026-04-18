export type SuccessCriterionType =
    | 'artifact_generated'
    | 'artifact_validated'
    | 'memory_updated'
    | 'notebook_updated'
    | 'search_results_persisted'
    | 'summary_created'
    | 'workflow_completed'
    | 'tool_result_validated'
    | 'operator_response_recorded'
    | 'custom';

export type CriterionValidationMethod =
    | 'presence_of_output_key'
    | 'artifact_persisted'
    | 'artifact_validated'
    | 'state_mutation_verified'
    | 'workflow_terminal_success'
    | 'tool_output_validation'
    | 'operator_acknowledged'
    | 'custom_rule';

export interface SuccessCriterion {
    id: string;
    type: SuccessCriterionType;
    label: string;
    targetRef?: string;
    required: boolean;
    validationMethod: CriterionValidationMethod;
    metadata?: Record<string, unknown>;
}

export interface SuccessCriterionResult {
    criterionId: string;
    type: SuccessCriterionType;
    required: boolean;
    satisfied: boolean;
    validationPerformed: boolean;
    validationMethod: CriterionValidationMethod;
    reasonCodes: string[];
    evidenceRefs?: string[];
    detail?: string;
}

