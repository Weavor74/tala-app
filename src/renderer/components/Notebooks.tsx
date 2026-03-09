/**
 * Notebooks (Research Workspace)
 * 
 * A specialized interface for organizing high-density information into "Notebooks".
 * Modeled after advanced research tools (like NotebookLM), it allows source grouping.
 * 
 * **Workspace Modes:**
 * - **Notebook View**: Manage the active curated sources (files, URLs) for a specific project.
 * - **Search & Add**: Integrated discovery layer for finding new content to pull into a notebook.
 * - **Global Library**: Quick access to the workspace's entire document repository.
 * 
 * **Agent Interaction:**
 * - **Context Sync**: `UPDATE AGENT CONTEXT` sends selected sources to TALA's RAG system.
 * - **Synthesis**: "GENERATE SUMMARY" triggers a chain-of-thought analysis over the selected notebook data.
 */
import React, { useState, useEffect } from 'react';
import { Search } from './Search';
import { Library } from './Library';

interface Notebook {
    id: string;
    name: string;
    description?: string;
    sourcePaths: string[];
    createdAt: number;
}

export const Notebooks: React.FC<{ onOpenFile?: (path: string) => void }> = ({ onOpenFile }) => {
    const [notebooks, setNotebooks] = useState<Notebook[]>([]);
    const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
    const [activeSources, setActiveSources] = useState<Set<string>>(new Set());
    const [mode, setMode] = useState<'notebook' | 'search' | 'library'>('notebook');

    const api = (window as any).tala;

    const loadData = async () => {
        if (api && api.getSettings) {
            const settings = await api.getSettings();
            setNotebooks(settings.notebooks || []);
        }
    };

    useEffect(() => { loadData(); }, []);

    const selectedNotebook = notebooks.find(n => n.id === selectedNotebookId);

    const handleCreateNotebook = async () => {
        const name = prompt("Enter Notebook Name:");
        if (!name) return;

        const newNotebook: Notebook = {
            id: `nb-${Math.random().toString(36).substr(2, 9)}`,
            name,
            sourcePaths: [],
            createdAt: Date.now()
        };

        const settings = await api.getSettings();
        const updated = [...(settings.notebooks || []), newNotebook];
        await api.saveSettings({ ...settings, notebooks: updated });
        setNotebooks(updated);
        setSelectedNotebookId(newNotebook.id);
    };

    const handleDeleteNotebook = async (id: string) => {
        if (!confirm("Delete this notebook? Sources will remain in library but the grouping will be lost.")) return;
        const settings = await api.getSettings();
        const updated = (settings.notebooks || []).filter((n: any) => n.id !== id);
        await api.saveSettings({ ...settings, notebooks: updated });
        setNotebooks(updated);
        if (selectedNotebookId === id) setSelectedNotebookId(null);
    };

    const toggleSource = (path: string) => {
        setActiveSources(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    return (
        <div style={{ display: 'flex', height: '100%', color: '#ccc', background: '#1e1e1e' }}>
            {/* Sidebar: Notebook List */}
            <div style={{ width: 220, borderRight: '1px solid #333', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: 15, borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 'bold', fontSize: 11, color: '#9cdcfe' }}>RESEARCH</span>
                    <button onClick={handleCreateNotebook} style={{ background: '#333', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 16 }} title="New Notebook">+</button>
                </div>
                <div
                    onClick={() => { setMode('search'); setSelectedNotebookId(null); }}
                    style={{
                        padding: '10px 15px',
                        cursor: 'pointer',
                        background: mode === 'search' ? '#0e639c' : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        fontWeight: mode === 'search' ? 'bold' : 'normal',
                        color: mode === 'search' ? '#fff' : '#ccc'
                    }}
                >
                    <span style={{ fontSize: 14 }}>🔍</span>
                    <span style={{ fontSize: 12 }}>Search & Add</span>
                </div>
                <div
                    onClick={() => { setMode('library'); setSelectedNotebookId(null); }}
                    style={{
                        padding: '10px 15px',
                        cursor: 'pointer',
                        borderBottom: '1px solid #252526',
                        background: mode === 'library' ? '#0e639c' : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        fontWeight: mode === 'library' ? 'bold' : 'normal',
                        color: mode === 'library' ? '#fff' : '#ccc'
                    }}
                >
                    <span style={{ fontSize: 14 }}>📚</span>
                    <span style={{ fontSize: 12 }}>Global Library</span>
                </div>
                <div style={{ padding: '10px 15px', fontSize: 10, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 1, marginTop: 10 }}>My Notebooks</div>
                <div style={{ flex: 1, overflowY: 'auto' }}>
                    {notebooks.length === 0 && (
                        <div style={{ padding: 20, textAlign: 'center', opacity: 0.5, fontSize: 11 }}>No notebooks yet.</div>
                    )}
                    {notebooks.map(nb => (
                        <div
                            key={nb.id}
                            onClick={() => { setSelectedNotebookId(nb.id); setMode('notebook'); }}
                            style={{
                                padding: '10px 15px',
                                cursor: 'pointer',
                                borderBottom: '1px solid #252526',
                                background: selectedNotebookId === nb.id ? '#2d2d2d' : 'transparent',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center'
                            }}
                        >
                            <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 12, fontWeight: selectedNotebookId === nb.id ? 'bold' : 'normal', color: selectedNotebookId === nb.id ? '#fff' : '#ccc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {nb.name}
                                </div>
                                <div style={{ fontSize: 10, opacity: 0.5 }}>{nb.sourcePaths.length} sources</div>
                            </div>
                            <button
                                onClick={(e) => { e.stopPropagation(); handleDeleteNotebook(nb.id); }}
                                style={{ background: 'transparent', border: 'none', color: '#555', cursor: 'pointer', fontSize: 12 }}
                            >×</button>
                        </div>
                    ))}
                </div>
            </div>

            {/* Main Content */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                {mode === 'search' ? (
                    <Search
                        onOpenFile={onOpenFile}
                        initialNotebookId={selectedNotebookId}
                        onAdd={() => {
                            loadData();
                            // Optionally switch back to notebook? For now stay in search so they can add more.
                        }}
                    />
                ) : mode === 'library' ? (
                    <Library onOpenFile={onOpenFile} />
                ) : !selectedNotebook ? (
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.3, flexDirection: 'column' }}>
                        <span style={{ fontSize: 48 }}>📚</span>
                        <h3>Select or Create a Notebook</h3>
                        <button
                            onClick={() => setMode('search')}
                            style={{ marginTop: 20, background: '#0e639c', color: 'white', border: 'none', padding: '8px 20px', borderRadius: 4, cursor: 'pointer' }}
                        >
                            Start Searching
                        </button>
                    </div>
                ) : (
                    <>
                        <div style={{ padding: 20, borderBottom: '1px solid #333' }}>
                            <h2 style={{ margin: 0, color: '#dcdcaa' }}>{selectedNotebook.name}</h2>
                            <p style={{ margin: '5px 0 0 0', fontSize: 12, opacity: 0.6 }}>Sources in this notebook are available for Tala to ground response.</p>
                        </div>

                        <div style={{ flex: 1, padding: 20, overflowY: 'auto' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 15 }}>
                                <span style={{ fontWeight: 'bold', fontSize: 11, color: '#888' }}>SOURCES</span>
                                <div style={{ display: 'flex', gap: 10 }}>
                                    <button
                                        onClick={async () => {
                                            if (activeSources.size === 0) {
                                                alert("Select at least one source to summarize.");
                                                return;
                                            }
                                            const paths = Array.from(activeSources).map(p => p.split('\\').pop()).join(', ');
                                            const query = `Please provide a comprehensive summary and "Notebook Guide" based on the selected sources: ${paths}. What are the key themes and insights?`;
                                            api.send('chat-message', { text: query });
                                            alert("Summary request sent to Tala.");
                                        }}
                                        style={{ background: '#3e3e42', border: '1px solid #444', color: '#fff', padding: '4px 10px', borderRadius: 2, fontSize: 10, cursor: 'pointer' }}
                                    >
                                        GENERATE SUMMARY
                                    </button>
                                    <button
                                        onClick={() => alert("Ask Tala to search and 'Add to Notebook'")}
                                        style={{ background: '#0e639c', border: 'none', color: 'white', padding: '4px 10px', borderRadius: 2, fontSize: 10, cursor: 'pointer' }}
                                    >
                                        + ADD SOURCE
                                    </button>
                                </div>
                            </div>

                            {selectedNotebook.sourcePaths.length === 0 ? (
                                <div style={{ padding: 40, textAlign: 'center', background: '#252526', borderRadius: 8, border: '1px dashed #444' }}>
                                    <div style={{ fontSize: 24, marginBottom: 10 }}>🔎</div>
                                    <div style={{ fontSize: 13, color: '#888' }}>No sources in this notebook.</div>
                                    <p style={{ fontSize: 11, opacity: 0.5 }}>Search the web or local files and select "Add to Notebook".</p>
                                </div>
                            ) : (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 15 }}>
                                    {selectedNotebook.sourcePaths.map(path => {
                                        const name = path.split('/').pop() || path;
                                        const isActive = activeSources.has(path);
                                        return (
                                            <div
                                                key={path}
                                                style={{
                                                    background: '#252526',
                                                    border: '1px solid',
                                                    borderColor: isActive ? '#007acc' : '#333',
                                                    borderRadius: 6,
                                                    padding: 12,
                                                    display: 'flex',
                                                    gap: 10,
                                                    position: 'relative',
                                                    transition: '0.2s all',
                                                    cursor: 'pointer'
                                                }}
                                                onClick={() => toggleSource(path)}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={isActive}
                                                    readOnly
                                                    style={{ cursor: 'pointer' }}
                                                />
                                                <div style={{ minWidth: 0, flex: 1 }}>
                                                    <div
                                                        style={{ fontSize: 12, fontWeight: 'bold', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                                        onClick={(e) => { e.stopPropagation(); onOpenFile?.(path); }}
                                                        title="Click to view full content"
                                                    >
                                                        {name}
                                                    </div>
                                                    <div style={{ fontSize: 9, opacity: 0.5, marginTop: 4 }}>Type: Document</div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* Action Bar */}
                        <div style={{ padding: '15px 20px', borderTop: '1px solid #333', display: 'flex', gap: 10, alignItems: 'center' }}>
                            <div style={{ flex: 1 }}>
                                <span style={{ fontSize: 11, opacity: 0.7 }}>Active Context: </span>
                                <span style={{ fontSize: 11, fontWeight: 'bold', color: '#007acc' }}>{activeSources.size} Sources Selected</span>
                            </div>
                            <button
                                onClick={() => {
                                    if (api?.setActiveNotebookContext) {
                                        api.setActiveNotebookContext(selectedNotebookId, Array.from(activeSources));
                                        alert("Context synchronized with Tala.");
                                    }
                                }}
                                style={{ background: '#1a8c3e', border: 'none', color: 'white', padding: '6px 15px', borderRadius: 4, fontSize: 12, cursor: 'pointer', fontWeight: 'bold' }}
                            >
                                UPDATE AGENT CONTEXT
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
