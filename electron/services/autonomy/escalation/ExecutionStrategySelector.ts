/**
 * ExecutionStrategySelector.ts — Phase 5.1 P5.1E
 *
 * Deterministic strategy selector for model escalation and decomposition.
 *
 * Given a task capability assessment, an escalation decision, and an optional
 * decomposition plan, this selector returns the best execution strategy.
 *
 * Selection algorithm (first applicable rule wins):
 *
 *   Rule 1: canHandle=true → proceed_local
 *
 *   Rule 2: escalationAllowed AND !requiresHumanApproval → escalate_remote
 *
 *   Rule 3: escalationAllowed AND requiresHumanApproval → escalate_human
 *     (No silent remote escalation. Human approval is required by default.)
 *
 *   Rule 4: decompositionPlan available → decompose_local
 *
 *   Rule 5: any insufficiency reasons present → defer
 *     (Defer to next cycle — capability gap may resolve via updated model or pack)
 *
 *   Rule 6: fallback → escalate_human
 *     (Human review when no autonomous resolution is possible)
 *
 * CRITICAL: strategy escalate_remote is only returned when requiresHumanApproval=false.
 * By default (DEFAULT_ESCALATION_POLICY), requireHumanApprovalForRemote=true, so
 * escalate_remote is not reachable in default configuration (escalate_human is used instead).
 *
 * Design principle: DETERMINISTIC FIRST — same inputs → same result.
 */

import type {
    TaskCapabilityAssessment,
    EscalationDecision,
    DecompositionPlan,
    ExecutionStrategyDecision,
    EscalationStrategyKind,
    EscalationReasonCode,
    EscalationPolicy,
} from '../../../../shared/escalationTypes';

// ─── ExecutionStrategySelector ────────────────────────────────────────────────

export class ExecutionStrategySelector {
    /**
     * Selects an execution strategy given the assessment, escalation decision, and
     * optional decomposition plan.
     *
     * @param assessment         The capability assessment for the goal.
     * @param escalationDecision Escalation policy decision (null when not evaluated).
     * @param decompositionPlan  Decomposition plan (null when decomposition not possible).
     * @param policy             The active escalation policy.
     */
    select(
        assessment: TaskCapabilityAssessment,
        escalationDecision: EscalationDecision | null,
        decompositionPlan: DecompositionPlan | null,
        policy: EscalationPolicy,
    ): ExecutionStrategyDecision {
        const decidedAt = new Date().toISOString();

        // ── Rule 1: Model can handle → proceed locally ─────────────────────────
        if (assessment.canHandle) {
            return this._result(
                assessment.goalId, decidedAt, 'proceed_local',
                'Active model is assessed as capable of handling this goal locally.',
                ['model_can_handle', 'context_within_limit', 'no_recent_failures'],
                undefined, undefined,
            );
        }

        // ── Rule 2 & 3: Escalation allowed ────────────────────────────────────
        if (escalationDecision?.escalationAllowed) {
            if (!escalationDecision.requiresHumanApproval) {
                // Direct remote escalation (only when explicitly permitted without approval)
                return this._result(
                    assessment.goalId, decidedAt, 'escalate_remote',
                    `Escalation to remote model allowed without human approval. ` +
                    `Insufficiency: ${assessment.insufficiencyReasons.join(', ')}.`,
                    ['escalation_allowed_by_policy'],
                    undefined,
                    escalationDecision.requestId,
                );
            }
            // Human approval required for remote escalation
            return this._result(
                assessment.goalId, decidedAt, 'escalate_human',
                `Escalation to remote model requires human approval (governance). ` +
                `Insufficiency: ${assessment.insufficiencyReasons.join(', ')}.`,
                ['escalation_allowed_by_policy', 'escalation_requires_approval'],
                undefined,
                escalationDecision.requestId,
            );
        }

        // ── Rule 4: Decomposition available → decompose locally ────────────────
        if (decompositionPlan !== null) {
            const reasons = this._mapToReasonCodes(assessment);
            reasons.push('decomposition_possible');
            return this._result(
                assessment.goalId, decidedAt, 'decompose_local',
                `Local decomposition available (${decompositionPlan.totalSteps} steps, ` +
                `depth=${decompositionPlan.depth}). ` +
                `Escalation denied: ${escalationDecision?.denialReason ?? 'not evaluated'}.`,
                reasons,
                decompositionPlan.planId,
                undefined,
            );
        }

        // ── Rule 5: Insufficiency present but no resolution → defer ────────────
        if (assessment.insufficiencyReasons.length > 0) {
            const reasons = this._mapToReasonCodes(assessment);
            reasons.push('decomposition_not_possible');
            return this._result(
                assessment.goalId, decidedAt, 'defer',
                `Deferring goal: model insufficient, escalation denied, decomposition not possible. ` +
                `Insufficiency: ${assessment.insufficiencyReasons.join(', ')}.`,
                reasons,
                undefined, undefined,
            );
        }

        // ── Rule 6: Fallback → escalate to human ──────────────────────────────
        return this._result(
            assessment.goalId, decidedAt, 'escalate_human',
            'No autonomous resolution available. Routing to human review.',
            ['no_viable_strategy'],
            undefined, undefined,
        );
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _result(
        goalId: string,
        decidedAt: string,
        strategy: EscalationStrategyKind,
        reason: string,
        reasonCodes: EscalationReasonCode[],
        decompositionPlanId: string | undefined,
        escalationRequestId: string | undefined,
    ): ExecutionStrategyDecision {
        return {
            goalId,
            decidedAt,
            strategy,
            reason,
            reasonCodes,
            decompositionPlanId,
            escalationRequestId,
        };
    }

    /**
     * Maps assessment insufficiency reasons to EscalationReasonCodes.
     */
    private _mapToReasonCodes(assessment: TaskCapabilityAssessment): EscalationReasonCode[] {
        const codes: EscalationReasonCode[] = [];
        for (const r of assessment.insufficiencyReasons) {
            switch (r) {
                case 'context_size_exceeded':       codes.push('context_exceeded'); break;
                case 'repeated_local_failures':     codes.push('repeated_failures'); break;
                case 'high_complexity_task':        codes.push('high_complexity'); break;
                case 'multi_file_repair_scope':     codes.push('multi_file_scope'); break;
                case 'recovery_pack_exhausted':     codes.push('pack_exhausted'); break;
                case 'low_confidence_output':       codes.push('low_confidence'); break;
            }
        }
        return codes;
    }
}
