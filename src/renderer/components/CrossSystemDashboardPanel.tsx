import React from 'react';
import type {
    CrossSystemDashboardState,
    IncidentCluster,
    RootCauseHypothesis,
    StrategyDecisionRecord,
    CrossSystemOutcomeRecord,
    CrossSystemStrategyKind,
    RootCauseCategory,
} from '../../../shared/crossSystemTypes';

/**
 * CrossSystemDashboardPanel — Phase 6 P6H
 *
 * Reflection Dashboard integration for the Cross-System Intelligence layer.
 *
 * Sections:
 *  - KPI bar (signals, clusters, root causes, strategies, outcomes)
 *  - Open Incident Clusters (with linked root causes and strategies)
 *  - Root Cause Hypotheses
 *  - Recent Strategy Decisions
 *  - Recent Outcomes (success/recurrence tracking)
 */
interface CrossSystemDashboardPanelProps {
    state: CrossSystemDashboardState;
}

const CrossSystemDashboardPanel: React.FC<CrossSystemDashboardPanelProps> = ({ state }) => {
    const { openClusters, rootCauses, recentDecisions, recentOutcomes, kpis, signalWindowCount } = state;

    return (
        <div style={{ color: '#e5e7eb' }}>
            {/* Header */}
            <div style={{
                padding: '1rem',
                background: '#1e293b',
                borderRadius: '8px',
                borderLeft: '4px solid #8b5cf6',
                marginBottom: '1.5rem',
            }}>
                <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
                    🧠 Cross-System Intelligence (Phase 6)
                </h2>
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#6b7280' }}>
                    Deterministic pattern detection across subsystems — no model calls, bounded and auditable
                </p>
            </div>

            {/* KPI bar */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: '0.75rem',
                marginBottom: '1.5rem',
            }}>
                <KpiTile label="Signals (window)" value={signalWindowCount} icon="📡" />
                <KpiTile label="Open Clusters" value={kpis.openClusterCount} icon="🔗" color="#f59e0b" />
                <KpiTile label="Root Causes" value={kpis.totalRootCausesGenerated} icon="🔎" color="#8b5cf6" />
                <KpiTile label="Succeeded" value={kpis.totalSucceeded} icon="✅" color="#10b981" />
            </div>

            {/* Secondary KPI row */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: '0.75rem',
                marginBottom: '2rem',
            }}>
                <KpiTile label="Total Signals" value={kpis.totalSignalsIngested} icon="📊" />
                <KpiTile label="Clusters Formed" value={kpis.totalClustersFormed} icon="📦" />
                <KpiTile label="Strategies Run" value={kpis.totalStrategiesSelected} icon="⚙️" />
                <KpiTile label="Recurred" value={kpis.totalRecurred} icon="🔁" color={kpis.totalRecurred > 0 ? '#ef4444' : undefined} />
            </div>

            {/* Empty state — shown only when there is no actionable data at all */}
            {openClusters.length === 0 && rootCauses.length === 0 && recentDecisions.length === 0 && recentOutcomes.length === 0 && (
                <div style={{
                    color: '#6b7280',
                    background: 'rgba(31,41,55,0.5)',
                    padding: '2rem',
                    borderRadius: '8px',
                    textAlign: 'center',
                }}>
                    No cross-system patterns detected yet. The system will surface patterns when correlated
                    signals accumulate across subsystems.
                </div>
            )}

            {/* Open Incident Clusters */}
            {openClusters.length > 0 && (
                <Section title={`🔗 Open Incident Clusters (${openClusters.length})`} accent="#f59e0b">
                    {openClusters.map(cluster => (
                        <ClusterCard
                            key={cluster.clusterId}
                            cluster={cluster}
                            rootCauses={rootCauses.filter(h => h.clusterId === cluster.clusterId)}
                            decisions={recentDecisions.filter(d => d.clusterId === cluster.clusterId)}
                        />
                    ))}
                </Section>
            )}

            {/* Root Cause Hypotheses */}
            {rootCauses.length > 0 && (
                <Section title={`🔎 Root Cause Hypotheses (${rootCauses.length})`} accent="#8b5cf6">
                    {rootCauses.map(h => (
                        <RootCauseCard key={h.rootCauseId} hypothesis={h} />
                    ))}
                </Section>
            )}

            {/* Recent Strategy Decisions */}
            {recentDecisions.length > 0 && (
                <Section title={`⚙️ Recent Strategy Decisions (${recentDecisions.length})`} accent="#3b82f6">
                    {recentDecisions.map(d => (
                        <DecisionCard key={d.decisionId} decision={d} />
                    ))}
                </Section>
            )}

            {/* Recent Outcomes */}
            {recentOutcomes.length > 0 && (
                <Section title={`📈 Recent Outcomes (${recentOutcomes.length})`} accent="#10b981">
                    {recentOutcomes.map(o => (
                        <OutcomeCard key={o.outcomeId} outcome={o} />
                    ))}
                </Section>
            )}
        </div>
    );
};

