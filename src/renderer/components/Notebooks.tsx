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
 * - **Ingest Selected** (placeholder): Future `ingestItems(itemKeys)` call to create source_documents
 *   and document_chunks from selected notebook_items. Ingestion is always an explicit step — never
 *   triggered automatically when items are saved.
 * 
 * **Curated Research Architecture:**
 * - search results = candidate discovery items (found in Search & Add)
 * - notebook_items = curated saved references (the curation gate)
 * - ingestion = explicit later step (source_documents / document_chunks)
 * 
 * Notebooks are persisted in PostgreSQL via the research:* IPC handlers.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Search } from './Search';
import { Library } from './Library';

interface Notebook {
    id: string;
    name: string;
    description?: string | null;
    created_at: string;
    updated_at: string;
    is_dynamic: boolean;
}

interface NotebookItem {
    id: string;
    notebook_id: string;
    item_key: string;
    item_type: string;
    source_path: string | null;
    title: string | null;
    uri: string | null;
    snippet: string | null;
    added_at: string;
}

export const Notebooks: React.FC<{ onOpenFile?: (path: string) => void }> = ({ onOpenFile }) => {
    const [notebooks, setNotebooks] = useState<Notebook[]>([]);
    const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
    const [notebookItems, setNotebookItems] = useState<NotebookItem[]>([]);
    const [activeSources, setActiveSources] = useState<Set<string>>(new Set());
    const [mode, setMode] = useState<'notebook' | 'search' | 'library'>('notebook');
    const [dbAvailable, setDbAvailable] = useState(true);

    const api = (window as any).tala;

    const loadNotebooks = useCallback(async () => {
        if (api?.researchListNotebooks) {
            const res = await api.researchListNotebooks();
            if (res?.ok) {
                setNotebooks(res.notebooks || []);
                setDbAvailable(true);
            } else {
                // DB not available — fall back to settings-based notebooks
                setDbAvailable(false);
                if (api.getSettings) {
                    const settings = await api.getSettings();
                    const legacy = (settings.notebooks || []).map((n: any) => ({
                        id: n.id,
                        name: n.name,
                        description: n.description ?? null,
                        created_at: new Date(n.createdAt || Date.now()).toISOString(),
                        updated_at: new Date(n.createdAt || Date.now()).toISOString(),
                        is_dynamic: false,
                    }));
                    setNotebooks(legacy);
                }
            }
        }
    }, [api]);

    const loadNotebookItems = useCallback(async (notebookId: string) => {
        if (!dbAvailable || !api?.researchListNotebookItems) {
            setNotebookItems([]);
            return;
        }
        const res = await api.researchListNotebookItems(notebookId);
        if (res?.ok) {
            setNotebookItems(res.items || []);
        }
    }, [api, dbAvailable]);

    useEffect(() => { loadNotebooks(); }, [loadNotebooks]);

    useEffect(() => {
        if (selectedNotebookId) {
            loadNotebookItems(selectedNotebookId);
        } else {
            setNotebookItems([]);
        }
    }, [selectedNotebookId, loadNotebookItems]);

    const selectedNotebook = notebooks.find(n => n.id === selectedNotebookId);

    const handleCreateNotebook = async () => {
        const name = prompt("Enter Notebook Name:");
        if (!name) return;

        if (dbAvailable && api?.researchCreateNotebook) {
            const res = await api.researchCreateNotebook({ name });
            if (res?.ok && res.notebook) {
                await loadNotebooks();
                setSelectedNotebookId(res.notebook.id);
                setMode('notebook');
                return;
            }
        }

        // Fallback: settings-based
        const newNotebook = {
            id: `nb-${Math.random().toString(36).substring(2, 11)}`,
            name,
            sourcePaths: [],
            createdAt: Date.now()
        };
        const settings = await api.getSettings();
        const updated = [...(settings.notebooks || []), newNotebook];
        await api.saveSettings({ ...settings, notebooks: updated });
        await loadNotebooks();
        setSelectedNotebookId(newNotebook.id);
    };

    const handleDeleteNotebook = async (id: string) => {
        if (!confirm("Delete this notebook? Items will be removed but sources remain in the library.")) return;

        if (dbAvailable && api?.researchDeleteNotebook) {
            const res = await api.researchDeleteNotebook(id);
            if (res?.ok) {
                await loadNotebooks();
                if (selectedNotebookId === id) setSelectedNotebookId(null);
                return;
            }
        }

        // Fallback: settings-based
        const settings = await api.getSettings();
        const updated = (settings.notebooks || []).filter((n: any) => n.id !== id);
        await api.saveSettings({ ...settings, notebooks: updated });
        await loadNotebooks();
        if (selectedNotebookId === id) setSelectedNotebookId(null);
    };

    const handleRemoveItem = async (itemKey: string) => {
        if (!selectedNotebookId || !dbAvailable || !api?.researchRemoveNotebookItem) return;
        await api.researchRemoveNotebookItem(selectedNotebookId, itemKey);
        setActiveSources(prev => { const n = new Set(prev); n.delete(itemKey); return n; });
        await loadNotebookItems(selectedNotebookId);
    };

    /**
     * Remove all selected (activeSources) notebook items from the notebook.
     * Optionally also removes scraped/ingested local content from the RAG store
     * for items that have a source_path.
     */
    const handleRemoveSelected = async () => {
        if (activeSources.size === 0 || !selectedNotebookId) return;

        const keys = Array.from(activeSources);
        const itemsToRemove = notebookItems.filter(i => activeSources.has(i.item_key));
        const scrapedPaths = itemsToRemove
            .map(i => i.source_path)
            .filter((p): p is string => !!p);

        // Determine whether to also delete ingested content from RAG store
        const alsoDeleteIngested =
            scrapedPaths.length > 0 &&
            confirm(
                `Remove ${keys.length} item(s) from this notebook?\n\n` +
                `${scrapedPaths.length} item(s) also have downloaded content.\n` +
                `Click OK to also remove that content from the RAG index.\n` +
                `Click Cancel to remove from notebook only.`
            );

        // Remove from notebook
        if (dbAvailable && api?.researchRemoveNotebookItems) {
            await api.researchRemoveNotebookItems(selectedNotebookId, keys);
        } else {
            // Fallback: single-item loop
            for (const key of keys) {
                if (api?.researchRemoveNotebookItem) {
                    await api.researchRemoveNotebookItem(selectedNotebookId, key);
                }
            }
        }

        // Optionally remove ingested content from RAG store
        if (alsoDeleteIngested && api?.deleteMemory) {
            const ragFailures: string[] = [];
            for (const path of scrapedPaths) {
                try { await api.deleteMemory(path); } catch {
                    ragFailures.push(path);
                }
            }
            if (ragFailures.length > 0) {
                alert(`Removed from notebook, but failed to delete RAG content for ${ragFailures.length} file(s):\n${ragFailures.join('\n')}`);
            }
        }

        setActiveSources(new Set());
        await loadNotebookItems(selectedNotebookId);
    };

    const toggleSource = (key: string) => {
        setActiveSources(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
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
                                <div style={{ fontSize: 10, opacity: 0.5 }}>
                                    {selectedNotebookId === nb.id ? `${notebookItems.length} items` : 'notebook'}
                                </div>
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
                            loadNotebooks();
                            if (selectedNotebookId) loadNotebookItems(selectedNotebookId);
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
                            {selectedNotebook.description && (
                                <p style={{ margin: '4px 0 0 0', fontSize: 12, opacity: 0.6 }}>{selectedNotebook.description}</p>
                            )}
                            <p style={{ margin: '5px 0 0 0', fontSize: 12, opacity: 0.6 }}>Sources in this notebook are available for Tala to ground response.</p>
                        </div>

                        <div style={{ flex: 1, padding: 20, overflowY: 'auto' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 15 }}>
                                <span style={{ fontWeight: 'bold', fontSize: 11, color: '#888' }}>ITEMS ({notebookItems.length})</span>
                                <div style={{ display: 'flex', gap: 10 }}>
                                    {activeSources.size > 0 && (
                                        <button
                                            onClick={handleRemoveSelected}
                                            style={{ background: '#5a1a1a', border: '1px solid #8b2020', color: '#ff8080', padding: '4px 10px', borderRadius: 2, fontSize: 10, cursor: 'pointer' }}
                                            title={`Remove ${activeSources.size} selected item(s) from notebook`}
                                        >
                                            REMOVE SELECTED ({activeSources.size})
                                        </button>
                                    )}
                                    <button
                                        onClick={async () => {
                                            if (activeSources.size === 0) {
                                                alert("Select at least one item to summarize.");
                                                return;
                                            }
                                            const titles = notebookItems
                                                .filter(i => activeSources.has(i.item_key))
                                                .map(i => i.title || i.uri || i.source_path || i.item_key)
                                                .join(', ');
                                            const query = `Please provide a comprehensive summary and "Notebook Guide" based on the selected sources: ${titles}. What are the key themes and insights?`;
                                            api.send('chat-message', { text: query });
                                            alert("Summary request sent to Tala.");
                                        }}
                                        style={{ background: '#3e3e42', border: '1px solid #444', color: '#fff', padding: '4px 10px', borderRadius: 2, fontSize: 10, cursor: 'pointer' }}
                                    >
                                        GENERATE SUMMARY
                                    </button>
                                    <button
                                        onClick={() => setMode('search')}
                                        style={{ background: '#0e639c', border: 'none', color: 'white', padding: '4px 10px', borderRadius: 2, fontSize: 10, cursor: 'pointer' }}
                                    >
                                        + ADD SOURCE
                                    </button>
                                </div>
                            </div>

                            {notebookItems.length === 0 ? (
                                <div style={{ padding: 40, textAlign: 'center', background: '#252526', borderRadius: 8, border: '1px dashed #444' }}>
                                    <div style={{ fontSize: 24, marginBottom: 10 }}>🔎</div>
                                    <div style={{ fontSize: 13, color: '#888' }}>No items in this notebook.</div>
                                    <p style={{ fontSize: 11, opacity: 0.5 }}>Search the web or local files and select "Add to Notebook".</p>
                                </div>
                            ) : (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 15 }}>
                                    {notebookItems.map(item => {
                                        const label = item.title || item.uri || item.source_path || item.item_key;
                                        const isActive = activeSources.has(item.item_key);
                                        return (
                                            <div
                                                key={item.id}
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
                                                onClick={() => toggleSource(item.item_key)}
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
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            if (item.source_path) onOpenFile?.(item.source_path);
                                                            else if (item.uri) window.open(item.uri, '_blank');
                                                        }}
                                                        title={label}
                                                    >
                                                        {label}
                                                    </div>
                                                    <div style={{ fontSize: 9, opacity: 0.5, marginTop: 4 }}>{item.item_type}</div>
                                                    {item.snippet && (
                                                        <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                                                            {item.snippet}
                                                        </div>
                                                    )}
                                                </div>
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); handleRemoveItem(item.item_key); }}
                                                    style={{ position: 'absolute', top: 4, right: 4, background: 'transparent', border: 'none', color: '#555', cursor: 'pointer', fontSize: 12 }}
                                                    title="Remove from notebook"
                                                >×</button>
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
                                <span style={{ fontSize: 11, fontWeight: 'bold', color: '#007acc' }}>{activeSources.size} Items Selected</span>
                            </div>
                            {/* INGEST SELECTED placeholder — future selective ingestion via ingestItems(itemKeys).
                                When implemented, will create source_documents and document_chunks from
                                selected notebook_items. Notebook membership is the curation gate;
                                ingestion is a separate explicit step. */}
                            <button
                                disabled
                                title="Selective ingestion coming soon — will call ingestItems(itemKeys) for selected items"
                                style={{ background: '#333', border: '1px solid #444', color: '#666', padding: '6px 15px', borderRadius: 4, fontSize: 12, cursor: 'not-allowed' }}
                            >
                                INGEST SELECTED
                            </button>
                            {/* Ingest Notebook — explicit ingestion of all notebook items into source_documents. */}
                            <button
                                onClick={async () => {
                                    if (!dbAvailable || !api?.ingestNotebook) {
                                        alert('Ingestion requires a database connection.');
                                        return;
                                    }
                                    if (!confirm(`Ingest all items in this notebook into the content store?\nThis fetches full content and creates document chunks for retrieval.`)) return;
                                    const res = await api.ingestNotebook(selectedNotebookId);
                                    if (res?.ok) {
                                        const r = res.result;
                                        const msg = [
                                            `Ingestion complete.`,
                                            `Documents created: ${r.documentsCreated}`,
                                            `Documents skipped (unchanged): ${r.documentsSkipped}`,
                                            `Chunks created: ${r.chunksCreated}`,
                                            r.warnings?.length ? `Warnings:\n${r.warnings.join('\n')}` : '',
                                        ].filter(Boolean).join('\n');
                                        alert(msg);
                                    } else {
                                        alert(`Ingestion failed: ${res?.error ?? 'Unknown error'}`);
                                    }
                                }}
                                title="Fetch full content for all notebook items and store as document chunks"
                                style={{ background: '#1a4d8c', border: 'none', color: 'white', padding: '6px 15px', borderRadius: 4, fontSize: 12, cursor: 'pointer', fontWeight: 'bold' }}
                            >
                                INGEST NOTEBOOK
                            </button>
                            <button
                                onClick={async () => {
                                    if (api?.setActiveNotebookContext) {
                                        const scope = dbAvailable && api.researchResolveNotebookScope
                                            ? await api.researchResolveNotebookScope(selectedNotebookId)
                                            : null;
                                        const sourcePaths = scope?.ok
                                            ? scope.scope.sourcePaths
                                            : Array.from(activeSources);
                                        api.setActiveNotebookContext(selectedNotebookId, sourcePaths);
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
