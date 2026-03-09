/**
 * MemoryViewer Sidebar Panel
 *
 * An interactive explorer for TALA's short-term associative memory bank.
 * 
 * **Capabilities:**
 * - **CRUD**: Allows manual entry, editing, and deletion of atomic memory items (facts, preferences).
 * - **Search**: Filters memory nodes by textual content for rapid recall assessment.
 * - **Maintenance**: Provides "Prune" operations for aging out stale context and "Scan" for directory ingestion.
 * 
 * **Integration:**
 * - Synchronizes with the `mem0-core` service via IPC (`getAllMemoryItems`, `addMemoryItem`, etc.).
 */
import React, { useState, useEffect } from 'react';

interface MemoryItem {
    id: string;
    text: string;
    timestamp?: number;
}

export const MemoryViewer: React.FC = () => {
    const [memories, setMemories] = useState<MemoryItem[]>([]);
    const [filter, setFilter] = useState('');
    const [isAdding, setIsAdding] = useState(false);
    const [newText, setNewText] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editText, setEditText] = useState('');
    const api = (window as any).tala;

    const refresh = async () => {
        if (api?.getAllMemoryItems) {
            try {
                const items = await api.getAllMemoryItems();
                setMemories(items || []);
            } catch (e) {
                console.error("Failed to load memories", e);
            }
        }
    };

    useEffect(() => { refresh(); }, []);

    const handleAdd = async () => {
        if (!newText.trim()) return;
        if (api?.addMemoryItem) {
            await api.addMemoryItem(newText.trim());
            setNewText('');
            setIsAdding(false);
            refresh();
        }
    };

    const handleDelete = async (id: string) => {
        if (confirm('Delete this memory?') && api?.deleteMemoryItem) {
            await api.deleteMemoryItem(id);
            refresh();
        }
    };

    const startEdit = (m: MemoryItem) => {
        setEditingId(m.id);
        setEditText(m.text);
    };

    const saveEdit = async () => {
        if (!editingId || !editText.trim()) return;
        if (api?.updateMemoryItem) {
            await api.updateMemoryItem(editingId, editText.trim());
            setEditingId(null);
            refresh();
        }
    };

    const filtered = memories.filter(m =>
        (m.text || '').toLowerCase().includes(filter.toLowerCase())
    );

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Header / Search */}
            <div style={{ padding: '8px 12px', borderBottom: '1px solid #333', display: 'flex', gap: 8 }}>
                <input
                    type="text"
                    placeholder="Search memories..."
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    style={{
                        flex: 1,
                        background: '#252526',
                        border: '1px solid #3c3c3c',
                        color: 'white',
                        padding: '4px 8px',
                        borderRadius: 2,
                        outline: 'none',
                        fontSize: 12
                    }}
                />
                <button
                    onClick={() => setIsAdding(!isAdding)}
                    style={{
                        background: isAdding ? '#444' : '#0e639c',
                        color: 'white',
                        border: 'none',
                        borderRadius: 2,
                        width: 24,
                        cursor: 'pointer',
                        fontSize: 16,
                        lineHeight: 1,
                        display: 'flex', alignItems: 'center', justifyContent: 'center'
                    }}
                    title="Add Memory"
                >
                    {isAdding ? '×' : '+'}
                </button>
                <div style={{ marginLeft: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                        onClick={async () => {
                            if (api?.scanAndIngest) {
                                try {
                                    const res = await api.scanAndIngest();
                                    alert(`Inbox Scan Complete.\nMoved & Indexed: ${res.ingested}\nErrors: ${res.errors}`);
                                } catch (e: any) {
                                    alert(`Scan failed: ${e.message}`);
                                }
                            }
                        }}
                        title="Scan 'memory/' inbox and move to 'processed/'"
                        style={{
                            background: 'transparent',
                            border: '1px solid #444',
                            color: '#888',
                            borderRadius: 3,
                            cursor: 'pointer',
                            fontSize: 10,
                            padding: '2px 5px'
                        }}
                    >Scan Inbox</button>
                    <button
                        onClick={async () => {
                            if (confirm("Prune memories older than 30 days?") && api?.pruneMemory) {
                                const count = await api.pruneMemory(30, 1000);
                                alert(`Pruned ${count} memories.`);
                                refresh();
                            }
                        }}
                        title="Prune Old (30d+)"
                        style={{
                            background: 'transparent',
                            border: '1px solid #444',
                            color: '#888',
                            borderRadius: 3,
                            cursor: 'pointer',
                            fontSize: 10,
                            padding: '2px 5px'
                        }}
                    >Prune</button>
                </div>
            </div>

            {/* Add New Input */}
            {isAdding && (
                <div style={{ padding: 12, background: '#252526', borderBottom: '1px solid #333' }}>
                    <textarea
                        value={newText}
                        onChange={e => setNewText(e.target.value)}
                        placeholder="Enter new fact or preference..."
                        rows={3}
                        style={{
                            width: '100%',
                            background: '#1e1e1e',
                            border: '1px solid #3c3c3c',
                            color: 'white',
                            padding: 8,
                            borderRadius: 2,
                            marginBottom: 8,
                            resize: 'vertical',
                            fontSize: 12,
                            fontFamily: 'inherit'
                        }}
                        onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleAdd(); }}
                    />
                    <button
                        onClick={handleAdd}
                        style={{ width: '100%', padding: '4px', background: '#0e639c', color: 'white', border: 'none', cursor: 'pointer' }}
                    >
                        Save Memory
                    </button>
                </div>
            )}

            {/* List */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
                {filtered.length === 0 && (
                    <div style={{ padding: 20, textAlign: 'center', color: '#666', fontSize: 12 }}>
                        No memories found.
                    </div>
                )}
                {filtered.map(m => (
                    <div key={m.id} style={{
                        background: '#252526',
                        marginBottom: 8,
                        borderRadius: 4,
                        padding: 8,
                        border: '1px solid #333',
                        fontSize: 12,
                        position: 'relative'
                    }}>
                        {editingId === m.id ? (
                            <div>
                                <textarea
                                    value={editText}
                                    onChange={e => setEditText(e.target.value)}
                                    rows={3}
                                    style={{ width: '100%', background: '#1e1e1e', color: 'white', border: '1px solid #3c3c3c', padding: 4, marginBottom: 4 }}
                                />
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button onClick={saveEdit} style={{ flex: 1, background: '#0e639c', border: 'none', color: 'white', cursor: 'pointer', padding: 2 }}>Save</button>
                                    <button onClick={() => setEditingId(null)} style={{ flex: 1, background: '#444', border: 'none', color: 'white', cursor: 'pointer', padding: 2 }}>Cancel</button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <div style={{ paddingRight: 20, whiteSpace: 'pre-wrap', color: '#ddd' }}>{m.text}</div>
                                <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', color: '#666', fontSize: 10 }}>
                                    <span>{m.timestamp ? new Date(m.timestamp).toLocaleDateString() : ''}</span>
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <span onClick={() => startEdit(m)} style={{ cursor: 'pointer', opacity: 0.7 }} className="hover-white">Edit</span>
                                        <span onClick={() => handleDelete(m.id)} style={{ cursor: 'pointer', opacity: 0.7, color: '#f66' }} className="hover-red">Delete</span>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
};
