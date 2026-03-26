import React, { useState, useEffect, useCallback } from 'react';

/**
 * SelfModelPanel — Phase 1G
 *
 * Diagnostic surface for the self-model system.
 * Exposes the full self-model inspection capabilities through a tabbed UI.
 *
 * Tabs:
 * - Overview: status badge, meta, artifact counts, kind summary
 * - Subsystems: list of subsystem records with blast radius and invariants
 * - Invariants: full invariant registry
 * - Capabilities: full capability registry
 * - Query: free-text self-inspection query tool
 *
 * Data source: window.tala.selfModel.* IPC calls
 */

// ─── Type imports (inline to avoid renderer-side type dependencies) ───────────

type SelfModelHealthStatus = 'fresh' | 'stale' | 'drifted' | 'missing' | 'error';

interface SelfModelMeta {
    version: string;
    generatedAt: string;
    commitSha?: string;
    indexHash: string;
    ownershipHash: string;
    status: SelfModelHealthStatus;
    staleReasons: string[];
    driftedSubsystems: string[];
    refreshDurationMs: number;
}

interface SubsystemRecord {
    id: string;
    name: string;
    description: string;
    rootPaths: string[];
    authorityFiles: string[];
    entrypoints: string[];
    dependencies: string[];
    dependents: string[];
    invariantIds: string[];
    testFiles: string[];
    docFiles: string[];
    riskLevel: string;
    confidence: string;
    notes?: string;
}

interface InvariantRecord {
    id: string;
    title: string;
    description: string;
    severity: string;
    appliesToSubsystems: string[];
    enforcementMode: string;
    testFileRefs?: string[];
    verificationHints?: string[];
    notes?: string;
}

interface CapabilityRecord {
    id: string;
    name: string;
    available: boolean;
    authoritySource: string;
    executionPath?: string;
    constraints?: string[];
    ipcChannels?: string[];
    allowedModes?: string[];
    notes?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusColor(status: SelfModelHealthStatus | string): string {
    switch (status) {
        case 'fresh': return '#22c55e';
        case 'stale': return '#f59e0b';
        case 'drifted': return '#f97316';
        case 'missing': return '#ef4444';
        case 'error': return '#ef4444';
        default: return '#9ca3af';
    }
}

function riskColor(risk: string): string {
    switch (risk) {
        case 'critical': return '#ef4444';
        case 'high': return '#f97316';
        case 'medium': return '#f59e0b';
        case 'low': return '#22c55e';
        default: return '#9ca3af';
    }
}

function confidenceColor(confidence: string): string {
    switch (confidence) {
        case 'high': return '#22c55e';
        case 'medium': return '#f59e0b';
        case 'low': return '#f97316';
        default: return '#9ca3af';
    }
}

function Badge({ label, color }: { label: string; color: string }) {
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
            background: color + '22', color, border: `1px solid ${color}55`,
            textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: color, display: 'inline-block' }} />
            {label}
        </span>
    );
}

const tala = () => (window as any).tala;

// ─── Sub-components ───────────────────────────────────────────────────────────

