/**
 * Settings Panel (~2700 lines)
 *
 * The master configuration UI for the entire Tala application.
 * Renders a multi-tab settings page with the following sections:
 *
 * - **General** — Deployment mode (USB/Local/Remote).
 * - **Inference** — Manage LLM provider instances (local Ollama, cloud OpenAI/Anthropic/etc.),
 *   scan for local engines, install Ollama, configure priorities.
 * - **Storage** — Configure RAG vector database providers (ChromaDB, Pinecone, Supabase, etc.).
 * - **Backup** — Schedule automatic workspace backups.
 * - **Authentication** — Local password, SSO login (Google/GitHub/Microsoft),
 *   developer API keys (Discord, OAuth client secrets).
 * - **Server** — Runtime configuration (Node/Python), remote SSH deployment.
 * - **Agent** — Create/edit agent personality profiles (system prompt, temperature,
 *   astro birth data, rules, workflow paths, MCP server assignments, guardrails).
 * - **Source Control** — Git provider credentials (GitHub, GitLab, Bitbucket, generic).
 * - **System** — Custom environment variables for the `system.env` block.
 * - **MCP Servers** — Add/edit/remove Model Context Protocol server definitions.
 * - **Functions** — CRUD for user-defined custom tool/function definitions.
 * - **Guardrails** — Create/edit content safety rules with scope (global/agent/session).
 * - **Workflows** — Visual workflow editor integration (opens `WorkflowEditor`).
 *
 * Data is loaded from `app_settings.json` via `tala.getSettings()`, migrated
 * with `migrateSettings()`, edited locally in React state, and persisted
 * via `tala.saveSettings(data)` on explicit save.
 */
import { useState, useEffect } from 'react';
import { DEFAULT_SETTINGS, migrateSettings } from './settingsData';
import type { AppSettings, InferenceInstance, SourceControlProvider } from './settingsData';
import 'xterm/css/xterm.css';
import { WorkflowEditor } from './components/WorkflowEditor';
import { GitView } from './components/GitView';
import { WORKFLOW_TEMPLATES } from './catalog/WorkflowTemplates';

