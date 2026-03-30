import React, { useState, useEffect, useCallback } from 'react';
import type {
    GovernanceDashboardState,
    GovernanceDecision,
    GovernanceDecisionStatus,
    AuthorityTier,
    ConfirmationRequirement,
} from '../../../shared/governanceTypes';

/**
 * GovernancePanel
 *
 * Phase 3.5 P3.5H — Human-in-the-Loop Governance Dashboard Panel
 *
 * Integrated into the Reflection Dashboard as the 'governance' sub-tab
 * under Engineering / Core Systems → Reflection.
 *
 * Shows:
 * - Governance KPIs
 * - Pending approval queue
 * - Confirmation requirements
 * - Decision history
 * - Governance blockers with reasons
 * - Authority tier required per proposal
 * - Self-authorization status
 */

// ─── Tier display helpers ─────────────────────────────────────────────────────

const TIER_CONFIG: Record<AuthorityTier, { label: string; color: string; icon: string }> = {
    tala_self_low_risk:    { label: 'Self-Auth (Low Risk)', color: '#10b981', icon: '🤖' },
    tala_self_standard:    { label: 'Self-Auth (Standard)', color: '#06b6d4', icon: '🤖' },
    protected_subsystem:   { label: 'Protected Subsystem', color: '#f59e0b', icon: '🔒' },
    human_review_required: { label: 'Human Review', color: '#f59e0b', icon: '👤' },
    human_dual_approval:   { label: 'Dual Approval', color: '#f97316', icon: '👥' },
    emergency_manual_only: { label: 'Emergency Manual Only', color: '#ef4444', icon: '🚨' },
    blocked:               { label: 'Blocked', color: '#ef4444', icon: '🚫' },
};

const STATUS_CONFIG: Record<GovernanceDecisionStatus, { label: string; color: string; icon: string }> = {
    pending:          { label: 'Pending', color: '#f59e0b', icon: '⏳' },
    approved:         { label: 'Approved', color: '#10b981', icon: '✅' },
    self_authorized:  { label: 'Self-Authorized', color: '#06b6d4', icon: '🤖' },
    rejected:         { label: 'Rejected', color: '#ef4444', icon: '❌' },
    deferred:         { label: 'Deferred', color: '#6b7280', icon: '⏸️' },
    escalated:        { label: 'Escalated', color: '#f97316', icon: '⬆️' },
    blocked:          { label: 'Blocked', color: '#ef4444', icon: '🚫' },
    expired:          { label: 'Expired', color: '#6b7280', icon: '💀' },
};

function TierBadge({ tier }: { tier: AuthorityTier }) {
    const cfg = TIER_CONFIG[tier] ?? { label: tier, color: '#6b7280', icon: '•' };
    return (
        <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '2px 8px',
            borderRadius: '12px',
            fontSize: '11px',
            fontWeight: 600,
            background: `${cfg.color}22`,
            color: cfg.color,
            border: `1px solid ${cfg.color}44`,
        }}>
            {cfg.icon} {cfg.label}
        </span>
    );
}

function StatusBadge({ status }: { status: GovernanceDecisionStatus }) {
    const cfg = STATUS_CONFIG[status] ?? { label: status, color: '#6b7280', icon: '•' };
    return (
        <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '2px 8px',
            borderRadius: '12px',
            fontSize: '11px',
            fontWeight: 600,
            background: `${cfg.color}22`,
            color: cfg.color,
            border: `1px solid ${cfg.color}44`,
        }}>
            {cfg.icon} {cfg.label}
        </span>
    );
}

// ─── KPI bar ──────────────────────────────────────────────────────────────────

function KpiBar({ state }: { state: GovernanceDashboardState }) {
    const { kpis } = state;
    const items = [
        { label: 'Total', value: kpis.totalDecisions, color: '#9ca3af' },
        { label: 'Pending', value: kpis.pending, color: '#f59e0b' },
        { label: 'Self-Auth', value: kpis.selfAuthorized, color: '#06b6d4' },
        { label: 'Approved', value: kpis.humanApproved, color: '#10b981' },
        { label: 'Rejected', value: kpis.rejected, color: '#ef4444' },
        { label: 'Blocked', value: kpis.blocked, color: '#ef4444' },
        { label: 'Escalated', value: kpis.escalated, color: '#f97316' },
        { label: 'Expired', value: kpis.expired, color: '#6b7280' },
    ];
    return (
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            {items.map(item => (
                <div key={item.label} style={{
                    background: '#1f2937',
                    border: '1px solid #374151',
                    borderRadius: '6px',
                    padding: '0.4rem 0.75rem',
                    minWidth: '60px',
                    textAlign: 'center',
                }}>
                    <div style={{ color: item.color, fontSize: '18px', fontWeight: 700 }}>{item.value}</div>
                    <div style={{ color: '#9ca3af', fontSize: '10px' }}>{item.label}</div>
                </div>
            ))}
        </div>
    );
}

