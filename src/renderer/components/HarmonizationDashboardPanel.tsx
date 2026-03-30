import React from 'react';
import type {
    HarmonizationDashboardState,
    HarmonizationCampaign,
    HarmonizationDriftRecord,
    HarmonizationOutcomeRecord,
    HarmonizationRuleConfidenceSummary,
    HarmonizationCampaignStatus,
} from '../../shared/harmonizationTypes';

/**
 * HarmonizationDashboardPanel — Phase 5.6 P5.6H
 *
 * Reflection Dashboard integration for the Code Harmonization layer.
 *
 * Sections:
 *  - KPI bar
 *  - Canon Rule Health (confidence, counts)
 *  - Pending Drift Records
 *  - Active Harmonization Campaigns
 *  - Deferred Campaigns
 *  - Recent Outcomes
 */

interface HarmonizationDashboardPanelProps {
    state: HarmonizationDashboardState;
    onDefer?: (campaignId: string) => void;
    onAbort?: (campaignId: string) => void;
    onResume?: (campaignId: string) => void;
}

const HarmonizationDashboardPanel: React.FC<HarmonizationDashboardPanelProps> = ({
    state,
    onDefer,
    onAbort,
    onResume,
}) => {
    const { kpis, pendingDriftRecords, activeCampaigns, deferredCampaigns, recentOutcomes, canonRuleSummaries } = state;

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
                    🔧 Code Harmonization (Phase 5.6)
                </h2>
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#6b7280' }}>
                    Deterministic, rule-driven consistency campaigns through planning, governance, and execution
                </p>
            </div>

            {/* KPI bar */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(5, 1fr)',
                gap: '0.75rem',
                marginBottom: '1.5rem',
            }}>
                <KpiCard title="Active" value={kpis.activeCampaigns} icon="▶️" />
                <KpiCard title="Succeeded" value={kpis.totalSucceeded} icon="✅" color="#10b981" />
                <KpiCard title="Failed" value={kpis.totalFailed} icon="❌" color="#ef4444" />
                <KpiCard title="Skipped" value={kpis.totalSkipped} icon="⏭️" color="#6b7280" />
                <KpiCard title="Avg Confidence" value={kpis.avgConfidenceAcrossRules} icon="📊" format="pct" />
            </div>

            {/* Canon Rule Health */}
            {canonRuleSummaries.length > 0 && (
                <Section title="📋 Canon Rule Health" accent="#6366f1">
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                            <thead>
                                <tr style={{ borderBottom: '1px solid #374151' }}>
                                    <th style={thStyle}>Rule</th>
                                    <th style={thStyle}>Pattern Class</th>
                                    <th style={thStyle}>Confidence</th>
                                    <th style={thStyle}>✅ / ❌ / ⚠️</th>
                                    <th style={thStyle}>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {canonRuleSummaries.map(r => (
                                    <CanonRuleRow key={r.ruleId} rule={r} />
                                ))}
                            </tbody>
                        </table>
                    </div>
                </Section>
            )}

            {/* Pending Drift Records */}
            {pendingDriftRecords.length > 0 && (
                <Section title={`🔍 Pending Drift Records (${pendingDriftRecords.length})`} accent="#f59e0b">
                    {pendingDriftRecords.map(d => (
                        <DriftCard key={d.driftId} drift={d} />
                    ))}
                </Section>
            )}

            {/* Active campaigns */}
            {activeCampaigns.length > 0 && (
                <Section title={`🔄 Active Campaigns (${activeCampaigns.length})`} accent="#6366f1">
                    {activeCampaigns.map(c => (
                        <CampaignCard
                            key={c.campaignId}
                            campaign={c}
                            onDefer={onDefer}
                            onAbort={onAbort}
                        />
                    ))}
                </Section>
            )}

            {/* Deferred campaigns */}
            {deferredCampaigns.length > 0 && (
                <Section title={`⏸️ Deferred Campaigns (${deferredCampaigns.length})`} accent="#6b7280">
                    {deferredCampaigns.map(c => (
                        <CampaignCard
                            key={c.campaignId}
                            campaign={c}
                            onResume={onResume}
                            onAbort={onAbort}
                        />
                    ))}
                </Section>
            )}

            {/* Recent outcomes */}
            {recentOutcomes.length > 0 && (
                <Section title={`📜 Recent Outcomes (${recentOutcomes.length})`} accent="#374151">
                    {recentOutcomes.slice(0, 10).map(o => (
                        <OutcomeCard key={o.outcomeId} outcome={o} />
                    ))}
                </Section>
            )}

            {/* Empty state */}
            {activeCampaigns.length === 0 && pendingDriftRecords.length === 0 && recentOutcomes.length === 0 && (
                <div style={{
                    padding: '2rem',
                    textAlign: 'center',
                    color: '#4b5563',
                    background: '#111827',
                    borderRadius: '8px',
                }}>
                    No harmonization activity yet. Drift detection runs after each autonomous improvement cycle.
                </div>
            )}
        </div>
    );
};

