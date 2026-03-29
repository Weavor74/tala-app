/**
 * ApprovalWorkflowRegistry.ts — Phase 3.5 P3.5E
 *
 * Persistent local store for governance decisions and approval records.
 *
 * Storage layout:
 *   <dataDir>/governance/decisions/<proposalId>.json    — GovernanceDecision (full record)
 *   <dataDir>/governance/approvals/<proposalId>.jsonl   — ApprovalRecord (append-only)
 *
 * Design rules:
 * - Decision JSON is the authoritative mutable state.
 * - Approvals JSONL is the immutable append-only audit trail of approval actions.
 * - Both files are written on every mutation.
 * - No decision state change is permitted without a corresponding audit event.
 * - Same-actor dual approval is rejected: one actor cannot provide both approvals.
 * - Decision file is written atomically using a temp file + rename pattern.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    GovernanceDecision,
    GovernanceDecisionStatus,
    ApprovalRecord,
    ApprovalActor,
    ConfirmationRequirement,
    EscalationRequirement,
    GovernanceEvaluationResult,
    GovernanceProposalSnapshot,
} from '../../../shared/governanceTypes';
import { approvalsRequired } from './AuthorityTierModel';
import { telemetry } from '../TelemetryService';

// ─── ApprovalWorkflowRegistry ─────────────────────────────────────────────────

export class ApprovalWorkflowRegistry {
    private readonly decisionsDir: string;
    private readonly approvalsDir: string;

    constructor(dataDir: string) {
        this.decisionsDir = path.join(dataDir, 'governance', 'decisions');
        this.approvalsDir = path.join(dataDir, 'governance', 'approvals');
        this._ensureDirs();
    }

    // ── Decision lifecycle ──────────────────────────────────────────────────────

    /**
     * Creates and persists a new GovernanceDecision from an evaluation result.
     * If a decision already exists for this proposalId, returns the existing decision.
     */
    createDecision(
        evalResult: GovernanceEvaluationResult,
        snapshot: GovernanceProposalSnapshot,
        confirmations: ConfirmationRequirement[],
        escalations: EscalationRequirement[],
    ): GovernanceDecision {
        const existing = this.getDecision(evalResult.proposalId);
        if (existing) return existing;

        const now = new Date().toISOString();
        const isSelfAuth = evalResult.selfAuthorizationPermitted;
        const isBlocked = evalResult.blockedByPolicy;

        const decision: GovernanceDecision = {
            decisionId: uuidv4(),
            proposalId: evalResult.proposalId,
            createdAt: now,
            updatedAt: now,
            status: isBlocked ? 'blocked' : (isSelfAuth ? 'self_authorized' : 'pending'),
            requiredTier: evalResult.resolvedTier,
            evaluatedPolicyId: evalResult.policyId,
            evaluatedPolicyVersion: evalResult.policyVersion,
            matchedRuleIds: evalResult.matchedRules.map(r => r.ruleId),
            tierRationale: evalResult.matchedRules.length > 0
                ? evalResult.matchedRules.map(r => r.rationale).join(' | ')
                : `Default tier applied: ${evalResult.resolvedTier}`,
            selfAuthorized: isSelfAuth && !isBlocked,
            approvals: [],
            approvalsRequired: evalResult.approvalsRequired,
            confirmations,
            escalations,
            blockReason: evalResult.blockReason,
            executionAuthorized: isSelfAuth && !isBlocked && confirmations.length === 0,
            proposalSnapshot: snapshot,
        };

        if (decision.executionAuthorized) {
            decision.executionAuthorizedAt = now;
            decision.executionAuthorizedBy = {
                actorId: evalResult.matchedRules.length > 0
                    ? evalResult.matchedRules[0]!.ruleId
                    : 'default-policy',
                kind: 'tala_policy',
                label: 'Tala Policy Self-Authorization',
                timestamp: now,
            };
        }

        this._persistDecision(decision);
        return decision;
    }

    /**
     * Retrieves a governance decision by proposalId.
     * Returns null if not found.
     */
    getDecision(proposalId: string): GovernanceDecision | null {
        const filePath = path.join(this.decisionsDir, `${proposalId}.json`);
        return this._loadFile<GovernanceDecision>(filePath);
    }

    /**
     * Retrieves a governance decision by decisionId.
     * Scans all decisions (linear scan — use proposalId when possible).
     */
    getDecisionById(decisionId: string): GovernanceDecision | null {
        return this.listDecisions().find(d => d.decisionId === decisionId) ?? null;
    }

    /**
     * Lists all governance decisions, optionally filtered by status.
     * Returns newest-first.
     */
    listDecisions(filter?: { status?: GovernanceDecisionStatus }): GovernanceDecision[] {
        try {
            const files = fs.readdirSync(this.decisionsDir)
                .filter(f => f.endsWith('.json'));

            const decisions = files
                .map(f => this._loadFile<GovernanceDecision>(path.join(this.decisionsDir, f)))
                .filter((d): d is GovernanceDecision => d !== null)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

            if (filter?.status) {
                return decisions.filter(d => d.status === filter.status);
            }
            return decisions;
        } catch {
            return [];
        }
    }

    // ── Approval flow ───────────────────────────────────────────────────────────

    /**
     * Records a human approval for a proposal.
     *
     * Validation:
     * - Decision must exist and be in 'pending' or 'escalated' status.
     * - Same actor cannot approve twice for dual-approval tier.
     * - Returns null if validation fails (with reason in error log).
     */
    recordApproval(
        proposalId: string,
        actor: ApprovalActor,
        snapshot: GovernanceProposalSnapshot,
        reason?: string,
    ): { record: ApprovalRecord | null; error?: string } {
        const decision = this.getDecision(proposalId);
        if (!decision) return { record: null, error: 'decision_not_found' };

        if (decision.status !== 'pending' && decision.status !== 'escalated') {
            return {
                record: null,
                error: `decision_not_pending: status is '${decision.status}'`,
            };
        }

        // Prevent same actor from approving twice when dual approval is required
        const existingApprovers = decision.approvals
            .filter(a => a.outcome === 'approved')
            .map(a => a.actor.actorId);
        if (existingApprovers.includes(actor.actorId) && decision.approvalsRequired >= 2) {
            return { record: null, error: 'duplicate_actor_approval' };
        }

        const record = this._makeApprovalRecord(proposalId, decision.decisionId, actor, 'approved', snapshot, reason);
        this._appendApprovalRecord(proposalId, record);

        const updatedApprovals = [...decision.approvals, record];
        const approvedCount = updatedApprovals.filter(a => a.outcome === 'approved').length;
        const allApprovalsReceived = approvedCount >= decision.approvalsRequired;
        const allConfirmationsSatisfied = decision.confirmations.every(
            c => !c.required || c.satisfied,
        );
        const executionAuthorized = allApprovalsReceived && allConfirmationsSatisfied;
        const now = new Date().toISOString();

        const updates: Partial<GovernanceDecision> = {
            approvals: updatedApprovals,
            updatedAt: now,
            status: allApprovalsReceived ? 'approved' : decision.status,
            executionAuthorized,
            executionAuthorizedAt: executionAuthorized ? now : decision.executionAuthorizedAt,
            executionAuthorizedBy: executionAuthorized ? actor : decision.executionAuthorizedBy,
        };

        this._updateDecision(proposalId, updates);
        return { record };
    }

    /**
     * Records a human rejection for a proposal.
     * Transitions decision to 'rejected' — terminal state.
     */
    recordRejection(
        proposalId: string,
        actor: ApprovalActor,
        snapshot: GovernanceProposalSnapshot,
        reason: string,
    ): { record: ApprovalRecord | null; error?: string } {
        const decision = this.getDecision(proposalId);
        if (!decision) return { record: null, error: 'decision_not_found' };

        const record = this._makeApprovalRecord(proposalId, decision.decisionId, actor, 'rejected', snapshot, reason);
        this._appendApprovalRecord(proposalId, record);

        this._updateDecision(proposalId, {
            approvals: [...decision.approvals, record],
            updatedAt: new Date().toISOString(),
            status: 'rejected',
            executionAuthorized: false,
            blockReason: reason,
        });

        return { record };
    }

    /**
     * Records a deferral for a proposal.
     * Transitions decision to 'deferred' — may be re-evaluated after replan.
     */
    recordDeferral(
        proposalId: string,
        actor: ApprovalActor,
        snapshot: GovernanceProposalSnapshot,
        reason?: string,
    ): { record: ApprovalRecord | null; error?: string } {
        const decision = this.getDecision(proposalId);
        if (!decision) return { record: null, error: 'decision_not_found' };

        const record = this._makeApprovalRecord(proposalId, decision.decisionId, actor, 'deferred', snapshot, reason);
        this._appendApprovalRecord(proposalId, record);

        this._updateDecision(proposalId, {
            approvals: [...decision.approvals, record],
            updatedAt: new Date().toISOString(),
            status: 'deferred',
            executionAuthorized: false,
        });

        return { record };
    }

    // ── Confirmation management ─────────────────────────────────────────────────

    /**
     * Marks a specific confirmation as satisfied by the given actor.
     * Re-evaluates whether execution is now authorized.
     */
    satisfyConfirmation(
        proposalId: string,
        confirmationId: string,
        actor: ApprovalActor,
    ): { success: boolean; error?: string } {
        const decision = this.getDecision(proposalId);
        if (!decision) return { success: false, error: 'decision_not_found' };

        const confirmationIndex = decision.confirmations.findIndex(
            c => c.confirmationId === confirmationId,
        );
        if (confirmationIndex === -1) {
            return { success: false, error: 'confirmation_not_found' };
        }

        const now = new Date().toISOString();
        const updatedConfirmations = [...decision.confirmations];
        updatedConfirmations[confirmationIndex] = {
            ...updatedConfirmations[confirmationIndex]!,
            satisfied: true,
            satisfiedAt: now,
            satisfiedByActor: actor,
        };

        const approvedCount = decision.approvals.filter(a => a.outcome === 'approved').length;
        const allApprovalsReceived = decision.selfAuthorized ||
            (approvedCount >= decision.approvalsRequired);
        const allConfirmationsSatisfied = updatedConfirmations.every(
            c => !c.required || c.satisfied,
        );
        const executionAuthorized = allApprovalsReceived && allConfirmationsSatisfied;

        this._updateDecision(proposalId, {
            confirmations: updatedConfirmations,
            updatedAt: now,
            executionAuthorized,
            executionAuthorizedAt: executionAuthorized ? now : decision.executionAuthorizedAt,
            executionAuthorizedBy: executionAuthorized ? actor : decision.executionAuthorizedBy,
        });

        return { success: true };
    }

    // ── Escalation management ───────────────────────────────────────────────────

    /**
     * Adds an escalation requirement to an existing decision.
     */
    addEscalation(proposalId: string, escalation: EscalationRequirement): { success: boolean; error?: string } {
        const decision = this.getDecision(proposalId);
        if (!decision) return { success: false, error: 'decision_not_found' };

        this._updateDecision(proposalId, {
            escalations: [...decision.escalations, escalation],
            updatedAt: new Date().toISOString(),
            status: decision.status === 'approved' ? 'escalated' : decision.status,
            executionAuthorized: false,
        });

        return { success: true };
    }

    /**
     * Resolves an escalation requirement by ID.
     */
    resolveEscalation(
        proposalId: string,
        escalationId: string,
        actor: ApprovalActor,
    ): { success: boolean; error?: string } {
        const decision = this.getDecision(proposalId);
        if (!decision) return { success: false, error: 'decision_not_found' };

        const idx = decision.escalations.findIndex(e => e.escalationId === escalationId);
        if (idx === -1) return { success: false, error: 'escalation_not_found' };

        const now = new Date().toISOString();
        const updatedEscalations = [...decision.escalations];
        updatedEscalations[idx] = {
            ...updatedEscalations[idx]!,
            resolved: true,
            resolvedAt: now,
            resolvedByActor: actor,
        };

        this._updateDecision(proposalId, {
            escalations: updatedEscalations,
            updatedAt: now,
        });

        return { success: true };
    }

    // ── Expiry sweep ────────────────────────────────────────────────────────────

    /**
     * Marks pending decisions older than maxAgeMs as 'expired'.
     * Returns the list of expired decisionIds.
     */
    expireStaleDecisions(maxAgeMs: number): string[] {
        const now = Date.now();
        const expired: string[] = [];

        for (const decision of this.listDecisions({ status: 'pending' })) {
            const ageMs = now - new Date(decision.createdAt).getTime();
            if (ageMs > maxAgeMs) {
                this._updateDecision(decision.proposalId, {
                    status: 'expired',
                    executionAuthorized: false,
                    updatedAt: new Date().toISOString(),
                });
                expired.push(decision.decisionId);

                telemetry.operational(
                    'governance',
                    'governance.decision.expired',
                    'warn',
                    'ApprovalWorkflowRegistry',
                    `Decision ${decision.decisionId} for proposal ${decision.proposalId} expired after ${Math.floor(ageMs / 86400000)} day(s)`,
                );
            }
        }

        return expired;
    }

    // ── Approval record persistence ─────────────────────────────────────────────

    /**
     * Returns all approval records for a proposal from the JSONL file.
     */
    listApprovalRecords(proposalId: string): ApprovalRecord[] {
        const filePath = path.join(this.approvalsDir, `${proposalId}.jsonl`);
        if (!fs.existsSync(filePath)) return [];
        try {
            return fs.readFileSync(filePath, 'utf-8')
                .split('\n')
                .filter(l => l.trim())
                .map(l => JSON.parse(l) as ApprovalRecord);
        } catch {
            return [];
        }
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _makeApprovalRecord(
        proposalId: string,
        decisionId: string,
        actor: ApprovalActor,
        outcome: ApprovalRecord['outcome'],
        snapshot: GovernanceProposalSnapshot,
        reason?: string,
    ): ApprovalRecord {
        return {
            approvalId: uuidv4(),
            proposalId,
            decisionId,
            actor,
            outcome,
            reason,
            timestamp: new Date().toISOString(),
            proposalSnapshot: snapshot,
        };
    }

    private _appendApprovalRecord(proposalId: string, record: ApprovalRecord): void {
        const filePath = path.join(this.approvalsDir, `${proposalId}.jsonl`);
        try {
            fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'governance',
                'governance.approvals.write_error',
                'warn',
                'ApprovalWorkflowRegistry',
                `Failed to append approval record for proposal ${proposalId}: ${err.message}`,
            );
        }
    }

    private _persistDecision(decision: GovernanceDecision): void {
        const filePath = path.join(this.decisionsDir, `${decision.proposalId}.json`);
        const tempPath = `${filePath}.tmp`;
        try {
            fs.writeFileSync(tempPath, JSON.stringify(decision, null, 2), 'utf-8');
            fs.renameSync(tempPath, filePath);
        } catch (err: any) {
            // Clean up temp file on failure
            try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
            telemetry.operational(
                'governance',
                'governance.decision.persist_error',
                'warn',
                'ApprovalWorkflowRegistry',
                `Failed to persist decision for proposal ${decision.proposalId}: ${err.message}`,
            );
        }
    }

    private _updateDecision(proposalId: string, updates: Partial<GovernanceDecision>): void {
        const existing = this.getDecision(proposalId);
        if (!existing) return;
        const updated = { ...existing, ...updates };
        this._persistDecision(updated);
    }

    private _loadFile<T>(filePath: string): T | null {
        if (!fs.existsSync(filePath)) return null;
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
        } catch {
            return null;
        }
    }

    private _ensureDirs(): void {
        try {
            if (!fs.existsSync(this.decisionsDir)) {
                fs.mkdirSync(this.decisionsDir, { recursive: true });
            }
            if (!fs.existsSync(this.approvalsDir)) {
                fs.mkdirSync(this.approvalsDir, { recursive: true });
            }
        } catch {
            // Non-fatal — will fail at write time with a more specific error
        }
    }
}
