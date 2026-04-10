import React from 'react';
import type {
    StrategyRoutingDashboardState,
    StrategyRoutingDecision,
    StrategyRoutingOutcomeRecord,
    StrategyRoutingTargetType,
    StrategyRoutingStatus,
} from '../../../shared/strategyRoutingTypes';

/**
 * StrategyRoutingDashboardPanel — Phase 6.1 P6.1G
 *
 * Reflection Dashboard integration for the Strategy Routing layer.
 *
 * Sections:
 *  - KPI bar (decisions evaluated, routed, human review, deferred, blocked, trust)
 *  - Active routing decisions (eligible + routed)
 *  - Human review items (require operator action)
 *  - Blocked / deferred summary
 *  - Routing outcome history
 */
interface StrategyRoutingDashboardPanelProps {
    state: StrategyRoutingDashboardState;
}

const StrategyRoutingDashboardPanel: React.FC<StrategyRoutingDashboardPanelProps> = ({ state }) => {
    const {
        routingDecisions,
        blockedDecisions,
        deferredDecisions,
        humanReviewItems,
        recentOutcomes,
        kpis,
    } = state;

    const activeDecisions = routingDecisions.filter(
        d => d.status === 'eligible' || d.status === 'routed',
    );

    return (
        <div style={{ color: '#e5e7eb' }}>
            {/* Header */}
            <div style={{
                padding: '1rem',
                background: '#1e293b',
                borderRadius: '8px',
                borderLeft: '4px solid #6366f1',
                marginBottom: '1.5rem',
            }}>
                <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
                    🔀 Strategy Routing (Phase 6.1)
                </h2>
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#6b7280' }}>
                    Deterministic routing of cross-system strategy decisions into bounded, governed action forms
                </p>
            </div>

            {/* KPI bar */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(6, 1fr)',
                gap: '0.75rem',
                marginBottom: '1.5rem',
            }}>
                <KpiTile label="Evaluated" value={kpis.totalDecisionsEvaluated} icon="📊" />
                <KpiTile label="Routed to Goal" value={kpis.totalRoutedToGoal} icon="🎯" color="#10b981" />
                <KpiTile label="Campaigns" value={kpis.totalRoutedToRepairCampaign + kpis.totalRoutedToHarmonizationCampaign} icon="🔧" color="#3b82f6" />
                <KpiTile label="Human Review" value={kpis.totalRoutedToHumanReview} icon="👤" color="#f59e0b" />
                <KpiTile label="Blocked" value={kpis.totalBlocked} icon="🚫" color="#ef4444" />
                <KpiTile label="Trust Score" value={Math.round(kpis.overallTrustScore * 100)} icon="⚖️" color="#8b5cf6" suffix="%" />
            </div>

            {/* Active routing decisions */}
            {activeDecisions.length > 0 && (
                <Section title="⚡ Active Routing Decisions" accent="#6366f1">
                    {activeDecisions.map(d => (
                        <RoutingDecisionCard key={d.routingDecisionId} decision={d} />
                    ))}
                </Section>
            )}

            {/* Human review items */}
            {humanReviewItems.length > 0 && (
                <Section title="👤 Pending Human Review" accent="#f59e0b">
                    {humanReviewItems.map(d => (
                        <RoutingDecisionCard key={d.routingDecisionId} decision={d} />
                    ))}
                </Section>
            )}

            {/* Blocked decisions */}
            {blockedDecisions.length > 0 && (
                <Section title="🚫 Blocked Routing Decisions" accent="#ef4444">
                    {blockedDecisions.slice(0, 5).map(d => (
                        <BlockedCard key={d.routingDecisionId} decision={d} />
                    ))}
                    {blockedDecisions.length > 5 && (
                        <div style={{ fontSize: '0.75rem', color: '#6b7280', padding: '0.25rem' }}>
                            +{blockedDecisions.length - 5} more blocked decisions
                        </div>
                    )}
                </Section>
            )}

            {/* Deferred decisions */}
            {deferredDecisions.length > 0 && (
                <Section title="⏸ Deferred Routing Decisions" accent="#6b7280">
                    {deferredDecisions.slice(0, 5).map(d => (
                        <BlockedCard key={d.routingDecisionId} decision={d} />
                    ))}
                </Section>
            )}

            {/* Routing outcome history */}
            {recentOutcomes.length > 0 && (
                <Section title="📈 Routing Outcome History" accent="#8b5cf6">
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
                        <thead>
                            <tr style={{ color: '#9ca3af', textAlign: 'left' }}>
                                <th style={{ padding: '0.25rem 0.5rem' }}>Target</th>
                                <th style={{ padding: '0.25rem 0.5rem' }}>Action</th>
                                <th style={{ padding: '0.25rem 0.5rem' }}>Completed?</th>
                                <th style={{ padding: '0.25rem 0.5rem' }}>Correct?</th>
                                <th style={{ padding: '0.25rem 0.5rem' }}>Trust Δ</th>
                                <th style={{ padding: '0.25rem 0.5rem' }}>Recorded</th>
                            </tr>
                        </thead>
                        <tbody>
                            {recentOutcomes.map(o => (
                                <OutcomeRow key={o.outcomeId} outcome={o} />
                            ))}
                        </tbody>
                    </table>
                </Section>
            )}

            {/* Empty state */}
            {routingDecisions.length === 0 && (
                <div style={{
                    color: '#6b7280', background: 'rgba(31,41,55,0.5)',
                    padding: '2rem', borderRadius: '8px', textAlign: 'center',
                }}>
                    No strategy routing decisions yet.
                    Strategy decisions from Phase 6 will appear here when the cross-system analysis
                    layer produces them.
                </div>
            )}
        </div>
    );
};

