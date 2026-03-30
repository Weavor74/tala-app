import React from 'react';
import type {
    CampaignDashboardState,
    RepairCampaign,
    CampaignOutcomeSummary,
    CampaignStep,
    CampaignCheckpoint,
} from '../../shared/repairCampaignTypes';

/**
 * CampaignDashboardPanel — Phase 5.5 P5.5H
 *
 * Reflection Dashboard integration for repair campaigns.
 *
 * Displays:
 *   - KPI bar (campaigns, steps, success, failures, rollbacks)
 *   - Active campaigns with per-step progress
 *   - Checkpoint and reassessment outcomes
 *   - Deferred/halted campaigns with resume/abort actions
 *   - Recent campaign outcome history
 */

interface CampaignDashboardPanelProps {
    state: CampaignDashboardState;
    onDefer?: (campaignId: string) => void;
    onAbort?: (campaignId: string) => void;
    onResume?: (campaignId: string) => void;
}

const CampaignDashboardPanel: React.FC<CampaignDashboardPanelProps> = ({
    state,
    onDefer,
    onAbort,
    onResume,
}) => {
    const { kpis, activeCampaigns, deferredCampaigns, recentOutcomes } = state;

    return (
        <div style={{ color: '#e5e7eb' }}>
            {/* Header */}
            <div style={{
                padding: '1rem',
                background: '#1e293b',
                borderRadius: '8px',
                borderLeft: '4px solid #f59e0b',
                marginBottom: '1.5rem',
            }}>
                <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
                    🛠️ Repair Campaigns
                </h2>
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#6b7280' }}>
                    Bounded multi-step repair workflows with checkpoints and reassessment
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
                <KpiCard title="Rolled Back" value={kpis.totalRolledBack} icon="↩️" color="#f59e0b" />
                <KpiCard title="Deferred" value={kpis.totalDeferred} icon="⏸️" color="#6b7280" />
            </div>

            {/* Active campaigns */}
            {activeCampaigns.length > 0 && (
                <Section title={`🔄 Active Campaigns (${activeCampaigns.length})`} accent="#f59e0b">
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

            {/* Deferred/halted campaigns */}
            {deferredCampaigns.length > 0 && (
                <Section title={`⏸️ Deferred / Halted (${deferredCampaigns.length})`} accent="#6b7280">
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
                        <OutcomeCard key={o.campaignId} outcome={o} />
                    ))}
                </Section>
            )}

            {/* Empty state */}
            {activeCampaigns.length === 0 && deferredCampaigns.length === 0 && recentOutcomes.length === 0 && (
                <div style={{
                    padding: '2rem',
                    textAlign: 'center',
                    color: '#6b7280',
                    background: '#1e293b',
                    borderRadius: '8px',
                    fontSize: '0.875rem',
                }}>
                    No repair campaigns active. Campaigns are created when multi-step repairs are needed.
                </div>
            )}
        </div>
    );
};

export default CampaignDashboardPanel;

// ─── Sub-components ───────────────────────────────────────────────────────────

const KpiCard: React.FC<{ title: string; value: number; icon: string; color?: string }> = ({
    title, value, icon, color = '#e5e7eb',
}) => (
    <div style={{
        padding: '0.75rem',
        background: '#1e293b',
        borderRadius: '8px',
        textAlign: 'center',
    }}>
        <div style={{ fontSize: '1.25rem', marginBottom: '0.25rem' }}>{icon}</div>
        <div style={{ fontSize: '1.5rem', fontWeight: 700, color }}>{value}</div>
        <div style={{ fontSize: '0.7rem', color: '#6b7280', marginTop: '0.25rem' }}>{title}</div>
    </div>
);

const Section: React.FC<{ title: string; accent: string; children: React.ReactNode }> = ({
    title, accent, children,
}) => (
    <div style={{ marginBottom: '1.5rem' }}>
        <div style={{
            fontSize: '0.8rem',
            fontWeight: 600,
            color: '#9ca3af',
            borderBottom: `2px solid ${accent}`,
            paddingBottom: '0.4rem',
            marginBottom: '0.75rem',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
        }}>
            {title}
        </div>
        {children}
    </div>
);

