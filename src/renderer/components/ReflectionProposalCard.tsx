import React, { useState } from 'react';
import type { ChangeProposal } from '../reflectionTypes';

interface Props {
    proposal: ChangeProposal;
    onAction: () => void;
}

/**
 * ReflectionProposalCard
 * 
 * An interactive card for reviewing AI-suggested change proposals.
 * Provides risk assessment, description, and approval/rejection actions.
 */
const ReflectionProposalCard: React.FC<Props> = ({ proposal, onAction }) => {
    const [submitting, setSubmitting] = useState(false);
    const tala = (window as any).tala;

    const handleApprove = async () => {
        setSubmitting(true);
        try {
            await tala.approveProposal(proposal.id);
            onAction();
        } catch (err) {
            console.error('Approve failed:', err);
        } finally {
            setSubmitting(false);
        }
    };

    const handleReject = async () => {
        setSubmitting(true);
        try {
            await tala.rejectProposal(proposal.id);
            onAction();
        } catch (err) {
            console.error('Reject failed:', err);
        } finally {
            setSubmitting(false);
        }
    };

    const getRiskStyle = (score: number): React.CSSProperties => {
        if (score <= 3) return { color: '#4ade80', background: 'rgba(74, 222, 128, 0.1)', border: '1px solid rgba(74, 222, 128, 0.2)' };
        if (score <= 6) return { color: '#facc15', background: 'rgba(250, 204, 21, 0.1)', border: '1px solid rgba(250, 204, 21, 0.2)' };
        return { color: '#f87171', background: 'rgba(248, 113, 113, 0.1)', border: '1px solid rgba(248, 113, 113, 0.2)' };
    };

    return (
        <div style={{
            background: '#111827',
            border: '1px solid #374151',
            borderRadius: '8px',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 10px 25px rgba(0,0,0,0.3)'
        }}>
            <div style={{ padding: '1.25rem', borderBottom: '1px solid #1f2937' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                    <span style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.1em',
                        color: '#60a5fa',
                        padding: '0.25rem 0.5rem',
                        background: 'rgba(96, 165, 250, 0.1)',
                        borderRadius: '4px'
                    }}>
                        {proposal.category}
                    </span>
                    <span style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        padding: '0.25rem 0.5rem',
                        borderRadius: '4px',
                        ...getRiskStyle(proposal.risk.score)
                    }}>
                        Risk: {proposal.risk.score}/10
                    </span>
                </div>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#fff', marginBottom: '0.5rem' }}>{proposal.title}</h3>
                <p style={{ color: '#9ca3af', fontSize: '0.875rem', lineHeight: 1.6 }}>{proposal.description}</p>

                {proposal.changes.length > 0 && (
                    <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: '#6b7280' }}>
                        📁 {proposal.changes.length} file(s): {proposal.changes.map(c => c.path).join(', ')}
                    </div>
                )}
            </div>

            <div style={{
                padding: '0.75rem 1rem',
                background: 'rgba(31, 41, 55, 0.3)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
            }}>
                <div style={{ fontSize: '0.7rem', color: '#6b7280' }}>
                    Reflection: <span style={{ fontFamily: 'monospace' }}>{proposal.reflectionId.split('-')[0]}</span>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                        onClick={handleReject}
                        disabled={submitting}
                        style={{
                            padding: '0.5rem 1rem',
                            fontSize: '0.875rem',
                            color: '#9ca3af',
                            background: 'transparent',
                            border: '1px solid #374151',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            transition: 'all 0.2s'
                        }}
                    >
                        Reject
                    </button>
                    <button
                        onClick={handleApprove}
                        disabled={submitting}
                        style={{
                            padding: '0.5rem 1.5rem',
                            fontSize: '0.875rem',
                            background: '#16a34a',
                            color: '#fff',
                            fontWeight: 700,
                            border: 'none',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            boxShadow: '0 4px 10px rgba(22, 163, 74, 0.2)',
                            transition: 'all 0.2s',
                            transform: 'scale(1)'
                        }}
                        onMouseOver={e => { e.currentTarget.style.background = '#22c55e'; e.currentTarget.style.transform = 'scale(1.05)'; }}
                        onMouseOut={e => { e.currentTarget.style.background = '#16a34a'; e.currentTarget.style.transform = 'scale(1)'; }}
                    >
                        {submitting ? 'Applying...' : 'Approve & Apply'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ReflectionProposalCard;
