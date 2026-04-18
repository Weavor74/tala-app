import type { ExecutionPlan, PlanExecutionResult } from '../../../shared/planning/PlanningTypes';
import type { PlanningLoopRun, LoopObservationResult } from '../../../shared/planning/planningLoopTypes';
import type { ILoopObserver } from './PlanningLoopService';
import type { AgentTurnOutput } from '../../types/artifacts';

export class ChatLoopObserver implements ILoopObserver {
    async observe(
        rawResult: unknown,
        _plan: ExecutionPlan,
        _loopRun: Readonly<PlanningLoopRun>,
    ): Promise<LoopObservationResult> {
        if (this._isPlanExecutionResult(rawResult)) {
            if (rawResult.status === 'failed') {
                return {
                    outcome: 'failed',
                    goalSatisfied: false,
                    reasonCodes: rawResult.reasonCodes.length > 0
                        ? rawResult.reasonCodes
                        : ['plan_execution_failed'],
                };
            }
            if (rawResult.status === 'degraded' || rawResult.status === 'partial') {
                return {
                    outcome: 'partial',
                    goalSatisfied: false,
                    reasonCodes: rawResult.reasonCodes.length > 0
                        ? rawResult.reasonCodes
                        : ['plan_execution_partial'],
                };
            }
            return {
                outcome: 'succeeded',
                goalSatisfied: true,
                reasonCodes: rawResult.reasonCodes.length > 0
                    ? rawResult.reasonCodes
                    : ['plan_execution_completed'],
            };
        }

        if (!rawResult || typeof rawResult !== 'object') {
            return {
                outcome: 'failed',
                goalSatisfied: false,
                reasonCodes: ['chat_result_invalid:not_an_object'],
            };
        }

        const turn = rawResult as Partial<AgentTurnOutput>;
        if (turn.suppressChatContent === true) {
            return {
                outcome: 'succeeded',
                goalSatisfied: true,
                reasonCodes: ['chat_result:suppressed_content_turn'],
            };
        }

        const hasMessage = typeof turn.message === 'string' && turn.message.trim().length > 0;
        if (hasMessage) {
            return {
                outcome: 'succeeded',
                goalSatisfied: true,
                reasonCodes: ['chat_result:message_produced'],
            };
        }

        return {
            outcome: 'failed',
            goalSatisfied: false,
            reasonCodes: ['chat_result_invalid:empty_message'],
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
