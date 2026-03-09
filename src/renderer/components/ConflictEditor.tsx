/**
 * ConflictEditor Component
 * 
 * A specialized interactive diff viewer for resolving git-style merge conflicts.
 * 
 * **Mechanism:**
 * - Parsers: Splices file content into `normal` and `conflict` chunks using standard markers (`<<<<<<<`, `=======`, `>>>>>>>`).
 * - Interaction: Provides per-chunk resolution actions (Accept Current, Accept Incoming, Accept Both).
 * - Completion: Concatenates resolved chunks and notifies the caller via `onResolve`.
 */
import React, { useState, useEffect } from 'react';

interface ConflictChunk {
    id: string;
    type: 'normal' | 'conflict';
    content?: string; // for normal
    current?: string; // for conflict (HEAD)
    incoming?: string; // for conflict (Incoming)
    resolvedContent?: string; // if resolved
    status?: 'unresolved' | 'resolved';
}

interface ConflictEditorProps {
    path: string;
    content: string;
    onResolve: (path: string, newContent: string) => void;
    onCancel: () => void;
}

export const ConflictEditor: React.FC<ConflictEditorProps> = ({ path, content, onResolve, onCancel }) => {
    const [chunks, setChunks] = useState<ConflictChunk[]>([]);

    useEffect(() => {
        parseContent(content);
    }, [content]);

    const parseContent = (text: string) => {
        const lines = text.split('\n');
        const newChunks: ConflictChunk[] = [];
        let parsingConflict = false;
        let conflictStage: 'current' | 'incoming' | null = null;

        // Simple parser for standard git conflict markers
        // <<<<<<< HEAD
        // ... current ...
        // =======
        // ... incoming ...
        // >>>>>>> incoming_branch

        let buffer: string[] = [];
        let currentBuffer: string[] = [];
        let incomingBuffer: string[] = [];

        const flushBuffer = () => {
            if (buffer.length > 0) {
                newChunks.push({
                    id: Math.random().toString(36).substr(2, 9),
                    type: 'normal',
                    content: buffer.join('\n')
                });
                buffer = [];
            }
        };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.startsWith('<<<<<<<')) {
                flushBuffer();
                parsingConflict = true;
                conflictStage = 'current';
                currentBuffer = [];
                incomingBuffer = [];
            } else if (line.startsWith('=======')) {
                conflictStage = 'incoming';
            } else if (line.startsWith('>>>>>>>')) {
                // End of conflict
                newChunks.push({
                    id: Math.random().toString(36).substr(2, 9),
                    type: 'conflict',
                    current: currentBuffer.join('\n'),
                    incoming: incomingBuffer.join('\n'),
                    status: 'unresolved'
                });
                parsingConflict = false;
                conflictStage = null;
            } else {
                if (parsingConflict) {
                    if (conflictStage === 'current') {
                        currentBuffer.push(line);
                    } else if (conflictStage === 'incoming') {
                        incomingBuffer.push(line);
                    }
                } else {
                    buffer.push(line);
                }
            }
        }
        flushBuffer();
        setChunks(newChunks);
    };

    const resolveChunk = (id: string, choice: 'current' | 'incoming' | 'both') => {
        setChunks(prev => prev.map(c => {
            if (c.id !== id || c.type !== 'conflict') return c;

            let resolved = '';
            if (choice === 'current') resolved = c.current || '';
            else if (choice === 'incoming') resolved = c.incoming || '';
            else if (choice === 'both') resolved = (c.current || '') + '\n' + (c.incoming || '');

            return { ...c, status: 'resolved', resolvedContent: resolved };
        }));
    };

    const handleComplete = () => {
        const fullContent = chunks.map(c => {
            if (c.type === 'normal') return c.content;
            return c.resolvedContent; // Assuming all resolved
        }).join('\n');
        onResolve(path, fullContent);
    };

    const unresolvedCount = chunks.filter(c => c.type === 'conflict' && c.status === 'unresolved').length;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#1e1e1e', color: '#ccc', fontFamily: 'Consolas, monospace' }}>
            {/* Header */}
            <div style={{ padding: 10, borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#252526' }}>
                <span style={{ fontWeight: 'bold' }}>Conflict Resolution: {path}</span>
                <div style={{ display: 'flex', gap: 10 }}>
                    <span style={{ color: unresolvedCount > 0 ? '#f44' : '#4f4' }}>
                        {unresolvedCount} Remaining
                    </span>
                    <button
                        onClick={handleComplete}
                        disabled={unresolvedCount > 0}
                        style={{ background: unresolvedCount > 0 ? '#444' : '#0e639c', color: 'white', border: 'none', padding: '5px 10px', cursor: unresolvedCount > 0 ? 'not-allowed' : 'pointer' }}
                    >
                        Complete Merge
                    </button>
                    <button onClick={onCancel} style={{ background: 'transparent', border: '1px solid #444', color: '#ccc', padding: '5px 10px', cursor: 'pointer' }}>
                        Cancel
                    </button>
                </div>
            </div>

            {/* Editor Area */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                {chunks.map(chunk => {
                    if (chunk.type === 'normal') {
                        return (
                            <div key={chunk.id} style={{ whiteSpace: 'pre-wrap', opacity: 0.8 }}>
                                {chunk.content}
                            </div>
                        );
                    }

                    // Conflict Chunk
                    if (chunk.status === 'resolved') {
                        return (
                            <div key={chunk.id} style={{ background: '#2d382d', padding: 10, margin: '10px 0', border: '1px solid #4f4' }}>
                                <div style={{ fontSize: 10, color: '#4f4', marginBottom: 5 }}>RESOLVED</div>
                                <div style={{ whiteSpace: 'pre-wrap' }}>{chunk.resolvedContent}</div>
                            </div>
                        );
                    }

                    return (
                        <div key={chunk.id} style={{ border: '1px solid #fbd75b', margin: '20px 0' }}>
                            {/* Toolbar */}
                            <div style={{ background: '#3a3a2a', padding: 5, display: 'flex', gap: 5, justifyContent: 'center', borderBottom: '1px solid #fbd75b' }}>
                                <button onClick={() => resolveChunk(chunk.id, 'current')} style={{ background: '#0e639c', color: 'white', border: 'none', padding: '4px 8px', cursor: 'pointer' }}>Accept Current</button>
                                <button onClick={() => resolveChunk(chunk.id, 'incoming')} style={{ background: '#007acc', color: 'white', border: 'none', padding: '4px 8px', cursor: 'pointer' }}>Accept Incoming</button>
                                <button onClick={() => resolveChunk(chunk.id, 'both')} style={{ background: '#444', color: 'white', border: 'none', padding: '4px 8px', cursor: 'pointer' }}>Accept Both</button>
                            </div>

                            <div style={{ display: 'flex' }}>
                                <div style={{ flex: 1, padding: 10, borderRight: '1px solid #444', background: '#222' }}>
                                    <div style={{ fontSize: 10, color: '#888', marginBottom: 5, textAlign: 'center' }}>CURRENT (HEAD)</div>
                                    <div style={{ whiteSpace: 'pre-wrap', color: '#9cdcfe' }}>{chunk.current}</div>
                                </div>
                                <div style={{ flex: 1, padding: 10, background: '#222' }}>
                                    <div style={{ fontSize: 10, color: '#888', marginBottom: 5, textAlign: 'center' }}>INCOMING</div>
                                    <div style={{ whiteSpace: 'pre-wrap', color: '#ce9178' }}>{chunk.incoming}</div>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