const STATUS_COLORS: Record<string, string> = {
    active: '#3b82f6',
    step_in_progress: '#8b5cf6',
    awaiting_checkpoint: '#f59e0b',
    awaiting_reassessment: '#f97316',
    paused: '#6b7280',
    deferred: '#6b7280',
    succeeded: '#10b981',
    failed: '#ef4444',
    rolled_back: '#dc2626',
    aborted: '#9ca3af',
    expired: '#6b7280',
    draft: '#4b5563',
};

const CampaignCard: React.FC<{
    campaign: RepairCampaign;
    onDefer?: (id: string) => void;
    onAbort?: (id: string) => void;
    onResume?: (id: string) => void;
}> = ({ campaign, onDefer, onAbort, onResume }) => {
    const statusColor = STATUS_COLORS[campaign.status] ?? '#6b7280';
    const passedSteps = campaign.steps.filter(s => s.status === 'passed').length;
    const totalSteps = campaign.steps.length;

    return (
        <div style={{
            background: '#0f172a',
            borderRadius: '8px',
            border: `1px solid ${statusColor}33`,
            padding: '0.875rem',
            marginBottom: '0.75rem',
        }}>
            {/* Campaign header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                <div>
                    <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{campaign.label}</div>
                    <div style={{ fontSize: '0.7rem', color: '#6b7280', marginTop: '0.15rem' }}>
                        {campaign.subsystem} · {campaign.originType}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <span style={{
                        background: `${statusColor}22`,
                        color: statusColor,
                        padding: '0.15rem 0.5rem',
                        borderRadius: '4px',
                        fontSize: '0.7rem',
                        fontWeight: 600,
                    }}>
                        {campaign.status}
                    </span>
                </div>
            </div>

            {/* Progress bar */}
            <div style={{ marginBottom: '0.5rem' }}>
                <div style={{ fontSize: '0.7rem', color: '#6b7280', marginBottom: '0.2rem' }}>
                    {passedSteps}/{totalSteps} steps passed
                </div>
                <div style={{ background: '#1e293b', borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                    <div style={{
                        width: totalSteps > 0 ? `${(passedSteps / totalSteps) * 100}%` : '0%',
                        height: '100%',
                        background: statusColor,
                        borderRadius: '4px',
                        transition: 'width 0.3s',
                    }} />
                </div>
            </div>

            {/* Step list */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginBottom: '0.5rem' }}>
                {campaign.steps.map(step => (
                    <StepChip key={step.stepId} step={step} />
                ))}
            </div>

            {/* Latest checkpoint */}
            {campaign.checkpoints.length > 0 && (
                <CheckpointBadge checkpoint={campaign.checkpoints[campaign.checkpoints.length - 1]} />
            )}

            {/* Latest reassessment */}
            {campaign.reassessmentRecords.length > 0 && (
                <div style={{ fontSize: '0.7rem', color: '#6b7280', marginTop: '0.3rem' }}>
                    Last reassessment: <span style={{ color: '#e5e7eb' }}>
                        {campaign.reassessmentRecords[campaign.reassessmentRecords.length - 1].decision}
                    </span>
                    {' '}({campaign.reassessmentRecords[campaign.reassessmentRecords.length - 1].triggerRule})
                </div>
            )}

            {/* Halt reason */}
            {campaign.haltReason && (
                <div style={{
                    fontSize: '0.7rem',
                    color: '#fca5a5',
                    background: '#450a0a',
                    padding: '0.3rem 0.5rem',
                    borderRadius: '4px',
                    marginTop: '0.4rem',
                }}>
                    ⚠️ {campaign.haltReason}
                </div>
            )}

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
                {onDefer && (
                    <button
                        onClick={() => onDefer(campaign.campaignId)}
                        style={actionButtonStyle('#374151', '#e5e7eb')}
                    >
                        ⏸ Defer
                    </button>
                )}
                {onResume && (
                    <button
                        onClick={() => onResume(campaign.campaignId)}
                        style={actionButtonStyle('#065f46', '#6ee7b7')}
                    >
                        ▶ Resume
                    </button>
                )}
                {onAbort && (
                    <button
                        onClick={() => onAbort(campaign.campaignId)}
                        style={actionButtonStyle('#450a0a', '#fca5a5')}
                    >
                        ✕ Abort
                    </button>
                )}
            </div>
        </div>
    );
};

const STEP_STATUS_COLORS: Record<string, string> = {
    pending: '#374151',
    running: '#3b82f6',
    awaiting_verification: '#8b5cf6',
    passed: '#10b981',
    failed: '#ef4444',
    skipped: '#6b7280',
    rolled_back: '#dc2626',
};

const StepChip: React.FC<{ step: CampaignStep }> = ({ step }) => {
    const color = STEP_STATUS_COLORS[step.status] ?? '#374151';
    return (
        <div title={`${step.label}\n${step.status}`} style={{
            background: `${color}22`,
            border: `1px solid ${color}55`,
            color,
            padding: '0.1rem 0.4rem',
            borderRadius: '4px',
            fontSize: '0.65rem',
            fontWeight: 600,
            whiteSpace: 'nowrap',
            maxWidth: '160px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
        }}>
            {step.order + 1}. {step.label}
        </div>
    );
};

const CHECKPOINT_COLORS: Record<string, string> = {
    passed: '#10b981',
    degraded: '#f59e0b',
    failed: '#ef4444',
};

const CheckpointBadge: React.FC<{ checkpoint: CampaignCheckpoint }> = ({ checkpoint }) => {
    const color = CHECKPOINT_COLORS[checkpoint.outcome] ?? '#6b7280';
    return (
        <div style={{
            fontSize: '0.7rem',
            color: '#9ca3af',
            marginTop: '0.3rem',
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'center',
        }}>
            <span>Checkpoint:</span>
            <span style={{
                color,
                fontWeight: 600,
                background: `${color}22`,
                padding: '0.1rem 0.4rem',
                borderRadius: '4px',
            }}>
                {checkpoint.outcome}
            </span>
            <span style={{ color: '#6b7280' }}>{checkpoint.summary}</span>
        </div>
    );
};

const OutcomeCard: React.FC<{ outcome: CampaignOutcomeSummary }> = ({ outcome }) => {
    const statusColor = STATUS_COLORS[outcome.finalStatus] ?? '#6b7280';
    const durationSec = Math.round(outcome.durationMs / 1000);
    return (
        <div style={{
            background: '#0f172a',
            borderRadius: '8px',
            border: `1px solid ${statusColor}33`,
            padding: '0.625rem 0.875rem',
            marginBottom: '0.5rem',
            fontSize: '0.8rem',
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                    <span style={{ fontWeight: 600 }}>{outcome.label}</span>
                    <span style={{ color: '#6b7280', fontSize: '0.7rem', marginLeft: '0.5rem' }}>
                        {outcome.subsystem} · {outcome.originType}
                    </span>
                </div>
                <span style={{
                    color: statusColor,
                    fontWeight: 600,
                    fontSize: '0.7rem',
                    background: `${statusColor}22`,
                    padding: '0.1rem 0.4rem',
                    borderRadius: '4px',
                }}>
                    {outcome.finalStatus}
                </span>
            </div>
            <div style={{ color: '#6b7280', fontSize: '0.7rem', marginTop: '0.2rem' }}>
                {outcome.stepCount} steps · {durationSec}s · rollback freq {(outcome.rollbackFrequency * 100).toFixed(0)}%
            </div>
            {outcome.learningNotes.length > 0 && (
                <div style={{ color: '#9ca3af', fontSize: '0.7rem', marginTop: '0.2rem' }}>
                    {outcome.learningNotes[0]}
                </div>
            )}
        </div>
    );
};

function actionButtonStyle(bg: string, color: string): React.CSSProperties {
    return {
        background: bg,
        color,
        border: 'none',
        padding: '0.25rem 0.6rem',
        borderRadius: '4px',
        fontSize: '0.7rem',
        cursor: 'pointer',
        fontWeight: 600,
    };
}
