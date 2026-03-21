/**
 * Search Component (Unified Local + Web Search)
 *
 * Provides a search panel with two modes:
 * - **Local Search:** Searches workspace files by name/content via the
 *   RetrievalOrchestrator (LocalSearchProvider, providerId='local').
 * - **Web Search:** Queries configured external providers via
 *   RetrievalOrchestrator (ExternalApiSearchProvider) or falls back to the
 *   legacy DuckDuckGo Lite IPC path when no external provider is configured.
 *
 * All searches flow through RetrievalOrchestrator so both local and external
 * providers are normalized into the same result shape. Legacy `searchFiles`
 * and `searchRemote` IPC calls are kept as fallback paths for backward
 * compatibility when the orchestrator is unavailable.
 *
 * Each search creates a `search_run` record in PostgreSQL, and results are
 * registered in `search_run_results`. From there users can save results into
 * a Notebook (persisted in `notebook_items`).
 *
 * Results display with clickable titles that either open local files
 * or launch URLs in the embedded browser.
 */
import React, { useState } from 'react';

/**
 * A unified search result — either a local file match or a web search result.
 * Local results have `path` and `content`; web results have `title`, `snippet`, and `url`.
 * All results may also carry `providerId` and `sourceType` for provenance display.
 */
interface Result {
    path?: string;
    content?: string;
    title?: string;
    snippet?: string;
    url?: string;
    /** ID of the retrieval provider that produced this result (e.g., 'local', 'external:brave'). */
    providerId?: string;
    /** Source category from the provider (e.g., 'local_file', 'web'). */
    sourceType?: string;
}

/** Props for the Search component. */
interface SearchProps {
    /** Callback to open a local file in the editor panel. */
    onOpenFile?: (path: string) => void;
    /** ID of the notebook to pre-select. */
    initialNotebookId?: string | null;
    /** Callback when a source is successfully added to a notebook. */
    onAdd?: () => void;
}

// ─── Legacy search fallback ───────────────────────────────────────────────────

/**
 * Fallback search when RetrievalOrchestrator IPC is unavailable.
 * Uses the original searchFiles / searchRemote IPC paths.
 * Kept for backward compatibility during the transition period.
 */
async function _legacySearch(api: any, query: string, mode: 'local' | 'remote'): Promise<Result[]> {
    if (mode === 'local') {
        return (await api.searchFiles?.(query)) || [];
    }
    return (await api.searchRemote?.(query)) || [];
}

/**
 * Search panel with local/web toggle, query input, result list,
 * and bulk-scrape capability for web results.
 */
