/**
 * Log Viewer Panel
 * 
 * An advanced diagnostic interface for inspecting system logs, performance metrics,
 * and subsystem health snapshots.
 * 
 * **Key Features:**
 * - **Multi-source Reading**: Switches between different log providers (e.g., standard, specialized).
 * - **Diagnostic Intelligence**: Calculates error/warn counts and unique session/turn distributions.
 * - **Correlation Engine**: Links related logs by `sessionId` or `turnId` to reconstruct events.
 * - **Timeline Visualization**: Reconstructs the execution flow for specific agent turns.
 * - **Health Monitoring**: Displays real-time status of backend subsystems (Ollama, RAG, etc.).
 * - **Log Management**: Supports archiving, clearing, and exporting log data.
 * 
 * @param api The `window.tala` IPC bridge.
 */
import React, { useState, useEffect, useMemo } from 'react';
import type {
    LogSeverity,
    LogViewerEntry,
    LogSourceInfo,
    PerformanceSummary,
    LogDiagnosticsSummary
} from '../logTypes';
import type { SystemHealthSnapshot } from '../../../shared/system-health-types';

interface LogViewerPanelProps {
    api: any;
}

export const LogViewerPanel: React.FC<LogViewerPanelProps> = ({ api }) => {
    const [sources, setSources] = useState<LogSourceInfo[]>([]);
    const [activeSourceId, setActiveSourceId] = useState<string>('');
    const [entries, setEntries] = useState<LogViewerEntry[]>([]);
    const [selectedEntry, setSelectedEntry] = useState<LogViewerEntry | null>(null);
    const [loading, setLoading] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [severityFilter, setSeverityFilter] = useState<Record<LogSeverity, boolean>>({
        debug: true,
        info: true,
        warn: true,
        error: true,
        unknown: true
    });

    const [subsystemFilter, setSubsystemFilter] = useState<string>('all');
    const [errorsOnly, setErrorsOnly] = useState(false);
    const [autoRefresh, setAutoRefresh] = useState(false);
    const [healthSnapshot, setHealthSnapshot] = useState<SystemHealthSnapshot | null>(null);
    const [detailsTab, setDetailsTab] = useState<'info' | 'raw' | 'related' | 'insights' | 'timeline'>('info');
    const [correlatedEntries, setCorrelatedEntries] = useState<LogViewerEntry[]>([]);
    const [correlationLoading, setCorrelationLoading] = useState(false);
    const [timelineEntries, setTimelineEntries] = useState<LogViewerEntry[]>([]);
    const [timelineLoading, setTimelineLoading] = useState(false);
    const [performanceSummary, setPerformanceSummary] = useState<PerformanceSummary | null>(null);

    // Initial load
    useEffect(() => {
        const init = async () => {
            try {
                const src = await api.logs.listSources();
                setSources(src);
                if (src.length > 0 && !activeSourceId) {
                    setActiveSourceId(src[0].id);
                }
                loadHealth();
                loadPerformance();
            } catch (e) {
                console.error("Failed to initialize logs", e);
            }
        };
        init();
    }, []);

    // Load entries when source changes
    useEffect(() => {
        if (activeSourceId) {
            loadEntries();
        }
    }, [activeSourceId]);

    // Auto-refresh logic
    useEffect(() => {
        let interval: any = null;
        if (autoRefresh && activeSourceId) {
            interval = setInterval(() => {
                loadEntries(false);
                loadHealth();
                loadPerformance();
            }, 5000);
        }
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [autoRefresh, activeSourceId]);

    // Load related and timeline entries when selectedEntry changes
    useEffect(() => {
        if (selectedEntry) {
            if (selectedEntry.sessionId || selectedEntry.turnId) {
                loadCorrelation();
            }
            if (selectedEntry.turnId) {
                loadTimeline();
            }
        } else {
            setCorrelatedEntries([]);
            setTimelineEntries([]);
        }
    }, [selectedEntry]);

    const loadEntries = async (showLoading = true) => {
        if (!activeSourceId) return;
        if (showLoading) setLoading(true);
        try {
            const result = await api.logs.readEntries({ sourceId: activeSourceId, limit: 500 });
            const newEntries = result.entries || [];

            if (autoRefresh) {
                setEntries(prev => {
                    const existingIds = new Set(prev.map((e: LogViewerEntry) => e.id));
                    const uniqueNew = newEntries.filter((e: LogViewerEntry) => !existingIds.has(e.id));
                    return [...uniqueNew, ...prev].sort((a: LogViewerEntry, b: LogViewerEntry) =>
                        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
                    ).slice(0, 1000);
                });
            } else {
                setEntries(newEntries);
            }
        } catch (err: any) {
            console.error("Failed to load entries", err);
        } finally {
            if (showLoading) setLoading(false);
        }
    };

    const loadHealth = async () => {
        try {
            const snapshot = await api.logs.getHealthSnapshot();
            setHealthSnapshot(snapshot);
        } catch (e) {
            console.error("Failed to load health snapshot", e);
        }
    };

    const loadPerformance = async () => {
        try {
            const summary = await api.logs.getPerformanceSummary();
            setPerformanceSummary(summary);
        } catch (e) {
            console.error("Failed to load performance summary", e);
        }
    };

    const loadCorrelation = async () => {
        if (!selectedEntry) return;
        setCorrelationLoading(true);
        try {
            const result = await api.logs.getCorrelationEntries({
                sessionId: selectedEntry.sessionId,
                turnId: selectedEntry.turnId
            });
            setCorrelatedEntries(result || []);
        } catch (e) {
            console.error("Failed to load correlation", e);
        } finally {
            setCorrelationLoading(false);
        }
    };

    const loadTimeline = async () => {
        if (!selectedEntry?.turnId) return;
        setTimelineLoading(true);
        try {
            const result = await api.logs.getTimelineEntries({ turnId: selectedEntry.turnId });
            setTimelineEntries(result || []);
        } catch (e) {
            console.error("Failed to load timeline", e);
        } finally {
            setTimelineLoading(false);
        }
    };

    const filteredEntries = useMemo(() => {
        return entries.filter(entry => {
            if (errorsOnly && entry.level !== 'error' && entry.level !== 'warn') return false;

            const matchesSeverity = severityFilter[entry.level];
            const matchesSubsystem = subsystemFilter === 'all' || entry.subsystem === subsystemFilter;
            const matchesSearch = searchQuery === '' ||
                entry.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
                entry.eventType.toLowerCase().includes(searchQuery.toLowerCase()) ||
                entry.subsystem?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                entry.id.toLowerCase().includes(searchQuery.toLowerCase());

            return matchesSeverity && matchesSubsystem && matchesSearch;
        });
    }, [entries, severityFilter, searchQuery, subsystemFilter, errorsOnly]);

    const diagnosticsSummary = useMemo((): LogDiagnosticsSummary => {
        const sessions = new Set();
        const turns = new Set();
        let errors = 0;
        let warns = 0;
        let prompts = 0;

        filteredEntries.forEach(e => {
            if (e.level === 'error') errors++;
            if (e.level === 'warn') warns++;
            if (e.subsystem === 'prompt_audit') prompts++;
            if (e.sessionId) sessions.add(e.sessionId);
            if (e.turnId) turns.add(e.turnId);
        });

        return {
            totalEntries: filteredEntries.length,
            errorCount: errors,
            warnCount: warns,
            promptAuditCount: prompts,
            lastTimestamp: filteredEntries[0]?.timestamp,
            uniqueSessions: sessions.size,
            uniqueTurns: turns.size
        };
    }, [filteredEntries]);

    const subsystems = useMemo(() => {
        const subs = new Set<string>();
        ['ollama', 'rag', 'memory', 'astro', 'prompt_audit', 'routing', 'mcp', 'guardrails', 'app'].forEach(s => subs.add(s));
        entries.forEach(e => { if (e.subsystem) subs.add(e.subsystem); });
        return Array.from(subs).sort();
    }, [entries]);

    const toggleSeverity = (sev: LogSeverity) => {
        setSeverityFilter(prev => ({ ...prev, [sev]: !prev[sev] }));
    };

    const exportLogs = () => {
        const blob = new Blob([JSON.stringify(filteredEntries, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tala_logs_${new Date().toISOString()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleClearSource = async () => {
        if (!activeSourceId) return;
        const source = sources.find(s => s.id === activeSourceId);
        const label = source?.label || activeSourceId;

        if (window.confirm(`Are you sure you want to clear all entries in ${label}? This action cannot be undone.`)) {
            try {
                await api.logs.clearSource(activeSourceId);
                loadEntries();
            } catch (e) {
                console.error("Failed to clear source", e);
                alert("Failed to clear log source.");
            }
        }
    };

    const handleClearAll = async () => {
        if (window.confirm("Are you sure you want to clear ALL diagnostic logs? This will empty all visible log sources.")) {
            try {
                await api.logs.clearAll();
                loadEntries();
            } catch (e) {
                console.error("Failed to clear all logs", e);
                alert("Failed to clear logs.");
            }
        }
    };

    const handleArchiveSource = async () => {
        if (!activeSourceId) return;
        try {
            const result = await api.logs.archiveSource(activeSourceId);
            if (result.success) {
                alert(`Successfully archived to:\n${result.archiveFolder}`);
            } else {
                alert(`Archive failed: ${result.error || 'Unknown error'}`);
            }
        } catch (e: any) {
            console.error("Failed to archive source", e);
            alert(`Failed to archive log source: ${e.message || String(e)}`);
        }
    };

    const handleArchiveAll = async () => {
        if (window.confirm("Are you sure you want to archive ALL diagnostic logs into a new folder?")) {
            try {
                const result = await api.logs.archiveAll();
                if (result.success) {
                    alert(`Successfully archived ${result.copiedFiles.filter((f: any) => f.copied).length} sources to:\n${result.archiveFolder}`);
                } else {
                    alert(`Archive failed: ${result.error || 'Unknown error'}`);
                }
            } catch (e: any) {
                console.error("Failed to archive all logs", e);
                alert(`Failed to archive logs: ${e.message || String(e)}`);
            }
        }
    };

    // Styles
    const panelStyle: React.CSSProperties = {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#1e1e1e',
        color: '#ccc',
        fontFamily: 'Segoe UI, Tahoma, Geneva, Verdana, sans-serif'
    };

    const dashboardStyle: React.CSSProperties = {
        padding: '15px 20px',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '12px',
        background: '#252526',
        borderBottom: '1px solid #333'
    };

    const summaryCardStyle = (color?: string): React.CSSProperties => ({
        padding: '12px',
        background: 'rgba(255, 255, 255, 0.03)',
        borderLeft: `3px solid ${color || '#007acc'}`,
        borderRadius: '4px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px'
    });

    const toolbarStyle: React.CSSProperties = {
        padding: '10px 20px',
        borderBottom: '1px solid #333',
        display: 'flex',
        gap: '15px',
        alignItems: 'center',
        background: '#2d2d2d',
        flexWrap: 'wrap'
    };

    const contentStyle: React.CSSProperties = {
        display: 'flex',
        flex: 1,
        minHeight: 0
    };

    const tableContainerStyle: React.CSSProperties = {
        flex: 1,
        overflowY: 'auto',
        borderRight: '1px solid #333',
        minWidth: '400px',
        background: '#111'
    };

    const detailsPaneStyle: React.CSSProperties = {
        width: '40%',
        minWidth: '350px',
        background: '#1e1e1e',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        borderLeft: '1px solid #333'
    };

    const tableStyle: React.CSSProperties = {
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: '12px'
    };

    const getSeverityColor = (sev: LogSeverity) => {
        switch (sev) {
            case 'error': return '#f14c4c';
            case 'warn': return '#cca700';
            case 'debug': return '#888';
            case 'info': return '#3794ff';
            default: return '#ccc';
        }
    };

    const inputStyle: React.CSSProperties = {
        background: '#3c3c3c',
        border: '1px solid #3e3e42',
        padding: '6px 10px',
        color: '#eee',
        fontSize: '11px',
        borderRadius: '2px',
        outline: 'none'
    };

    const healthBadge = (status: string) => {
        let color = '#888';
        if (status === 'healthy') color = '#4caf50';
        if (status === 'degraded' || status === 'maintenance' || status === 'recovery') color = '#ff9800';
        if (status === 'impaired' || status === 'failed') color = '#f44336';

        return (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: color }} />
                <span style={{ fontSize: '10px', fontWeight: 'bold' }}>{status.toUpperCase()}</span>
            </div>
        );
    };

    return (
        <div style={panelStyle}>
            {/* Dashboard Summary */}
            <div style={dashboardStyle}>
                <div style={summaryCardStyle()}>
                    <span style={{ fontSize: '10px', color: '#888', fontWeight: 'bold' }}>TOTAL EVENTS</span>
                    <span style={{ fontSize: '18px', fontWeight: 'bold' }}>{diagnosticsSummary.totalEntries}</span>
                </div>
                <div style={summaryCardStyle(getSeverityColor('error'))}>
                    <span style={{ fontSize: '10px', color: '#888', fontWeight: 'bold' }}>ERRORS / WARNS</span>
                    <span style={{ fontSize: '18px', fontWeight: 'bold', color: diagnosticsSummary.errorCount > 0 ? getSeverityColor('error') : '#eee' }}>
                        {diagnosticsSummary.errorCount} / {diagnosticsSummary.warnCount}
                    </span>
                </div>
                <div style={summaryCardStyle('#9cdcfe')}>
                    <span style={{ fontSize: '10px', color: '#888', fontWeight: 'bold' }}>PROMPT AUDITS</span>
                    <span style={{ fontSize: '18px', fontWeight: 'bold' }}>{diagnosticsSummary.promptAuditCount}</span>
                </div>
                <div style={summaryCardStyle('#b5cea8')}>
                    <span style={{ fontSize: '10px', color: '#888', fontWeight: 'bold' }}>SESSIONS / TURNS</span>
                    <span style={{ fontSize: '18px', fontWeight: 'bold' }}>{diagnosticsSummary.uniqueSessions} / {diagnosticsSummary.uniqueTurns}</span>
                </div>
                {performanceSummary && (
                    <div style={{ ...summaryCardStyle('#f48771'), minWidth: '220px' }}>
                        <span style={{ fontSize: '10px', color: '#888', fontWeight: 'bold', borderBottom: '1px solid #444', marginBottom: '4px' }}>PERFORMANCE (AVG)</span>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px', gap: '4px', fontSize: '10px' }}>
                            <span style={{ opacity: 0.7 }}>OLLAMA:</span>
                            <span style={{ textAlign: 'right', fontWeight: 'bold' }}>{Math.round(performanceSummary.avgOllamaLatency)}ms</span>
                            <span style={{ opacity: 0.7 }}>ASSEMBLY:</span>
                            <span style={{ textAlign: 'right' }}>{Math.round(performanceSummary.avgPromptAssemblyTime)}ms</span>
                            <span style={{ opacity: 0.7 }}>RAG SEARCH:</span>
                            <span style={{ textAlign: 'right' }}>{Math.round(performanceSummary.avgRagQueryTime)}ms</span>
                        </div>
                    </div>
                )}
                {healthSnapshot && (
                    <div style={{ ...summaryCardStyle('#888'), borderLeft: '1px solid #333', minWidth: '240px' }}>
                        <span style={{ fontSize: '10px', color: '#888', fontWeight: 'bold', borderBottom: '1px solid #444', marginBottom: '4px' }}>SYSTEM HEALTH</span>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                            <span style={{ fontSize: '9px', opacity: 0.7 }}>OVERALL</span>
                            {healthBadge(healthSnapshot.overall_status)}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                            <span style={{ fontSize: '9px', opacity: 0.7 }}>MODE</span>
                            <span style={{ fontSize: '10px', color: '#ddd' }}>{healthSnapshot.effective_mode}</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', rowGap: '2px' }}>
                            {healthSnapshot.subsystem_entries.map((subsystem) => (
                                <div key={subsystem.name} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
                                    <span style={{ fontSize: '9px', opacity: 0.7 }}>{subsystem.name.toUpperCase()}</span>
                                    {healthBadge(subsystem.status)}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Toolbar */}
            <div style={toolbarStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '10px', fontWeight: 'bold', color: '#888' }}>SOURCE:</span>
                        <select
                            style={inputStyle}
                            value={activeSourceId}
                            onChange={(e) => setActiveSourceId(e.target.value)}
                        >
                            {sources.map(s => (
                                <option key={s.id} value={s.id}>{s.label}</option>
                            ))}
                        </select>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '10px', fontWeight: 'bold', color: '#888' }}>SUBSYSTEM:</span>
                        <select
                            style={inputStyle}
                            value={subsystemFilter}
                            onChange={(e) => setSubsystemFilter(e.target.value)}
                        >
                            <option value="all">All Subsystems</option>
                            {subsystems.map(s => (
                                <option key={s} value={s}>{s.toUpperCase()}</option>
                            ))}
                        </select>
                    </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {(['error', 'warn', 'info', 'debug'] as LogSeverity[]).map(sev => (
                        <button
                            key={sev}
                            onClick={() => toggleSeverity(sev)}
                            style={{
                                background: severityFilter[sev] ? getSeverityColor(sev) : 'transparent',
                                color: severityFilter[sev] ? 'white' : getSeverityColor(sev),
                                border: `1px solid ${getSeverityColor(sev)}`,
                                padding: '3px 8px',
                                borderRadius: '2px',
                                fontSize: '10px',
                                fontWeight: 'bold',
                                cursor: 'pointer',
                                opacity: severityFilter[sev] ? 1 : 0.4
                            }}
                        >
                            {sev.toUpperCase()}
                        </button>
                    ))}
                    <button
                        onClick={() => setErrorsOnly(!errorsOnly)}
                        style={{
                            background: errorsOnly ? '#f14c4c' : 'transparent',
                            color: errorsOnly ? 'white' : '#f14c4c',
                            border: '1px solid #f14c4c',
                            padding: '3px 8px',
                            borderRadius: '2px',
                            fontSize: '10px',
                            fontWeight: 'bold',
                            cursor: 'pointer',
                            marginLeft: '8px'
                        }}
                    >
                        ERRORS ONLY
                    </button>
                </div>

                <div style={{ flex: 1 }}>
                    <input
                        style={{ ...inputStyle, width: '100%', padding: '6px 12px' }}
                        placeholder="Search logs (message, event type, id, subsystem)..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ fontSize: '10px', color: '#666', fontStyle: 'italic' }}>
                        Showing most recent 500 entries
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <button
                            onClick={() => loadEntries()}
                            style={{ ...inputStyle, cursor: 'pointer', borderColor: '#007acc', background: '#007acc', color: 'white' }}
                            disabled={loading}
                        >
                            {loading ? '...' : 'REFRESH'}
                        </button>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10px', color: '#888', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                            <input
                                type="checkbox"
                                checked={autoRefresh}
                                onChange={(e) => setAutoRefresh(e.target.checked)}
                            />
                            LIVE TAIL
                        </label>
                    </div>
                    <button
                        onClick={exportLogs}
                        style={{ ...inputStyle, cursor: 'pointer', border: '1px solid #444' }}
                        title="Export filtered logs to JSON"
                    >
                        EXPORT
                    </button>
                    <div style={{ height: '18px', width: '1px', background: '#444', margin: '0 4px' }} />
                    <button
                        onClick={handleArchiveSource}
                        style={{ ...inputStyle, cursor: 'pointer', border: '1px solid #007acc', color: '#007acc' }}
                        title="Copy current source into a timestamped archive folder"
                    >
                        ARCHIVE CURRENT
                    </button>
                    <button
                        onClick={handleArchiveAll}
                        style={{ ...inputStyle, cursor: 'pointer', background: '#007acc', color: 'white', border: 'none' }}
                        title="Copy all logs into a new timestamped archive folder"
                    >
                        ARCHIVE ALL
                    </button>
                    <div style={{ height: '18px', width: '1px', background: '#444', margin: '0 4px' }} />
                    <button
                        onClick={handleClearSource}
                        style={{ ...inputStyle, cursor: 'pointer', border: '1px solid #f14c4c', color: '#f14c4c' }}
                        title="Clear all entries in the currently selected source"
                    >
                        CLEAR CURRENT
                    </button>
                    <button
                        onClick={handleClearAll}
                        style={{ ...inputStyle, cursor: 'pointer', background: '#f14c4c', color: 'white', border: 'none' }}
                        title="Clear ALL diagnostic logs"
                    >
                        CLEAR ALL
                    </button>
                </div>
            </div>

            {/* Table Area */}
            <div style={contentStyle}>
                <div style={tableContainerStyle}>
                    <table style={tableStyle}>
                        <thead style={{ position: 'sticky', top: 0, background: '#252526', zIndex: 1, boxShadow: '0 2px 2px rgba(0,0,0,0.5)' }}>
                            <tr style={{ textAlign: 'left', color: '#888', textTransform: 'uppercase', fontSize: '10px' }}>
                                <th style={{ padding: '10px 8px', width: '40px', textAlign: 'center' }}>Level</th>
                                <th style={{ padding: '10px 8px', width: '140px' }}>Timestamp</th>
                                <th style={{ padding: '10px 8px', width: '110px' }}>Subsystem</th>
                                <th style={{ padding: '10px 8px', width: '120px' }}>Event Type</th>
                                <th style={{ padding: '10px 8px' }}>Message</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredEntries.map(entry => (
                                <tr
                                    key={entry.id}
                                    onClick={() => setSelectedEntry(entry)}
                                    style={{
                                        borderBottom: '1px solid #252526',
                                        cursor: 'pointer',
                                        background: selectedEntry?.id === entry.id ? 'rgba(0, 122, 204, 0.25)' : 'transparent',
                                        transition: 'background 0.1s'
                                    }}
                                    onMouseEnter={(e) => { if (selectedEntry?.id !== entry.id) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                                    onMouseLeave={(e) => { if (selectedEntry?.id !== entry.id) e.currentTarget.style.background = 'transparent'; }}
                                >
                                    <td style={{ padding: '8px', textAlign: 'center' }}>
                                        <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: getSeverityColor(entry.level), margin: 'auto' }} />
                                    </td>
                                    <td style={{ padding: '8px', color: '#888', whiteSpace: 'nowrap', fontSize: '11px' }}>
                                        {new Date(entry.timestamp).toLocaleString(undefined, { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                    </td>
                                    <td style={{ padding: '8px' }}>
                                        <span style={{ color: '#ce9178', background: 'rgba(206, 145, 120, 0.1)', padding: '2px 6px', borderRadius: '3px', fontSize: '10px', fontWeight: 'bold' }}>
                                            {entry.subsystem?.toUpperCase()}
                                        </span>
                                    </td>
                                    <td style={{ padding: '8px', color: '#4fc1ff', fontWeight: '500' }}>{entry.eventType}</td>
                                    <td style={{ padding: '8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '400px', color: '#eee' }}>{entry.message}</td>
                                </tr>
                            ))}
                            {filteredEntries.length === 0 && (
                                <tr>
                                    <td colSpan={5} style={{ padding: '60px', textAlign: 'center', color: '#666' }}>
                                        <div style={{ fontSize: '24px', marginBottom: '10px' }}>🔍</div>
                                        {loading ? 'Refreshing logs...' : errorsOnly ? 'No warnings or errors in the current scope.' : 'No entries found matching filters.'}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>

                {/* Details Sidepane */}
                <div style={detailsPaneStyle}>
                    {selectedEntry ? (
                        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                            {/* Header Tabs */}
                            <div style={{ display: 'flex', background: '#252526', borderBottom: '1px solid #333' }}>
                                {(['info', 'timeline', 'related', 'raw', 'insights'] as const).map(tab => {
                                    const isInsights = tab === 'insights';
                                    const showInsights = isInsights && selectedEntry.subsystem === 'prompt_audit';
                                    if (isInsights && !showInsights) return null;

                                    if (tab === 'timeline' && !selectedEntry.turnId) return null;

                                    return (
                                        <div
                                            key={tab}
                                            onClick={() => setDetailsTab(tab)}
                                            style={{
                                                padding: '10px 15px',
                                                fontSize: '11px',
                                                fontWeight: 'bold',
                                                cursor: 'pointer',
                                                borderBottom: detailsTab === tab ? '2px solid #007acc' : 'none',
                                                color: detailsTab === tab ? '#fff' : '#888',
                                                textTransform: 'uppercase'
                                            }}
                                        >
                                            {tab === 'info' ? 'Summary' : tab}
                                        </div>
                                    );
                                })}
                            </div>

                            <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
                                {detailsTab === 'info' && (
                                    <>
                                        <div style={{ marginBottom: '25px', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                                            <div style={{ padding: '4px 8px', borderRadius: '3px', background: getSeverityColor(selectedEntry.level), color: 'white', fontSize: '10px', fontWeight: 'bold' }}>
                                                {selectedEntry.level.toUpperCase()}
                                            </div>
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontSize: '14px', color: '#eee', fontWeight: '500', lineHeight: 1.4 }}>{selectedEntry.message}</div>
                                                <div style={{ fontSize: '11px', color: '#888', marginTop: '4px' }}>{new Date(selectedEntry.timestamp).toString()}</div>
                                            </div>
                                        </div>

                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '25px' }}>
                                            <div>
                                                <label style={{ fontSize: '10px', color: '#555', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>SUBSYSTEM</label>
                                                <div style={{ color: '#9cdcfe', fontSize: '12px' }}>{selectedEntry.subsystem}</div>
                                            </div>
                                            <div>
                                                <label style={{ fontSize: '10px', color: '#555', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>EVENT TYPE</label>
                                                <div style={{ color: '#9cdcfe', fontSize: '12px' }}>{selectedEntry.eventType}</div>
                                            </div>
                                            <div style={{ cursor: selectedEntry.sessionId ? 'pointer' : 'default' }} onClick={() => selectedEntry.sessionId && setSearchQuery(selectedEntry.sessionId)}>
                                                <label style={{ fontSize: '10px', color: '#555', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>SESSION ID</label>
                                                <div style={{ color: selectedEntry.sessionId ? '#3794ff' : '#666', fontSize: '11px', fontFamily: 'monospace', textDecoration: selectedEntry.sessionId ? 'underline' : 'none' }}>
                                                    {selectedEntry.sessionId || 'N/A'}
                                                </div>
                                            </div>
                                            <div style={{ cursor: selectedEntry.turnId ? 'pointer' : 'default' }} onClick={() => selectedEntry.turnId && setSearchQuery(selectedEntry.turnId)}>
                                                <label style={{ fontSize: '10px', color: '#555', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>TURN ID</label>
                                                <div style={{ color: selectedEntry.turnId ? '#3794ff' : '#666', fontSize: '11px', fontFamily: 'monospace', textDecoration: selectedEntry.turnId ? 'underline' : 'none' }}>
                                                    {selectedEntry.turnId || 'N/A'}
                                                </div>
                                            </div>
                                        </div>

                                        {selectedEntry.sessionId && (
                                            <div style={{ display: 'flex', gap: '8px' }}>
                                                <button
                                                    onClick={() => setSubsystemFilter('all')}
                                                    style={{ ...inputStyle, flex: 1, cursor: 'pointer', background: '#333' }}
                                                >
                                                    Filter this Session
                                                </button>
                                                <button
                                                    onClick={() => setDetailsTab('related')}
                                                    style={{ ...inputStyle, flex: 1, cursor: 'pointer', background: '#333' }}
                                                >
                                                    Related Events
                                                </button>
                                            </div>
                                        )}
                                    </>
                                )}

                                {detailsTab === 'timeline' && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0px' }}>
                                        <div style={{ fontSize: '11px', color: '#888', marginBottom: '15px', borderBottom: '1px solid #333', paddingBottom: '8px' }}>
                                            Timeline for Turn <span style={{ color: '#ce9178', fontWeight: 'bold' }}>{selectedEntry.turnId}</span>
                                        </div>
                                        {timelineLoading ? (
                                            <div style={{ textAlign: 'center', padding: '20px', color: '#666' }}>Reconstructing timeline...</div>
                                        ) : timelineEntries.length === 0 ? (
                                            <div style={{ textAlign: 'center', padding: '20px', color: '#666' }}>No timeline events found.</div>
                                        ) : (
                                            <div style={{ position: 'relative', paddingLeft: '20px', borderLeft: '1px solid #333', marginLeft: '10px' }}>
                                                {timelineEntries.map((e) => (
                                                    <div
                                                        key={e.id}
                                                        onClick={() => setSelectedEntry(e)}
                                                        style={{
                                                            padding: '0 0 20px 0',
                                                            position: 'relative',
                                                            cursor: 'pointer'
                                                        }}
                                                    >
                                                        <div style={{
                                                            position: 'absolute',
                                                            left: '-24px',
                                                            top: '4px',
                                                            width: '8px',
                                                            height: '8px',
                                                            borderRadius: '50%',
                                                            background: e.id === selectedEntry.id ? 'white' : getSeverityColor(e.level),
                                                            border: `2px solid ${e.id === selectedEntry.id ? '#007acc' : '#1e1e1e'}`,
                                                            zIndex: 2
                                                        }} />

                                                        <div style={{
                                                            display: 'flex',
                                                            flexDirection: 'column',
                                                            padding: '6px 10px',
                                                            background: e.id === selectedEntry.id ? 'rgba(0,122,204,0.1)' : 'rgba(255,255,255,0.02)',
                                                            border: `1px solid ${e.id === selectedEntry.id ? '#007acc' : '#333'}`,
                                                            borderRadius: '4px',
                                                            transition: 'background 0.2s'
                                                        }}>
                                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', opacity: 0.8 }}>
                                                                <span style={{ fontSize: '9px', fontWeight: 'bold', color: getSeverityColor(e.level) }}>{e.subsystem?.toUpperCase()}</span>
                                                                <span style={{ fontSize: '9px' }}>{new Date(e.timestamp).toLocaleTimeString()}</span>
                                                            </div>
                                                            <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#4fc1ff', marginBottom: '2px' }}>{e.eventType}</div>
                                                            <div style={{ fontSize: '10px', color: '#eee', lineHeight: 1.4 }}>{e.message}</div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}

                                {detailsTab === 'related' && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                        <div style={{ fontSize: '11px', color: '#888', marginBottom: '10px' }}>
                                            Showing related events for {selectedEntry.turnId ? `Turn ${selectedEntry.turnId}` : `Session ${selectedEntry.sessionId}`}
                                        </div>
                                        {correlationLoading ? (
                                            <div style={{ textAlign: 'center', padding: '20px', color: '#666' }}>Finding correlations...</div>
                                        ) : correlatedEntries.length === 0 ? (
                                            <div style={{ textAlign: 'center', padding: '20px', color: '#666' }}>No correlated events found.</div>
                                        ) : (
                                            correlatedEntries.map(e => (
                                                <div
                                                    key={e.id}
                                                    onClick={() => setSelectedEntry(e)}
                                                    style={{
                                                        padding: '10px',
                                                        background: e.id === selectedEntry.id ? 'rgba(0,122,204,0.1)' : 'rgba(255,255,255,0.02)',
                                                        border: `1px solid ${e.id === selectedEntry.id ? '#007acc' : '#333'}`,
                                                        borderRadius: '4px',
                                                        cursor: 'pointer'
                                                    }}
                                                >
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                                        <span style={{ fontSize: '9px', fontWeight: 'bold', color: getSeverityColor(e.level) }}>{e.subsystem?.toUpperCase()}</span>
                                                        <span style={{ fontSize: '9px', color: '#555' }}>{new Date(e.timestamp).toLocaleTimeString()}</span>
                                                    </div>
                                                    <div style={{ fontSize: '11px', color: '#ccc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.message}</div>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                )}

                                {detailsTab === 'raw' && (
                                    <pre style={{
                                        background: '#0a0a0a',
                                        padding: '15px',
                                        borderRadius: '4px',
                                        fontSize: '11px',
                                        color: '#dcdcaa',
                                        overflowX: 'auto',
                                        border: '1px solid #2d2d2d',
                                        margin: 0,
                                        lineHeight: 1.5
                                    }}>
                                        {selectedEntry.rawText}
                                    </pre>
                                )}

                                {detailsTab === 'insights' && selectedEntry.subsystem === 'prompt_audit' && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                                        <div style={{ background: 'rgba(156, 220, 254, 0.05)', border: '1px solid rgba(156, 220, 254, 0.2)', padding: '15px', borderRadius: '4px' }}>
                                            <h4 style={{ margin: '0 0 12px 0', fontSize: '13px', color: '#9cdcfe' }}>PROMPT ASSEMBLY INSIGHTS</h4>
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '15px' }}>
                                                <div>
                                                    <label style={{ fontSize: '9px', color: '#555', fontWeight: 'bold' }}>MODEL</label>
                                                    <div style={{ fontSize: '12px' }}>{selectedEntry.raw.model || 'default'}</div>
                                                </div>
                                                <div>
                                                    <label style={{ fontSize: '9px', color: '#555', fontWeight: 'bold' }}>VERSION</label>
                                                    <div style={{ fontSize: '12px' }}>{selectedEntry.raw.version || '0.8'}</div>
                                                </div>
                                                <div>
                                                    <label style={{ fontSize: '9px', color: '#555', fontWeight: 'bold' }}>MODE</label>
                                                    <div style={{ fontSize: '12px', color: '#b5cea8' }}>{selectedEntry.raw.mode || 'assistant'}</div>
                                                </div>
                                                <div>
                                                    <label style={{ fontSize: '9px', color: '#555', fontWeight: 'bold' }}>INTENT</label>
                                                    <div style={{ fontSize: '12px', color: '#ce9178' }}>{selectedEntry.raw.intent || 'unknown'}</div>
                                                </div>
                                            </div>
                                            <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '12px', marginBottom: '15px' }}>
                                                <label style={{ fontSize: '9px', color: '#555', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>GREETING / RESPONSE PREVIEW</label>
                                                <div style={{ fontSize: '11px', color: '#ddd', fontStyle: 'italic', background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: '4px' }}>
                                                    {selectedEntry.raw.greeting || selectedEntry.raw.responsePreview || 'No preview available'}
                                                </div>
                                            </div>
                                            <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '12px' }}>
                                                <label style={{ fontSize: '9px', color: '#555', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>COMPONENT INCLUSION</label>
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                                    {Object.entries(selectedEntry.raw.inclusionFlags || {}).map(([flag, val]) => (
                                                        <div key={flag} style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', background: val ? 'rgba(76, 175, 80, 0.15)' : 'rgba(244, 67, 54, 0.15)', color: val ? '#4caf50' : '#f44336', border: `1px solid ${val ? 'rgba(76, 175, 80, 0.3)' : 'rgba(244, 67, 54, 0.3)'}` }}>
                                                            {flag.replace('Included', '')}: {val ? 'YES' : 'NO'}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                        <button onClick={() => console.log(selectedEntry.raw)} style={{ ...inputStyle, cursor: 'pointer', background: '#333' }}>
                                            View Full Request Payload in Console
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#555', gap: '15px', padding: '40px' }}>
                            <div style={{ fontSize: '48px', opacity: 0.2 }}>📋</div>
                            <div style={{ textAlign: 'center' }}>
                                <div style={{ fontWeight: 'bold', color: '#666', marginBottom: '4px' }}>No Event Selected</div>
                                <div style={{ fontSize: '11px' }}>Click a row in the table to inspect details, correlation data, and internal metadata.</div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

