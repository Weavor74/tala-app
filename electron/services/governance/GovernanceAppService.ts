/**
 * GovernanceAppService.ts — Phase 3.5 P3.5H / P3.5I
 *
 * IPC handler registry for the governance layer.
 *
 * Follows the ExecutionAppService pattern exactly:
 * - All handlers registered in registerIpcHandlers().
 * - All calls wrapped in executeWithTelemetry() for uniform error logging.
 *
 * IPC namespace: governance:*
 *
 * Handlers:
 *   governance:getDecision              — get governance decision for a proposal
 *   governance:listDecisions            — list all decisions (optionally filtered)
 *   governance:getDashboardState        — full governance dashboard KPIs + queue
 *   governance:evaluateProposal         — trigger governance evaluation for a proposal
 *   governance:approve                  — record a human approval
 *   governance:reject                   — record a human rejection
 *   governance:defer                    — record a deferral
 *   governance:satisfyConfirmation      — mark a confirmation requirement as satisfied
 *   governance:getAuditLog              — read audit log for a proposal
 *   governance:getAuthorizationDecision — canExecute() check for a proposal
 */

import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type {
    GovernanceApproveRequest,
    GovernanceRejectRequest,
    GovernanceDeferRequest,
    GovernanceSatisfyConfirmationRequest,
    GovernanceDecisionStatus,
    ApprovalActor,
    GovernancePolicy,
    GovernanceDecision,
} from '../../../shared/governanceTypes';
import type { SafeChangeProposal } from '../../../shared/reflectionPlanTypes';
import { ApprovalWorkflowRegistry } from './ApprovalWorkflowRegistry';
import { GovernanceAuditService } from './GovernanceAuditService';
import { ExecutionAuthorizationGate } from './ExecutionAuthorizationGate';
import { GovernanceDashboardBridge } from './GovernanceDashboardBridge';
import { DEFAULT_GOVERNANCE_POLICY } from './defaults/defaultPolicy';
import { telemetry } from '../TelemetryService';

// ─── GovernanceAppService ──────────────────────────────────────────────────────

const EXPIRY_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DECISION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const LOCAL_HUMAN_ACTOR: ApprovalActor = {
    actorId: 'local_user',
    kind: 'human_user',
    label: 'Local Operator',
    timestamp: '', // filled at call time
};

export class GovernanceAppService {
    private readonly registry: ApprovalWorkflowRegistry;
    private readonly auditService: GovernanceAuditService;
    private readonly dashboardBridge: GovernanceDashboardBridge;
    private readonly authGate: ExecutionAuthorizationGate;
    private readonly activePolicy: GovernancePolicy;
    private expiryTimer: NodeJS.Timeout | null = null;

    constructor(
        dataDir: string,
        private readonly getProposal: (proposalId: string) => SafeChangeProposal | null,
        private readonly getProtectedFiles: () => string[] = () => [],
    ) {
        this.activePolicy = this._loadOrDefaultPolicy(dataDir);
        this.registry = new ApprovalWorkflowRegistry(dataDir);
        this.auditService = new GovernanceAuditService(dataDir);
        this.dashboardBridge = new GovernanceDashboardBridge();

        this.authGate = new ExecutionAuthorizationGate(
            this.registry,
            this.auditService,
            this.dashboardBridge,
            this.activePolicy,
            this.getProtectedFiles,
        );

        this.registerIpcHandlers();
        this._startExpirySweep();
    }

    // ── Public API (used by ExecutionOrchestrator and ReflectionAppService) ───────

    /**
     * Returns the ExecutionAuthorizationGate for use by ExecutionEligibilityGate check 10.
     */
    getAuthorizationGate(): ExecutionAuthorizationGate {
        return this.authGate;
    }

    /**
     * Evaluates governance policy for a proposal and creates/refreshes a GovernanceDecision.
     *
     * Called automatically when a proposal transitions to 'promoted' status via
     * planning:promoteProposal — ensures a governance decision exists before the
     * ExecutionEligibilityGate (check 10) is reached.
     *
     * Idempotent: if a decision already exists for this proposalId, the existing
     * decision is returned unchanged.
     *
     * Does NOT authorize execution — that remains the exclusive responsibility of
     * the policy engine + approval workflow + ExecutionAuthorizationGate.
     */
    evaluateForProposal(proposal: SafeChangeProposal): GovernanceDecision {
        return this.authGate.evaluateProposal(proposal);
    }

