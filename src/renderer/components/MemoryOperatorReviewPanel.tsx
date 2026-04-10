import React, { useState, useCallback } from 'react';
import type {
    MemoryOperatorReviewModel,
    OperatorReviewPosture,
} from '../../../shared/memory/MemoryOperatorReviewModel';

/**
 * MemoryOperatorReviewPanel — Operator-facing memory maintenance review surface
 *
 * Read-focused panel that surfaces the complete memory maintenance intelligence
 * stack in one unified view. Consumes the MemoryOperatorReviewModel via the
 * `memory:getOperatorReviewModel` IPC channel.
 *
 * Sections:
 *   A. Current Posture card
 *   B. Key Findings
 *   C. Adaptive Plan
 *   D. Optimization Suggestions (advisory only)
 *   E. Queue / Deferred Work
 *   F. Recent Repair Activity
 *   G. Notes / Safety
 *
 * All optimization suggestions are clearly labeled as advisory.
 * No auto-apply controls are present.
 */

// ─── Posture visual helpers ───────────────────────────────────────────────────

function postureColor(posture: OperatorReviewPosture | string): string {
    switch (posture) {
        case 'critical':  return '#ef4444';
        case 'unstable':  return '#f97316';
        case 'watch':     return '#f59e0b';
        case 'stable':    return '#22c55e';
        default:          return '#9ca3af';
    }
}

function severityColor(severity: string): string {
    switch (severity) {
        case 'critical':  return '#ef4444';
        case 'error':     return '#f97316';
        case 'warning':   return '#f59e0b';
        case 'info':      return '#3b82f6';
        default:          return '#9ca3af';
    }
}

function PostureBadge({ posture }: { posture: string }) {
    const color = postureColor(posture);
    return (
        <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 13,
            fontWeight: 700,
            padding: '4px 12px',
            borderRadius: 12,
            background: color + '22',
            color,
            border: `1.5px solid ${color}55`,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
        }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
            {posture}
        </span>
    );
}

function SeverityBadge({ severity }: { severity: string }) {
    const color = severityColor(severity);
    return (
        <span style={{
            display: 'inline-block',
            fontSize: 10,
            fontWeight: 700,
            padding: '1px 7px',
            borderRadius: 8,
            background: color + '22',
            color,
            border: `1px solid ${color}44`,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
        }}>
            {severity}
        </span>
    );
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div style={{ marginBottom: 24 }}>
            <div style={{
                fontSize: 11,
                fontWeight: 700,
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom: 10,
                borderBottom: '1px solid #1e293b',
                paddingBottom: 6,
            }}>
                {title}
            </div>
            {children}
        </div>
    );
}

// ─── Empty state ─────────────────────────────────────────────────────────────

function EmptyNote({ text }: { text: string }) {
    return (
        <div style={{ fontSize: 12, color: '#64748b', fontStyle: 'italic', padding: '8px 0' }}>
            {text}
        </div>
    );
}

// ─── Main panel ──────────────────────────────────────────────────────────────

