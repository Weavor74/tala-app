/**
 * Search Component (Unified Local + Web Search)
 *
 * Provides a search panel with two modes:
 * - **Local Search:** Searches workspace files by name/content via `FileService.searchFiles()`.
 * - **Web Search:** Queries DuckDuckGo Lite via the `search-remote` IPC handler.
 *
 * Web results can be selected and bulk-scraped into the RAG database
 * using `search-scrape`, which downloads, converts to markdown, and ingests.
 *
 * Results display with clickable titles that either open local files
 * or launch URLs in the embedded browser.
 */
import React, { useState } from 'react';

/**
 * A unified search result — either a local file match or a web search result.
 * Local results have `path` and `content`; web results have `title`, `snippet`, and `url`.
 */
interface Result {
    path?: string;
    content?: string;
    title?: string;
    snippet?: string;
    url?: string;
}

/** Props for the Search component. */
interface SearchProps {
    /** Callback to open a local file in the editor panel. */
    onOpenFile?: (path: string) => void;
}

/**
 * Search panel with local/web toggle, query input, result list,
 * and bulk-scrape capability for web results.
 */
export const Search: React.FC<SearchProps> = ({ onOpenFile }) => {
    const [query, setQuery] = useState('');
    const [mode, setMode] = useState<'local' | 'remote'>('remote'); // Default to remote as per user request context
    const [results, setResults] = useState<Result[]>([]);
    const [loading, setLoading] = useState(false);
    const [scraping, setScraping] = useState<string | null>(null);
    const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());

    const api = (window as any).tala;


    const handleBulkAdd = async () => {
        if (selectedUrls.size === 0) return;
        setLoading(true); // repurpose loading or use a new state?

        const urls = Array.from(selectedUrls);
        let successCount = 0;
        let failCount = 0;

        for (const url of urls) {
            const resItem = results.find(r => r.url === url);
            const title = resItem?.title || 'Web Resource';
            setScraping(url); // Show activity on specific item
            try {
                const res = await api.scrapeUrl(url, title);
                if (res.success) {
                    successCount++;
                    // Remove from selection on success?
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
        setScraping(null);
        setLoading(false);
        alert(`Bulk Import Complete.\nSuccess: ${successCount}\nFailed: ${failCount}`);
    };

    const handleSearch = async () => {
        if (!query.trim()) return;
        setLoading(true);
        setSelectedUrls(new Set()); // Clear selection on new search

        if (!api) return;

        try {
            if (mode === 'local') {
                const res = await api.searchFiles(query);
                setResults(res || []);
            } else {
                const res = await api.searchRemote(query);
                setResults(res || []);
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
                    <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#2d2d2d', padding: '5px 10px', borderRadius: 4 }}>
                        <span style={{ fontSize: 12 }}>{selectedUrls.size} selected</span>
                        <button
                            onClick={handleBulkAdd}
                            style={{
                                background: '#1a8c3e',
                                border: 'none',
                                color: 'white',
                                fontSize: 11,
                                padding: '4px 10px',
                                borderRadius: 2,
                                cursor: 'pointer'
                            }}
                        >
                            ADD TO LIBRARY
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
                                        {/* Maybe show "Added" if we tracked history? For now simpler is better. */}
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
