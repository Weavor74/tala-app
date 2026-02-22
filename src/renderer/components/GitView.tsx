/**
 * Git View (Advanced Git Panel)
 *
 * A comprehensive Git management panel displayed as a main content view.
 * Provides branch management, commit history, and stash operations:
 * - List and switch branches.
 * - Create and delete branches.
 * - View commit log with hash, author, date, and subject.
 * - Stash push and pop.
 *
 * Delegates all Git operations to `GitService` via IPC handlers.
 * For basic staging/committing, see `SourceControl.tsx`.
 */
import React, { useState, useEffect } from 'react';

// Styles
const containerStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%', color: '#ccc', background: '#1e1e1e', overflow: 'hidden' };
const headerStyle: React.CSSProperties = { padding: '15px 20px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' };
const subHeaderStyle: React.CSSProperties = { padding: '8px 20px', background: '#252526', borderBottom: '1px solid #333', fontSize: 11, fontWeight: 'bold', color: '#888', display: 'flex', gap: 20 };
const contentStyle: React.CSSProperties = { flex: 1, display: 'flex', overflow: 'hidden' };
const sidebarStyle: React.CSSProperties = { width: '300px', borderRight: '1px solid #333', overflowY: 'auto', display: 'flex', flexDirection: 'column' };
const mainAreaStyle: React.CSSProperties = { flex: 1, overflowY: 'auto', padding: '20px' };

const buttonStyle: React.CSSProperties = { background: '#2d2d2d', color: '#fff', border: '1px solid #444', padding: '4px 12px', fontSize: 11, cursor: 'pointer', borderRadius: 2 };

interface GitCommit {
    hash: string;
    author: string;
    date: string;
    subject: string;
}

