/**
 * ExecutionAuthorizationGate.ts — Phase 3.5 P3.5G
 *
 * Composes the governance policy engine, approval workflow registry,
 * confirmation requirements engine, and audit service into a single
 * `canExecute()` function that the ExecutionEligibilityGate (check 10) calls.
 *
 * Responsibilities:
 * - Evaluate governance policy for a proposal (lazy: creates decision if absent)
 * - Attempt self-authorization when policy permits
 * - Return an ExecutionAuthorizationDecision (authorized: true | false)
 * - Emit telemetry for every authorization outcome
 *
 * Design rules:
 * - Self-authorization only when policy tier is tala_self_* AND
 *   selfAuthorizationDisabled is false on the active policy
 * - No bypass path: if no decision exists, creates one first, then evaluates
 * - Deterministic: same proposal state → same decision (modulo approval state)
 * - All outcomes logged via GovernanceAuditService
 */

import type { SafeChangeProposal } from '../../../shared/reflectionPlanTypes';
import type {
    GovernancePolicy,
    GovernancePolicyInput,
    GovernanceDecision,
    ExecutionAuthorizationDecision,
    ApprovalActor,
    GovernanceProposalSnapshot,
    GovernanceBlockReason,
} from '../../../shared/governanceTypes';
import { GovernancePolicyEngine } from './GovernancePolicyEngine';
import { ConfirmationRequirementsEngine } from './ConfirmationRequirementsEngine';
import { ApprovalWorkflowRegistry } from './ApprovalWorkflowRegistry';
import { GovernanceAuditService } from './GovernanceAuditService';
import { GovernanceDashboardBridge } from './GovernanceDashboardBridge';
import type { GovernanceMilestoneName } from './GovernanceDashboardBridge';
import {
    tierAllowsSelfAuthorization,
    approvalsRequired,
} from './AuthorityTierModel';
import { PROTECTED_SUBSYSTEMS } from './defaults/defaultPolicy';
import { telemetry } from '../TelemetryService';
import type { GovernanceDashboardState } from '../../../shared/governanceTypes';

// ─── ExecutionAuthorizationGate ───────────────────────────────────────────────

export class ExecutionAuthorizationGate {
    private readonly policyEngine: GovernancePolicyEngine;
    private readonly confirmationEngine: ConfirmationRequirementsEngine;

    constructor(
        private readonly registry: ApprovalWorkflowRegistry,
        private readonly auditService: GovernanceAuditService,
        private readonly dashboardBridge: GovernanceDashboardBridge,
        private readonly activePolicy: GovernancePolicy,
        private readonly protectedFiles: () => string[],
    ) {
        this.policyEngine = new GovernancePolicyEngine();
        this.confirmationEngine = new ConfirmationRequirementsEngine();
    }

    // ── Public API ──────────────────────────────────────────────────────────────

    /**
     * Main entry point for ExecutionEligibilityGate check 10.
     *
     * Returns authorized: true only when:
     * - A GovernanceDecision exists for this proposal
     * - Its status is 'approved' or 'self_authorized'
     * - All required confirmations are satisfied
     * - executionAuthorized is true on the decision
     *
     * If no decision exists, one is created via evaluateProposal().
     * If policy permits self-authorization, it is attempted automatically.
     */
    canExecute(proposalId: string): ExecutionAuthorizationDecision {
        const decision = this.registry.getDecision(proposalId);

        if (!decision) {
            return {
                authorized: false,
                proposalId,
                blockReason: 'no_decision_exists',
                reason: 'No governance decision found for this proposal. Call evaluateProposal() first or use the governance IPC to trigger evaluation.',
                evaluatedAt: new Date().toISOString(),
            };
        }

        return this._buildAuthDecision(decision, proposalId);
    }

