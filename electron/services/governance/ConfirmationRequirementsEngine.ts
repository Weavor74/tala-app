/**
 * ConfirmationRequirementsEngine.ts — Phase 3.5 P3.5D
 *
 * Derives ConfirmationRequirement[] and EscalationRequirement[] from a
 * GovernanceEvaluationResult and proposal context.
 *
 * Design rules:
 * - No I/O, no async, no model calls.
 * - Deterministic: same evaluation result → same requirements.
 * - Each confirmation has a unique, stable ID based on proposalId + kind.
 * - Escalations are independent of confirmations.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    GovernanceEvaluationResult,
    ConfirmationRequirement,
    EscalationRequirement,
    ConfirmationKind,
    EscalationTrigger,
    AuthorityTier,
} from '../../../shared/governanceTypes';
import { tierRequiresHumanApproval, tierRequiresDualApproval } from './AuthorityTierModel';

// ─── ConfirmationRequirementsEngine ───────────────────────────────────────────

export class ConfirmationRequirementsEngine {

    /**
     * Derives confirmation requirements from a governance evaluation result.
     * Returns an array of unsatisfied ConfirmationRequirement records.
     */
    deriveConfirmations(
        result: GovernanceEvaluationResult,
        hasProtectedFiles: boolean,
    ): ConfirmationRequirement[] {
        const requirements: ConfirmationRequirement[] = [];
        const { proposalId, resolvedTier } = result;

        // Pre-execution manual confirmation: required for any human-review tier
        if (result.requiresManualConfirmation || tierRequiresHumanApproval(resolvedTier)) {
            requirements.push(
                this._makeConfirmation(
                    proposalId,
                    'pre_execution_manual',
                    'Manually review this proposal before execution proceeds.',
                ),
            );
        }

        // Protected file acknowledgement
        if (hasProtectedFiles) {
            requirements.push(
                this._makeConfirmation(
                    proposalId,
                    'protected_file_ack',
                    'This proposal targets one or more protected files. Acknowledge before proceeding.',
                ),
            );
        }

        // Dual approval acknowledgement
        if (tierRequiresDualApproval(resolvedTier)) {
            requirements.push(
                this._makeConfirmation(
                    proposalId,
                    'dual_approval_ack',
                    'This proposal requires two distinct approvals. Confirm that both have been obtained.',
                ),
            );
        }

        return requirements;
    }

    /**
     * Derives escalation requirements from a governance evaluation result.
     * Returns an array of unresolved EscalationRequirement records.
     */
    deriveEscalations(
        result: GovernanceEvaluationResult,
        hasProtectedFiles: boolean,
        isProtectedSubsystem: boolean,
    ): EscalationRequirement[] {
        const escalations: EscalationRequirement[] = [];
        const { proposalId, resolvedTier } = result;

        if (result.escalateOnVerificationFailure) {
            escalations.push(
                this._makeEscalation(
                    proposalId,
                    'verification_failure',
                    this._escalateTier(resolvedTier),
                    'Escalation will be triggered if post-execution verification fails.',
                ),
            );
        }

        if (isProtectedSubsystem) {
            escalations.push(
                this._makeEscalation(
                    proposalId,
                    'critical_subsystem',
                    'human_review_required',
                    'Proposal targets a protected subsystem — escalation is pre-registered.',
                ),
            );
        }

        if (hasProtectedFiles && resolvedTier !== 'blocked') {
            escalations.push(
                this._makeEscalation(
                    proposalId,
                    'protected_file',
                    'human_review_required',
                    'Proposal targets protected files — escalation is pre-registered.',
                ),
            );
        }

        return escalations;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _makeConfirmation(
        proposalId: string,
        kind: ConfirmationKind,
        promptText: string,
    ): ConfirmationRequirement {
        return {
            confirmationId: uuidv4(),
            proposalId,
            kind,
            promptText,
            required: true,
            satisfied: false,
        };
    }

    private _makeEscalation(
        proposalId: string,
        trigger: EscalationTrigger,
        requiredTierAfterEscalation: AuthorityTier,
        notes: string,
    ): EscalationRequirement {
        return {
            escalationId: uuidv4(),
            proposalId,
            trigger,
            requiredTierAfterEscalation,
            resolved: false,
            notes,
        };
    }

    /**
     * Determines the escalation tier: one step above the current tier.
     * Blocked → stays blocked. Everything else escalates one step.
     */
    private _escalateTier(tier: AuthorityTier): AuthorityTier {
        switch (tier) {
            case 'tala_self_low_risk':    return 'human_review_required';
            case 'tala_self_standard':    return 'human_review_required';
            case 'protected_subsystem':   return 'human_review_required';
            case 'human_review_required': return 'human_dual_approval';
            case 'human_dual_approval':   return 'emergency_manual_only';
            case 'emergency_manual_only': return 'blocked';
            case 'blocked':               return 'blocked';
            default:                      return 'human_review_required';
        }
    }
}