export const GitView: React.FC = () => {
    const api = (window as any).tala;

    const [branches, setBranches] = useState<string[]>([]);
    const [currentBranch, setCurrentBranch] = useState('');
    const [history, setHistory] = useState<GitCommit[]>([]);
    const [diff, setDiff] = useState('');
    const [loading, setLoading] = useState(false);
    const [view, setView] = useState<'history' | 'diff' | 'branches'>('history');
    const [newBranchName, setNewBranchName] = useState('');

    useEffect(() => {
        loadAll();
    }, []);

    const loadAll = async () => {
        setLoading(true);
        try {
            const [b, cur, log, d] = await Promise.all([
                api.gitBranches(),
                api.gitCurrentBranch(),
                api.gitLog(50),
                api.gitDiff()
            ]);
            setBranches(b || []);
            setCurrentBranch(cur || '');
            setHistory(log || []);
            setDiff(d || '');
        } catch (e) {
            console.error('Failed to load git data:', e);
        } finally {
            setLoading(false);
        }
    };

    const handleCheckout = async (branch: string) => {
        setLoading(true);
        try {
            await api.gitCheckout(branch);
            await loadAll();
        } catch (e: any) {
            alert(`Checkout failed: ${e.message}`);
        } finally {
            setLoading(false);
        }
    };

    const handleCreateBranch = async () => {
        if (!newBranchName.trim()) return;
        setLoading(true);
        try {
            await api.gitCreateBranch(newBranchName.trim());
            setNewBranchName('');
            await loadAll();
        } catch (e: any) {
            alert(`Create branch failed: ${e.message}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={containerStyle}>
            {/* HEADER */}
            <div style={headerStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
                    <h2 style={{ margin: 0, fontSize: 16, color: '#fff' }}>SOURCE CONTROL</h2>
                    <div style={{ background: '#333', padding: '2px 8px', borderRadius: 4, fontSize: 11, color: '#007acc', fontWeight: 'bold', border: '1px solid #007acc' }}>
                        BRANCH: {currentBranch.toUpperCase()}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button style={buttonStyle} onClick={loadAll} disabled={loading}>⟳ Refresh</button>
                    <button style={buttonStyle} onClick={() => api.gitSync({})} disabled={loading}>⇅ Sync</button>
                </div>
            </div>

            {/* TAB BAR */}
            <div style={subHeaderStyle}>
                <span
                    onClick={() => setView('history')}
                    style={{ cursor: 'pointer', color: view === 'history' ? '#fff' : 'inherit', borderBottom: view === 'history' ? '1px solid #fff' : 'none' }}
                >
                    HISTORY
                </span>
                <span
                    onClick={() => setView('branches')}
                    style={{ cursor: 'pointer', color: view === 'branches' ? '#fff' : 'inherit', borderBottom: view === 'branches' ? '1px solid #fff' : 'none' }}
                >
                    BRANCHES
                </span>
                <span
                    onClick={() => setView('diff')}
                    style={{ cursor: 'pointer', color: view === 'diff' ? '#fff' : 'inherit', borderBottom: view === 'diff' ? '1px solid #fff' : 'none' }}
                >
                    WORKING DIFF
                </span>
            </div>

            <div style={contentStyle}>
                {/* SIDEBAR - COMMIT LIST OR BRANCH LIST */}
                <div style={sidebarStyle}>
                    {view === 'history' && (
                        <div style={{ flex: 1, overflowY: 'auto' }}>
                            {history.map(commit => (
                                <div
                                    key={commit.hash}
                                    style={{ padding: '12px 15px', borderBottom: '1px solid #2a2d2e', cursor: 'pointer' }}
                                    className="commit-item"
                                >
                                    <div style={{ fontWeight: 'bold', fontSize: 13, marginBottom: 4, color: '#ccc' }}>{commit.subject}</div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, opacity: 0.6 }}>
                                        <span>{commit.author}</span>
                                        <span>{new Date(commit.date).toLocaleDateString()}</span>
                                    </div>
                                    <div style={{ fontSize: 9, opacity: 0.4, marginTop: 4, fontFamily: 'monospace' }}>{commit.hash.substring(0, 8)}</div>
                                </div>
                            ))}
                        </div>
                    )}

                    {view === 'branches' && (
                        <div style={{ flex: 1, overflowY: 'auto', padding: '15px' }}>
                            <div style={{ marginBottom: 20 }}>
                                <label style={{ display: 'block', fontSize: 10, marginBottom: 8, color: '#569cd6' }}>NEW BRANCH</label>
                                <div style={{ display: 'flex', gap: 5 }}>
                                    <input
                                        style={{ flex: 1, background: '#3c3c3c', border: '1px solid #444', color: '#fff', fontSize: 12, padding: '4px 8px' }}
                                        value={newBranchName}
                                        onChange={e => setNewBranchName(e.target.value)}
                                        placeholder="branch-name"
                                    />
                                    <button style={buttonStyle} onClick={handleCreateBranch}>+</button>
                                </div>
                            </div>

                            <label style={{ display: 'block', fontSize: 10, marginBottom: 8, color: '#569cd6' }}>LOCAL BRANCHES</label>
                            {branches.map(branch => (
                                <div
                                    key={branch}
                                    onClick={() => handleCheckout(branch)}
                                    style={{
                                        padding: '8px 10px',
                                        fontSize: 13,
                                        cursor: 'pointer',
                                        background: branch === currentBranch ? '#094771' : 'transparent',
                                        borderRadius: 3,
                                        marginBottom: 2
                                    }}
                                >
                                    {branch === currentBranch ? '✓ ' : ''} {branch}
                                </div>
                            ))}
                        </div>
                    )}

                    {view === 'diff' && (
                        <div style={{ padding: 15, opacity: 0.7, fontSize: 12 }}>
                            Working directory changes compared to HEAD.
                        </div>
                    )}
                </div>

                {/* MAIN AREA - DETAIL VIEW */}
                <div style={mainAreaStyle}>
                    {view === 'diff' && (
                        <pre style={{ margin: 0, fontFamily: 'Consolas, monospace', fontSize: 12, color: '#d4d4d4', whiteSpace: 'pre-wrap' }}>
                            {diff || 'No changes to display.'}
                        </pre>
                    )}

                    {view === 'history' && history.length > 0 && (
                        <div style={{ opacity: 0.6, fontSize: 13, textAlign: 'center', marginTop: 100 }}>
                            Select a commit to view changes (Coming Soon)
                        </div>
                    )}

                    {view === 'branches' && (
                        <div style={{ padding: '20px', background: '#252526', borderRadius: 4, border: '1px solid #333' }}>
                            <h3 style={{ margin: '0 0 10px 0', fontSize: 14 }}>Branch Management</h3>
                            <p style={{ fontSize: 12, opacity: 0.7 }}>
                                Current branch: <strong>{currentBranch}</strong>
                            </p>
                            <p style={{ fontSize: 12, opacity: 0.7 }}>
                                Use the sidebar to switch between existing local branches or create a new one.
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
