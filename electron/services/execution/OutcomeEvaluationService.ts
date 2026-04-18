import type {
    ExecutionQuality,
    OutcomeEvaluationResult,
    ResponseQuality,
    StepCompletionEvidence,
    TurnCompletionAssessment,
} from '../../../shared/execution/CompletionEvidenceTypes';
import type { PlanStageExecutionResult } from '../../../shared/planning/PlanningTypes';
import type { SuccessCriterion, SuccessCriterionResult } from '../../../shared/planning/SuccessCriteriaTypes';

interface EvaluatePlanOutcomeInput {
    executionId: string;
    planId?: string;
    criteria?: SuccessCriterion[];
    stageResults: PlanStageExecutionResult[];
    responseProduced?: boolean;
    responseQuality?: ResponseQuality;
}

function buildCriterionResult(
    criterion: SuccessCriterion,
    stageEvidence: StepCompletionEvidence[],
): SuccessCriterionResult {
    const allStageResults = stageEvidence.flatMap((evidence) => evidence.criterionResults ?? []);
    const direct = allStageResults.find((result) => result.criterionId === criterion.id);
    if (direct) {
        return direct;
    }

    const reasons: string[] = [];
    let satisfied = false;
    let validationPerformed = false;

    switch (criterion.type) {
        case 'artifact_generated': {
            const hasArtifact = stageEvidence.some((item) => item.artifacts.some((artifact) => artifact.persisted));
            satisfied = hasArtifact;
            validationPerformed = true;
            reasons.push(hasArtifact ? 'artifact_generated_verified' : 'artifact_missing');
            break;
        }
        case 'artifact_validated': {
            const validated = stageEvidence.some((item) => item.artifacts.some((artifact) => artifact.validated === true));
            satisfied = validated;
            validationPerformed = true;
            reasons.push(validated ? 'artifact_generated_verified' : 'artifact_validation_failed');
            break;
        }
        case 'memory_updated': {
            const mutation = stageEvidence.some((item) =>
                item.stateMutations.some((mutationEvidence) =>
                    mutationEvidence.mutationType === 'memory' &&
                    mutationEvidence.persisted));
            satisfied = mutation;
            validationPerformed = true;
            reasons.push(mutation ? 'memory_update_verified' : 'memory_update_missing');
            break;
        }
        case 'notebook_updated': {
            const mutation = stageEvidence.some((item) =>
                item.stateMutations.some((mutationEvidence) =>
                    mutationEvidence.mutationType === 'notebook' &&
                    mutationEvidence.persisted));
            satisfied = mutation;
            validationPerformed = true;
            reasons.push(mutation ? 'notebook_update_verified' : 'notebook_update_missing');
            break;
        }
        case 'search_results_persisted': {
            const mutation = stageEvidence.some((item) =>
                item.stateMutations.some((mutationEvidence) =>
                    mutationEvidence.mutationType === 'search_results' &&
                    mutationEvidence.persisted));
            satisfied = mutation;
            validationPerformed = true;
            reasons.push(mutation ? 'search_results_persisted' : 'search_results_not_persisted');
            break;
        }
        case 'summary_created': {
            const summary = stageEvidence.some((item) =>
                item.artifacts.some((artifact) => artifact.artifactType === 'summary' && artifact.persisted));
            satisfied = summary;
            validationPerformed = true;
            reasons.push(summary ? 'artifact_generated_verified' : 'artifact_missing');
            break;
        }
        case 'workflow_completed': {
            const workflowCompleted = stageEvidence.some((item) => item.status === 'succeeded');
            satisfied = workflowCompleted;
            validationPerformed = true;
            reasons.push(workflowCompleted ? 'required_criteria_satisfied' : 'execution_blocked_dependency');
            break;
        }
        case 'tool_result_validated': {
            const validated = stageEvidence.some((item) => item.validationPassed === true);
            satisfied = validated;
            validationPerformed = stageEvidence.some((item) => item.validationPerformed);
            reasons.push(validated ? 'tool_result_validated' : 'tool_result_invalid');
            break;
        }
        case 'operator_response_recorded': {
            const operatorAction = stageEvidence.some((item) => item.operatorInputRequired);
            satisfied = operatorAction;
            validationPerformed = true;
            reasons.push(operatorAction ? 'operator_input_required' : 'required_criteria_unmet');
            break;
        }
        case 'custom':
        default: {
            const customSatisfied = stageEvidence.some((item) =>
                item.reasonCodes.includes(`criterion_satisfied:${criterion.id}`));
            satisfied = customSatisfied;
            validationPerformed = stageEvidence.some((item) =>
                item.reasonCodes.includes(`criterion_checked:${criterion.id}`));
            reasons.push(customSatisfied ? 'required_criteria_satisfied' : 'required_criteria_unmet');
            break;
        }
    }

    return {
        criterionId: criterion.id,
        type: criterion.type,
        required: criterion.required,
        satisfied,
        validationPerformed,
        validationMethod: criterion.validationMethod,
        reasonCodes: reasons,
        evidenceRefs: criterion.targetRef ? [criterion.targetRef] : undefined,
        detail: criterion.label,
    };
}

