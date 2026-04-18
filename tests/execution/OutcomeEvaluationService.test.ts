import { describe, expect, it } from 'vitest';
import { OutcomeEvaluationService } from '../../electron/services/execution/OutcomeEvaluationService';
import type { PlanStageExecutionResult } from '../../shared/planning/PlanningTypes';
import type { SuccessCriterion } from '../../shared/planning/SuccessCriteriaTypes';
import type { StepCompletionEvidence } from '../../shared/execution/CompletionEvidenceTypes';

const service = new OutcomeEvaluationService();

function makeEvidence(overrides: Partial<StepCompletionEvidence> = {}): StepCompletionEvidence {
    return {
        stepId: 'stage-1',
        status: 'succeeded',
        validationPerformed: true,
        validationPassed: true,
        operatorInputRequired: false,
        artifacts: [],
        stateMutations: [],
        criterionResults: [],
        reasonCodes: ['required_criteria_satisfied'],
        ...overrides,
    };
}

function makeStageResult(overrides: Partial<PlanStageExecutionResult> = {}): PlanStageExecutionResult {
    return {
        stageId: 'stage-1',
        handoffType: 'tool',
        status: 'completed',
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
        reasonCodes: ['completed'],
        attempts: 1,
        completionEvidence: makeEvidence(),
        ...overrides,
    };
}

function criterion(type: SuccessCriterion['type'], id: string): SuccessCriterion {
    return {
        id,
        type,
        label: id,
        required: true,
        validationMethod: 'custom_rule',
    };
}

describe('OutcomeEvaluationService', () => {
    it('marks response-produced but unmet required criteria as non-successful', () => {
        const result = service.evaluatePlanOutcome({
            executionId: 'exec-1',
            planId: 'plan-1',
            criteria: [criterion('tool_result_validated', 'tool.validated')],
            stageResults: [makeStageResult({
                completionEvidence: makeEvidence({ validationPassed: false, reasonCodes: ['tool_result_invalid'] }),
            })],
            responseProduced: true,
            responseQuality: 'produced',
        });

        expect(result.responseProduced).toBe(true);
        expect(result.executionQuality).toBe('partial');
        expect(result.reasonCodes).toContain('response_only_no_verified_outcome');
    });

    it('keeps artifact validation unmet as non-successful', () => {
        const result = service.evaluatePlanOutcome({
            executionId: 'exec-2',
            planId: 'plan-2',
            criteria: [criterion('artifact_validated', 'artifact.validated')],
            stageResults: [makeStageResult({
                completionEvidence: makeEvidence({
                    artifacts: [{ id: 'a', artifactType: 'file', reference: '/tmp/a.txt', persisted: true, validated: false, reasonCodes: ['artifact_validation_failed'] }],
                }),
            })],
        });
        expect(result.executionQuality).not.toBe('successful');
        expect(result.reasonCodes).toContain('artifact_validation_failed');
    });

    it('marks search completed but not persisted as non-successful', () => {
        const result = service.evaluatePlanOutcome({
            executionId: 'exec-3',
            planId: 'plan-3',
            criteria: [criterion('search_results_persisted', 'search.persisted')],
            stageResults: [makeStageResult({
                completionEvidence: makeEvidence({
                    stateMutations: [{
                        mutationType: 'search_results',
                        attempted: true,
                        persisted: false,
                        reasonCodes: ['search_results_not_persisted'],
                    }],
                }),
            })],
        });
        expect(result.executionQuality).not.toBe('successful');
        expect(result.reasonCodes).toContain('search_results_not_persisted');
    });

    it('marks notebook updated and verified as successful when required criteria satisfied', () => {
        const result = service.evaluatePlanOutcome({
            executionId: 'exec-4',
            planId: 'plan-4',
            criteria: [criterion('notebook_updated', 'notebook.updated')],
            stageResults: [makeStageResult({
                completionEvidence: makeEvidence({
                    stateMutations: [{
                        mutationType: 'notebook',
                        targetRef: 'notes/main.md',
                        attempted: true,
                        persisted: true,
                        reasonCodes: ['notebook_update_verified'],
                    }],
                }),
            })],
        });
        expect(result.executionQuality).toBe('successful');
        expect(result.requiredCriteriaSatisfied).toBe(true);
    });

    it('marks memory write rejection as unmet criterion and non-successful', () => {
        const result = service.evaluatePlanOutcome({
            executionId: 'exec-5',
            planId: 'plan-5',
            criteria: [criterion('memory_updated', 'memory.updated')],
            stageResults: [makeStageResult({
                completionEvidence: makeEvidence({
                    status: 'failed',
                    stateMutations: [{
                        mutationType: 'memory',
                        attempted: true,
                        persisted: false,
                        rejected: true,
                        reasonCodes: ['memory_update_missing'],
                    }],
                }),
                status: 'failed',
            })],
        });
        expect(result.executionQuality).toBe('failed');
        expect(result.reasonCodes).toContain('memory_update_missing');
    });

    it('returns blocked when operator input is required', () => {
        const result = service.evaluatePlanOutcome({
            executionId: 'exec-6',
            planId: 'plan-6',
            criteria: [criterion('operator_response_recorded', 'operator.required')],
            stageResults: [makeStageResult({
                status: 'blocked',
                completionEvidence: makeEvidence({
                    status: 'requires_operator_input',
                    operatorInputRequired: true,
                }),
            })],
            responseProduced: true,
            responseQuality: 'produced',
        });
        expect(result.executionQuality).toBe('blocked');
        expect(result.reasonCodes).toContain('operator_input_required');
    });

    it('marks workflow completed with validated outputs as successful', () => {
        const result = service.evaluatePlanOutcome({
            executionId: 'exec-7',
            planId: 'plan-7',
            criteria: [
                criterion('workflow_completed', 'workflow.completed'),
                criterion('tool_result_validated', 'workflow.outputs.validated'),
            ],
            stageResults: [makeStageResult({
                handoffType: 'workflow',
                completionEvidence: makeEvidence({ validationPassed: true, validationPerformed: true }),
            })],
        });
        expect(result.executionQuality).toBe('successful');
        expect(result.requiredCriteriaSatisfied).toBe(true);
    });

    it('treats missing success-criteria contract as failed (no silent success)', () => {
        const result = service.evaluatePlanOutcome({
            executionId: 'exec-8',
            planId: 'plan-8',
            criteria: [],
            stageResults: [makeStageResult()],
        });
        expect(result.executionQuality).toBe('failed');
        expect(result.reasonCodes).toContain('missing_success_criteria_contract');
    });

    it('assesses chat-only turn as not_applicable execution quality', () => {
        const assessment = service.assessTurnCompletion({
            taskAttempted: false,
            responseProduced: true,
            responseQuality: 'produced',
        });
        expect(assessment.executionQuality).toBe('not_applicable');
        expect(assessment.responseQuality).toBe('produced');
    });
});

