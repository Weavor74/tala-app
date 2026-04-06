import React, { useState, useEffect, useCallback } from 'react';
import type { ReflectionDashboardState, ChangeProposal, SoulIdentity, SoulReflection, ReflectionJournalEntry, SelfImprovementGoal, TelemetryEvent } from '../reflectionTypes';
import ReflectionProposalCard from './ReflectionProposalCard';
import ExecutionPipelinePanel from './ExecutionPipelinePanel';
import GovernancePanel from './GovernancePanel';
import AutonomyDashboardPanel from './AutonomyDashboardPanel';
import TelemetryEventsPanel from './TelemetryEventsPanel';

/**
 * Reflection Dashboard Component
 * 
 * The central UI hub for Tala's self-improvement and existential awareness systems.
 * 
 * **Tabs:**
 * - **Engineering**: Displays system improvement proposals, execution pipeline
 *   activity, and autonomous engineering telemetry. Allows users to trigger
 *   manual reflection cycles.
 * - **Tala's Soul**: Visualizes the agent's internal identity, including
 *   core values, behavioral boundaries, and recent ethical reflections.
 * 
 * **Data Flow:**
 * - Fetches metrics and state from `AgentService` via `tala` IPC bridge.
 * - Listens for real-time telemetry and pipeline updates.
 */
