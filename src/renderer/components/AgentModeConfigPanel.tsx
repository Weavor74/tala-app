/**
 * AgentModeConfigPanel
 * 
 * An overlay interface for fine-tuning the active agent mode (RP, Hybrid, Assistant).
 * 
 * **Functionality:**
 * - Reactive Configuration: Loads and updates mode-specific parameters (intensity, verbosity, safety guards).
 * - Mode Awareness: Changes the available configuration fields based on the currently selected `activeMode`.
 * - Persistence: Immediately syncs adjustments to the backend via `tala.updateModeConfig`.
 */
import React, { useState, useEffect } from 'react';

interface Props {
    activeMode: 'rp' | 'hybrid' | 'assistant';
    onClose: () => void;
}

export const AgentModeConfigPanel: React.FC<Props> = ({ activeMode, onClose }) => {
    const [config, setConfig] = useState<any>(null);
    const api = (window as any).tala;

    useEffect(() => {
        const loadConfig = async () => {
            if (api?.getModeConfig) {
                const cfg = await api.getModeConfig(activeMode);
                setConfig(cfg);
            }
        };
        loadConfig();
    }, [activeMode, api]);

    const handleSave = async (patch: any) => {
        const newConfig = { ...config, ...patch };
        setConfig(newConfig);
        if (api?.updateModeConfig) {
            await api.updateModeConfig(activeMode, patch);
        }
    };

    if (!config) return <div style={{ padding: 20, color: '#888' }}>Loading config...</div>;

    const renderField = (label: string, key: string, type: 'checkbox' | 'number' | 'select' | 'slider', options?: string[]) => {
        const value = config[key];

        return (
            <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label style={{ fontSize: 12, color: '#ccc' }}>{label}</label>
                {type === 'checkbox' && (
                    <input
                        type="checkbox"
                        checked={!!value}
                        onChange={(e) => handleSave({ [key]: e.target.checked })}
                    />
                )}
                {type === 'slider' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.1"
                            value={value || 0}
                            onChange={(e) => handleSave({ [key]: parseFloat(e.target.value) })}
                            style={{ width: 80 }}
                        />
                        <span style={{ fontSize: 10, color: '#666', minWidth: 20 }}>{value}</span>
                    </div>
                )}
                {type === 'number' && (
                    <input
                        type="number"
                        value={value || 0}
                        onChange={(e) => handleSave({ [key]: parseInt(e.target.value) })}
                        style={{ width: 60, background: '#333', color: '#fff', border: '1px solid #444', fontSize: 11 }}
                    />
                )}
                {type === 'select' && options && (
                    <select
                        value={value}
                        onChange={(e) => handleSave({ [key]: e.target.value })}
                        style={{ background: '#333', color: '#fff', border: '1px solid #444', fontSize: 11 }}
                    >
                        {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                )}
            </div>
        );
    };

    return (
        <div style={{
            position: 'absolute',
            top: 40,
            right: 10,
            width: 240,
            background: '#1e1e1e',
            border: '1px solid #333',
            borderRadius: 4,
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column'
        }}>
            <div style={{
                padding: '8px 12px',
                borderBottom: '1px solid #333',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: '#252526'
            }}>
                <span style={{ fontSize: 11, fontWeight: 'bold', color: '#aaa', textTransform: 'uppercase' }}>
                    {activeMode} Configuration
                </span>
                <span onClick={onClose} style={{ cursor: 'pointer', fontSize: 14, color: '#666' }}>×</span>
            </div>
            <div style={{ padding: 12, overflowY: 'auto', maxHeight: 400 }}>
                {activeMode === 'rp' && (
                    <>
                        {renderField('Intensity', 'rpIntensity', 'slider')}
                        {renderField('Lore Density', 'loreDensity', 'slider')}
                        {renderField('Memory Recall', 'allowMemoryRecall', 'checkbox')}
                        {renderField('Astro', 'allowAstro', 'checkbox')}
                    </>
                )}
                {activeMode === 'hybrid' && (
                    <>
                        {renderField('Blend Ratio', 'blendRatio', 'slider')}
                        {renderField('No Task Acks', 'noTaskAcknowledgements', 'checkbox')}
                        {renderField('RAG', 'allowRag', 'checkbox')}
                        {renderField('Mem0 Search', 'allowMem0Search', 'checkbox')}
                        {renderField('Astro', 'allowAstro', 'checkbox')}
                        {renderField('FS Read', 'allowFsRead', 'checkbox')}
                        {renderField('FS Write', 'allowFsWrite', 'select', ['on', 'confirm', 'off'])}
                        {renderField('Shell Run', 'allowShellRun', 'checkbox')}
                    </>
                )}
                {activeMode === 'assistant' && (
                    <>
                        {renderField('Verbosity', 'verbosity', 'select', ['concise', 'normal', 'detailed'])}
                        {renderField('Auto Tools', 'autoUseTools', 'checkbox')}
                        {renderField('Safe Mode', 'safeMode', 'checkbox')}
                        {renderField('Memory Writes', 'memoryWrites', 'checkbox')}
                        {renderField('Tools-Only Coding', 'toolsOnlyCodingTurns', 'checkbox')}
                        {renderField('Timeout (ms)', 'ollamaTimeoutMs', 'number')}
                    </>
                )}
            </div>
        </div>
    );
};
