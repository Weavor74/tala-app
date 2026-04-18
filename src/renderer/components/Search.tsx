/**
 * Search Component (Unified Local + Web Search)
 *
 * Provides a search panel with two modes:
 * - **Local Search:** Searches workspace files by name/content via the
 *   RetrievalOrchestrator (LocalSearchProvider, providerId='local').
 * - **Web Search:** Queries configured external providers via
 *   RetrievalOrchestrator (ExternalApiSearchProvider) or uses the
 *   unified DuckDuckGo provider as a zero-config fallback.
 *
 * All searches flow through RetrievalOrchestrator so both local and external
 * providers are normalized into the same result shape.
 *
 * Each search creates a `search_run` record in PostgreSQL, and results are
 * registered in `search_run_results`. From there users can:
 *   - **Save Selected** (preferred): save only selected results as
 *     `notebook_items` references — no content scraping or ingestion.
 *   - **Save All** (convenience): copy all search-run results into a notebook.
 *   - **Add to Notebook (with scrape)**: scrape/download content before saving.
 *
 * Architectural contract:
 *   - search results = candidate discovery items
 *   - notebook_items = curated saved references (this component's output)
 *   - ingestion (source_documents / chunks) = explicit later step
 *
 * Results display with clickable titles that either open local files
 * or launch URLs in the embedded browser.
 */
import React, { useState } from 'react';
import {
    resultKey,
    resultToNotebookItem,
    filterSelectedResults,
    allResultKeys,
} from '../utils/searchSelection';

/**
 * A unified search result — either a local file match or a web search result.
 * Local results have `path` and `content`; web results have `title`, `snippet`, and `url`.
 * All results may also carry `providerId` and `sourceType` for provenance display.
 * Aligns with `SearchResultInput` in searchSelection.ts.
 */
interface Result {
    sourcePath?: string;
    snippet?: string;
    title?: string;
    uri?: string;
    /** ID of the retrieval provider that produced this result (e.g., 'local', 'external:brave'). */
    providerId?: string;
    /** Source category from the provider (e.g., 'local_file', 'web'). */
    sourceType?: string;
    /** Provider-native identifier from NormalizedSearchResult.externalId. */
    externalId?: string | null;
    /** Arbitrary provider metadata from NormalizedSearchResult.metadata. */
    metadata?: Record<string, unknown>;
    contentHash?: string | null;
    mimeType?: string | null;
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

// ─── Search Execution ────────────────────────────────────────────────────────

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
    /** Keys of results the user has selected (url || path || result:<index>). */
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
    const [notebooks, setNotebooks] = useState<any[]>([]);
    const [selectedNotebookId, setSelectedNotebookId] = useState<string>(initialNotebookId || 'CREATE_NEW_NB');
    /** The search_run id from the most recent search, used to register notebook items. */
    const [currentSearchRunId, setCurrentSearchRunId] = useState<string | null>(null);
    /** Controls visibility of the inline notebook-name input (Electron-safe prompt replacement). */
    const [nbNameVisible, setNbNameVisible] = useState(false);
    /** Draft value typed into the notebook-name input. */
    const [nbNameValue, setNbNameValue] = useState('');
    /** Pending Promise resolve from askNotebookName(), settled on confirm or cancel. */
    const [nbNameResolve, setNbNameResolve] = useState<((v: string | null) => void) | null>(null);

    const api = (window as any).tala;

    /**
     * Electron-safe replacement for window.prompt().
     * Shows the inline notebook-name input and resolves with the trimmed name
     * entered by the user, or null when the user cancels.
     */
    const askNotebookName = (): Promise<string | null> =>
        new Promise(resolve => {
            setNbNameValue('');
            // Wrap in arrow so React does not treat `resolve` as a state-updater function.
            setNbNameResolve(() => resolve);
            setNbNameVisible(true);
        });

    const confirmNbName = () => {
        const name = nbNameValue.trim();
        if (!name) return;
        const settle = nbNameResolve;
        setNbNameVisible(false);
        setNbNameResolve(null);
        settle?.(name);
    };

    const cancelNbName = () => {
        const settle = nbNameResolve;
        setNbNameVisible(false);
        setNbNameResolve(null);
        settle?.(null);
    };