const MemoryOperatorReviewPanel: React.FC = () => {
    const [model, setModel] = useState<MemoryOperatorReviewModel | null>(null);
    const [loading, setLoading] = useState(false);
    const [runningMaintenance, setRunningMaintenance] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);

    const tala = (window as any).tala;

    const fetchModel = useCallback(async () => {
        if (!tala?.getMemoryOperatorReviewModel) {
            setError('Memory operator review API not available. Please restart the application.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            console.log('[MemoryOperatorReview] manual refresh requested');
            const m = await tala.getMemoryOperatorReviewModel();
            setModel(m);
            setLastRefreshed(new Date().toLocaleTimeString());
        } catch (err: any) {
            setError(`Failed to load review model: ${err?.message ?? err}`);
        } finally {
            setLoading(false);
        }
    }, [tala]);

    const triggerMaintenance = useCallback(async () => {
        if (!tala?.runMemoryMaintenanceNow) return;
        setRunningMaintenance(true);
        try {
            await tala.runMemoryMaintenanceNow();
            // Refresh model after run
            await fetchModel();
        } catch (err: any) {
            setError(`Maintenance run failed: ${err?.message ?? err}`);
        } finally {
            setRunningMaintenance(false);
        }
    }, [tala, fetchModel]);

    // Render placeholder if not yet loaded
    if (!model && !loading && !error) {
        return (
            <div style={{ padding: 24, color: '#94a3b8', fontSize: 13 }}>
                <p style={{ marginBottom: 16, color: '#64748b' }}>
                    Load the operator review to see the current memory maintenance posture, adaptive plan, and optimization suggestions.
                </p>
                <button
                    onClick={fetchModel}
                    style={{
                        padding: '8px 18px', borderRadius: 6, background: '#1e40af',
                        color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                    }}
                >
                    Load Review
                </button>
            </div>
        );
    }

    return (
        <div style={{ padding: 20, overflowY: 'auto', fontSize: 13, color: '#cbd5e1', minHeight: 400 }}>

            {/* Toolbar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                <button
                    onClick={fetchModel}
                    disabled={loading}
                    style={{
                        padding: '6px 14px', borderRadius: 6, background: '#1e293b',
                        color: loading ? '#64748b' : '#94a3b8', border: '1px solid #334155',
                        cursor: loading ? 'default' : 'pointer', fontSize: 12,
                    }}
                >
                    {loading ? 'Refreshing…' : '↻ Refresh Review'}
                </button>
                <button
                    onClick={triggerMaintenance}
                    disabled={runningMaintenance || loading}
                    style={{
                        padding: '6px 14px', borderRadius: 6, background: '#1e293b',
                        color: (runningMaintenance || loading) ? '#64748b' : '#94a3b8',
                        border: '1px solid #334155',
                        cursor: (runningMaintenance || loading) ? 'default' : 'pointer', fontSize: 12,
                    }}
                >
                    {runningMaintenance ? 'Running…' : '⚡ Run Analysis Now'}
                </button>
                {lastRefreshed && (
                    <span style={{ fontSize: 11, color: '#475569', marginLeft: 'auto' }}>
                        Last refreshed: {lastRefreshed}
                    </span>
                )}
            </div>

            {error && (
                <div style={{ padding: '10px 14px', background: '#1f0000', border: '1px solid #ef4444',
                    borderRadius: 6, color: '#f87171', fontSize: 12, marginBottom: 16 }}>
                    {error}
                </div>
            )}

            {model && (
                <>
                    {/* A. Current Posture Card */}
                    <Section title="Current Posture">
                        <div style={{
                            background: '#0f172a',
                            border: `1.5px solid ${postureColor(model.posture)}44`,
                            borderRadius: 10,
                            padding: '16px 20px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 10,
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                                <PostureBadge posture={model.posture} />
                                {model.health.hardDisabled && (
                                    <span style={{
                                        fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 8,
                                        background: '#ef444422', color: '#ef4444', border: '1px solid #ef444444',
                                        textTransform: 'uppercase', letterSpacing: '0.05em',
                                    }}>
                                        HARD DISABLED
                                    </span>
                                )}
                                <span style={{ fontSize: 11, color: '#64748b', marginLeft: 'auto' }}>
                                    {new Date(model.generatedAt).toLocaleString()}
                                </span>
                            </div>
                            <div style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 500 }}>
                                {model.summary.headline}
                            </div>
                            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, color: '#64748b' }}>
                                <span>State: <span style={{ color: '#94a3b8' }}>{model.health.state}</span></span>
                                <span>Mode: <span style={{ color: '#94a3b8' }}>{model.health.mode}</span></span>
                                {model.health.reasons.length > 0 && (
                                    <span>Reasons: <span style={{ color: '#94a3b8' }}>{model.health.reasons.join(', ')}</span></span>
                                )}
                            </div>
                        </div>
                    </Section>

                    {/* B. Key Findings */}
                    <Section title="Key Findings">
                        {model.summary.keyFindings.length === 0 ? (
                            <EmptyNote text="No escalation signals in the current analysis window." />
                        ) : (
                            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, color: '#94a3b8' }}>
                                {model.summary.keyFindings.map((f, i) => (
                                    <li key={i} style={{ fontSize: 12, marginBottom: 3 }}>{f}</li>
                                ))}
                            </ul>
                        )}

                        {(model.summary.topFailureReasons.length > 0 || model.summary.unstableSubsystems.length > 0) && (
                            <div style={{ display: 'flex', gap: 20, marginTop: 12, flexWrap: 'wrap' }}>
                                {model.summary.topFailureReasons.length > 0 && (
                                    <div style={{ flex: 1, minWidth: 200 }}>
                                        <div style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Top Failure Reasons</div>
                                        {model.summary.topFailureReasons.map((r, i) => (
                                            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #1e293b', fontSize: 12 }}>
                                                <span style={{ color: '#94a3b8', fontFamily: 'monospace', fontSize: 11 }}>{r.reason}</span>
                                                <span style={{ color: '#64748b', fontSize: 11 }}>{r.count}×</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {model.summary.unstableSubsystems.length > 0 && (
                                    <div style={{ flex: 1, minWidth: 180 }}>
                                        <div style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Unstable Subsystems</div>
                                        {model.summary.unstableSubsystems.map((s, i) => (
                                            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #1e293b', fontSize: 12 }}>
                                                <span style={{ color: '#f97316', fontFamily: 'monospace', fontSize: 11 }}>{s.subsystem}</span>
                                                {s.count > 0 && <span style={{ color: '#64748b', fontSize: 11 }}>{s.count}×</span>}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </Section>

                    {/* C. Adaptive Plan */}
                    <Section title="Adaptive Maintenance Plan">
                        {!model.adaptivePlan ? (
                            <EmptyNote text="No adaptive plan available yet. Waiting for first scheduled analytics run." />
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '12px 16px' }}>
                                    <div style={{ fontSize: 11, color: '#475569', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Recommended Primary Action</div>
                                    <div style={{ color: '#e2e8f0', fontSize: 13 }}>{model.adaptivePlan.recommendedPrimaryAction}</div>
                                </div>
                                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                                    <div style={{ flex: 1, minWidth: 140, background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '10px 14px' }}>
                                        <div style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Escalation Bias</div>
                                        <div style={{ color: '#94a3b8', fontSize: 13 }}>{model.adaptivePlan.escalationBias}</div>
                                    </div>
                                    <div style={{ flex: 1, minWidth: 140, background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '10px 14px' }}>
                                        <div style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Suggested Cadence</div>
                                        <div style={{ color: '#94a3b8', fontSize: 13 }}>{model.adaptivePlan.cadenceRecommendationMinutes} min</div>
                                    </div>
                                </div>
                                {model.adaptivePlan.topPriorities.length > 0 && (
                                    <div>
                                        <div style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Priority Targets</div>
                                        {model.adaptivePlan.topPriorities.map((p, i) => (
                                            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '7px 0', borderBottom: '1px solid #1e293b' }}>
                                                <span style={{
                                                    minWidth: 36, textAlign: 'center', fontSize: 11, fontWeight: 700,
                                                    background: p.score >= 70 ? '#ef444422' : p.score >= 40 ? '#f9731622' : '#1e293b',
                                                    color: p.score >= 70 ? '#ef4444' : p.score >= 40 ? '#f97316' : '#64748b',
                                                    borderRadius: 6, padding: '2px 6px',
                                                }}>
                                                    {p.score}
                                                </span>
                                                <div style={{ flex: 1 }}>
                                                    <span style={{ color: '#a78bfa', fontFamily: 'monospace', fontSize: 12 }}>{p.target}</span>
                                                    <div style={{ color: '#64748b', fontSize: 11, marginTop: 2 }}>{p.reason}</div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </Section>

                    {/* D. Optimization Suggestions */}
                    <Section title="Optimization Suggestions">
                        <div style={{
                            fontSize: 11, color: '#475569', fontStyle: 'italic',
                            padding: '6px 10px', background: '#0f172a', borderRadius: 6,
                            border: '1px solid #1e293b', marginBottom: 10,
                        }}>
                            ⚠ Advisory only — these are human-gated recommendations. No settings were auto-changed.
                        </div>
                        {model.optimizationSuggestions.topSuggestions.length === 0 ? (
                            <EmptyNote text="No optimization suggestions in the current analysis window." />
                        ) : (
                            <>
                                <div style={{ fontSize: 11, color: '#475569', marginBottom: 8 }}>
                                    Showing top {model.optimizationSuggestions.topSuggestions.length} of {model.optimizationSuggestions.totalSuggestions} suggestion{model.optimizationSuggestions.totalSuggestions !== 1 ? 's' : ''}.
                                </div>
                                {model.optimizationSuggestions.topSuggestions.map((s, i) => (
                                    <div key={s.id} style={{
                                        background: '#0f172a', border: '1px solid #1e293b',
                                        borderRadius: 8, padding: '12px 16px', marginBottom: 8,
                                    }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                                            <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', flex: 1 }}>{s.title}</span>
                                            <SeverityBadge severity={s.severity} />
                                            <span style={{ fontSize: 11, color: '#475569' }}>Score: {s.priorityScore}</span>
                                        </div>
                                        <div style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace', marginBottom: 4 }}>
                                            {s.category}{s.affectedSubsystems.length > 0 ? ` · ${s.affectedSubsystems.join(', ')}` : ''}
                                        </div>
                                        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>{s.summary}</div>
                                        {s.recommendedHumanAction && (
                                            <div style={{ fontSize: 11, color: '#64748b', borderTop: '1px solid #1e293b', paddingTop: 6, marginTop: 4 }}>
                                                <span style={{ color: '#475569', fontWeight: 600 }}>Recommended action: </span>
                                                {s.recommendedHumanAction.slice(0, 200)}{s.recommendedHumanAction.length > 200 ? '…' : ''}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </>
                        )}
                    </Section>

                    {/* E. Queue / Deferred Work */}
                    <Section title="Queue / Deferred Work">
                        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                            {[
                                { label: 'Extraction', value: model.queues.extractionPending },
                                { label: 'Embedding', value: model.queues.embeddingPending },
                                { label: 'Graph', value: model.queues.graphPending },
                            ].map(q => (
                                <div key={q.label} style={{
                                    flex: 1, minWidth: 100, background: '#0f172a',
                                    border: `1px solid ${q.value > 0 ? '#f59e0b44' : '#1e293b'}`,
                                    borderRadius: 8, padding: '10px 14px', textAlign: 'center',
                                }}>
                                    <div style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{q.label}</div>
                                    <div style={{
                                        fontSize: 22, fontWeight: 700,
                                        color: q.value > 250 ? '#ef4444' : q.value > 0 ? '#f59e0b' : '#22c55e',
                                    }}>
                                        {q.value}
                                    </div>
                                    <div style={{ fontSize: 10, color: '#475569' }}>pending</div>
                                </div>
                            ))}
                        </div>
                        {model.queues.deadLetters.length > 0 ? (
                            <div>
                                <div style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Dead Letters</div>
                                {model.queues.deadLetters.map((dl, i) => (
                                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 10px', background: '#1f0000', border: '1px solid #ef444433', borderRadius: 6, fontSize: 12, marginBottom: 4 }}>
                                        <span style={{ color: '#f87171', fontFamily: 'monospace' }}>{dl.kind}</span>
                                        <span style={{ color: '#ef4444', fontWeight: 700 }}>{dl.count}</span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div style={{ fontSize: 11, color: '#22c55e' }}>No dead-letter items in the current analysis window.</div>
                        )}
                    </Section>

                    {/* F. Recent Repair Activity */}
                    <Section title="Recent Repair Activity">
                        {model.recentRepair.lastRunAt && (
                            <div style={{ fontSize: 11, color: '#475569', marginBottom: 8 }}>
                                Last run: <span style={{ color: '#64748b' }}>{new Date(model.recentRepair.lastRunAt).toLocaleString()}</span>
                            </div>
                        )}
                        {model.recentRepair.recentCycles.length === 0 ? (
                            <EmptyNote text="No recent maintenance cycles recorded yet." />
                        ) : (
                            <div style={{ marginBottom: 12 }}>
                                {model.recentRepair.recentCycles.map((cycle, i) => (
                                    <div key={i} style={{
                                        display: 'flex', alignItems: 'flex-start', gap: 10,
                                        padding: '8px 0', borderBottom: '1px solid #1e293b',
                                    }}>
                                        <PostureBadge posture={cycle.skipped ? 'watch' : cycle.outcome} />
                                        <div style={{ flex: 1, fontSize: 11 }}>
                                            <div style={{ color: '#64748b' }}>
                                                {new Date(cycle.startedAt).toLocaleTimeString()} → {new Date(cycle.completedAt).toLocaleTimeString()}
                                            </div>
                                            {cycle.attemptedActions.length > 0 && (
                                                <div style={{ color: '#475569', marginTop: 2 }}>
                                                    Actions: {cycle.attemptedActions.join(', ')}
                                                </div>
                                            )}
                                            {cycle.skipped && (
                                                <div style={{ color: '#64748b', fontStyle: 'italic', marginTop: 2 }}>Skipped</div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        {model.recentRepair.actionEffectiveness.length > 0 && (
                            <div>
                                <div style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Action Effectiveness</div>
                                {model.recentRepair.actionEffectiveness.map((e, i) => (
                                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', borderBottom: '1px solid #1e293b', fontSize: 12 }}>
                                        <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 11, color: '#94a3b8' }}>{e.action}</span>
                                        <span style={{ width: 42, textAlign: 'right', color: e.successRate >= 0.8 ? '#22c55e' : e.successRate >= 0.5 ? '#f59e0b' : '#ef4444', fontWeight: 600 }}>
                                            {Math.round(e.successRate * 100)}%
                                        </span>
                                        <span style={{ color: '#475569', fontSize: 11 }}>{e.totalExecutions}×</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Section>

                    {/* G. Notes / Safety */}
                    <Section title="Notes">
                        <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: '12px 16px' }}>
                            {model.notes.map((note, i) => (
                                <div key={i} style={{ fontSize: 11, color: '#475569', marginBottom: i < model.notes.length - 1 ? 6 : 0 }}>
                                    • {note}
                                </div>
                            ))}
                        </div>
                    </Section>
                </>
            )}
        </div>
    );
};

export default MemoryOperatorReviewPanel;