// ─── Confirmation checklist ───────────────────────────────────────────────────

interface ConfirmationChecklistProps {
    proposalId: string;
    confirmations: ConfirmationRequirement[];
    onSatisfy: (proposalId: string, confirmationId: string) => void;
    disabled: boolean;
}

function ConfirmationChecklist({ proposalId, confirmations, onSatisfy, disabled }: ConfirmationChecklistProps) {
    const pending = confirmations.filter(c => c.required && !c.satisfied);
    if (pending.length === 0) return null;
    return (
        <div style={{ marginTop: '0.5rem' }}>
            <div style={{ color: '#9ca3af', fontSize: '11px', fontWeight: 600, marginBottom: '0.25rem' }}>
                REQUIRED CONFIRMATIONS
            </div>
            {pending.map(conf => (
                <div key={conf.confirmationId} style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.5rem',
                    padding: '0.35rem 0.5rem',
                    background: '#111827',
                    border: '1px solid #374151',
                    borderRadius: '4px',
                    marginBottom: '0.25rem',
                }}>
                    <input
                        type="checkbox"
                        checked={conf.satisfied}
                        disabled={disabled || conf.satisfied}
                        onChange={() => onSatisfy(proposalId, conf.confirmationId)}
                        style={{ marginTop: '2px', cursor: 'pointer' }}
                    />
                    <span style={{ color: '#d1d5db', fontSize: '12px' }}>{conf.promptText}</span>
                </div>
            ))}
        </div>
    );
}

// ─── Pending approval card ────────────────────────────────────────────────────

interface ApprovalCardProps {
    decision: GovernanceDecision;
    onApprove: (proposalId: string) => void;
    onReject: (proposalId: string) => void;
    onDefer: (proposalId: string) => void;
    onSatisfyConfirmation: (proposalId: string, confirmationId: string) => void;
    loading: boolean;
}

