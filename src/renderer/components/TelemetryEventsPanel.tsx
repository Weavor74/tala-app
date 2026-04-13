import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { RuntimeEvent } from '../../../shared/runtimeEventTypes';
import {
    deriveExecutionGroupsByExecutionId,
    selectExecutionGroups,
    DEFAULT_FILTER,
} from '../utils/TelemetryExecutionGroupResolver';
import type {
    ExecutionGroup,
    ExecutionGroupFilter,
    ExecutionOrigin,
    ExecutionTerminalState,
} from '../utils/TelemetryExecutionGroupResolver';

/**
 * TelemetryEventsPanel
 *
 * Execution timeline surface for runtime debugging.
 * Fetches from the TelemetryBus ring buffer via the `telemetry:getRecentEvents`
 * IPC bridge (window.tala.telemetry.getRecentEvents), groups events by
 * executionId, and displays them as collapsed execution records with an
 * expandable event sequence per execution.
 *
 * Both chat (AgentKernel) and autonomy (AutonomousRunOrchestrator) lifecycle
 * events share one RuntimeEvent schema and appear together here.
 *
 * Integrated as the 'exec-events' sub-tab in ReflectionPanel > Engineering.
 */

const POLL_INTERVAL_MS = 10_000;

// ─── Style helpers ────────────────────────────────────────────────────────────

const EVENT_COLORS: Record<string, string> = {
    failed:     '#ef4444',
    completed:  '#10b981',
    finalizing: '#f59e0b',
    accepted:   '#3b82f6',
    created:    '#8b5cf6',
};

function eventColor(event: string): string {
    const verb = event.split('.').pop() ?? '';
    return EVENT_COLORS[verb] ?? '#6b7280';
}

function terminalStateColor(state: ExecutionTerminalState): string {
    if (state === 'completed')   return '#10b981';
    if (state === 'failed')      return '#ef4444';
    return '#f59e0b'; // in_progress
}

function terminalStateLabel(state: ExecutionTerminalState): string {
    if (state === 'completed')   return '✔ completed';
    if (state === 'failed')      return '✖ failed';
    return '⟳ in progress';
}

function originColor(origin: ExecutionOrigin): string {
    if (origin === 'autonomy') return '#f59e0b';
    if (origin === 'chat')     return '#3b82f6';
    return '#6b7280';
}

function shortId(id: string): string {
    return id.length > 12 ? '…' + id.slice(-12) : id;
}

