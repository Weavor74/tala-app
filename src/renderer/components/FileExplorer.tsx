/**
 * File Explorer Component
 *
 * Tree-view file browser displayed in the left sidebar panel.
 * Supports recursive directory expansion, right-click context menus,
 * and file operations (create file/folder, rename, delete, copy, move).
 *
 * **Data flow:**
 * - Calls `tala.listDirectory(path)` to load directory contents.
 * - Opens files in the editor via the `onOpenFile` callback.
 * - Mutates the filesystem via `tala.createFile`, `tala.deleteFile`,
 *   `tala.createDirectory`, `tala.movePath`, `tala.copyPath`.
 *
 * The tree state (expanded directories, loaded children) is held
 * entirely in React state to avoid re-fetching unchanged subtrees.
 */
import React, { useState, useEffect } from 'react';

/**
 * A node in the file tree.
 * Directories may have lazily-loaded `children`.
 */
interface FileEntry {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: FileEntry[];
}

/** Props for the FileExplorer component. */
interface Props {
    /** Callback to open a file in the editor panel by absolute path. */
    onOpenFile: (path: string) => void;
}

/**
 * Tracks the state of the right-click context menu.
 * `file` is null when the user right-clicks on empty space.
 */
interface ContextMenuState {
    x: number;
    y: number;
    file: FileEntry | null; // Null means root/background
}

/**
 * File explorer tree view with lazy directory loading, context menus,
 * and full CRUD file operations.
 */