// ─── Sub-components ───────────────────────────────────────────────────────────

const KpiTile: React.FC<{
    label: string;
    value: number;
    icon: string;
    color?: string;
    suffix?: string;
}> = ({ label, value, icon, color = '#e5e7eb', suffix = '' }) => (
    <div style={{
        padding: '0.75rem', background: '#1e293b', borderRadius: '8px', textAlign: 'center',
    }}>
        <div style={{ fontSize: '1.2rem', marginBottom: '0.2rem' }}>{icon}</div>
        <div style={{ fontSize: '1.2rem', fontWeight: 700, color }}>{value}{suffix}</div>
        <div style={{ fontSize: '0.65rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {label}
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

const STATUS_COLORS: Record<StrategyRoutingStatus, string> = {
    eligible:         '#f59e0b',
    routed:           '#3b82f6',
    blocked:          '#ef4444',
    deferred:         '#6b7280',
    human_review:     '#f59e0b',
    outcome_recorded: '#10b981',
};

const TARGET_LABELS: Record<StrategyRoutingTargetType, string> = {
    autonomous_goal:         '🎯 Goal',
    repair_campaign:         '🔧 Repair',
    harmonization_campaign:  '🔀 Harmonize',
    human_review:            '👤 Human',
    deferred:                '⏸ Deferred',
};

const RoutingDecisionCard: React.FC<{ decision: StrategyRoutingDecision }> = ({ decision }) => {
    const statusColor = STATUS_COLORS[decision.status] ?? '#9ca3af';
    const targetLabel = TARGET_LABELS[decision.routingTargetType] ?? decision.routingTargetType;
    const confPct = Math.round(decision.confidence * 100);
    const shortId = decision.routingDecisionId.slice(-8);
    const shortCluster = decision.clusterId.slice(-8);

    return (
        <div style={{
            padding: '0.75rem 1rem',
            background: '#0f172a',
            borderRadius: '6px',
            borderLeft: `3px solid ${statusColor}`,
            fontSize: '0.8rem',
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
                <span style={{ color: '#e5e7eb', fontWeight: 600 }}>{targetLabel}</span>
                <span style={{
                    background: statusColor,
                    color: '#0f172a',
                    padding: '0.1rem 0.4rem',
                    borderRadius: '4px',
                    fontSize: '0.7rem',
                    fontWeight: 700,
                }}>
                    {decision.status.toUpperCase()}
                </span>
            </div>
            <div style={{ color: '#9ca3af', marginBottom: '0.25rem' }}>
                Strategy: <code style={{ color: '#c084fc' }}>{decision.strategyKind}</code>
                {' · '}cluster: <code style={{ color: '#60a5fa' }}>…{shortCluster}</code>
                {' · '}routing: <code style={{ color: '#818cf8' }}>…{shortId}</code>
                {' · '}conf: <span style={{ color: confPct >= 65 ? '#10b981' : '#f59e0b' }}>{confPct}%</span>
            </div>
            {decision.routedActionRef && (
                <div style={{ color: '#6b7280', fontSize: '0.75rem' }}>
                    Action: {decision.routedActionRef.actionType}
                    {' — '}<code style={{ color: '#93c5fd' }}>
                        …{decision.routedActionRef.actionId.slice(-10)}
                    </code>
                    {' ('}{decision.routedActionRef.status}{')'}
                </div>
            )}
            <div style={{ color: '#4b5563', fontSize: '0.7rem', marginTop: '0.25rem', fontStyle: 'italic' }}>
                {decision.scopeSummary.slice(0, 120)}
            </div>
        </div>
    );
};

const BlockedCard: React.FC<{ decision: StrategyRoutingDecision }> = ({ decision }) => {
    const reason = decision.blockedReason ?? decision.deferredReason ?? 'No reason recorded';
    const shortId = decision.routingDecisionId.slice(-8);
    const borderColor = decision.status === 'blocked' ? '#ef4444' : '#6b7280';

    return (
        <div style={{
            padding: '0.5rem 0.75rem',
            background: '#0f172a',
            borderRadius: '6px',
            borderLeft: `3px solid ${borderColor}`,
            fontSize: '0.75rem',
        }}>
            <span style={{ color: '#9ca3af' }}>
                <code style={{ color: '#c084fc' }}>{decision.strategyKind}</code>
                {' → '}<code style={{ color: '#818cf8' }}>…{shortId}</code>
                {': '}
            </span>
            <span style={{ color: '#6b7280' }}>{reason}</span>
        </div>
    );
};

const OutcomeRow: React.FC<{ outcome: StrategyRoutingOutcomeRecord }> = ({ outcome }) => {
    const deltaColor = outcome.trustDelta > 0 ? '#10b981' : outcome.trustDelta < 0 ? '#ef4444' : '#9ca3af';
    const shortAction = outcome.actionId.slice(-8);

    return (
        <tr style={{ borderTop: '1px solid #1e293b' }}>
            <td style={{ padding: '0.25rem 0.5rem', color: '#9ca3af' }}>
                {TARGET_LABELS[outcome.targetType] ?? outcome.targetType}
            </td>
            <td style={{ padding: '0.25rem 0.5rem' }}>
                <code style={{ color: '#60a5fa' }}>…{shortAction}</code>
            </td>
            <td style={{ padding: '0.25rem 0.5rem', color: outcome.actionCompleted ? '#10b981' : '#ef4444' }}>
                {outcome.actionCompleted ? '✓' : '✗'}
            </td>
            <td style={{ padding: '0.25rem 0.5rem', color: outcome.routingCorrect === true ? '#10b981' : outcome.routingCorrect === false ? '#ef4444' : '#6b7280' }}>
                {outcome.routingCorrect === undefined ? '—' : outcome.routingCorrect ? '✓' : '✗'}
            </td>
            <td style={{ padding: '0.25rem 0.5rem', color: deltaColor, fontWeight: 600 }}>
                {outcome.trustDelta > 0 ? '+' : ''}{outcome.trustDelta.toFixed(1)}
            </td>
            <td style={{ padding: '0.25rem 0.5rem', color: '#4b5563' }}>
                {new Date(outcome.recordedAt).toLocaleTimeString()}
            </td>
        </tr>
    );
};

export default StrategyRoutingDashboardPanel;