export const Search: React.FC<SearchProps> = ({ onOpenFile, initialNotebookId, onAdd }) => {
    const [query, setQuery] = useState('');
    const [mode, setMode] = useState<'local' | 'remote'>('remote'); // Default to remote as per user request context
    const [results, setResults] = useState<Result[]>([]);
    const [loading, setLoading] = useState(false);
    const [scraping, setScraping] = useState<string | null>(null);
    const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
    const [notebooks, setNotebooks] = useState<any[]>([]);
    const [selectedNotebookId, setSelectedNotebookId] = useState<string>(initialNotebookId || '');
    /** The search_run id from the most recent search, used to register notebook items. */
    const [currentSearchRunId, setCurrentSearchRunId] = useState<string | null>(null);

    const api = (window as any).tala;


    const handleBulkAdd = async () => {
        if (selectedUrls.size === 0 || !selectedNotebookId) return;
        setLoading(true);

        const urls = Array.from(selectedUrls);
        let successCount = 0;
        let failCount = 0;

        // 1. Determine target notebook id (may need to create one)
        let targetId = selectedNotebookId;
        if (selectedNotebookId === 'CREATE_NEW_NB') {
            const name = prompt("Enter New Notebook Name:");
            if (!name) {
                setScraping(null);
                setLoading(false);
                return;
            }
            // Try PostgreSQL-backed creation first
            if (api?.researchCreateNotebook) {
                const res = await api.researchCreateNotebook({ name });
                if (res?.ok && res.notebook) {
                    targetId = res.notebook.id;
                }
            }
            if (targetId === 'CREATE_NEW_NB') {
                // Fallback: settings-based
                const settings = await api.getSettings();
                const newNb = {
                    id: `nb-${Math.random().toString(36).substring(2, 11)}`,
                    name,
                    sourcePaths: [],
                    createdAt: Date.now()
                };
                const nbs = [...(settings.notebooks || []), newNb];
                await api.saveSettings({ ...settings, notebooks: nbs });
                targetId = newNb.id;
            }
        }

        // 2. Ingest files and collect notebook items
        const notebookItems: Array<{
            item_key: string; item_type: string;
            source_path?: string; title?: string; uri?: string; snippet?: string;
            provider_id?: string;
        }> = [];

        for (const url of urls) {
            const resItem = results.find(r => r.url === url);
            const title = resItem?.title || 'Web Resource';
            setScraping(url);
            try {
                const res = await api.scrapeUrl(url, title);
                if (res.success && res.path) {
                    successCount++;
                    notebookItems.push({
                        item_key: url,
                        item_type: 'web',
                        source_path: res.path,
                        title: resItem?.title ?? url,
                        uri: url,
                        snippet: resItem?.snippet ?? undefined,
                        provider_id: resItem?.providerId ?? undefined,
                    });
                    setSelectedUrls(prev => {
                        const next = new Set(prev);
                        next.delete(url);
                        return next;
                    });
                } else {
                    failCount++;
                }
            } catch (e) {
                failCount++;
            }
        }

        // 3. Persist notebook items to PostgreSQL
        if (notebookItems.length > 0 && api?.researchAddItemsToNotebook) {
            await api.researchAddItemsToNotebook(targetId, notebookItems, currentSearchRunId ?? undefined);
        } else if (notebookItems.length > 0 && api?.getSettings) {
            // Fallback: settings-based
            const settings = await api.getSettings();
            const nbs = [...(settings.notebooks || [])];
            const nbIdx = nbs.findIndex((n: any) => n.id === targetId);
            if (nbIdx >= 0) {
                const paths = notebookItems.map(i => i.source_path).filter(Boolean) as string[];
                nbs[nbIdx].sourcePaths = Array.from(new Set([...(nbs[nbIdx].sourcePaths || []), ...paths]));
                await api.saveSettings({ ...settings, notebooks: nbs });
            }
        }

        setSelectedNotebookId(targetId);
        setScraping(null);
        setLoading(false);
        alert(`Notebook Updated.\nAdded: ${successCount}\nFailed: ${failCount}`);
        if (onAdd) onAdd();
    };

    const loadNotebooks = async () => {
        if (api?.researchListNotebooks) {
            const res = await api.researchListNotebooks();
            if (res?.ok) {
                setNotebooks(res.notebooks || []);
                if (res.notebooks?.length > 0 && !selectedNotebookId) {
                    setSelectedNotebookId(res.notebooks[0].id);
                }
                return;
            }
        }
        // Fallback: settings-based
        if (api?.getSettings) {
            const settings = await api.getSettings();
            setNotebooks(settings.notebooks || []);
            if (settings.notebooks?.length > 0 && !selectedNotebookId) {
                setSelectedNotebookId(settings.notebooks[0].id);
            }
        }
    };

    React.useEffect(() => {
        loadNotebooks();
    }, []);

    const handleSearch = async () => {
        if (!query.trim()) return;
        setLoading(true);
        setSelectedUrls(new Set()); // Clear selection on new search
        setCurrentSearchRunId(null);

        if (!api) return;

        try {
            let fetchedResults: Result[] = [];

            // Attempt retrieval via RetrievalOrchestrator first (canonical path).
            // providerIds: 'local' for Local mode, omit for Web to use all enabled providers.
            if (api.retrievalRetrieve) {
                const providerIds = mode === 'local' ? ['local'] : undefined;
                const retrievalRes = await api.retrievalRetrieve({
                    query: query.trim(),
                    mode: 'keyword',
                    scope: 'global',
                    providerIds,
                });
                if (retrievalRes?.ok && retrievalRes.response?.results) {
                    fetchedResults = (retrievalRes.response.results as Array<{
                        title: string; uri?: string | null; sourcePath?: string | null;
                        snippet?: string | null; providerId: string; sourceType?: string | null;
                    }>).map(r => ({
                        title: r.title,
                        url: r.uri ?? undefined,
                        path: r.sourcePath ?? undefined,
                        snippet: r.snippet ?? undefined,
                        content: r.snippet ?? undefined,
                        providerId: r.providerId,
                        sourceType: r.sourceType ?? undefined,
                    }));
                } else {
                    // Fall through to legacy path if orchestrator returned error
                    fetchedResults = await _legacySearch(api, query, mode);
                }
            } else {
                // Orchestrator not yet exposed — use legacy IPC paths
                fetchedResults = await _legacySearch(api, query, mode);
            }

            setResults(fetchedResults);

            // Register the search run + results in PostgreSQL (best-effort, non-blocking)
            if (api.researchCreateSearchRun && fetchedResults.length > 0) {
                try {
                    const runRes = await api.researchCreateSearchRun({ query_text: query });
                    if (runRes?.ok && runRes.searchRun?.id) {
                        const searchRunId: string = runRes.searchRun.id;
                        setCurrentSearchRunId(searchRunId);

                        const runResults = fetchedResults.map((r, i) => ({
                            item_key: r.url || r.path || `result-${i}`,
                            item_type: r.sourceType ?? (r.providerId === 'local' ? 'local_file' : 'web'),
                            source_path: r.path ?? undefined,
                            title: r.title ?? r.path ?? undefined,
                            uri: r.url ?? undefined,
                            snippet: (r.snippet || r.content)?.slice(0, 500) ?? undefined,
                            provider_id: r.providerId ?? undefined,
                        }));
                        await api.researchAddSearchRunResults(searchRunId, runResults);
                    }
                } catch {
                    // Non-fatal: search still succeeds even if run registration fails
                }
            }
        } catch (e) {
            console.error("Search failed", e);
            setResults([]);
        } finally {
            setLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') handleSearch();
    };

    const toggleSelection = (url: string) => {
        setSelectedUrls(prev => {
            const next = new Set(prev);
            if (next.has(url)) {
                next.delete(url);
            } else {
                next.add(url);
            }
            return next;
        });
    };

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: '#ccc', background: '#1e1e1e' }}>
            <div style={{ padding: '20px', borderBottom: '1px solid #333' }}>
                <div style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
                    <button
                        onClick={() => setMode('remote')}
                        style={{
                            background: mode === 'remote' ? '#0e639c' : '#333',
                            color: 'white',
                            border: 'none',
                            padding: '5px 15px',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '12px',
                            transition: 'background 0.2s',
                            fontWeight: mode === 'remote' ? 'bold' : 'normal'
                        }}
                    >
                        WEB SEARCH
                    </button>
                    <button
                        onClick={() => setMode('local')}
                        style={{
                            background: mode === 'local' ? '#0e639c' : '#333',
                            color: 'white',
                            border: 'none',
                            padding: '5px 15px',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '12px',
                            transition: 'background 0.2s',
                            fontWeight: mode === 'local' ? 'bold' : 'normal'
                        }}
                    >
                        LOCAL FILES
                    </button>
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                    <input
                        type="text"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={mode === 'local' ? "Search workspace..." : "Search the web..."}
                        style={{
                            flex: 1,
                            background: '#2d2d2d',
                            border: '1px solid #444',
                            color: 'white',
                            padding: '8px 12px',
                            borderRadius: '4px',
                            outline: 'none'
                        }}
                    />
                    <button
                        onClick={handleSearch}
                        disabled={loading}
                        style={{
                            background: '#0e639c',
                            color: 'white',
                            border: 'none',
                            padding: '8px 20px',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            opacity: loading ? 0.5 : 1
                        }}
                    >
                        {loading ? '...' : 'SEARCH'}
                    </button>
                </div>

                {/* Bulk Actions Toolbar */}
                {mode === 'remote' && selectedUrls.size > 0 && (
                    <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', background: '#2d2d2d', padding: '5px 10px', borderRadius: 4 }}>
                        <span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{selectedUrls.size} selected</span>
                        <select
                            value={selectedNotebookId}
                            onChange={e => setSelectedNotebookId(e.target.value)}
                            style={{ flex: 1, background: '#1e1e1e', border: '1px solid #444', color: '#fff', fontSize: 11, padding: '2px 5px', borderRadius: 2 }}
                        >
                            <option value="">Select Notebook...</option>
                            <option value="CREATE_NEW_NB">+ Create New Notebook...</option>
                            {notebooks.map(nb => (
                                <option key={nb.id} value={nb.id}>{nb.name}</option>
                            ))}
                        </select>
                        <button
                            onClick={handleBulkAdd}
                            disabled={!selectedNotebookId}
                            style={{
                                background: selectedNotebookId ? '#1a8c3e' : '#444',
                                border: 'none',
                                color: 'white',
                                fontSize: 11,
                                padding: '4px 10px',
                                borderRadius: 2,
                                cursor: selectedNotebookId ? 'pointer' : 'default',
                                whiteSpace: 'nowrap'
                            }}
                        >
                            ADD TO NOTEBOOK
                        </button>
                    </div>
                )}

                {/* Save All Results toolbar (shown when search run was registered) */}
                {currentSearchRunId && results.length > 0 && selectedUrls.size === 0 && (
                    <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', background: '#1e2d1e', padding: '5px 10px', borderRadius: 4, border: '1px solid #2a4a2a' }}>
                        <span style={{ fontSize: 11, opacity: 0.7, flex: 1 }}>Save all {results.length} results to notebook</span>
                        <select
                            value={selectedNotebookId}
                            onChange={e => setSelectedNotebookId(e.target.value)}
                            style={{ background: '#1e1e1e', border: '1px solid #444', color: '#fff', fontSize: 11, padding: '2px 5px', borderRadius: 2 }}
                        >
                            <option value="">Select Notebook...</option>
                            <option value="CREATE_NEW_NB">+ Create New Notebook from Search</option>
                            {notebooks.map(nb => (
                                <option key={nb.id} value={nb.id}>{nb.name}</option>
                            ))}
                        </select>
                        <button
                            onClick={async () => {
                                if (!selectedNotebookId || !currentSearchRunId) return;
                                if (selectedNotebookId === 'CREATE_NEW_NB') {
                                    const name = prompt("Notebook name:");
                                    if (!name?.trim()) return;
                                    if (!api?.researchCreateNotebookFromSearchRun) return;
                                    const res = await api.researchCreateNotebookFromSearchRun(currentSearchRunId, name.trim());
                                    if (res?.ok) {
                                        alert(`Notebook "${name.trim()}" created with ${res.itemCount} items.`);
                                        if (onAdd) onAdd();
                                    }
                                } else {
                                    if (!api?.researchAddSearchRunResultsToNotebook) return;
                                    const res = await api.researchAddSearchRunResultsToNotebook(currentSearchRunId, selectedNotebookId);
                                    if (res?.ok) {
                                        alert(`Added ${res.itemCount} items to notebook.`);
                                        if (onAdd) onAdd();
                                    }
                                }
                            }}
                            disabled={!selectedNotebookId}
                            style={{
                                background: selectedNotebookId ? '#1a8c3e' : '#444',
                                border: 'none',
                                color: 'white',
                                fontSize: 11,
                                padding: '4px 10px',
                                borderRadius: 2,
                                cursor: selectedNotebookId ? 'pointer' : 'default',
                                whiteSpace: 'nowrap'
                            }}
                        >
                            SAVE ALL
                        </button>
                    </div>
                )}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '10px' }}>
                {results.length === 0 && !loading && (
                    <div style={{ textAlign: 'center', marginTop: '50px', opacity: 0.5 }}>
                        {query ? 'No results found.' : 'Enter a query and hit search.'}
                    </div>
                )}

                {results.map((res, i) => {
                    const isSelected = res.url ? selectedUrls.has(res.url) : false;
                    const isScraping = res.url === scraping;

                    return (
                        <div
                            key={i}
                            style={{
                                padding: '15px',
                                borderBottom: '1px solid #252526',
                                cursor: 'default',
                                transition: 'background 0.2s',
                                position: 'relative',
                                display: 'flex',
                                gap: 10,
                                background: isSelected ? '#2d2d2d' : 'transparent'
                            }}
                            className="search-result-item"
                        >
                            {/* Checkbox for Remote Items */}
                            {mode === 'remote' && res.url && (
                                <div style={{ paddingTop: 2 }}>
                                    <input
                                        type="checkbox"
                                        checked={isSelected}
                                        onChange={() => toggleSelection(res.url!)}
                                        style={{ cursor: 'pointer' }}
                                    />
                                </div>
                            )}

                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                    onClick={() => mode === 'local' && res.path && onOpenFile?.(res.path)}
                                    style={{
                                        fontWeight: 'bold',
                                        color: '#9cdcfe',
                                        marginBottom: '5px',
                                        cursor: mode === 'local' ? 'pointer' : 'text'
                                    }}
                                >
                                    {res.title || res.path}
                                </div>
                                <div style={{ fontSize: '13px', color: '#d4d4d4', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                                    {res.content || res.snippet}
                                </div>
                                {res.url && (
                                    <div style={{ display: 'flex', gap: 10, marginTop: 5, alignItems: 'center' }}>
                                        <a href={res.url} target="_blank" rel="noreferrer" style={{ fontSize: '12px', color: '#3794ff', textDecoration: 'none' }}>
                                            View Source
                                        </a>
                                        {/* Status Indicator */}
                                        {isScraping && <span style={{ fontSize: 11, color: '#e2b93d' }}>ADDING...</span>}
                                        {/* Provider badge for provenance */}
                                        {res.providerId && res.providerId !== 'local' && (
                                            <span style={{ fontSize: 10, color: '#888', fontFamily: 'monospace', background: '#2a2a2a', padding: '1px 4px', borderRadius: 2 }}>
                                                {res.providerId}
                                            </span>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
