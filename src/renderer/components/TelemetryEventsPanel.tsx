import React, { useState, useEffect, useCallback } from 'react';
import type { RuntimeEvent } from '../../../shared/runtimeEventTypes';

/**
 * TelemetryEventsPanel
 *
 * Lightweight read-only surface for recent unified execution telemetry.
 * Fetches from the TelemetryBus ring buffer via the `telemetry:getRecentEvents`
 * IPC bridge (window.tala.telemetry.getRecentEvents).
 *
 * Both chat (AgentKernel) and autonomy (AutonomousRunOrchestrator) lifecycle
 * events share the same RuntimeEvent schema and are shown together here.
 *
 * Fields rendered: timestamp, executionId, event, subsystem, origin, phase,
 * durationMs (when present), failureReason (when present).
 *
 * Integrated as the 'exec-events' sub-tab in ReflectionPanel > Engineering.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Explicit lookup keyed on the terminal word of each RuntimeEventType value.
// The RuntimeEventType union uses 'execution.<verb>' naming, so we key on <verb>.
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

/**
 * Derives a human-readable origin label from a RuntimeEvent.
 *
 * Payload contract (set by AgentKernel and AutonomousRunOrchestrator):
 *   - Chat runs:     payload.origin = 'kernel'   (or absent)
 *   - Autonomy runs: payload.origin = 'autonomy_engine'
 *                    payload.type   = 'autonomy_task'
 *
 * Falls back to event.subsystem when no origin payload field is present.
 */
function originLabel(event: RuntimeEvent): string {
    const p = event.payload ?? {};
    if (p['origin'] === 'autonomy_engine' || p['type'] === 'autonomy_task') return 'autonomy';
    if (p['origin']) return String(p['origin']);
    return event.subsystem;
}

function shortId(id: string): string {
    // Show last 8 chars for readability
    return id.length > 8 ? '…' + id.slice(-8) : id;
}

// ─── Component ────────────────────────────────────────────────────────────────

const TelemetryEventsPanel: React.FC = () => {
    const [events, setEvents] = useState<RuntimeEvent[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastFetched, setLastFetched] = useState<Date | null>(null);

    const fetchEvents = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const api = (window as any).tala; // established codebase pattern — all renderer components use (window as any).tala
            const result: RuntimeEvent[] = await api.telemetry.getRecentEvents();
            // Most-recent first
            setEvents([...result].reverse());
            setLastFetched(new Date());
        } catch (e: any) {
            setError(e?.message ?? 'Failed to fetch events');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchEvents();
    }, [fetchEvents]);

    return (
        <section style={{ animation: 'fadeIn 0.2s ease-out' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <div>
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>Execution Events</h2>
                    <p style={{ fontSize: '0.75rem', color: '#6b7280', margin: '0.25rem 0 0' }}>
                        Unified lifecycle events — chat and autonomy runs share one schema.
                        {lastFetched && (
                            <span style={{ marginLeft: '0.5rem' }}>
                                Last fetched: {lastFetched.toLocaleTimeString()}
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
                    }}
                >
                    {loading ? 'Loading…' : '↻ Refresh'}
                </button>
            </div>

            {/* Error */}
            {error && (
                <div style={{
                    background: '#1c0a0a', border: '1px solid #7f1d1d', borderRadius: '8px',
                    padding: '0.75rem 1rem', color: '#ef4444', fontSize: '0.8rem', marginBottom: '1rem',
                }}>
                    {error}
                </div>
            )}

            {/* Empty state */}
            {!loading && events.length === 0 && !error && (
                <div style={{
                    color: '#6b7280', fontFamily: 'monospace', padding: '2rem',
                    background: '#0f172a', borderRadius: '8px', textAlign: 'center', fontSize: '0.85rem',
                }}>
                    No execution events recorded yet. Run a chat or autonomy task to populate the bus.
                </div>
            )}

            {/* Event list */}
            {events.length > 0 && (
                <div style={{
                    fontFamily: 'monospace', fontSize: '0.78rem', background: '#0f172a',
                    borderRadius: '8px', overflowY: 'auto', maxHeight: '540px',
                    border: '1px solid #1e293b',
                }}>
                    {/* Column header */}
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: '130px 90px 200px 70px 80px 70px 90px 1fr',
                        gap: '0.5rem',
                        padding: '0.5rem 0.75rem',
                        borderBottom: '1px solid #1e293b',
                        color: '#475569',
                        fontSize: '0.7rem',
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        position: 'sticky', top: 0, background: '#0f172a', zIndex: 1,
                    }}>
                        <span>Time</span>
                        <span>Exec ID</span>
                        <span>Event</span>
                        <span>Subsystem</span>
                        <span>Origin</span>
                        <span>Phase</span>
                        <span>Duration</span>
                        <span>Detail</span>
                    </div>

                    {events.map((ev) => {
                        const color = eventColor(ev.event);
                        const origin = originLabel(ev);
                        const durationMs = ev.payload?.['durationMs'];
                        const failureReason = ev.payload?.['failureReason'];
                        const isFailed = ev.event.split('.').pop() === 'failed';
                        return (
                            <div
                                key={ev.id}
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: '130px 90px 200px 70px 80px 70px 90px 1fr',
                                    gap: '0.5rem',
                                    padding: '0.4rem 0.75rem',
                                    alignItems: 'start',
                                    borderBottom: '1px solid #0d1a2d',
                                    background: isFailed ? 'rgba(127,29,29,0.12)' : 'transparent',
                                }}
                            >
                                {/* Timestamp */}
                                <span style={{ color: '#475569', whiteSpace: 'nowrap' }}>
                                    {(() => { const d = new Date(ev.timestamp); return `${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, '0')}`; })()}
                                </span>

                                {/* executionId (shortened) */}
                                <span style={{ color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ev.executionId}>
                                    {shortId(ev.executionId)}
                                </span>

                                {/* event type */}
                                <span style={{ color, fontWeight: 600, whiteSpace: 'nowrap' }}>
                                    {ev.event}
                                </span>

                                {/* subsystem */}
                                <span style={{ color: '#8b5cf6' }}>{ev.subsystem}</span>

                                {/* origin */}
                                <span style={{
                                    color: origin === 'autonomy' ? '#f59e0b' : '#3b82f6',
                                }}>
                                    {origin}
                                </span>

                                {/* phase */}
                                <span style={{ color: '#64748b' }}>{ev.phase ?? '—'}</span>

                                {/* durationMs */}
                                <span style={{ color: '#94a3b8' }}>
                                    {durationMs != null ? `${durationMs}ms` : '—'}
                                </span>

                                {/* detail (failureReason or empty) */}
                                <span style={{ color: isFailed ? '#ef4444' : '#475569', wordBreak: 'break-word' }}>
                                    {failureReason ? String(failureReason) : '—'}
                                </span>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Legend */}
            <div style={{
                display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '0.75rem',
                fontSize: '0.7rem', color: '#475569',
            }}>
                <span style={{ color: '#8b5cf6' }}>● created</span>
                <span style={{ color: '#3b82f6' }}>● accepted</span>
                <span style={{ color: '#f59e0b' }}>● finalizing</span>
                <span style={{ color: '#10b981' }}>● completed</span>
                <span style={{ color: '#ef4444' }}>● failed</span>
                <span style={{ color: '#3b82f6', marginLeft: '0.5rem' }}>origin: chat (kernel)</span>
                <span style={{ color: '#f59e0b' }}>origin: autonomy</span>
            </div>
        </section>
    );
};

export default TelemetryEventsPanel;
