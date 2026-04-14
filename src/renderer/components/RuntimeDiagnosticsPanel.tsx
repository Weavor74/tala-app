import React, { useState, useEffect, useCallback } from 'react';
import type {
    RuntimeDiagnosticsSnapshot,
    McpServiceDiagnostics,
} from '../../../shared/runtimeDiagnosticsTypes';

/**
 * RuntimeDiagnosticsPanel — Phase 2B Minimal Diagnostics Panel
 *
 * Displays a normalized view of the current runtime state:
 * - Inference provider status and stream state
 * - MCP service inventory with health indicators
 * - Provider health scores and suppressions
 * - Recent operator actions
 * - Recent failures
 *
 * Data contract:
 * - All data comes exclusively from diagnostics:getRuntimeSnapshot
 * - No provider probing or service calls in the renderer
 * - Control actions are dispatched via diagnostics:* IPC handlers
 */

const tala = () => (window as any).tala;

// ─── Status badge helpers ─────────────────────────────────────────────────────

function statusColor(status: string): string {
    switch (status) {
        case 'healthy': return '#22c55e';
        case 'maintenance':
        case 'recovery': return '#f59e0b';
        case 'impaired':
        case 'failed': return '#ef4444';
        case 'ready': return '#22c55e';
        case 'starting':
        case 'recovering': return '#f59e0b';
        case 'busy':
        case 'streaming': return '#3b82f6';
        case 'degraded': return '#f97316';
        case 'unavailable':
        case 'failed': return '#ef4444';
        case 'disabled':
        case 'stopped': return '#6b7280';
        default: return '#9ca3af';
    }
}

function StatusBadge({ status }: { status: string }) {
    return (
        <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 7px',
            borderRadius: 10,
            background: statusColor(status) + '22',
            color: statusColor(status),
            border: `1px solid ${statusColor(status)}55`,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
        }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor(status), display: 'inline-block' }} />
            {status}
        </span>
    );
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9ca3af', marginBottom: 6, padding: '0 2px' }}>
                {title}
            </div>
            <div style={{ background: '#1f2937', borderRadius: 8, padding: '10px 12px', border: '1px solid #374151' }}>
                {children}
            </div>
        </div>
    );
}

// ─── Provider row ─────────────────────────────────────────────────────────────

interface ProviderRowProps {
    id: string;
    name: string;
    status: string;
    selected: boolean;
    suppressed: boolean;
    failureStreak: number;
    onRestart: () => void;
    onDisable: () => void;
    onEnable: () => void;
    onForceSelect: () => void;
    busy: boolean;
}

function ProviderRow({ name, status, selected, suppressed, failureStreak, onRestart, onDisable, onEnable, onForceSelect, busy }: ProviderRowProps) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid #374151' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, color: selected ? '#60a5fa' : '#e5e7eb', fontWeight: selected ? 600 : 400 }}>
                    {name}
                    {selected && <span style={{ marginLeft: 5, fontSize: 10, color: '#60a5fa' }}>✦ selected</span>}
                    {suppressed && <span style={{ marginLeft: 5, fontSize: 10, color: '#ef4444' }}>● suppressed</span>}
                </span>
                {failureStreak > 0 && (
                    <span style={{ marginLeft: 5, fontSize: 10, color: '#f97316' }}>
                        streak:{failureStreak}
                    </span>
                )}
            </div>
            <StatusBadge status={suppressed ? 'disabled' : status} />
            <div style={{ display: 'flex', gap: 4 }}>
                <ControlButton label="↺" title="Restart / Re-probe provider" onClick={onRestart} disabled={busy} />
                {suppressed
                    ? <ControlButton label="✓" title="Re-enable provider" onClick={onEnable} disabled={busy} />
                    : <ControlButton label="✕" title="Disable provider" onClick={onDisable} disabled={busy} />
                }
                <ControlButton label="→" title="Force-select this provider" onClick={onForceSelect} disabled={busy} />
            </div>
        </div>
    );
}

// ─── MCP row ──────────────────────────────────────────────────────────────────

interface McpRowProps {
    svc: McpServiceDiagnostics;
    onRestart: () => void;
    onDisable: () => void;
    onEnable: () => void;
    busy: boolean;
}

