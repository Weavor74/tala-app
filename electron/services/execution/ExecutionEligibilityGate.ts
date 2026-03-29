/**
 * ExecutionEligibilityGate.ts — Phase 3 P3B
 *
 * Determines whether execution may begin for a given promoted proposal.
 *
 * All checks are deterministic and synchronous — no model calls, no file I/O.
 * A single failed check blocks execution with a human-readable reason.
 *
 * Checks (in order):
 *   1. proposal_status        — proposal must be 'promoted'
 *   2. proposal_freshness     — not stale beyond MAX_PROPOSAL_AGE_MS
 *   3. subsystem_lock         — no active execution for this subsystem
 *   4. cooldown               — subsystem not in post-execution cooldown
 *   5. required_fields        — targetFiles, changes, verificationRequirements present
 *   6. invariant_refs         — all threatened invariant IDs still exist
 *   7. rollback_plan_present  — rollbackSteps non-empty or no_rollback_needed
 *   8. verification_plan      — at least one verification requirement present
 *   9. authorization          — valid ExecutionAuthorization present
 */

import type {
    ExecutionAuthorization,
    ExecutionEligibilityCheck,
    ExecutionEligibilityCheckName,
    ExecutionEligibilityResult,
} from '../../../shared/executionTypes';
import type { SafeChangeProposal } from '../../../shared/reflectionPlanTypes';
import type { ExecutionRunRegistry } from './ExecutionRunRegistry';
import { telemetry } from '../TelemetryService';

// ─── Governance Authorization Provider interface ───────────────────────────────

/**
 * Thin interface for the governance authorization gate injected into the eligibility gate.
 * Keeping this as a minimal interface maintains testability without importing
 * the full ExecutionAuthorizationGate.
 */
export interface GovernanceAuthorizationProvider {
    canExecute(proposalId: string): { authorized: boolean; reason: string; decisionId?: string };
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Proposals older than this are considered stale. Default: 7 days. */
const MAX_PROPOSAL_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ─── ExecutionEligibilityGate ─────────────────────────────────────────────────

export class ExecutionEligibilityGate {
    constructor(
        private readonly registry: ExecutionRunRegistry,
        private readonly maxProposalAgeMs = MAX_PROPOSAL_AGE_MS,
        /** Optional governance provider. When absent, check 10 is skipped (backward-compat). */
        private readonly governanceProvider?: GovernanceAuthorizationProvider,
    ) {}