    /**
     * Returns the current governance decision for a proposal, or null if none exists.
     * Used by AutonomousRunOrchestrator (Phase 4) to check governance status without IPC.
     */
    getDecision(proposalId: string): GovernanceDecision | null {
        return this.registry.getDecision(proposalId);
    }

    // ── IPC logging helper (mirrors ExecutionAppService) ───────────────────────

    private logIpc(method: string, args?: unknown): void {
        console.log(`[GovernanceAppService] 🛡️ IPC Invoke: ${method}`, args ?? '');
    }

    private async executeWithTelemetry<T>(
        methodName: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        this.logIpc(methodName);
        try {
            const start = Date.now();
            const result = await operation();
            const elapsed = Date.now() - start;
            telemetry.operational(
                'governance',
                `governance.ipc.${methodName}.success`,
                'debug',
                'GovernanceAppService',
                `Successfully executed ${methodName} in ${elapsed}ms`,
            );
            return result;
        } catch (error: any) {
            console.error(`[GovernanceAppService] 🔴 IPC Error in ${methodName}:`, error);
            telemetry.operational(
                'governance',
                `governance.ipc.${methodName}.error`,
                'error',
                'GovernanceAppService',
                `Failed during ${methodName}: ${error.message}`,
            );
            throw error;
        }
    }

    // ── IPC handlers ────────────────────────────────────────────────────────────

