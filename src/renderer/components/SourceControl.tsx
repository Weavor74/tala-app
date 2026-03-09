/**
 * Source Control Panel
 *
 * A specialized sidebar interface for rapid, everyday Git operations.
 * Optimized for a stream-based coding workflow where TALA and the USER share a repository.
 * 
 * **Capabilities:**
 * - **Staging Area**: Visualizes the index vs. working tree (Modified, Unstaged, Staged).
 * - **Commitment**: Provides atomic commit operations with message validation.
 * - **Sync & Collaboration**: Bridges with GitHub for cloud-based synchronization (Pull/Push).
 * - **Issue/PR Integration**: Surface-level visibility into GitHub repository state.
 * 
 * **Conflict Awareness:**
 * - Detects merge conflicts (Status 'U') and delegates resolution to the `ConflictEditor` overlay.
 */
import React, { useState, useEffect } from 'react';

// Styles
const containerStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%', color: '#ccc' };
const inputStyle: React.CSSProperties = { width: '100%', background: '#3c3c3c', border: '1px solid #3c3c3c', color: '#ccc', padding: '6px', fontSize: '13px', outline: 'none', resize: 'none', marginBottom: 10 };
const buttonStyle: React.CSSProperties = { background: '#007acc', color: 'white', border: 'none', padding: '6px 14px', borderRadius: 2, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' };
const fileRowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px', fontSize: 13, cursor: 'pointer' };
const headerStyle: React.CSSProperties = { fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase', padding: '8px', color: '#888', display: 'flex', justifyContent: 'space-between' };

/**
 * Represents a single file in the Git working tree.
 * `status` is a Git status code like 'M', 'A', 'D', '??'.
 */
interface GitStatusItem {
    path: string;
    status: string;
    staged: boolean;
}

interface SourceControlProps {
    onOpenConflict?: (path: string) => void;
}

export const SourceControl: React.FC<SourceControlProps> = ({ onOpenConflict }) => {
    const [status, setStatus] = useState<GitStatusItem[]>([]);
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [gitOk, setGitOk] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [activeTab, setActiveTab] = useState<'changes' | 'projects' | 'issues' | 'prs'>('changes');
    const [repos, setRepos] = useState<any[]>([]);
    const [reposLoading, setReposLoading] = useState(false);
    const [isRepo, setIsRepo] = useState(true);

    // Issues & PRs
    const [issues, setIssues] = useState<any[]>([]);
    const [prs, setPrs] = useState<any[]>([]);
    const [listLoading, setListLoading] = useState(false);
    const [slug, setSlug] = useState<string | null>(null);

    const api = (window as any).tala; // Access IPC

    useEffect(() => {
        checkGit();
        if (gitOk) {
            refresh();
            loadSlug();
        }
    }, [gitOk]);

    useEffect(() => {
        if (activeTab === 'projects') loadRepos();
        if (activeTab === 'issues') loadIssues();
        if (activeTab === 'prs') loadPRs();
    }, [activeTab]);

    const checkGit = async () => {
        if (!api || !api.gitCheck) return;
        const ok = await api.gitCheck();
        setGitOk(ok);
        if (ok) refresh();
    };

    const loadSlug = async () => {
        if (!api || !api.gitGetSlug) return;
        const s = await api.gitGetSlug();
        setSlug(s);
    };

    const refresh = async () => {
        if (!api || !api.gitStatus) return;
        setLoading(true);
        setError('');
        try {
            const data = await api.gitStatus();
            setStatus(data || []);
            setIsRepo(true);
        } catch (e: any) {
            if (e.message.includes('not a git repository')) {
                setIsRepo(false);
            } else {
                setError(e.message);
            }
        } finally {
            setLoading(false);
        }
    };

    const loadIssues = async () => {
        if (!api || !api.gitFetchIssues || !slug) return;
        setListLoading(true);
        try {
            const settings = await api.getSettings();
            let token = '';

            if (settings?.sourceControl?.providers) {
                const p = settings.sourceControl.providers.find((x: any) => x.active);
                if (p) token = p.token || '';
            }

            if (!token) {
                setError('GitHub token required in Settings.');
                setListLoading(false);
                return;
            }

            const [owner, repo] = slug.split('/');
            const data = await api.gitFetchIssues({ owner, repo, token });
            // Filter out PRs (GitHub API returns PRs as issues sometimes)
            setIssues(data.filter((i: any) => !i.pull_request) || []);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setListLoading(false);
        }
    };

    const loadPRs = async () => {
        if (!api || !api.gitFetchPRs || !slug) return;
        setListLoading(true);
        try {
            const settings = await api.getSettings();
            let token = '';

            if (settings?.sourceControl?.providers) {
                const p = settings.sourceControl.providers.find((x: any) => x.active);
                if (p) token = p.token || '';
            }

            if (!token) {
                setError('GitHub token required in Settings.');
                setListLoading(false);
                return;
            }

            const [owner, repo] = slug.split('/');
            const data = await api.gitFetchPRs({ owner, repo, token });
            setPrs(data || []);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setListLoading(false);
        }
    };

    // ... handleInit, handleStage, handleUnstage, handleCommit ... 
    // (We'll assume these existing functions are preserved by the replacement range if we are careful, 
    /**
     * Toast Notification System
     *
     * A reactive, globally-accessible alerting mechanism for ephemeral system feedback.
     * 
     * **Architecture:**
     * - **Provider-Pattern**: Wraps the application root to manage the toast stack.
     * - **Hook Engagement**: Exposes `useToast()` for any child component to trigger alerts.
     * - **Management**: Automatically prioritizes and dismisses messages via timer-based removal.
     * 
     * **Alert Types:**
     * - Success: Affirmative operations (e.g., Save, Deploy).
     * - Error: Critical failures or permission blocks.
     * - Info/Warning: Contextual status updates.
     */
    const handleInit = async () => {
        if (!api || !api.gitInit) return;
        setLoading(true);
        try {
            await api.gitInit();
            refresh();
        } catch (e: any) {
            setError('Init failed: ' + e.message);
            setLoading(false);
        }
    };

    const handleStage = async (file: string) => {
        if (!api || !api.gitStage) return;
        await api.gitStage(file);
        refresh();
    };

    const handleUnstage = async (file: string) => {
        if (!api || !api.gitUnstage) return;
        await api.gitUnstage(file);
        refresh();
    };

    const handleCommit = async () => {
        if (!api || !api.gitCommit || !message.trim()) return;
        setLoading(true);
        try {
            await api.gitCommit(message);
            setMessage('');
            refresh();
        } catch (e: any) {
            setError('Commit failed: ' + e.message);
        } finally {
            setLoading(false);
        }
    };

    const handleSync = async () => {
        if (!api || !api.gitSync) return;
        setIsSyncing(true);
        try {
            // Get credentials from Settings
            const settings = await api.getSettings();
            let token = '';
            let username = '';

            // Look for active provider
            if (settings?.sourceControl?.providers) {
                const p = settings.sourceControl.providers.find((x: any) => x.active);
                if (p) {
                    token = p.token || '';
                    username = p.username || '';
                }
            }

            const res = await api.gitSync({ token, username });
            alert(res);
            refresh();
        } catch (e: any) {
            setError(e.message);
        } finally {
            setIsSyncing(false);
        }
    };

    const loadRepos = async () => {
        if (!api || !api.gitFetchRepos) return;
        setReposLoading(true);
        setError('');
        try {
            const settings = await api.getSettings();
            let token = '';
            let username = '';

            if (settings?.sourceControl?.providers) {
                const p = settings.sourceControl.providers.find((x: any) => x.active);
                if (p) {
                    token = p.token || '';
                    username = p.username || '';
                }
            }

            if (!token && !username) {
                setError('No GitHub credentials found in Settings -> Source Control.');
                setRepos([]);
                return;
            }

            const data = await api.gitFetchRepos({ username, token });
            setRepos(data || []);
        } catch (e: any) {
            setError('Failed to fetch repos: ' + e.message);
        } finally {
            setReposLoading(false);
        }
    };

    if (!gitOk) {
        return (
            <div style={{ padding: 20 }}>
                <p>Git is not detected in the system path.</p>
                <button onClick={checkGit} style={buttonStyle}>Retry</button>
            </div>
        );
    }

    if (!isRepo && activeTab === 'changes') {
        return (
            <div style={containerStyle}>
                <div style={{ padding: 10, borderBottom: '1px solid #333' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 'bold' }}>SOURCE CONTROL</span>
                        <div style={{ display: 'flex', gap: 10 }}>
                            <span onClick={() => setActiveTab('changes')} style={{ cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}>CHANGES</span>
                            <span onClick={() => setActiveTab('projects')} style={{ cursor: 'pointer', fontSize: 11, color: '#888' }}>PROJECTS</span>
                            <span onClick={() => activeTab === 'changes' ? refresh() : loadRepos()} style={{ cursor: 'pointer', fontSize: 14 }}>⟳</span>
                        </div>
                    </div>
                </div>
                <div style={{ padding: 20, textAlign: 'center', color: '#888' }}>
                    <p style={{ fontSize: 13, marginBottom: 15 }}>No Git repository detected.</p>
                    <button onClick={handleInit} style={buttonStyle}>{loading ? 'Initializing...' : 'Initialize Repository'}</button>
                    {error && <div style={{ color: '#f44', fontSize: 11, marginTop: 10 }}>{error}</div>}
                </div>
            </div>
        );
    }

    const staged = status.filter(x => x.staged);
    const changes = status.filter(x => !x.staged);

    const openLink = (url: string) => {
        if (api && api.openExternal) api.openExternal(url);
    };

    const renderHeader = () => (
        <div style={{ padding: 10, borderBottom: '1px solid #333' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 'bold' }}>SOURCE CONTROL</span>
                <span onClick={() => {
                    if (activeTab === 'changes') refresh();
                    else if (activeTab === 'projects') loadRepos();
                    else if (activeTab === 'issues') loadIssues();
                    else if (activeTab === 'prs') loadPRs();
                }} style={{ cursor: 'pointer', fontSize: 14 }}>⟳</span>
            </div>
            <div style={{ display: 'flex', gap: 15, fontSize: 10, color: '#ccc' }}>
                <span onClick={() => setActiveTab('changes')} style={{ cursor: 'pointer', fontWeight: activeTab === 'changes' ? 'bold' : 'normal', borderBottom: activeTab === 'changes' ? '1px solid white' : 'none' }}>CHANGES</span>
                <span onClick={() => setActiveTab('projects')} style={{ cursor: 'pointer', fontWeight: activeTab === 'projects' ? 'bold' : 'normal', borderBottom: activeTab === 'projects' ? '1px solid white' : 'none' }}>PROJECTS</span>
                <span onClick={() => setActiveTab('issues')} style={{ cursor: 'pointer', fontWeight: activeTab === 'issues' ? 'bold' : 'normal', borderBottom: activeTab === 'issues' ? '1px solid white' : 'none' }}>ISSUES</span>
                <span onClick={() => setActiveTab('prs')} style={{ cursor: 'pointer', fontWeight: activeTab === 'prs' ? 'bold' : 'normal', borderBottom: activeTab === 'prs' ? '1px solid white' : 'none' }}>PRS</span>
            </div>
        </div>
    );

    return (
        <div style={containerStyle}>
            {renderHeader()}

            {/* CHANGES TAB */}
            {activeTab === 'changes' && (
                <>
                    <textarea
                        style={inputStyle}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder="Message (Ctrl+Enter to commit)"
                        rows={3}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && e.ctrlKey) handleCommit();
                        }}
                    />
                    <div style={{ display: 'flex', gap: 5, padding: '0 10px 10px 10px' }}>
                        <button
                            onClick={handleCommit}
                            style={{ ...buttonStyle, flex: 1, opacity: (loading || !message || staged.length === 0) ? 0.5 : 1 }}
                            disabled={loading || !message || staged.length === 0}
                        >
                            {loading ? '...' : 'Commit'}
                        </button>
                        <button
                            onClick={handleSync}
                            style={{ ...buttonStyle, background: '#2d2d2d', border: '1px solid #444', opacity: (loading || isSyncing) ? 0.5 : 1 }}
                            disabled={loading || isSyncing}
                        >
                            {isSyncing ? 'Syncing...' : 'Sync'}
                        </button>
                    </div>
                    {error && <div style={{ color: '#f44', fontSize: 11, padding: '0 10px' }}>{error}</div>}

                    <div style={{ flex: 1, overflowY: 'auto' }}>
                        {/* STAGED */}
                        {staged.length > 0 && (
                            <div>
                                <div style={headerStyle}>
                                    <span>STAGED CHANGES ({staged.length})</span>
                                </div>
                                {staged.map(f => (
                                    <div key={'staged-' + f.path} style={fileRowStyle} className="file-item">
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
                                        <span onClick={() => handleUnstage(f.path)} style={{ cursor: 'pointer', opacity: 0.7 }}>-</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* CHANGES */}
                        <div>
                            <div style={headerStyle}>
                                <span>CHANGES ({changes.length})</span>
                            </div>
                            {changes.length === 0 && staged.length === 0 && (
                                <div style={{ padding: 10, fontSize: 12, color: '#666', fontStyle: 'italic', textAlign: 'center' }}>
                                    No changes detected.
                                </div>
                            )}
                            {changes.map(f => (
                                <div key={'change-' + f.path} style={fileRowStyle} className="file-item">
                                    <span style={{ color: f.status === '?' ? '#78dce8' : f.status === 'U' ? '#f44' : '#e2b93d', marginRight: 5 }}>{f.status}</span>
                                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
                                    {f.status === 'U' ? (
                                        <span
                                            onClick={() => onOpenConflict && onOpenConflict(f.path)}
                                            style={{ fontSize: 10, background: '#f44', color: 'white', padding: '1px 4px', borderRadius: 2, cursor: 'pointer' }}
                                        >Resolve</span>
                                    ) : (
                                        <span onClick={() => handleStage(f.path)} style={{ cursor: 'pointer', opacity: 0.7 }}>+</span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                </>
            )}

            {/* PROJECTS TAB */}
            {activeTab === 'projects' && (
                <div style={{ flex: 1, overflowY: 'auto' }}>
                    {reposLoading && <div style={{ padding: 10, fontStyle: 'italic', opacity: 0.7 }}>Loading repositories...</div>}
                    {!reposLoading && repos.length === 0 && <div style={{ padding: 10, opacity: 0.7 }}>No repositories found.</div>}
                    {repos.map(r => (
                        <div key={r.id} className="file-item" style={{ ...fileRowStyle, flexDirection: 'column', alignItems: 'flex-start', borderBottom: '1px solid #2a2d2e', padding: '8px 15px' }}>
                            <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between' }}>
                                <span style={{ fontWeight: 'bold', color: r.private ? '#e2b93d' : '#ccc' }}>{r.name}</span>
                                {r.private && <span style={{ fontSize: 9, border: '1px solid #555', padding: '0 4px', borderRadius: 2 }}>PVT</span>}
                            </div>
                            <div style={{ fontSize: 10, color: '#777', marginTop: 2 }}>{r.description || 'No description'}</div>
                            <div style={{ fontSize: 9, color: '#555', marginTop: 4 }}>Last updated: {new Date(r.updated_at).toLocaleDateString()}</div>
                        </div>
                    ))}
                </div>
            )}

            {/* ISSUES TAB */}
            {activeTab === 'issues' && (
                <div style={{ flex: 1, overflowY: 'auto' }}>
                    {!slug && <div style={{ padding: 10, color: '#f44' }}>Current repo has no 'origin' or is not on GitHub.</div>}
                    {slug && (
                        <>
                            <div style={{ padding: '5px 10px', fontSize: 11, color: '#888' }}>{slug}</div>
                            {listLoading && <div style={{ padding: 10 }}>Loading...</div>}
                            {!listLoading && issues.length === 0 && <div style={{ padding: 10, opacity: 0.7 }}>No open issues.</div>}
                            {issues.map(i => (
                                <div key={i.id} style={{ padding: '8px 15px', borderBottom: '1px solid #2a2d2e', cursor: 'pointer' }} onClick={() => openLink(i.html_url)}>
                                    <div style={{ fontWeight: 'bold', fontSize: 12, marginBottom: 2 }}>#{i.number} {i.title}</div>
                                    <div style={{ fontSize: 10, color: '#666' }}>opened by {i.user.login}</div>
                                </div>
                            ))}
                        </>
                    )}
                </div>
            )}

            {/* PRs TAB */}
            {activeTab === 'prs' && (
                <div style={{ flex: 1, overflowY: 'auto' }}>
                    {!slug && <div style={{ padding: 10, color: '#f44' }}>Current repo has no 'origin' or is not on GitHub.</div>}
                    {slug && (
                        <>
                            <div style={{ padding: '5px 10px', fontSize: 11, color: '#888' }}>{slug}</div>
                            {listLoading && <div style={{ padding: 10 }}>Loading...</div>}
                            {!listLoading && prs.length === 0 && <div style={{ padding: 10, opacity: 0.7 }}>No open PRs.</div>}
                            {prs.map(p => (
                                <div key={p.id} style={{ padding: '8px 15px', borderBottom: '1px solid #2a2d2e', cursor: 'pointer' }} onClick={() => openLink(p.html_url)}>
                                    <div style={{ fontWeight: 'bold', fontSize: 12, marginBottom: 2 }}>#{p.number} {p.title}</div>
                                    <div style={{ fontSize: 10, color: '#666' }}>opened by {p.user.login}</div>
                                </div>
                            ))}
                        </>
                    )}
                </div>
            )}
        </div>
    );
};