// ─── Sub-components ───────────────────────────────────────────────────────────

const Section: React.FC<{ title: string; accent: string; children: React.ReactNode }> = ({
    title, accent, children,
}) => (
    <div style={{ marginBottom: '1.5rem' }}>
        <h3 style={{
            fontSize: '0.85rem',
            fontWeight: 700,
            color: accent,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: '0.75rem',
        }}>
            {title}
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {children}
        </div>
    </div>
);

const KpiTile: React.FC<{ label: string; value: number; icon: string; color?: string }> = ({
    label, value, icon, color = '#e5e7eb',
}) => (
    <div style={{
        background: '#1f2937',
        borderRadius: '8px',
        padding: '0.875rem',
        border: '1px solid #374151',
        textAlign: 'center',
    }}>
        <div style={{ fontSize: '1.1rem', marginBottom: '0.25rem' }}>{icon}</div>
        <div style={{ fontSize: '1.25rem', fontWeight: 700, color }}>{value}</div>
        <div style={{ fontSize: '0.7rem', color: '#6b7280', marginTop: '0.125rem' }}>{label}</div>
    </div>
);

const SEVERITY_COLORS: Record<string, string> = {
    low: '#6b7280',
    medium: '#f59e0b',
    high: '#ef4444',
};

const STRATEGY_LABELS: Record<CrossSystemStrategyKind, string> = {
    targeted_repair: '🔧 Targeted Repair',
    harmonization_campaign: '🔄 Harmonization',
    multi_step_campaign: '📋 Multi-Step Campaign',
    defer: '⏸️ Defer',
    escalate_human: '👤 Escalate to Human',
};

const CATEGORY_LABELS: Record<RootCauseCategory, string> = {
    structural_drift: 'Structural Drift',
    repeated_execution_error: 'Repeated Execution Error',
    cross_subsystem_dependency: 'Cross-Subsystem Dependency',
    policy_boundary_gap: 'Policy Boundary Gap',
    campaign_scope_mismatch: 'Campaign Scope Mismatch',
    unknown: 'Unknown',
};

const ClusterCard: React.FC<{
    cluster: IncidentCluster;
    rootCauses: RootCauseHypothesis[];
    decisions: StrategyDecisionRecord[];
}> = ({ cluster, rootCauses, decisions }) => {
    const severityColor = SEVERITY_COLORS[cluster.severity] ?? '#6b7280';
    const topHypothesis = rootCauses.length > 0 ? rootCauses[0] : null;
    const latestDecision = decisions.length > 0 ? decisions[decisions.length - 1] : null;

    return (
        <div style={{
            background: '#1f2937',
            borderRadius: '8px',
            padding: '1rem',
            border: `1px solid ${severityColor}33`,
            borderLeft: `4px solid ${severityColor}`,
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                <div>
                    <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{cluster.label}</span>
                    <span style={{
                        marginLeft: '0.5rem',
                        fontSize: '0.65rem',
                        background: `${severityColor}22`,
                        color: severityColor,
                        padding: '1px 6px',
                        borderRadius: '10px',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                    }}>
                        {cluster.severity}
                    </span>
                </div>
                <span style={{
                    fontSize: '0.65rem',
                    color: cluster.status === 'open' ? '#10b981' : '#6b7280',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                }}>
                    {cluster.status}
                </span>
            </div>

            <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.75rem', color: '#9ca3af', marginBottom: '0.5rem' }}>
                <span>🔢 {cluster.signalCount} signals</span>
                <span>🏷️ {cluster.subsystems.join(', ')}</span>
                <span>⚠️ {cluster.dominantFailureType}</span>
                <span>📅 {new Date(cluster.lastSeenAt).toLocaleTimeString()}</span>
            </div>

            {cluster.clusteringCriteria.length > 0 && (
                <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                    {cluster.clusteringCriteria.map(c => (
                        <span key={c} style={{
                            fontSize: '0.65rem',
                            background: '#374151',
                            color: '#d1d5db',
                            padding: '2px 6px',
                            borderRadius: '10px',
                        }}>
                            {c.replace(/_/g, ' ')}
                        </span>
                    ))}
                </div>
            )}

            {topHypothesis && (
                <div style={{
                    background: '#111827',
                    borderRadius: '6px',
                    padding: '0.5rem 0.75rem',
                    fontSize: '0.75rem',
                    marginTop: '0.5rem',
                }}>
                    <span style={{ color: '#8b5cf6', fontWeight: 600 }}>Root cause: </span>
                    <span style={{ color: '#d1d5db' }}>
                        {CATEGORY_LABELS[topHypothesis.category]} — score {topHypothesis.score}
                        /100 (conf {(topHypothesis.confidence * 100).toFixed(0)}%)
                    </span>
                </div>
            )}

            {latestDecision && (
                <div style={{
                    background: '#0f172a',
                    borderRadius: '6px',
                    padding: '0.5rem 0.75rem',
                    fontSize: '0.75rem',
                    marginTop: '0.35rem',
                }}>
                    <span style={{ color: '#3b82f6', fontWeight: 600 }}>Strategy: </span>
                    <span style={{ color: '#d1d5db' }}>
                        {STRATEGY_LABELS[latestDecision.strategySelected]}
                    </span>
                </div>
            )}
        </div>
    );
};

const RootCauseCard: React.FC<{ hypothesis: RootCauseHypothesis }> = ({ hypothesis }) => {
    const confidencePct = Math.round(hypothesis.confidence * 100);
    const confColor = confidencePct >= 70 ? '#10b981' : confidencePct >= 40 ? '#f59e0b' : '#ef4444';

    return (
        <div style={{
            background: '#1f2937',
            borderRadius: '8px',
            padding: '0.875rem',
            border: '1px solid #374151',
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                <div>
                    <span style={{ fontWeight: 600, fontSize: '0.85rem', color: '#8b5cf6' }}>
                        {CATEGORY_LABELS[hypothesis.category]}
                    </span>
                    <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '0.2rem' }}>
                        {hypothesis.description}
                    </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '1rem' }}>
                    <div style={{ fontSize: '1rem', fontWeight: 700, color: confColor }}>{confidencePct}%</div>
                    <div style={{ fontSize: '0.65rem', color: '#6b7280' }}>confidence</div>
                </div>
            </div>

            {/* Scoring factors */}
            {hypothesis.scoringFactors.length > 0 && (
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                    {hypothesis.scoringFactors.map(f => (
                        <span key={f.factorName} style={{
                            fontSize: '0.65rem',
                            background: '#374151',
                            color: '#d1d5db',
                            padding: '2px 6px',
                            borderRadius: '10px',
                        }}>
                            {f.factorName}: {f.contribution.toFixed(0)}pts
                        </span>
                    ))}
                </div>
            )}

            {hypothesis.subsystemsImplicated.length > 0 && (
                <div style={{ fontSize: '0.7rem', color: '#6b7280', marginTop: '0.35rem' }}>
                    Subsystems: {hypothesis.subsystemsImplicated.join(', ')}
                </div>
            )}
        </div>
    );
};