    private registerIpcHandlers(): void {

        // ── governance:getDecision ──────────────────────────────────────────────
        ipcMain.handle('governance:getDecision', (_, proposalId: string) =>
            this.executeWithTelemetry('getDecision', async () => {
                const decision = this.registry.getDecision(proposalId);
                return { decision, found: decision !== null };
            }),
        );

        // ── governance:listDecisions ────────────────────────────────────────────
        ipcMain.handle(
            'governance:listDecisions',
            (_, filter?: { status?: GovernanceDecisionStatus }) =>
                this.executeWithTelemetry('listDecisions', async () => {
                    const decisions = this.registry.listDecisions(filter);
                    return { decisions, total: decisions.length };
                }),
        );

        // ── governance:getDashboardState ────────────────────────────────────────
        ipcMain.handle('governance:getDashboardState', () =>
            this.executeWithTelemetry('getDashboardState', async () => {
                return this._buildDashboardState();
            }),
        );

        // ── governance:evaluateProposal ─────────────────────────────────────────
        ipcMain.handle('governance:evaluateProposal', (_, proposalId: string) =>
            this.executeWithTelemetry('evaluateProposal', async () => {
                const proposal = this.getProposal(proposalId);
                if (!proposal) {
                    return { success: false, decision: null, error: 'proposal_not_found' };
                }
                const decision = this.authGate.evaluateProposal(proposal);
                return { success: true, decision };
            }),
        );

        // ── governance:approve ──────────────────────────────────────────────────
        ipcMain.handle('governance:approve', (_, request: GovernanceApproveRequest) =>
            this.executeWithTelemetry('approve', async () => {
                const proposal = this.getProposal(request.proposalId);
                if (!proposal) {
                    return { success: false, decision: null, record: null, error: 'proposal_not_found' };
                }

                const decision = this.registry.getDecision(request.proposalId);
                if (!decision) {
                    return { success: false, decision: null, record: null, error: 'decision_not_found' };
                }

                const actor: ApprovalActor = {
                    ...LOCAL_HUMAN_ACTOR,
                    timestamp: new Date().toISOString(),
                };

                const { record, error } = this.registry.recordApproval(
                    request.proposalId,
                    actor,
                    decision.proposalSnapshot,
                    request.reason,
                );

                if (error || !record) {
                    return { success: false, decision: null, record: null, error };
                }

                this.auditService.append(
                    request.proposalId,
                    decision.decisionId,
                    'approval_recorded',
                    `Human approval recorded${request.reason ? `: ${request.reason}` : ''}`,
                    actor,
                    { approvalId: record.approvalId },
                );

                telemetry.operational(
                    'governance',
                    'governance.approval.granted',
                    'info',
                    'GovernanceAppService',
                    `Approval recorded for proposal ${request.proposalId}`,
                );

                const updatedDecision = this.registry.getDecision(request.proposalId);
                if (updatedDecision?.executionAuthorized) {
                    this.auditService.append(
                        request.proposalId,
                        decision.decisionId,
                        'execution_authorized',
                        'Execution authorized after human approval',
                        actor,
                    );
                    this.dashboardBridge.maybeEmit('execution_authorized', this._buildDashboardState());
                } else {
                    this.dashboardBridge.maybeEmit('approval_recorded', this._buildDashboardState());
                }

                return { success: true, decision: updatedDecision, record };
            }),
        );

        // ── governance:reject ───────────────────────────────────────────────────
        ipcMain.handle('governance:reject', (_, request: GovernanceRejectRequest) =>
            this.executeWithTelemetry('reject', async () => {
                const decision = this.registry.getDecision(request.proposalId);
                if (!decision) {
                    return { success: false, decision: null, record: null, error: 'decision_not_found' };
                }

                const actor: ApprovalActor = {
                    ...LOCAL_HUMAN_ACTOR,
                    timestamp: new Date().toISOString(),
                };

                const { record, error } = this.registry.recordRejection(
                    request.proposalId,
                    actor,
                    decision.proposalSnapshot,
                    request.reason,
                );

                if (error || !record) {
                    return { success: false, decision: null, record: null, error };
                }

                this.auditService.append(
                    request.proposalId,
                    decision.decisionId,
                    'rejection_recorded',
                    `Human rejection recorded: ${request.reason}`,
                    actor,
                    { approvalId: record.approvalId, reason: request.reason },
                );

                telemetry.operational(
                    'governance',
                    'governance.approval.rejected',
                    'warn',
                    'GovernanceAppService',
                    `Rejection recorded for proposal ${request.proposalId}`,
                );

                this.dashboardBridge.maybeEmit('rejection_recorded', this._buildDashboardState());

                const updatedDecision = this.registry.getDecision(request.proposalId);
                return { success: true, decision: updatedDecision, record };
            }),
        );

        // ── governance:defer ────────────────────────────────────────────────────
        ipcMain.handle('governance:defer', (_, request: GovernanceDeferRequest) =>
            this.executeWithTelemetry('defer', async () => {
                const decision = this.registry.getDecision(request.proposalId);
                if (!decision) {
                    return { success: false, decision: null, record: null, error: 'decision_not_found' };
                }

                const actor: ApprovalActor = {
                    ...LOCAL_HUMAN_ACTOR,
                    timestamp: new Date().toISOString(),
                };

                const { record, error } = this.registry.recordDeferral(
                    request.proposalId,
                    actor,
                    decision.proposalSnapshot,
                    request.reason,
                );

                if (error || !record) {
                    return { success: false, decision: null, record: null, error };
                }

                this.auditService.append(
                    request.proposalId,
                    decision.decisionId,
                    'deferral_recorded',
                    `Deferral recorded${request.reason ? `: ${request.reason}` : ''}`,
                    actor,
                );

                telemetry.operational(
                    'governance',
                    'governance.approval.deferred',
                    'info',
                    'GovernanceAppService',
                    `Deferral recorded for proposal ${request.proposalId}`,
                );

                this.dashboardBridge.maybeEmit('deferral_recorded', this._buildDashboardState());

                const updatedDecision = this.registry.getDecision(request.proposalId);
                return { success: true, decision: updatedDecision, record };
            }),
        );

        // ── governance:satisfyConfirmation ──────────────────────────────────────
        ipcMain.handle(
            'governance:satisfyConfirmation',
            (_, request: GovernanceSatisfyConfirmationRequest) =>
                this.executeWithTelemetry('satisfyConfirmation', async () => {
                    const decision = this.registry.getDecision(request.proposalId);
                    if (!decision) {
                        return { success: false, error: 'decision_not_found' };
                    }

                    const actor: ApprovalActor = {
                        ...LOCAL_HUMAN_ACTOR,
                        timestamp: new Date().toISOString(),
                    };

                    const { success, error } = this.registry.satisfyConfirmation(
                        request.proposalId,
                        request.confirmationId,
                        actor,
                    );

                    if (!success) {
                        return { success: false, error };
                    }

                    this.auditService.append(
                        request.proposalId,
                        decision.decisionId,
                        'confirmation_satisfied',
                        `Confirmation ${request.confirmationId} satisfied`,
                        actor,
                    );

                    telemetry.operational(
                        'governance',
                        'governance.confirmation.recorded',
                        'debug',
                        'GovernanceAppService',
                        `Confirmation ${request.confirmationId} satisfied for proposal ${request.proposalId}`,
                    );

                    const updatedDecision = this.registry.getDecision(request.proposalId);
                    if (updatedDecision?.executionAuthorized) {
                        this.auditService.append(
                            request.proposalId,
                            decision.decisionId,
                            'execution_authorized',
                            'Execution authorized after confirmation satisfied',
                            actor,
                        );
                        this.dashboardBridge.maybeEmit('execution_authorized', this._buildDashboardState());
                    } else {
                        this.dashboardBridge.maybeEmit('confirmation_satisfied', this._buildDashboardState());
                    }

                    return { success: true, decision: updatedDecision };
                }),
        );

        // ── governance:getAuditLog ──────────────────────────────────────────────
        ipcMain.handle('governance:getAuditLog', (_, proposalId: string) =>
            this.executeWithTelemetry('getAuditLog', async () => {
                const records = this.auditService.readAll(proposalId);
                return { records, total: records.length };
            }),
        );

        // ── governance:getAuthorizationDecision ─────────────────────────────────
        ipcMain.handle('governance:getAuthorizationDecision', (_, proposalId: string) =>
            this.executeWithTelemetry('getAuthorizationDecision', async () => {
                return this.authGate.canExecute(proposalId);
            }),
        );

        // ── governance:getActivePolicy ──────────────────────────────────────────
        ipcMain.handle('governance:getActivePolicy', () =>
            this.executeWithTelemetry('getActivePolicy', async () => {
                return { policy: this.activePolicy };
            }),
        );
    }

