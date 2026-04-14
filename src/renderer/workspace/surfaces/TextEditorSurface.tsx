import React from 'react';
import type { WorkspaceSurfaceProps } from './WorkspaceSurfaceTypes';

export const TextEditorSurface: React.FC<WorkspaceSurfaceProps> = ({
    document,
    onContentChange,
    onSave,
    onEditorKeyDown,
}) => {
    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '5px 10px', background: '#252526', color: '#ccc', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{document.path || document.title}</span>
                {!document.readOnly && onSave && (
                    <button
                        onClick={onSave}
                        style={{ background: '#0e639c', color: 'white', border: 'none', padding: '2px 10px', fontSize: 10, cursor: 'pointer', borderRadius: 2 }}
                    >
                        SAVE
                    </button>
                )}
            </div>
            <textarea
                style={{ flex: 1, background: '#1e1e1e', color: '#d4d4d4', padding: 10, border: 'none', resize: 'none', fontFamily: 'Consolas, monospace', outline: 'none' }}
                value={document.payload || ''}
                onChange={e => onContentChange?.(e.target.value)}
                onKeyDown={onEditorKeyDown}
                readOnly={document.readOnly}
            />
        </div>
    );
};

export default TextEditorSurface;