    /**
     * Evaluates all eligibility checks for the given proposal + authorization.
     *
     * Fail-fast: returns on the first failed check.
     * Returns a fully-structured result suitable for audit + UI display.
     */
    evaluate(
        proposal: SafeChangeProposal,
        authorization: ExecutionAuthorization,
        knownInvariantIds: string[],
    ): ExecutionEligibilityResult {
        const checks: ExecutionEligibilityCheck[] = [];
        const checkedAt = new Date().toISOString();

        const fail = (
            name: ExecutionEligibilityCheckName,
            detail: string,
        ): ExecutionEligibilityResult => {
            checks.push({ name, passed: false, detail });
            telemetry.operational(
                'execution',
                `execution.eligibility.failed.${name}`,
                'warn',
                'ExecutionEligibilityGate',
                `Eligibility blocked for proposal ${proposal.proposalId}: ${detail}`,
            );
            return {
                eligible: false,
                checkedAt,
                checks,
                blockedBy: name,
                message: `Execution blocked: ${detail}`,
            };
        };

        const pass = (name: ExecutionEligibilityCheckName): void => {
            checks.push({ name, passed: true });
        };

        // ── Check 1: proposal_status ────────────────────────────────────────────
        if (proposal.status !== 'promoted') {
            return fail(
                'proposal_status',
                `Proposal is '${proposal.status}' — only 'promoted' proposals may execute`,
            );
        }
        pass('proposal_status');

        // ── Check 2: proposal_freshness ─────────────────────────────────────────
        const ageMs = Date.now() - new Date(proposal.createdAt).getTime();
        if (ageMs > this.maxProposalAgeMs) {
            const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
            return fail(
                'proposal_freshness',
                `Proposal is ${ageDays} day(s) old — exceeds freshness limit; replan required`,
            );
        }
        pass('proposal_freshness');

        // ── Check 3: subsystem_lock ─────────────────────────────────────────────
        if (this.registry.isSubsystemLocked(proposal.targetSubsystem)) {
            const active = this.registry.getActiveRun(proposal.targetSubsystem);
            return fail(
                'subsystem_lock',
                `Subsystem '${proposal.targetSubsystem}' already has an active execution` +
                    (active ? ` (executionId: ${active.executionId})` : ''),
            );
        }
        pass('subsystem_lock');

        // ── Check 4: cooldown ───────────────────────────────────────────────────
        if (this.registry.isInCooldown(proposal.targetSubsystem)) {
            const cd = this.registry.getCooldown(proposal.targetSubsystem);
            const remainingMin = cd ? Math.ceil((cd.expiresAt - Date.now()) / 60_000) : 0;
            return fail(
                'cooldown',
                `Subsystem '${proposal.targetSubsystem}' is in post-execution cooldown` +
                    ` (${remainingMin} min remaining) — wait before re-executing`,
            );
        }
        pass('cooldown');

        // ── Check 5: required_fields ────────────────────────────────────────────
        if (!proposal.targetFiles || proposal.targetFiles.length === 0) {
            return fail('required_fields', 'Proposal has no targetFiles');
        }
        if (!proposal.changes || proposal.changes.length === 0) {
            return fail('required_fields', 'Proposal has no changes');
        }
        if (!proposal.verificationRequirements) {
            return fail('required_fields', 'Proposal missing verificationRequirements');
        }
        if (!proposal.rollbackClassification) {
            return fail('required_fields', 'Proposal missing rollbackClassification');
        }
        pass('required_fields');

        // ── Check 6: invariant_refs ─────────────────────────────────────────────
        if (proposal.blastRadius?.threatenedInvariantIds?.length) {
            const known = new Set(knownInvariantIds);
            const missing = proposal.blastRadius.threatenedInvariantIds.filter(id => !known.has(id));
            if (missing.length > 0) {
                return fail(
                    'invariant_refs',
                    `Invariant(s) no longer registered: ${missing.join(', ')} — replan required`,
                );
            }
        }
        pass('invariant_refs');

        // ── Check 7: rollback_plan_present ──────────────────────────────────────
        const strategy = proposal.rollbackClassification.strategy;
        const steps = proposal.rollbackClassification.rollbackSteps ?? [];
        if (strategy !== 'no_rollback_needed' && steps.length === 0) {
            return fail(
                'rollback_plan_present',
                'Rollback plan has no steps (strategy requires steps)',
            );
        }
        pass('rollback_plan_present');

        // ── Check 8: verification_plan ──────────────────────────────────────────
        const vr = proposal.verificationRequirements;
        const hasAnyVerification =
            vr.requiresBuild ||
            vr.requiresTypecheck ||
            vr.requiresLint ||
            vr.requiredTests.length > 0 ||
            vr.smokeChecks.length > 0;
        if (!hasAnyVerification) {
            return fail(
                'verification_plan',
                'Proposal has no verification requirements — execution requires at least one check',
            );
        }
        pass('verification_plan');

        // ── Check 9: authorization ──────────────────────────────────────────────
        if (!authorization.authorizationToken) {
            return fail('authorization', 'Authorization token missing');
        }
        if (authorization.proposalStatus !== 'promoted') {
            return fail(
                'authorization',
                `Authorization was issued for proposal status '${authorization.proposalStatus}', not 'promoted'`,
            );
        }
        pass('authorization');

        // ── Check 10: governance_approval (P3.5G) ───────────────────────────────
        // Only evaluated when a governance provider is configured.
        // When absent (e.g., in tests without governance), this check is skipped.
        if (this.governanceProvider) {
            const govResult = this.governanceProvider.canExecute(proposal.proposalId);
            if (!govResult.authorized) {
                return fail(
                    'governance_approval',
                    `Governance gate blocked execution: ${govResult.reason}`,
                );
            }
            pass('governance_approval');
        }

        telemetry.operational(
            'execution',
            'execution.eligibility.passed',
            'debug',
            'ExecutionEligibilityGate',
            `All eligibility checks passed for proposal ${proposal.proposalId}`,
        );

        return {
            eligible: true,
            checkedAt,
            checks,
            message: 'All eligibility checks passed — execution is permitted',
        };
    }
}
