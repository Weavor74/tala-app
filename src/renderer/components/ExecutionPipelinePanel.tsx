import React, { useState, useEffect, useCallback } from 'react';
import type {
    ExecutionRun,
    ExecutionStatus,
    ExecutionDashboardState,
    ExecutionAuditRecord,
    ExecutionTelemetryEvent,
} from '../../../shared/executionTypes';

/**
 * ExecutionPipelinePanel
 *
 * Phase 3 P3I — Controlled Execution Dashboard Panel
 *
 * Integrated into ReflectionPanel as the 'execution' sub-tab under Engineering.
 *
 * Shows:
 * - Promoted proposals ready for execution
 * - Active execution pipeline state
 * - Verification progress
 * - Rollback state
 * - Final outcomes
 * - Audit trail summary
 */

// ─── Status helpers ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<ExecutionStatus, { label: string; color: string; icon: string }> = {
    pending_execution: { label: 'Pending', color: '#6b7280', icon: '⏳' },
    validating:        { label: 'Validating', color: '#3b82f6', icon: '🔍' },
    ready_to_apply:    { label: 'Ready', color: '#06b6d4', icon: '✅' },
    applying:          { label: 'Applying', color: '#f59e0b', icon: '⚙️' },
    verifying:         { label: 'Verifying', color: '#8b5cf6', icon: '🧪' },
    succeeded:         { label: 'Succeeded', color: '#10b981', icon: '✅' },
    failed_verification: { label: 'Failed Verification', color: '#f97316', icon: '❌' },
    rollback_pending:  { label: 'Rollback Pending', color: '#f59e0b', icon: '⚠️' },
    rolling_back:      { label: 'Rolling Back', color: '#f59e0b', icon: '↩️' },
    rolled_back:       { label: 'Rolled Back', color: '#eab308', icon: '↩️' },
    aborted:           { label: 'Aborted', color: '#ef4444', icon: '🚫' },
    execution_blocked: { label: 'Blocked', color: '#ef4444', icon: '🔒' },
};

const TERMINAL_STATUSES = new Set<ExecutionStatus>([
    'succeeded', 'rolled_back', 'aborted', 'execution_blocked',
]);

function StatusBadge({ status }: { status: ExecutionStatus }) {
    const cfg = STATUS_CONFIG[status] ?? { label: status, color: '#6b7280', icon: '•' };
    return (
        <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '2px 8px',
            borderRadius: '12px',
            fontSize: '12px',
            fontWeight: 600,
            background: `${cfg.color}22`,
            color: cfg.color,
            border: `1px solid ${cfg.color}44`,
        }}>
            {cfg.icon} {cfg.label}
        </span>
    );
}

// ─── Proposal Row ─────────────────────────────────────────────────────────────

interface PromotedProposalRowProps {
    proposal: any;
    onExecute: (id: string, dry: boolean) => void;
    disabled: boolean;
}

