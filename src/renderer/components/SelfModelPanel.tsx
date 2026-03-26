/**
 * SelfModelPanel.tsx — Architecture Self-Model UI Panel
 *
 * Phase 1 Self-Model Foundation
 *
 * Displays Tala's self-model: architecture summary, invariants registry,
 * and capabilities registry. Data is loaded from the SelfModel IPC surface.
 */

import React, { useState, useEffect } from 'react';

const DARK = {
    bg: '#1e1e1e',
    surface: '#252526',
    border: '#3c3c3c',
    text: '#d4d4d4',
    muted: '#858585',
    accent: '#007acc',
    success: '#4caf50',
    warn: '#ff9800',
    error: '#f44336',
    badge: '#2d2d2d',
};

const CATEGORY_COLORS: Record<string, string> = {
    architectural: '#007acc',
    behavioral: '#9c27b0',
    safety: '#f44336',
    ethical: '#ff9800',
    inference: '#00bcd4',
    memory: '#4caf50',
    retrieval: '#ff9800',
    ui: '#9c27b0',
    tools: '#2196f3',
    identity: '#e91e63',
};

const STATUS_COLORS: Record<string, string> = {
    active: '#4caf50',
    deprecated: '#858585',
    candidate: '#ff9800',
    available: '#4caf50',
    degraded: '#ff9800',
    unavailable: '#f44336',
    optional: '#858585',
};

function Badge({ text, color }: { text: string; color: string }) {
    return (
        <span style={{
            display: 'inline-block',
            padding: '1px 7px',
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 600,
            color: '#fff',
            background: color,
            marginLeft: 6,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
        }}>
            {text}
        </span>
    );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
    const [open, setOpen] = useState(true);
    return (
        <div style={{ marginBottom: 16, border: `1px solid ${DARK.border}`, borderRadius: 4 }}>
            <div
                onClick={() => setOpen(o => !o)}
                style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 12px', cursor: 'pointer', background: DARK.surface,
                    borderRadius: open ? '4px 4px 0 0' : 4,
                }}
            >
                <span style={{ fontSize: 12, fontWeight: 600, color: DARK.text }}>
                    {title}
                    {count !== undefined && (
                        <span style={{ marginLeft: 8, color: DARK.muted, fontWeight: 400 }}>({count})</span>
                    )}
                </span>
                <span style={{ color: DARK.muted, fontSize: 10 }}>{open ? '▲' : '▼'}</span>
            </div>
            {open && (
                <div style={{ padding: '10px 12px', background: DARK.bg }}>
                    {children}
                </div>
            )}
        </div>
    );
}

