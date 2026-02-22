/**
 * ChatSessions — sidebar panel for browsing, creating, and managing chat sessions.
 *
 * Displays a scrollable list of saved sessions, each showing title (first user message)
 * and timestamp. Click to load, delete button per session, "New Chat" at top.
 */
import React, { useState, useEffect } from 'react';

interface Session {
    id: string;
    title: string;
    createdAt: string;
    messageCount: number;
    parentId?: string;
    branchPoint?: number;
}

interface Props {
    onLoadSession: (messages: any[]) => void;
    activeId?: string;
    onSessionSelect?: (id: string, messages: any[]) => void;
}

export const ChatSessions: React.FC<Props> = ({ onLoadSession, activeId: externalActiveId, onSessionSelect }) => {
    const [sessions, setSessions] = useState<Session[]>([]);
    const [localActiveId, setLocalActiveId] = useState<string>(externalActiveId || '');
    const api = (window as any).tala;

    // Synchronize local state if external active ID changes
    useEffect(() => {
        if (externalActiveId !== undefined) {
            setLocalActiveId(externalActiveId);
        }
    }, [externalActiveId]);

    const activeId = externalActiveId !== undefined ? externalActiveId : localActiveId;

    const refresh = async () => {
        if (api?.listSessions) {
            const list = await api.listSessions();
            setSessions(list);
        }
    };

    useEffect(() => {
        refresh();
        const handleUpdate = () => refresh();
        if (api?.on) api.on('sessions-update', handleUpdate);
        return () => {
            if (api?.off) api.off('sessions-update', handleUpdate);
        };
    }, []);

    const handleNew = async () => {
        if (api?.newSession) {
            const id = await api.newSession();
            setLocalActiveId(id);
            if (onSessionSelect) onSessionSelect(id, []);
            else onLoadSession([]);
            refresh();
        }
    };

    const handleLoad = async (id: string) => {
        if (api?.loadSession) {
            const messages = await api.loadSession(id);
            setLocalActiveId(id);
            if (onSessionSelect) onSessionSelect(id, messages);
            else onLoadSession(messages);
        }
    };

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        if (api?.deleteSession) {
            await api.deleteSession(id);
            if (activeId === id) {
                if (onSessionSelect) onSessionSelect('', []);
                else onLoadSession([]);
                setLocalActiveId('');
            }
            refresh();
        }
    };

    const formatDate = (iso: string) => {
        if (!iso) return '';
        const d = new Date(iso);
        const now = new Date();
        const diffMs = now.getTime() - d.getTime();
        const diffHrs = diffMs / (1000 * 60 * 60);
        if (diffHrs < 1) return `${Math.round(diffMs / 60000)}m ago`;
        if (diffHrs < 24) return `${Math.round(diffHrs)}h ago`;
        if (diffHrs < 168) return `${Math.round(diffHrs / 24)}d ago`;
        return d.toLocaleDateString();
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ padding: '8px 12px', borderBottom: '1px solid #333' }}>
                <button
                    onClick={handleNew}
                    style={{
                        width: '100%',
                        padding: '6px 12px',
                        background: '#0e639c',
                        color: 'white',
                        border: 'none',
                        borderRadius: 4,
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 600,
                        letterSpacing: 0.5,
                    }}
                >
                    + NEW CHAT
                </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
                {sessions.length === 0 && (
                    <div style={{ padding: 20, textAlign: 'center', opacity: 0.4, fontSize: 12 }}>
                        No sessions yet
                    </div>
                )}
                {sessions.map(s => (
                    <div
                        key={s.id}
                        onClick={() => handleLoad(s.id)}
                        style={{
                            padding: '8px 12px',
                            cursor: 'pointer',
                            background: activeId === s.id ? 'rgba(14,99,156,0.3)' : 'transparent',
                            borderLeft: activeId === s.id ? '2px solid #0e639c' : '2px solid transparent',
                            transition: 'background 0.15s',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                        }}
                        onMouseEnter={e => { if (activeId !== s.id) (e.currentTarget.style.background = 'rgba(255,255,255,0.04)'); }}
                        onMouseLeave={e => { if (activeId !== s.id) (e.currentTarget.style.background = 'transparent'); }}
                    >
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                                fontSize: 12,
                                color: activeId === s.id ? '#fff' : '#ccc',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                            }}>
                                {s.title}
                            </div>
                            <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>
                                {s.parentId && <span title={`Branched from session ${s.parentId.slice(0, 8)}`} style={{ marginRight: 4 }}>⑂</span>}
                                {s.messageCount} msgs · {formatDate(s.createdAt)}
                            </div>
                        </div>
                        <span
                            onClick={(e) => handleDelete(e, s.id)}
                            style={{
                                opacity: 0.3,
                                cursor: 'pointer',
                                fontSize: 14,
                                flexShrink: 0,
                                padding: '0 2px',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.opacity = '0.8')}
                            onMouseLeave={e => (e.currentTarget.style.opacity = '0.3')}
                            title="Delete session"
                        >
                            ×
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
};