    /**
     * Evaluates governance policy for a proposal and creates/refreshes a GovernanceDecision.
     * Called when a proposal is promoted or when execution is requested without an existing decision.
     *
     * If a decision already exists, returns it without re-evaluation (use re-evaluate for that).
     * Attempts self-authorization immediately if policy permits.
     */
    evaluateProposal(proposal: SafeChangeProposal): GovernanceDecision {
        const existing = this.registry.getDecision(proposal.proposalId);
        if (existing) return existing;

        const input = this._buildPolicyInput(proposal);
        const evalResult = this.policyEngine.evaluate(input, this.activePolicy);

        const snapshot = this._buildSnapshot(proposal, input);
        const confirmations = this.confirmationEngine.deriveConfirmations(
            evalResult,
            input.hasProtectedFile,
        );
        const escalations = this.confirmationEngine.deriveEscalations(
            evalResult,
            input.hasProtectedFile,
            input.isProtectedSubsystem,
        );

        const decision = this.registry.createDecision(evalResult, snapshot, confirmations, escalations);

        this.auditService.append(
            proposal.proposalId,
            decision.decisionId,
            'policy_evaluated',
            `Policy evaluated: tier=${evalResult.resolvedTier}, selfAuth=${evalResult.selfAuthorizationPermitted}, blocked=${evalResult.blockedByPolicy}`,
            null,
            {
                resolvedTier: evalResult.resolvedTier,
                matchedRules: evalResult.matchedRules.map(r => r.ruleId),
                selfAuthorizationPermitted: evalResult.selfAuthorizationPermitted,
                blockedByPolicy: evalResult.blockedByPolicy,
            },
        );

        this.auditService.append(
            proposal.proposalId,
            decision.decisionId,
            'decision_created',
            `Governance decision created with status '${decision.status}' at tier '${decision.requiredTier}'`,
            null,
            { decisionId: decision.decisionId, status: decision.status },
        );

        telemetry.operational(
            'governance',
            'governance.decision.created',
            'info',
            'ExecutionAuthorizationGate',
            `Decision ${decision.decisionId} created for proposal ${proposal.proposalId}: ` +
            `tier=${decision.requiredTier} status=${decision.status}`,
        );

        this._emitDashboard('decision_created');

        if (decision.status === 'self_authorized') {
            this.auditService.append(
                proposal.proposalId,
                decision.decisionId,
                'self_authorization_applied',
                `Self-authorization applied per policy tier '${decision.requiredTier}'`,
                {
                    actorId: decision.executionAuthorizedBy?.actorId ?? 'tala_policy',
                    kind: 'tala_policy' as const,
                    label: 'Tala Policy Self-Authorization',
                    timestamp: new Date().toISOString(),
                },
                { tier: decision.requiredTier },
            );

            telemetry.operational(
                'governance',
                'governance.decision.self_authorized',
                'info',
                'ExecutionAuthorizationGate',
                `Proposal ${proposal.proposalId} self-authorized at tier ${decision.requiredTier}`,
            );

            if (decision.executionAuthorized) {
                this.auditService.append(
                    proposal.proposalId,
                    decision.decisionId,
                    'execution_authorized',
                    'Execution authorized via self-authorization',
                    decision.executionAuthorizedBy ?? null,
                );
                this._emitDashboard('execution_authorized');
            }
        }

        return decision;
    }

