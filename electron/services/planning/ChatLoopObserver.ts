/**
 * ChatLoopObserver.ts — ILoopObserver implementation for chat-based execution
 *
 * Evaluates the raw result produced by ChatLoopExecutor (an AgentTurnOutput)
 * and returns a structured LoopObservationResult that PlanningLoopService uses
 * for its OBSERVE → decision step.
 *
 * Design invariants
 * ─────────────────
 * 1. Pure — no I/O, no DB, no telemetry emission.
 * 2. Deterministic — same AgentTurnOutput always produces the same observation.
 * 3. Conservative — an unrecognised raw result is treated as `failed`.
 * 4. Chat turns that produce a message are considered `succeeded` + `goalSatisfied`.
 *    The loop therefore completes in a single iteration for normal chat turns.
 * 5. Suppressed-content turns (suppressChatContent=true) are treated as succeeded
 *    to avoid spurious replanning on background operations.
 */

import type { ExecutionPlan } from '../../../shared/planning/PlanningTypes';
import type { PlanningLoopRun, LoopObservationResult } from '../../../shared/planning/planningLoopTypes';
import type { ILoopObserver } from './PlanningLoopService';
import type { AgentTurnOutput } from '../../types/artifacts';

// ─── ChatLoopObserver ─────────────────────────────────────────────────────────

/**
 * ILoopObserver that evaluates AgentTurnOutput from the chat pipeline.
 *
 * For standard chat turns, a non-empty message response is treated as a
 * successful, goal-satisfying result.  This drives the loop to completion
 * after one iteration.
 *
 * Error conditions, empty responses, or non-AgentTurnOutput raw results
 * are classified as 'failed' to allow the loop to apply its replan policy.
 */
export class ChatLoopObserver implements ILoopObserver {
    /**
     * Observes the raw execution result and returns a structured observation.
     *
     * @param rawResult  - Value returned by ChatLoopExecutor.executePlan().
     * @param _plan      - The plan that was executed (not used for chat turns).
     * @param _loopRun   - Current loop run state (not used for chat turns).
     */
    async observe(
        rawResult: unknown,
        _plan: ExecutionPlan,
        _loopRun: Readonly<PlanningLoopRun>,
    ): Promise<LoopObservationResult> {
        // ── Non-AgentTurnOutput result ───────────────────────────────────────
        if (!rawResult || typeof rawResult !== 'object') {
            return {
                outcome: 'failed',
                goalSatisfied: false,
                reasonCodes: ['chat_result_invalid:not_an_object'],
            };
        }

        const turn = rawResult as Partial<AgentTurnOutput>;

        // ── Suppressed-content turn ──────────────────────────────────────────
        // Background operations that intentionally suppress chat content are
        // treated as succeeded; no replan is warranted.
        if (turn.suppressChatContent === true) {
            return {
                outcome: 'succeeded',
                goalSatisfied: true,
                reasonCodes: ['chat_result:suppressed_content_turn'],
            };
        }

        // ── Successful chat turn ─────────────────────────────────────────────
        // A non-empty message response means the chat pipeline completed normally.
        const hasMessage = typeof turn.message === 'string' && turn.message.trim().length > 0;
        if (hasMessage) {
            return {
                outcome: 'succeeded',
                goalSatisfied: true,
                reasonCodes: ['chat_result:message_produced'],
            };
        }

        // ── Empty message ────────────────────────────────────────────────────
        // No message and no suppressed-content flag is treated as a failure to
        // allow the loop to apply its replan policy.
        return {
            outcome: 'failed',
            goalSatisfied: false,
            reasonCodes: ['chat_result_invalid:empty_message'],
        };
    }
}