export class OutcomeEvaluationService {
    evaluatePlanOutcome(input: EvaluatePlanOutcomeInput): OutcomeEvaluationResult {
        const stageEvidence = input.stageResults
            .map((result) => result.completionEvidence)
            .filter((item): item is StepCompletionEvidence => Boolean(item));
        const criteria = input.criteria ?? [];
        if (criteria.length === 0) {
            return {
                executionId: input.executionId,
                planId: input.planId,
                executionQuality: 'failed',
                criteriaSatisfiedCount: 0,
                criteriaUnmetCount: 0,
                requiredCriteriaSatisfied: false,
                unmetRequiredCriteria: [],
                operatorInputRequired: false,
                responseProduced: input.responseProduced === true,
                responseQuality: input.responseQuality,
                reasonCodes: ['missing_success_criteria_contract'],
            };
        }

        const criterionResults = criteria.map((criterion) => buildCriterionResult(criterion, stageEvidence));
        const required = criterionResults.filter((result) => result.required);
        const unmetRequired = required.filter((result) => !result.satisfied);
        const criteriaSatisfiedCount = criterionResults.filter((result) => result.satisfied).length;
        const criteriaUnmetCount = criterionResults.length - criteriaSatisfiedCount;
        const operatorInputRequired = stageEvidence.some((result) => result.operatorInputRequired);
        const anyFailed = stageEvidence.some((result) => result.status === 'failed');
        const anyBlocked = stageEvidence.some((result) =>
            result.status === 'blocked' || result.status === 'requires_operator_input');
        const anyPartial = stageEvidence.some((result) => result.status === 'partial');
        const requiredCriteriaSatisfied = unmetRequired.length === 0;

        let executionQuality: ExecutionQuality = 'successful';
        if (operatorInputRequired || anyBlocked) {
            executionQuality = 'blocked';
        } else if (!requiredCriteriaSatisfied && (anyFailed || stageEvidence.length === 0)) {
            executionQuality = 'failed';
        } else if (!requiredCriteriaSatisfied || anyPartial) {
            executionQuality = 'partial';
        }

        const reasonCodes = new Set<string>();
        reasonCodes.add(requiredCriteriaSatisfied ? 'required_criteria_satisfied' : 'required_criteria_unmet');
        if (operatorInputRequired) reasonCodes.add('operator_input_required');
        if (executionQuality === 'partial') reasonCodes.add('partial_completion_only');
        if (executionQuality === 'blocked') reasonCodes.add('execution_blocked_dependency');
        if (input.responseProduced === true && executionQuality !== 'successful' && !requiredCriteriaSatisfied) {
            reasonCodes.add('response_only_no_verified_outcome');
        }
        for (const result of criterionResults) {
            for (const reasonCode of result.reasonCodes) {
                reasonCodes.add(reasonCode);
            }
        }

        return {
            executionId: input.executionId,
            planId: input.planId,
            executionQuality,
            criteriaSatisfiedCount,
            criteriaUnmetCount,
            requiredCriteriaSatisfied,
            unmetRequiredCriteria: unmetRequired.map((result) => result.criterionId),
            operatorInputRequired,
            responseProduced: input.responseProduced === true,
            responseQuality: input.responseQuality,
            reasonCodes: Array.from(reasonCodes),
        };
    }

    assessTurnCompletion(input: {
        taskAttempted: boolean;
        responseProduced: boolean;
        responseQuality: ResponseQuality;
        outcomeEvaluation?: OutcomeEvaluationResult;
    }): TurnCompletionAssessment {
        const executionQuality: ExecutionQuality = input.outcomeEvaluation?.executionQuality
            ?? (input.taskAttempted ? 'failed' : 'not_applicable');
        const outcomeVerified = Boolean(
            input.outcomeEvaluation &&
            input.outcomeEvaluation.requiredCriteriaSatisfied &&
            input.outcomeEvaluation.executionQuality === 'successful',
        );
        const reasonCodes = new Set<string>(input.outcomeEvaluation?.reasonCodes ?? []);
        if (input.responseProduced && !outcomeVerified && input.taskAttempted) {
            reasonCodes.add('response_only_no_verified_outcome');
        }

        return {
            responseQuality: input.responseQuality,
            executionQuality,
            responseProduced: input.responseProduced,
            taskAttempted: input.taskAttempted,
            userVisibleCompletion: input.responseProduced,
            outcomeVerified,
            reasonCodes: Array.from(reasonCodes),
        };
    }
}