    /**
     * Resolves (or creates) the target notebook.
     * Returns the resolved notebook ID, or null if the user cancelled.
     */
    const resolveTargetNotebook = async (rawId: string): Promise<string | null> => {
        if (rawId !== 'CREATE_NEW_NB') return rawId;

        const name = await askNotebookName();
        if (!name) return null;

        // Try PostgreSQL-backed creation first
        if (api?.researchCreateNotebook) {
            const res = await api.researchCreateNotebook({ name });
            if (res?.ok && res.notebook) return res.notebook.id;
        }
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
        return newNb.id;
    };

    /**
     * SAVE SELECTED — preferred curated workflow.
     *
     * Saves only the selected search results into the target notebook as
     * `notebook_items` reference records. No content scraping or ingestion
     * occurs. The saved items carry full normalized metadata (itemKey, title,
     * uri, sourcePath, snippet, providerId, externalId) so they can be
     * explicitly ingested later via ingestItems(itemKeys).
     */
    const handleSaveSelected = async () => {
        if (selectedKeys.size === 0 || !selectedNotebookId) return;
        setLoading(true);

        const selectedItemKeys = Array.from(selectedKeys);

        // Try atomic PostgreSQL DB paths first whenever a search run exists
        if (currentSearchRunId) {
            if (selectedNotebookId === 'CREATE_NEW_NB') {
                const name = await askNotebookName();
                if (!name) { setLoading(false); return; }
                if (api?.researchCreateNotebookFromSearchRun) {
                    const res = await api.researchCreateNotebookFromSearchRun(currentSearchRunId, name, undefined, selectedItemKeys);
                    if (res?.ok) {
                        setSelectedNotebookId(res.notebook.id);
                        setSelectedKeys(new Set());
                        setLoading(false);
                        alert(`Saved ${res.itemCount} item(s) to notebook.`);
                        if (onAdd) onAdd();
                        return;
                    } else if (res?.error) {
                        alert(`Save Failed: ${res.error}`);
                        setLoading(false);
                        return;
                    }
                }
            } else {
                if (api?.researchAddSearchRunResultsToNotebook) {
                    const res = await api.researchAddSearchRunResultsToNotebook(currentSearchRunId, selectedNotebookId, selectedItemKeys);
                    if (res?.ok) {
                        setSelectedKeys(new Set());
                        setLoading(false);
                        alert(`Saved ${res.itemCount} item(s) to notebook.`);
                        if (onAdd) onAdd();
                        return;
                    } else if (res?.error) {
                        alert(`Save Failed: ${res.error}`);
                        setLoading(false);
                        return;
                    }
                }
            }
        }

        // Fallback: non-DB path or no current search run
        const targetId = await resolveTargetNotebook(selectedNotebookId);
        if (!targetId) { setLoading(false); return; }

        const selected = filterSelectedResults(results, selectedKeys);
        const notebookItems = selected.map(({ result, index }) =>
            resultToNotebookItem(result, index)
        );

        if (notebookItems.length > 0 && api?.researchAddItemsToNotebook) {
            const res = await api.researchAddItemsToNotebook(targetId, notebookItems, currentSearchRunId ?? undefined);
            if (!res?.ok && res?.error) {
                alert(`Save Failed: ${res.error}`);
                setLoading(false);
                return;
            }
        } else if (notebookItems.length > 0 && api?.getSettings) {
            // Settings-based fallback (DB unavailable): only source_paths can be persisted.
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
        setSelectedKeys(new Set());
        setLoading(false);
        alert(`Saved ${notebookItems.length} item(s) to notebook.`);
        if (onAdd) onAdd();
    };

    /**
     * ADD TO NOTEBOOK (with scrape) — downloads/scrapes web content before saving.
     *
     * This is an explicit content-fetch action for users who want to download
     * the page content as a local artifact alongside the notebook reference.
     * Only applies to web results that have a URL.
     */
    const handleBulkAdd = async () => {
        if (selectedKeys.size === 0 || !selectedNotebookId) return;
        setLoading(true);

        const targetId = await resolveTargetNotebook(selectedNotebookId);
        if (!targetId) { setScraping(null); setLoading(false); return; }

        let successCount = 0;
        let failCount = 0;

        const uris = results
            .filter((r, i) => r.uri && selectedKeys.has(resultKey(r.uri, r.sourcePath, i)))
            .map(r => r.uri as string);

        const notebookItems: Array<{
            item_key: string; item_type: string;
            source_path?: string; title?: string; uri?: string; snippet?: string;
            provider_id?: string;
        }> = [];

        for (const uri of uris) {
            const resItem = results.find(r => r.uri === uri);
            const title = resItem?.title || 'Web Resource';
            setScraping(uri);
            try {
                const res = await api.scrapeUrl(uri, title);
                if (res.success && res.path) {
                    successCount++;
                    notebookItems.push({
                        item_key: uri,
                        item_type: 'web',
                        source_path: res.path,
                        title: resItem?.title ?? uri,
                        uri: uri,
                        snippet: resItem?.snippet ?? undefined,
                        provider_id: resItem?.providerId ?? undefined,
                    });
                    setSelectedKeys(prev => {
                        const next = new Set(prev);
                        next.delete(uri);
                        return next;
                    });
                } else {
                    failCount++;
                }
            } catch (e) {
                failCount++;
            }
        }

        // Persist notebook items to PostgreSQL
        if (notebookItems.length > 0 && api?.researchAddItemsToNotebook) {
            const saveRes = await api.researchAddItemsToNotebook(targetId, notebookItems, currentSearchRunId ?? undefined);
            if (!saveRes?.ok) {
                setScraping(null);
                setLoading(false);
                alert(`Notebook save failed: ${saveRes?.error ?? 'Unknown error'}\nContent scraped: ${successCount} file(s) — retry saving them manually.`);
                if (onAdd) onAdd();
                return;
            }
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
                // Auto-select first existing notebook when none is explicitly chosen yet
                // (includes the 'CREATE_NEW_NB' placeholder so a real ID wins over it).
                if (!selectedNotebookId || selectedNotebookId === 'CREATE_NEW_NB') {
                    setSelectedNotebookId(
                        res.notebooks?.length > 0 ? res.notebooks[0].id : 'CREATE_NEW_NB'
                    );
                }
                return;
            }
        }
        // Fallback: settings-based
        if (api?.getSettings) {
            const settings = await api.getSettings();
            setNotebooks(settings.notebooks || []);
            if (!selectedNotebookId || selectedNotebookId === 'CREATE_NEW_NB') {
                setSelectedNotebookId(
                    settings.notebooks?.length > 0 ? settings.notebooks[0].id : 'CREATE_NEW_NB'
                );
            }
        }
    };