const DecisionCard: React.FC<{ decision: StrategyDecisionRecord }> = ({ decision }) => (
    <div style={{
        background: '#1f2937',
        borderRadius: '8px',
        padding: '0.875rem',
        border: '1px solid #1e3a5f',
    }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <span style={{ fontWeight: 600, fontSize: '0.85rem', color: '#3b82f6' }}>
                {STRATEGY_LABELS[decision.strategySelected]}
            </span>
            <span style={{ fontSize: '0.7rem', color: '#6b7280' }}>
                {new Date(decision.decidedAt).toLocaleString()}
            </span>
        </div>
        <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginBottom: '0.4rem' }}>
            {decision.rationale}
        </div>
        {decision.policyConstraints.length > 0 && (
            <div style={{ fontSize: '0.7rem', color: '#6b7280' }}>
                Constraints: {decision.policyConstraints.join(', ')}
            </div>
        )}
        {decision.alternativesConsidered.length > 0 && (
            <div style={{ fontSize: '0.7rem', color: '#4b5563', marginTop: '0.25rem' }}>
                Considered: {decision.alternativesConsidered.map(a => STRATEGY_LABELS[a]).join(', ')}
            </div>
        )}
    </div>
);

const OutcomeCard: React.FC<{ outcome: CrossSystemOutcomeRecord }> = ({ outcome }) => {
    const statusColor = outcome.succeeded ? '#10b981' : '#ef4444';
    const statusLabel = outcome.succeeded ? '✅ Succeeded' : '❌ Failed';

    return (
        <div style={{
            background: '#1f2937',
            borderRadius: '8px',
            padding: '0.875rem',
            border: `1px solid ${statusColor}33`,
            borderLeft: `4px solid ${statusColor}`,
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                <span style={{ fontWeight: 600, fontSize: '0.85rem', color: statusColor }}>{statusLabel}</span>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    {outcome.recurred && (
                        <span style={{
                            fontSize: '0.65rem',
                            background: '#7f1d1d',
                            color: '#fca5a5',
                            padding: '2px 6px',
                            borderRadius: '10px',
                            fontWeight: 700,
                        }}>
                            RECURRED
                        </span>
                    )}
                    <span style={{ fontSize: '0.7rem', color: '#6b7280' }}>
                        {new Date(outcome.executedAt).toLocaleString()}
                    </span>
                </div>
            </div>
            <div style={{ fontSize: '0.75rem', color: '#9ca3af', display: 'flex', gap: '1rem' }}>
                <span>Strategy: {STRATEGY_LABELS[outcome.strategyUsed]}</span>
            </div>
            {outcome.notes && (
                <div style={{ fontSize: '0.7rem', color: '#6b7280', marginTop: '0.25rem' }}>
                    {outcome.notes}
                </div>
            )}
        </div>
    );
};

export default CrossSystemDashboardPanel;