function fmtTime(iso: string): string {
    const d = new Date(iso);
    return `${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function FilterBar({
    filter,
    onChange,
    totalCount,
    visibleCount,
}: {
    filter: ExecutionGroupFilter;
    onChange: (f: ExecutionGroupFilter) => void;
    totalCount: number;
    visibleCount: number;
}) {
    const btnBase: React.CSSProperties = {
        padding: '0.25rem 0.6rem', borderRadius: '12px', fontSize: '0.72rem',
        border: '1px solid #374151', cursor: 'pointer', background: 'transparent',
        color: '#9ca3af',
    };
    const active: React.CSSProperties = { ...btnBase, background: '#374151', color: '#fff' };

    const origins: Array<{ key: 'all' | ExecutionOrigin; label: string }> = [
        { key: 'all',      label: 'All origins' },
        { key: 'chat',     label: 'Chat' },
        { key: 'autonomy', label: 'Autonomy' },
        { key: 'unknown',  label: 'Unknown' },
    ];
    const states: Array<{ key: 'all' | ExecutionTerminalState; label: string }> = [
        { key: 'all',         label: 'All states' },
        { key: 'completed',   label: '✔ Completed' },
        { key: 'failed',      label: '✖ Failed' },
        { key: 'in_progress', label: '⟳ In progress' },
    ];

    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center', marginBottom: '0.75rem' }}>
            {origins.map(({ key, label }) => (
                <button
                    key={key}
                    style={filter.origin === key ? active : btnBase}
                    onClick={() => onChange({ ...filter, origin: key })}
                >
                    {label}
                </button>
            ))}
            <span style={{ width: '1px', background: '#374151', alignSelf: 'stretch', margin: '0 0.2rem' }} />
            {states.map(({ key, label }) => (
                <button
                    key={key}
                    style={filter.state === key ? active : btnBase}
                    onClick={() => onChange({ ...filter, state: key })}
                >
                    {label}
                </button>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: '#475569' }}>
                {visibleCount} / {totalCount} executions
            </span>
        </div>
    );
}

function EventTimeline({ events }: { events: RuntimeEvent[] }) {
    return (
        <div style={{
            marginTop: '0.5rem', paddingTop: '0.5rem',
            borderTop: '1px solid #1e293b',
            display: 'flex', flexDirection: 'column', gap: '0.2rem',
        }}>
            {events.map((ev) => {
                const color = eventColor(ev.event);
                const durationMs = ev.payload?.['durationMs'];
                return (
                    <div key={ev.id} style={{
                        display: 'grid',
                        gridTemplateColumns: '110px 180px 60px 60px 1fr',
                        gap: '0.4rem',
                        fontSize: '0.75rem',
                        fontFamily: 'monospace',
                        padding: '0.15rem 0.3rem',
                        borderRadius: '3px',
                        background: ev.event.split('.').pop() === 'failed' ? 'rgba(127,29,29,0.1)' : 'transparent',
                    }}>
                        <span style={{ color: '#475569' }}>{fmtTime(ev.timestamp)}</span>
                        <span style={{ color, fontWeight: 600 }}>{ev.event}</span>
                        <span style={{ color: '#64748b' }}>{ev.phase ?? '—'}</span>
                        <span style={{ color: '#94a3b8' }}>{durationMs != null ? `${durationMs}ms` : '—'}</span>
                        <span style={{ color: '#475569', wordBreak: 'break-word' }}>
                            {ev.payload?.['failureReason'] ? String(ev.payload['failureReason']) : ''}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

function ExecutionRow({ group }: { group: ExecutionGroup }) {
    const [expanded, setExpanded] = useState(false);
    const stateColor = terminalStateColor(group.terminalState);

    return (
        <div style={{
            border: `1px solid ${group.terminalState === 'failed' ? '#7f1d1d' : '#1e293b'}`,
            borderRadius: '6px',
            padding: '0.6rem 0.75rem',
            background: group.terminalState === 'failed' ? 'rgba(127,29,29,0.08)' : '#0f172a',
            marginBottom: '0.4rem',
        }}>
            {/* Summary row */}
            <div
                style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}
                onClick={() => setExpanded((v) => !v)}
            >
                {/* Expand toggle */}
                <span style={{ color: '#475569', fontSize: '0.8rem', userSelect: 'none', minWidth: '12px' }}>
                    {expanded ? '▼' : '▶'}
                </span>

                {/* State badge */}
                <span style={{
                    fontSize: '0.7rem', fontWeight: 700, padding: '2px 7px', borderRadius: '10px',
                    background: stateColor + '22', color: stateColor,
                    border: `1px solid ${stateColor}55`, whiteSpace: 'nowrap',
                }}>
                    {terminalStateLabel(group.terminalState)}
                </span>

                {/* Origin badge */}
                <span style={{
                    fontSize: '0.7rem', fontWeight: 600, color: originColor(group.origin),
                    whiteSpace: 'nowrap',
                }}>
                    {group.origin}
                </span>

                {/* Execution ID */}
                <span
                    style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#64748b', whiteSpace: 'nowrap' }}
                    title={group.executionId}
                >
                    {shortId(group.executionId)}
                </span>

                {/* Start time */}
                <span style={{ fontFamily: 'monospace', fontSize: '0.72rem', color: '#475569' }}>
                    {fmtTime(group.startedAt)}
                </span>

                {/* Duration */}
                {group.durationMs != null && (
                    <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                        {group.durationMs}ms
                    </span>
                )}

                {/* Failure reason (inline preview) */}
                {group.failureReason && (
                    <span style={{ fontSize: '0.72rem', color: '#ef4444', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {group.failureReason}
                    </span>
                )}

                {/* Event count */}
                <span style={{ marginLeft: 'auto', fontSize: '0.7rem', color: '#374151', whiteSpace: 'nowrap' }}>
                    {group.events.length} events
                </span>
            </div>

            {/* Expanded timeline */}
            {expanded && <EventTimeline events={group.events} />}
        </div>
    );
}

// ─── Main component ───────────────────────────────────────────────────────────

const TelemetryEventsPanel: React.FC = () => {
    const [allGroups, setAllGroups] = useState<ExecutionGroup[]>([]);
    const [filter, setFilter] = useState<ExecutionGroupFilter>(DEFAULT_FILTER);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastFetched, setLastFetched] = useState<Date | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const fetchEvents = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const api = (window as any).tala; // established codebase pattern — all renderer components use (window as any).tala
            const result: RuntimeEvent[] = await api.telemetry.getRecentEvents();
            setAllGroups(deriveExecutionGroupsByExecutionId(result));
            setLastFetched(new Date());
        } catch (e: any) {
            setError(e?.message ?? 'Failed to fetch events');
        } finally {
            setLoading(false);
        }
    }, []);

    // Initial fetch + auto-poll every POLL_INTERVAL_MS
    useEffect(() => {
        fetchEvents();
        pollRef.current = setInterval(fetchEvents, POLL_INTERVAL_MS);
        return () => {
            if (pollRef.current != null) clearInterval(pollRef.current);
        };
    }, [fetchEvents]);

    const visibleGroups = selectExecutionGroups(allGroups, filter);

    return (
        <section style={{ animation: 'fadeIn 0.2s ease-out' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                <div>
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>Execution Timeline</h2>
                    <p style={{ fontSize: '0.75rem', color: '#6b7280', margin: '0.25rem 0 0' }}>
                        Grouped by execution — chat and autonomy share one schema. Polls every {POLL_INTERVAL_MS / 1000}s.
                        {lastFetched && (
                            <span style={{ marginLeft: '0.5rem', color: '#374151' }}>
                                Updated {lastFetched.toLocaleTimeString()}
                            </span>
                        )}
                    </p>
                </div>
                <button
                    onClick={fetchEvents}
                    disabled={loading}
                    style={{
                        background: 'transparent', color: loading ? '#374151' : '#9ca3af',
                        border: '1px solid #374151', padding: '0.3rem 0.6rem',
                        borderRadius: '4px', fontSize: '0.75rem', cursor: loading ? 'default' : 'pointer',
                        flexShrink: 0,
                    }}
                >
                    {loading ? 'Loading…' : '↻ Refresh'}
                </button>
            </div>

            {/* Filter bar */}
            <FilterBar
                filter={filter}
                onChange={setFilter}
                totalCount={allGroups.length}
                visibleCount={visibleGroups.length}
            />

            {/* Error */}
            {error && (
                <div style={{
                    background: '#1c0a0a', border: '1px solid #7f1d1d', borderRadius: '8px',
                    padding: '0.75rem 1rem', color: '#ef4444', fontSize: '0.8rem', marginBottom: '0.75rem',
                }}>
                    {error}
                </div>
            )}

            {/* Empty state */}
            {!loading && allGroups.length === 0 && !error && (
                <div style={{
                    color: '#6b7280', fontFamily: 'monospace', padding: '2rem',
                    background: '#0f172a', borderRadius: '8px', textAlign: 'center', fontSize: '0.85rem',
                    border: '1px solid #1e293b',
                }}>
                    No execution events recorded yet. Run a chat or autonomy task to populate the bus.
                </div>
            )}

            {/* Filtered empty state */}
            {!loading && allGroups.length > 0 && visibleGroups.length === 0 && (
                <div style={{
                    color: '#6b7280', padding: '1.5rem', background: '#0f172a',
                    borderRadius: '8px', textAlign: 'center', fontSize: '0.85rem',
                    border: '1px solid #1e293b',
                }}>
                    No executions match the current filter.
                </div>
            )}

            {/* Execution groups */}
            {visibleGroups.length > 0 && (
                <div style={{ maxHeight: '560px', overflowY: 'auto' }}>
                    {visibleGroups.map((group) => (
                        <ExecutionRow key={group.executionId} group={group} />
                    ))}
                </div>
            )}

            {/* Legend */}
            <div style={{
                display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '0.75rem',
                fontSize: '0.7rem', color: '#475569', paddingTop: '0.5rem', borderTop: '1px solid #1e293b',
            }}>
                <span style={{ color: '#8b5cf6' }}>● created</span>
                <span style={{ color: '#3b82f6' }}>● accepted</span>
                <span style={{ color: '#f59e0b' }}>● finalizing</span>
                <span style={{ color: '#10b981' }}>● completed</span>
                <span style={{ color: '#ef4444' }}>● failed</span>
                <span style={{ borderLeft: '1px solid #374151', paddingLeft: '1rem', color: '#3b82f6' }}>origin: chat</span>
                <span style={{ color: '#f59e0b' }}>origin: autonomy</span>
            </div>
        </section>
    );
};

export default TelemetryEventsPanel;

