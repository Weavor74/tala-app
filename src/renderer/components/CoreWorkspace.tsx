import React, { useState } from 'react';
import { MemoryViewer } from './MemoryViewer';
import ReflectionPanel from './ReflectionPanel';

/**
 * CoreWorkspace
 * 
 * Unified panel for TALA's internal systems:
 * - Memory Bank (Short-term facts & context)
 * - Reflection (Self-improvement & Soul identity)
 */
export const CoreWorkspace: React.FC = () => {
    const [mode, setMode] = useState<'memory' | 'reflection'>('memory');

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#1e1e1e' }}>
            {/* Mode Selector */}
            <div style={{
                display: 'flex',
                background: '#252526',
                borderBottom: '1px solid #333',
                padding: '2px'
            }}>
                <button
                    onClick={() => setMode('memory')}
                    style={{
                        flex: 1,
                        padding: '10px 5px',
                        background: mode === 'memory' ? '#37373d' : 'transparent',
                        border: 'none',
                        color: mode === 'memory' ? '#fff' : '#888',
                        cursor: 'pointer',
                        fontSize: '10px',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '1px',
                        transition: 'all 0.2s'
                    }}
                >
                    Memory Bank
                </button>
                <button
                    onClick={() => setMode('reflection')}
                    style={{
                        flex: 1,
                        padding: '10px 5px',
                        background: mode === 'reflection' ? '#37373d' : 'transparent',
                        border: 'none',
                        color: mode === 'reflection' ? '#fff' : '#888',
                        cursor: 'pointer',
                        fontSize: '10px',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '1px',
                        transition: 'all 0.2s'
                    }}
                >
                    Reflection
                </button>
            </div>

            {/* Content Area */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
                {mode === 'memory' ? (
                    <MemoryViewer />
                ) : (
                    <ReflectionPanel />
                )}
            </div>

            {/* Footer Status */}
            <div style={{
                padding: '6px 12px',
                fontSize: '9px',
                color: '#555',
                borderTop: '1px solid #333',
                background: '#1e1e1e',
                textAlign: 'center',
                textTransform: 'uppercase',
                letterSpacing: '0.5px'
            }}>
                Tala Core Systems • {mode} Active
            </div>
        </div>
    );
};
