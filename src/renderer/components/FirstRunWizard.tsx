import React, { useState } from 'react';

interface FirstRunWizardProps {
    onComplete: () => void;
}

export const FirstRunWizard: React.FC<FirstRunWizardProps> = ({ onComplete }) => {
    const [step, setStep] = useState(1);

    const handleNext = () => {
        if (step < 3) setStep(step + 1);
        else onComplete();
    };

    return (
        <div className="wizard-overlay">
            <div className="wizard-card">
                {/* Header */}
                <div className="wizard-header" style={{ textAlign: 'center' }}>
                    <h1>Welcome to Tala</h1>
                    <p>Your Autonomous AI Agent</p>
                </div>

                {/* Content */}
                <div className="wizard-body">
                    {step === 1 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                            <div style={{ fontSize: '48px' }}>👋</div>
                            <p style={{ fontSize: '18px', color: 'var(--text-active)' }}>
                                Tala is designed to be your pair programmer and autonomous assistant.
                            </p>
                            <p style={{ color: 'var(--text-muted)' }}>
                                I can edit files, run commands, browse the web, and manage your projects.
                            </p>
                        </div>
                    )}

                    {step === 2 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                            <div style={{ fontSize: '48px' }}>🧠</div>
                            <h2 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--text-active)' }}>Intelligence Engine</h2>
                            <p style={{ color: 'var(--text-main)' }}>
                                By default, Tala uses <strong>Ollama, vLLM, or LlamaCPP</strong> for local privacy and speed.
                            </p>
                            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                                Make sure Ollama is running! You can switch to Cloud providers (OpenAI, Anthropic) in Settings later.
                            </p>
                        </div>
                    )}

                    {step === 3 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                            <div style={{ fontSize: '48px' }}>🚀</div>
                            <h2 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--text-active)' }}>Ready to Launch</h2>
                            <p style={{ color: 'var(--text-main)' }}>
                                You're all set! Explore the sidebar to manage files, memory, and tools.
                            </p>
                            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                                Hit <strong>Ctrl+Shift+P</strong> anytime to focus the chat.
                            </p>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="wizard-footer">
                    <div className="wizard-dots">
                        <div className={`wizard-dot ${step === 1 ? 'active' : ''}`} />
                        <div className={`wizard-dot ${step === 2 ? 'active' : ''}`} />
                        <div className={`wizard-dot ${step === 3 ? 'active' : ''}`} />
                    </div>
                    <button onClick={handleNext} className="wizard-next">
                        {step === 3 ? 'Get Started' : 'Next'}
                    </button>
                </div>
            </div>
        </div>
    );
};