function OverviewTab({ meta, onRefresh, refreshing }: {
    meta: SelfModelMeta | null;
    onRefresh: (force: boolean) => void;
    refreshing: boolean;
}) {
    if (!meta) {
        return (
            <div style={{ padding: 24, color: '#9ca3af' }}>
                <p>No self-model data found.</p>
                <button onClick={() => onRefresh(true)} disabled={refreshing}
                    style={{ marginTop: 12, padding: '8px 16px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                    {refreshing ? 'Generating…' : 'Generate Self-Model Now'}
                </button>
            </div>
        );
    }

    const ageMs = Date.now() - new Date(meta.generatedAt).getTime();
    const ageMin = Math.round(ageMs / 60000);

    return (
        <div style={{ padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
                <Badge label={meta.status} color={statusColor(meta.status)} />
                <span style={{ color: '#6b7280', fontSize: 12 }}>
                    Generated {ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`}
                    {meta.commitSha ? ` · ${meta.commitSha.slice(0, 8)}` : ''}
                </span>
                <button onClick={() => onRefresh(true)} disabled={refreshing}
                    style={{ marginLeft: 'auto', padding: '6px 14px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, cursor: refreshing ? 'not-allowed' : 'pointer', fontSize: 12 }}>
                    {refreshing ? 'Refreshing…' : '↻ Refresh'}
                </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
                <MetaCard label="Refresh time" value={`${meta.refreshDurationMs}ms`} />
                <MetaCard label="Drifted subsystems" value={String(meta.driftedSubsystems.length)} />
                <MetaCard label="Version" value={meta.version} />
            </div>

            {meta.staleReasons.length > 0 && (
                <div style={{ background: '#f97316' + '11', border: '1px solid #f97316' + '44', borderRadius: 8, padding: 12, marginBottom: 16 }}>
                    <div style={{ fontWeight: 600, color: '#f97316', marginBottom: 6, fontSize: 12 }}>Stale reasons</div>
                    {meta.staleReasons.map(r => <div key={r} style={{ fontSize: 11, color: '#d1d5db' }}>• {r}</div>)}
                </div>
            )}

            {meta.driftedSubsystems.length > 0 && (
                <div style={{ background: '#f97316' + '11', border: '1px solid #f97316' + '44', borderRadius: 8, padding: 12 }}>
                    <div style={{ fontWeight: 600, color: '#f97316', marginBottom: 6, fontSize: 12 }}>Drifted subsystems</div>
                    {meta.driftedSubsystems.map(s => <div key={s} style={{ fontSize: 11, color: '#d1d5db' }}>• {s}</div>)}
                </div>
            )}
        </div>
    );
}

function MetaCard({ label, value }: { label: string; value: string }) {
    return (
        <div style={{ background: '#1e2030', border: '1px solid #2d3148', borderRadius: 8, padding: '12px 16px' }}>
            <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#e5e7eb' }}>{value}</div>
        </div>
    );
}

function SubsystemsTab({ subsystems }: { subsystems: SubsystemRecord[] }) {
    const [expanded, setExpanded] = useState<string | null>(null);

    if (!subsystems.length) return <div style={{ padding: 24, color: '#9ca3af' }}>No subsystem data. Run a refresh first.</div>;

    return (
        <div style={{ padding: 16 }}>
            {subsystems.map(s => (
                <div key={s.id} style={{ border: '1px solid #2d3148', borderRadius: 8, marginBottom: 8, overflow: 'hidden' }}>
                    <div
                        onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', cursor: 'pointer', background: expanded === s.id ? '#1e2030' : 'transparent' }}
                    >
                        <Badge label={s.riskLevel} color={riskColor(s.riskLevel)} />
                        <span style={{ fontWeight: 600, color: '#e5e7eb', flex: 1 }}>{s.name}</span>
                        <span style={{ fontSize: 11, color: '#6b7280' }}>{s.id}</span>
                        <Badge label={s.confidence} color={confidenceColor(s.confidence)} />
                        <span style={{ color: '#6b7280', fontSize: 14 }}>{expanded === s.id ? '▲' : '▼'}</span>
                    </div>
                    {expanded === s.id && (
                        <div style={{ padding: '12px 14px', background: '#1e2030', borderTop: '1px solid #2d3148' }}>
                            <p style={{ color: '#9ca3af', fontSize: 12, margin: '0 0 10px' }}>{s.description}</p>
                            <Detail label="Authority files" items={s.authorityFiles} />
                            <Detail label="Dependencies" items={s.dependencies} />
                            <Detail label="Dependents (blast radius)" items={s.dependents} />
                            <Detail label="Invariants" items={s.invariantIds} />
                            <Detail label="Test files" items={s.testFiles} />
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}

function Detail({ label, items }: { label: string; items: string[] }) {
    if (!items.length) return null;
    return (
        <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {items.map(item => (
                    <span key={item} style={{ fontSize: 10, background: '#374151', color: '#d1d5db', padding: '2px 6px', borderRadius: 4, fontFamily: 'monospace' }}>{item}</span>
                ))}
            </div>
        </div>
    );
}

function InvariantsTab({ invariants }: { invariants: InvariantRecord[] }) {
    if (!invariants.length) return <div style={{ padding: 24, color: '#9ca3af' }}>No invariants loaded.</div>;

    return (
        <div style={{ padding: 16 }}>
            {invariants.map(inv => (
                <div key={inv.id} style={{ border: '1px solid #2d3148', borderRadius: 8, padding: '12px 14px', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#6b7280' }}>{inv.id}</span>
                        <Badge label={inv.severity} color={riskColor(inv.severity)} />
                        <Badge label={inv.enforcementMode.replace('_', ' ')} color="#3b82f6" />
                        <span style={{ fontWeight: 600, color: '#e5e7eb', flex: 1 }}>{inv.title}</span>
                    </div>
                    <p style={{ color: '#9ca3af', fontSize: 12, margin: '0 0 8px' }}>{inv.description}</p>
                    {inv.appliesToSubsystems.length > 0 && (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {inv.appliesToSubsystems.map(s => (
                                <span key={s} style={{ fontSize: 10, background: '#374151', color: '#d1d5db', padding: '2px 6px', borderRadius: 4, fontFamily: 'monospace' }}>{s}</span>
                            ))}
                        </div>
                    )}
                    {inv.testFileRefs && inv.testFileRefs.length > 0 && (
                        <div style={{ marginTop: 6, fontSize: 11, color: '#22c55e' }}>
                            ✓ {inv.testFileRefs.join(', ')}
                        </div>
                    )}
                    {inv.notes && <div style={{ marginTop: 6, fontSize: 11, color: '#6b7280', fontStyle: 'italic' }}>{inv.notes}</div>}
                </div>
            ))}
        </div>
    );
}

function CapabilitiesTab({ capabilities }: { capabilities: CapabilityRecord[] }) {
    if (!capabilities.length) return <div style={{ padding: 24, color: '#9ca3af' }}>No capabilities loaded.</div>;

    return (
        <div style={{ padding: 16 }}>
            {capabilities.map(cap => (
                <div key={cap.id} style={{ border: '1px solid #2d3148', borderRadius: 8, padding: '12px 14px', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#6b7280' }}>{cap.id}</span>
                        <Badge label={cap.available ? 'available' : 'not available'} color={cap.available ? '#22c55e' : '#9ca3af'} />
                        <span style={{ fontWeight: 600, color: '#e5e7eb', flex: 1 }}>{cap.name}</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace', marginBottom: 4 }}>{cap.authoritySource}</div>
                    {cap.allowedModes && cap.allowedModes.length > 0 && (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                            {cap.allowedModes.map(m => (
                                <span key={m} style={{ fontSize: 10, background: '#1e40af' + '44', color: '#93c5fd', padding: '2px 6px', borderRadius: 4 }}>{m}</span>
                            ))}
                        </div>
                    )}
                    {cap.notes && <div style={{ marginTop: 6, fontSize: 11, color: '#6b7280', fontStyle: 'italic' }}>{cap.notes}</div>}
                </div>
            ))}
        </div>
    );
}

function QueryTab() {
    const [queryText, setQueryText] = useState('');
    const [queryType, setQueryType] = useState<'ownership' | 'invariants' | 'blastRadius' | 'explain'>('ownership');
    const [result, setResult] = useState<unknown>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleQuery = useCallback(async () => {
        if (!queryText.trim()) return;
        setLoading(true);
        setError(null);
        setResult(null);
        try {
            const sm = tala()?.selfModel;
            if (!sm) { setError('Self-model IPC not available'); return; }
            let res: unknown;
            if (queryType === 'ownership') res = await sm.queryOwnership(queryText);
            else if (queryType === 'invariants') res = await sm.queryInvariants(queryText);
            else if (queryType === 'blastRadius') res = await sm.queryBlastRadius(queryText);
            else res = await sm.explainOwnership(queryText);
            setResult(res);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, [queryText, queryType]);

    return (
        <div style={{ padding: 20 }}>
            <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Query type</label>
                <select value={queryType} onChange={e => setQueryType(e.target.value as typeof queryType)}
                    style={{ background: '#1e2030', color: '#e5e7eb', border: '1px solid #2d3148', borderRadius: 6, padding: '6px 10px', fontSize: 12, width: '100%' }}>
                    <option value="ownership">Ownership — who owns this file/behavior?</option>
                    <option value="invariants">Invariants — what invariants apply to this subsystem?</option>
                    <option value="blastRadius">Blast radius — what systems are affected?</option>
                    <option value="explain">Explain — human-readable ownership explanation</option>
                </select>
            </div>
            <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, color: '#9ca3af', display: 'block', marginBottom: 4 }}>
                    {queryType === 'invariants' ? 'Subsystem ID (e.g. "inference", "memory")' : 'File path or search term (e.g. "AgentService", "reflection")'}
                </label>
                <input value={queryText} onChange={e => setQueryText(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleQuery()}
                    placeholder={queryType === 'invariants' ? 'e.g. memory' : 'e.g. AgentService.ts'}
                    style={{ background: '#1e2030', color: '#e5e7eb', border: '1px solid #2d3148', borderRadius: 6, padding: '8px 12px', fontSize: 12, width: '100%', boxSizing: 'border-box' }} />
            </div>
            <button onClick={handleQuery} disabled={loading || !queryText.trim()}
                style={{ padding: '8px 18px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
                {loading ? 'Querying…' : 'Query'}
            </button>

            {error && <div style={{ marginTop: 16, color: '#ef4444', fontSize: 12, background: '#ef444411', padding: 10, borderRadius: 6 }}>{error}</div>}

            {result !== null && (
                <div style={{ marginTop: 16 }}>
                    {typeof result === 'string' ? (
                        <pre style={{ background: '#1e2030', border: '1px solid #2d3148', borderRadius: 8, padding: 14, fontSize: 12, color: '#d1d5db', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{result}</pre>
                    ) : (
                        <QueryResultView result={result as Record<string, unknown>} />
                    )}
                </div>
            )}
        </div>
    );
}

function QueryResultView({ result }: { result: Record<string, unknown> }) {
    const confidence = result.confidence as string | undefined;
    const reasoning = result.reasoning as string | undefined;
    const owningSubsystem = result.owningSubsystem as SubsystemRecord | undefined;
    const relatedTests = result.relatedTests as string[] | undefined;
    const relatedInvariants = result.relatedInvariants as InvariantRecord[] | undefined;
    const directDependents = result.directDependents as string[] | undefined;
    const transitivelyAffected = result.transitivelyAffected as string[] | undefined;

    return (
        <div style={{ background: '#1e2030', border: '1px solid #2d3148', borderRadius: 8, padding: 14 }}>
            {confidence && <div style={{ marginBottom: 10 }}><Badge label={`confidence: ${confidence}`} color={confidenceColor(confidence)} /></div>}
            {reasoning && <p style={{ color: '#9ca3af', fontSize: 12, margin: '0 0 12px' }}>{reasoning}</p>}
            {owningSubsystem && (
                <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', marginBottom: 4 }}>Owning subsystem</div>
                    <div style={{ fontWeight: 600, color: '#e5e7eb' }}>{owningSubsystem.name}</div>
                    <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>{owningSubsystem.id}</div>
                    <Badge label={owningSubsystem.riskLevel} color={riskColor(owningSubsystem.riskLevel)} />
                </div>
            )}
            {relatedTests && relatedTests.length > 0 && <Detail label="Related tests" items={relatedTests} />}
            {relatedInvariants && relatedInvariants.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', marginBottom: 4 }}>Related invariants</div>
                    {relatedInvariants.map(inv => (
                        <div key={inv.id} style={{ fontSize: 11, color: '#d1d5db', marginBottom: 2 }}>
                            <span style={{ fontFamily: 'monospace', color: '#6b7280' }}>{inv.id}</span> — {inv.title}
                        </div>
                    ))}
                </div>
            )}
            {directDependents && <Detail label="Direct dependents" items={directDependents} />}
            {transitivelyAffected && transitivelyAffected.length > 0 && <Detail label="Transitively affected" items={transitivelyAffected} />}
        </div>
    );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

const SelfModelPanel: React.FC = () => {
    const [activeTab, setActiveTab] = useState<'overview' | 'subsystems' | 'invariants' | 'capabilities' | 'query'>('overview');
    const [meta, setMeta] = useState<SelfModelMeta | null>(null);
    const [subsystems, setSubsystems] = useState<SubsystemRecord[]>([]);
    const [invariants, setInvariants] = useState<InvariantRecord[]>([]);
    const [capabilities, setCapabilities] = useState<CapabilityRecord[]>([]);
    const [refreshing, setRefreshing] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    const loadData = useCallback(async () => {
        const sm = tala()?.selfModel;
        if (!sm) { setLoadError('Self-model IPC bridge not available'); return; }
        try {
            setLoadError(null);
            const [metaRes, ownershipRes, invRes, capRes] = await Promise.allSettled([
                sm.getMeta(),
                sm.getOwnershipMap(),
                sm.getInvariants(),
                sm.getCapabilities(),
            ]);
            if (metaRes.status === 'fulfilled') setMeta(metaRes.value);
            if (ownershipRes.status === 'fulfilled' && ownershipRes.value?.subsystems) {
                setSubsystems(ownershipRes.value.subsystems);
            }
            if (invRes.status === 'fulfilled' && invRes.value?.invariants) {
                setInvariants(invRes.value.invariants);
            }
            if (capRes.status === 'fulfilled' && capRes.value?.capabilities) {
                setCapabilities(capRes.value.capabilities);
            }
        } catch (e: unknown) {
            setLoadError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    useEffect(() => { loadData(); }, [loadData]);

    const handleRefresh = useCallback(async (force: boolean) => {
        const sm = tala()?.selfModel;
        if (!sm) return;
        setRefreshing(true);
        try {
            const newMeta = await sm.refresh(force);
            setMeta(newMeta);
            await loadData();
        } catch (e: unknown) {
            console.error('Self-model refresh failed:', e);
        } finally {
            setRefreshing(false);
        }
    }, [loadData]);

    const TABS: Array<{ id: typeof activeTab; label: string }> = [
        { id: 'overview', label: 'Overview' },
        { id: 'subsystems', label: `Subsystems (${subsystems.length})` },
        { id: 'invariants', label: `Invariants (${invariants.length})` },
        { id: 'capabilities', label: `Capabilities (${capabilities.length})` },
        { id: 'query', label: 'Query' },
    ];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#111827', color: '#e5e7eb', fontFamily: 'system-ui, sans-serif' }}>
            {/* Header */}
            <div style={{ padding: '16px 20px 0', borderBottom: '1px solid #1f2937' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                    <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#f3f4f6' }}>Self-Model</h2>
                    {meta && <Badge label={meta.status} color={statusColor(meta.status)} />}
                    {loadError && <span style={{ fontSize: 11, color: '#ef4444' }}>Error: {loadError}</span>}
                </div>
                <div style={{ display: 'flex', gap: 2 }}>
                    {TABS.map(tab => (
                        <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                            style={{
                                padding: '6px 14px', border: 'none', borderRadius: '6px 6px 0 0', cursor: 'pointer', fontSize: 12, fontWeight: 500,
                                background: activeTab === tab.id ? '#1f2937' : 'transparent',
                                color: activeTab === tab.id ? '#e5e7eb' : '#6b7280',
                                borderBottom: activeTab === tab.id ? '2px solid #3b82f6' : '2px solid transparent',
                            }}>
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Tab content */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
                {activeTab === 'overview' && <OverviewTab meta={meta} onRefresh={handleRefresh} refreshing={refreshing} />}
                {activeTab === 'subsystems' && <SubsystemsTab subsystems={subsystems} />}
                {activeTab === 'invariants' && <InvariantsTab invariants={invariants} />}
                {activeTab === 'capabilities' && <CapabilitiesTab capabilities={capabilities} />}
                {activeTab === 'query' && <QueryTab />}
            </div>
        </div>
    );
};

export default SelfModelPanel;