function McpRow({ svc, onRestart, onDisable, onEnable, busy }: McpRowProps) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid #374151' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, color: '#e5e7eb' }}>{svc.displayName}</span>
                {svc.restartCount > 0 && (
                    <span style={{ marginLeft: 5, fontSize: 10, color: '#9ca3af' }}>restarts:{svc.restartCount}</span>
                )}
            </div>
            <StatusBadge status={!svc.enabled ? 'disabled' : svc.status} />
            <div style={{ display: 'flex', gap: 4 }}>
                {svc.enabled
                    ? <>
                        <ControlButton label="↺" title="Restart MCP service" onClick={onRestart} disabled={busy} />
                        <ControlButton label="✕" title="Disable MCP service" onClick={onDisable} disabled={busy} />
                      </>
                    : <ControlButton label="✓" title="Enable MCP service" onClick={onEnable} disabled={busy} />
                }
            </div>
        </div>
    );
}

// ─── Control button ───────────────────────────────────────────────────────────

function ControlButton({ label, title, onClick, disabled }: { label: string; title: string; onClick: () => void; disabled?: boolean }) {
    return (
        <button
            title={title}
            onClick={onClick}
            disabled={disabled}
            style={{
                background: disabled ? '#374151' : '#2d3748',
                color: disabled ? '#6b7280' : '#e5e7eb',
                border: '1px solid #4b5563',
                borderRadius: 4,
                padding: '2px 7px',
                fontSize: 12,
                cursor: disabled ? 'not-allowed' : 'pointer',
                lineHeight: '16px',
            }}
        >
            {label}
        </button>
    );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

const RuntimeDiagnosticsPanel: React.FC = () => {
    const [snapshot, setSnapshot] = useState<RuntimeDiagnosticsSnapshot | null>(null);
    const [operatorState, setOperatorState] = useState<any | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [actionBusy, setActionBusy] = useState(false);
    const [notification, setNotification] = useState<string | null>(null);
    const api = tala();

    const fetchSnapshot = useCallback(async () => {
        try {
            if (!api?.getRuntimeSnapshot) {
                setError('Runtime diagnostics API not available');
                setLoading(false);
                return;
            }
            const snap = await api.getRuntimeSnapshot();
            setSnapshot(snap);
            if (api?.getOperatorActionState) {
                const opState = await api.getOperatorActionState();
                setOperatorState(opState);
            }
            setError(null);
        } catch (e: any) {
            setError(`Failed to load snapshot: ${e.message}`);
        } finally {
            setLoading(false);
        }
    }, [api]);

    useEffect(() => {
        fetchSnapshot();
        const interval = setInterval(fetchSnapshot, 5000);
        return () => clearInterval(interval);
    }, [fetchSnapshot]);

    function showNotification(msg: string) {
        setNotification(msg);
        setTimeout(() => setNotification(null), 3000);
    }

    async function runAction(fn: () => Promise<any>, label: string) {
        setActionBusy(true);
        try {
            const result = await fn();
            showNotification(result?.error ? `${label}: ${result.error}` : `${label}: done`);
        } catch (e: any) {
            showNotification(`${label}: ${e.message}`);
        } finally {
            setActionBusy(false);
            fetchSnapshot();
        }
    }

    async function runOperatorAction(action: string, label: string, params?: Record<string, unknown>) {
        return runAction(
            () => api.executeOperatorAction?.({
                action,
                requested_by: 'dashboard_operator',
                params,
            }),
            label,
        );
    }

    if (loading) {
        return <div style={{ padding: 20, color: '#9ca3af', fontSize: 13 }}>Loading runtime diagnostics…</div>;
    }

    if (error || !snapshot) {
        return (
            <div style={{ padding: 20, color: '#ef4444', fontSize: 13 }}>
                {error ?? 'No snapshot available.'}
                <button onClick={fetchSnapshot} style={{ marginLeft: 8, fontSize: 12, color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer' }}>Retry</button>
            </div>
        );
    }

    const { inference, mcp, recentFailures, providerHealthScores, suppressedProviders, operatorActions, recentProviderRecoveries, systemHealth } = snapshot;
    const selectedId = inference.selectedProviderId;
    const latestOperator = operatorState?.actions?.slice?.(-5)?.reverse?.() ?? [];
    const latestAuto = operatorState?.auto_actions?.slice?.(-3)?.reverse?.() ?? [];

    return (
        <div style={{ padding: '14px 16px', fontFamily: 'system-ui, sans-serif', color: '#e5e7eb', maxWidth: 560, fontSize: 13 }}>

            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: '#f3f4f6', letterSpacing: '-0.01em' }}>
                    TALA Runtime Status
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                    <ControlButton label="↺ Probe All" title="Re-probe all inference providers" onClick={() => runAction(() => api.probeProviders?.(), 'Probe providers')} disabled={actionBusy} />
                    <ControlButton label="↺ Probe MCP" title="Re-probe all MCP services" onClick={() => runAction(() => api.probeMcpServices?.(), 'Probe MCP')} disabled={actionBusy} />
                    <ControlButton label="⟳" title="Refresh snapshot" onClick={fetchSnapshot} disabled={loading} />
                </div>
            </div>

            {/* Notification */}
            {notification && (
                <div style={{ marginBottom: 10, padding: '6px 10px', background: '#1e3a5f', borderRadius: 6, fontSize: 12, color: '#93c5fd', border: '1px solid #2563eb44' }}>
                    {notification}
                </div>
            )}
            {/* Canonical system health alert */}
            {systemHealth.overall_status !== 'healthy' && (
                <div style={{ marginBottom: 12, padding: '6px 10px', background: '#7c2d1222', borderRadius: 6, fontSize: 12, color: '#f97316', border: '1px solid #f9731644' }}>
                    System health: <strong>{systemHealth.overall_status.toUpperCase()}</strong>
                    {systemHealth.operator_attention_required ? ' (operator attention required)' : ''}
                </div>
            )}

            <Section title="System Health">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <StatusBadge status={systemHealth.overall_status} />
                    <span style={{ fontSize: 12, color: '#9ca3af' }}>
                        trust: {Math.round(systemHealth.trust_score * 100)}%
                    </span>
                </div>
                <div style={{ fontSize: 12, color: '#d1d5db', marginBottom: 8 }}>
                    effective mode: <strong>{systemHealth.effective_mode}</strong>
                </div>
                {systemHealth.active_degradation_flags.length > 0 && (
                    <div style={{ fontSize: 11, color: '#f59e0b', marginBottom: 8 }}>
                        flags: {systemHealth.active_degradation_flags.join(', ')}
                    </div>
                )}
                <div style={{ fontSize: 11, color: '#9ca3af' }}>
                    {systemHealth.subsystem_entries.filter((s) => s.status !== 'healthy').slice(0, 4).map((s) => (
                        <div key={s.name}>{s.name}: {s.status}</div>
                    ))}
                    {systemHealth.subsystem_entries.every((s) => s.status === 'healthy') && (
                        <div>All canonical health adapters are healthy.</div>
                    )}
                </div>
                {systemHealth.mode_contract.blocked_capabilities.length > 0 && (
                    <div style={{ fontSize: 11, color: '#fca5a5', marginTop: 8 }}>
                        blocked capabilities: {systemHealth.mode_contract.blocked_capabilities.join(', ')}
                    </div>
                )}
            </Section>

            <Section title="Operator Controls">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                    <ControlButton label="Pause Autonomy" title="Pause autonomy" onClick={() => runOperatorAction('pause_autonomy', 'Pause autonomy')} disabled={actionBusy} />
                    <ControlButton label="Resume Autonomy" title="Resume autonomy" onClick={() => runOperatorAction('resume_autonomy', 'Resume autonomy')} disabled={actionBusy} />
                    <ControlButton label="Safe Mode" title="Enter safe mode" onClick={() => runOperatorAction('enter_safe_mode', 'Enter safe mode')} disabled={actionBusy} />
                    <ControlButton label="Exit Safe" title="Exit safe mode" onClick={() => runOperatorAction('exit_safe_mode', 'Exit safe mode', { operator_approved: true })} disabled={actionBusy} />
                    <ControlButton label="Maintenance" title="Enter maintenance mode" onClick={() => runOperatorAction('enter_maintenance_mode', 'Enter maintenance mode')} disabled={actionBusy} />
                    <ControlButton label="Clear Maint." title="Clear maintenance mode" onClick={() => runOperatorAction('clear_maintenance_mode', 'Clear maintenance mode', { operator_approved: true })} disabled={actionBusy} />
                    <ControlButton label="Retry Health" title="Retry subsystem health checks" onClick={() => runOperatorAction('retry_subsystem_health_check', 'Retry health checks')} disabled={actionBusy} />
                    <ControlButton label="Revalidate DB" title="Re-run DB health validation" onClick={() => runOperatorAction('rerun_db_health_validation', 'Revalidate DB')} disabled={actionBusy} />
                    <ControlButton label="Revalidate Memory" title="Revalidate memory authority" onClick={() => runOperatorAction('revalidate_memory_authority', 'Revalidate memory')} disabled={actionBusy} />
                    <ControlButton label="Export Health" title="Export health snapshot" onClick={() => runOperatorAction('export_health_snapshot', 'Export health snapshot')} disabled={actionBusy} />
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>
                    self-improvement locked: {operatorState?.visibility?.self_improvement_locked ? 'yes' : 'no'}
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>
                    high-risk approval required: {operatorState?.visibility?.high_risk_human_approval_required ? 'yes' : 'no'}
                </div>
            </Section>
            {/* Inference section */}
            <Section title="Inference">
                <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                    <div>
                        <span style={{ color: '#9ca3af', fontSize: 11 }}>Provider</span>
                        <div style={{ fontWeight: 600 }}>{inference.selectedProviderName ?? '—'}</div>
                    </div>
                    <div>
                        <span style={{ color: '#9ca3af', fontSize: 11 }}>Stream</span>
                        <div><StatusBadge status={inference.streamStatus} /></div>
                    </div>
                    <div>
                        <span style={{ color: '#9ca3af', fontSize: 11 }}>Fallback</span>
                        <div style={{ color: inference.fallbackApplied ? '#f97316' : '#9ca3af' }}>
                            {inference.fallbackApplied ? 'applied' : 'none'}
                        </div>
                    </div>
                </div>
                {inference.lastFailureReason && (
                    <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>
                        Last failure: {inference.lastFailureReason}
                    </div>
                )}
                {(suppressedProviders?.length ?? 0) > 0 && (
                    <div style={{ fontSize: 11, color: '#f97316', marginTop: 4 }}>
                        Suppressed providers: {suppressedProviders.join(', ')}
                    </div>
                )}
            </Section>

            {/* Providers section */}
            <Section title="Providers">
                {(snapshot.mcp?.services?.length === 0 && !inference.selectedProviderId && !inference.providerInventorySummary.total) ? (
                    <div style={{ color: '#6b7280', fontSize: 12 }}>No providers detected.</div>
                ) : null}
                <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 12, color: '#9ca3af' }}>
                    <span>Total: {inference.providerInventorySummary.total}</span>
                    <span style={{ color: '#22c55e' }}>Ready: {inference.providerInventorySummary.ready}</span>
                    {inference.providerInventorySummary.degraded > 0 && <span style={{ color: '#f97316' }}>Degraded: {inference.providerInventorySummary.degraded}</span>}
                    {inference.providerInventorySummary.unavailable > 0 && <span style={{ color: '#ef4444' }}>Unavailable: {inference.providerInventorySummary.unavailable}</span>}
                </div>
                {/* Per-provider rows from health scores */}
                {(providerHealthScores ?? []).length > 0 && (providerHealthScores ?? []).map(score => (
                    <ProviderRow
                        key={score.providerId}
                        id={score.providerId}
                        name={score.providerId}
                        status={score.suppressed ? 'disabled' : (score.failureStreak >= 3 ? 'degraded' : 'ready')}
                        selected={score.providerId === selectedId}
                        suppressed={score.suppressed}
                        failureStreak={score.failureStreak}
                        onRestart={() => runAction(() => api.restartProvider?.(score.providerId), `Restart ${score.providerId}`)}
                        onDisable={() => runAction(() => api.disableProvider?.(score.providerId), `Disable ${score.providerId}`)}
                        onEnable={() => runAction(() => api.enableProvider?.(score.providerId), `Enable ${score.providerId}`)}
                        onForceSelect={() => runAction(() => api.forceProviderSelection?.(score.providerId), `Select ${score.providerId}`)}
                        busy={actionBusy}
                    />
                ))}
            </Section>

            {/* MCP Services section */}
            <Section title="MCP Services">
                {mcp.services.length === 0 ? (
                    <div style={{ color: '#6b7280', fontSize: 12 }}>No MCP services configured.</div>
                ) : (
                    <>
                        <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 12, color: '#9ca3af' }}>
                            <span>Total: {mcp.totalConfigured}</span>
                            <span style={{ color: '#22c55e' }}>Ready: {mcp.totalReady}</span>
                            {mcp.totalDegraded > 0 && <span style={{ color: '#f97316' }}>Degraded: {mcp.totalDegraded}</span>}
                            {mcp.totalUnavailable > 0 && <span style={{ color: '#ef4444' }}>Unavailable: {mcp.totalUnavailable}</span>}
                        </div>
                        {mcp.services.map(svc => (
                            <McpRow
                                key={svc.serviceId}
                                svc={svc}
                                onRestart={() => runAction(() => api.restartMcpService?.(svc.serviceId), `Restart ${svc.displayName}`)}
                                onDisable={() => runAction(() => api.disableMcpService?.(svc.serviceId), `Disable ${svc.displayName}`)}
                                onEnable={() => runAction(() => api.enableMcpService?.(svc.serviceId), `Enable ${svc.displayName}`)}
                                busy={actionBusy}
                            />
                        ))}
                    </>
                )}
            </Section>

            {/* Recent Failures */}
            {recentFailures.count > 0 && (
                <Section title="Recent Failures">
                    <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>
                        {recentFailures.count} failure{recentFailures.count !== 1 ? 's' : ''} recorded
                    </div>
                    {recentFailures.lastFailureReason && (
                        <div style={{ fontSize: 12, color: '#ef4444' }}>{recentFailures.lastFailureReason}</div>
                    )}
                    {recentFailures.failedEntityIds.slice(0, 5).map((id, i) => (
                        <div key={i} style={{ fontSize: 11, color: '#6b7280' }}>• {id}</div>
                    ))}
                </Section>
            )}

            {/* Recent Operator Actions */}
            {(operatorActions ?? []).length > 0 && (
                <Section title="Recent Actions">
                    {operatorActions.slice(-5).reverse().map((a, i) => (
                        <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', borderBottom: '1px solid #2d3748', fontSize: 11 }}>
                            <span style={{ color: '#6b7280', minWidth: 90 }}>{new Date(a.timestamp).toLocaleTimeString()}</span>
                            <span style={{ color: '#9ca3af' }}>{a.action}</span>
                            <span style={{ color: '#e5e7eb' }}>{a.entityId}</span>
                            {a.newState && <span style={{ color: statusColor(a.newState) }}>→ {a.newState}</span>}
                        </div>
                    ))}
                </Section>
            )}

            {(latestOperator.length > 0 || latestAuto.length > 0) && (
                <Section title="Action Contract Audit">
                    {latestOperator.map((a: any, i: number) => (
                        <div key={`op-${i}`} style={{ display: 'flex', gap: 8, padding: '3px 0', borderBottom: '1px solid #2d3748', fontSize: 11 }}>
                            <span style={{ color: '#6b7280', minWidth: 90 }}>{new Date(a.executed_at).toLocaleTimeString()}</span>
                            <span style={{ color: a.allowed ? '#22c55e' : '#ef4444' }}>{a.allowed ? 'allowed' : 'denied'}</span>
                            <span style={{ color: '#9ca3af' }}>{a.action_id}</span>
                            <span style={{ color: '#e5e7eb' }}>{a.reason}</span>
                        </div>
                    ))}
                    {latestAuto.map((a: any, i: number) => (
                        <div key={`auto-${i}`} style={{ display: 'flex', gap: 8, padding: '3px 0', borderBottom: '1px solid #2d3748', fontSize: 11 }}>
                            <span style={{ color: '#6b7280', minWidth: 90 }}>{new Date(a.executed_at).toLocaleTimeString()}</span>
                            <span style={{ color: '#f59e0b' }}>auto</span>
                            <span style={{ color: '#9ca3af' }}>{a.action_id}</span>
                            <span style={{ color: '#e5e7eb' }}>{a.reason}</span>
                        </div>
                    ))}
                </Section>
            )}

            {/* Recent Recoveries */}
            {(recentProviderRecoveries ?? []).length > 0 && (
                <Section title="Provider Recoveries">
                    {recentProviderRecoveries.slice(-3).map((r, i) => (
                        <div key={i} style={{ fontSize: 11, color: '#22c55e', padding: '2px 0' }}>
                            ✓ {r.providerId} — {new Date(r.timestamp).toLocaleTimeString()}
                        </div>
                    ))}
                </Section>
            )}

            {/* Footer timestamp */}
            <div style={{ marginTop: 8, fontSize: 10, color: '#374151', textAlign: 'right' }}>
                Snapshot: {new Date(snapshot.timestamp).toLocaleTimeString()}
            </div>
        </div>
    );
};

export default RuntimeDiagnosticsPanel;