export function SelfModelPanel() {
    const api = (window as any).tala?.selfModel;

    const [summary, setSummary] = useState<any>(null);
    const [invariants, setInvariants] = useState<any[]>([]);
    const [capabilities, setCapabilities] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = async () => {
        try {
            const [sumResult, invResult, capResult] = await Promise.all([
                api?.getArchitectureSummary(),
                api?.getInvariants(),
                api?.getCapabilities(),
            ]);
            setSummary(sumResult);
            setInvariants(invResult?.invariants ?? []);
            setCapabilities(capResult?.capabilities ?? []);
            setError(null);
        } catch (e: any) {
            setError(e?.message ?? 'Failed to load self-model data');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    const handleRefresh = async () => {
        setRefreshing(true);
        try {
            await api?.refresh();
            await load();
        } catch (e: any) {
            setError(e?.message ?? 'Refresh failed');
        } finally {
            setRefreshing(false);
        }
    };

    const panelStyle: React.CSSProperties = {
        background: DARK.bg,
        color: DARK.text,
        fontFamily: 'monospace',
        fontSize: 12,
        padding: 16,
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
    };

    if (loading) {
        return <div style={panelStyle}>Loading self-model…</div>;
    }

    if (error) {
        return (
            <div style={panelStyle}>
                <div style={{ color: DARK.error, marginBottom: 12 }}>⚠ {error}</div>
                <button onClick={load} style={{ background: DARK.accent, color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}>
                    Retry
                </button>
            </div>
        );
    }

    return (
        <div style={panelStyle}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: DARK.text }}>Architecture Self-Model</div>
                    <div style={{ fontSize: 10, color: DARK.muted, marginTop: 2 }}>Phase 1 — Invariants & Capabilities</div>
                </div>
                <button
                    onClick={handleRefresh}
                    disabled={refreshing}
                    style={{
                        background: DARK.accent, color: '#fff', border: 'none',
                        padding: '5px 12px', borderRadius: 3, cursor: refreshing ? 'not-allowed' : 'pointer',
                        fontSize: 11, opacity: refreshing ? 0.6 : 1,
                    }}
                >
                    {refreshing ? 'Refreshing…' : '↺ Refresh'}
                </button>
            </div>

            {/* Architecture Summary */}
            {summary && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
                    {[
                        { label: 'Invariants', value: `${summary.activeInvariants} / ${summary.totalInvariants} active` },
                        { label: 'Capabilities', value: `${summary.availableCapabilities} / ${summary.totalCapabilities} available` },
                        { label: 'Components', value: String(summary.totalComponents) },
                    ].map(item => (
                        <div key={item.label} style={{ background: DARK.surface, border: `1px solid ${DARK.border}`, borderRadius: 4, padding: '8px 12px' }}>
                            <div style={{ fontSize: 10, color: DARK.muted, marginBottom: 4 }}>{item.label}</div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: DARK.text }}>{item.value}</div>
                        </div>
                    ))}
                </div>
            )}

            {/* Invariants */}
            <Section title="Invariants" count={invariants.length}>
                {invariants.length === 0 ? (
                    <div style={{ color: DARK.muted, fontSize: 11 }}>No invariants loaded.</div>
                ) : (
                    invariants.map((inv: any) => (
                        <div key={inv.id} style={{ borderBottom: `1px solid ${DARK.border}`, paddingBottom: 8, marginBottom: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                                <span style={{ fontWeight: 600, color: DARK.text }}>{inv.label}</span>
                                <Badge text={inv.category} color={CATEGORY_COLORS[inv.category] ?? DARK.muted} />
                                <Badge text={inv.status} color={STATUS_COLORS[inv.status] ?? DARK.muted} />
                            </div>
                            <div style={{ color: DARK.muted, fontSize: 11, marginTop: 3 }}>{inv.description}</div>
                            {inv.enforcedBy && (
                                <div style={{ color: DARK.muted, fontSize: 10, marginTop: 2 }}>
                                    enforced by: <span style={{ color: DARK.text }}>{inv.enforcedBy}</span>
                                </div>
                            )}
                        </div>
                    ))
                )}
            </Section>

            {/* Capabilities */}
            <Section title="Capabilities" count={capabilities.length}>
                {capabilities.length === 0 ? (
                    <div style={{ color: DARK.muted, fontSize: 11 }}>No capabilities loaded.</div>
                ) : (
                    capabilities.map((cap: any) => (
                        <div key={cap.id} style={{ borderBottom: `1px solid ${DARK.border}`, paddingBottom: 8, marginBottom: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                                <span style={{ fontWeight: 600, color: DARK.text }}>{cap.label}</span>
                                <Badge text={cap.category} color={CATEGORY_COLORS[cap.category] ?? DARK.muted} />
                                <Badge text={cap.status} color={STATUS_COLORS[cap.status] ?? DARK.muted} />
                            </div>
                            <div style={{ color: DARK.muted, fontSize: 11, marginTop: 3 }}>{cap.description}</div>
                            {cap.requiredFor && cap.requiredFor.length > 0 && (
                                <div style={{ color: DARK.muted, fontSize: 10, marginTop: 2 }}>
                                    required for: <span style={{ color: DARK.text }}>{cap.requiredFor.join(', ')}</span>
                                </div>
                            )}
                        </div>
                    ))
                )}
            </Section>
        </div>
    );
}
