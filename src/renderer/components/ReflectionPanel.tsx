import React, { useState, useEffect, useCallback } from 'react';
import type { ReflectionMetrics, ChangeProposal } from '../reflectionTypes';
import ReflectionProposalCard from './ReflectionProposalCard';

/**
 * ReflectionPanel
 * 
 * The central hub for TALA's self-improvement loop. Allows users to
 * monitor metrics, review proposals, and trigger manual reflections.
 */
const ReflectionPanel: React.FC = () => {
    const [metrics, setMetrics] = useState<ReflectionMetrics | null>(null);
    const [proposals, setProposals] = useState<ChangeProposal[]>([]);
    const [loading, setLoading] = useState(true);
    const [notification, setNotification] = useState<string | null>(null);

    const tala = (window as any).tala;

    const fetchData = useCallback(async () => {
        try {
            const [m, p] = await Promise.all([
                tala.getReflectionMetrics(),
                tala.getReflectionProposals()
            ]);
            setMetrics(m);
            setProposals((p || []).filter((pr: ChangeProposal) => pr.status === 'pending'));
        } catch (err) {
            console.error('Failed to fetch reflection data:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 30000);

        // Listen for real-time proposal notifications
        const unsub = tala.onProposalCreated?.((data: any) => {
            setNotification(`New Proposal: ${data.title}`);
            fetchData();
            // Auto-dismiss notification after 5s
            setTimeout(() => setNotification(null), 5000);
        });

        return () => {
            clearInterval(interval);
            unsub?.();
        };
    }, [fetchData]);

    const handleForceTick = async () => {
        setLoading(true);
        await tala.forceHeartbeat();
        await fetchData();
    };

    if (loading && !metrics) {
        return (
            <div style={{ padding: '2rem', color: '#9ca3af' }}>Loading Reflection Data...</div>
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
                    animation: 'slideIn 0.3s ease-out',
                    boxShadow: '0 4px 15px rgba(59, 130, 246, 0.3)'
                }}>
                    <span style={{ fontSize: '1.2rem' }}>🔔</span>
                    <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>{notification}</span>
                </div>
            )}

            <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
                <div>
                    <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Reflection Dashboard</h1>
                    <p style={{ color: '#6b7280', fontSize: '0.875rem', margin: '0.25rem 0 0' }}>TALA's autonomous learning & optimization loop.</p>
                </div>
                <button
                    onClick={handleForceTick}
                    style={{
                        background: '#2563eb',
                        color: '#fff',
                        border: 'none',
                        padding: '0.5rem 1rem',
                        borderRadius: '6px',
                        fontSize: '0.875rem',
                        cursor: 'pointer',
                        transition: 'background 0.2s'
                    }}
                    onMouseOver={e => (e.currentTarget.style.background = '#3b82f6')}
                    onMouseOut={e => (e.currentTarget.style.background = '#2563eb')}
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

            <section>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
                    Pending Proposals ({proposals.length})
                </h2>
                {proposals.length === 0 ? (
                    <div style={{
                        color: '#6b7280',
                        background: 'rgba(31, 41, 55, 0.5)',
                        padding: '2rem',
                        borderRadius: '8px',
                        textAlign: 'center',
                        border: '1px solid rgba(75, 85, 99, 0.3)'
                    }}>
                        No pending proposals. System is performing optimally.
                    </div>
                ) : (
                    <div style={{ display: 'grid', gap: '1rem' }}>
                        {proposals.map(p => (
                            <ReflectionProposalCard key={p.id} proposal={p} onAction={fetchData} />
                        ))}
                    </div>
                )}
            </section>

            {metrics?.lastHeartbeat && (
                <div style={{ marginTop: '2rem', fontSize: '0.75rem', color: '#4b5563', textAlign: 'right' }}>
                    Last heartbeat: {new Date(metrics.lastHeartbeat).toLocaleString()}
                </div>
            )}
        </div>
    );
};

const MetricCard: React.FC<{ title: string; value: string | number; icon?: string }> = ({ title, value, icon }) => (
    <div style={{
        background: 'rgba(31, 41, 55, 0.8)',
        padding: '1rem',
        borderRadius: '8px',
        border: '1px solid rgba(75, 85, 99, 0.4)',
        transition: 'border-color 0.2s'
    }}>
        <div style={{ color: '#9ca3af', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>
            {icon && <span style={{ marginRight: '0.25rem' }}>{icon}</span>}{title}
        </div>
        <div style={{ fontSize: '1.25rem', fontFamily: 'monospace', fontWeight: 600 }}>{value}</div>
    </div>
);

export default ReflectionPanel;