// Styles
const containerStyle = { padding: '30px', maxWidth: '900px', margin: '0 auto', color: '#ccc', height: '100%', display: 'flex', flexDirection: 'column' as const };
const headerStyle = { borderBottom: '1px solid #333', paddingBottom: 15, marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' };
const tabContainerStyle = { display: 'flex', borderBottom: '1px solid #333', marginBottom: 20, flexWrap: 'wrap' as const, gap: '4px' };
const tabStyle = (active: boolean) => ({
    padding: '8px 12px',
    cursor: 'pointer',
    color: active ? '#fff' : '#888',
    background: active ? 'rgba(0, 122, 204, 0.1)' : 'transparent',
    borderBottom: active ? '2px solid #007acc' : '2px solid transparent',
    fontWeight: active ? '700' : '500',
    fontSize: '10px',
    textTransform: 'uppercase' as const,
    letterSpacing: '1px',
    transition: '0.2s all',
    whiteSpace: 'nowrap' as const,
    borderRadius: '4px 4px 0 0'
});

const sectionStyle = { marginBottom: 30, animation: 'fadeIn 0.2s', background: 'rgba(30, 30, 30, 0.4)', padding: '20px', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.05)', backdropFilter: 'blur(10px)' };
const labelStyle = { display: 'block', fontSize: '10px', fontWeight: '800', color: '#888', marginBottom: '8px', textTransform: 'uppercase' as const, letterSpacing: '1.5px' };
const inputStyle = { width: '100%', background: '#121212', border: '1px solid #333', padding: '12px', color: '#eee', fontSize: '13px', outline: 'none', marginBottom: 15, borderRadius: '4px', transition: 'border-color 0.2s' };
const selectStyle = { ...inputStyle, cursor: 'pointer' };

const Field = ({ label, value, onChange, placeholder, type = "text" }: any) => (
    <div style={{ marginBottom: 15 }}>
        <label style={labelStyle}>{label}</label>
        <input
            type={type}
            style={inputStyle}
            value={value || ''}
            onChange={onChange}
            placeholder={placeholder}
            onFocus={(e) => e.target.style.borderColor = '#007acc'}
            onBlur={(e) => e.target.style.borderColor = '#333'}
        />
    </div>
);

// Helper Components
const ProgressBar = ({ progress, label }: { progress: number, label: string }) => (
    <div style={{ marginTop: 15 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#aaa', marginBottom: 5 }}>
            <span>{label.toUpperCase()}</span>
            <span>{progress}%</span>
        </div>
        <div style={{ background: '#333', height: 6, borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: '#007acc', transition: 'width 0.2s' }} />
        </div>
    </div>
);

const ModeSwitcher = ({ mode, onChange }: { mode: 'usb' | 'local' | 'remote', onChange: (m: 'usb' | 'local' | 'remote') => void }) => (
    <div style={{ display: 'flex', background: '#333', padding: 4, borderRadius: 4, marginBottom: 20, width: 'fit-content' }}>
        {[
            { id: 'usb', label: 'USB (ISOLATED)' },
            { id: 'local', label: 'LOCAL (SYSTEM)' },
            { id: 'remote', label: 'REMOTE (CLOUD)' }
        ].map(m => (
            <div
                key={m.id}
                onClick={() => onChange(m.id as any)}
                style={{
                    padding: '6px 20px',
                    cursor: 'pointer',
                    background: mode === m.id ? '#007acc' : 'transparent',
                    color: mode === m.id ? 'white' : '#aaa',
                    borderRadius: 2,
                    fontSize: 10,
                    fontWeight: 'bold',
                    transition: '0.2s all'
                }}
            >
                {m.label}
            </div>
        ))}
    </div>
);

export const Settings = () => {
    const api = (window as any).tala;
    const [scope, setScope] = useState<'global' | 'workspace'>('global');
    const [globalSettings, setGlobalSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
    const [workspaceSettings, setWorkspaceSettings] = useState<Partial<AppSettings>>({});
    const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS); // Interactive view

    const [activeTab, setActiveTab] = useState<'auth' | 'storage' | 'backup' | 'inference' | 'server' | 'agent' | 'sourceControl' | 'workflows' | 'system' | 'guardrails'>('inference');
    const [workflowSubTab, setWorkflowSubTab] = useState<'workflow' | 'mcp' | 'function'>('workflow');
    const [status, setStatus] = useState('');
    const [downloading, setDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [downloadType, setDownloadType] = useState<'binary' | 'model' | 'python'>('binary');


    const [systemInfo, setSystemInfo] = useState<any>(null);
    const [selectedMcpId, setSelectedMcpId] = useState<string | null>(null);
    const [mcpCapabilities, setMcpCapabilities] = useState<{ tools: any[], resources: any[] } | null>(null);
    const [functions, setFunctions] = useState<any[]>([]);
    const [selectedFunc, setSelectedFunc] = useState<string | null>(null); // func name
    const [functionSearch, setFunctionSearch] = useState('');
    const [mcpSearch, setMcpSearch] = useState('');

    const [workflows, setWorkflows] = useState<any[]>([]);
    const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
    const [showTemplates, setShowTemplates] = useState(false);

    const [installingEngine, setInstallingEngine] = useState<string | null>(null);
    const [installProgress, setInstallProgress] = useState(0);
    const [scSubTab, setScSubTab] = useState<'providers' | 'advanced'>('providers');

    // Deep merge helper
    const deepMerge = (target: any, source: any): any => {
        const output = { ...target };
        if (isObject(target) && isObject(source)) {
            Object.keys(source).forEach(key => {
                if (isObject(source[key])) {
                    if (!(key in target)) Object.assign(output, { [key]: source[key] });
                    else output[key] = deepMerge(target[key], source[key]);
                } else {
                    Object.assign(output, { [key]: source[key] });
                }
            });
        }
        return output;
    };
    const isObject = (item: any) => (item && typeof item === 'object' && !Array.isArray(item));

    // Re-calculate effective settings when scope or underlying data changes
    useEffect(() => {
        if (scope === 'global') {
            setSettings(globalSettings);
        } else {
            setSettings(deepMerge(globalSettings, workspaceSettings));
        }
    }, [scope, globalSettings, workspaceSettings]);

    // Listen for install progress
    useEffect(() => {
        if (!api?.onInstallProgress) return;
        const removeListener = api.onInstallProgress((data: any) => {
            if (data.progress !== undefined) {
                setInstallProgress(data.progress);
                if (data.progress === 100) {
                    setTimeout(() => setInstallingEngine(null), 2000);
                }
            }
        });
        return () => removeListener();
    }, []);

    // MCP Capability Fetcher
    useEffect(() => {
        if (selectedMcpId) {
            setMcpCapabilities(null);
            // find server to check if enabled
            const srv = settings.mcpServers?.find((s: any) => s.id === selectedMcpId);
            if (srv && srv.enabled) {
                // Check if preload is updated (Requires App Restart)
                // @ts-ignore
                if (typeof window.tala.getMcpCapabilities === 'function') {
                    // @ts-ignore
                    window.tala.getMcpCapabilities(selectedMcpId)
                        .then((data: any) => setMcpCapabilities(data))
                        .catch((err: any) => console.error(err));
                } else {
                    console.warn("getMcpCapabilities missing. App restart required.");
                    setMcpCapabilities({ tools: [], resources: [] }); // Safe fallback
                }
            }
        } else {
            setMcpCapabilities(null);
        }
    }, [selectedMcpId, settings.mcpServers]); // Re-fetch if enabled status changes

    // Load Functions
    const loadFunctions = () => {
        // @ts-ignore
        if (window.tala && window.tala.getFunctions) {
            // @ts-ignore
            window.tala.getFunctions().then((fns: any) => setFunctions(fns)).catch(console.error);
        }
    };

    useEffect(() => {
        if (activeTab === 'workflows' && workflowSubTab === 'function') {
            loadFunctions();
        }
    }, [activeTab, workflowSubTab]);

    const [systemSubTab, setSystemSubTab] = useState<'env' | 'guardrails'>('env');

    // Load Workflows
    const loadWorkflows = () => {
        // @ts-ignore
        if (window.tala && window.tala.getWorkflows) {
            // @ts-ignore
            window.tala.getWorkflows().then((wfs: any) => setWorkflows(wfs)).catch(console.error);
        }
    };

    useEffect(() => {
        if (activeTab === 'workflows' && workflowSubTab === 'workflow') {
            loadWorkflows();
        }
    }, [activeTab, workflowSubTab]);


    // Load Settings
    useEffect(() => {
        const load = async () => {
            const api = (window as any).tala;
            if (api && api.getSettings) {
                const loaded = await api.getSettings();
                if (loaded) {
                    // Check if new format { global, workspace } or old format
                    let g = loaded;
                    let w = {};
                    if (loaded.global) {
                        g = loaded.global;
                        w = loaded.workspace || {};
                    }

                    const migrated = migrateSettings(g);
                    setGlobalSettings(migrated);
                    setWorkspaceSettings(w);
                    // Initial set will trigger the effect above
                }
            }
            if (api && api.getSystemInfo) {
                const info = await api.getSystemInfo();
                setSystemInfo(info);
            }
        };
        load();
    }, []);

    // Save Settings
    const handleSave = async () => {
        setStatus('Saving Configuration...');
        const api = (window as any).tala;
        if (api) {
            if (api.saveSettings) await api.saveSettings(globalSettings);
            if (api.saveWorkspaceSettings) await api.saveWorkspaceSettings(workspaceSettings);

            setStatus('Configuration Locked.');
            setTimeout(() => setStatus(''), 2000);
        } else {
            setStatus('Error: API bridge missing.');
        }
    };

    const handleLogin = async (provider: 'google' | 'github' | 'microsoft' | 'apple') => {
        setStatus('Authenticating...');
        const api = (window as any).tala;
        if (api && api.login) {
            try {
                const result = await api.login(provider);
                if (result && result.success) {
                    const newAuth = {
                        ...settings.auth,
                        cloudProvider: provider,
                        cloudToken: result.token,
                        cloudRefreshToken: result.refreshToken,
                        cloudEmail: result.email,
                        cloudName: result.name,
                        cloudAvatar: result.avatar
                    };

                    // Update Global Settings by default for Auth
                    setGlobalSettings(prev => ({
                        ...prev,
                        auth: { ...prev.auth, ...newAuth }
                    }));

                    // Auto-save after login
                    await api.saveSettings({
                        ...globalSettings,
                        auth: { ...globalSettings.auth, ...newAuth }
                    });
                    setStatus('Authentication Successful.');
                } else {
                    setStatus(`Auth Failed: ${result?.error || 'Unknown Error'}`);
                }
            } catch (e: any) {
                setStatus(`Auth Error: ${e.message}`);
            }
        }
    };

    const update = (...args: any[]) => {
        if (scope === 'global') {
            if (args.length === 2) {
                const [section, val] = args;
                setGlobalSettings(prev => ({ ...prev, [section]: val }));
            } else {
                const [section, key, val] = args;
                setGlobalSettings(prev => ({
                    ...prev,
                    [section]: {
                        ...(prev[section as keyof AppSettings] as any),
                        [key]: val
                    }
                }));
            }
        } else {
            // Workspace Scope - Update Partial
            if (args.length === 2) {
                const [section, val] = args;
                setWorkspaceSettings(prev => ({ ...prev, [section]: val }));
            } else {
                const [section, key, val] = args;
                setWorkspaceSettings(prev => {
                    const prevSection = prev[section as keyof AppSettings] || {};
                    return {
                        ...prev,
                        [section]: {
                            ...(prevSection as any),
                            [key]: val
                        }
                    };
                });
            }
        }
    };

    return (
        <div style={containerStyle}>
            <div style={headerStyle}>
                <div>
                    <h1 style={{ margin: 0, fontSize: 24, color: '#fff' }}>SYSTEM CONFIGURATION</h1>
                    <div style={{ marginTop: 10 }}>
                        <ModeSwitcher
                            mode={settings.deploymentMode}
                            onChange={(m) => update('deploymentMode', m)}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                            <span style={{ fontSize: 10, fontWeight: 'bold', color: '#888' }}>SCOPE:</span>
                            <div style={{ display: 'flex', background: '#333', padding: 4, borderRadius: 4, width: 'fit-content' }}>
                                <div
                                    onClick={() => setScope('global')}
                                    style={{
                                        padding: '6px 20px',
                                        cursor: 'pointer',
                                        background: scope === 'global' ? '#007acc' : 'transparent',
                                        color: scope === 'global' ? 'white' : '#aaa',
                                        borderRadius: 2,
                                        fontSize: 10,
                                        fontWeight: 'bold',
                                        transition: '0.2s all'
                                    }}
                                >
                                    GLOBAL
                                </div>
                                <div
                                    onClick={() => setScope('workspace')}
                                    style={{
                                        padding: '6px 20px',
                                        cursor: 'pointer',
                                        background: scope === 'workspace' ? '#d7ba7d' : 'transparent',
                                        color: scope === 'workspace' ? '#1e1e1e' : '#aaa',
                                        borderRadius: 2,
                                        fontSize: 10,
                                        fontWeight: 'bold',
                                        transition: '0.2s all'
                                    }}
                                >
                                    WORKSPACE
                                </div>
                            </div>
                            {scope === 'workspace' && (
                                <span style={{ fontSize: 10, color: '#d7ba7d', fontStyle: 'italic' }}>
                                    Editing .tala/settings.json
                                </span>
                            )}
                        </div>
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                    <button
                        onClick={async () => {
                            if (api && api.exportSettings) {
                                const res = await api.exportSettings();
                                if (res) setStatus('Settings Exported Successfully.');
                                else setStatus('Export Cancelled or Failed.');
                                setTimeout(() => setStatus(''), 2000);
                            }
                        }}
                        style={{ background: '#333', color: '#ccc', border: '1px solid #555', padding: '8px 16px', borderRadius: 2, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}
                        title="Export Global Settings to JSON"
                    >
                        EXPORT
                    </button>
                    <button
                        onClick={async () => {
                            if (api && api.importSettings) {
                                if (!confirm("Importing settings will overwrite your current Global configuration. Continue?")) return;
                                const res = await api.importSettings();
                                if (res.success && res.settings) {
                                    setGlobalSettings(res.settings);
                                    setSettings(scope === 'global' ? res.settings : deepMerge(res.settings, workspaceSettings));
                                    setStatus('Settings Imported Successfully.');
                                } else {
                                    if (res.error) setStatus(`Import Failed: ${res.error}`);
                                }
                                setTimeout(() => setStatus(''), 2000);
                            }
                        }}
                        style={{ background: '#333', color: '#ccc', border: '1px solid #555', padding: '8px 16px', borderRadius: 2, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}
                        title="Import Global Settings from JSON"
                    >
                        IMPORT
                    </button>
                    <button
                        onClick={handleSave}
                        style={{ background: '#007acc', color: 'white', border: 'none', padding: '8px 24px', borderRadius: 2, cursor: 'pointer', fontWeight: 'bold', fontSize: 11 }}
                    >
                        APPLY CHANGES
                    </button>
                </div>
            </div>

            {/* TABS */}
            <div style={tabContainerStyle}>
                {[
                    { id: 'inference', label: 'Inference' },
                    { id: 'agent', label: 'Agent' },
                    { id: 'workflows', label: 'Workflows' },
                    { id: 'guardrails', label: 'Guardrails' },
                    { id: 'system', label: 'System' },
                    { id: 'sourceControl', label: 'Git' },
                    { id: 'storage', label: 'Storage' },
                    { id: 'backup', label: 'Backup' },
                    { id: 'server', label: 'Runtime' },
                    { id: 'auth', label: 'Auth' }
                ].map(tab => (
                    <div
                        key={tab.id}
                        style={tabStyle(activeTab === tab.id)}
                        onClick={() => setActiveTab(tab.id as any)}
                    >
                        {tab.label}
                    </div>
                ))}
            </div>

            {/* CONTENT AREA */}
            <div style={{ flex: 1, overflowY: 'auto' }}>

                {/* AGENT TAB - Profile Switching */}
                {activeTab === 'agent' && settings.agent && (
                    <div style={sectionStyle}>
                        {/* CAPABILITIES TOGGLES */}
                        <div style={{ marginBottom: 30, background: '#1e1e1e', padding: 15, borderRadius: 4, border: '1px solid #3e3e42' }}>
                            <h3 style={{ margin: '0 0 15px 0', color: '#dcdcaa', fontSize: 13, borderBottom: '1px solid #333', paddingBottom: 10 }}>AGENT SUBSYSTEMS</h3>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                                    <input
                                        type="checkbox"
                                        style={{ marginTop: 2, transform: 'scale(1.2)' }}
                                        checked={settings.agent.capabilities?.memory !== false}
                                        onChange={(e) => update('agent', 'capabilities', { ...settings.agent.capabilities, memory: e.target.checked })}
                                    />
                                    <div>
                                        <div style={{ fontWeight: 'bold', fontSize: 12, color: '#ccc' }}>Memory (RAG)</div>
                                        <div style={{ fontSize: 10, color: '#888', marginTop: 2 }}>Enable long-term context retrieval. Disable to save resources or prevent confusion on small models.</div>
                                    </div>
                                </label>
                                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                                    <input
                                        type="checkbox"
                                        style={{ marginTop: 2, transform: 'scale(1.2)' }}
                                        checked={settings.agent.capabilities?.emotions !== false}
                                        onChange={(e) => update('agent', 'capabilities', { ...settings.agent.capabilities, emotions: e.target.checked })}
                                    />
                                    <div>
                                        <div style={{ fontWeight: 'bold', fontSize: 12, color: '#ccc' }}>Astro Emotion</div>
                                        <div style={{ fontSize: 10, color: '#888', marginTop: 2 }}>Enable emotional state simulation. Disable for a purely logical assistant.</div>
                                    </div>
                                </label>
                            </div>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                            <div>
                                <h3 style={{ margin: 0, color: '#dcdcaa' }}>AGENT IDENTITY</h3>
                                <p style={{ margin: 0, fontSize: 11, opacity: 0.7 }}>Manage personas and behavioral rulesets.</p>
                            </div>
                            <button
                                onClick={() => {
                                    const newProfile = {
                                        id: `agent-${Math.random().toString(36).substr(2, 5)}`,
                                        name: 'New Agent',
                                        description: 'A new custom personality.',
                                        systemPrompt: 'You are a helpful AI assistant.',
                                        temperature: 0.7,
                                        rules: { global: 'Be helpful and concise.', workspace: '' },
                                        workflows: { globalPath: './workflows/global', workspacePath: './workflows' },
                                        mcp: { global: [], workspace: [] }
                                    };
                                    update('agent', 'profiles', [...settings.agent.profiles, newProfile]);
                                }}
                                style={{ background: '#2d2d2d', border: '1px solid #444', color: '#fff', padding: '6px 12px', fontSize: 11, cursor: 'pointer' }}
                            >
                                + ADD AGENT
                            </button>
                        </div>

                        <div style={{ marginBottom: 30 }}>
                            <label style={labelStyle}>ACTIVE PROFILE</label>
                            <select
                                style={{ ...inputStyle, cursor: 'pointer', border: '1px solid #007acc' }}
                                value={settings.agent.activeProfileId}
                                onChange={e => update('agent', 'activeProfileId', e.target.value)}
                            >
                                {settings.agent.profiles.map(p => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </select>
                        </div>

                        {/* PROFILE LIST */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                            {settings.agent.profiles.map((p) => (
                                <div key={p.id} style={{ background: '#252526', border: '1px solid #3e3e42', padding: 20, borderRadius: 4 }}>

                                    {/* HEADER: Name + ID + Delete */}
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 15 }}>
                                        <div style={{ flex: 1, marginRight: 20 }}>
                                            <input
                                                value={p.name}
                                                onChange={e => {
                                                    const list = [...settings.agent.profiles];
                                                    const pg = list.find(x => x.id === p.id);
                                                    if (pg) pg.name = e.target.value;
                                                    update('agent', 'profiles', list);
                                                }}
                                                style={{ ...inputStyle, fontSize: 16, fontWeight: 'bold', marginBottom: 5 }}
                                                placeholder="Agent Name"
                                            />
                                            <div style={{ fontSize: 10, color: '#666' }}>ID: {p.id}</div>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center' }}>
                                            <button
                                                onClick={async () => {
                                                    console.log("[Settings] Exporting agent:", p.id);
                                                    if (!api || !api.exportAgentToPython) {
                                                        alert("Error: Export function not found in API bridge. Please restart the application.");
                                                        return;
                                                    }
                                                    try {
                                                        const result = await api.exportAgentToPython(p.id);
                                                        console.log("[Settings] Export result:", result);
                                                        if (result && result.success) {
                                                            alert(`Agent "${p.name}" exported successfully to:\n${result.path}`);
                                                        } else if (result && result.error) {
                                                            alert(`Export failed: ${result.error}`);
                                                        } else if (result && result.canceled) {
                                                            console.log("[Settings] Export canceled by user.");
                                                        }
                                                    } catch (err: any) {
                                                        console.error("[Settings] Export error:", err);
                                                        alert(`Critical Export Error: ${err.message}`);
                                                    }
                                                }}
                                                style={{ height: 'fit-content', color: '#007acc', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 10, marginRight: 15, display: 'flex', alignItems: 'center', gap: 4, opacity: 0.8 }}
                                                title="Export to standalone Python project"
                                            >
                                                <span style={{ fontSize: 12 }}>📤</span> EXPORT
                                            </button>
                                            <button
                                                onClick={() => {
                                                    if (settings.agent.profiles.length <= 1) {
                                                        alert("Cannot delete the last profile.");
                                                        return;
                                                    }
                                                    const list = settings.agent.profiles.filter(x => x.id !== p.id);
                                                    update('agent', 'profiles', list);
                                                    // If we deleted the active one, switch to first available
                                                    if (p.id === settings.agent.activeProfileId) {
                                                        update('agent', 'activeProfileId', list[0].id);
                                                    }
                                                }}
                                                style={{ height: 'fit-content', color: '#ff4444', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 18 }}
                                                title="Delete Profile"
                                            >
                                                ×
                                            </button>
                                        </div>
                                    </div>

                                    {/* DETAILS */}
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 15 }}>
                                        <div>
                                            <label style={labelStyle}>DESCRIPTION</label>
                                            <input
                                                style={inputStyle}
                                                value={p.description || ''}
                                                onChange={e => {
                                                    const list = [...settings.agent.profiles];
                                                    const pg = list.find(x => x.id === p.id);
                                                    if (pg) pg.description = e.target.value;
                                                    update('agent', 'profiles', list);
                                                }}
                                                placeholder="Short description of this agent's role"
                                            />
                                        </div>

                                        <div>
                                            <label style={labelStyle}>SYSTEM PROMPT</label>
                                            <textarea
                                                style={{ ...inputStyle, height: 100, fontFamily: 'Consolas, monospace', resize: 'vertical' }}
                                                value={p.systemPrompt}
                                                onChange={e => {
                                                    const list = [...settings.agent.profiles];
                                                    const pg = list.find(x => x.id === p.id);
                                                    if (pg) pg.systemPrompt = e.target.value;
                                                    update('agent', 'profiles', list);
                                                }}
                                                placeholder="The core instructions for the LLM..."
                                            />
                                        </div>

                                        <div>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <label style={labelStyle}>TEMPERATURE</label>
                                                <span style={{ fontSize: 11, color: '#007acc', fontWeight: 'bold' }}>{p.temperature || 0.7}</span>
                                            </div>
                                            <input
                                                type="range"
                                                min="0"
                                                max="1"
                                                step="0.1"
                                                style={{ width: '100%', cursor: 'pointer', margin: '5px 0 15px 0' }}
                                                value={p.temperature || 0.7}
                                                onChange={e => {
                                                    const list = [...settings.agent.profiles];
                                                    const pg = list.find(x => x.id === p.id);
                                                    if (pg) pg.temperature = parseFloat(e.target.value);
                                                    update('agent', 'profiles', list);
                                                }}
                                            />
                                        </div>

                                        <div>
                                            <label style={labelStyle}>GLOBAL RULES (Memory/Context)</label>
                                            <textarea
                                                style={{ ...inputStyle, height: 80, fontFamily: 'Consolas, monospace', resize: 'vertical' }}
                                                value={p.rules?.global || ''}
                                                onChange={e => {
                                                    const list = [...settings.agent.profiles];
                                                    const pg = list.find(x => x.id === p.id);
                                                    if (pg) {
                                                        if (!pg.rules) pg.rules = { global: '', workspace: '' };
                                                        pg.rules.global = e.target.value;
                                                    }
                                                    update('agent', 'profiles', list);
                                                }}
                                                placeholder="Permanent rules injected into context..."
                                            />
                                        </div>

                                        {/* ASTRO DATA */}
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, background: '#1e1e1e', padding: 10, borderRadius: 4 }}>
                                            <div style={{ gridColumn: 'span 2', fontSize: 11, color: '#aaa', marginBottom: 5 }}>ASTRO EMOTION ENGINE CONFIG</div>
                                            <div>
                                                <label style={labelStyle}>BIRTH DATE (ISO)</label>
                                                <input
                                                    style={{ ...inputStyle, marginBottom: 0 }}
                                                    value={p.astroBirthDate || ''}
                                                    onChange={e => {
                                                        const list = [...settings.agent.profiles];
                                                        const pg = list.find(x => x.id === p.id);
                                                        if (pg) pg.astroBirthDate = e.target.value;
                                                        update('agent', 'profiles', list);
                                                    }}
                                                    placeholder="1990-01-01T12:00:00"
                                                />
                                            </div>
                                            <div>
                                                <label style={labelStyle}>BIRTH CITY</label>
                                                <input
                                                    style={{ ...inputStyle, marginBottom: 0 }}
                                                    value={p.astroBirthPlace || ''}
                                                    onChange={e => {
                                                        const list = [...settings.agent.profiles];
                                                        const pg = list.find(x => x.id === p.id);
                                                        if (pg) pg.astroBirthPlace = e.target.value;
                                                        update('agent', 'profiles', list);
                                                    }}
                                                    placeholder="London"
                                                />
                                            </div>
                                        </div>

                                        {/* WORKFLOWS & MCP ASSIGNMENT */}
                                        <div style={{ marginTop: 15, background: '#1e1e1e', padding: '12px', borderRadius: 4 }}>
                                            <div style={{ fontSize: 11, color: '#aaa', marginBottom: 10, fontWeight: 'bold' }}>CAPABILITIES & TOOLSETS</div>

                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 15 }}>
                                                <div>
                                                    <label style={{ ...labelStyle, fontSize: 9 }}>GLOBAL WORKFLOW PATH</label>
                                                    <input
                                                        style={{ ...inputStyle, padding: '8px', fontSize: 11, marginBottom: 0 }}
                                                        value={p.workflows?.globalPath || ''}
                                                        onChange={e => {
                                                            const list = [...settings.agent.profiles];
                                                            const pg = list.find(x => x.id === p.id);
                                                            if (pg) {
                                                                if (!pg.workflows) pg.workflows = { globalPath: '', workspacePath: '' };
                                                                pg.workflows.globalPath = e.target.value;
                                                            }
                                                            update('agent', 'profiles', list);
                                                        }}
                                                        placeholder="./workflows"
                                                    />
                                                </div>
                                                <div>
                                                    <label style={{ ...labelStyle, fontSize: 9 }}>WORKSPACE PATH</label>
                                                    <input
                                                        style={{ ...inputStyle, padding: '8px', fontSize: 11, marginBottom: 0 }}
                                                        value={p.workflows?.workspacePath || ''}
                                                        onChange={e => {
                                                            const list = [...settings.agent.profiles];
                                                            const pg = list.find(x => x.id === p.id);
                                                            if (pg) {
                                                                if (!pg.workflows) pg.workflows = { globalPath: '', workspacePath: '' };
                                                                pg.workflows.workspacePath = e.target.value;
                                                            }
                                                            update('agent', 'profiles', list);
                                                        }}
                                                        placeholder=".tala/workflows"
                                                    />
                                                </div>
                                            </div>

                                            <label style={{ ...labelStyle, fontSize: 9 }}>ASSIGNED MCP SERVERS</label>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 5 }}>
                                                {settings.mcpServers?.length > 0 ? (
                                                    settings.mcpServers.map((srv: any) => (
                                                        <label key={srv.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#ccc', background: '#2d2d2d', padding: '5px 10px', borderRadius: 4, cursor: 'pointer' }}>
                                                            <input
                                                                type="checkbox"
                                                                checked={(p.mcp?.global || []).includes(srv.id)}
                                                                onChange={e => {
                                                                    const list = [...settings.agent.profiles];
                                                                    const pg = list.find(x => x.id === p.id);
                                                                    if (pg) {
                                                                        if (!pg.mcp) pg.mcp = { global: [], workspace: [] };
                                                                        const current = pg.mcp.global || [];
                                                                        if (e.target.checked) pg.mcp.global = [...current, srv.id];
                                                                        else pg.mcp.global = current.filter((id: string) => id !== srv.id);
                                                                    }
                                                                    update('agent', 'profiles', list);
                                                                }}
                                                            />
                                                            {srv.name}
                                                        </label>
                                                    ))
                                                ) : (
                                                    <div style={{ fontSize: 10, color: '#555', fontStyle: 'italic' }}>No MCP servers defined. Add them in WORKFLOWS tab.</div>
                                                )}
                                            </div>
                                        </div>

                                        {/* GUARDRAILS ASSIGNMENT */}
                                        {(settings.guardrails || []).filter((g: any) => g.scope === 'agent' && g.enabled).length > 0 && (
                                            <div style={{ marginTop: 15, background: '#1e1e1e', padding: 10, borderRadius: 4 }}>
                                                <label style={{ fontSize: 11, color: '#aaa', marginBottom: 8, display: 'block' }}>ASSIGNED GUARDRAILS</label>
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                                    {(settings.guardrails || [])
                                                        .filter((g: any) => g.scope === 'agent' && g.enabled)
                                                        .map((g: any) => (
                                                            <label key={g.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#ccc', background: '#2d2d2d', padding: '4px 8px', borderRadius: 3, cursor: 'pointer' }}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={(p.guardrailIds || []).includes(g.id)}
                                                                    onChange={(e) => {
                                                                        const list = [...settings.agent.profiles];
                                                                        const pg = list.find(x => x.id === p.id);
                                                                        if (pg) {
                                                                            const currentIds = pg.guardrailIds || [];
                                                                            if (e.target.checked) {
                                                                                pg.guardrailIds = [...currentIds, g.id];
                                                                            } else {
                                                                                pg.guardrailIds = currentIds.filter((id: string) => id !== g.id);
                                                                            }
                                                                        }
                                                                        update('agent', 'profiles', list);
                                                                    }}
                                                                />
                                                                {g.name}
                                                            </label>
                                                        ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                </div>
                            ))}
                        </div>
                    </div>
                )}


                {/* INFERENCE TAB */}
                {activeTab === 'inference' && (
                    <div style={sectionStyle}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                            <div>
                                <h3 style={{ margin: 0, color: '#dcdcaa' }}>INFERENCE STACK</h3>
                                <p style={{ margin: 0, fontSize: 11, opacity: 0.7 }}>Defined prioritization chain for Model Inference.</p>
                            </div>
                            <div style={{ display: 'flex', gap: 10 }}>
                                <button
                                    onClick={async () => {
                                        setStatus('Scanning for local models...');
                                        // @ts-ignore
                                        if (window.tala && window.tala.scanLocalModels) {
                                            // @ts-ignore
                                            const found = await window.tala.scanLocalModels();
                                            if (found && found.length > 0) {
                                                const currentIds = settings.inference.instances.map(i => i.id);
                                                // Simple dedup by ID
                                                const newInstances = found.filter((f: any) => !currentIds.includes(f.id));

                                                if (newInstances.length > 0) {
                                                    update('inference', 'instances', [...settings.inference.instances, ...newInstances]);
                                                    setStatus(`Found ${newInstances.length} new local providers.`);
                                                } else {
                                                    setStatus('No new providers found (already added).');
                                                }
                                            } else {
                                                setStatus('No local providers found.');
                                            }
                                        }
                                        setTimeout(() => setStatus(''), 3000);
                                    }}
                                    style={{ background: '#2d2d2d', border: '1px solid #444', color: '#fff', padding: '6px 12px', fontSize: 11, cursor: 'pointer' }}
                                >
                                    SCAN LOCAL
                                </button>
                                <button
                                    onClick={() => {
                                        // Add new instance
                                        const newInst: InferenceInstance = {
                                            id: Math.random().toString(36).substr(2, 9),
                                            alias: 'New Provider',
                                            source: 'cloud',
                                            engine: 'openai',
                                            endpoint: '',
                                            model: 'gpt-4',
                                            priority: settings.inference.instances.length,
                                            apiKey: ''
                                        };
                                        update('inference', 'instances', [...settings.inference.instances, newInst]);
                                    }}
                                    style={{ background: '#2d2d2d', border: '1px solid #444', color: '#fff', padding: '6px 12px', fontSize: 11, cursor: 'pointer' }}
                                >
                                    + ADD PROVIDER
                                </button>
                            </div>
                        </div>

                        {/* AUTO-INSTALL HELPER */}
                        {!settings.inference.instances.some(i => i.engine === 'ollama') && (
                            <div style={{ background: '#1e1e1e', padding: 20, borderRadius: 4, marginBottom: 20, border: '1px solid #3e3e42' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div>
                                        <div style={{ fontWeight: 'bold', color: '#569cd6', fontSize: 13, marginBottom: 5 }}>OLLAMA NOT DETECTED</div>
                                        <div style={{ fontSize: 11, color: '#888' }}>Ollama is the recommended engine for local reasoning. Would you like to auto-install it?</div>
                                    </div>
                                    <button
                                        disabled={!!installingEngine}
                                        onClick={async () => {
                                            setInstallingEngine('ollama');
                                            setInstallProgress(0);
                                            const res = await api.installLocalEngine('ollama');
                                            if (!res.success) {
                                                alert(`Installation failed: ${res.error}`);
                                                setInstallingEngine(null);
                                            }
                                        }}
                                        style={{
                                            background: installingEngine ? '#333' : '#007acc',
                                            color: 'white',
                                            border: 'none',
                                            padding: '8px 20px',
                                            borderRadius: 2,
                                            cursor: installingEngine ? 'not-allowed' : 'pointer',
                                            fontWeight: 'bold',
                                            fontSize: 11
                                        }}
                                    >
                                        {installingEngine ? 'PREPARING...' : 'AUTO-INSTALL OLLAMA'}
                                    </button>
                                </div>

                                {installingEngine === 'ollama' && (
                                    <ProgressBar progress={installProgress} label="Downloading Ollama Installer" />
                                )}
                            </div>
                        )}

                        {/* MODE TOGGLE */}
                        <div style={{ background: '#333', padding: 10, borderRadius: 4, marginBottom: 20, borderLeft: settings.inference.mode === 'local-only' ? '4px solid #4CAF50' : '4px solid #007acc' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                    <div style={{ fontWeight: 'bold', color: 'white', marginBottom: 4 }}>
                                        Running Mode: {settings.inference.mode === 'local-only' ? 'LOCAL ONLY (SAFE)' : 'HYBRID (CLOUD ALLOWED)'}
                                    </div>
                                    <div style={{ fontSize: 11 }}>
                                        {settings.inference.mode === 'local-only'
                                            ? "Only the Active Local Provider will be used."
                                            : "Cloud providers will be used if configured, falling back to Local."}
                                    </div>
                                </div>
                                <button
                                    onClick={() => update('inference', 'mode', settings.inference.mode === 'local-only' ? 'hybrid' : 'local-only')}
                                    style={{
                                        background: settings.inference.mode === 'local-only' ? '#4CAF50' : '#2d2d2d',
                                        color: 'white',
                                        border: '1px solid #555',
                                        padding: '6px 12px',
                                        cursor: 'pointer',
                                        fontWeight: 'bold',
                                        fontSize: 11
                                    }}
                                >
                                    {settings.inference.mode === 'local-only' ? 'ENABLE CLOUD' : 'GO LOCAL ONLY'}
                                </button>
                            </div>
                        </div>

                        {/* BUILT-IN ENGINE (SOLO/USB) */}
                        <div style={{ background: '#1e1e1e', padding: 20, borderRadius: 4, marginBottom: 20, border: settings.inference.localEngine?.enabled ? '1px solid #4CAF50' : '1px solid #3e3e42' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
                                <div>
                                    <h4 style={{ margin: 0, color: '#dcdcaa', fontSize: 13 }}>BUILT-IN ENGINE (SOLO/USB)</h4>
                                    <p style={{ margin: 0, fontSize: 11, opacity: 0.7 }}>Native llama.cpp server for absolute offline use.</p>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <button
                                        onClick={async () => {
                                            const status = await api.getLocalEngineStatus();
                                            if (status.isRunning) {
                                                await api.stopLocalEngine();
                                            } else {
                                                if (!settings.inference.localEngine?.modelPath) {
                                                    alert("Please select a GGUF model first.");
                                                    return;
                                                }
                                                try {
                                                    setStatus('Starting Local Engine...');
                                                    await api.startLocalEngine({
                                                        modelPath: settings.inference.localEngine.modelPath,
                                                        options: settings.inference.localEngine.options
                                                    });
                                                    setStatus('Local Engine Running.');
                                                } catch (e: any) {
                                                    alert(`Failed to start engine: ${e.message}`);
                                                    setStatus('Engine Start Failed.');
                                                }
                                            }
                                            setTimeout(() => setStatus(''), 3000);
                                        }}
                                        style={{
                                            background: settings.inference.localEngine?.enabled ? '#4CAF50' : '#2d2d2d',
                                            color: '#fff',
                                            border: '1px solid #666',
                                            padding: '4px 12px',
                                            fontSize: 10,
                                            fontWeight: 'bold',
                                            cursor: 'pointer',
                                            borderRadius: 2
                                        }}
                                    >
                                        {settings.inference.localEngine?.enabled ? 'RESTART' : 'START SERVER'}
                                    </button>
                                    {settings.inference.localEngine?.enabled && (
                                        <button
                                            onClick={async () => {
                                                await api.stopLocalEngine();
                                                update('inference', 'localEngine', { ...settings.inference.localEngine, enabled: false });
                                            }}
                                            style={{ background: '#ff4444', color: '#fff', border: 'none', padding: '4px 12px', fontSize: 10, fontWeight: 'bold', cursor: 'pointer', borderRadius: 2 }}
                                        >
                                            STOP
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* DOWNLOAD PROGRESS */}
                            {downloading && (
                                <div style={{ marginBottom: 15, padding: 10, background: '#252526', borderRadius: 4, border: '1px solid #007acc' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 5 }}>
                                        <span color="#007acc">Downloading {downloadType === 'binary' ? 'Engine' : downloadType === 'model' ? 'Model' : 'Python'}...</span>
                                        <span>{downloadProgress}%</span>
                                    </div>
                                    <div style={{ height: 4, background: '#333', borderRadius: 2, overflow: 'hidden' }}>
                                        <div style={{ width: `${downloadProgress}%`, height: '100%', background: '#007acc', transition: 'width 0.3s ease' }} />
                                    </div>
                                </div>
                            )}

                            <div style={{ marginBottom: 15, display: 'flex', gap: 10 }}>
                                <button
                                    onClick={async () => {
                                        setDownloadType('binary');
                                        setDownloading(true);
                                        setDownloadProgress(0);
                                        const cleanup = api.onLocalEngineDownloadProgress((data: any) => {
                                            if (data.type === 'binary') setDownloadProgress(data.progress);
                                        });
                                        try {
                                            await api.downloadLocalEngineBinary();
                                            alert("Engine downloaded to 'bin/' folder. You may need to restart the app for detection.");
                                        } catch (e: any) {
                                            alert(`Download failed: ${e.message}`);
                                        } finally {
                                            cleanup();
                                            setDownloading(false);
                                        }
                                    }}
                                    disabled={downloading}
                                    style={{ flex: 1, background: '#333', border: '1px solid #555', color: '#fff', padding: '6px', fontSize: 10, cursor: downloading ? 'not-allowed' : 'pointer' }}
                                >
                                    {downloading && downloadType === 'binary' ? 'DOWNLOADING...' : 'DOWNLOAD ENGINE'}
                                </button>
                                <button
                                    onClick={async () => {
                                        setDownloadType('model');
                                        setDownloading(true);
                                        setDownloadProgress(0);
                                        const cleanup = api.onLocalEngineDownloadProgress((data: any) => {
                                            if (data.type === 'model') setDownloadProgress(data.progress);
                                        });
                                        try {
                                            const modelPath = await api.downloadLocalEngineModel();
                                            update('inference', 'localEngine', { ...settings.inference.localEngine, modelPath });
                                            alert("Model downloaded and path updated.");
                                        } catch (e: any) {
                                            alert(`Download failed: ${e.message}`);
                                        } finally {
                                            cleanup();
                                            setDownloading(false);
                                        }
                                    }}
                                    disabled={downloading}
                                    style={{ flex: 1, background: '#333', border: '1px solid #555', color: '#fff', padding: '6px', fontSize: 10, cursor: downloading ? 'not-allowed' : 'pointer' }}
                                >
                                    {downloading && downloadType === 'model' ? 'DOWNLOADING...' : 'DOWNLOAD MODEL'}
                                </button>
                                <button
                                    onClick={async () => {
                                        setDownloadType('python');
                                        setDownloading(true);
                                        setDownloadProgress(0);
                                        const cleanup = api.onLocalEngineDownloadProgress((data: any) => {
                                            if (data.type === 'python') setDownloadProgress(data.progress);
                                        });
                                        try {
                                            await api.downloadLocalEnginePython();
                                            alert("Portable Python downloaded to 'bin/python'. Restart the app to use it.");
                                        } catch (e: any) {
                                            alert(`Download failed: ${e.message}`);
                                        } finally {
                                            cleanup();
                                            setDownloading(false);
                                        }
                                    }}
                                    disabled={downloading}
                                    style={{ flex: 1, background: '#333', border: '1px solid #555', color: '#fff', padding: '6px', fontSize: 10, cursor: downloading ? 'not-allowed' : 'pointer' }}
                                >
                                    {downloading && downloadType === 'python' ? 'DOWNLOADING...' : 'DOWNLOAD PYTHON'}
                                </button>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15 }}>
                                <div style={{ gridColumn: 'span 2' }}>
                                    <label style={labelStyle}>GGUF MODEL PATH</label>
                                    <div style={{ display: 'flex', gap: 5 }}>
                                        <input
                                            style={{ ...inputStyle, marginBottom: 0, flex: 1 }}
                                            value={settings.inference.localEngine?.modelPath || ''}
                                            onChange={e => update('inference', 'localEngine', {
                                                ...settings.inference.localEngine,
                                                modelPath: e.target.value
                                            })}
                                            placeholder="C:\path\to\model.gguf"
                                        />
                                        <button
                                            onClick={async () => {
                                                const path = await api.selectFile([{ name: 'GGUF Models', extensions: ['gguf'] }]);
                                                if (path) {
                                                    update('inference', 'localEngine', {
                                                        ...settings.inference.localEngine,
                                                        modelPath: path
                                                    });
                                                }
                                            }}
                                            style={{ background: '#333', border: '1px solid #555', color: 'white', cursor: 'pointer', padding: '0 12px' }}
                                        >
                                            BROWSE
                                        </button>
                                    </div>
                                </div>

                                <div>
                                    <label style={labelStyle}>PORT</label>
                                    <input
                                        type="number"
                                        style={{ ...inputStyle, marginBottom: 0 }}
                                        value={settings.inference.localEngine?.options?.port || 8080}
                                        onChange={e => update('inference', 'localEngine', {
                                            ...settings.inference.localEngine,
                                            options: { ...settings.inference.localEngine?.options, port: Number(e.target.value) }
                                        })}
                                    />
                                </div>

                                <div>
                                    <label style={labelStyle}>CONTEXT SIZE (TOKENS)</label>
                                    <input
                                        type="number"
                                        style={{ ...inputStyle, marginBottom: 0 }}
                                        value={settings.inference.localEngine?.options?.contextSize || 4096}
                                        onChange={e => update('inference', 'localEngine', {
                                            ...settings.inference.localEngine,
                                            options: { ...settings.inference.localEngine?.options, contextSize: Number(e.target.value) }
                                        })}
                                    />
                                </div>

                                <div>
                                    <label style={labelStyle}>GPU LAYERS (NGL)</label>
                                    <input
                                        type="number"
                                        style={{ ...inputStyle, marginBottom: 0 }}
                                        value={settings.inference.localEngine?.options?.gpus || 0}
                                        onChange={e => update('inference', 'localEngine', {
                                            ...settings.inference.localEngine,
                                            options: { ...settings.inference.localEngine?.options, gpus: Number(e.target.value) }
                                        })}
                                        title="0 for CPU only, 99 for all on GPU"
                                    />
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <input
                                        type="checkbox"
                                        checked={settings.inference.localEngine?.enabled || false}
                                        onChange={e => update('inference', 'localEngine', {
                                            ...settings.inference.localEngine,
                                            enabled: e.target.checked
                                        })}
                                        id="local-engine-enable"
                                    />
                                    <label htmlFor="local-engine-enable" style={{ fontSize: 11, color: '#aaa', cursor: 'pointer' }}>
                                        AUTO-START ON IGNITION
                                    </label>
                                </div>
                            </div>
                        </div>

                        {/* ACTIVE PROVIDER SELECTION */}
                        <div style={{ marginBottom: 20 }}>
                            <label style={labelStyle}>ACTIVE LOCAL PROVIDER</label>
                            <select
                                style={{ ...inputStyle, cursor: 'pointer', border: '1px solid #007acc', background: '#1e1e1e' }}
                                value={settings.inference.activeLocalId || ''}
                                onChange={e => update('inference', 'activeLocalId', e.target.value)}
                            >
                                <option value="">-- Select Primary Local Engine --</option>
                                {settings.inference.instances
                                    .filter(i => i.source === 'local')
                                    .map(i => (
                                        <option key={i.id} value={i.id}>{i.alias} ({i.engine})</option>
                                    ))}
                            </select>
                        </div>

                        {/* LIST OF INSTANCES */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {settings.inference.instances
                                .sort((a, b) => a.priority - b.priority)
                                .map((inst, index) => (
                                    <div key={inst.id} style={{ background: index === 0 ? '#1e1e1e' : '#252526', border: index === 0 ? '1px solid #007acc' : '1px solid #3e3e42', padding: 15, borderRadius: 4, position: 'relative' }}>

                                        {index === 0 && (
                                            <div style={{ position: 'absolute', top: -10, right: 10, background: '#007acc', color: 'white', fontSize: 10, padding: '2px 8px', borderRadius: 4, fontWeight: 'bold' }}>
                                                ACTIVE PRIMARY
                                            </div>
                                        )}

                                        {/* HEADER ROW */}
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, alignItems: 'center' }}>
                                            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                                <input
                                                    type="checkbox"
                                                    title="Set as Active / Default"
                                                    checked={inst.id === settings.inference.activeLocalId}
                                                    onChange={e => {
                                                        if (e.target.checked) update('inference', 'activeLocalId', inst.id);
                                                        else if (inst.id === settings.inference.activeLocalId) update('inference', 'activeLocalId', '');
                                                    }}
                                                    style={{ cursor: 'pointer', width: 16, height: 16 }}
                                                />
                                                <input
                                                    value={inst.alias}
                                                    onChange={e => {
                                                        const list = [...settings.inference.instances];
                                                        const t = list.find(i => i.id === inst.id);
                                                        if (t) t.alias = e.target.value;
                                                        update('inference', 'instances', list);
                                                    }}
                                                    style={{ background: 'transparent', border: 'none', color: '#fff', fontWeight: 'bold', fontSize: 13, outline: 'none', width: 200 }}
                                                    placeholder="Provider Alias"
                                                />
                                            </div>

                                            <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                                                <div style={{ fontSize: 10, color: '#666', fontWeight: 'bold', marginRight: 5 }}>
                                                    PRIORITY {inst.priority}
                                                </div>
                                                <button
                                                    onClick={() => {
                                                        // Move UP (Lower index)
                                                        if (index === 0) return;
                                                        const sorted = [...settings.inference.instances].sort((a, b) => a.priority - b.priority);
                                                        // Swap with index - 1
                                                        const temp = sorted[index];
                                                        sorted[index] = sorted[index - 1];
                                                        sorted[index - 1] = temp;
                                                        // Re-index
                                                        sorted.forEach((p, i) => p.priority = i);
                                                        update('inference', 'instances', sorted);
                                                    }}
                                                    disabled={index === 0}
                                                    style={{ background: '#333', border: 'none', color: index === 0 ? '#555' : '#fff', cursor: index === 0 ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 2 }}
                                                >
                                                    ▲
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        // Move DOWN (Higher index)
                                                        const sorted = [...settings.inference.instances].sort((a, b) => a.priority - b.priority);
                                                        if (index === sorted.length - 1) return;
                                                        // Swap with index + 1
                                                        const temp = sorted[index];
                                                        sorted[index] = sorted[index + 1];
                                                        sorted[index + 1] = temp;
                                                        // Re-index
                                                        sorted.forEach((p, i) => p.priority = i);
                                                        update('inference', 'instances', sorted);
                                                    }}
                                                    disabled={index === settings.inference.instances.length - 1}
                                                    style={{ background: '#333', border: 'none', color: index === settings.inference.instances.length - 1 ? '#555' : '#fff', cursor: index === settings.inference.instances.length - 1 ? 'default' : 'pointer', padding: '2px 8px', borderRadius: 2 }}
                                                >
                                                    ▼
                                                </button>

                                                <button
                                                    onClick={() => {
                                                        const list = settings.inference.instances.filter(i => i.id !== inst.id);
                                                        update('inference', 'instances', list);
                                                    }}
                                                    style={{ color: '#ff4444', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 16, marginLeft: 10 }}
                                                    title="Delete Provider"
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        </div>

                                        {/* CONFIG ROW */}
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>

                                            {/* SOURCE & ENGINE */}
                                            <div>
                                                <label style={labelStyle}>SOURCE / ENGINE</label>
                                                <select
                                                    style={{ ...selectStyle, marginBottom: 5 }}
                                                    value={inst.engine}
                                                    onChange={e => {
                                                        const list = [...settings.inference.instances];
                                                        const t = list.find(i => i.id === inst.id);
                                                        if (t) {
                                                            t.engine = e.target.value as any;
                                                            // Set defaults based on engine
                                                            if (t.engine === 'ollama') { t.source = 'local'; t.endpoint = 'http://127.0.0.1:11434'; }
                                                            if (t.engine === 'llamacpp') { t.source = 'local'; t.endpoint = 'http://127.0.0.1:8080'; }
                                                            if (t.engine === 'openai') { t.source = 'cloud'; t.endpoint = 'https://api.openai.com/v1'; }
                                                            if (t.engine === 'anthropic') { t.source = 'cloud'; t.endpoint = 'https://api.anthropic.com/v1'; }
                                                        }
                                                        update('inference', 'instances', list);
                                                    }}
                                                >
                                                    <optgroup label="Local">
                                                        <option value="ollama">Ollama</option>
                                                        <option value="llamacpp">Llama.cpp / LocalAI</option>
                                                        <option value="vllm">vLLM</option>
                                                    </optgroup>
                                                    <optgroup label="Cloud">
                                                        <option value="openai">OpenAI</option>
                                                        <option value="anthropic">Anthropic</option>
                                                        <option value="gemini">Google Gemini</option>
                                                        <option value="groq">Groq</option>
                                                        <option value="custom">Custom Compatible</option>
                                                    </optgroup>
                                                </select>
                                            </div>

                                            {/* MODEL */}
                                            <div>
                                                <label style={labelStyle}>MODEL ID</label>
                                                {inst.params?.knownModels && inst.params.knownModels.length > 0 ? (
                                                    <select
                                                        style={{ ...selectStyle, marginBottom: 5 }}
                                                        value={inst.model}
                                                        onChange={e => {
                                                            const list = [...settings.inference.instances];
                                                            const t = list.find(i => i.id === inst.id);
                                                            if (t) t.model = e.target.value;
                                                            update('inference', 'instances', list);
                                                        }}
                                                    >
                                                        {inst.params.knownModels.map((m: string) => (
                                                            <option key={m} value={m}>{m}</option>
                                                        ))}
                                                        <option value="__custom__">-- Custom / Other --</option>
                                                    </select>
                                                ) : (
                                                    <div style={{ display: 'flex', gap: 5 }}>
                                                        <input
                                                            style={{ ...inputStyle, marginBottom: 5, flex: 1 }}
                                                            value={inst.model}
                                                            onChange={e => {
                                                                const list = [...settings.inference.instances];
                                                                const t = list.find(i => i.id === inst.id);
                                                                if (t) t.model = e.target.value;
                                                                update('inference', 'instances', list);
                                                            }}
                                                            placeholder={inst.engine === 'ollama' ? 'llama3:latest' : 'gpt-4'}
                                                        />
                                                        {['llamacpp', 'vllm', 'custom'].includes(inst.engine) && inst.source === 'local' && (
                                                            <button
                                                                onClick={async () => {
                                                                    const path = await (window as any).tala.invoke('select-path', { properties: ['openFile', 'openDirectory'] });
                                                                    if (path) {
                                                                        const list = [...settings.inference.instances];
                                                                        const t = list.find(i => i.id === inst.id);
                                                                        if (t) t.model = path;
                                                                        update('inference', 'instances', list);
                                                                    }
                                                                }}
                                                                style={{ background: '#333', border: '1px solid #555', color: 'white', cursor: 'pointer', marginBottom: 5, fontSize: 10, padding: '0 8px' }}
                                                                title="Select Model File / Folder (Portable Mode)"
                                                            >
                                                                📁
                                                            </button>
                                                        )}
                                                    </div>
                                                )}

                                                {/* Fallback Input if they selected Custom or list is empty/missing logic handles empty above */}
                                                {/* If they selected __custom__, we should probably flip a state to show input, but for now let's keep it simple. 
                                                    Actually, if they pick __custom__, we can momentarily swap to input. 
                                                    But simpler: Just show input IF model is not in list? No. 
                                                    Strategy: If select is shown, selecting __custom__ sets model to empty string? 
                                                */}
                                            </div>

                                            {/* PRIORITY */}
                                            <div>
                                                <label style={labelStyle}>PRIORITY (0=High)</label>
                                                <input
                                                    type="number"
                                                    style={{ ...inputStyle, marginBottom: 5 }}
                                                    value={inst.priority}
                                                    onChange={e => {
                                                        const list = [...settings.inference.instances];
                                                        const t = list.find(i => i.id === inst.id);
                                                        if (t) t.priority = Number(e.target.value);
                                                        update('inference', 'instances', list);
                                                    }}
                                                />
                                            </div>
                                        </div>

                                        {/* DETAILS ROW */}
                                        <div style={{ display: 'flex', gap: 10 }}>
                                            <div style={{ flex: 2 }}>
                                                <label style={labelStyle}>ENDPOINT URL</label>
                                                <input
                                                    style={{ ...inputStyle, marginBottom: 0 }}
                                                    value={inst.endpoint}
                                                    onChange={e => {
                                                        const list = [...settings.inference.instances];
                                                        const t = list.find(i => i.id === inst.id);
                                                        if (t) t.endpoint = e.target.value;
                                                        update('inference', 'instances', list);
                                                    }}
                                                />
                                            </div>
                                            {inst.source === 'cloud' && (
                                                <div style={{ flex: 1 }}>
                                                    <label style={labelStyle}>API KEY</label>
                                                    <input
                                                        type="password"
                                                        style={{ ...inputStyle, marginBottom: 0 }}
                                                        value={inst.apiKey || ''}
                                                        onChange={e => {
                                                            const list = [...settings.inference.instances];
                                                            const t = list.find(i => i.id === inst.id);
                                                            if (t) t.apiKey = e.target.value;
                                                            update('inference', 'instances', list);
                                                        }}
                                                        placeholder="Stored Securely"
                                                    />
                                                </div>
                                            )}
                                        </div>

                                    </div>
                                ))}
                        </div>

                        <div style={{ marginTop: 20, textAlign: 'center' }}>
                            <button
                                onClick={async () => {
                                    setStatus('Scanning Local Ports (11434, 8080, 1234)...');
                                    const api = (window as any).tala;
                                    if (api && api.scanLocalProviders) {
                                        const found = await api.scanLocalProviders();
                                        if (found && found.length > 0) {
                                            const newInstances = [...settings.inference.instances];
                                            let addedCount = 0;

                                            found.forEach((p: any) => {
                                                // Check if already exists by endpoint AND engine
                                                const exists = newInstances.find(i => i.endpoint === p.endpoint && i.engine === p.engine);
                                                if (exists) {
                                                    // Update known models
                                                    if (!exists.params) exists.params = {};
                                                    exists.params.knownModels = p.models;
                                                    // Default to first model if current is empty or invalid
                                                    if (!exists.model || !p.models.includes(exists.model)) {
                                                        exists.model = p.models[0];
                                                    }
                                                } else {
                                                    // Add new
                                                    newInstances.push({
                                                        id: Math.random().toString(36).substr(2, 9),
                                                        alias: `${p.engine.toUpperCase()} (Auto)`,
                                                        source: 'local',
                                                        engine: p.engine,
                                                        endpoint: p.endpoint,
                                                        model: p.models[0] || 'default',
                                                        priority: newInstances.length + 1,
                                                        params: { knownModels: p.models }
                                                    });
                                                    addedCount++;
                                                }
                                            });

                                            update('inference', 'instances', newInstances);
                                            setStatus(`Scan Complete. Updated ${found.length} providers. Added ${addedCount} new.`);
                                        } else {
                                            setStatus('Scan Complete. No local providers found active.');
                                        }
                                    } else {
                                        setStatus('Error: Scan API not available.');
                                    }
                                }}
                                style={{ background: 'transparent', color: '#007acc', border: '1px dashed #007acc', padding: '8px 16px', fontSize: 11, cursor: 'pointer', opacity: 0.7 }}
                            >
                                ⟳ SCAN FOR LOCAL ENGINES
                            </button>
                        </div>
                    </div>
                )}

                {/* SYSTEM TAB */}
                {activeTab === ('system' as any) && (
                    <div style={sectionStyle}>
                        <div style={{ display: 'flex', borderBottom: '1px solid #333', marginBottom: 20 }}>
                            {['env', 'guardrails'].map(sub => (
                                <div
                                    key={sub}
                                    style={{
                                        padding: '5px 15px',
                                        cursor: 'pointer',
                                        color: systemSubTab === sub ? '#fff' : '#666',
                                        borderBottom: systemSubTab === sub ? '2px solid #007acc' : '2px solid transparent',
                                        fontSize: 12,
                                        fontWeight: 'bold',
                                        textTransform: 'uppercase'
                                    }}
                                    onClick={() => setSystemSubTab(sub as any)}
                                >
                                    {sub === 'env' ? 'Environment' : 'Guardrails'}
                                </div>
                            ))}
                        </div>

                        {systemSubTab === 'env' && (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                                    <div>
                                        <h3 style={{ margin: 0, color: '#dcdcaa' }}>SYSTEM ENVIRONMENT</h3>
                                        <p style={{ margin: 0, fontSize: 11, opacity: 0.7 }}>Manage runtime paths and variables.</p>
                                    </div>
                                    <button
                                        onClick={async () => {
                                            setSystemInfo(null);
                                            const info = await api.getSystemInfo();
                                            setSystemInfo(info);
                                        }}
                                        style={{ background: '#2d2d2d', border: '1px solid #444', color: '#fff', padding: '6px 12px', fontSize: 11, cursor: 'pointer' }}
                                    >
                                        ⟳ RESCAN
                                    </button>
                                </div>

                                {systemInfo ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                                        <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: '10px 20px', alignItems: 'center' }}>
                                            <div style={{ ...labelStyle, marginBottom: 0 }}>OPERATING SYSTEM</div>
                                            <div style={{ fontSize: 13, color: '#fff' }}>{systemInfo.os} ({systemInfo.platform})</div>

                                            <div style={{ ...labelStyle, marginBottom: 0 }}>NODE RUNTIME</div>
                                            <div style={{ fontSize: 13, color: '#fff' }}>
                                                <code>{systemInfo.nodePath}</code>
                                                <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>Version: {systemInfo.nodeVersion}</div>
                                            </div>

                                            <div style={{ ...labelStyle, marginBottom: 0 }}>PYTHON RUNTIME</div>
                                            <div style={{ fontSize: 13, color: '#fff' }}>
                                                <code>{systemInfo.pythonPath}</code>
                                                <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>Version: {systemInfo.pythonVersion}</div>
                                            </div>

                                            <div style={{ ...labelStyle, marginBottom: 0 }}>PYTHON VIRTUAL ENV</div>
                                            <div style={{ fontSize: 13, color: systemInfo.pythonEnvPath ? '#fff' : '#666' }}>
                                                {systemInfo.pythonEnvPath ? (
                                                    <code>{systemInfo.pythonEnvPath}</code>
                                                ) : (
                                                    "None detected in workspace"
                                                )}
                                            </div>

                                            {/* DETECTED ENV VARS ACCORDION */}
                                            <div style={{ gridColumn: 'span 2', marginTop: 10 }}>
                                                <div style={{ ...labelStyle, marginBottom: 10 }}>DETECTED VARIABLES ({systemInfo.envVariables ? Object.keys(systemInfo.envVariables).length : 0})</div>
                                                <div style={{ background: '#1e1e1e', padding: 10, borderRadius: 4, maxHeight: 200, overflowY: 'auto', border: '1px solid #3e3e42' }}>
                                                    {systemInfo.envVariables ? (
                                                        Object.entries(systemInfo.envVariables).map(([k, v]) => (
                                                            <div key={k} style={{ display: 'flex', gap: 10, fontSize: 11, fontFamily: 'Consolas', marginBottom: 4 }}>
                                                                <span style={{ color: '#569cd6', minWidth: 200, flexShrink: 0 }}>{k}</span>
                                                                <span style={{ color: '#ce9178', wordBreak: 'break-all' }}>{String(v)}</span>
                                                            </div>
                                                        ))
                                                    ) : (
                                                        <div style={{ color: '#666', fontSize: 11 }}>No variables detected</div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>

                                        {/* CUSTOM ENV VARS */}
                                        <div style={{ borderTop: '1px solid #3e3e42', paddingTop: 20 }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                                                <label style={labelStyle}>CUSTOM VARIABLES / OVERRIDES</label>
                                                <button
                                                    onClick={() => {
                                                        const current = { ...(settings.system?.env || {}) };
                                                        let i = 1;
                                                        while (current[`NEW_VAR_${i}`]) i++;
                                                        current[`NEW_VAR_${i}`] = '';
                                                        update('system', 'env', current);
                                                    }}
                                                    style={{ background: '#2d2d2d', border: '1px solid #444', color: '#fff', padding: '4px 8px', fontSize: 10, cursor: 'pointer' }}
                                                >
                                                    + ADD VARIABLE
                                                </button>
                                            </div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                                                {settings.system?.env && Object.entries(settings.system.env).map(([k, v]) => (
                                                    <div key={k} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                                        <input
                                                            value={k}
                                                            onChange={e => {
                                                                const newKey = e.target.value;
                                                                if (newKey !== k) {
                                                                    const current = { ...settings.system.env };
                                                                    current[newKey] = v;
                                                                    delete current[k];
                                                                    update('system', 'env', current);
                                                                }
                                                            }}
                                                            placeholder="KEY"
                                                            style={{ ...inputStyle, flex: 1, fontFamily: 'Consolas', marginBottom: 0 }}
                                                        />
                                                        <input
                                                            value={String(v)}
                                                            onChange={e => {
                                                                const current = { ...settings.system.env };
                                                                current[k] = e.target.value;
                                                                update('system', 'env', current);
                                                            }}
                                                            placeholder="VALUE"
                                                            style={{ ...inputStyle, flex: 2, fontFamily: 'Consolas', marginBottom: 0 }}
                                                        />
                                                        <button
                                                            onClick={() => {
                                                                const current = { ...settings.system.env };
                                                                delete current[k];
                                                                update('system', 'env', current);
                                                            }}
                                                            style={{ color: '#ff4444', background: 'transparent', border: 'none', cursor: 'pointer' }}
                                                        >
                                                            ×
                                                        </button>
                                                    </div>
                                                ))}
                                                {(!settings.system?.env || Object.keys(settings.system.env).length === 0) && (
                                                    <div style={{ fontSize: 11, color: '#666', fontStyle: 'italic' }}>No custom variables defined.</div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>
                                        SCANNING SYSTEM ENVIRONMENT...
                                    </div>
                                )}
                            </>
                        )}

                        {systemSubTab === 'guardrails' && (
                            <div>
                                <h3 style={{ color: '#dcdcaa' }}>SAFETY GUARDRAILS</h3>
                                <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 20 }}>Define safety boundaries and confirmation thresholds.</p>

                                <div style={{ marginBottom: 20 }}>
                                    <label style={labelStyle}>SENSITIVE TOPIC FILTERING</label>
                                    <div style={{ background: '#1e1e1e', padding: 15, borderRadius: 4, border: '1px solid #3e3e42' }}>
                                        <p style={{ fontSize: 12, marginTop: 0 }}>Select topics that require explicit user confirmation:</p>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                            {['Financial Transactions', 'File Deletion', 'System Configuration', 'External API Calls', 'Shell Commands'].map(topic => (
                                                <label key={topic} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
                                                    <input type="checkbox" defaultChecked={['File Deletion', 'Shell Commands'].includes(topic)} />
                                                    {topic}
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                </div>

                                <div style={{ marginBottom: 20 }}>
                                    <label style={labelStyle}>MAXIMUM APPROVAL THRESHOLD</label>
                                    <div style={{ display: 'flex', gap: 10 }}>
                                        <div style={{ flex: 1 }}>
                                            <div style={{ fontSize: 11, marginBottom: 5 }}>AUTO-APPROVE ACTIONS UNDER:</div>
                                            <select style={{ ...selectStyle, width: '100%' }}>
                                                <option>Low Risk (Read-only)</option>
                                                <option>Medium Risk (Edits)</option>
                                                <option>High Risk (Deletes/Exec)</option>
                                                <option>Never Auto-approve</option>
                                            </select>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )
                }

                {/* SOURCE CONTROL TAB */}
                {
                    activeTab === 'sourceControl' && settings.sourceControl && (
                        <div style={{ ...sectionStyle, padding: 0 }}>
                            <div style={{ padding: '20px 20px 0 20px', borderBottom: '1px solid #333', background: '#252526' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
                                    <div>
                                        <h3 style={{ margin: 0, color: '#dcdcaa' }}>SOURCE CONTROL</h3>
                                        <p style={{ margin: 0, fontSize: 11, opacity: 0.7 }}>Configure providers or manage local version control.</p>
                                    </div>
                                </div>
                                <div style={{ display: 'flex', gap: 20 }}>
                                    <div
                                        onClick={() => setScSubTab('providers')}
                                        style={{
                                            padding: '8px 0',
                                            fontSize: 12,
                                            cursor: 'pointer',
                                            borderBottom: scSubTab === 'providers' ? '2px solid #007acc' : 'none',
                                            color: scSubTab === 'providers' ? '#fff' : '#888'
                                        }}
                                    >
                                        PROVIDERS
                                    </div>
                                    <div
                                        onClick={() => setScSubTab('advanced')}
                                        style={{
                                            padding: '8px 0',
                                            fontSize: 12,
                                            cursor: 'pointer',
                                            borderBottom: scSubTab === 'advanced' ? '2px solid #007acc' : 'none',
                                            color: scSubTab === 'advanced' ? '#fff' : '#888'
                                        }}
                                    >
                                        ADVANCED MANAGEMENT
                                    </div>
                                </div>
                            </div>

                            {scSubTab === 'providers' ? (
                                <div style={{ padding: 20 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                                        <div style={{ fontSize: 11, color: '#888' }}>Manage Git providers for authenticating agent access.</div>
                                        <button
                                            onClick={() => {
                                                const newProvider: SourceControlProvider = {
                                                    id: `git-${Math.random().toString(36).substr(2, 5)}`,
                                                    name: 'New Git Provider',
                                                    type: 'git',
                                                    active: false
                                                };
                                                update('sourceControl', 'providers', [...settings.sourceControl.providers, newProvider]);
                                            }}
                                            style={{ background: '#2d2d2d', border: '1px solid #444', color: '#fff', padding: '6px 12px', fontSize: 11, cursor: 'pointer' }}
                                        >
                                            + ADD PROVIDER
                                        </button>
                                    </div>

                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
                                        {settings.sourceControl.providers.map(provider => (
                                            <div key={provider.id} style={{ background: '#252526', padding: 15, borderRadius: 4, border: provider.active ? '1px solid #007acc' : '1px solid #3e3e42', position: 'relative' }}>

                                                <button
                                                    onClick={() => {
                                                        const list = settings.sourceControl.providers.filter(p => p.id !== provider.id);
                                                        update('sourceControl', 'providers', list);
                                                    }}
                                                    style={{ position: 'absolute', top: 10, right: 10, background: 'transparent', border: 'none', color: '#ff4444', cursor: 'pointer', fontSize: 14 }}
                                                    title="Remove Provider"
                                                >
                                                    ×
                                                </button>

                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                        <input
                                                            type="checkbox"
                                                            checked={provider.active}
                                                            onChange={e => {
                                                                const list = [...settings.sourceControl.providers];
                                                                const p = list.find(x => x.id === provider.id);
                                                                if (p) p.active = e.target.checked;
                                                                update('sourceControl', 'providers', list);
                                                            }}
                                                            style={{ width: 16, height: 16 }}
                                                        />
                                                        <input
                                                            value={provider.name}
                                                            onChange={e => {
                                                                const list = [...settings.sourceControl.providers];
                                                                const p = list.find(x => x.id === provider.id);
                                                                if (p) p.name = e.target.value;
                                                                update('sourceControl', 'providers', list);
                                                            }}
                                                            style={{ background: 'transparent', border: 'none', color: provider.active ? '#fff' : '#888', fontWeight: 'bold', fontSize: 14, outline: 'none', width: 250 }}
                                                        />
                                                    </div>
                                                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                                        <select
                                                            value={provider.type}
                                                            onChange={e => {
                                                                const list = [...settings.sourceControl.providers];
                                                                const p = list.find(x => x.id === provider.id);
                                                                if (p) p.type = e.target.value as any;
                                                                update('sourceControl', 'providers', list);
                                                            }}
                                                            style={{ background: '#333', color: '#ccc', border: '1px solid #444', fontSize: 10, padding: '2px 6px', borderRadius: 2 }}
                                                        >
                                                            <option value="github">GitHub</option>
                                                            <option value="gitlab">GitLab</option>
                                                            <option value="bitbucket">Bitbucket</option>
                                                            <option value="gitea">Gitea</option>
                                                            <option value="git">Generic Git</option>
                                                            <option value="custom">Custom API</option>
                                                        </select>
                                                    </div>
                                                </div>

                                                {provider.active && (
                                                    <div style={{ paddingLeft: 26, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15 }}>
                                                        <div>
                                                            <label style={labelStyle}>USERNAME</label>
                                                            <input
                                                                style={inputStyle}
                                                                value={provider.username || ''}
                                                                onChange={e => {
                                                                    const list = [...settings.sourceControl.providers];
                                                                    const p = list.find(x => x.id === provider.id);
                                                                    if (p) p.username = e.target.value;
                                                                    update('sourceControl', 'providers', list);
                                                                }}
                                                                placeholder="git-user"
                                                            />
                                                        </div>
                                                        <div>
                                                            <label style={labelStyle}>ACCESS TOKEN (PAT)</label>
                                                            <input
                                                                type="password"
                                                                style={inputStyle}
                                                                value={provider.token || ''}
                                                                onChange={e => {
                                                                    const list = [...settings.sourceControl.providers];
                                                                    const p = list.find(x => x.id === provider.id);
                                                                    if (p) p.token = e.target.value;
                                                                    update('sourceControl', 'providers', list);
                                                                }}
                                                                placeholder="token_..."
                                                            />
                                                        </div>
                                                        {(provider.type !== 'github' && provider.type !== 'git') && (
                                                            <div style={{ gridColumn: 'span 2' }}>
                                                                <label style={labelStyle}>INSTANCE / API URL</label>
                                                                <input
                                                                    style={inputStyle}
                                                                    value={provider.endpoint || ''}
                                                                    onChange={e => {
                                                                        const list = [...settings.sourceControl.providers];
                                                                        const p = list.find(x => x.id === provider.id);
                                                                        if (p) p.endpoint = e.target.value;
                                                                        update('sourceControl', 'providers', list);
                                                                    }}
                                                                    placeholder={provider.type === 'gitlab' ? 'https://gitlab.com' : 'https://api.your-instance.com'}
                                                                />
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                <div style={{ flex: 1, minHeight: 600 }}>
                                    <GitView />
                                </div>
                            )}
                        </div>
                    )
                }

                {/* STORAGE TAB */}
                {
                    activeTab === 'storage' && (
                        <div style={sectionStyle}>
                            <h3 style={{ color: '#dcdcaa' }}>MEMORY STORAGE</h3>
                            <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 20 }}>Persist long-term vector memory and files.</p>

                            {/* ACTIVE PROVIDER SELECTOR */}
                            <div style={{ marginBottom: 20, background: '#1e1e1e', padding: 15, borderRadius: 4, border: '1px solid #007acc' }}>
                                <label style={{ ...labelStyle, color: '#fff' }}>ACTIVE STORAGE PROVIDER</label>
                                <select
                                    style={{ ...selectStyle, marginBottom: 0, border: '1px solid #333' }}
                                    value={settings.storage.activeProviderId}
                                    onChange={e => update('storage', 'activeProviderId', e.target.value)}
                                >
                                    {(settings.storage.providers || []).map((p: any) => (
                                        <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
                                    ))}
                                </select>
                            </div>

                            {/* PROVIDERS LIST */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                                {(settings.storage.providers || []).map((provider: any, index: number) => {
                                    const updateProvider = (field: string, val: any) => {
                                        const list = [...settings.storage.providers];
                                        list[index] = { ...provider, [field]: val };
                                        update('storage', 'providers', list);
                                    };

                                    return (
                                        <div key={provider.id} style={{ background: '#252526', padding: 15, borderRadius: 4, border: '1px solid #3e3e42', position: 'relative' }}>
                                            {/* HEADER */}
                                            <div style={{ display: 'flex', gap: 10, marginBottom: 15, alignItems: 'center' }}>
                                                <div style={{ flex: 1 }}>
                                                    <label style={labelStyle}>PROVIDER NAME</label>
                                                    <input
                                                        value={provider.name}
                                                        onChange={e => updateProvider('name', e.target.value)}
                                                        style={{ ...inputStyle, marginBottom: 0, fontWeight: 'bold' }}
                                                    />
                                                </div>
                                                <div style={{ width: 150 }}>
                                                    <label style={labelStyle}>TYPE</label>
                                                    <select
                                                        style={{ ...selectStyle, marginBottom: 0 }}
                                                        value={provider.type}
                                                        onChange={e => updateProvider('type', e.target.value)}
                                                    >
                                                        <option value="chroma-local">Local ChromaDB</option>
                                                        <option value="chroma-remote">Remote ChromaDB</option>
                                                        <option value="pinecone">Pinecone</option>
                                                        <option value="weaviate">Weaviate</option>
                                                        <option value="s3">S3 / MinIO</option>
                                                        <option value="supabase">Supabase</option>
                                                    </select>
                                                </div>
                                                <button
                                                    onClick={() => {
                                                        if (settings.storage.providers.length <= 1) {
                                                            setStatus('Cannot delete last provider.');
                                                            return;
                                                        }
                                                        const list = settings.storage.providers.filter((p: any) => p.id !== provider.id);
                                                        update('storage', 'providers', list);
                                                        if (settings.storage.activeProviderId === provider.id) {
                                                            update('storage', 'activeProviderId', list[0].id);
                                                        }
                                                    }}
                                                    style={{ color: '#ff4444', background: 'transparent', border: 'none', cursor: 'pointer', alignSelf: 'flex-end', paddingBottom: 10 }}
                                                >
                                                    REMOVE
                                                </button>
                                            </div>

                                            {/* DYNAMIC FIELDS */}
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15 }}>

                                                <Field
                                                    label="COLLECTION / BUCKET"
                                                    value={provider.collection || provider.bucket}
                                                    onChange={(e: any) => {
                                                        if (['s3', 'supabase'].includes(provider.type)) {
                                                            updateProvider('bucket', e.target.value);
                                                        } else if (provider.type === 'pinecone') {
                                                            updateProvider('indexName', e.target.value);
                                                        } else {
                                                            updateProvider('collection', e.target.value);
                                                        }
                                                    }}
                                                    placeholder={['s3', 'supabase'].includes(provider.type) ? "my-bucket" : (provider.type === 'pinecone' ? "index-name" : "tala_memory")}
                                                />

                                                {/* Local Path */}
                                                {provider.type === 'chroma-local' && (
                                                    <Field
                                                        label="DATA PATH"
                                                        value={provider.path}
                                                        onChange={(e: any) => updateProvider('path', e.target.value)}
                                                        placeholder="./data/memory"
                                                    />
                                                )}

                                                {/* Remote Endpoint */}
                                                {['chroma-remote', 's3', 'supabase', 'weaviate'].includes(provider.type) && (
                                                    <div style={{ gridColumn: 'span 2' }}>
                                                        <Field
                                                            label={provider.type === 'weaviate' ? "HOST (e.g. cluster.weaviate.io)" : "ENDPOINT URL"}
                                                            value={provider.endpoint || provider.host}
                                                            onChange={(e: any) => {
                                                                if (provider.type === 'weaviate') updateProvider('host', e.target.value);
                                                                else updateProvider('endpoint', e.target.value);
                                                            }}
                                                            placeholder={provider.type === 'supabase' ? "https://xyz.supabase.co" : (provider.type === 'weaviate' ? "cluster.weaviate.io" : "http://localhost:8000")}
                                                        />
                                                    </div>
                                                )}

                                                {/* Pinecone Fields */}
                                                {provider.type === 'pinecone' && (
                                                    <>
                                                        <Field
                                                            label="ENVIRONMENT"
                                                            value={provider.environment}
                                                            onChange={(e: any) => updateProvider('environment', e.target.value)}
                                                            placeholder="us-east-1-gcp"
                                                        />
                                                        <Field
                                                            label="NAMESPACE (Optional)"
                                                            value={provider.namespace}
                                                            onChange={(e: any) => updateProvider('namespace', e.target.value)}
                                                            placeholder="production"
                                                        />
                                                    </>
                                                )}

                                                {/* Weaviate Scheme */}
                                                {provider.type === 'weaviate' && (
                                                    <div style={{ width: 150 }}>
                                                        <label style={labelStyle}>SCHEME</label>
                                                        <select
                                                            style={selectStyle}
                                                            value={provider.scheme || 'https'}
                                                            onChange={e => updateProvider('scheme', e.target.value)}
                                                        >
                                                            <option value="https">HTTPS</option>
                                                            <option value="http">HTTP</option>
                                                        </select>
                                                    </div>
                                                )}

                                                {/* Auth Keys */}
                                                {['chroma-remote', 's3', 'supabase', 'pinecone', 'weaviate'].includes(provider.type) && (
                                                    <>
                                                        <Field
                                                            label={provider.type === 's3' ? "ACCESS KEY" : "API KEY"}
                                                            value={provider.apiKey || provider.accessKey}
                                                            onChange={(e: any) => {
                                                                if (provider.type === 's3') updateProvider('accessKey', e.target.value);
                                                                else updateProvider('apiKey', e.target.value);
                                                            }}
                                                        />
                                                        {provider.type === 's3' && (
                                                            <Field
                                                                label="SECRET KEY"
                                                                type="password"
                                                                value={provider.secretKey}
                                                                onChange={(e: any) => updateProvider('secretKey', e.target.value)}
                                                            />
                                                        )}
                                                    </>
                                                )}

                                                {provider.type === 's3' && (
                                                    <Field
                                                        label="REGION"
                                                        value={provider.region}
                                                        onChange={(e: any) => updateProvider('region', e.target.value)}
                                                        placeholder="us-east-1"
                                                    />
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}

                                <button
                                    onClick={() => {
                                        const newProvider = {
                                            id: `storage-${Date.now()}`,
                                            name: 'New Storage Provider',
                                            type: 'chroma-local',
                                            path: './data/memory',
                                            collection: 'tala_memory'
                                        };
                                        update('storage', 'providers', [...settings.storage.providers, newProvider]);
                                    }}
                                    style={{ background: '#2d2d2d', border: '1px dashed #444', color: '#ccc', padding: '12px', fontSize: 12, cursor: 'pointer', textAlign: 'center' }}
                                >
                                    + ADD STORAGE PROVIDER
                                </button>
                            </div>
                        </div>
                    )
                }

                {/* BACKUP TAB */}
                {/* BACKUP TAB */}
                {
                    activeTab === 'backup' && (
                        <div style={sectionStyle}>
                            <h3 style={{ color: '#dcdcaa' }}>CLOUD BACKUP & RESTORE</h3>
                            <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 20 }}>Securely backup your workspace to S3-compatible storage.</p>

                            <div style={{ marginBottom: 20, background: '#1e1e1e', padding: 15, borderRadius: 4, border: '1px solid #3e3e42' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
                                    <label style={{ color: '#fff', fontSize: 13, display: 'flex', alignItems: 'center' }}>
                                        <input
                                            type="checkbox"
                                            checked={settings.backup?.enabled || false}
                                            onChange={e => update('backup', 'enabled', e.target.checked)}
                                            style={{ marginRight: 10, width: 16, height: 16 }}
                                        />
                                        ENABLE AUTOMATED BACKUPS
                                    </label>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                        <label style={{ fontSize: 11, color: '#888' }}>Every (hours):</label>
                                        <input
                                            type="number"
                                            value={settings.backup?.intervalHours || 24}
                                            onChange={e => update('backup', 'intervalHours', parseInt(e.target.value))}
                                            style={{ ...inputStyle, width: 60, marginBottom: 0 }}
                                            min="1"
                                        />
                                    </div>
                                </div>

                                <div style={{ marginBottom: 15 }}>
                                    <label style={labelStyle}>STORAGE PROVIDER</label>
                                    <select
                                        style={selectStyle}
                                        value={settings.backup?.provider || 'local'}
                                        onChange={e => update('backup', 'provider', e.target.value)}
                                    >
                                        <option value="local">Local Disk Only</option>
                                        <option value="s3">AWS S3</option>
                                        <option value="compat">S3 Compatible (MinIO, DigitalOcean, R2)</option>
                                        <option value="gcs">Google Cloud Storage (S3 Interop)</option>
                                    </select>
                                </div>

                                {settings.backup?.provider !== 'local' && (
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15 }}>
                                        <div style={{ gridColumn: 'span 2' }}>
                                            <label style={labelStyle}>ENDPOINT URL (Optional for AWS)</label>
                                            <input
                                                style={inputStyle}
                                                value={settings.backup?.endpoint || ''}
                                                onChange={e => update('backup', 'endpoint', e.target.value)}
                                                placeholder="https://s3.us-east-1.amazonaws.com or https://minio.myserver.com"
                                            />
                                        </div>
                                        <div>
                                            <label style={labelStyle}>REGION</label>
                                            <input
                                                style={inputStyle}
                                                value={settings.backup?.region || ''}
                                                onChange={e => update('backup', 'region', e.target.value)}
                                                placeholder="us-east-1"
                                            />
                                        </div>
                                        <div>
                                            <label style={labelStyle}>BUCKET NAME</label>
                                            <input
                                                style={inputStyle}
                                                value={settings.backup?.bucket || ''}
                                                onChange={e => update('backup', 'bucket', e.target.value)}
                                                placeholder="my-tala-backups"
                                            />
                                        </div>
                                        <div>
                                            <label style={labelStyle}>ACCESS KEY ID</label>
                                            <input
                                                type="password"
                                                style={inputStyle}
                                                value={settings.backup?.accessKeyId || ''}
                                                onChange={e => update('backup', 'accessKeyId', e.target.value)}
                                                placeholder="AKIA..."
                                            />
                                        </div>
                                        <div>
                                            <label style={labelStyle}>SECRET ACCESS KEY</label>
                                            <input
                                                type="password"
                                                style={inputStyle}
                                                value={settings.backup?.secretAccessKey || ''}
                                                onChange={e => update('backup', 'secretAccessKey', e.target.value)}
                                                placeholder="wJalr..."
                                            />
                                        </div>

                                        <div style={{ gridColumn: 'span 2', display: 'flex', gap: 10, marginTop: 10 }}>
                                            <button
                                                onClick={async () => {
                                                    setStatus('Testing Connection...');
                                                    const api = (window as any).tala;
                                                    if (api && api.testBackupConnection) {
                                                        const res = await api.testBackupConnection(settings.backup);
                                                        if (res.success) setStatus('Connection Successful!');
                                                        else setStatus(`Connection Failed: ${res.error}`);
                                                    } else {
                                                        setStatus('Error: API not available');
                                                    }
                                                }}
                                                style={{ background: '#333', border: '1px solid #555', color: '#fff', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
                                            >
                                                TEST CONNECTION
                                            </button>
                                            <button
                                                onClick={async () => {
                                                    setStatus('Starting Backup...');
                                                    const api = (window as any).tala;
                                                    if (api && api.backupNow) {
                                                        const res = await api.backupNow();
                                                        if (res.success) setStatus(`Backup Complete: ${res.path}`);
                                                        else setStatus(`Backup Failed: ${res.error}`);
                                                    }
                                                }}
                                                style={{ background: '#007acc', border: 'none', color: '#fff', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }}
                                            >
                                                BACKUP NOW
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )
                }

                {/* AUTH TAB */}
                {
                    activeTab === 'auth' && (
                        <div style={sectionStyle}>
                            <h3 style={{ color: '#dcdcaa' }}>SECURITY & AUTHENTICATION</h3>
                            <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 20 }}>Configure OAuth providers for cloud authentication.</p>

                            <div style={{ marginBottom: 20, background: '#1e1e1e', padding: 20, borderRadius: 4, border: '1px solid #3e3e42' }}>
                                <h4 style={{ marginTop: 0, color: '#9cdcfe', fontSize: 13 }}>OAUTH CONFIGURATION</h4>
                                <p style={{ fontSize: 11, color: '#888', marginBottom: 15 }}>
                                    External providers require Client ID and Secret to authenticate.
                                    <br />Redirect URI: <code>http://localhost:[RANDOM_PORT]/callback</code>
                                </p>

                                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                                    {/* GOOGLE */}
                                    <div style={{ padding: 15, background: '#252526', borderRadius: 4 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                                            <strong style={{ color: '#fff' }}>Google</strong>
                                            {settings.auth?.cloudProvider === 'google' && <span style={{ color: '#4CAF50', fontSize: 10 }}>● ACTIVE</span>}
                                        </div>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                            <div>
                                                <label style={labelStyle}>CLIENT ID</label>
                                                <input
                                                    style={inputStyle}
                                                    value={settings.auth?.keys?.googleClientId || ''}
                                                    onChange={e => update('auth', 'keys', { ...(settings.auth?.keys || {}), googleClientId: e.target.value })}
                                                    placeholder="...apps.googleusercontent.com"
                                                />
                                            </div>
                                            <div>
                                                <label style={labelStyle}>CLIENT SECRET</label>
                                                <input
                                                    type="password"
                                                    style={inputStyle}
                                                    value={settings.auth?.keys?.googleClientSecret || ''}
                                                    onChange={e => update('auth', 'keys', { ...(settings.auth?.keys || {}), googleClientSecret: e.target.value })}
                                                    placeholder="GOCSPX-..."
                                                />
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => handleLogin('google')}
                                            style={{ marginTop: 10, background: '#fff', color: '#333', border: 'none', padding: '6px 12px', borderRadius: 2, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}
                                        >
                                            CONNECT GOOGLE
                                        </button>
                                    </div>

                                    {/* MICROSOFT */}
                                    <div style={{ padding: 15, background: '#252526', borderRadius: 4 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                                            <strong style={{ color: '#fff' }}>Microsoft (Azure AD)</strong>
                                            {settings.auth?.cloudProvider === 'microsoft' && <span style={{ color: '#4CAF50', fontSize: 10 }}>● ACTIVE</span>}
                                        </div>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                            <div>
                                                <label style={labelStyle}>CLIENT ID (Application ID)</label>
                                                <input
                                                    style={inputStyle}
                                                    value={settings.auth?.keys?.microsoftClientId || ''}
                                                    onChange={e => update('auth', 'keys', { ...(settings.auth?.keys || {}), microsoftClientId: e.target.value })}
                                                    placeholder="00000000-0000-..."
                                                />
                                            </div>
                                            <div>
                                                <label style={labelStyle}>CLIENT SECRET</label>
                                                <input
                                                    type="password"
                                                    style={inputStyle}
                                                    value={settings.auth?.keys?.microsoftClientSecret || ''}
                                                    onChange={e => update('auth', 'keys', { ...(settings.auth?.keys || {}), microsoftClientSecret: e.target.value })}
                                                    placeholder="Value..."
                                                />
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => handleLogin('microsoft')}
                                            style={{ marginTop: 10, background: '#0078d4', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 2, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}
                                        >
                                            CONNECT MICROSOFT
                                        </button>
                                    </div>

                                    {/* GITHUB */}
                                    <div style={{ padding: 15, background: '#252526', borderRadius: 4 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                                            <strong style={{ color: '#fff' }}>GitHub</strong>
                                            {settings.auth?.cloudProvider === 'github' && <span style={{ color: '#4CAF50', fontSize: 10 }}>● ACTIVE</span>}
                                        </div>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                            <div>
                                                <label style={labelStyle}>CLIENT ID</label>
                                                <input
                                                    style={inputStyle}
                                                    value={settings.auth?.keys?.githubClientId || ''}
                                                    onChange={e => update('auth', 'keys', { ...(settings.auth?.keys || {}), githubClientId: e.target.value })}
                                                    placeholder="Iv1. ..."
                                                />
                                            </div>
                                            <div>
                                                <label style={labelStyle}>CLIENT SECRET</label>
                                                <input
                                                    type="password"
                                                    style={inputStyle}
                                                    value={settings.auth?.keys?.githubClientSecret || ''}
                                                    onChange={e => update('auth', 'keys', { ...(settings.auth?.keys || {}), githubClientSecret: e.target.value })}
                                                    placeholder="SECRET..."
                                                />
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => handleLogin('github')}
                                            style={{ marginTop: 10, background: '#24292e', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 2, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}
                                        >
                                            CONNECT GITHUB
                                        </button>
                                    </div>
                                </div>
                            </div>

                            <div style={{ marginTop: 20, borderTop: '1px solid #444', paddingTop: 15 }}>
                                <h4 style={{ marginTop: 0, color: '#dcdcaa' }}>CREDENTIAL VAULT</h4>
                                <p style={{ fontSize: 11, color: '#888', marginBottom: 15 }}>
                                    Securely store API Keys, Passwords, and Configuration Objects for Workflows.
                                </p>

                                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
                                    <button
                                        onClick={() => {
                                            const current: any = { ...(settings.auth.keys || {}) };
                                            let i = 1;
                                            while (current[`NEW_KEY_${i}`]) i++;
                                            update('auth', 'keys', { ...current, [`NEW_KEY_${i}`]: '' });
                                        }}
                                        style={{ background: '#2d2d2d', border: '1px solid #444', color: '#fff', padding: '4px 8px', fontSize: 10, cursor: 'pointer' }}
                                    >
                                        + ADD SECRET
                                    </button>
                                </div>

                                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                    {settings.auth.keys && Object.entries(settings.auth.keys)
                                        // Filter out the hardcoded ones to avoid duplication if we want, 
                                        // but actually showing them all offers a unified view. 
                                        // However, the hardcoded inputs above control specific known keys. 
                                        // Let's filter out known keys from this generic list to avoid confusion?
                                        // Known: googleClientId, googleClientSecret, github..., microsoft..., discord...
                                        // Actually, let's just show *custom* ones or all? 
                                        // Showing all is safer for "Vault" concept. But editing complex objects might be hard in a single input.
                                        // Let's show all for now, but maybe use a textarea for value to support JSON.
                                        .map(([k, v]) => (
                                            <div key={k} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: '#252526', padding: 10, borderRadius: 4 }}>
                                                <input
                                                    value={k}
                                                    onChange={e => {
                                                        const newKey = e.target.value;
                                                        if (newKey !== k) {
                                                            const current: any = { ...settings.auth.keys };
                                                            current[newKey] = v;
                                                            delete current[k];
                                                            update('auth', 'keys', current);
                                                        }
                                                    }}
                                                    placeholder="KEY_NAME"
                                                    style={{ ...inputStyle, width: '200px', marginBottom: 0, fontFamily: 'Consolas', fontWeight: 'bold' }}
                                                />
                                                <textarea
                                                    value={typeof v === 'string' ? v : JSON.stringify(v)}
                                                    onChange={e => {
                                                        const current: any = { ...settings.auth.keys };
                                                        current[k] = e.target.value;
                                                        update('auth', 'keys', current);
                                                    }}
                                                    placeholder="VALUE (String or JSON)"
                                                    style={{ ...inputStyle, flex: 1, marginBottom: 0, fontFamily: 'Consolas', height: '38px', minHeight: '38px', resize: 'vertical' }}
                                                    spellCheck={false}
                                                />
                                                <button
                                                    onClick={() => {
                                                        if (confirm(`Delete secret '${k}'?`)) {
                                                            const current: any = { ...settings.auth.keys };
                                                            delete current[k];
                                                            update('auth', 'keys', current);
                                                        }
                                                    }}
                                                    style={{ color: '#ff4444', background: 'transparent', border: 'none', cursor: 'pointer', marginTop: 10 }}
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        ))}
                                    {(!settings.auth.keys || Object.keys(settings.auth.keys).length === 0) && (
                                        <div style={{ fontSize: 11, color: '#666', fontStyle: 'italic', textAlign: 'center' }}>No secrets stored.</div>
                                    )}
                                </div>
                            </div>


                            <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 20 }}>
                                Link a Cloud Identity using the keys above.
                            </p>

                            {
                                settings.auth.cloudEmail ? (
                                    <div style={{ background: '#2d2d2d', padding: 20, borderRadius: 4, border: '1px solid #007acc', display: 'flex', gap: 20, alignItems: 'center' }}>
                                        <img
                                            src={settings.auth.cloudAvatar || "https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y"}
                                            style={{ width: 50, height: 50, borderRadius: '50%' }}
                                            alt="Cloud Profile"
                                        />
                                        <div style={{ flex: 1 }}>
                                            <div style={{ fontSize: 14, fontWeight: 'bold', color: 'white' }}>
                                                {settings.auth.cloudName || 'Authenticated User'}
                                            </div>
                                            <div style={{ fontSize: 12, color: '#ccc' }}>
                                                {settings.auth.cloudEmail}
                                            </div>
                                            <div style={{ fontSize: 10, color: '#007acc', marginTop: 5 }}>
                                                VIA {settings.auth.cloudProvider?.toUpperCase()}
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => {
                                                update('auth', 'cloudEmail', '');
                                                update('auth', 'cloudToken', '');
                                            }}
                                            style={{ background: 'transparent', border: '1px solid #ff4444', color: '#ff4444', padding: '6px 12px', cursor: 'pointer', fontSize: 11 }}
                                        >
                                            DISCONNECT
                                        </button>
                                    </div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                        {status === 'Authenticating...' ? (
                                            <div style={{ textAlign: 'center', padding: 20, color: '#007acc' }}>
                                                Waiting for browser authentication...
                                            </div>
                                        ) : (
                                            <>
                                                <button
                                                    onClick={() => handleLogin('google')}
                                                    style={{
                                                        background: '#fff', color: '#333', border: 'none', padding: '12px',
                                                        borderRadius: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, fontWeight: 'bold'
                                                    }}
                                                >
                                                    <span style={{ color: '#4285F4' }}>G</span> Sign in with Google
                                                </button>

                                                <button
                                                    onClick={() => handleLogin('github')}
                                                    style={{
                                                        background: '#24292e', color: 'white', border: 'none', padding: '12px',
                                                        borderRadius: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, fontWeight: 'bold'
                                                    }}
                                                >
                                                    Sign in with GitHub
                                                </button>

                                                <button
                                                    onClick={() => handleLogin('microsoft')}
                                                    style={{
                                                        background: '#00a4ef', color: 'white', border: 'none', padding: '12px',
                                                        borderRadius: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, fontWeight: 'bold'
                                                    }}
                                                >
                                                    Sign in with Microsoft
                                                </button>

                                                <button
                                                    onClick={() => handleLogin('apple')}
                                                    style={{
                                                        background: '#000', color: 'white', border: 'none', padding: '12px',
                                                        borderRadius: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, fontWeight: 'bold'
                                                    }}
                                                >
                                                    Sign in with Apple
                                                </button>
                                                <div style={{ marginTop: 30, padding: 15, background: 'rgba(0, 122, 204, 0.1)', borderRadius: 4 }}>
                                                    <h4 style={{ margin: '0 0 10px 0', fontSize: 12, color: '#007acc' }}>UNLOCKS CAPABILITIES:</h4>
                                                    <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: '#ccc', lineHeight: 1.6 }}>
                                                        <li>Single Sign-On (SSO) for App Access</li>
                                                        <li>Cloud Backup (G-Drive / OneDrive)</li>
                                                        <li>Cloud Inference (Gemini / Azure OpenAI)</li>
                                                        <li>Synchronization across devices</li>
                                                    </ul>
                                                </div>
                                            </>
                                        )}
                                    </div >
                                )}
                        </div >
                    )
                }

                {/* SERVER TAB */}
                {
                    activeTab === 'server' && (
                        <div style={sectionStyle}>
                            <h3 style={{ color: '#dcdcaa' }}>EXTERNAL SERVERS (DEPLOY TARGETS)</h3>
                            <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 20 }}>Execution environments available to the Agent.</p>

                            <ModeSwitcher mode={settings.server.mode} onChange={m => update('server', 'mode', m)} />

                            {settings.server.mode === 'local' ? (
                                <div className="local-config">
                                    <label style={labelStyle}>LOCAL RUNTIME</label>
                                    <select
                                        style={selectStyle}
                                        value={settings.server.localRuntime}
                                        onChange={e => update('server', 'localRuntime', e.target.value)}
                                    >
                                        <option value="node">Node.js (Host)</option>
                                        <option value="python">Python (MCP)</option>
                                    </select>
                                </div>
                            ) : (
                                <div className="cloud-config">
                                    <Field label="HOST (IP/Domain)" value={settings.server.host} onChange={(e: any) => update('server', 'host', e.target.value)} />
                                    <Field label="USERNAME" value={settings.server.username} onChange={(e: any) => update('server', 'username', e.target.value)} />
                                    <Field label="SSH KEY PATH" value={settings.server.sshKey} onChange={(e: any) => update('server', 'sshKey', e.target.value)} />
                                </div>
                            )}
                        </div>
                    )
                }

                {/* AGENT TAB */}
                {
                    activeTab === 'agent' && (
                        <div style={sectionStyle}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                    <h3 style={{ margin: 0, color: '#dcdcaa' }}>AGENT IDENTITY & CONTEXT</h3>
                                    <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 20 }}>Configure the active persona and its operating rules.</p>
                                </div>
                                {/* Profile Selector */}
                                <select
                                    style={{ ...selectStyle, width: 200, border: '1px solid #007acc' }}
                                    value={settings.agent.activeProfileId}
                                    onChange={e => update('agent', 'activeProfileId', e.target.value)}
                                >
                                    {settings.agent.profiles.map(p => (
                                        <option key={p.id} value={p.id}>{p.name}</option>
                                    ))}
                                </select>
                            </div>

                            {/* Edit Current Profile */}
                            {(() => {
                                const profile = settings.agent.profiles.find(p => p.id === settings.agent.activeProfileId) || settings.agent.profiles[0];
                                const updateProfile = (field: string, val: any) => {
                                    const newProfiles = settings.agent.profiles.map(p => {
                                        if (p.id === profile.id) return { ...p, [field]: val };
                                        return p;
                                    });
                                    update('agent', 'profiles', newProfiles);
                                };
                                const updateNested = (category: 'rules' | 'workflows' | 'mcp', key: 'global' | 'workspace' | 'globalPath' | 'workspacePath', val: any) => {
                                    const newProfiles = settings.agent.profiles.map(p => {
                                        if (p.id === profile.id) return {
                                            ...p,
                                            [category]: { ...p[category], [key]: val }
                                        };
                                        return p;
                                    });
                                    update('agent', 'profiles', newProfiles);
                                };

                                return (
                                    <div>
                                        {/* IDENTITY BLOCK */}
                                        <div style={{ background: '#1e1e1e', padding: 20, marginBottom: 20, borderRadius: 4, border: '1px solid #3e3e42', display: 'flex', flexDirection: 'column', gap: 15 }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                                <div>
                                                    <h4 style={{ marginTop: 0, marginBottom: 5, color: '#9cdcfe' }}>IDENTITY MANIFESTO</h4>
                                                    <p style={{ fontSize: 11, color: '#888', margin: 0 }}>Define the Agent's entire existence using the Structured Format.</p>
                                                </div>
                                                <button
                                                    onClick={() => updateProfile('systemPrompt', `WORKSPACE NAME: [Name]
WORKSPACE PURPOSE: [Purpose]

1) PRIMARY DIRECTIVE (IMMUTABLE)
[Directive]

2) IDENTITY & VOICE CONSTRAINTS (IMMUTABLE)
Perspective: First-person ("I").
Tone: Minimalist, calm, practical.
[Constraints]

3) HARD LINGUISTIC GUARDRAILS (IMMUTABLE)
[Guardrails]

4) OPERATING CONTEXT
[Context Rules]
`)}
                                                    style={{ background: '#2d2d2d', border: '1px solid #444', color: '#ccc', padding: '4px 8px', fontSize: 10, cursor: 'pointer', borderRadius: 2 }}
                                                >
                                                    + INSERT FORMAT TEMPLATE
                                                </button>
                                            </div>

                                            <Field label="DISPLAY NAME" value={profile.name} onChange={(e: any) => updateProfile('name', e.target.value)} />

                                            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                                                <label style={labelStyle}>CORE DEFINITION (The "Bible")</label>
                                                <textarea
                                                    value={profile.systemPrompt}
                                                    onChange={e => updateProfile('systemPrompt', e.target.value)}
                                                    style={{
                                                        ...inputStyle,
                                                        height: 400,
                                                        fontFamily: 'Consolas, "Courier New", monospace',
                                                        fontSize: 13,
                                                        lineHeight: 1.5,
                                                        resize: 'vertical',
                                                        whiteSpace: 'pre',
                                                        overflowX: 'auto'
                                                    }}
                                                    placeholder="Paste your workspace definition here..."
                                                />
                                                <div style={{ fontSize: 10, color: '#666' }}>
                                                    Dynamic Tokens: [ASTRO_STATE], [USER_CONTEXT], [CAPABILITY_CONTEXT], [USER_QUERY]
                                                </div>
                                            </div>

                                            <label style={labelStyle}>CREATIVITY / TEMP ({profile.temperature})</label>
                                            <input
                                                type="range" min="0" max="1" step="0.1"
                                                value={profile.temperature}
                                                onChange={e => updateProfile('temperature', parseFloat(e.target.value))}
                                                style={{ width: '100%' }}
                                            />

                                            {/* IN-UNIVERSE IDENTITY */}
                                            <div style={{ marginTop: 20, paddingTop: 20, borderTop: '1px solid #3e3e42' }}>
                                                <h4 style={{ marginTop: 0, marginBottom: 5, color: '#ce9178', fontSize: 12 }}>IN-UNIVERSE IDENTITY (Lore/RP)</h4>
                                                <p style={{ fontSize: 10, color: '#888', marginBottom: 15 }}>
                                                    Fictional birth data that the agent references when asked about their past.
                                                </p>
                                                <div style={{ display: 'flex', gap: 15 }}>
                                                    <div style={{ flex: 1 }}>
                                                        <label style={labelStyle}>BIRTH DATE (In-Universe)</label>
                                                        <input
                                                            style={inputStyle}
                                                            value={profile.birthDate || ''}
                                                            onChange={(e) => updateProfile('birthDate', e.target.value)}
                                                            placeholder="2923-05-15"
                                                        />
                                                    </div>
                                                    <div style={{ flex: 1 }}>
                                                        <label style={labelStyle}>BIRTH PLACE (In-Universe)</label>
                                                        <input
                                                            style={inputStyle}
                                                            value={profile.birthPlace || ''}
                                                            onChange={(e) => updateProfile('birthPlace', e.target.value)}
                                                            placeholder="Levski, Delamar"
                                                        />
                                                    </div>
                                                </div>
                                            </div>

                                            {/* ASTRO PROFILE */}
                                            <div style={{ marginTop: 20, paddingTop: 20, borderTop: '1px solid #3e3e42' }}>
                                                <h4 style={{ marginTop: 0, marginBottom: 5, color: '#9cdcfe', fontSize: 12 }}>ASTRO PROFILE (Emotional Modulation)</h4>
                                                <p style={{ fontSize: 10, color: '#888', marginBottom: 15 }}>
                                                    Real-world birth data for astrological emotional state calculations. Uses actual dates/places.
                                                </p>
                                                <div style={{ display: 'flex', gap: 15 }}>
                                                    <div style={{ flex: 1 }}>
                                                        <label style={labelStyle}>ASTRO BIRTH DATE (Real-World ISO 8601)</label>
                                                        <input
                                                            style={inputStyle}
                                                            value={profile.astroBirthDate || ''}
                                                            onChange={(e) => updateProfile('astroBirthDate', e.target.value)}
                                                            placeholder="1990-01-01T12:00:00"
                                                        />
                                                    </div>
                                                    <div style={{ flex: 1 }}>
                                                        <label style={labelStyle}>ASTRO BIRTH PLACE (Real-World City)</label>
                                                        <input
                                                            style={inputStyle}
                                                            value={profile.astroBirthPlace || ''}
                                                            onChange={(e) => updateProfile('astroBirthPlace', e.target.value)}
                                                            placeholder="London"
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        {/* CONTEXT RULES BLOCK - Keeping these for "Injection" on top of the Bible */}
                                        <div style={{ background: '#252526', padding: 20, marginBottom: 20, borderRadius: 4, border: '1px solid #3e3e42' }}>
                                            <h4 style={{ marginTop: 0, color: '#ce9178' }}>DYNAMIC INJECTIONS</h4>
                                            <p style={{ fontSize: 11, color: '#888', marginBottom: 15 }}>Additional context injected <i>after</i> the Manifesto depending on scope.</p>

                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                                                <div>
                                                    <label style={{ ...labelStyle, color: '#dcdcaa' }}>GLOBAL INJECTIONS</label>
                                                    <textarea
                                                        value={profile.rules.global}
                                                        onChange={e => updateNested('rules', 'global', e.target.value)}
                                                        style={{ ...inputStyle, height: 100 }}
                                                        placeholder="Rules active across ALL Workspaces..."
                                                    />
                                                </div>
                                                <div>
                                                    <label style={{ ...labelStyle, color: '#4ec9b0' }}>WORKSPACE INJECTIONS</label>
                                                    <textarea
                                                        value={profile.rules.workspace}
                                                        onChange={e => updateNested('rules', 'workspace', e.target.value)}
                                                        style={{ ...inputStyle, height: 100 }}
                                                        placeholder="Rules active ONLY in this Workspace..."
                                                    />
                                                </div>
                                            </div>
                                        </div>

                                        {/* WORKFLOWS & MCP */}
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                                            <div style={{ background: '#252526', padding: 20, borderRadius: 4, border: '1px solid #3e3e42' }}>
                                                <h4 style={{ marginTop: 0, color: '#D7BA7D' }}>WORKFLOW PATHS</h4>
                                                <Field label="GLOBAL WORKFLOWS PATH" value={profile.workflows.globalPath} onChange={(e: any) => updateNested('workflows', 'globalPath', e.target.value)} />
                                                <Field label="WORKSPACE WORKFLOWS PATH" value={profile.workflows.workspacePath} onChange={(e: any) => updateNested('workflows', 'workspacePath', e.target.value)} />
                                            </div>

                                            <div style={{ background: '#252526', padding: 20, borderRadius: 4, border: '1px solid #3e3e42' }}>
                                                <h4 style={{ marginTop: 0, color: '#c586c0' }}>MCP SERVERS</h4>
                                                <div style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>Enabled Model Context Protocol Servers</div>

                                                <div style={{ marginBottom: 10 }}>
                                                    <label style={{ ...labelStyle, color: '#dcdcaa' }}>GLOBAL MCPs</label>
                                                    <input
                                                        style={inputStyle}
                                                        value={profile.mcp.global.join(', ')}
                                                        onChange={e => updateNested('mcp', 'global', e.target.value.split(',').map(s => s.trim()))}
                                                        placeholder="filesystem, memory, github"
                                                    />
                                                </div>
                                                <div>
                                                    <label style={{ ...labelStyle, color: '#4ec9b0' }}>WORKSPACE MCPs</label>
                                                    <input
                                                        style={inputStyle}
                                                        value={profile.mcp.workspace.join(', ')}
                                                        onChange={e => updateNested('mcp', 'workspace', e.target.value.split(',').map(s => s.trim()))}
                                                        placeholder="postgres, local-tools"
                                                    />
                                                </div>
                                            </div>
                                        </div>

                                    </div>
                                );
                            })()}
                        </div>
                    )
                }


                {/* WORKFLOWS TAB */}
                {
                    activeTab === 'workflows' && (
                        <div style={sectionStyle}>
                            <h3 style={{ color: '#dcdcaa' }}>WORKFLOW ORCHESTRATION</h3>
                            <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 20 }}>Manage autonomous workflows, MCP servers, and tool functions.</p>

                            {/* REMOTE IMPORT SECTION */}
                            <div style={{ background: '#1e1e1e', padding: 15, borderRadius: 4, border: '1px solid #3e3e42', marginBottom: 20 }}>
                                <h4 style={{ marginTop: 0, marginBottom: 10, color: '#9cdcfe', fontSize: 12 }}>REMOTE WORKFLOW IMPORT</h4>
                                <div style={{ display: 'flex', gap: 10 }}>
                                    <input
                                        style={{ ...inputStyle, flex: 1, marginBottom: 0 }}
                                        placeholder="https://example.com/workflows.json"
                                        value={settings.workflows?.remoteImportUrl || ''}
                                        onChange={e => update('workflows', 'remoteImportUrl', e.target.value)}
                                    />
                                    <button
                                        onClick={async () => {
                                            if (!settings.workflows?.remoteImportUrl) {
                                                setStatus('Please provide a URL first.');
                                                return;
                                            }
                                            setStatus('Fetching remote catalog...');
                                            // @ts-ignore
                                            const result = await window.tala.importWorkflows(settings.workflows.remoteImportUrl);
                                            if (result.success) {
                                                setStatus(`Imported ${result.count} workflows!`);
                                                loadWorkflows();
                                            } else {
                                                setStatus(`Import failed: ${result.error}`);
                                            }
                                            setTimeout(() => setStatus(''), 3000);
                                        }}
                                        style={{ background: '#3e3e42', color: 'white', border: 'none', padding: '0 20px', borderRadius: 2, cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}
                                    >
                                        IMPORT
                                    </button>
                                </div>
                                <p style={{ fontSize: 10, color: '#666', marginTop: 8 }}>Supports JSON catalogs or direct workflow files.</p>
                            </div>

                            {/* SUB TABS */}
                            <div style={{ display: 'flex', borderBottom: '1px solid #333', marginBottom: 20 }}>
                                {['workflow', 'mcp', 'function'].map(sub => (
                                    <div
                                        key={sub}
                                        style={{
                                            padding: '8px 16px',
                                            cursor: 'pointer',
                                            color: workflowSubTab === sub ? '#fff' : '#888',
                                            borderBottom: workflowSubTab === sub ? '2px solid #007acc' : '2px solid transparent',
                                            fontWeight: workflowSubTab === sub ? 'bold' : 'normal',
                                            fontSize: 11,
                                            textTransform: 'uppercase'
                                        }}
                                        onClick={() => setWorkflowSubTab(sub as any)}
                                    >
                                        {sub}
                                    </div>
                                ))}
                            </div>

                            {/* CONTENT: WORKFLOW */}
                            {workflowSubTab === 'workflow' && (
                                <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: 20, height: '70vh', minHeight: '500px' }}>
                                    {/* SIDEBAR LIST */}
                                    <div style={{ background: '#252526', border: '1px solid #3e3e42', borderRadius: 4, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                                        <div style={{ padding: 10, borderBottom: '1px solid #3e3e42', background: '#2d2d2d', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <span style={{ fontWeight: 'bold', fontSize: 11, color: '#ccc' }}>WORKFLOWS</span>
                                            <div style={{ display: 'flex', gap: 5 }}>
                                                <button
                                                    onClick={() => setShowTemplates(!showTemplates)}
                                                    style={{ background: '#3e3e42', border: 'none', color: '#ccc', fontSize: 10, padding: '2px 6px', borderRadius: 2, cursor: 'pointer', fontWeight: 'bold' }}
                                                >
                                                    TEMPLATES
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        const newId = `wf-${Date.now()}`;
                                                        const newWf = { id: newId, name: 'New Workflow', nodes: [], edges: [], active: true };
                                                        // @ts-ignore
                                                        window.tala.saveWorkflow(newWf).then(() => {
                                                            setWorkflows(prev => [...prev, newWf]);
                                                            setSelectedWorkflowId(newId);
                                                        });
                                                    }}
                                                    style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: 16, cursor: 'pointer' }}
                                                >
                                                    +
                                                </button>
                                            </div>
                                        </div>
                                        {showTemplates && (
                                            <div style={{ background: '#1e1e1e', padding: 10, borderBottom: '1px solid #3e3e42', maxHeight: '300px', overflowY: 'auto' }}>
                                                <div style={{ fontSize: 10, color: '#888', marginBottom: 8, fontWeight: 'bold' }}>SELECT A TEMPLATE</div>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                                                    {WORKFLOW_TEMPLATES.map(tpl => (
                                                        <div
                                                            key={tpl.id}
                                                            onClick={async () => {
                                                                const newId = `wf-${Date.now()}`;
                                                                const newWf = {
                                                                    id: newId,
                                                                    name: tpl.name,
                                                                    nodes: tpl.nodes,
                                                                    edges: tpl.edges,
                                                                    active: true
                                                                };
                                                                // @ts-ignore
                                                                await window.tala.saveWorkflow(newWf);
                                                                setWorkflows(prev => [...prev, newWf]);
                                                                setSelectedWorkflowId(newId);
                                                                setShowTemplates(false);
                                                            }}
                                                            style={{
                                                                padding: '6px 8px',
                                                                background: '#2d2d2d',
                                                                borderRadius: 3,
                                                                cursor: 'pointer',
                                                                fontSize: 11,
                                                                border: '1px solid #3e3e42'
                                                            }}
                                                            onMouseEnter={(e) => e.currentTarget.style.borderColor = '#007acc'}
                                                            onMouseLeave={(e) => e.currentTarget.style.borderColor = '#3e3e42'}
                                                        >
                                                            <div style={{ fontWeight: 'bold', color: '#569cd6' }}>{tpl.name}</div>
                                                            <div style={{ fontSize: 9, color: '#888', marginTop: 2 }}>{tpl.description}</div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                        <div style={{ overflowY: 'auto', flex: 1 }}>
                                            {workflows.map((wf: any) => (
                                                <div
                                                    key={wf.id}
                                                    onClick={() => setSelectedWorkflowId(wf.id)}
                                                    style={{
                                                        padding: '8px 10px',
                                                        cursor: 'pointer',
                                                        background: selectedWorkflowId === wf.id ? '#37373d' : 'transparent',
                                                        borderBottom: '1px solid #303030',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'space-between'
                                                    }}
                                                >
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                                                        <input
                                                            type="checkbox"
                                                            checked={wf.active}
                                                            onClick={(e) => e.stopPropagation()}
                                                            onChange={(e) => {
                                                                const updated = { ...wf, active: e.target.checked };
                                                                // @ts-ignore
                                                                window.tala.saveWorkflow(updated).then(() => {
                                                                    setWorkflows(prev => prev.map(p => p.id === wf.id ? updated : p));
                                                                });
                                                            }}
                                                        />
                                                        <span style={{ fontSize: 13, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{wf.name}</span>
                                                    </div>
                                                    <button
                                                        onClick={async (e) => {
                                                            e.stopPropagation();
                                                            const api = (window as any).tala;
                                                            if (!api?.exportWorkflowToPython) {
                                                                alert('Export not available. Please restart the application.');
                                                                return;
                                                            }
                                                            try {
                                                                const result = await api.exportWorkflowToPython(wf.id);
                                                                if (result?.success) {
                                                                    alert(`Workflow "${wf.name}" exported to:\n${result.path}`);
                                                                } else if (result?.error) {
                                                                    alert(`Export failed: ${result.error}`);
                                                                }
                                                            } catch (err: any) {
                                                                alert(`Export error: ${err.message}`);
                                                            }
                                                        }}
                                                        title="Export workflow to Python"
                                                        style={{ color: '#569cd6', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 'bold', padding: '0 4px' }}
                                                    >
                                                        ↑ PY
                                                    </button>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            if (confirm('Delete workflow?')) {
                                                                // @ts-ignore
                                                                window.tala.deleteWorkflow(wf.id).then(() => {
                                                                    setWorkflows(prev => prev.filter(p => p.id !== wf.id));
                                                                    if (selectedWorkflowId === wf.id) setSelectedWorkflowId(null);
                                                                });
                                                            }
                                                        }}
                                                        style={{ color: '#666', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 14 }}
                                                    >
                                                        &times;
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    {/* EDITOR CANVAS */}
                                    <div style={{ background: '#1e1e1e', borderRadius: 4, border: '1px solid #3e3e42', overflow: 'hidden', position: 'relative' }}>
                                        {selectedWorkflowId ? (
                                            (() => {
                                                const wf = workflows.find(w => w.id === selectedWorkflowId);
                                                if (!wf) return null;
                                                return (
                                                    <WorkflowEditor
                                                        workflow={wf}
                                                        onSave={(updatedWf: any) => {
                                                            // @ts-ignore
                                                            window.tala.saveWorkflow(updatedWf).then(() => {
                                                                setWorkflows(prev => prev.map(p => p.id === updatedWf.id ? updatedWf : p));
                                                                setStatus('Workflow Saved!');
                                                                setTimeout(() => setStatus(''), 2000);
                                                            });
                                                        }}
                                                    />
                                                );
                                            })()
                                        ) : (
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666' }}>
                                                Select or create a workflow to edit.
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* CONTENT: MCP */}
                            {workflowSubTab === 'mcp' && (
                                <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: 20, height: '450px' }}>
                                    {/* LIST COLUMN */}
                                    <div style={{ background: '#252526', border: '1px solid #3e3e42', borderRadius: 4, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                                        <div style={{ padding: 10, borderBottom: '1px solid #3e3e42', background: '#2d2d2d' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                                                <span style={{ fontWeight: 'bold', fontSize: 11, color: '#ccc' }}>SERVERS</span>
                                                <button
                                                    onClick={() => {
                                                        const newId = `mcp-${Math.random().toString(36).substr(2, 5)}`;
                                                        const newServer: any = { id: newId, name: 'New Server', type: 'stdio', command: 'npx', args: [], enabled: true };
                                                        setSettings(prev => ({ ...prev, mcpServers: [...(prev.mcpServers || []), newServer] }));
                                                        setSelectedMcpId(newId);
                                                    }}
                                                    style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: 16, cursor: 'pointer' }}
                                                >
                                                    +
                                                </button>
                                            </div>
                                            <input
                                                value={mcpSearch}
                                                onChange={(e) => setMcpSearch(e.target.value)}
                                                placeholder="Search servers..."
                                                style={{
                                                    width: '100%',
                                                    background: '#1e1e1e',
                                                    border: '1px solid #3e3e42',
                                                    color: '#fff',
                                                    padding: '4px 8px',
                                                    fontSize: 12,
                                                    borderRadius: 2,
                                                    outline: 'none'
                                                }}
                                            />
                                        </div>
                                        <div style={{ overflowY: 'auto', flex: 1 }}>
                                            {(settings.mcpServers || [])
                                                .filter((srv: any) => srv.name.toLowerCase().includes(mcpSearch.toLowerCase()))
                                                .map((srv: any) => (
                                                    <div
                                                        key={srv.id}
                                                        onClick={() => setSelectedMcpId(srv.id)}
                                                        style={{
                                                            padding: '8px 10px',
                                                            cursor: 'pointer',
                                                            background: selectedMcpId === srv.id ? '#37373d' : 'transparent',
                                                            borderBottom: '1px solid #303030',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            gap: 8
                                                        }}
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={srv.enabled}
                                                            onChange={(e) => {
                                                                e.stopPropagation();
                                                                const list = [...(settings.mcpServers || [])];
                                                                const t = list.find((x: any) => x.id === srv.id);
                                                                if (t) t.enabled = e.target.checked;
                                                                setSettings(prev => ({ ...prev, mcpServers: list }));
                                                            }}
                                                        />
                                                        <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: srv.enabled ? '#fff' : '#888' }}>
                                                            {srv.name}
                                                        </div>
                                                    </div>
                                                ))}
                                        </div>
                                    </div>

                                    {/* DETAILS COLUMN */}
                                    <div style={{ background: '#1e1e1e', padding: 20, borderRadius: 4, border: '1px solid #3e3e42', overflowY: 'auto' }}>
                                        {(() => {
                                            const srv = (settings.mcpServers || []).find((s: any) => s.id === selectedMcpId);
                                            if (!srv) {
                                                return <div style={{ color: '#666', textAlign: 'center', marginTop: 40 }}>Select an MCP Server to configure.</div>;
                                            }

                                            return (
                                                <div>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20, alignItems: 'center' }}>
                                                        <h4 style={{ margin: 0, color: '#c586c0' }}>{srv.name.toUpperCase()}</h4>
                                                        <button
                                                            onClick={() => {
                                                                const list = (settings.mcpServers || []).filter((s: any) => s.id !== srv.id);
                                                                setSettings(prev => ({ ...prev, mcpServers: list }));
                                                                setSelectedMcpId(null);
                                                            }}
                                                            style={{ color: '#ff4444', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 11 }}
                                                        >
                                                            DELETE
                                                        </button>
                                                    </div>

                                                    <Field
                                                        label="NAME"
                                                        value={srv.name}
                                                        onChange={(e: any) => {
                                                            const list = [...settings.mcpServers];
                                                            const t = list.find((x: any) => x.id === srv.id);
                                                            if (t) t.name = e.target.value;
                                                            setSettings(prev => ({ ...prev, mcpServers: list }));
                                                        }}
                                                    />

                                                    <div style={{ marginBottom: 15 }}>
                                                        <label style={labelStyle}>TYPE</label>
                                                        <select
                                                            style={selectStyle}
                                                            value={srv.type}
                                                            onChange={(e: any) => {
                                                                const list = [...settings.mcpServers];
                                                                const t = list.find((x: any) => x.id === srv.id);
                                                                if (t) t.type = e.target.value;
                                                                setSettings(prev => ({ ...prev, mcpServers: list }));
                                                            }}
                                                        >
                                                            <option value="stdio">STDIO (Local Command)</option>
                                                            <option value="websocket">WebSocket (Remote)</option>
                                                        </select>
                                                    </div>

                                                    {srv.type === 'stdio' ? (
                                                        <>
                                                            <Field
                                                                label="COMMAND"
                                                                value={srv.command}
                                                                onChange={(e: any) => {
                                                                    const list = [...settings.mcpServers];
                                                                    const t = list.find((x: any) => x.id === srv.id);
                                                                    if (t) t.command = e.target.value;
                                                                    setSettings(prev => ({ ...prev, mcpServers: list }));
                                                                }}
                                                                placeholder="npx, python, etc..."
                                                            />
                                                            <Field
                                                                label="ARGUMENTS (Space separated)"
                                                                value={srv.args ? srv.args.join(' ') : ''}
                                                                onChange={(e: any) => {
                                                                    const list = [...settings.mcpServers];
                                                                    const t = list.find((x: any) => x.id === srv.id);
                                                                    if (t) t.args = e.target.value.split(' ');
                                                                    setSettings(prev => ({ ...prev, mcpServers: list }));
                                                                }}
                                                                placeholder="-y @modelcontextprotocol/server-filesystem ./"
                                                            />
                                                        </>
                                                    ) : (
                                                        <Field
                                                            label="WEBSOCKET URL"
                                                            value={srv.url}
                                                            onChange={(e: any) => {
                                                                const list = [...settings.mcpServers];
                                                                const t = list.find((x: any) => x.id === srv.id);
                                                                if (t) t.url = e.target.value;
                                                                setSettings(prev => ({ ...prev, mcpServers: list }));
                                                            }}
                                                            placeholder="ws://localhost:3000/mcp"
                                                        />
                                                    )}

                                                    <div style={{ marginTop: 20, borderTop: '1px solid #333', paddingTop: 15 }}>
                                                        <h5 style={{ margin: '0 0 10px 0', color: '#fff' }}>AVAILABLE TOOLS & RESOURCES</h5>
                                                        {mcpCapabilities ? (
                                                            <div style={{ fontSize: 11, color: '#ccc' }}>
                                                                <div style={{ marginBottom: 10 }}>
                                                                    <strong style={{ color: '#4fc1ff' }}>Tools ({mcpCapabilities.tools?.length || 0})</strong>
                                                                    <ul style={{ paddingLeft: 15, margin: '5px 0', color: '#888' }}>
                                                                        {(mcpCapabilities.tools || []).map((t: any) => (
                                                                            <li key={t.name} style={{ marginBottom: 4 }}>
                                                                                <span style={{ color: '#dcdcaa' }}>{t.name}</span>
                                                                                <span style={{ marginLeft: 5, opacity: 0.7 }}>- {t.description?.substring(0, 50)}{t.description?.length > 50 ? '...' : ''}</span>
                                                                            </li>
                                                                        ))}
                                                                    </ul>
                                                                </div>
                                                                <div>
                                                                    <strong style={{ color: '#4fc1ff' }}>Resources ({mcpCapabilities.resources?.length || 0})</strong>
                                                                    <ul style={{ paddingLeft: 15, margin: '5px 0', color: '#888' }}>
                                                                        {(mcpCapabilities.resources || []).map((r: any) => (
                                                                            <li key={r.uri}>{r.name}</li>
                                                                        ))}
                                                                    </ul>
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <div style={{ fontSize: 11, color: '#888', fontStyle: 'italic' }}>
                                                                {srv.enabled ? "Fetching capabilities..." : "Server is disabled. Enable to fetch capabilities."}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })()}
                                    </div>
                                </div>
                            )}

                            {/* CONTENT: FUNCTION */}
                            {workflowSubTab === 'function' && (
                                <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: 20, height: '450px' }}>
                                    {/* LIST COLUMN */}
                                    <div style={{ background: '#252526', border: '1px solid #3e3e42', borderRadius: 4, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                                        <div style={{ padding: 10, borderBottom: '1px solid #3e3e42', background: '#2d2d2d' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                                                <span style={{ fontWeight: 'bold', fontSize: 11, color: '#ccc' }}>FUNCTIONS</span>
                                                <button
                                                    onClick={() => {
                                                        const newName = `func_${Math.floor(Math.random() * 1000)}`;
                                                        const newFn = { name: newName, type: 'python', content: 'print("Hello World")' };
                                                        setFunctions(prev => [...prev, newFn]);
                                                        setSelectedFunc(newName);
                                                    }}
                                                    style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: 16, cursor: 'pointer' }}
                                                >
                                                    +
                                                </button>
                                            </div>
                                            <input
                                                value={functionSearch}
                                                onChange={(e) => setFunctionSearch(e.target.value)}
                                                placeholder="Search functions..."
                                                style={{
                                                    width: '100%',
                                                    background: '#1e1e1e',
                                                    border: '1px solid #3e3e42',
                                                    color: '#fff',
                                                    padding: '4px 8px',
                                                    fontSize: 12,
                                                    borderRadius: 2,
                                                    outline: 'none'
                                                }}
                                            />
                                        </div>
                                        <div style={{ overflowY: 'auto', flex: 1 }}>
                                            {functions
                                                .filter(fn => fn.name.toLowerCase().includes(functionSearch.toLowerCase()))
                                                .map((fn: any) => (
                                                    <div
                                                        key={fn.name}
                                                        onClick={() => setSelectedFunc(fn.name)}
                                                        style={{
                                                            padding: '8px 10px',
                                                            cursor: 'pointer',
                                                            background: selectedFunc === fn.name ? '#37373d' : 'transparent',
                                                            borderBottom: '1px solid #303030',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            gap: 8
                                                        }}
                                                    >
                                                        <div style={{
                                                            width: 8, height: 8, borderRadius: '50%',
                                                            background: fn.type === 'python' ? '#3572A5' : '#F7DF1E'
                                                        }} title={fn.type} />
                                                        <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: '#fff' }}>
                                                            {fn.name}
                                                        </div>
                                                    </div>
                                                ))}
                                        </div>
                                    </div>

                                    {/* EDITOR COLUMN */}
                                    <div style={{ background: '#1e1e1e', padding: 20, borderRadius: 4, border: '1px solid #3e3e42', display: 'flex', flexDirection: 'column' }}>
                                        {(() => {
                                            const fn = functions.find(f => f.name === selectedFunc);
                                            if (!fn) {
                                                return <div style={{ color: '#666', textAlign: 'center', marginTop: 40 }}>Select a function to edit.</div>;
                                            }

                                            return (
                                                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20, alignItems: 'center' }}>
                                                        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                                            <Field
                                                                label="KEYWORD"
                                                                value={fn.name}
                                                                onChange={(e: any) => {
                                                                    const list = [...functions];
                                                                    const t = list.find(x => x.name === fn.name); // Note: Renaming breaks ID match unless we track ID separately. For now, simplistic.
                                                                    if (t) {
                                                                        // We update the name in place, but need to update selectedFunc if we want to keep it selected?
                                                                        // Actually renaming key is tricky. Let's assume name is key.
                                                                        t.name = e.target.value.replace(/[^a-zA-Z0-9_-]/g, '');
                                                                        setSelectedFunc(t.name);
                                                                        setFunctions(list);
                                                                    }
                                                                }}
                                                                placeholder="my_script"
                                                            />
                                                            <div style={{ marginLeft: 10 }}>
                                                                <label style={labelStyle} >TYPE</label>
                                                                <select
                                                                    style={selectStyle}
                                                                    value={fn.type}
                                                                    onChange={(e: any) => {
                                                                        const list = [...functions];
                                                                        const t = list.find(x => x.name === fn.name);
                                                                        if (t) t.type = e.target.value;
                                                                        setFunctions(list);
                                                                    }}
                                                                >
                                                                    <option value="python">Python</option>
                                                                    <option value="javascript">Node.js</option>
                                                                </select>
                                                            </div>
                                                        </div>
                                                        <div style={{ display: 'flex', gap: 10 }}>
                                                            <button
                                                                onClick={() => {
                                                                    // @ts-ignore
                                                                    window.tala.saveFunction(fn).then(() => {
                                                                        setStatus('Function Saved!');
                                                                        setTimeout(() => setStatus(''), 2000);
                                                                        loadFunctions();
                                                                    });
                                                                }}
                                                                style={{
                                                                    background: '#0e639c', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 2, cursor: 'pointer', fontSize: 12
                                                                }}
                                                            >
                                                                SAVE
                                                            </button>
                                                            <button
                                                                onClick={() => {
                                                                    if (confirm('Delete this function?')) {
                                                                        // @ts-ignore
                                                                        window.tala.deleteFunction(fn).then(() => {
                                                                            setFunctions(prev => prev.filter(f => f.name !== fn.name));
                                                                            setSelectedFunc(null);
                                                                        });
                                                                    }
                                                                }}
                                                                style={{ color: '#ff4444', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 11 }}
                                                            >
                                                                DELETE
                                                            </button>
                                                        </div>
                                                    </div>

                                                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                                                        <label style={labelStyle}>CODE CONTENT</label>
                                                        <textarea
                                                            value={fn.content}
                                                            onChange={(e) => {
                                                                const list = [...functions];
                                                                const t = list.find(x => x.name === fn.name);
                                                                if (t) t.content = e.target.value;
                                                                setFunctions(list);
                                                            }}
                                                            style={{
                                                                flex: 1,
                                                                background: '#1e1e1e',
                                                                border: '1px solid #3e3e42',
                                                                color: '#dcdcaa',
                                                                fontFamily: 'Consolas, "Courier New", monospace',
                                                                fontSize: 13,
                                                                padding: 10,
                                                                resize: 'none',
                                                                outline: 'none'
                                                            }}
                                                            spellCheck={false}
                                                        />
                                                    </div>
                                                    <div style={{ marginTop: 10, fontSize: 11, color: '#666' }}>
                                                        Call this in chat with: <code style={{ color: '#ce9178' }}>/{fn.name} [args]</code>
                                                    </div>
                                                </div>
                                            );
                                        })()}
                                    </div>
                                </div>
                            )}
                        </div>
                    )
                }

                {/* GUARDRAILS TAB */}
                {
                    activeTab === 'guardrails' && (
                        <div style={sectionStyle}>
                            <h2 style={{ color: '#dcdcaa', marginBottom: 5 }}>GUARDRAILS</h2>
                            <p style={{ fontSize: 12, opacity: 0.7, marginBottom: 20 }}>Define safety rules that can be applied globally, per agent, or per session.</p>

                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 15 }}>
                                <button
                                    onClick={() => {
                                        const newGuardrail = {
                                            id: `guardrail-${Date.now()}`,
                                            name: 'New Guardrail',
                                            rules: 'Content must be safe and appropriate.',
                                            enabled: true,
                                            scope: 'global' as const
                                        };
                                        const updated = [...(settings.guardrails || []), newGuardrail];
                                        setSettings({ ...settings, guardrails: updated });
                                    }}
                                    style={{ background: '#2da042', color: '#fff', border: 'none', padding: '8px 16px', cursor: 'pointer', fontSize: 12 }}
                                >
                                    + ADD GUARDRAIL
                                </button>
                            </div>

                            {/* GUARDRAIL LIST */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
                                {(settings.guardrails || []).map((g: any, idx: number) => (
                                    <div
                                        key={g.id}
                                        style={{
                                            background: '#252526',
                                            border: '1px solid #3e3e42',
                                            padding: 15
                                        }}
                                    >
                                        {/* HEADER ROW */}
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                                            <input
                                                value={g.name}
                                                onChange={(e) => {
                                                    const updated = [...(settings.guardrails || [])];
                                                    updated[idx] = { ...updated[idx], name: e.target.value };
                                                    setSettings({ ...settings, guardrails: updated });
                                                }}
                                                style={{ background: 'transparent', border: 'none', color: '#dcdcaa', fontSize: 14, fontWeight: 'bold', flex: 1 }}
                                            />
                                            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#888' }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={g.enabled}
                                                        onChange={(e) => {
                                                            const updated = [...(settings.guardrails || [])];
                                                            updated[idx] = { ...updated[idx], enabled: e.target.checked };
                                                            setSettings({ ...settings, guardrails: updated });
                                                        }}
                                                    />
                                                    Enabled
                                                </label>
                                                <button
                                                    onClick={() => {
                                                        const updated = (settings.guardrails || []).filter((_: any, i: number) => i !== idx);
                                                        setSettings({ ...settings, guardrails: updated });
                                                    }}
                                                    style={{ background: '#c53030', color: '#fff', border: 'none', padding: '4px 8px', cursor: 'pointer', fontSize: 11 }}
                                                >
                                                    DELETE
                                                </button>
                                            </div>
                                        </div>

                                        {/* SCOPE ROW */}
                                        <div style={{ display: 'flex', gap: 15, marginBottom: 10, alignItems: 'center' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                                <label style={{ fontSize: 11, color: '#888' }}>Scope:</label>
                                                <select
                                                    value={g.scope || 'global'}
                                                    onChange={(e) => {
                                                        const updated = [...(settings.guardrails || [])];
                                                        const newScope = e.target.value as 'global' | 'agent' | 'session';
                                                        updated[idx] = { ...updated[idx], scope: newScope };
                                                        setSettings({ ...settings, guardrails: updated });
                                                    }}
                                                    style={{ background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: '4px 8px', fontSize: 11 }}
                                                >
                                                    <option value="global">Global (All Agents)</option>
                                                    <option value="agent">Per Agent</option>
                                                    <option value="session">Per Session (Temporary)</option>
                                                </select>
                                            </div>
                                        </div>

                                        {/* RULES TEXTAREA */}
                                        <textarea
                                            value={g.rules}
                                            onChange={(e) => {
                                                const updated = [...(settings.guardrails || [])];
                                                updated[idx] = { ...updated[idx], rules: e.target.value };
                                                setSettings({ ...settings, guardrails: updated });
                                            }}
                                            rows={4}
                                            placeholder="Enter safety rules..."
                                            style={{ width: '100%', background: '#1e1e1e', border: '1px solid #3e3e42', color: '#fff', padding: 10, fontSize: 12, resize: 'vertical' }}
                                        />

                                        {/* SCOPE INDICATOR */}
                                        <div style={{ marginTop: 8, fontSize: 10, color: '#569cd6' }}>
                                            {g.scope === 'global' && '🌐 Applies to all agents and sessions'}
                                            {g.scope === 'agent' && '👤 Assign to agents in the "agent Providers" tab'}
                                            {g.scope === 'session' && '⏱️ Temporary - cleared when app restarts'}
                                        </div>
                                    </div>
                                ))}
                                {(settings.guardrails || []).length === 0 && (
                                    <div style={{ color: '#555', fontStyle: 'italic', padding: 20, textAlign: 'center' }}>
                                        No guardrails defined. Click "+ ADD GUARDRAIL" to create safety rules.
                                    </div>
                                )}
                            </div>

                            <div style={{ marginTop: 20, padding: 15, background: '#1e1e1e', border: '1px solid #3e3e42' }}>
                                <div style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>Note: Changes are saved when you click "APPLY CHANGES" at the top.</div>
                                <div style={{ fontSize: 11, color: '#569cd6' }}>
                                    <strong>Scope Guide:</strong><br />
                                    • <strong>Global:</strong> Applies to all agents and sessions<br />
                                    • <strong>Per Agent:</strong> Assign in "agent Providers" tab on each agent profile<br />
                                    • <strong>Per Session:</strong> Not persisted, cleared when app restarts
                                </div>
                            </div>
                        </div>
                    )
                }
            </div >
            {status && <div style={{ marginTop: 10, color: '#4ec9b0', fontSize: 12 }}>{status}</div>}
        </div >
    );
};