    const handleClear = () => {
        setQuery('');
        setResults([]);
        setSelectedKeys(new Set());
        setLoading(false);
        setCurrentSearchRunId(null);
    };

    React.useEffect(() => {
        loadNotebooks();
    }, []);

    const handleSearch = async () => {
        if (!query.trim()) return;
        console.log(`[SearchUI] handleSearch triggered for query: "${query.trim()}" in mode: ${mode}`);
        setLoading(true);
        setSelectedKeys(new Set()); // Reset selection when a new search is run
        setCurrentSearchRunId(null);

        if (!api) { setLoading(false); return; }

        try {
            let fetchedResults: Result[] = [];

            // Execute canonical retrieval via RetrievalOrchestrator.
            if (api?.retrievalRetrieve) {
                const settings = api.getSettings ? await api.getSettings() : null;
                const preferredId = settings?.search?.preferredProviderId;
                const providerIds = (preferredId && preferredId !== 'auto') ? [preferredId] : undefined;

                const providerCategory = mode === 'local' ? 'local' : 'external';
                console.log(`[SearchUI] Calling retrievalRetrieve with mode: keyword, scope: global, category: ${providerCategory}, preferred: ${preferredId}`);
                
                const retrievalRes = await api.retrievalRetrieve({
                    query: query.trim(),
                    mode: 'keyword',
                    scope: 'global',
                    providerIds,
                    providerCategory,
                });

                console.log(`[SearchUI] retrievalRetrieve response received:`, retrievalRes);

                if (retrievalRes?.ok && retrievalRes.response?.results) {
                    fetchedResults = (retrievalRes.response.results as Array<{
                        title: string; uri?: string | null; sourcePath?: string | null;
                        snippet?: string | null; providerId: string; sourceType?: string | null;
                        externalId?: string | null; metadata?: Record<string, unknown>;
                        contentHash?: string | null;
                        mimeType?: string | null;
                    }>).map(r => ({
                        title: r.title,
                        uri: r.uri ?? undefined,
                        sourcePath: r.sourcePath ?? undefined,
                        snippet: r.snippet ?? undefined,
                        providerId: r.providerId,
                        sourceType: r.sourceType ?? undefined,
                        externalId: r.externalId ?? undefined,
                        metadata: r.metadata,
                        contentHash: r.contentHash ?? undefined,
                        mimeType: r.mimeType ?? undefined,
                    }));
                }
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
                            item_key: resultKey(r.uri, r.sourcePath, i),
                            item_type: r.sourceType ?? (r.providerId === 'local' ? 'local_file' : 'web'),
                            source_id: r.providerId ?? undefined,
                            source_path: r.sourcePath ?? undefined,
                            title: r.title ?? r.sourcePath ?? undefined,
                            uri: r.uri ?? undefined,
                            snippet: r.snippet?.slice(0, 500) ?? undefined,
                            content_hash: r.contentHash ?? undefined,
                            sourceType: r.sourceType ?? undefined,
                            providerId: r.providerId ?? undefined,
                            mimeType: r.mimeType ?? undefined,
                            retrievalStatus: (r.uri ?? r.sourcePath) ? 'queued' : 'saved_metadata_only',
                            openTarget: r.uri ?? r.sourcePath ?? null,
                            openTargetType: r.uri ? 'browser' : (r.sourcePath ? 'workspace_file' : 'none'),
                            createdFromSearch: true,
                            metadata_json: {
                                ...(r.metadata ?? {}),
                                externalId: r.externalId ?? null,
                                providerId: r.providerId ?? null,
                            },
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
        if (e.key === 'Escape') handleClear();
    };

    const toggleSelection = (key: string) => {
        setSelectedKeys(prev => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    };

    const handleSelectAll = () => setSelectedKeys(allResultKeys(results));
    const handleClearSelection = () => setSelectedKeys(new Set());

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
                    {(query || results.length > 0) && (
                        <button
                            onClick={handleClear}
                            title="Clear search results and input (Esc)"
                            style={{
                                background: 'transparent',
                                border: '1px solid #444',
                                color: '#888',
                                padding: '8px 12px',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '11px',
                                transition: 'color 0.2s'
                            }}
                        >
                            CLEAR
                        </button>
                    )}
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

                {/* Selection controls — shown whenever there are results */}
                {results.length > 0 && (
                    <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button
                            onClick={handleSelectAll}
                            style={{ background: 'transparent', border: '1px solid #444', color: '#aaa', fontSize: 10, padding: '2px 8px', borderRadius: 2, cursor: 'pointer' }}
                        >
                            Select All
                        </button>
                        <button
                            onClick={handleClearSelection}
                            disabled={selectedKeys.size === 0}
                            style={{ background: 'transparent', border: '1px solid #444', color: selectedKeys.size > 0 ? '#aaa' : '#555', fontSize: 10, padding: '2px 8px', borderRadius: 2, cursor: selectedKeys.size > 0 ? 'pointer' : 'default' }}
                        >
                            Clear
                        </button>
                        {selectedKeys.size > 0 && (
                            <span style={{ fontSize: 10, opacity: 0.7 }}>{selectedKeys.size} of {results.length} selected</span>
                        )}
                    </div>
                )}

                {/* Save Selected toolbar — preferred curated workflow, no content scraping */}
                {selectedKeys.size > 0 && (
                    <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', background: '#1e2830', padding: '5px 10px', borderRadius: 4, border: '1px solid #2a4060' }}>
                        <span style={{ fontSize: 11, whiteSpace: 'nowrap', color: '#9cdcfe' }}>
                            💾 {selectedKeys.size} selected
                        </span>
                        <select
                            value={selectedNotebookId}
                            onChange={e => setSelectedNotebookId(e.target.value)}
                            style={{ flex: 1, background: '#1e1e1e', border: '1px solid #444', color: '#fff', fontSize: 11, padding: '2px 5px', borderRadius: 2 }}
                        >
                            <option value="CREATE_NEW_NB">+ Create New Notebook...</option>
                            {notebooks.map(nb => (
                                <option key={nb.id} value={nb.id}>{nb.name}</option>
                            ))}
                        </select>
                        <button
                            onClick={handleSaveSelected}
                            disabled={!selectedNotebookId}
                            title="Save selected results as notebook references (no content download)"
                            style={{
                                background: selectedNotebookId ? '#0e639c' : '#444',
                                border: 'none',
                                color: 'white',
                                fontSize: 11,
                                padding: '4px 10px',
                                borderRadius: 2,
                                cursor: selectedNotebookId ? 'pointer' : 'default',
                                whiteSpace: 'nowrap',
                                fontWeight: 'bold'
                            }}
                        >
                            SAVE SELECTED
                        </button>
                        {mode === 'remote' && (
                            <button
                                onClick={handleBulkAdd}
                                disabled={!selectedNotebookId}
                                title="Download and scrape selected web pages, then save to notebook"
                                style={{
                                    background: 'transparent',
                                    border: '1px solid #444',
                                    color: selectedNotebookId ? '#aaa' : '#555',
                                    fontSize: 11,
                                    padding: '4px 10px',
                                    borderRadius: 2,
                                    cursor: selectedNotebookId ? 'pointer' : 'default',
                                    whiteSpace: 'nowrap'
                                }}
                            >
                                + SCRAPE & ADD
                            </button>
                        )}
                    </div>
                )}

                {/* Save All Results toolbar (shown when results exist and nothing is selected) */}
                {results.length > 0 && selectedKeys.size === 0 && (
                    <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', background: '#1e2d1e', padding: '5px 10px', borderRadius: 4, border: '1px solid #2a4a2a' }}>
                        <span style={{ fontSize: 11, opacity: 0.7, flex: 1 }}>Save all {results.length} results to notebook</span>
                        <select
                            value={selectedNotebookId}
                            onChange={e => setSelectedNotebookId(e.target.value)}
                            style={{ background: '#1e1e1e', border: '1px solid #444', color: '#fff', fontSize: 11, padding: '2px 5px', borderRadius: 2 }}
                        >
                            <option value="CREATE_NEW_NB">+ Create New Notebook from Search</option>
                            {notebooks.map(nb => (
                                <option key={nb.id} value={nb.id}>{nb.name}</option>
                            ))}
                        </select>
                        <button
                            onClick={async () => {
                                if (!selectedNotebookId) return;
                                if (currentSearchRunId) {
                                    // Preferred path: search run registered — use atomic DB methods.
                                    if (selectedNotebookId === 'CREATE_NEW_NB') {
                                        const name = await askNotebookName();
                                        if (!name?.trim()) return;
                                        if (!api?.researchCreateNotebookFromSearchRun) return;
                                        const res = await api.researchCreateNotebookFromSearchRun(currentSearchRunId, name.trim());
                                        if (res?.ok) {
                                            alert(`Notebook "${name.trim()}" created with ${res.itemCount} items.`);
                                            if (onAdd) onAdd();
                                        } else {
                                            alert(`Save failed: ${res?.error ?? 'Unknown error'}`);
                                        }
                                    } else {
                                        if (!api?.researchAddSearchRunResultsToNotebook) return;
                                        const res = await api.researchAddSearchRunResultsToNotebook(currentSearchRunId, selectedNotebookId);
                                        if (res?.ok) {
                                            alert(`Added ${res.itemCount} items to notebook.`);
                                            if (onAdd) onAdd();
                                        } else {
                                            alert(`Save failed: ${res?.error ?? 'Unknown error'}`);
                                        }
                                    }
                                } else {
                                    // Fallback: no search run registered — save items directly.
                                    const targetId = await resolveTargetNotebook(selectedNotebookId);
                                    if (!targetId) return;
                                    const notebookItems = results.map((r, i) => resultToNotebookItem(r, i));
                                    if (notebookItems.length > 0 && api?.researchAddItemsToNotebook) {
                                        const res = await api.researchAddItemsToNotebook(targetId, notebookItems);
                                        if (res?.ok) {
                                            alert(`Saved ${res.added ?? notebookItems.length} item(s) to notebook.`);
                                            if (onAdd) onAdd();
                                        } else {
                                            alert(`Save failed: ${res?.error ?? 'Unknown error'}`);
                                        }
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

            {/* ── Inline notebook-name input ─────────────────────────────────────────
                Electron-safe replacement for window.prompt(). Shown when any save
                action needs a new notebook name. Keyboard: Enter = confirm, Esc = cancel. */}
            {nbNameVisible && (
                <div style={{ padding: '8px 20px', borderBottom: '1px solid #333', display: 'flex', gap: 8, alignItems: 'center', background: '#252526' }}>
                    <span style={{ fontSize: 11, color: '#ccc', whiteSpace: 'nowrap' }}>Notebook name:</span>
                    <input
                        autoFocus
                        type="text"
                        value={nbNameValue}
                        onChange={e => setNbNameValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') confirmNbName(); else if (e.key === 'Escape') cancelNbName(); }}
                        placeholder="Enter notebook name…"
                        style={{ flex: 1, background: '#1e1e1e', border: '1px solid #555', color: '#fff', fontSize: 11, padding: '4px 8px', borderRadius: 2, outline: 'none' }}
                    />
                    <button
                        onClick={confirmNbName}
                        disabled={!nbNameValue.trim()}
                        style={{ background: nbNameValue.trim() ? '#0e639c' : '#444', border: 'none', color: 'white', fontSize: 11, padding: '4px 12px', borderRadius: 2, cursor: nbNameValue.trim() ? 'pointer' : 'default' }}
                    >
                        OK
                    </button>
                    <button
                        onClick={cancelNbName}
                        style={{ background: 'transparent', border: '1px solid #555', color: '#aaa', fontSize: 11, padding: '4px 12px', borderRadius: 2, cursor: 'pointer' }}
                    >
                        Cancel
                    </button>
                </div>
            )}

            <div style={{ flex: 1, overflowY: 'auto', padding: '10px' }}>
                {results.length === 0 && !loading && (
                    <div style={{ textAlign: 'center', marginTop: '50px', opacity: 0.5 }}>
                        {query ? 'No results found.' : 'Enter a query and hit search.'}
                    </div>
                )}

                {results.map((res, i) => {
                    const key = resultKey(res.uri, res.sourcePath, i);
                    const isSelected = selectedKeys.has(key);
                    const isScraping = res.uri === scraping;

                    return (
                        <div
                            key={i}
                            onClick={() => toggleSelection(key)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSelection(key); } }}
                            tabIndex={0}
                            role="checkbox"
                            aria-checked={isSelected}
                            style={{
                                padding: '15px',
                                borderBottom: '1px solid #252526',
                                cursor: 'pointer',
                                transition: 'background 0.2s',
                                position: 'relative',
                                display: 'flex',
                                gap: 10,
                                background: isSelected ? '#1e2830' : 'transparent',
                                outline: 'none'
                            }}
                            className="search-result-item"
                        >
                            {/* Checkbox — available for all result types (local and web) */}
                            <div style={{ paddingTop: 2 }}>
                                <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleSelection(key)}
                                    onClick={e => e.stopPropagation()}
                                    style={{ cursor: 'pointer' }}
                                />
                            </div>

                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (mode === 'local' && res.sourcePath) onOpenFile?.(res.sourcePath);
                                    }}
                                    style={{
                                        fontWeight: 'bold',
                                        color: '#9cdcfe',
                                        marginBottom: '5px',
                                        cursor: mode === 'local' && res.sourcePath ? 'pointer' : 'default'
                                    }}
                                >
                                    {res.title || res.sourcePath}
                                </div>
                                <div style={{ fontSize: '13px', color: '#d4d4d4', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                                    {res.snippet}
                                </div>
                                {res.uri && (
                                    <div style={{ display: 'flex', gap: 10, marginTop: 5, alignItems: 'center' }}>
                                        <a
                                            href={res.uri}
                                            target="_blank"
                                            rel="noreferrer"
                                            onClick={e => e.stopPropagation()}
                                            style={{ fontSize: '12px', color: '#3794ff', textDecoration: 'none' }}
                                        >
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
                                {/* Provider badge for local results */}
                                {res.providerId === 'local' && res.sourcePath && (
                                    <div style={{ fontSize: 10, color: '#888', marginTop: 3, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {res.sourcePath}
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
