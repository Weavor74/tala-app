/**
 * Library (Knowledge Base) Component
 *
 * Shows a unified view of the user's document library — both local
 * `memory/` files and RAG-indexed files. Allows users to:
 * - View which files are locally present and/or indexed in the vector DB.
 * - Bulk-ingest all local memory files into RAG.
 * - Import individual files into the workspace.
 * - Delete files from both the filesystem and the RAG index.
 *
 * Data sources:
 * - `tala.listDirectory('memory')` — local markdown/text files.
 * - `tala.listIndexedFiles()` — files indexed in the RAG vector database.
 */
import React, { useState, useEffect } from 'react';

/**
 * Represents a single document in the library list.
 * Combines local filesystem info with RAG indexing status.
 */
interface LibraryDoc {
    name: string;
    path: string;
    size: number;
    date: string;
    /** True if the file exists on the local filesystem. */
    isLocal: boolean;
    /** True if the file is indexed in the RAG vector database. */
    isIndexed: boolean;
}

/** Props for the Library component. */
interface LibraryProps {
    /** Callback to open a file in the editor panel. */
    onOpenFile?: (path: string) => void;
}

/**
 * Library panel component.
 * Displays a searchable list of documents with status indicators
 * and action buttons for ingestion, import, and deletion.
 */
export const Library: React.FC<LibraryProps> = ({ onOpenFile }) => {
    const [docs, setDocs] = useState<LibraryDoc[]>([]);
    const [loading, setLoading] = useState(false);
    const [ingesting, setIngesting] = useState(false);

    const getApi = () => (window as any).tala;

    const loadLibrary = async () => {
        setLoading(true);
        const api = getApi();
        if (!api) return;

        try {
            const normalize = (p: string) => p.toLowerCase().replace(/\\/g, '/');

            // 1. Get files from DB
            const rawIndexed = await api.listIndexedFiles();
            const indexedSources = rawIndexed.map(normalize);

            // 2. Get local files
            const finalPath = 'memory';
            await api.createDirectory(finalPath);
            const entries = await api.listDirectory(finalPath);
            const localEntries = entries.filter((e: any) => !e.isDirectory);
            const localPaths = localEntries.map((e: any) => normalize(e.path));

            // 3. Merge
            const allPaths = Array.from(new Set([...indexedSources, ...localPaths]));

            const combinedDocs: LibraryDoc[] = allPaths.map(pathKey => {
                const name = pathKey.split('/').pop() || pathKey;
                const isLocal = localPaths.includes(pathKey);
                const isIndexed = indexedSources.includes(pathKey);

                return {
                    name,
                    path: pathKey,
                    size: 0,
                    date: isIndexed ? 'Indexed' : 'Local Only',
                    isLocal,
                    isIndexed
                };
            });

            console.log(`[Library] Total combined: ${combinedDocs.length}. Indexed: ${combinedDocs.filter(d => d.isIndexed).length}`);
            setDocs(combinedDocs);
        } catch (e) {
            console.error("Failed to load library", e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadLibrary();
    }, []);

    const handleImport = async () => {
        // Mock import dialog
        // In real app: dialog.showOpenDialog -> copy file to memory folder
        // For now, let's just create a dummy file
        const api = getApi();
        const name = prompt("Enter document name (e.g. protocol.md):");
        if (name) {
            const filePath = `memory/${name}`;
            await api.createFile(filePath, "# New Memory\n\nContent...");

            // Trigger RAG Ingestion
            console.log(`[Library] Requesting ingestion for ${filePath}`);
            const result = await api.ingestFile(filePath);
            alert(result); // Show ingestion result

            loadLibrary();
        }
    };

    const handleDelete = async (doc: LibraryDoc) => {
        if (confirm(`Permanently delete "${doc.name}"? This will remove its associated vectors from long-term memory.`)) {
            const api = getApi();
            await api.deletePath(doc.path);

            // Clean up vectors
            await api.deleteMemory(doc.path);

            loadLibrary();
        }
    }

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', color: '#ccc' }}>
            {/* Header / Toolbar */}
            <div style={{ padding: 10, borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 'bold', fontSize: 11, color: '#9cdcfe' }}>RAG DOCUMENTS</span>
                <div style={{ display: 'flex', gap: 5 }}>
                    <button
                        onClick={loadLibrary}
                        style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 13 }}
                        title="Refresh"
                    >
                        ⟳
                    </button>
                    {!ingesting && (
                        <button
                            onClick={async () => {
                                setIngesting(true);
                                try {
                                    const res = await getApi().scanAndIngest();
                                    alert(`Scan complete: ${res.ingested} new documents indexed.`);
                                    loadLibrary();
                                } catch (e) {
                                    console.error("Manual scan failed", e);
                                } finally {
                                    setIngesting(false);
                                }
                            }}
                            style={{ background: '#333', border: '1px solid #444', color: '#fff', padding: '2px 6px', borderRadius: 2, fontSize: 10, cursor: 'pointer' }}
                            title="Scan memory folder for new documents"
                        >
                            RE-INDEX ALL
                        </button>
                    )}
                    <button
                        onClick={handleImport}
                        style={{ background: '#0e639c', border: 'none', color: 'white', padding: '2px 8px', borderRadius: 2, fontSize: 11, cursor: 'pointer' }}
                    >
                        + ADD
                    </button>
                </div>
            </div>

            {/* Content */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
                {loading && !ingesting && <div style={{ padding: 20, textAlign: 'center', opacity: 0.5 }}>Loading...</div>}

                {!loading && docs.length === 0 && (
                    <div style={{ padding: 20, textAlign: 'center', opacity: 0.5, fontSize: 12 }}>
                        No documents in memory.<br />
                        Click + ADD to ingest.
                    </div>
                )}

                {docs.map(doc => (
                    <div
                        key={doc.path}
                        className="file-item"
                        onClick={() => onOpenFile?.(doc.path)}
                        style={{ padding: '8px 15px', borderBottom: '1px solid #252526', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: 14 }}>📄</span>
                            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                                <span style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{doc.name}</span>
                                <div style={{ display: 'flex', gap: 5, marginTop: 2 }}>
                                    {doc.isIndexed && <span style={{ fontSize: 8, background: '#007acc', color: 'white', padding: '1px 4px', borderRadius: 2 }}>INDEXED</span>}
                                    {doc.isLocal && <span style={{ fontSize: 8, background: '#3e3e42', color: '#ccc', padding: '1px 4px', borderRadius: 2 }}>LOCAL</span>}
                                </div>
                            </div>
                        </div>
                        <button
                            onClick={(e) => { e.stopPropagation(); handleDelete(doc); }}
                            style={{ background: 'transparent', border: 'none', color: '#555', cursor: 'pointer', fontSize: 14, marginLeft: 10 }}
                            title="Delete"
                        >
                            ×
                        </button>
                    </div>
                ))}
            </div>

            {/* Stats Footer */}
            <div style={{ padding: 5, borderTop: '1px solid #333', fontSize: 10, opacity: 0.5, textAlign: 'center' }}>
                {docs.length} Documents • Local Vector Store
            </div>
        </div>
    );
};
