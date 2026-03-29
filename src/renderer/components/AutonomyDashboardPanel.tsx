import React, { useState, useEffect, useCallback } from 'react';
import type {
    AutonomyDashboardState,
    AutonomousGoal,
    AutonomousRun,
    LearningRecord,
    AutonomyTelemetryEvent,
} from '../../shared/autonomyTypes';

/**
 * AutonomyDashboardPanel — Phase 4 P4G
 *
 * The Reflection Dashboard integration for autonomous self-improvement.
 *
 * Sections:
 *  - Global toggle (enable/disable autonomy)
 *  - KPI bar (goals, runs, success, fail, blocked)
 *  - Active autonomous runs (live status)
 *  - Pending goals queue (scored, awaiting selection)
 *  - Blocked goals (human review required)
 *  - Recent completed runs
 *  - Learning history (pattern confidence)
 *  - Live telemetry stream
 */
const AutonomyDashboardPanel: React.FC = () => {
    const [dashState, setDashState] = useState<AutonomyDashboardState | null>(null);
    const [loading, setLoading] = useState(true);
    const [notification, setNotification] = useState<string | null>(null);
    const [cycleRunning, setCycleRunning] = useState(false);

    const tala = (window as any).tala;

    const fetchData = useCallback(async () => {
        try {
            if (!tala?.autonomy?.getDashboardState) return;
            const state = await tala.autonomy.getDashboardState();
            setDashState(state);
        } catch (e: any) {
            console.error('[AutonomyDashboard] fetch error:', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 30_000);

        const unsub = tala?.autonomy?.onDashboardUpdate?.((data: AutonomyDashboardState) => {
            setDashState(data);
        });

        return () => {
            clearInterval(interval);
            unsub?.();
        };
    }, [fetchData]);

    const handleToggleAutonomy = async () => {
        if (!tala?.autonomy?.setGlobalEnabled || !dashState) return;
        const next = !dashState.globalAutonomyEnabled;
        try {
            await tala.autonomy.setGlobalEnabled(next);
            setNotification(`Autonomy ${next ? 'enabled' : 'disabled'}`);
            await fetchData();
        } catch (e: any) {
            setNotification(`Error: ${e.message}`);
        }
        setTimeout(() => setNotification(null), 4000);
    };

    const handleRunCycle = async () => {
        if (!tala?.autonomy?.runCycleOnce) return;
        setCycleRunning(true);
        try {
            await tala.autonomy.runCycleOnce();
            setNotification('Detection cycle triggered');
            await fetchData();
        } catch (e: any) {
            setNotification(`Error: ${e.message}`);
        } finally {
            setCycleRunning(false);
            setTimeout(() => setNotification(null), 4000);
        }
    };

    if (loading) {
        return (
            <div style={{ padding: '2rem', color: '#9ca3af' }}>
                Loading autonomy state...
            </div>
        );
    }

    const state = dashState;

    return (
        <div style={{ color: '#e5e7eb' }}>
            {/* Notification */}
            {notification && (
                <div style={{
                    background: 'linear-gradient(90deg, #1e40af, #3b82f6)',
                    color: '#fff',
                    padding: '0.75rem 1rem',
                    borderRadius: '8px',
                    marginBottom: '1rem',
                    fontSize: '0.875rem',
                    fontWeight: 600,
                }}>
                    🤖 {notification}
                </div>
            )}

            {/* Header: Global toggle + manual trigger */}
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginBottom: '1.5rem', padding: '1rem', background: '#1e293b',
                borderRadius: '8px', borderLeft: '4px solid #8b5cf6',
            }}>
                <div>
                    <h2 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 700 }}>
                        🤖 Autonomous Self-Improvement
                    </h2>
                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#6b7280' }}>
                        Policy-bounded, auditable, local-first improvement loop
                    </p>
                </div>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    <button
                        onClick={handleRunCycle}
                        disabled={cycleRunning}
                        style={{
                            background: '#374151', color: '#e5e7eb', border: '1px solid #4b5563',
                            padding: '0.4rem 0.9rem', borderRadius: '6px', fontSize: '0.8rem',
                            cursor: cycleRunning ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {cycleRunning ? '⏳ Running...' : '🔍 Scan Now'}
                    </button>
                    <button
                        onClick={handleToggleAutonomy}
                        style={{
                            background: state?.globalAutonomyEnabled ? '#065f46' : '#4b5563',
                            color: '#fff',
                            border: 'none',
                            padding: '0.4rem 0.9rem',
                            borderRadius: '6px',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                            fontWeight: 600,
                        }}
                    >
                        {state?.globalAutonomyEnabled ? '✅ Autonomy ON' : '⛔ Autonomy OFF'}
                    </button>
                </div>
            </div>

            {/* KPI bar */}
            {state && (
                <div style={{
                    display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)',
                    gap: '0.75rem', marginBottom: '1.5rem',
                }}>
                    <KpiCard title="Goals Detected" value={state.kpis.totalGoalsDetected} icon="🎯" />
                    <KpiCard title="Runs Started" value={state.kpis.totalRunsStarted} icon="▶️" />
                    <KpiCard title="Succeeded" value={state.kpis.totalRunsSucceeded} icon="✅" color="#10b981" />
                    <KpiCard title="Failed" value={state.kpis.totalRunsFailed + state.kpis.totalRunsRolledBack} icon="❌" color="#ef4444" />
                    <KpiCard title="Blocked" value={state.kpis.totalPolicyBlocked + state.kpis.totalGovernanceBlocked} icon="🛡️" color="#f59e0b" />
                </div>
            )}

            {/* Budget gauge */}
            {state && (
                <div style={{
                    display: 'flex', gap: '1rem', marginBottom: '1.5rem',
                    padding: '0.75rem 1rem', background: '#1e293b', borderRadius: '8px',
                    fontSize: '0.8rem', color: '#9ca3af', alignItems: 'center',
                }}>
                    <span>📊 Budget:</span>
                    <span style={{ color: '#e5e7eb', fontWeight: 600 }}>
                        {state.budgetUsedThisPeriod} / {state.budget.maxRunsPerPeriod} runs this period
                    </span>
                    <span>·</span>
                    <span>{state.kpis.activeRuns} active run{state.kpis.activeRuns !== 1 ? 's' : ''}</span>
                    <span>·</span>
                    <span>{state.kpis.pendingGoals} pending goal{state.kpis.pendingGoals !== 1 ? 's' : ''}</span>
                </div>
            )}

            {/* Active runs */}
            {state && state.activeRuns.length > 0 && (
                <Section title={`🔄 Active Autonomous Runs (${state.activeRuns.length})`} accent="#3b82f6">
                    {state.activeRuns.map(run => (
                        <RunCard key={run.runId} run={run} />
                    ))}
                </Section>
            )}

            {/* Pending goals */}
            {state && state.pendingGoals.length > 0 && (
                <Section title={`📋 Pending Goals (${state.pendingGoals.length})`} accent="#8b5cf6">
                    {state.pendingGoals.slice(0, 8).map(goal => (
                        <GoalCard key={goal.goalId} goal={goal} />
                    ))}
                </Section>
            )}

            {/* Blocked goals — human review required */}
            {state && state.blockedGoals.length > 0 && (
                <Section title={`🛑 Blocked / Human Review Required (${state.blockedGoals.length})`} accent="#f59e0b">
                    {state.blockedGoals.slice(0, 8).map(goal => (
                        <GoalCard key={goal.goalId} goal={goal} showBlockReason />
                    ))}
                </Section>
            )}

            {/* Recent completed runs */}
            {state && state.recentRuns.length > 0 && (
                <Section title={`📜 Recent Runs (${state.recentRuns.length})`} accent="#374151">
                    {state.recentRuns.slice(0, 10).map(run => (
                        <RunCard key={run.runId} run={run} compact />
                    ))}
                </Section>
            )}

            {/* Learning history */}
            {state && state.learningRecords.length > 0 && (
                <Section title={`🧠 Learning History (${state.learningRecords.length} patterns)`} accent="#0f766e">
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem' }}>
                        {state.learningRecords.slice(0, 10).map(r => (
                            <LearningCard key={r.recordId} record={r} />
                        ))}
                    </div>
                </Section>
            )}

            {/* Live telemetry stream */}
            {state && state.recentTelemetry.length > 0 && (
                <Section title="📡 Autonomy Telemetry Stream" accent="#1e40af">
                    <div style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                        {state.recentTelemetry.slice().reverse().slice(0, 20).map(ev => (
                            <TelemetryLine key={ev.eventId} event={ev} />
                        ))}
                    </div>
                </Section>
            )}

            {/* Empty state */}
            {state && state.kpis.totalGoalsDetected === 0 && (
                <div style={{
                    color: '#6b7280', background: 'rgba(31,41,55,0.5)',
                    padding: '2rem', borderRadius: '8px', textAlign: 'center',
                }}>
                    No autonomy goals detected yet.
                    {state.globalAutonomyEnabled
                        ? ' Click "Scan Now" to trigger a detection cycle.'
                        : ' Enable autonomy to start goal detection.'}
                </div>
            )}
        </div>
    );
};