// ─── Sub-components ───────────────────────────────────────────────────────────

const thStyle: React.CSSProperties = {
    padding: '0.4rem 0.6rem',
    textAlign: 'left',
    color: '#9ca3af',
    fontWeight: 600,
};

const KpiCard: React.FC<{
    title: string;
    value: number;
    icon: string;
    color?: string;
    format?: 'int' | 'pct';
}> = ({ title, value, icon, color = '#e5e7eb', format = 'int' }) => (
    <div style={{
        background: '#1f2937',
        borderRadius: '8px',
        padding: '0.75rem',
        textAlign: 'center',
        border: '1px solid #374151',
    }}>
        <div style={{ fontSize: '1.2rem' }}>{icon}</div>
        <div style={{ fontSize: '1.3rem', fontWeight: 700, color }}>
            {format === 'pct' ? `${Math.round(value * 100)}%` : value}
        </div>
        <div style={{ fontSize: '0.7rem', color: '#6b7280', marginTop: '0.2rem' }}>{title}</div>
    </div>
);

const Section: React.FC<{ title: string; accent: string; children: React.ReactNode }> = ({
    title, accent, children,
}) => (
    <div style={{ marginBottom: '1.5rem' }}>
        <h3 style={{
            margin: '0 0 0.75rem',
            fontSize: '0.9rem',
            fontWeight: 700,
            color: '#d1d5db',
            borderLeft: `3px solid ${accent}`,
            paddingLeft: '0.5rem',
        }}>
            {title}
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {children}
        </div>
    </div>
);

const CONFIDENCE_COLOR = (c: number) =>
    c >= 0.75 ? '#10b981' : c >= 0.5 ? '#f59e0b' : '#ef4444';

const STATUS_BADGE_COLORS: Record<string, string> = {
    active: '#10b981',
    disabled: '#6b7280',
    deprecated: '#ef4444',
};