function ApprovalCard({ decision, onApprove, onReject, onDefer, onSatisfyConfirmation, loading }: ApprovalCardProps) {
    const approvalsReceived = decision.approvals.filter(a => a.outcome === 'approved').length;

    return (
        <div style={{
            background: '#1f2937',
            border: '1px solid #374151',
            borderLeft: '3px solid #f59e0b',
            borderRadius: '6px',
            padding: '0.75rem 1rem',
            marginBottom: '0.5rem',
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.4rem' }}>
                <div>
                    <code style={{ color: '#a5b4fc', fontSize: '11px' }}>{decision.proposalId.slice(0, 12)}…</code>
                    <span style={{ color: '#6b7280', fontSize: '11px', marginLeft: '8px' }}>
                        {decision.proposalSnapshot.targetSubsystem}
                    </span>
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <TierBadge tier={decision.requiredTier} />
                    <StatusBadge status={decision.status} />
                </div>
            </div>

            <div style={{ color: '#9ca3af', fontSize: '11px', marginBottom: '0.35rem' }}>
                Approvals: <strong style={{ color: '#d1d5db' }}>{approvalsReceived} / {decision.approvalsRequired}</strong>
                {' · '}Files: <strong style={{ color: '#d1d5db' }}>{decision.proposalSnapshot.targetFileCount}</strong>
                {' · '}Risk: <strong style={{ color: '#d1d5db' }}>{decision.proposalSnapshot.riskScore}</strong>
                {decision.proposalSnapshot.hasProtectedFiles && (
                    <span style={{ color: '#f59e0b', marginLeft: '6px' }}>⚠ Protected Files</span>
                )}
                {decision.proposalSnapshot.isProtectedSubsystem && (
                    <span style={{ color: '#ef4444', marginLeft: '6px' }}>🔒 Protected Subsystem</span>
                )}
            </div>

            {decision.tierRationale && (
                <div style={{ color: '#6b7280', fontSize: '10px', marginBottom: '0.5rem', fontStyle: 'italic' }}>
                    {decision.tierRationale.split(' | ')[0]}
                </div>
            )}

            <ConfirmationChecklist
                proposalId={decision.proposalId}
                confirmations={decision.confirmations}
                onSatisfy={onSatisfyConfirmation}
                disabled={loading}
            />

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button
                    onClick={() => onApprove(decision.proposalId)}
                    disabled={loading}
                    style={{
                        padding: '4px 12px',
                        background: '#10b98122',
                        color: '#10b981',
                        border: '1px solid #10b98144',
                        borderRadius: '4px',
                        cursor: loading ? 'default' : 'pointer',
                        fontSize: '12px',
                        fontWeight: 600,
                    }}
                >
                    ✅ Approve
                </button>
                <button
                    onClick={() => onReject(decision.proposalId)}
                    disabled={loading}
                    style={{
                        padding: '4px 12px',
                        background: '#ef444422',
                        color: '#ef4444',
                        border: '1px solid #ef444444',
                        borderRadius: '4px',
                        cursor: loading ? 'default' : 'pointer',
                        fontSize: '12px',
                        fontWeight: 600,
                    }}
                >
                    ❌ Reject
                </button>
                <button
                    onClick={() => onDefer(decision.proposalId)}
                    disabled={loading}
                    style={{
                        padding: '4px 12px',
                        background: 'transparent',
                        color: '#9ca3af',
                        border: '1px solid #374151',
                        borderRadius: '4px',
                        cursor: loading ? 'default' : 'pointer',
                        fontSize: '12px',
                    }}
                >
                    ⏸ Defer
                </button>
            </div>
        </div>
    );
}

// ─── Decision history row ─────────────────────────────────────────────────────

function DecisionHistoryRow({ decision }: { decision: GovernanceDecision }) {
    const approvalsReceived = decision.approvals.filter(a => a.outcome === 'approved').length;
    return (
        <div style={{
            background: '#1f2937',
            border: '1px solid #374151',
            borderRadius: '6px',
            padding: '0.5rem 0.75rem',
            marginBottom: '0.25rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
        }}>
            <div>
                <code style={{ color: '#a5b4fc', fontSize: '11px' }}>{decision.proposalId.slice(0, 12)}…</code>
                <span style={{ color: '#6b7280', fontSize: '10px', marginLeft: '8px' }}>
                    {decision.proposalSnapshot.targetSubsystem}
                </span>
                {decision.status === 'blocked' && decision.blockReason && (
                    <span style={{ color: '#ef4444', fontSize: '10px', marginLeft: '8px' }}>
                        {decision.blockReason}
                    </span>
                )}
            </div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                {decision.status !== 'self_authorized' && decision.status !== 'blocked' && (
                    <span style={{ color: '#6b7280', fontSize: '10px' }}>
                        {approvalsReceived}/{decision.approvalsRequired}
                    </span>
                )}
                <TierBadge tier={decision.requiredTier} />
                <StatusBadge status={decision.status} />
            </div>
        </div>
    );
}

// ─── Main GovernancePanel ─────────────────────────────────────────────────────

const GovernancePanel: React.FC = () => {
    const [dashboardState, setDashboardState] = useState<GovernanceDashboardState | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [rejectReason, setRejectReason] = useState('');
    const [rejectingFor, setRejectingFor] = useState<string | null>(null);
    const tala = (window as any).tala;

    const refresh = useCallback(async () => {
        if (!tala?.getGovernanceDashboardState) return;
        try {
            const state = await tala.getGovernanceDashboardState();
            setDashboardState(state);
            setError(null);
        } catch (e: any) {
            setError(`Failed to load governance state: ${e.message}`);
        }
    }, [tala]);

    useEffect(() => {
        refresh();

        if (!tala?.onGovernanceUpdate) return;
        const unsub = tala.onGovernanceUpdate((state: GovernanceDashboardState) => {
            setDashboardState(state);
        });
        return () => unsub?.();
    }, [refresh, tala]);

    const handleApprove = useCallback(async (proposalId: string) => {
        if (!tala?.approveGovernanceProposal) return;
        setLoading(true);
        try {
            await tala.approveGovernanceProposal({ proposalId });
            await refresh();
        } catch (e: any) {
            setError(`Approval failed: ${e.message}`);
        } finally {
            setLoading(false);
        }
    }, [tala, refresh]);

    const handleReject = useCallback(async (proposalId: string) => {
        if (!tala?.rejectGovernanceProposal) return;
        const reason = rejectingFor === proposalId && rejectReason.trim()
            ? rejectReason.trim()
            : 'Rejected by operator';
        setLoading(true);
        try {
            await tala.rejectGovernanceProposal({ proposalId, reason });
            setRejectingFor(null);
            setRejectReason('');
            await refresh();
        } catch (e: any) {
            setError(`Rejection failed: ${e.message}`);
        } finally {
            setLoading(false);
        }
    }, [tala, refresh, rejectingFor, rejectReason]);

    const handleDefer = useCallback(async (proposalId: string) => {
        if (!tala?.deferProposal) return;
        setLoading(true);
        try {
            await tala.deferProposal({ proposalId });
            await refresh();
        } catch (e: any) {
            setError(`Deferral failed: ${e.message}`);
        } finally {
            setLoading(false);
        }
    }, [tala, refresh]);

    const handleSatisfyConfirmation = useCallback(async (proposalId: string, confirmationId: string) => {
        if (!tala?.satisfyGovernanceConfirmation) return;
        setLoading(true);
        try {
            await tala.satisfyGovernanceConfirmation({ proposalId, confirmationId });
            await refresh();
        } catch (e: any) {
            setError(`Confirmation failed: ${e.message}`);
        } finally {
            setLoading(false);
        }
    }, [tala, refresh]);

    if (!tala?.getGovernanceDashboardState) {
        return (
            <div style={{ padding: '1rem', color: '#6b7280', fontSize: '13px' }}>
                Governance service not available.
            </div>
        );
    }

    return (
        <div style={{ padding: '0.75rem', fontFamily: 'system-ui, sans-serif', color: '#d1d5db' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <div>
                    <span style={{ color: '#f9fafb', fontWeight: 600, fontSize: '14px' }}>🛡️ Governance</span>
                    {dashboardState && (
                        <span style={{ color: '#6b7280', fontSize: '11px', marginLeft: '8px' }}>
                            Policy: {dashboardState.activePolicyLabel}
                            {' · '}
                            Self-Auth: {dashboardState.selfAuthorizationEnabled ? (
                                <span style={{ color: '#10b981' }}>enabled</span>
                            ) : (
                                <span style={{ color: '#ef4444' }}>disabled</span>
                            )}
                        </span>
                    )}
                </div>
                <button
                    onClick={refresh}
                    disabled={loading}
                    style={{
                        padding: '3px 10px',
                        background: 'transparent',
                        color: '#6b7280',
                        border: '1px solid #374151',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '11px',
                    }}
                >
                    ↻ Refresh
                </button>
            </div>

            {error && (
                <div style={{
                    background: '#ef444411',
                    border: '1px solid #ef444444',
                    borderRadius: '6px',
                    padding: '0.5rem 0.75rem',
                    color: '#ef4444',
                    fontSize: '12px',
                    marginBottom: '0.75rem',
                }}>
                    {error}
                </div>
            )}

            {!dashboardState && !error && (
                <div style={{ color: '#6b7280', fontSize: '13px' }}>Loading governance state…</div>
            )}

            {dashboardState && (
                <>
                    {/* KPI bar */}
                    <KpiBar state={dashboardState} />

                    {/* Pending Approval Queue */}
                    <div style={{ marginBottom: '1.25rem' }}>
                        <div style={{ color: '#9ca3af', fontSize: '12px', fontWeight: 600, marginBottom: '0.5rem' }}>
                            PENDING APPROVAL QUEUE ({dashboardState.pendingQueue.length})
                        </div>
                        {dashboardState.pendingQueue.length === 0 ? (
                            <div style={{ color: '#6b7280', fontSize: '13px' }}>
                                No pending approvals. Proposals will appear here when human review is required.
                            </div>
                        ) : (
                            dashboardState.recentDecisions
                                .filter(d => d.status === 'pending' || d.status === 'escalated')
                                .map(decision => (
                                    <ApprovalCard
                                        key={decision.decisionId}
                                        decision={decision}
                                        onApprove={handleApprove}
                                        onReject={handleReject}
                                        onDefer={handleDefer}
                                        onSatisfyConfirmation={handleSatisfyConfirmation}
                                        loading={loading}
                                    />
                                ))
                        )}
                    </div>

                    {/* Decision History */}
                    {dashboardState.recentDecisions.filter(d =>
                        d.status !== 'pending' && d.status !== 'escalated',
                    ).length > 0 && (
                        <div>
                            <div style={{ color: '#9ca3af', fontSize: '12px', fontWeight: 600, marginBottom: '0.5rem' }}>
                                DECISION HISTORY
                            </div>
                            {dashboardState.recentDecisions
                                .filter(d => d.status !== 'pending' && d.status !== 'escalated')
                                .slice(0, 15)
                                .map(decision => (
                                    <DecisionHistoryRow key={decision.decisionId} decision={decision} />
                                ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export default GovernancePanel;