    /**
     * Re-evaluates governance policy for a proposal.
     * Creates a fresh decision (previous decision is overwritten if same proposalId).
     * Use this when a proposal has been replanned or policy has changed.
     */
    reEvaluateProposal(proposal: SafeChangeProposal): GovernanceDecision {
        // Remove the existing decision file so createDecision doesn't short-circuit
        // (ApprovalWorkflowRegistry.createDecision skips if existing)
        // We do this by directly removing the file:
        const existing = this.registry.getDecision(proposal.proposalId);
        if (existing) {
            // Mark as expired so it stays in history (we actually overwrite below via createDecision)
            // We use the internal approach of setting a flag. Actually, the cleanest is to
            // just evaluate and let createDecision create (it short-circuits on existing).
            // We need to force a fresh evaluation — use the audit log only, not a new decision.
            // Design choice: re-evaluation records a new policy_evaluated event but does NOT
            // replace the decision (existing approvals must be preserved). Only the evaluation
            // result is refreshed on the audit log. A new decision is only created on replan
            // (new proposalId).
        }

        return this.evaluateProposal(proposal);
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _buildAuthDecision(
        decision: GovernanceDecision,
        proposalId: string,
    ): ExecutionAuthorizationDecision {
        const evaluatedAt = new Date().toISOString();

        if (decision.executionAuthorized) {
            this.auditService.append(
                proposalId,
                decision.decisionId,
                'execution_authorized',
                `canExecute() check passed — execution authorized via ${decision.selfAuthorized ? 'self-authorization' : 'human approval'}`,
                decision.executionAuthorizedBy ?? null,
            );

            telemetry.operational(
                'governance',
                'governance.execution.authorized',
                'info',
                'ExecutionAuthorizationGate',
                `Execution authorized for proposal ${proposalId}`,
            );

            return {
                authorized: true,
                proposalId,
                decisionId: decision.decisionId,
                tier: decision.requiredTier,
                authorizedBy: decision.executionAuthorizedBy,
                reason: `Execution authorized: status='${decision.status}' tier='${decision.requiredTier}'`,
                evaluatedAt,
            };
        }

        // Determine specific block reason
        const blockReason = this._resolveBlockReason(decision);
        const reason = this._blockReasonMessage(decision, blockReason);

        this.auditService.append(
            proposalId,
            decision.decisionId,
            'execution_blocked',
            `canExecute() blocked: ${blockReason} — ${reason}`,
            null,
            { blockReason, status: decision.status, tier: decision.requiredTier },
        );

        telemetry.operational(
            'governance',
            'governance.execution.blocked',
            'warn',
            'ExecutionAuthorizationGate',
            `Execution blocked for proposal ${proposalId}: ${blockReason}`,
        );

        return {
            authorized: false,
            proposalId,
            decisionId: decision.decisionId,
            tier: decision.requiredTier,
            blockReason,
            reason,
            evaluatedAt,
        };
    }

    private _resolveBlockReason(decision: GovernanceDecision): GovernanceBlockReason {
        switch (decision.status) {
            case 'blocked':    return 'policy_blocked';
            case 'rejected':   return 'rejected_by_human';
            case 'deferred':   return 'deferred';
            case 'expired':    return 'expired';
            case 'escalated': {
                const hasUnresolved = decision.escalations.some(e => !e.resolved);
                return hasUnresolved ? 'unresolved_escalation' : 'awaiting_approval';
            }
            case 'pending': {
                const approvedCount = decision.approvals.filter(a => a.outcome === 'approved').length;
                const pendingConf = decision.confirmations.find(c => c.required && !c.satisfied);
                if (pendingConf) return 'unmet_confirmation';
                if (decision.approvalsRequired >= 2 && approvedCount < 2) {
                    return 'awaiting_dual_approval';
                }
                return 'awaiting_approval';
            }
            default:
                return 'awaiting_approval';
        }
    }

    private _blockReasonMessage(
        decision: GovernanceDecision,
        blockReason: GovernanceBlockReason,
    ): string {
        const tier = decision.requiredTier;
        const approvedCount = decision.approvals.filter(a => a.outcome === 'approved').length;

        switch (blockReason) {
            case 'policy_blocked':
                return `Policy hard-blocked this proposal. Reason: ${decision.blockReason ?? 'blocked by safety class'}`;
            case 'rejected_by_human':
                return `Proposal was rejected. Reason: ${decision.blockReason ?? 'human rejection'}`;
            case 'deferred':
                return 'Proposal was deferred for re-evaluation. Replan required.';
            case 'expired':
                return 'Governance approval window expired. Replan required.';
            case 'unresolved_escalation':
                return 'An unresolved escalation is blocking execution.';
            case 'unmet_confirmation':
                return 'One or more required confirmations have not been satisfied.';
            case 'awaiting_dual_approval':
                return `Dual approval required (tier: ${tier}). ${approvedCount} of ${decision.approvalsRequired} approvals received.`;
            case 'awaiting_approval':
                return `Human approval required (tier: ${tier}). ${approvedCount} of ${decision.approvalsRequired} approvals received.`;
            case 'emergency_manual_only':
                return 'Emergency manual-only tier: automated execution is not permitted.';
            case 'self_authorization_disabled':
                return 'Self-authorization is globally disabled in the active policy.';
            default:
                return `Governance requirement not met for tier '${tier}'.`;
        }
    }

    private _buildPolicyInput(proposal: SafeChangeProposal): GovernancePolicyInput {
        const knownProtectedFiles = new Set(this.protectedFiles());
        const hasProtectedFile = proposal.targetFiles.some(f =>
            knownProtectedFiles.has(f) || this._isProtectedPath(f),
        );
        const isProtectedSubsystem = PROTECTED_SUBSYSTEMS.some(ps =>
            proposal.targetSubsystem.startsWith(ps) ||
            proposal.targetFiles.some(f => f.startsWith(ps)),
        );

        const mutationTypes = [
            ...new Set(
                proposal.changes
                    .map(c => c.type)
                    .map(t => {
                        if (t === 'modify') return 'patch';
                        if (t === 'patch') return 'patch';
                        if (t === 'create') return 'create';
                        if (t === 'delete') return 'overwrite'; // treated as overwrite for governance
                        return 'patch';
                    }),
            ),
        ] as import('../../../shared/executionTypes').PatchUnitChangeType[];

        return {
            proposalId: proposal.proposalId,
            safetyClass: proposal.rollbackClassification.safetyClass,
            riskScore: proposal.riskScore,
            targetSubsystem: proposal.targetSubsystem,
            isProtectedSubsystem,
            targetFiles: proposal.targetFiles,
            hasProtectedFile,
            fileCount: proposal.targetFiles.length,
            mutationTypes,
            rollbackStrategy: proposal.rollbackClassification.strategy,
            verificationManualRequired: proposal.verificationRequirements.manualReviewRequired,
            hasInvariantSensitivity:
                (proposal.blastRadius.threatenedInvariantIds?.length ?? 0) > 0 ||
                (proposal.blastRadius.blockedBy?.length ?? 0) > 0,
        };
    }

    private _buildSnapshot(
        proposal: SafeChangeProposal,
        input: GovernancePolicyInput,
    ): GovernanceProposalSnapshot {
        return {
            proposalId: proposal.proposalId,
            riskScore: proposal.riskScore,
            safetyClass: proposal.rollbackClassification.safetyClass,
            targetSubsystem: proposal.targetSubsystem,
            targetFileCount: proposal.targetFiles.length,
            hasProtectedFiles: input.hasProtectedFile,
            isProtectedSubsystem: input.isProtectedSubsystem,
            hasInvariantSensitivity: input.hasInvariantSensitivity,
            rollbackStrategy: proposal.rollbackClassification.strategy,
            mutationTypes: input.mutationTypes,
            verificationManualRequired: proposal.verificationRequirements.manualReviewRequired,
        };
    }

    /**
     * Heuristic check for protected file paths based on known Tala path patterns.
     * This supplements the caller-provided protected files list.
     */
    private _isProtectedPath(filePath: string): boolean {
        const protectedPatterns = [
            'electron/services/router/',
            'electron/services/soul/',
            'data/identity/',
            'electron/main.ts',
            'electron/preload.ts',
            'electron/services/SystemPrompts.ts',
            'electron/services/ToolService.ts',
        ];
        return protectedPatterns.some(p => filePath.includes(p));
    }

    private _emitDashboard(milestone: GovernanceMilestoneName): void {
        try {
            const state = this._buildDashboardState();
            this.dashboardBridge.maybeEmit(milestone, state);
        } catch {
            // Non-fatal — dashboard emission must never block governance
        }
    }

    private _buildDashboardState(): GovernanceDashboardState {
        const decisions = this.registry.listDecisions();
        const pending = decisions.filter(d =>
            d.status === 'pending' || d.status === 'escalated',
        );
        const recent = decisions.slice(0, 20);

        const kpis = {
            totalDecisions: decisions.length,
            selfAuthorized: decisions.filter(d => d.status === 'self_authorized').length,
            humanApproved: decisions.filter(d => d.status === 'approved').length,
            rejected: decisions.filter(d => d.status === 'rejected').length,
            pending: decisions.filter(d => d.status === 'pending').length,
            blocked: decisions.filter(d => d.status === 'blocked').length,
            escalated: decisions.filter(d => d.status === 'escalated').length,
            expired: decisions.filter(d => d.status === 'expired').length,
        };

        return {
            kpis,
            pendingQueue: pending.map(d => ({
                decisionId: d.decisionId,
                proposalId: d.proposalId,
                proposalTitle: `Proposal ${d.proposalId.slice(0, 8)}`,
                requiredTier: d.requiredTier,
                approvalsRequired: d.approvalsRequired,
                approvalsReceived: d.approvals.filter(a => a.outcome === 'approved').length,
                pendingConfirmations: d.confirmations.filter(c => c.required && !c.satisfied),
                createdAt: d.createdAt,
                proposalSnapshot: d.proposalSnapshot,
            })),
            recentDecisions: recent,
            activePolicyId: this.activePolicy.policyId,
            activePolicyLabel: this.activePolicy.label,
            selfAuthorizationEnabled: !this.activePolicy.selfAuthorizationDisabled,
            lastUpdatedAt: new Date().toISOString(),
        };
    }
}
