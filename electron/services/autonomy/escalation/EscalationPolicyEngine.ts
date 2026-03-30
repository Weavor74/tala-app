/**
 * EscalationPolicyEngine.ts — Phase 5.1 P5.1C
 *
 * Deterministic policy engine for model escalation decisions.
 *
 * Given a task capability assessment (canHandle=false), this engine decides
 * whether escalation to a remote model is allowed under the active policy.
 *
 * Evaluation order (first applicable rule wins):
 *
 *   Rule 1: policy=local_only → deny escalation immediately
 *
 *   Rule 2: Spam guard — recentEscalationCount >= maxEscalationRequestsPerHour
 *     → deny escalation (anti-spam)
 *
 *   Rule 3: Insufficient local failures — recentLocalFailures < minLocalFailuresBeforeEscalation
 *     → deny escalation (not yet justified)
 *
 *   Rule 4: policy=remote_required_for_high_complexity AND high_complexity_task in reasons
 *     → allow escalation (forced for high-complexity)
 *
 *   Rule 5: policy=auto_escalate_for_allowed_classes AND task class in allowedTaskClasses
 *     → allow escalation
 *
 *   Rule 6: policy=remote_allowed OR local_preferred_with_request
 *     → allow escalation (with human approval if requireHumanApprovalForRemote=true)
 *
 *   Rule 7: fallback → deny escalation
 *
 * When escalation is allowed and requireHumanApprovalForRemote=true,
 * requiresHumanApproval=true in the decision, and the strategy selector
 * will route to 'escalate_human' instead of 'escalate_remote'.
 *
 * Design principle: DETERMINISTIC FIRST — same inputs → same result.
 * No model calls, no network I/O.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    TaskCapabilityAssessment,
    EscalationRequest,
    EscalationDecision,
    EscalationPolicy,
} from '../../../../shared/escalationTypes';

// ─── EscalationPolicyEngine ───────────────────────────────────────────────────

export class EscalationPolicyEngine {
    /**
     * Evaluates whether escalation is allowed for the given capability assessment.
     *
     * @param assessment              The capability assessment (must have canHandle=false).
     * @param policy                  The active escalation policy.
     * @param recentEscalationCount   Number of escalation requests in the current hour.
     * @param decompositionCooldownActive Whether a decomposition cooldown is active.
     * @returns { decision, request } — request is null when escalation is denied.
     */
    evaluate(
        assessment: TaskCapabilityAssessment,
        policy: EscalationPolicy,
        recentEscalationCount: number,
        decompositionCooldownActive: boolean,
    ): { decision: EscalationDecision; request: EscalationRequest | null } {
        const requestId = uuidv4();
        const decidedAt = new Date().toISOString();

        // ── Rule 1: local_only → always deny ───────────────────────────────────
        if (policy.policyKind === 'local_only') {
            return {
                request: null,
                decision: this._deny(
                    requestId,
                    assessment.goalId,
                    decidedAt,
                    'Escalation policy is local_only — remote escalation is not permitted.',
                ),
            };
        }

        // ── Rule 2: Spam guard ─────────────────────────────────────────────────
        if (recentEscalationCount >= policy.maxEscalationRequestsPerHour) {
            return {
                request: null,
                decision: this._deny(
                    requestId,
                    assessment.goalId,
                    decidedAt,
                    `Escalation spam guard: ${recentEscalationCount} requests in the current hour ` +
                    `(limit: ${policy.maxEscalationRequestsPerHour}).`,
                ),
            };
        }

        // ── Rule 3: Insufficient local failures ────────────────────────────────
        if (assessment.recentLocalFailures < policy.minLocalFailuresBeforeEscalation
            && !assessment.insufficiencyReasons.includes('recovery_pack_exhausted')) {
            return {
                request: null,
                decision: this._deny(
                    requestId,
                    assessment.goalId,
                    decidedAt,
                    `Insufficient local failures for escalation: ` +
                    `${assessment.recentLocalFailures} < ${policy.minLocalFailuresBeforeEscalation} ` +
                    `(recovery_pack_exhausted not triggered).`,
                ),
            };
        }

        // ── Rule 4: remote_required_for_high_complexity → force-allow ─────────
        if (
            policy.policyKind === 'remote_required_for_high_complexity'
            && assessment.insufficiencyReasons.includes('high_complexity_task')
        ) {
            const request = this._buildRequest(requestId, assessment);
            return {
                request,
                decision: this._allow(
                    requestId,
                    assessment.goalId,
                    decidedAt,
                    policy.requireHumanApprovalForRemote,
                    `Policy requires remote escalation for high-complexity tasks. ` +
                    `complexity=${assessment.complexityScore}`,
                ),
            };
        }

        // ── Rule 5: auto_escalate_for_allowed_classes ──────────────────────────
        if (policy.policyKind === 'auto_escalate_for_allowed_classes') {
            // Check if the goal's subsystem matches an allowed task class
            const subsystemInAllowed = policy.allowedTaskClasses.includes(
                assessment.goalId.split('-')[0] ?? '',
            );
            if (subsystemInAllowed) {
                const request = this._buildRequest(requestId, assessment);
                return {
                    request,
                    decision: this._allow(
                        requestId,
                        assessment.goalId,
                        decidedAt,
                        policy.requireHumanApprovalForRemote,
                        `Auto-escalation allowed for task class in allowedTaskClasses.`,
                    ),
                };
            }
            // Task class not in allowed list → deny
            return {
                request: null,
                decision: this._deny(
                    requestId,
                    assessment.goalId,
                    decidedAt,
                    'Task class is not in allowedTaskClasses for auto-escalation.',
                ),
            };
        }

        // ── Rule 6: remote_allowed or local_preferred_with_request ────────────
        if (
            policy.policyKind === 'remote_allowed'
            || policy.policyKind === 'local_preferred_with_request'
        ) {
            const request = this._buildRequest(requestId, assessment);
            return {
                request,
                decision: this._allow(
                    requestId,
                    assessment.goalId,
                    decidedAt,
                    policy.requireHumanApprovalForRemote,
                    `Escalation allowed under ${policy.policyKind} policy. ` +
                    `Reasons: ${assessment.insufficiencyReasons.join(', ')}`,
                ),
            };
        }

        // ── Rule 7: Fallback deny ──────────────────────────────────────────────
        return {
            request: null,
            decision: this._deny(
                requestId,
                assessment.goalId,
                decidedAt,
                `Escalation denied: policy kind '${policy.policyKind}' does not permit escalation ` +
                `under current conditions.`,
            ),
        };
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _allow(
        requestId: string,
        goalId: string,
        decidedAt: string,
        requiresHumanApproval: boolean,
        rationale: string,
    ): EscalationDecision {
        return {
            requestId,
            goalId,
            decidedAt,
            escalationAllowed: true,
            requiresHumanApproval,
            rationale,
        };
    }

    private _deny(
        requestId: string,
        goalId: string,
        decidedAt: string,
        denialReason: string,
    ): EscalationDecision {
        return {
            requestId,
            goalId,
            decidedAt,
            escalationAllowed: false,
            denialReason,
            requiresHumanApproval: false,
            rationale: denialReason,
        };
    }

    private _buildRequest(
        requestId: string,
        assessment: TaskCapabilityAssessment,
    ): EscalationRequest {
        return {
            requestId,
            goalId: assessment.goalId,
            requestedAt: new Date().toISOString(),
            insufficiencyReasons: [...assessment.insufficiencyReasons],
            rationale:
                `Escalation requested: model assessed as insufficient. ` +
                `Reasons: ${assessment.insufficiencyReasons.join(', ')}. ` +
                `complexity=${assessment.complexityScore}, ` +
                `recentFailures=${assessment.recentLocalFailures}`,
        };
    }
}