const ReflectionPanel: React.FC = () => {
    const [activeTab, setActiveTab] = useState<'engineering' | 'soul'>('engineering');
    const [engineeringSubTab, setEngineeringSubTab] = useState<'proposals' | 'events' | 'goals' | 'telemetry' | 'execution' | 'governance' | 'autonomy' | 'exec-events'>('proposals');
    const [dashboardState, setDashboardState] = useState<ReflectionDashboardState | null>(null);
    const [proposals, setProposals] = useState<ChangeProposal[]>([]);
    const [reflectionEvents, setReflectionEvents] = useState<ReflectionJournalEntry[]>([]);
    const [goals, setGoals] = useState<SelfImprovementGoal[]>([]);
    const [telemetry, setTelemetry] = useState<TelemetryEvent[]>([]);
    const [identity, setIdentity] = useState<SoulIdentity | null>(null);
    const [reflections, setReflections] = useState<SoulReflection[]>([]);
    const [loading, setLoading] = useState(true);
    const [notification, setNotification] = useState<string | null>(null);

    const tala = (window as any).tala;

    const fetchData = useCallback(async () => {
        try {
            if (!tala || !tala.getReflectionMetrics) {
                console.warn('Tala Reflection API not fully available. Please restart the application.');
                setLoading(false);
                return;
            }

            if (activeTab === 'engineering') {
                try {
                    const ds = await tala.getDashboardState();
                    setDashboardState(ds);
                } catch (e) { console.error('Dashboard state fetch failed:', e); }

                try {
                    const p = await tala.listProposals();
                    setProposals(p || []);
                } catch (e) { console.error('Proposals fetch failed:', e); }

                try {
                    if (tala.listJournalEntries) {
                        const e = await tala.listJournalEntries();
                        setReflectionEvents(e || []);
                    }
                } catch (e) { console.error('Events fetch failed:', e); }

                try {
                    if (tala.listGoals) {
                        const g = await tala.listGoals();
                        setGoals(g || []);
                    }
                } catch (e) { console.error('Goals fetch failed:', e); }
            } else {
                try {
                    if (tala.getSoulIdentity) {
                        const id = await tala.getSoulIdentity();
                        setIdentity(id);
                    }
                    if (tala.getSoulReflections) {
                        const ref = await tala.getSoulReflections(10);
                        setReflections(ref || []);
                    }
                } catch (e) { console.error('Soul fetch failed:', e); }
            }
        } catch (err) {
            console.error('Critical failure in fetchData:', err);
        } finally {
            setLoading(false);
        }
    }, [activeTab]);

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 30000);

        const unsub = tala.onProposalCreated?.((data: any) => {
            setNotification(`New Proposal: ${data.title}`);
            fetchData();
            setTimeout(() => setNotification(null), 5000);
        });

        const unsub2 = tala.onReflectionTelemetry?.((data: TelemetryEvent) => {
            setTelemetry(prev => [data, ...prev].slice(0, 100)); // Keep last 100 events
        });

        const unsub3 = tala.onReflectionActivityUpdated?.((data: any) => {
            setDashboardState(prev => {
                if (!prev) return prev;
                return {
                    ...prev,
                    pipelineActivity: data.activity,
                    schedulerState: data.state
                };
            });
        });

        return () => {
            clearInterval(interval);
            unsub?.();
            unsub2?.();
            unsub3?.();
        };
    }, [fetchData]);

    const handleForceTick = async () => {
        setLoading(true);
        if (activeTab === 'engineering') {
            try {
                const res = await tala.triggerReflection();
                setNotification(res.success ? `Reflection Process: ${res.message}` : `Reflection Failed: ${res.message}`);
            } catch (e: any) {
                setNotification(`Error triggering reflection: ${e.message}`);
            }
        }
        await fetchData();
    };

    if (loading && !dashboardState && !identity) {
        return (
            <div style={{ padding: '2rem', color: '#9ca3af' }}>Gathering Internal State...</div>
        );
    }

    return (
        <div style={{ padding: '1.5rem', overflowY: 'auto', height: '100%', color: '#e5e7eb' }}>
            {/* Proposal Notification Banner */}
            {notification && (
                <div style={{
                    background: 'linear-gradient(90deg, #1e40af, #3b82f6)',
                    color: '#fff',
                    padding: '0.75rem 1rem',
                    borderRadius: '8px',
                    marginBottom: '1rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    boxShadow: '0 4px 15px rgba(59, 130, 246, 0.3)'
                }}>
                    <span style={{ fontSize: '1.2rem' }}>🔔</span>
                    <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>{notification}</span>
                </div>
            )}

            {/* Tab Selector */}
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', borderBottom: '1px solid #374151' }}>
                <button
                    onClick={() => setActiveTab('engineering')}
                    style={{
                        padding: '0.5rem 1rem', background: 'none', border: 'none',
                        color: activeTab === 'engineering' ? '#3b82f6' : '#6b7280',
                        borderBottom: activeTab === 'engineering' ? '2px solid #3b82f6' : 'none',
                        cursor: 'pointer', fontWeight: 600
                    }}
                >
                    Engineering
                </button>
                <button
                    onClick={() => setActiveTab('soul')}
                    style={{
                        padding: '0.5rem 1rem', background: 'none', border: 'none',
                        color: activeTab === 'soul' ? '#3b82f6' : '#6b7280',
                        borderBottom: activeTab === 'soul' ? '2px solid #3b82f6' : 'none',
                        cursor: 'pointer', fontWeight: 600
                    }}
                >
                    Tala's Soul
                </button>
            </div>

            {activeTab === 'engineering' ? (
                <>
                    <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
                        <div>
                            <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Reflection Dashboard</h1>
                            <p style={{ color: '#6b7280', fontSize: '0.875rem', margin: '0.25rem 0 0' }}>TALA's autonomous learning & optimization loop.</p>
                        </div>
                        <button
                            onClick={handleForceTick}
                            style={{
                                background: '#2563eb', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: '6px', fontSize: '0.875rem', cursor: 'pointer'
                            }}
                        >
                            ⚡ Trigger Reflection
                        </button>
                    </header>

                    {dashboardState?.pipelineActivity && (
                        <div style={{ marginBottom: '2rem', padding: '1.25rem', background: '#1e293b', borderRadius: '8px', borderLeft: '4px solid #3b82f6', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                                <div>
                                    <h3 style={{ margin: '0 0 0.25rem 0', color: '#93c5fd', fontSize: '1.1rem', fontWeight: 600 }}>Live Execution Pipeline</h3>
                                    <div style={{ fontSize: '0.875rem', color: '#9ca3af' }}>Status of the autonomous engineering queue</div>
                                </div>
                                <div style={{
                                    padding: '0.25rem 0.75rem',
                                    borderRadius: '12px',
                                    background: dashboardState.pipelineActivity.isActive ? '#065f46' : '#374151',
                                    color: dashboardState.pipelineActivity.isActive ? '#34d399' : '#9ca3af',
                                    fontSize: '0.75rem',
                                    fontWeight: 700,
                                    textTransform: 'uppercase',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem'
                                }}>
                                    {dashboardState.pipelineActivity.isActive && <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10b981', animation: 'pulse 1.5s infinite' }} />}
                                    {dashboardState.pipelineActivity.isActive ? 'Active' : 'Idle'}
                                </div>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '1rem', background: '#0f172a', padding: '1rem', borderRadius: '6px' }}>
                                <div>
                                    <div style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>Current Phase</div>
                                    <div style={{ fontSize: '1.125rem', fontWeight: 600, color: '#f8fafc', textTransform: 'capitalize' }}>
                                        {dashboardState.pipelineActivity.currentPhase.replace('_', ' ')}
                                    </div>
                                </div>
                                <div>
                                    <div style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>Engine</div>
                                    <div style={{ fontSize: '1.125rem', fontWeight: 600, color: dashboardState.schedulerState?.isRunning ? '#a7f3d0' : '#f8fafc' }}>
                                        {dashboardState.schedulerState?.isRunning ? 'Running' : 'Sleeping'}
                                    </div>
                                </div>
                                <div>
                                    <div style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>Pending Goals</div>
                                    <div style={{ fontSize: '1.125rem', fontWeight: 600, color: '#f8fafc' }}>
                                        {dashboardState.schedulerState?.queuedGoals ?? dashboardState.pipelineActivity.queuedGoalCount} Items
                                    </div>
                                </div>
                                <div style={{ gridColumn: 'span 2' }}>
                                    <div style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>Latest Output</div>
                                    <div style={{ fontSize: '0.875rem', color: dashboardState.pipelineActivity.lastOutcome === 'failed' ? '#ef4444' : '#a7f3d0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {dashboardState.pipelineActivity.lastError || dashboardState.schedulerState?.lastError || dashboardState.pipelineActivity.lastSummary || dashboardState.schedulerState?.lastRunSummary || 'Awaiting telemetry...'}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    <section style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '1rem', marginBottom: '2rem' }}>
                        <MetricCard title="Total Attempts" value={dashboardState?.totalReflections ?? 0} icon="🔍" />
                        <MetricCard title="Promoted" value={dashboardState?.appliedChanges ?? 0} icon="✅" />
                        <MetricCard title="Success Rate" value={`${((dashboardState?.successRate ?? 0) * 100).toFixed(1)}%`} icon="📊" />
                        <MetricCard title="Active Goals" value={dashboardState?.activeGoals ?? 0} icon="🎯" />
                        <MetricCard title="Proposals Ready" value={dashboardState?.proposalsReady ?? 0} icon="📋" />
                    </section>

                    {/* Sub-tab Selector for Engineering */}
                    <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}>
                        <button
                            onClick={() => setEngineeringSubTab('proposals')}
                            style={{
                                padding: '0.4rem 0.8rem', borderRadius: '20px', fontSize: '0.75rem', border: '1px solid #374151',
                                background: engineeringSubTab === 'proposals' ? '#374151' : 'transparent',
                                color: engineeringSubTab === 'proposals' ? '#fff' : '#9ca3af',
                                cursor: 'pointer'
                            }}
                        >
                            Change Proposals ({proposals.length})
                        </button>
                        <button
                            onClick={() => setEngineeringSubTab('events')}
                            style={{
                                padding: '0.4rem 0.8rem', borderRadius: '20px', fontSize: '0.75rem', border: '1px solid #374151',
                                background: engineeringSubTab === 'events' ? '#374151' : 'transparent',
                                color: engineeringSubTab === 'events' ? '#fff' : '#9ca3af',
                                cursor: 'pointer'
                            }}
                        >
                            Internal Reflections ({reflectionEvents.length})
                        </button>
                        <button
                            onClick={() => setEngineeringSubTab('goals')}
                            style={{
                                padding: '0.4rem 0.8rem', borderRadius: '20px', fontSize: '0.75rem', border: '1px solid #374151',
                                background: engineeringSubTab === 'goals' ? '#374151' : 'transparent',
                                color: engineeringSubTab === 'goals' ? '#fff' : '#9ca3af',
                                cursor: 'pointer'
                            }}
                        >
                            Improvement Goals ({goals.length})
                        </button>
                        <button
                            onClick={() => setEngineeringSubTab('telemetry')}
                            style={{
                                padding: '0.4rem 0.8rem', borderRadius: '20px', fontSize: '0.75rem', border: '1px solid #374151',
                                background: engineeringSubTab === 'telemetry' ? '#374151' : 'transparent',
                                color: engineeringSubTab === 'telemetry' ? '#fff' : '#9ca3af',
                                cursor: 'pointer'
                            }}
                        >
                            Live Telemetry Stream
                        </button>
                        <button
                            onClick={() => setEngineeringSubTab('execution')}
                            style={{
                                padding: '0.4rem 0.8rem', borderRadius: '20px', fontSize: '0.75rem', border: '1px solid #374151',
                                background: engineeringSubTab === 'execution' ? '#2563eb' : 'transparent',
                                color: engineeringSubTab === 'execution' ? '#fff' : '#9ca3af',
                                cursor: 'pointer'
                            }}
                        >
                            ▶ Live Execution Pipeline
                        </button>
                        <button
                            onClick={() => setEngineeringSubTab('governance')}
                            style={{
                                padding: '0.4rem 0.8rem', borderRadius: '20px', fontSize: '0.75rem', border: '1px solid #374151',
                                background: engineeringSubTab === 'governance' ? '#7c3aed' : 'transparent',
                                color: engineeringSubTab === 'governance' ? '#fff' : '#9ca3af',
                                cursor: 'pointer'
                            }}
                        >
                            🛡️ Governance
                        </button>
                        <button
                            onClick={() => setEngineeringSubTab('autonomy')}
                            style={{
                                padding: '0.4rem 0.8rem', borderRadius: '20px', fontSize: '0.75rem', border: '1px solid #374151',
                                background: engineeringSubTab === 'autonomy' ? '#5b21b6' : 'transparent',
                                color: engineeringSubTab === 'autonomy' ? '#fff' : '#9ca3af',
                                cursor: 'pointer'
                            }}
                        >
                            🤖 Autonomy
                        </button>
                        <button
                            onClick={() => setEngineeringSubTab('exec-events')}
                            style={{
                                padding: '0.4rem 0.8rem', borderRadius: '20px', fontSize: '0.75rem', border: '1px solid #374151',
                                background: engineeringSubTab === 'exec-events' ? '#0e7490' : 'transparent',
                                color: engineeringSubTab === 'exec-events' ? '#fff' : '#9ca3af',
                                cursor: 'pointer'
                            }}
                        >
                            🔍 Exec Events
                        </button>
                    </div>

                    {engineeringSubTab === 'proposals' ? (
                        <section>
                            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1.25rem' }}>
                                System Improvement Proposals ({proposals.length})
                            </h2>
                            {proposals.length === 0 ? (
                                <div style={{ color: '#6b7280', background: 'rgba(31, 41, 55, 0.5)', padding: '2rem', borderRadius: '8px', textAlign: 'center' }}>
                                    No proposals recorded. System is performing optimally.
                                </div>
                            ) : (
                                <div style={{ display: 'grid', gap: '1.25rem' }}>
                                    {proposals.map(p => (
                                        <div key={p.id} style={{ position: 'relative' }}>
                                            {p.status !== 'pending' && (
                                                <div style={{
                                                    position: 'absolute', top: '10px', right: '10px', zIndex: 10,
                                                    fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase',
                                                    padding: '2px 8px', borderRadius: '4px',
                                                    background: p.status === 'applied' ? '#16a34a' : '#ef4444',
                                                    color: '#fff', boxShadow: '0 2px 5px rgba(0,0,0,0.2)'
                                                }}>
                                                    {p.status}
                                                </div>
                                            )}
                                            <ReflectionProposalCard proposal={p} onAction={fetchData} />
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>
                    ) : engineeringSubTab === 'events' ? (
                        <section style={{ animation: 'fadeIn 0.2s ease-out' }}>
                            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>Internal Reflection Events</h2>
                            {reflectionEvents.length === 0 ? (
                                <div style={{ color: '#6b7280' }}>No reflection events recorded yet.</div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                    {reflectionEvents.map(e => (
                                        <div key={e.entryId} style={{ background: '#1f2937', padding: '1.25rem', borderRadius: '12px', border: '1px solid #374151' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                                                <span style={{ fontWeight: 700, color: '#3b82f6' }}>{e.summary}</span>
                                                <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>{new Date(e.timestamp).toLocaleString()}</span>
                                            </div>
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', fontSize: '0.875rem' }}>
                                                <div>
                                                    <div style={{ color: '#9ca3af', fontSize: '0.7rem', textTransform: 'uppercase', marginBottom: '0.5rem' }}>Observations</div>
                                                    <ul style={{ margin: 0, paddingLeft: '1.2rem', color: '#e5e7eb' }}>
                                                        {e.evidence?.errors?.map((o: any, idx: number) => <li key={idx} style={{ marginBottom: '0.25rem' }}>{o}</li>)}
                                                    </ul>
                                                </div>
                                                <div>
                                                    <div style={{ color: '#9ca3af', fontSize: '0.7rem', textTransform: 'uppercase', marginBottom: '0.5rem' }}>Technical context</div>
                                                    <div style={{ color: '#9ca3af', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                                        <span>Errors: {e.evidence?.errors?.length || 0}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>
                    ) : engineeringSubTab === 'telemetry' ? (
                        <section style={{ animation: 'fadeIn 0.2s ease-out' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                                <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Live Telemetry Stream</h2>
                                <button
                                    onClick={() => setTelemetry([])}
                                    style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', padding: '0.3rem 0.6rem', borderRadius: '4px', fontSize: '0.75rem', cursor: 'pointer' }}
                                >
                                    Clear Logs
                                </button>
                            </div>
                            {telemetry.length === 0 ? (
                                <div style={{ color: '#6b7280', fontFamily: 'monospace', padding: '1rem' }}>Awaiting telemetry events...</div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontFamily: 'monospace', fontSize: '0.8rem', background: '#0f172a', padding: '1rem', borderRadius: '8px', overflowY: 'auto', maxHeight: '500px' }}>
                                    {telemetry.map((t, idx) => (
                                        <div key={idx} style={{
                                            display: 'grid',
                                            gridTemplateColumns: 'minmax(140px, auto) 80px 160px 1fr',
                                            gap: '0.75rem',
                                            alignItems: 'start',
                                            borderBottom: '1px solid #1e293b',
                                            paddingBottom: '0.5rem'
                                        }}>
                                            <span style={{ color: '#64748b' }}>{new Date(t.timestamp).toLocaleTimeString() + '.' + new Date(t.timestamp).getMilliseconds().toString().padStart(3, '0')}</span>
                                            <span style={{
                                                color: t.level === 'error' ? '#ef4444' : t.level === 'warn' ? '#f59e0b' : t.level === 'debug' ? '#64748b' : '#34d399',
                                                fontWeight: t.level === 'error' || t.level === 'warn' ? 700 : 400
                                            }}>{t.level.toUpperCase()}</span>
                                            <span style={{ color: '#8b5cf6', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>[{t.source}]</span>
                                            <div style={{ color: '#e2e8f0', wordBreak: 'break-word' }}>
                                                <div>{t.event}: {t.message}</div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>
                    ) : (
                        <GoalPanel goals={goals} onRefresh={fetchData} />
                    )}
                    {engineeringSubTab === 'execution' && (
                        <ExecutionPipelinePanel />
                    )}
                    {engineeringSubTab === 'governance' && (
                        <GovernancePanel />
                    )}
                    {engineeringSubTab === 'autonomy' && (
                        <AutonomyDashboardPanel />
                    )}
                    {engineeringSubTab === 'exec-events' && (
                        <TelemetryEventsPanel />
                    )}
                </>
            ) : (
                <div style={{ animation: 'fadeIn 0.3s ease-out' }}>
                    <header style={{ marginBottom: '2rem' }}>
                        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Existential Status</h1>
                        <p style={{ color: '#6b7280', fontSize: '0.875rem', margin: '0.25rem 0 0' }}>Identity, values, and behavioral reflections.</p>
                    </header>

                    <section style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.5rem', marginBottom: '2rem' }}>
                        <SoulCard title="Values" items={identity?.values || []} color="#10b981" />
                        <SoulCard title="Boundaries" items={identity?.boundaries || []} color="#ef4444" />
                        <SoulCard title="Roles" items={identity?.roles || []} color="#8b5cf6" />
                    </section>

                    <section>
                        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>Recent Behavioral Reflections</h2>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                            {reflections.length === 0 && <div style={{ color: '#6b7280' }}>No soul events recorded yet.</div>}
                            {reflections.map(r => (
                                <div key={r.id} style={{ background: '#1f2937', padding: '1rem', borderRadius: '8px', borderLeft: '4px solid #3b82f6' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                                        <span style={{ fontWeight: 600 }}>{r.decision}</span>
                                        <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>{new Date(r.timestamp).toLocaleTimeString()}</span>
                                    </div>
                                    <p style={{ fontSize: '0.875rem', color: '#9ca3af', margin: '0.25rem 0' }}>{r.context}</p>
                                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                                        {r.uncertainties?.map((u, i) => (
                                            <span key={i} style={{ fontSize: '0.7rem', background: '#374151', padding: '2px 6px', borderRadius: '4px' }}>? {u}</span>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                </div>
            )}
        </div>
    );
};

/**
 * MetricCard
 * 
 * A compact display for reflection metrics (e.g., Promotion Rate, Total Attempts).
 */
const MetricCard: React.FC<{ title: string; value: string | number; icon?: string }> = ({ title, value, icon }) => (
    <div style={{ background: 'rgba(31, 41, 55, 0.8)', padding: '1rem', borderRadius: '8px', border: '1px solid rgba(75, 85, 99, 0.4)' }}>
        <div style={{ color: '#9ca3af', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>
            {icon && <span style={{ marginRight: '0.25rem' }}>{icon}</span>}{title}
        </div>
        <div style={{ fontSize: '1.25rem', fontFamily: 'monospace', fontWeight: 600 }}>{value}</div>
    </div>
);

/**
 * SoulCard
 * 
 * Visualizes a categorical list of identity attributes (Values, Boundaries, Roles).
 */
const SoulCard: React.FC<{ title: string; items: string[]; color: string }> = ({ title, items, color }) => (
    <div style={{ background: 'rgba(31, 41, 55, 0.8)', padding: '1.25rem', borderRadius: '12px', border: `1px solid ${color}33` }}>
        <h3 style={{ fontSize: '0.75rem', color: color, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '1rem', fontWeight: 700 }}>{title}</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {items.map((item, idx) => (
                <span key={idx} style={{ fontSize: '0.75rem', background: `${color}11`, color: '#e5e7eb', padding: '4px 8px', borderRadius: '6px', border: `1px solid ${color}22` }}>
                    {item}
                </span>
            ))}
        </div>
    </div>
);

/**
 * GoalPanel
 * 
 * Management interface for self-improvement goals. 
 * Allows users to add new goals to the queue and manually trigger processing.
 */
const GoalPanel: React.FC<{ goals: SelfImprovementGoal[], onRefresh: () => void }> = ({ goals, onRefresh }) => {
    const tala = (window as any).tala;
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [priority, setPriority] = useState('medium');
    const [category, setCategory] = useState('tooling');

    const handleCreate = async () => {
        if (!title.trim()) return;
        await tala.createGoal({
            title, description, priority, category,
            status: 'queued', source: 'user'
        });
        setTitle('');
        setDescription('');
        onRefresh();
    };

    return (
        <section style={{ animation: 'fadeIn 0.2s ease-out' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Self-Improvement Goals</h2>
                <button
                    onClick={async () => {
                        await tala.processNextGoal();
                        onRefresh();
                    }}
                    style={{ background: '#3b82f6', color: '#fff', border: 'none', padding: '0.4rem 0.8rem', borderRadius: '6px', fontWeight: 600, cursor: 'pointer', fontSize: '0.875rem' }}
                >
                    ▶ Process Next In Queue
                </button>
            </div>

            {/* Add Goal Form */}
            <div style={{ background: '#1f2937', padding: '1.5rem', borderRadius: '12px', border: '1px solid #374151', marginBottom: '2rem' }}>
                <h3 style={{ fontSize: '1rem', marginBottom: '1rem', fontWeight: 600 }}>Create New Goal</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1rem', marginBottom: '1rem' }}>
                    <input
                        type="text"
                        placeholder="Goal Title"
                        value={title}
                        onChange={e => setTitle(e.target.value)}
                        style={{ background: '#374151', color: '#fff', border: 'none', padding: '0.75rem', borderRadius: '6px' }}
                    />
                    <textarea
                        placeholder="Detailed Description / Success Criteria"
                        value={description}
                        onChange={e => setDescription(e.target.value)}
                        rows={3}
                        style={{ background: '#374151', color: '#fff', border: 'none', padding: '0.75rem', borderRadius: '6px', resize: 'vertical' }}
                    />
                    <div style={{ display: 'flex', gap: '1rem' }}>
                        <select
                            value={category}
                            onChange={e => setCategory(e.target.value)}
                            style={{ background: '#374151', color: '#fff', border: 'none', padding: '0.75rem', borderRadius: '6px', flex: 1 }}
                        >
                            {['stability', 'memory', 'routing', 'identity', 'performance', 'tooling', 'ui', 'testing', 'documentation'].map(c => (
                                <option key={c} value={c}>{c}</option>
                            ))}
                        </select>
                        <select
                            value={priority}
                            onChange={e => setPriority(e.target.value)}
                            style={{ background: '#374151', color: '#fff', border: 'none', padding: '0.75rem', borderRadius: '6px', flex: 1 }}
                        >
                            <option value="low">Low Priority</option>
                            <option value="medium">Medium Priority</option>
                            <option value="high">High Priority</option>
                            <option value="critical">Critical</option>
                        </select>
                    </div>
                </div>
                <button
                    onClick={handleCreate}
                    disabled={!title.trim()}
                    style={{ background: '#10b981', color: '#fff', border: 'none', padding: '0.75rem 1.5rem', borderRadius: '6px', fontWeight: 600, cursor: title.trim() ? 'pointer' : 'not-allowed', opacity: title.trim() ? 1 : 0.5 }}
                >
                    + Submit Goal to Pipeline
                </button>
            </div>

            {/* Goal List */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {goals.length === 0 ? (
                    <div style={{ color: '#6b7280', textAlign: 'center', padding: '2rem' }}>No Active Goals</div>
                ) : (
                    goals.map(g => (
                        <div key={g.goalId} style={{ background: '#1f2937', padding: '1.25rem', borderRadius: '12px', borderLeft: `4px solid ${g.status === 'completed' ? '#10b981' : (g.status === 'active' || g.status === 'validating' ? '#3b82f6' : '#6b7280')}` }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                                <div>
                                    <h4 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>{g.title}</h4>
                                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                                        <span style={{ fontSize: '0.7rem', color: '#9ca3af', background: '#374151', padding: '2px 8px', borderRadius: '12px' }}>{g.category}</span>
                                        <span style={{ fontSize: '0.7rem', color: '#9ca3af', background: '#374151', padding: '2px 8px', borderRadius: '12px' }}>Priority: {g.priority}</span>
                                    </div>
                                </div>
                                <span style={{ fontSize: '0.75rem', fontWeight: 600, padding: '4px 10px', borderRadius: '20px', background: 'rgba(255,255,255,0.1)', color: '#fff', textTransform: 'capitalize' }}>
                                    {g.status}
                                </span>
                            </div>
                            {g.description && <p style={{ fontSize: '0.875rem', color: '#d1d5db', marginTop: '0.75rem', marginBottom: 0 }}>{g.description}</p>}
                        </div>
                    ))
                )}
            </div>
        </section>
    );
};

export default ReflectionPanel;