    // ── Dashboard state builder ─────────────────────────────────────────────────

    private _buildDashboardState(): import('../../../shared/governanceTypes').GovernanceDashboardState {
        const decisions = this.registry.listDecisions();
        const pending = decisions.filter(d =>
            d.status === 'pending' || d.status === 'escalated',
        );

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
            recentDecisions: decisions.slice(0, 20),
            activePolicyId: this.activePolicy.policyId,
            activePolicyLabel: this.activePolicy.label,
            selfAuthorizationEnabled: !this.activePolicy.selfAuthorizationDisabled,
            lastUpdatedAt: new Date().toISOString(),
        };
    }

    // ── Policy loading ──────────────────────────────────────────────────────────

    private _loadOrDefaultPolicy(dataDir: string): GovernancePolicy {
        const policyFile = path.join(dataDir, 'governance', 'policy', 'active_policy.json');
        if (fs.existsSync(policyFile)) {
            try {
                const loaded = JSON.parse(fs.readFileSync(policyFile, 'utf-8')) as GovernancePolicy;
                // Basic validation
                if (loaded.policyId && loaded.rules && Array.isArray(loaded.rules)) {
                    return loaded;
                }
            } catch (err: any) {
                telemetry.operational(
                    'governance',
                    'governance.policy.load_error',
                    'warn',
                    'GovernanceAppService',
                    `Failed to load active_policy.json, using default: ${err.message}`,
                );
            }
        }
        return DEFAULT_GOVERNANCE_POLICY;
    }

    // ── Expiry sweep ────────────────────────────────────────────────────────────

    private _startExpirySweep(): void {
        this.expiryTimer = setInterval(() => {
            try {
                const expired = this.registry.expireStaleDecisions(DECISION_EXPIRY_MS);
                if (expired.length > 0) {
                    telemetry.operational(
                        'governance',
                        'governance.sweep.expired',
                        'info',
                        'GovernanceAppService',
                        `Expiry sweep: ${expired.length} decision(s) expired`,
                    );
                    this.dashboardBridge.maybeEmit('decision_expired', this._buildDashboardState());
                }
            } catch (err: any) {
                telemetry.operational(
                    'governance',
                    'governance.sweep.error',
                    'warn',
                    'GovernanceAppService',
                    `Expiry sweep failed: ${err.message}`,
                );
            }
        }, EXPIRY_SWEEP_INTERVAL_MS);

        // Don't keep the process alive just for sweeps
        if (this.expiryTimer.unref) {
            this.expiryTimer.unref();
        }
    }

    stopExpirySweep(): void {
        if (this.expiryTimer) {
            clearInterval(this.expiryTimer);
            this.expiryTimer = null;
        }
    }
}