const CanonRuleRow: React.FC<{ rule: HarmonizationRuleConfidenceSummary }> = ({ rule }) => (
    <tr style={{ borderBottom: '1px solid #1f2937' }}>
        <td style={{ padding: '0.35rem 0.6rem', color: '#d1d5db', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={rule.ruleId}>
            {rule.label}
        </td>
        <td style={{ padding: '0.35rem 0.6rem', color: '#9ca3af' }}>{rule.patternClass}</td>
        <td style={{ padding: '0.35rem 0.6rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <div style={{
                    width: 60, height: 6, background: '#374151', borderRadius: 3, overflow: 'hidden',
                }}>
                    <div style={{
                        width: `${Math.round(rule.confidenceCurrent * 100)}%`,
                        height: '100%',
                        background: CONFIDENCE_COLOR(rule.confidenceCurrent),
                        borderRadius: 3,
                    }} />
                </div>
                <span style={{ color: CONFIDENCE_COLOR(rule.confidenceCurrent), fontSize: '0.75rem' }}>
                    {Math.round(rule.confidenceCurrent * 100)}%
                </span>
            </div>
        </td>
        <td style={{ padding: '0.35rem 0.6rem', color: '#9ca3af', fontSize: '0.75rem' }}>
            ✅{rule.successCount} ❌{rule.failureCount} ⚠️{rule.regressionCount}
        </td>
        <td style={{ padding: '0.35rem 0.6rem' }}>
            <span style={{
                fontSize: '0.7rem',
                background: STATUS_BADGE_COLORS[rule.status] ?? '#374151',
                color: '#fff',
                padding: '0.15rem 0.4rem',
                borderRadius: 4,
            }}>
                {rule.status}
            </span>
        </td>
    </tr>
);

const DriftCard: React.FC<{ drift: HarmonizationDriftRecord }> = ({ drift }) => (
    <div style={{
        background: '#1f2937',
        borderRadius: '6px',
        padding: '0.75rem',
        border: `1px solid ${drift.touchesProtectedSubsystem ? '#ef4444' : '#374151'}`,
    }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
            <span style={{ fontWeight: 600, fontSize: '0.85rem', color: '#d1d5db' }}>
                {drift.patternClass}
            </span>
            <span style={{
                fontSize: '0.75rem',
                color: drift.driftSeverity >= 60 ? '#ef4444' : drift.driftSeverity >= 30 ? '#f59e0b' : '#10b981',
            }}>
                severity: {drift.driftSeverity}
            </span>
        </div>
        <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginBottom: '0.3rem' }}>
            {drift.summary}
        </div>
        <div style={{ fontSize: '0.7rem', color: '#6b7280' }}>
            Rule: {drift.ruleId} · Files: {drift.affectedFiles.length}
            {drift.touchesProtectedSubsystem && (
                <span style={{ color: '#ef4444', marginLeft: '0.5rem' }}>⚠️ Protected subsystem</span>
            )}
        </div>
    </div>
);

const CAMPAIGN_STATUS_COLORS: Record<HarmonizationCampaignStatus, string> = {
    draft: '#6b7280',
    active: '#3b82f6',
    step_in_progress: '#8b5cf6',
    awaiting_governance: '#f59e0b',
    paused: '#f59e0b',
    deferred: '#6b7280',
    succeeded: '#10b981',
    failed: '#ef4444',
    rolled_back: '#f59e0b',
    aborted: '#6b7280',
    skipped: '#4b5563',
    expired: '#4b5563',
};

const CampaignCard: React.FC<{
    campaign: HarmonizationCampaign;
    onDefer?: (id: string) => void;
    onAbort?: (id: string) => void;
    onResume?: (id: string) => void;
}> = ({ campaign, onDefer, onAbort, onResume }) => {
    const statusColor = CAMPAIGN_STATUS_COLORS[campaign.status] ?? '#6b7280';
    const progress = campaign.scope.targetFiles.length > 0
        ? Math.round((campaign.currentFileIndex / campaign.scope.targetFiles.length) * 100)
        : 0;

    return (
        <div style={{
            background: '#1f2937',
            borderRadius: '8px',
            padding: '0.85rem',
            border: `1px solid ${statusColor}40`,
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span style={{ fontWeight: 700, fontSize: '0.9rem', color: '#d1d5db' }}>
                    {campaign.label}
                </span>
                <span style={{
                    fontSize: '0.75rem', background: `${statusColor}20`,
                    color: statusColor, padding: '0.15rem 0.5rem', borderRadius: '4px',
                }}>
                    {campaign.status}
                </span>
            </div>
            <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginBottom: '0.4rem' }}>
                Rule: {campaign.ruleId} · Risk: {campaign.riskLevel} · Subsystem: {campaign.scope.targetSubsystem}
            </div>
            {/* Progress bar */}
            <div style={{ marginBottom: '0.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: '#6b7280', marginBottom: '0.2rem' }}>
                    <span>Files {campaign.currentFileIndex}/{campaign.scope.targetFiles.length}</span>
                    <span>{progress}%</span>
                </div>
                <div style={{ height: 4, background: '#374151', borderRadius: 2 }}>
                    <div style={{ width: `${progress}%`, height: '100%', background: statusColor, borderRadius: 2 }} />
                </div>
            </div>
            {campaign.haltReason && (
                <div style={{ fontSize: '0.7rem', color: '#6b7280', marginBottom: '0.4rem' }}>
                    Reason: {campaign.haltReason}
                </div>
            )}
            {/* Actions */}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                {onDefer && campaign.status === 'active' && (
                    <button style={actionBtnStyle('#374151', '#d1d5db')} onClick={() => onDefer(campaign.campaignId)}>
                        Defer
                    </button>
                )}
                {onAbort && !['succeeded', 'failed', 'rolled_back', 'aborted', 'skipped', 'expired'].includes(campaign.status) && (
                    <button style={actionBtnStyle('#7f1d1d', '#fca5a5')} onClick={() => onAbort(campaign.campaignId)}>
                        Abort
                    </button>
                )}
                {onResume && campaign.status === 'deferred' && (
                    <button style={actionBtnStyle('#064e3b', '#6ee7b7')} onClick={() => onResume(campaign.campaignId)}>
                        Resume
                    </button>
                )}
            </div>
        </div>
    );
};

const OutcomeCard: React.FC<{ outcome: HarmonizationOutcomeRecord }> = ({ outcome }) => {
    const statusColor = CAMPAIGN_STATUS_COLORS[outcome.finalStatus] ?? '#6b7280';
    const durationMs = new Date(outcome.endedAt).getTime() - new Date(outcome.startedAt).getTime();
    const durationSec = Math.round(durationMs / 1000);

    return (
        <div style={{
            background: '#111827',
            borderRadius: '6px',
            padding: '0.7rem',
            border: `1px solid ${statusColor}30`,
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
                <span style={{ fontSize: '0.8rem', color: '#d1d5db', fontWeight: 600 }}>
                    {outcome.patternClass} — {outcome.subsystem}
                </span>
                <span style={{ fontSize: '0.75rem', color: statusColor }}>{outcome.finalStatus}</span>
            </div>
            <div style={{ fontSize: '0.7rem', color: '#6b7280' }}>
                Rule: {outcome.ruleId} · Files: {outcome.filesModified} · {durationSec}s
                {outcome.regressionDetected && <span style={{ color: '#ef4444', marginLeft: '0.5rem' }}>⚠️ Regression</span>}
                {outcome.driftReducedConfirmed && <span style={{ color: '#10b981', marginLeft: '0.5rem' }}>✅ Drift reduced</span>}
                {outcome.confidenceDeltaApplied !== 0 && (
                    <span style={{ color: outcome.confidenceDeltaApplied > 0 ? '#10b981' : '#ef4444', marginLeft: '0.5rem' }}>
                        confidence {outcome.confidenceDeltaApplied > 0 ? '+' : ''}{(outcome.confidenceDeltaApplied * 100).toFixed(1)}%
                    </span>
                )}
            </div>
            {outcome.learningNotes.length > 0 && (
                <div style={{ marginTop: '0.3rem' }}>
                    {outcome.learningNotes.map((n, i) => (
                        <div key={i} style={{ fontSize: '0.7rem', color: '#4b5563' }}>• {n}</div>
                    ))}
                </div>
            )}
        </div>
    );
};

function actionBtnStyle(bg: string, color: string): React.CSSProperties {
    return {
        background: bg,
        color,
        border: 'none',
        borderRadius: '4px',
        padding: '0.25rem 0.6rem',
        fontSize: '0.75rem',
        cursor: 'pointer',
    };
}

export default HarmonizationDashboardPanel;
