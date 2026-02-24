import React, { useState, useEffect, useCallback } from 'react';
import type { ReflectionMetrics, ChangeProposal, SoulIdentity, SoulReflection, ReflectionEvent } from '../reflectionTypes';
import ReflectionProposalCard from './ReflectionProposalCard';

/**
 * ReflectionPanel
 * 
 * The central hub for TALA's self-improvement loop.
 * Now includes "Engineering" (code changes) and "Soul" (behavioral identity) tabs.
 */
const ReflectionPanel: React.FC = () => {
    const [activeTab, setActiveTab] = useState<'engineering' | 'soul'>('engineering');
    const [engineeringSubTab, setEngineeringSubTab] = useState<'proposals' | 'events'>('proposals');
    const [metrics, setMetrics] = useState<ReflectionMetrics | null>(null);
    const [proposals, setProposals] = useState<ChangeProposal[]>([]);
    const [reflectionEvents, setReflectionEvents] = useState<ReflectionEvent[]>([]);
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
                // Fetch independently to be resilient
                try {
                    const m = await tala.getReflectionMetrics();
                    setMetrics(m);
                } catch (e) { console.error('Metrics fetch failed:', e); }

                try {
                    const p = await tala.getReflectionProposals();
                    setProposals(p || []);
                } catch (e) { console.error('Proposals fetch failed:', e); }

                try {
                    if (tala.getReflectionEvents) {
                        const e = await tala.getReflectionEvents();
                        setReflectionEvents(e || []);
                    }
                } catch (e) { console.error('Events fetch failed:', e); }
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

        return () => {
            clearInterval(interval);
            unsub?.();
        };
    }, [fetchData]);

    const handleForceTick = async () => {
        setLoading(true);
        if (activeTab === 'engineering') {
            await tala.forceHeartbeat();
        }
        await fetchData();
    };

    if (loading && !metrics && !identity) {
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

                    <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '2rem' }}>
                        <MetricCard title="Total Reflections" value={metrics?.totalReflections ?? 0} icon="🔍" />
                        <MetricCard title="Total Proposals" value={metrics?.totalProposals ?? 0} icon="📋" />
                        <MetricCard title="Applied Changes" value={metrics?.appliedChanges ?? 0} icon="✅" />
                        <MetricCard title="Success Rate" value={`${((metrics?.successRate ?? 1) * 100).toFixed(1)}%`} icon="📊" />
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
                    ) : (
                        <section style={{ animation: 'fadeIn 0.2s ease-out' }}>
                            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>Internal Reflection Events</h2>
                            {reflectionEvents.length === 0 ? (
                                <div style={{ color: '#6b7280' }}>No reflection events recorded yet.</div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                    {reflectionEvents.map(e => (
                                        <div key={e.id} style={{ background: '#1f2937', padding: '1.25rem', borderRadius: '12px', border: '1px solid #374151' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                                                <span style={{ fontWeight: 700, color: '#3b82f6' }}>{e.summary}</span>
                                                <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>{new Date(e.timestamp).toLocaleString()}</span>
                                            </div>
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', fontSize: '0.875rem' }}>
                                                <div>
                                                    <div style={{ color: '#9ca3af', fontSize: '0.7rem', textTransform: 'uppercase', marginBottom: '0.5rem' }}>Observations</div>
                                                    <ul style={{ margin: 0, paddingLeft: '1.2rem', color: '#e5e7eb' }}>
                                                        {e.observations?.map((o, idx) => <li key={idx} style={{ marginBottom: '0.25rem' }}>{o}</li>)}
                                                    </ul>
                                                </div>
                                                <div>
                                                    <div style={{ color: '#9ca3af', fontSize: '0.7rem', textTransform: 'uppercase', marginBottom: '0.5rem' }}>Technical context</div>
                                                    <div style={{ color: '#9ca3af', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                                        <span>Errors: {e.evidence.errors.length}</span>
                                                        <span>Lat: {e.metrics.averageLatencyMs.toFixed(0)}ms</span>
                                                        <span>Err Rate: {(e.metrics.errorRate * 100).toFixed(1)}%</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>
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

const MetricCard: React.FC<{ title: string; value: string | number; icon?: string }> = ({ title, value, icon }) => (
    <div style={{ background: 'rgba(31, 41, 55, 0.8)', padding: '1rem', borderRadius: '8px', border: '1px solid rgba(75, 85, 99, 0.4)' }}>
        <div style={{ color: '#9ca3af', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>
            {icon && <span style={{ marginRight: '0.25rem' }}>{icon}</span>}{title}
        </div>
        <div style={{ fontSize: '1.25rem', fontFamily: 'monospace', fontWeight: 600 }}>{value}</div>
    </div>
);

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

export default ReflectionPanel;