function PromotedProposalRow({ proposal, onExecute, disabled }: PromotedProposalRowProps) {
    const riskColor = proposal.riskScore <= 30 ? '#10b981' : proposal.riskScore <= 60 ? '#f59e0b' : '#ef4444';
    return (
        <div style={{
            background: '#1f2937',
            border: '1px solid #374151',
            borderRadius: '8px',
            padding: '1rem',
            marginBottom: '0.5rem',
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                <div>
                    <div style={{ fontWeight: 600, color: '#f9fafb', fontSize: '14px' }}>
                        {proposal.title}
                    </div>
                    <div style={{ color: '#9ca3af', fontSize: '12px', marginTop: '2px' }}>
                        {proposal.targetSubsystem} · {proposal.targetFiles?.length ?? 0} file(s) · Risk: <span style={{ color: riskColor }}>{proposal.riskScore}</span>
                    </div>
                </div>
                <StatusBadge status="ready_to_apply" />
            </div>
            <div style={{ color: '#6b7280', fontSize: '12px', marginBottom: '0.75rem' }}>
                {proposal.description?.slice(0, 120)}{proposal.description?.length > 120 ? '…' : ''}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                    onClick={() => onExecute(proposal.proposalId, false)}
                    disabled={disabled}
                    style={{
                        padding: '6px 14px',
                        background: disabled ? '#374151' : '#2563eb',
                        color: disabled ? '#6b7280' : '#fff',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        fontSize: '13px',
                        fontWeight: 600,
                    }}
                >
                    ▶ Execute
                </button>
                <button
                    onClick={() => onExecute(proposal.proposalId, true)}
                    disabled={disabled}
                    style={{
                        padding: '6px 14px',
                        background: 'transparent',
                        color: disabled ? '#6b7280' : '#9ca3af',
                        border: `1px solid ${disabled ? '#374151' : '#4b5563'}`,
                        borderRadius: '6px',
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        fontSize: '13px',
                    }}
                >
                    🔬 Dry Run
                </button>
            </div>
        </div>
    );
}

// ─── Active Run Panel ─────────────────────────────────────────────────────────

function ActiveRunPanel({ run, onAbort, onManualCheck }: {
    run: ExecutionRun;
    onAbort: (id: string) => void;
    onManualCheck: (id: string, passed: boolean) => void;
}) {
    const milestoneNames = run.milestones.map(m => m.name);
    const stages: ExecutionStatus[] = [
        'validating', 'ready_to_apply', 'applying', 'verifying', 'succeeded',
    ];

    return (
        <div style={{
            background: '#1f2937',
            border: '1px solid #374151',
            borderRadius: '8px',
            padding: '1rem',
            marginBottom: '1rem',
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <div style={{ fontWeight: 600, color: '#f9fafb' }}>
                    Active Execution
                </div>
                <StatusBadge status={run.status} />
            </div>

            <div style={{ color: '#9ca3af', fontSize: '12px', marginBottom: '0.75rem' }}>
                Proposal: <code style={{ color: '#a5b4fc' }}>{run.proposalId.slice(0, 8)}…</code>
                {' · '}
                Subsystem: <code style={{ color: '#a5b4fc' }}>{run.subsystemId}</code>
                {run.dryRun && <span style={{ color: '#f59e0b', marginLeft: '8px' }}>DRY RUN</span>}
            </div>

            {/* Pipeline progress */}
            <div style={{ display: 'flex', gap: '4px', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
                {stages.map(stage => {
                    const cfg = STATUS_CONFIG[stage];
                    const isActive = run.status === stage;
                    const isPast = stages.indexOf(stage) < stages.indexOf(run.status as any);
                    return (
                        <div key={stage} style={{
                            padding: '3px 8px',
                            borderRadius: '4px',
                            fontSize: '11px',
                            fontWeight: isActive ? 700 : 400,
                            background: isActive ? `${cfg.color}33` : isPast ? '#1a2332' : 'transparent',
                            color: isActive ? cfg.color : isPast ? '#4b5563' : '#6b7280',
                            border: `1px solid ${isActive ? cfg.color : '#2d3748'}`,
                        }}>
                            {cfg.icon} {cfg.label}
                        </div>
                    );
                })}
            </div>

            {/* Verification details */}
            {run.verificationResult && (
                <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '0.75rem' }}>
                    Verification: {run.verificationResult.stepResults.length} step(s),{' '}
                    {run.verificationResult.failedSteps.length} failed
                    {run.verificationResult.manualCheckRequired && !run.verificationResult.manualCheckRecorded && (
                        <span style={{ color: '#f59e0b', marginLeft: '8px' }}>⚠️ Manual check pending</span>
                    )}
                </div>
            )}

            {/* Manual check buttons */}
            {run.status === 'verifying' &&
                run.verificationResult?.manualCheckRequired &&
                !run.verificationResult?.manualCheckRecorded && (
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                    <button onClick={() => onManualCheck(run.executionId, true)} style={{ padding: '5px 12px', background: '#065f46', color: '#10b981', border: 'none', borderRadius: '5px', cursor: 'pointer', fontSize: '12px' }}>
                        ✅ Mark Check Passed
                    </button>
                    <button onClick={() => onManualCheck(run.executionId, false)} style={{ padding: '5px 12px', background: '#7f1d1d', color: '#f87171', border: 'none', borderRadius: '5px', cursor: 'pointer', fontSize: '12px' }}>
                        ❌ Mark Check Failed
                    </button>
                </div>
            )}

            {/* Target files */}
            {run.targetFiles.length > 0 && (
                <div style={{ fontSize: '11px', color: '#6b7280' }}>
                    Files: {run.targetFiles.join(', ')}
                </div>
            )}

            {!TERMINAL_STATUSES.has(run.status) && (
                <button
                    onClick={() => onAbort(run.executionId)}
                    style={{ marginTop: '0.75rem', padding: '5px 12px', background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', borderRadius: '5px', cursor: 'pointer', fontSize: '12px' }}
                >
                    ⛔ Abort
                </button>
            )}
        </div>
    );
}

// ─── Audit Log Panel ──────────────────────────────────────────────────────────

function AuditLogPanel({ records }: { records: ExecutionAuditRecord[] }) {
    return (
        <div style={{ maxHeight: '200px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '11px' }}>
            {records.length === 0 ? (
                <div style={{ color: '#6b7280', padding: '0.5rem' }}>No audit records.</div>
            ) : (
                records.map(r => (
                    <div key={r.auditId} style={{
                        padding: '2px 4px',
                        borderBottom: '1px solid #1f2937',
                        color: r.event.includes('fail') || r.event === 'aborted' ? '#f87171'
                            : r.event.includes('passed') || r.event === 'succeeded' ? '#34d399'
                            : '#9ca3af',
                    }}>
                        <span style={{ color: '#4b5563' }}>{r.timestamp.slice(11, 19)}</span>
                        {' '}[{r.stage}] {r.event} — {r.detail}
                    </div>
                ))
            )}
        </div>
    );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

const ExecutionPipelinePanel: React.FC = () => {
    const [dashboardState, setDashboardState] = useState<ExecutionDashboardState | null>(null);
    const [promotedProposals, setPromotedProposals] = useState<any[]>([]);
    const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
    const [auditLog, setAuditLog] = useState<ExecutionAuditRecord[]>([]);
    const [telemetryEvents, setTelemetryEvents] = useState<ExecutionTelemetryEvent[]>([]);
    const [notification, setNotification] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const tala = (window as any).tala;

    const fetchData = useCallback(async () => {
        if (!tala) return;
        try {
            let promotedCount = 0;
            if (tala.listProposals) {
                const all = await tala.listProposals();
                const promoted = (all ?? []).filter((p: any) => p.status === 'promoted');
                setPromotedProposals(promoted);
                promotedCount = promoted.length;
            }
            if (tala.getExecutionDashboardState) {
                const state = await tala.getExecutionDashboardState(promotedCount);
                setDashboardState(state);
            }
        } catch (e) {
            console.error('[ExecutionPipelinePanel] fetchData error:', e);
        }
    }, []);

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 15_000);

        const unsub = tala?.onExecutionUpdate?.((state: ExecutionDashboardState) => {
            setDashboardState(state);
        });
        const unsubTelem = tala?.onExecutionTelemetry?.((ev: ExecutionTelemetryEvent) => {
            setTelemetryEvents(prev => [ev, ...prev].slice(0, 200));
        });

        return () => {
            clearInterval(interval);
            unsub?.();
            unsubTelem?.();
        };
    }, [fetchData]);

    const handleExecute = async (proposalId: string, dryRun: boolean) => {
        setLoading(true);
        try {
            const resp = dryRun
                ? await tala.startDryRun({ proposalId, authorizedBy: 'user_explicit' })
                : await tala.startExecution({ proposalId, authorizedBy: 'user_explicit' });

            if (resp.blocked) {
                setNotification(`⛔ Blocked: ${resp.message}`);
            } else {
                setNotification(dryRun
                    ? `🔬 Dry run started (${resp.executionId?.slice(0, 8)}…)`
                    : `▶ Execution started (${resp.executionId?.slice(0, 8)}…)`);
                fetchData();
            }
        } catch (e: any) {
            setNotification(`Error: ${e.message}`);
        } finally {
            setLoading(false);
            setTimeout(() => setNotification(null), 5000);
        }
    };

    const handleAbort = async (executionId: string) => {
        if (!tala.abortExecution) return;
        await tala.abortExecution({ executionId, reason: 'User aborted from dashboard' });
        fetchData();
    };

    const handleManualCheck = async (executionId: string, passed: boolean) => {
        if (!tala.recordManualCheck) return;
        await tala.recordManualCheck(executionId, passed);
        fetchData();
    };

    const handleViewAudit = async (executionId: string) => {
        if (selectedRunId === executionId) {
            setSelectedRunId(null);
            setAuditLog([]);
            return;
        }
        setSelectedRunId(executionId);
        if (tala.getExecutionAuditLog) {
            const records = await tala.getExecutionAuditLog(executionId);
            setAuditLog(records ?? []);
        }
    };

    const kpis = dashboardState?.kpis;

    return (
        <div style={{ padding: '1rem', color: '#e5e7eb' }}>
            {/* Notification banner */}
            {notification && (
                <div style={{
                    background: notification.startsWith('⛔') || notification.startsWith('Error')
                        ? 'rgba(239,68,68,0.15)' : 'rgba(59,130,246,0.15)',
                    border: `1px solid ${notification.startsWith('⛔') || notification.startsWith('Error') ? '#ef4444' : '#3b82f6'}`,
                    padding: '0.6rem 1rem',
                    borderRadius: '8px',
                    marginBottom: '1rem',
                    fontSize: '13px',
                }}>
                    {notification}
                </div>
            )}

            {/* KPI row */}
            {kpis && (
                <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
                    {[
                        { label: 'Total', value: kpis.totalExecutions, color: '#6b7280' },
                        { label: 'Succeeded', value: kpis.succeeded, color: '#10b981' },
                        { label: 'Failed Verification', value: kpis.failedVerification, color: '#f97316' },
                        { label: 'Rolled Back', value: kpis.rolledBack, color: '#eab308' },
                        { label: 'Aborted', value: kpis.aborted, color: '#ef4444' },
                        { label: 'Active', value: kpis.activeExecutions, color: '#3b82f6' },
                    ].map(({ label, value, color }) => (
                        <div key={label} style={{
                            background: '#1f2937',
                            border: '1px solid #374151',
                            borderRadius: '8px',
                            padding: '0.5rem 0.9rem',
                            textAlign: 'center',
                        }}>
                            <div style={{ color, fontSize: '20px', fontWeight: 700 }}>{value}</div>
                            <div style={{ color: '#6b7280', fontSize: '11px' }}>{label}</div>
                        </div>
                    ))}
                </div>
            )}

            {/* Active execution */}
            {dashboardState?.activeRun && (
                <div style={{ marginBottom: '1.25rem' }}>
                    <div style={{ color: '#9ca3af', fontSize: '12px', fontWeight: 600, marginBottom: '0.5rem' }}>
                        ACTIVE EXECUTION
                    </div>
                    <ActiveRunPanel
                        run={dashboardState.activeRun}
                        onAbort={handleAbort}
                        onManualCheck={handleManualCheck}
                    />
                </div>
            )}

            {/* Promoted proposals ready */}
            <div style={{ marginBottom: '1.25rem' }}>
                <div style={{ color: '#9ca3af', fontSize: '12px', fontWeight: 600, marginBottom: '0.5rem' }}>
                    PROMOTED PROPOSALS READY ({promotedProposals.length})
                </div>
                {promotedProposals.length === 0 ? (
                    <div style={{ color: '#6b7280', fontSize: '13px' }}>
                        No promoted proposals available. Use the Change Proposals tab to review and promote proposals.
                    </div>
                ) : (
                    promotedProposals.map(p => (
                        <PromotedProposalRow
                            key={p.proposalId}
                            proposal={p}
                            onExecute={handleExecute}
                            disabled={loading || !!dashboardState?.activeRun}
                        />
                    ))
                )}
            </div>

            {/* Recent runs */}
            {(dashboardState?.recentRuns?.length ?? 0) > 0 && (
                <div style={{ marginBottom: '1.25rem' }}>
                    <div style={{ color: '#9ca3af', fontSize: '12px', fontWeight: 600, marginBottom: '0.5rem' }}>
                        RECENT EXECUTIONS
                    </div>
                    {dashboardState!.recentRuns.map(run => (
                        <div key={run.executionId} style={{
                            background: '#1f2937',
                            border: '1px solid #374151',
                            borderRadius: '6px',
                            padding: '0.6rem 0.9rem',
                            marginBottom: '0.35rem',
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                    <code style={{ color: '#a5b4fc', fontSize: '11px' }}>{run.executionId.slice(0, 8)}…</code>
                                    <span style={{ color: '#6b7280', fontSize: '11px', marginLeft: '8px' }}>{run.subsystemId}</span>
                                    {run.dryRun && <span style={{ color: '#f59e0b', fontSize: '10px', marginLeft: '6px' }}>DRY RUN</span>}
                                </div>
                                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                    <StatusBadge status={run.status} />
                                    <button
                                        onClick={() => handleViewAudit(run.executionId)}
                                        style={{
                                            padding: '2px 8px',
                                            background: 'transparent',
                                            color: '#6b7280',
                                            border: '1px solid #374151',
                                            borderRadius: '4px',
                                            cursor: 'pointer',
                                            fontSize: '10px',
                                        }}
                                    >
                                        {selectedRunId === run.executionId ? '▲ Hide' : '▼ Audit'}
                                    </button>
                                </div>
                            </div>

                            {selectedRunId === run.executionId && (
                                <div style={{ marginTop: '0.5rem' }}>
                                    <AuditLogPanel records={auditLog} />
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* Telemetry stream */}
            {telemetryEvents.length > 0 && (
                <div>
                    <div style={{ color: '#9ca3af', fontSize: '12px', fontWeight: 600, marginBottom: '0.5rem' }}>
                        EXECUTION TELEMETRY ({telemetryEvents.length})
                    </div>
                    <div style={{ maxHeight: '150px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '11px' }}>
                        {telemetryEvents.slice(0, 50).map(ev => (
                            <div key={ev.eventId} style={{ padding: '1px 4px', color: ev.category === 'error' ? '#f87171' : '#6b7280' }}>
                                <span style={{ color: '#4b5563' }}>{ev.timestamp.slice(11, 19)}</span>
                                {' '}[{ev.category}] {ev.message}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default ExecutionPipelinePanel;