export const FileExplorer: React.FC<Props> = ({ onOpenFile }) => {
    const [rootFiles, setRootFiles] = useState<FileEntry[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [rootPath, setRootPath] = useState('Workspace');

    // UI State
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [clipboard, setClipboard] = useState<{ path: string, op: 'copy' | 'cut' } | null>(null);

    // Modal State
    const [modal, setModal] = useState<{
        isOpen: boolean;
        type: 'new_file' | 'new_folder' | 'rename';
        value: string;
        target?: FileEntry;
    }>({ isOpen: false, type: 'new_file', value: '', target: undefined });

    const getApi = () => (window as any).tala;

    const loadRoot = async () => {
        const api = getApi();
        if (api?.listDirectory) {
            try {
                if (api.getRoot) {
                    const r = await api.getRoot();
                    // Simple basename hack since we don't have path module in browser
                    const base = r.split(/[\\/]/).pop() || r;
                    setRootPath(base);
                }
                const files = await api.listDirectory('');
                setRootFiles(files);
                setError(null);
            } catch (err: any) {
                setError("Failed to load: " + err.message);
            }
        }
    };

    useEffect(() => { loadRoot(); }, []);

    // Auto-refresh when files change on disk
    useEffect(() => {
        const api = getApi();
        if (!api?.on) return;
        const handler = () => loadRoot();
        api.on('file-changed', handler);
        return () => { if (api.off) api.off('file-changed', handler); };
    }, []);

    // Recursive directory loader
    const toggleDirectory = async (entry: FileEntry) => {
        if (!entry.isDirectory) {
            onOpenFile(entry.path);
            return;
        }

        const newExpanded = new Set(expandedPaths);
        if (newExpanded.has(entry.path)) {
            newExpanded.delete(entry.path);
        } else {
            newExpanded.add(entry.path);
            // Load children if needed (mutate entry - React anti-pattern but effective for tree here)
            if (!entry.children) {
                try {
                    entry.children = await getApi().listDirectory(entry.path);
                } catch (e) { console.error(e); }
            }
        }
        setExpandedPaths(newExpanded);
    };

    const handleContextMenu = (e: React.MouseEvent, file: FileEntry | null) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY, file });
    };

    const handleAction = async (action: string) => {
        const target = contextMenu?.file;
        setContextMenu(null); // Close menu

        try {
            switch (action) {
                case 'new_file':
                    setModal({ isOpen: true, type: 'new_file', value: '', target: target || undefined });
                    break;
                case 'new_folder':
                    setModal({ isOpen: true, type: 'new_folder', value: '', target: target || undefined });
                    break;
                case 'rename':
                    if (target) setModal({ isOpen: true, type: 'rename', value: target.name, target });
                    break;
                case 'delete': {
                    if (!target) return;
                    if (confirm(`Delete ${target.name}?`)) {
                        await getApi().deletePath(target.path);
                        loadRoot();
                    }
                    break;
                }
                case 'copy': {
                    if (target) setClipboard({ path: target.path, op: 'copy' });
                    break;
                }
                case 'cut': {
                    if (target) setClipboard({ path: target.path, op: 'cut' });
                    break;
                }
                case 'paste': {
                    if (!clipboard) return;
                    const api = getApi();
                    const targetPath = target ? target.path : '';
                    const isDir = target ? target.isDirectory : true;

                    const destDir = isDir ? targetPath : targetPath.split('/').slice(0, -1).join('/');
                    const fileName = clipboard.path.split('/').pop() || 'item';
                    const destPath = destDir ? `${destDir}/${fileName}` : fileName;

                    if (clipboard.op === 'copy') {
                        await api.copyPath(clipboard.path, destPath);
                    } else {
                        await api.movePath(clipboard.path, destPath);
                        setClipboard(null); // Clear after moving
                    }
                    loadRoot();
                    break;
                }
                case 'open_folder': {
                    const api = getApi();
                    if (api?.openFolderDialog) {
                        const newRoot = await api.openFolderDialog();
                        if (newRoot) loadRoot();
                    }
                    break;
                }
            }
        } catch (e: any) {
            alert(`Error: ${e.message}`);
        }
    };

    const submitModal = async () => {
        if (!modal.value.trim()) return;
        const api = getApi();
        const target = modal.target;
        const targetPath = target ? target.path : '';
        const isDir = target ? target.isDirectory : true;

        try {
            if (modal.type === 'new_file') {
                const parent = isDir ? targetPath : targetPath.split('/').slice(0, -1).join('/');
                const newPath = parent ? `${parent}/${modal.value}` : modal.value;
                await api.createFile(newPath, "");
            } else if (modal.type === 'new_folder') {
                const parent = isDir ? targetPath : targetPath.split('/').slice(0, -1).join('/');
                const newPath = parent ? `${parent}/${modal.value}` : modal.value;
                await api.createDirectory(newPath);
            } else if (modal.type === 'rename' && target) {
                const parent = target.path.split('/').slice(0, -1).join('/');
                const dest = parent ? `${parent}/${modal.value}` : modal.value;
                await api.movePath(target.path, dest);
            }
            loadRoot();
            setModal({ ...modal, isOpen: false });
        } catch (e: any) {
            alert(e.message);
        }
    };

    // Recurisve Renderer Component
    const renderTree = (entries: FileEntry[], depth = 0) => {
        return entries.map(entry => (
            <div key={entry.path}>
                <div
                    className="file-row"
                    style={{
                        paddingLeft: depth * 12 + 10,
                        cursor: 'pointer',
                        paddingTop: 4,
                        paddingBottom: 4,
                        opacity: clipboard?.path === entry.path && clipboard.op === 'cut' ? 0.5 : 1,
                        backgroundColor: contextMenu?.file?.path === entry.path ? '#333' : 'transparent'
                    }}
                    onClick={(e) => { e.stopPropagation(); toggleDirectory(entry); }}
                    onContextMenu={(e) => handleContextMenu(e, entry)}
                >
                    <span style={{ marginRight: 6 }}>{entry.isDirectory ? (expandedPaths.has(entry.path) ? '📂' : '📁') : '📄'}</span>
                    {entry.name}
                </div>
                {entry.isDirectory && expandedPaths.has(entry.path) && entry.children && (
                    renderTree(entry.children, depth + 1)
                )}
            </div>
        ));
    };

    return (
        <div className="file-explorer" style={{ height: '100%', display: 'flex', flexDirection: 'column' }} onContextMenu={(e) => handleContextMenu(e, null)}>
            {/* Header */}
            <div style={{ padding: 10, fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #333' }}>
                <span
                    onClick={() => handleAction('open_folder')}
                    style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: '140px' }}
                    title="Change Folder"
                >
                    📂 {rootPath.toUpperCase()}
                </span>
                <span onClick={loadRoot} style={{ cursor: 'pointer' }}>↻</span>
            </div>

            {/* Error */}
            {error && <div style={{ color: '#ff6b6b', padding: 10 }}>{error}</div>}

            {/* Files Tree */}
            <div style={{ flex: 1, overflowY: 'auto', paddingTop: 5 }}>
                {renderTree(rootFiles)}
                {rootFiles.length === 0 && !error && <div style={{ padding: 10, opacity: 0.5 }}>Empty</div>}
            </div>

            {/* Context Menu */}
            {contextMenu && (
                <div style={{
                    position: 'fixed',
                    top: contextMenu.y,
                    left: contextMenu.x,
                    background: '#252526',
                    border: '1px solid #454545',
                    boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
                    zIndex: 1000,
                    minWidth: 150,
                    padding: '4px 0',
                    color: '#eee'
                }} onClick={e => e.stopPropagation()}>
                    <div className="menu-item" onClick={() => handleAction('new_file')}>New File</div>
                    <div className="menu-item" onClick={() => handleAction('new_folder')}>New Folder</div>
                    <div className="menu-separator" style={{ height: 1, background: '#454545', margin: '4px 0' }} />
                    <div className="menu-item" onClick={() => handleAction('copy')}>Copy</div>
                    <div className="menu-item" onClick={() => handleAction('cut')}>Cut</div>
                    <div className="menu-item" onClick={() => handleAction('paste')} style={{ opacity: clipboard ? 1 : 0.5 }}>Paste</div>
                    <div className="menu-separator" style={{ height: 1, background: '#454545', margin: '4px 0' }} />
                    <div className="menu-item" onClick={() => handleAction('rename')}>Rename</div>
                    <div className="menu-item" onClick={() => handleAction('delete')} style={{ color: '#ff6b6b' }}>Delete</div>
                </div>
            )}

            {/* Input Modal */}
            {modal.isOpen && (
                <div style={{
                    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000
                }}>
                    <div style={{ background: '#252526', padding: 20, width: 300, border: '1px solid #454545', borderRadius: 4 }}>
                        <div style={{ marginBottom: 10, fontWeight: 'bold' }}>
                            {modal.type === 'new_file' ? 'New File' : modal.type === 'new_folder' ? 'New Folder' : 'Rename'}
                        </div>
                        <input
                            autoFocus
                            style={{ width: '100%', padding: 5, background: '#3c3c3c', border: '1px solid #555', color: 'white', marginBottom: 10 }}
                            value={modal.value}
                            onChange={e => setModal({ ...modal, value: e.target.value })}
                            onKeyDown={e => {
                                if (e.key === 'Enter') submitModal();
                                if (e.key === 'Escape') setModal({ ...modal, isOpen: false });
                            }}
                        />
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                            <button onClick={() => setModal({ ...modal, isOpen: false })} style={{ padding: '4px 8px', background: 'transparent', color: '#ccc', border: 'none', cursor: 'pointer' }}>Cancel</button>
                            <button onClick={submitModal} style={{ padding: '4px 12px', background: '#0e639c', color: 'white', border: 'none', cursor: 'pointer' }}>OK</button>
                        </div>
                    </div>
                </div>
            )}

            <style>{`
                .menu-item { padding: 4px 12px; cursor: pointer; font-size: 13px; }
                .menu-item:hover { background: #094771; }
            `}</style>
        </div>
    );
};