// ─── Sub-components ───────────────────────────────────────────────────────────

const KpiCard: React.FC<{ title: string; value: number; icon: string; color?: string }> = ({
    title, value, icon, color = '#e5e7eb',
}) => (
    <div style={{
        padding: '1rem', background: '#1e293b', borderRadius: '8px', textAlign: 'center',
    }}>
        <div style={{ fontSize: '1.5rem', marginBottom: '0.25rem' }}>{icon}</div>
        <div style={{ fontSize: '1.5rem', fontWeight: 700, color }}>{value}</div>
        <div style={{ fontSize: '0.7rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {title}
        </div>
    </div>
);

const Section: React.FC<{ title: string; children: React.ReactNode; accent: string }> = ({
    title, children, accent,
}) => (
    <div style={{ marginBottom: '1.5rem' }}>
        <h3 style={{
            fontSize: '0.875rem', fontWeight: 600, color: '#9ca3af',
            textTransform: 'uppercase', letterSpacing: '0.05em',
            marginBottom: '0.75rem', borderBottom: `1px solid ${accent}`,
            paddingBottom: '0.4rem',
        }}>
            {title}
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {children}
        </div>
    </div>
);

const STATUS_COLORS: Record<string, string> = {
    succeeded: '#10b981',
    failed: '#ef4444',
    rolled_back: '#f59e0b',
    governance_blocked: '#f59e0b',
    policy_blocked: '#6b7280',
    executing: '#3b82f6',
    planning: '#8b5cf6',
    governance_pending: '#f59e0b',
    running: '#3b82f6',
    aborted: '#ef4444',
    suppressed: '#4b5563',
};

const RunCard: React.FC<{ run: AutonomousRun; compact?: boolean }> = ({ run, compact }) => {
    const color = STATUS_COLORS[run.status] ?? '#9ca3af';
    return (
        <div style={{
            padding: compact ? '0.5rem 0.75rem' : '0.75rem 1rem',
            background: '#0f172a', borderRadius: '6px',
            borderLeft: `3px solid ${color}`,
            fontSize: '0.8rem',
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#e5e7eb', fontWeight: 600 }}>
                    {run.subsystemId}
                </span>
                <span style={{
                    padding: '0.2rem 0.5rem', borderRadius: '12px',
                    background: `${color}22`, color,
                    fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase',
                }}>
                    {run.status}
                </span>
            </div>
            {!compact && (
                <div style={{ color: '#6b7280', marginTop: '0.25rem', fontSize: '0.75rem' }}>
                    Run {run.runId.slice(0, 8)} · {new Date(run.startedAt).toLocaleTimeString()}
                    {run.failureReason && (
                        <span style={{ color: '#ef4444', marginLeft: '0.5rem' }}>
                            · {run.failureReason.slice(0, 80)}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
};

const GoalCard: React.FC<{ goal: AutonomousGoal; showBlockReason?: boolean }> = ({
    goal, showBlockReason,
}) => {
    const tierColors: Record<string, string> = {
        critical: '#ef4444', high: '#f59e0b', medium: '#3b82f6',
        low: '#6b7280', suppressed: '#374151',
    };
    const color = tierColors[goal.priorityTier] ?? '#9ca3af';

    return (
        <div style={{
            padding: '0.75rem 1rem', background: '#0f172a',
            borderRadius: '6px', borderLeft: `3px solid ${color}`,
            fontSize: '0.8rem',
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span style={{ color: '#e5e7eb', fontWeight: 600 }}>{goal.title}</span>
                <span style={{
                    padding: '0.2rem 0.5rem', borderRadius: '12px',
                    background: `${color}22`, color,
                    fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase',
                    flexShrink: 0, marginLeft: '0.5rem',
                }}>
                    {goal.priorityTier}
                </span>
            </div>
            <div style={{ color: '#6b7280', marginTop: '0.25rem', fontSize: '0.7rem' }}>
                {goal.subsystemId} · score {goal.priorityScore.total} · {goal.source}
            </div>
            {showBlockReason && goal.humanReviewRequired && (
                <div style={{ color: '#f59e0b', marginTop: '0.25rem', fontSize: '0.7rem' }}>
                    ⚠️ Human review required
                </div>
            )}
        </div>
    );
};

const LearningCard: React.FC<{ record: LearningRecord }> = ({ record }) => {
    const confidence = Math.round(record.confidenceModifier * 100);
    const confColor = confidence >= 70 ? '#10b981' : confidence >= 40 ? '#f59e0b' : '#ef4444';
    return (
        <div style={{
            padding: '0.6rem 0.75rem', background: '#0f172a',
            borderRadius: '6px', fontSize: '0.75rem',
        }}>
            <div style={{ color: '#e5e7eb', fontWeight: 600, marginBottom: '0.2rem' }}>
                {record.subsystemId}
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', color: '#6b7280' }}>
                <span style={{ color: '#10b981' }}>✓{record.successCount}</span>
                <span style={{ color: '#ef4444' }}>✗{record.failureCount}</span>
                <span style={{ color: '#f59e0b' }}>↩{record.rollbackCount}</span>
                <span style={{ color: confColor }}>conf: {confidence}%</span>
            </div>
        </div>
    );
};

const TelemetryLine: React.FC<{ event: AutonomyTelemetryEvent }> = ({ event }) => {
    const color = event.type.includes('failed') || event.type.includes('blocked')
        ? '#ef4444'
        : event.type.includes('succeeded') || event.type.includes('completed')
            ? '#10b981'
            : '#9ca3af';
    return (
        <div style={{
            display: 'flex', gap: '0.75rem', padding: '0.2rem 0',
            borderBottom: '1px solid #1e293b', color,
        }}>
            <span style={{ color: '#4b5563', flexShrink: 0, fontWeight: 600 }}>
                {new Date(event.timestamp).toLocaleTimeString()}
            </span>
            <span style={{ color: '#6b7280', flexShrink: 0 }}>{event.type}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {event.detail}
            </span>
        </div>
    );
};

export default AutonomyDashboardPanel;
