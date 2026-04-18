import type { ExecutionPlan, PlanExecutionResult } from '../../../shared/planning/PlanningTypes';
import type { PlanningLoopRun, LoopObservationResult } from '../../../shared/planning/planningLoopTypes';
import type { ILoopObserver } from './PlanningLoopService';
import type { AgentTurnOutput } from '../../types/artifacts';
import type { ResponseQuality } from '../../../shared/execution/CompletionEvidenceTypes';
import { OutcomeEvaluationService } from '../execution/OutcomeEvaluationService';
import { TelemetryBus } from '../telemetry/TelemetryBus';

export class ChatLoopObserver implements ILoopObserver {
    private readonly _outcomeEvaluator = new OutcomeEvaluationService();
    private readonly _bus = TelemetryBus.getInstance();

    async observe(
        rawResult: unknown,
        plan: ExecutionPlan,
        loopRun: Readonly<PlanningLoopRun>,
    ): Promise<LoopObservationResult> {
        if (this._isPlanExecutionResult(rawResult)) {
            const outcomeEvaluation = rawResult.outcomeEvaluation
                ?? this._outcomeEvaluator.evaluatePlanOutcome({
                    executionId: rawResult.executionBoundaryId ?? plan.executionBoundaryId ?? loopRun.loopId,
                    planId: rawResult.planId,
                    criteria: plan.successCriteriaContract,
                    stageResults: rawResult.stageResults,
                    responseProduced: false,
                    responseQuality: 'not_produced',
                });
            const responseQuality: ResponseQuality = 'produced';
            const turnCompletionAssessment = this._outcomeEvaluator.assessTurnCompletion({
                taskAttempted: true,
                responseProduced: true,
                responseQuality,
                outcomeEvaluation: {
                    ...outcomeEvaluation,
                    responseProduced: true,
                    responseQuality,
                },
            });
            this._bus.emit({
                executionId: loopRun.loopId,
                subsystem: 'planning',
                event: 'planning.turn_completion_assessed',
                payload: {
                    loopId: loopRun.loopId,
                    planId: rawResult.planId,
                    executionBoundaryId: rawResult.executionBoundaryId,
                    responseProduced: turnCompletionAssessment.responseProduced,
                    responseQuality: turnCompletionAssessment.responseQuality,
                    executionQuality: turnCompletionAssessment.executionQuality,
                    taskAttempted: turnCompletionAssessment.taskAttempted,
                    outcomeVerified: turnCompletionAssessment.outcomeVerified,
                    criteriaSatisfiedCount: outcomeEvaluation.criteriaSatisfiedCount,
                    criteriaUnmetCount: outcomeEvaluation.criteriaUnmetCount,
                    unmetRequiredCriteria: outcomeEvaluation.unmetRequiredCriteria,
                    reasonCodes: turnCompletionAssessment.reasonCodes,
                },
            });

            if (turnCompletionAssessment.executionQuality === 'failed') {
                return {
                    outcome: 'failed',
                    goalSatisfied: false,
                    reasonCodes: turnCompletionAssessment.reasonCodes,
                    artifacts: { turnCompletionAssessment },
                };
            }
            if (
                turnCompletionAssessment.executionQuality === 'partial' ||
                turnCompletionAssessment.executionQuality === 'blocked'
            ) {
                return {
                    outcome: turnCompletionAssessment.executionQuality === 'blocked' ? 'blocked' : 'partial',
                    goalSatisfied: false,
                    reasonCodes: turnCompletionAssessment.reasonCodes,
                    artifacts: { turnCompletionAssessment },
                };
            }
            return {
                outcome: 'succeeded',
                goalSatisfied: true,
                reasonCodes: turnCompletionAssessment.reasonCodes,
                artifacts: { turnCompletionAssessment },
            };
        }

        if (!rawResult || typeof rawResult !== 'object') {
            const turnCompletionAssessment = this._outcomeEvaluator.assessTurnCompletion({
                taskAttempted: false,
                responseProduced: false,
                responseQuality: 'not_produced',
            });
            return {
                outcome: 'failed',
                goalSatisfied: false,
                reasonCodes: ['chat_result_invalid:not_an_object', ...turnCompletionAssessment.reasonCodes],
                artifacts: { turnCompletionAssessment },
            };
        }

        const turn = rawResult as Partial<AgentTurnOutput>;
        if (turn.suppressChatContent === true) {
            const turnCompletionAssessment = this._outcomeEvaluator.assessTurnCompletion({
                taskAttempted: false,
                responseProduced: true,
                responseQuality: 'suppressed',
            });
            return {
                outcome: 'succeeded',
                goalSatisfied: true,
                reasonCodes: ['chat_result:suppressed_content_turn'],
                artifacts: { turnCompletionAssessment },
            };
        }

        const hasMessage = typeof turn.message === 'string' && turn.message.trim().length > 0;
        if (hasMessage) {
            const turnCompletionAssessment = this._outcomeEvaluator.assessTurnCompletion({
                taskAttempted: false,
                responseProduced: true,
                responseQuality: 'produced',
            });
            return {
                outcome: 'succeeded',
                goalSatisfied: true,
                reasonCodes: ['chat_result:message_produced'],
                artifacts: { turnCompletionAssessment },
            };
        }

        const turnCompletionAssessment = this._outcomeEvaluator.assessTurnCompletion({
            taskAttempted: false,
            responseProduced: false,
            responseQuality: 'empty',
        });
        return {
            outcome: 'failed',
            goalSatisfied: false,
            reasonCodes: ['chat_result_invalid:empty_message', ...turnCompletionAssessment.reasonCodes],
            artifacts: { turnCompletionAssessment },
        };
    }

    private _isPlanExecutionResult(rawResult: unknown): rawResult is PlanExecutionResult {
        if (!rawResult || typeof rawResult !== 'object') return false;
        const candidate = rawResult as Partial<PlanExecutionResult>;
        return typeof candidate.planId === 'string'
            && typeof candidate.status === 'string'
            && Array.isArray(candidate.stageResults);
    }
}
