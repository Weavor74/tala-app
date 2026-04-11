/**
 * Settings Panel
 *
 * The master configuration UI for the entire Tala application.
 * Provides a comprehensive interface for managing infrastructure, security, and persona.
 * 
 * **Key Domains:**
 * - **Inference**: Configures LLM providers (Ollama, cloud endpoints).
 * - **Agent Profile**: Fine-tunes the personality, memory, and tools for the current persona.
 * - **Storage/RAG**: Manages vector database connectivity and embeddings.
 * - **Security**: Handles SSO providers (OAuth) and local credential management.
 * - **Automations**: Integrates with `WorkflowEditor` for graphical programming.
 * - **Observability**: Embeds `LogViewerPanel` for monitoring and PTY diagnostics.
 *
 * **Persistence:**
 * - Loads state from `app_settings.json` via `tala.getSettings()`.
 * - Supports "Global" vs "Workspace" scoping via a deep-merge strategy.
 * - Persists all changes to disk on-demand via the `Save` flow.
 */
import { useState, useEffect } from 'react';
import { DEFAULT_SETTINGS, migrateSettings } from './settingsData';
import type { AppSettings, InferenceInstance, SourceControlProvider, AgentProfile, McpServerConfig } from './settingsData';
import 'xterm/css/xterm.css';
import { WorkflowEditor } from './components/WorkflowEditor';
import { GitView } from './components/GitView';
import { WORKFLOW_TEMPLATES } from './catalog/WorkflowTemplates';
import { LogViewerPanel } from './components/LogViewerPanel';
import { SelfModelPanel } from './components/SelfModelPanel';
import {
    makeDefaultGuardrailPolicyConfig,
    VALIDATOR_PROVIDER_REGISTRY,
    type GuardrailPolicyConfig,
    type GuardrailRule,
    type ValidatorBinding,
    type GuardrailAction,
    type GuardrailSeverity,
    type ValidatorProviderKind,
} from '../../shared/guardrails/guardrailPolicyTypes';

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

    const [activeTab, setActiveTab] = useState<'auth' | 'storage' | 'backup' | 'inference' | 'server' | 'agent' | 'sourceControl' | 'workflows' | 'system' | 'guardrails' | 'search' | 'about' | 'firewall' | 'logging' | 'architecture'>('inference');
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
    const [retrievalProviders, setRetrievalProviders] = useState<any[]>([]);
    const [curatedProviders, setCuratedProviders] = useState<Array<{
        providerId: string;
        displayName: string;
        configured: boolean;
        enabled: boolean;
        degraded: boolean;
        reasonUnavailable?: string;
    }>>([]);

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
    
    // Retrieval Provider Fetcher
    useEffect(() => {
        if (activeTab === 'search' && (window as any).tala?.retrievalListProviders) {
            (window as any).tala.retrievalListProviders().then((res: any) => {
                if (res.ok) {
                    setRetrievalProviders(res.providers || []);
                }
            });
        }
        // Load curated search providers for the curated provider dropdown
        if (activeTab === 'search' && (window as any).tala?.retrieval?.getCuratedProviders) {
            (window as any).tala.retrieval.getCuratedProviders().then((providers: any[]) => {
                setCuratedProviders(providers || []);
            }).catch(() => {
                // Fallback: DuckDuckGo only
                setCuratedProviders([{ providerId: 'duckduckgo', displayName: 'DuckDuckGo (no API key)', configured: true, enabled: true, degraded: false }]);
            });
        }
    }, [activeTab]);

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

    const refreshInferenceRuntimeModels = async (opts: { silent?: boolean } = {}) => {
        const api = (window as any).tala;
        if (!api) {
            if (!opts.silent) setStatus('Error: API bridge missing.');
            return;
        }

        if (!opts.silent) {
            setStatus('Refreshing live provider/model availability...');
        }

        const normalizeFromInventory = (inventory: any): Array<{ engine: string; endpoint: string; models: string[]; detected: boolean }> => {
            const providers = Array.isArray(inventory?.providers) ? inventory.providers : [];
            return providers
                .filter((p: any) => p.scope !== 'cloud')
                .map((p: any) => ({
                    engine: p.providerType === 'embedded_llamacpp' ? 'llamacpp' : (p.providerType === 'embedded_vllm' ? 'vllm' : p.providerType),
                    endpoint: p.endpoint || '',
                    models: Array.isArray(p.models) ? p.models : [],
                    detected: !!p.detected,
                }));
        };

        const normalizeFromScan = (scanList: any[]): Array<{ engine: string; endpoint: string; models: string[]; detected: boolean }> => {
            return (Array.isArray(scanList) ? scanList : []).map((p: any) => ({
                engine: p.engine,
                endpoint: p.endpoint || '',
                models: Array.isArray(p.models) ? p.models : [],
                detected: true,
            }));
        };

        try {
            let liveProviders: Array<{ engine: string; endpoint: string; models: string[]; detected: boolean }> = [];
            if (api.inferenceRefreshProviders) {
                const inventory = await api.inferenceRefreshProviders();
                liveProviders = normalizeFromInventory(inventory);
            } else if (api.scanLocalProviders) {
                const scan = await api.scanLocalProviders();
                liveProviders = normalizeFromScan(scan);
            }

            const localEngines = new Set(['ollama', 'llamacpp', 'vllm']);
            const keyOf = (engine: string, endpoint: string) => `${engine}|${endpoint || ''}`.toLowerCase();
            const liveByKey = new Map(liveProviders.map((p) => [keyOf(p.engine, p.endpoint), p]));

            let invalidSelectionCount = 0;
            let staleListClearedCount = 0;

            const nextInstances = settings.inference.instances.map((inst: any) => {
                if (inst.source !== 'local' || !localEngines.has(inst.engine)) {
                    return inst;
                }

                const live = liveByKey.get(keyOf(inst.engine, inst.endpoint || ''));
                const liveModels = live?.detected ? (live.models || []) : [];
                const prevModels = Array.isArray(inst.params?.knownModels) ? inst.params.knownModels : [];
                const selectedModelValid = !!inst.model && liveModels.includes(inst.model);

                if (prevModels.join('|') !== liveModels.join('|')) {
                    staleListClearedCount++;
                }
                if (inst.model && !selectedModelValid) {
                    invalidSelectionCount++;
                }

                return {
                    ...inst,
                    params: {
                        ...(inst.params || {}),
                        knownModels: liveModels,
                        selectedModelValid,
                    },
                };
            });

            update('inference', 'instances', nextInstances);

            if (!opts.silent) {
                setStatus(
                    `Live refresh complete. Providers=${liveProviders.length} ` +
                    `modelListsUpdated=${staleListClearedCount} invalidSelections=${invalidSelectionCount}`
                );
            }
        } catch (e: any) {
            if (!opts.silent) {
                setStatus(`Live refresh failed: ${e?.message || String(e)}`);
            }
        } finally {
            if (!opts.silent) {
                setTimeout(() => setStatus(''), 3500);
            }
        }
    };

    useEffect(() => {
        if (activeTab === 'inference') {
            refreshInferenceRuntimeModels({ silent: true });
        }
    }, [activeTab]);

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
                    { id: 'search', label: 'Search' },
                    { id: 'system', label: 'System' },
                    { id: 'sourceControl', label: 'Git' },
                    { id: 'storage', label: 'Storage' },
                    { id: 'backup', label: 'Backup' },
                    { id: 'server', label: 'Runtime' },
                    { id: 'auth', label: 'Auth' },
                    { id: 'firewall', label: 'Firewall' },
                    { id: 'logging', label: 'Logging' },
                    { id: 'architecture', label: 'Architecture' },
                    { id: 'about', label: 'About' }
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
                                                    const list = settings.agent.profiles.filter((x: AgentProfile) => x.id !== p.id);
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
                                        await refreshInferenceRuntimeModels();
                                    }}
                                    style={{ background: '#2d2d2d', border: '1px solid #444', color: '#fff', padding: '6px 12px', fontSize: 11, cursor: 'pointer' }}
                                >
                                    REFRESH LIVE MODELS
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
                        <div style={{ background: '#333', padding: 10, borderRadius: 4, marginBottom: 20, borderLeft: settings.inference.mode === 'local-only' ? '4px solid #4CAF50' : (settings.inference.mode === 'cloud-only' ? '4px solid #e91e63' : '4px solid #007acc') }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                    <div style={{ fontWeight: 'bold', color: 'white', marginBottom: 4 }}>
                                        Inference Strategy: {settings.inference.mode === 'local-only' ? 'LOCAL ONLY (SAFE)' : (settings.inference.mode === 'cloud-only' ? 'CLOUD ONLY (HIGH FIDELITY)' : 'HYBRID (SMART)')}
                                    </div>
                                    <div style={{ fontSize: 11 }}>
                                        {settings.inference.mode === 'local-only'
                                            ? "Strictly local. No data leaves this machine."
                                            : settings.inference.mode === 'cloud-only'
                                                ? "Always use Cloud providers for maximum quality."
                                                : "Automatically selects the best model for the task."}
                                    </div>
                                </div>
                                <div style={{ display: 'flex', background: '#252526', padding: 4, borderRadius: 4 }}>
                                    {[
                                        { id: 'local-only', label: 'LOCAL' },
                                        { id: 'hybrid', label: 'HYBRID' },
                                        { id: 'cloud-only', label: 'CLOUD' }
                                    ].map(m => (
                                        <div
                                            key={m.id}
                                            onClick={() => update('inference', 'mode', m.id)}
                                            style={{
                                                padding: '6px 12px',
                                                cursor: 'pointer',
                                                background: settings.inference.mode === m.id ? (m.id === 'local-only' ? '#4CAF50' : (m.id === 'cloud-only' ? '#e91e63' : '#007acc')) : 'transparent',
                                                color: 'white',
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
                                                        {inst.model && !inst.params.knownModels.includes(inst.model) && (
                                                            <option value={inst.model} disabled>{`${inst.model} (Unavailable)`}</option>
                                                        )}
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
                                            </div>
                                        </div>
                                        {/* PRIORITY COLUMN */}
                                        <div>
                                            <label style={labelStyle}>PRIORITY</label>
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
                                            {
                                                inst.source === 'cloud' && (
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
                                    await refreshInferenceRuntimeModels();
                                }}
                                style={{ background: 'transparent', color: '#007acc', border: '1px dashed #007acc', padding: '8px 16px', fontSize: 11, cursor: 'pointer', opacity: 0.7 }}
                            >
                                ⟳ REFRESH LIVE LOCAL ENGINES
                            </button>
                        </div>
                    </div>
                )
                }

                {/* SYSTEM TAB */}
                {
                    activeTab === 'system' && (
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
                    )}

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
                    )}

                {/* SEARCH TAB */}
                {
                    activeTab === 'search' && settings.search && (
                        <div style={sectionStyle}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                                <div>
                                    <h3 style={{ margin: 0, color: '#dcdcaa' }}>SEARCH PROVIDERS</h3>
                                    <p style={{ margin: 0, fontSize: 11, opacity: 0.7 }}>Credentials for external information retrieval.</p>
                                </div>
                                <button
                                    onClick={() => {
                                        const newProv = {
                                            id: `search-${Math.random().toString(36).substr(2, 5)}`,
                                            name: 'New Provider',
                                            type: 'rest',
                                            enabled: false
                                        };
                                        update('search', 'providers', [...settings.search.providers, newProv]);
                                    }}
                                    style={{ background: '#2d2d2d', border: '1px solid #444', color: '#fff', padding: '6px 12px', fontSize: 11, cursor: 'pointer' }}
                                >
                                    + ADD PROVIDER
                                </button>
                            </div>

                            <div style={{ marginBottom: 20, background: '#1e1e1e', padding: 15, borderRadius: 4, border: '1px solid #007acc' }}>
                                <div style={{ display: 'flex', gap: 20 }}>
                                    <div style={{ flex: 1 }}>
                                        <label style={labelStyle}>PREFERRED SEARCH PROVIDER</label>
                                        <select
                                            style={{ ...selectStyle, marginBottom: 10 }}
                                            value={settings.search.preferredProviderId || 'auto'}
                                            onChange={e => update('search', 'preferredProviderId', e.target.value)}
                                        >
                                            <option value="auto">Auto (Recommended)</option>
                                            <option value="local">Local Files Only</option>
                                            <option value="duckduckgo">DuckDuckGo (Web)</option>
                                            {retrievalProviders.filter(p => p.id.startsWith('external:')).map(p => (
                                                <option key={p.id} value={p.id}>{p.id.replace('external:', 'External: ').toUpperCase()}</option>
                                            ))}
                                            {/* Show current external if not in list yet (e.g. registry just updated) */}
                                            {settings.search.activeProviderId && !retrievalProviders.some(p => p.id === `external:${settings.search.activeProviderId}`) && (
                                                <option value={`external:${settings.search.activeProviderId}`}>External: {settings.search.activeProviderId.toUpperCase()}</option>
                                            )}
                                        </select>
                                        <div style={{ fontSize: 10, color: '#888' }}>
                                            Determines the preferred engine for global search requests.
                                        </div>
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <label style={labelStyle}>CURATED SEARCH PROVIDER</label>
                                        <select
                                            style={{ ...selectStyle, marginBottom: 10 }}
                                            value={(settings.search as any).curatedSearchProviderId || 'duckduckgo'}
                                            onChange={e => {
                                                update('search', 'curatedSearchProviderId', e.target.value);
                                            }}
                                        >
                                            {curatedProviders.length === 0 && (
                                                <option value="duckduckgo">DuckDuckGo (no API key)</option>
                                            )}
                                            {curatedProviders.map(p => {
                                                const icon = p.degraded ? '❌' : (p.configured ? '✅' : '⚠');
                                                return (
                                                    <option
                                                        key={p.providerId}
                                                        value={p.providerId}
                                                        disabled={!p.enabled}
                                                    >
                                                        {icon} {p.displayName}{!p.enabled && p.reasonUnavailable ? ` — ${p.reasonUnavailable}` : ''}
                                                    </option>
                                                );
                                            })}
                                        </select>
                                        <div style={{ fontSize: 10, color: '#888' }}>
                                            The engine used for curated external web search. DuckDuckGo requires no API key.
                                            {(settings.search as any).curatedSearchProviderId && (settings.search as any).curatedSearchProviderId !== 'duckduckgo' && (
                                                <span style={{ color: '#007acc' }}> Apply Settings to activate.</span>
                                            )}
                                        </div>
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <label style={labelStyle}>ACTIVE EXTERNAL PROVIDER</label>
                                        <select
                                            style={{ ...selectStyle, marginBottom: 10 }}
                                            value={settings.search.activeProviderId}
                                            onChange={e => update('search', 'activeProviderId', e.target.value)}
                                        >
                                            {(settings.search.providers || []).map((p: any) => (
                                                <option key={p.id} value={p.id}>{p.name} ({p.type.toUpperCase()})</option>
                                            ))}
                                        </select>
                                        <div style={{ fontSize: 10, color: '#888' }}>
                                            The actual engine used when any 'External' provider is selected.
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                                {(settings.search.providers || []).map((p: any, idx: number) => (
                                    <div key={p.id} style={{ background: '#252526', border: '1px solid #3e3e42', padding: 20, borderRadius: 4 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 15 }}>
                                            <div style={{ flex: 1, marginRight: 20 }}>
                                                <input
                                                    value={p.name}
                                                    onChange={e => {
                                                        const list = [...settings.search.providers];
                                                        list[idx].name = e.target.value;
                                                        update('search', 'providers', list);
                                                    }}
                                                    style={{ ...inputStyle, marginBottom: 5, fontWeight: 'bold' }}
                                                    placeholder="Provider Name (e.g. Google REST API)"
                                                />
                                            </div>
                                            <button
                                                onClick={() => {
                                                    const list = settings.search.providers.filter((x: any) => x.id !== p.id);
                                                    update('search', 'providers', list);
                                                }}
                                                style={{ color: '#ff4444', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 18 }}
                                            >
                                                ×
                                            </button>
                                        </div>

                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15 }}>
                                            <div>
                                                <label style={labelStyle}>TYPE</label>
                                                <select
                                                    style={selectStyle}
                                                    value={p.type}
                                                    onChange={e => {
                                                        const list = [...settings.search.providers];
                                                        list[idx].type = e.target.value as any;
                                                        update('search', 'providers', list);
                                                    }}
                                                >
                                                    <option value="google">Google API</option>
                                                    <option value="brave">Brave Search</option>
                                                    <option value="serper">Serper.dev</option>
                                                    <option value="tavily">Tavily AI</option>
                                                    <option value="rest">Generic REST Endpoint</option>
                                                    <option value="custom">Custom Implementation</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label style={labelStyle}>STATUS</label>
                                                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', height: 40 }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={p.enabled}
                                                        onChange={e => {
                                                            const list = [...settings.search.providers];
                                                            list[idx].enabled = e.target.checked;
                                                            update('search', 'providers', list);
                                                        }}
                                                    />
                                                    <span style={{ fontSize: 12 }}>Enabled</span>
                                                </label>
                                            </div>
                                        </div>

                                        <div style={{ marginTop: 15 }}>
                                            <label style={labelStyle}>REST ENDPOINT / URL</label>
                                            <input
                                                style={inputStyle}
                                                value={p.endpoint || ''}
                                                onChange={e => {
                                                    const list = [...settings.search.providers];
                                                    list[idx].endpoint = e.target.value;
                                                    update('search', 'providers', list);
                                                }}
                                                placeholder="https://api.custom-search.com/v1/query"
                                            />
                                        </div>

                                        <div>
                                            <label style={labelStyle}>API KEY / CREDENTIALS</label>
                                            <input
                                                type="password"
                                                style={inputStyle}
                                                value={p.apiKey || ''}
                                                onChange={e => {
                                                    const list = [...settings.search.providers];
                                                    list[idx].apiKey = e.target.value;
                                                    update('search', 'providers', list);
                                                }}
                                                placeholder="Enter sensitive token here..."
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
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

                {/* FIREWALL TAB */}
                {
                    activeTab === 'firewall' && (
                        <div style={sectionStyle}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 15, marginBottom: 20 }}>
                                <div style={{ fontSize: 32 }}>🛡️</div>
                                <div>
                                    <h3 style={{ margin: 0, color: '#00ffff', letterSpacing: '1px' }}>QUANTUM FIREWALL</h3>
                                    <p style={{ margin: 0, fontSize: 11, opacity: 0.7 }}>Cryptographic secret scrubbing & data loss prevention.</p>
                                </div>
                            </div>

                            <div style={{ background: 'rgba(0, 255, 255, 0.05)', border: '1px solid rgba(0, 255, 255, 0.2)', padding: 20, borderRadius: 8, marginBottom: 30 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                                    <div>
                                        <h4 style={{ margin: 0, color: '#fff' }}>SYSTEM STATUS</h4>
                                        <div style={{ fontSize: 10, color: settings.firewall?.enabled ? '#00ff00' : '#ff4444', fontWeight: 'bold', marginTop: 4 }}>
                                            {settings.firewall?.enabled ? '● ACTIVE & MONITORING' : '○ DEACTIVATED'}
                                        </div>
                                    </div>
                                    <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', gap: 10, background: '#121212', padding: '8px 16px', borderRadius: 20, border: '1px solid #333' }}>
                                        <span style={{ fontSize: 10, fontWeight: 'bold' }}>{settings.firewall?.enabled ? 'DISABLE' : 'ENABLE'}</span>
                                        <input
                                            type="checkbox"
                                            checked={settings.firewall?.enabled}
                                            onChange={e => update('firewall', 'enabled', e.target.checked)}
                                            style={{ width: 18, height: 18 }}
                                        />
                                    </label>
                                </div>

                                <p style={{ fontSize: 11, color: '#aaa', lineHeight: '1.6' }}>
                                    The Quantum Firewall automatically detects and redacts sensitive patterns (API keys, security tokens, UUIDs)
                                    from internal logs and context. This prevents accidental leakage of credentials into long-term memory
                                    or external API calls.
                                </p>
                            </div>

                            {settings.firewall?.enabled && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 25 }}>
                                    <div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                                            <label style={labelStyle}>SENSITIVITY THRESHOLD</label>
                                            <span style={{ fontSize: 11, color: '#00ffff', fontWeight: 'bold' }}>{Math.round((settings.firewall?.sensitivity ?? 0.5) * 100)}%</span>
                                        </div>
                                        <input
                                            type="range"
                                            min="0"
                                            max="1"
                                            step="0.05"
                                            style={{ width: '100%', cursor: 'pointer', accentColor: '#00ffff' }}
                                            value={settings.firewall?.sensitivity ?? 0.5}
                                            onChange={e => update('firewall', 'sensitivity', parseFloat(e.target.value))}
                                        />
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, fontSize: 9, color: '#555' }}>
                                            <span>PERMISSIVE (OFF)</span>
                                            <span>BALANCED</span>
                                            <span>PARANOID (STRICT)</span>
                                        </div>
                                    </div>

                                    <div>
                                        <label style={labelStyle}>TARGET REDACTION PATTERNS (REGEX)</label>
                                        <div style={{ background: '#121212', border: '1px solid #333', borderRadius: 4, padding: 8 }}>
                                            {(settings.firewall?.targetPatterns || []).map((pattern: string, idx: number) => (
                                                <div key={idx} style={{ display: 'flex', gap: 5, marginBottom: 5 }}>
                                                    <input
                                                        style={{ ...inputStyle, marginBottom: 0, fontFamily: 'monospace', fontSize: 12, flex: 1 }}
                                                        value={pattern}
                                                        onChange={e => {
                                                            const p = [...(settings.firewall?.targetPatterns || [])];
                                                            p[idx] = e.target.value;
                                                            update('firewall', 'targetPatterns', p);
                                                        }}
                                                    />
                                                    <button
                                                        onClick={() => {
                                                            const p = (settings.firewall?.targetPatterns || []).filter((_: any, i: number) => i !== idx);
                                                            update('firewall', 'targetPatterns', p);
                                                        }}
                                                        style={{ background: 'transparent', border: 'none', color: '#ff4444', cursor: 'pointer', padding: '0 10px' }}
                                                    >
                                                        ✕
                                                    </button>
                                                </div>
                                            ))}
                                            <button
                                                onClick={() => {
                                                    const p = [...(settings.firewall?.targetPatterns || []), ""];
                                                    update('firewall', 'targetPatterns', p);
                                                }}
                                                style={{ background: 'transparent', border: '1px dashed #444', color: '#888', padding: '8px', cursor: 'pointer', width: '100%', fontSize: 10, marginTop: 5 }}
                                            >
                                                + ADD PATTERN
                                            </button>
                                        </div>
                                    </div>

                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                                        <div>
                                            <label style={labelStyle}>REPLACEMENT ANCHOR TEXT</label>
                                            <input
                                                style={inputStyle}
                                                value={settings.firewall?.replacementText || '[REDACTED BY QUANTUM FIREWALL]'}
                                                onChange={e => update('firewall', 'replacementText', e.target.value)}
                                                placeholder="[REDACTED]"
                                            />
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                            <label style={labelStyle}>AUDIT OPTIONS</label>
                                            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, cursor: 'pointer', color: '#ccc' }}>
                                                <input
                                                    type="checkbox"
                                                    checked={settings.firewall?.logRedactions !== false}
                                                    onChange={e => update('firewall', 'logRedactions', e.target.checked)}
                                                />
                                                <span>Log redaction events to audit-log.jsonl</span>
                                            </label>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
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
                    )}

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
                                                                const t = list.find((x: McpServerConfig) => x.id === srv.id);
                                                                if (t) t.enabled = e.target.checked;
                                                                setSettings((prev: AppSettings) => ({ ...prev, mcpServers: list }));
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
                                                                const list = (settings.mcpServers || []).filter((s: McpServerConfig) => s.id !== srv.id);
                                                                setSettings((prev: AppSettings) => ({ ...prev, mcpServers: list }));
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
                                                            const list = [...(settings.mcpServers || [])];
                                                            const t = list.find((x: McpServerConfig) => x.id === srv.id);
                                                            if (t) t.name = e.target.value;
                                                            setSettings((prev: AppSettings) => ({ ...prev, mcpServers: list }));
                                                        }}
                                                    />

                                                    <div style={{ marginBottom: 15 }}>
                                                        <label style={labelStyle}>TYPE</label>
                                                        <select
                                                            style={selectStyle}
                                                            value={srv.type}
                                                            onChange={(e: any) => {
                                                                const list = [...(settings.mcpServers || [])];
                                                                const t = list.find((x: McpServerConfig) => x.id === srv.id);
                                                                if (t) t.type = e.target.value;
                                                                setSettings((prev: AppSettings) => ({ ...prev, mcpServers: list }));
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
                                                                    const list = [...(settings.mcpServers || [])];
                                                                    const t = list.find((x: McpServerConfig) => x.id === srv.id);
                                                                    if (t) t.command = e.target.value;
                                                                    setSettings((prev: AppSettings) => ({ ...prev, mcpServers: list }));
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
                                                </div>
                                            );
                                        })()}
                                    </div>
                                </div>
                            )}
                        </div>
                    )
                }

                {
                    activeTab === 'logging' && (
                        <LogViewerPanel api={api} />
                    )
                }

                {/* GUARDRAILS TAB — GuardrailsAI-compatible Guard Builder + Validator Builder */}
                {activeTab === 'guardrails' && <GuardrailsTab settings={settings} api={api} />}

                {/* ARCHITECTURE TAB */}
                {activeTab === 'architecture' && <SelfModelPanel />}

                {/* ABOUT TAB */}
                {activeTab === 'about' && <AboutPanel />}
            </div>

            {status && <div style={{ marginTop: 10, color: '#4ec9b0', fontSize: 12 }}>{status}</div>}
        </div>
    );
};


// ═══════════════════════════════════════════════════════════════
// AboutPanel — identity, creator, and project info
// ═══════════════════════════════════════════════════════════════
function AboutPanel() {
    const GITHUB_URL = 'https://github.com/Weavor74/tala-app';
    const EMAIL = 'contact@tala-app.dev';
    const VERSION = '0.0.0';

    const openExternal = (url: string) => {
        const api = (window as any).tala;
        if (api?.openExternal) { api.openExternal(url); }
        else { window.open(url, '_blank'); }
    };

    const card: React.CSSProperties = {
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: 10,
        padding: '22px 26px',
        marginBottom: 16,
    };
    const lbl: React.CSSProperties = {
        fontSize: 9, fontWeight: 800, color: '#555',
        letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 5,
        display: 'block',
    };
    const linkBtn: React.CSSProperties = {
        display: 'inline-flex', alignItems: 'center', gap: 7,
        background: 'rgba(0,122,204,0.12)',
        border: '1px solid rgba(0,122,204,0.3)',
        color: '#7ab8e8', fontSize: 12, fontWeight: 600,
        padding: '8px 16px', borderRadius: 6,
        cursor: 'pointer', textDecoration: 'none',
        transition: '0.15s',
    };

    const CAPABILITIES = [
        '🧠 Hybrid LLM Inference (Local + Cloud)',
        '🔮 Astro-Emotional Engine (Dynamic personality)',
        '💾 Dual Memory: mem0 (short-term) + RAG (long-term)',
        '🔁 Reflection System (Self-improvement loop)',
        '🌐 Browser Perception & Automation',
        '⚡ MCP Server Ecosystem',
        '🛡 Guard Builder + Custom Validator Builder',
        '🗂 Workflow Engine + Visual Editor',
        '🔗 Git Integration',
        '🎙 Voice I/O (Whisper + ElevenLabs)',
        '📦 Portable / USB-deployable Build',
    ];

    return (
        <div style={{ fontFamily: "'Inter','Segoe UI',sans-serif", maxWidth: 700, paddingBottom: 40 }}>

            {/* Hero */}
            <div style={{
                ...card,
                background: 'linear-gradient(135deg, rgba(0,122,204,0.12) 0%, rgba(0,30,60,0.4) 100%)',
                border: '1px solid rgba(0,122,204,0.25)',
                textAlign: 'center', padding: '40px 30px',
            }}>
                {/* Wordmark */}
                <div style={{
                    fontSize: 56, fontWeight: 900, letterSpacing: 14,
                    background: 'linear-gradient(90deg,#7ab8e8 0%,#fff 45%,#7ab8e8 100%)',
                    WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text', marginBottom: 10,
                }}>T.A.L.A.</div>

                {/* Acronym expansion */}
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, marginBottom: 18 }}>
                    {[
                        ['T', 'actical'],
                        ['A', 'utonomous'],
                        ['L', 'earning'],
                        ['A', 'rchitecture'],
                    ].map(([letter, rest], i, arr) => (
                        <>
                            <span key={letter + rest} style={{ fontSize: 13, color: '#3a5a7a' }}>
                                <span style={{ color: '#7ab8e8', fontWeight: 800 }}>{letter}</span>{rest}
                            </span>
                            {i < arr.length - 1 && <span style={{ color: '#1e3a52', fontSize: 16 }}>·</span>}
                        </>
                    ))}
                </div>

                <div style={{ fontSize: 11, color: '#3a5a7a', letterSpacing: 2, textTransform: 'uppercase' }}>
                    Autonomous Intelligence System &nbsp;·&nbsp; v{VERSION}
                </div>
            </div>

            {/* Creator */}
            <div style={card}>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#555', letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 16 }}>Creator</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                    <div>
                        <label style={lbl}>Name</label>
                        <div style={{ fontSize: 15, fontWeight: 700, color: '#dcdcaa' }}>The T.A.L.A. Team</div>
                    </div>
                    <div>
                        <label style={lbl}>Email</label>
                        <a
                            href={`mailto:${EMAIL}`}
                            style={{ fontSize: 13, color: '#7ab8e8', textDecoration: 'none', fontWeight: 500 }}
                        >
                            {EMAIL}
                        </a>
                    </div>
                    <div>
                        <label style={lbl}>Founded</label>
                        <div style={{ fontSize: 13, color: '#aaa' }}>2023</div>
                    </div>
                    <div>
                        <label style={lbl}>License</label>
                        <div style={{ fontSize: 13, color: '#aaa' }}>Proprietary — All Rights Reserved</div>
                    </div>
                </div>
            </div>

            {/* Source */}
            <div style={card}>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#555', letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 16 }}>Source Repository</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#ccc', marginBottom: 4 }}>GitHub — Weavor74/tala-app</div>
                        <div style={{ fontSize: 11, color: '#555' }}>
                            🔒 Private repository — requires access invitation
                        </div>
                        <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#459', marginTop: 6, letterSpacing: 0.5 }}>
                            {GITHUB_URL}
                        </div>
                    </div>
                    <button
                        onClick={() => openExternal(GITHUB_URL)}
                        style={linkBtn}
                    >
                        <span style={{ fontSize: 16 }}>🐙</span> Open on GitHub
                    </button>
                </div>
            </div>

            {/* Capabilities */}
            <div style={card}>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#555', letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 16 }}>Capabilities</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {CAPABILITIES.map(cap => (
                        <div key={cap} style={{ fontSize: 11, color: '#888', display: 'flex', alignItems: 'flex-start', gap: 6, lineHeight: 1.5 }}>
                            {cap}
                        </div>
                    ))}
                </div>
            </div>

            {/* Footer note */}
            <div style={{ textAlign: 'center', fontSize: 10, color: '#2a3a4a', letterSpacing: 1.5, textTransform: 'uppercase', paddingTop: 10 }}>
                © 2023 T.A.L.A. System Architecture
            </div>
        </div>
    );
}


// ═══════════════════════════════════════════════════════════════

// GuardBuilderPanel — GuardrailsAI-compatible Guard Builder UI
// ═══════════════════════════════════════════════════════════════
const CATEGORY_COLORS: Record<string, string> = {
    'Etiquette': '#d79921',
    'Brand Risk': '#d65d0e',
    'Data Leakage': '#cc241d',
    'Jailbreaking': '#b16286',
    'Factuality': '#689d6a',
    'Formatting': '#458588',
    'Custom': '#928374',
};

const ON_FAIL_OPTIONS = [
    { value: 'noop', label: 'Noop — log, pass through' },
    { value: 'fix', label: 'Fix — auto-correct' },
    { value: 'filter', label: 'Filter — remove segment' },
    { value: 'refrain', label: 'Refrain — return empty' },
    { value: 'exception', label: 'Exception — block pipeline' },
];

const TARGET_OPTIONS = [
    { value: 'input', label: 'Input (User ➜ LLM)' },
    { value: 'output', label: 'Output (LLM ➜ User)' },
    { value: 'both', label: 'Both' },
];

function GuardBuilderPanel({ api }: { settings: any; api: any }) {
    const [guards, setGuards] = useState<any[]>([]);
    const [selectedGuardId, setSelectedGuardId] = useState<string | null>(null);
    const [validatorRegistry, setValidatorRegistry] = useState<any[]>([]);
    const [gbStatus, setGbStatus] = useState('');
    const [testText, setTestText] = useState('');
    const [testTarget, setTestTarget] = useState<'input' | 'output'>('output');
    const [testResult, setTestResult] = useState<any | null>(null);
    const [testRunning, setTestRunning] = useState(false);
    const [agentProfiles, setAgentProfiles] = useState<any[]>([]);
    const [wfList, setWfList] = useState<any[]>([]);
    const [showAddValidator, setShowAddValidator] = useState(false);
    const [validatorFilter, setValidatorFilter] = useState('');

    const selectedGuard = guards.find((g: any) => g.id === selectedGuardId) || null;

    const flash = (msg: string) => {
        setGbStatus(msg);
        setTimeout(() => setGbStatus(''), 3500);
    };

    useEffect(() => {
        const load = async () => {
            try {
                if (api?.listGuards) {
                    const gs = await api.listGuards();
                    setGuards(gs || []);
                }
                if (api?.getValidatorRegistry) {
                    const reg = await api.getValidatorRegistry();
                    setValidatorRegistry(reg || []);
                }
                if (api?.getSettings) {
                    const s = await api.getSettings();
                    const sd = s?.global || s;
                    setAgentProfiles(sd?.agentProfiles || []);
                }
                if (api?.getWorkflows) {
                    const wfs = await api.getWorkflows();
                    setWfList(wfs || []);
                }
            } catch (e: any) { flash(`Load error: ${e.message}`); }
        };
        load();
    }, []);

    const refreshGuards = async () => {
        if (api?.listGuards) { const gs = await api.listGuards(); setGuards(gs || []); }
    };

    const handleNewGuard = async () => {
        if (!api?.saveGuard) return;
        const g = await api.saveGuard({ name: 'New Guard', description: '', validators: [], appliedToAgents: [], appliedToWorkflows: [] });
        await refreshGuards();
        setSelectedGuardId(g.id);
    };

    const handleDeleteGuard = async () => {
        if (!selectedGuardId || !api?.deleteGuard) return;
        if (!confirm(`Delete guard "${selectedGuard?.name}"?`)) return;
        await api.deleteGuard(selectedGuardId);
        setSelectedGuardId(null);
        await refreshGuards();
        flash('Guard deleted.');
    };

    const handleSaveGuard = async (patch: any) => {
        if (!selectedGuard || !api?.saveGuard) return;
        await api.saveGuard({ ...selectedGuard, ...patch });
        await refreshGuards();
        flash('Saved ✓');
    };

    const updateGuardLocal = (field: string, value: any) => {
        setGuards((prev: any[]) => prev.map((g: any) => g.id === selectedGuardId ? { ...g, [field]: value } : g));
    };

    const addValidator = async (type: string) => {
        if (!selectedGuard) return;
        const meta = validatorRegistry.find((m: any) => m.type === type);
        const defaultArgs: Record<string, any> = {};
        if (meta?.argsSchema) Object.entries(meta.argsSchema).forEach(([k, s]: [string, any]) => { defaultArgs[k] = s.default; });
        const nv = { id: `v-${Date.now()}`, type, target: 'both', on_fail: 'noop', args: defaultArgs, enabled: true };
        await handleSaveGuard({ validators: [...(selectedGuard.validators || []), nv] });
        setShowAddValidator(false);
    };

    const removeValidator = async (vid: string) => {
        if (!selectedGuard) return;
        await handleSaveGuard({ validators: (selectedGuard.validators || []).filter((v: any) => v.id !== vid) });
    };

    const updateValidator = async (vid: string, patch: any) => {
        if (!selectedGuard) return;
        await handleSaveGuard({ validators: (selectedGuard.validators || []).map((v: any) => v.id === vid ? { ...v, ...patch } : v) });
    };

    const handleRunTest = async () => {
        if (!selectedGuardId || !testText || !api?.validateWithGuard) return;
        setTestRunning(true); setTestResult(null);
        try { setTestResult(await api.validateWithGuard(selectedGuardId, testText, testTarget)); }
        catch (e: any) { setTestResult({ error: e.message }); }
        finally { setTestRunning(false); }
    };

    const handleExport = async () => {
        if (!selectedGuardId || !api?.exportGuardToPython) return;
        const r = await api.exportGuardToPython(selectedGuardId);
        if (r?.success) flash(`Exported → ${r.path}`);
        else if (r?.error) flash(`Export failed: ${r.error}`);
    };

    const panelBase: React.CSSProperties = { background: 'rgba(30,30,30,0.7)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: 20, backdropFilter: 'blur(10px)', marginBottom: 16 };
    const btnP: React.CSSProperties = { background: 'linear-gradient(135deg,#007acc,#005f9e)', color: '#fff', border: 'none', padding: '7px 16px', borderRadius: 4, cursor: 'pointer', fontWeight: 700, fontSize: 11, letterSpacing: 0.8, transition: '0.2s' };
    const btnD: React.CSSProperties = { background: 'rgba(197,48,48,0.8)', color: '#fff', border: 'none', padding: '7px 13px', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700 };
    const btnG: React.CSSProperties = { background: 'rgba(255,255,255,0.05)', color: '#ccc', border: '1px solid rgba(255,255,255,0.1)', padding: '7px 13px', borderRadius: 4, cursor: 'pointer', fontSize: 11 };
    const inp: React.CSSProperties = { background: '#111', border: '1px solid #333', color: '#eee', padding: '9px 12px', fontSize: 12, borderRadius: 4, width: '100%', outline: 'none' };
    const sel: React.CSSProperties = { ...inp, cursor: 'pointer' };
    const lbl9: React.CSSProperties = { display: 'block', fontSize: 9, fontWeight: 800, color: '#888', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 5 };

    const catBadge = (cat: string): React.CSSProperties => ({ display: 'inline-block', padding: '2px 7px', borderRadius: 10, fontSize: 9, fontWeight: 700, letterSpacing: 1, background: `${CATEGORY_COLORS[cat] || '#555'}22`, color: CATEGORY_COLORS[cat] || '#aaa', border: `1px solid ${CATEGORY_COLORS[cat] || '#555'}44`, marginLeft: 6 });

    const byCategory = validatorRegistry
        .filter((m: any) => !validatorFilter || m.label.toLowerCase().includes(validatorFilter.toLowerCase()) || m.category.toLowerCase().includes(validatorFilter.toLowerCase()))
        .reduce((acc: any, m: any) => { if (!acc[m.category]) acc[m.category] = []; acc[m.category].push(m); return acc; }, {});

    return (
        <div style={{ fontFamily: "'Inter','Segoe UI',sans-serif" }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div>
                    <h2 style={{ margin: 0, color: '#dcdcaa', fontSize: 18, fontWeight: 800, letterSpacing: 1 }}>🛡 GUARD BUILDER</h2>
                    <p style={{ margin: '4px 0 0', fontSize: 11, color: '#666' }}>GuardrailsAI-compatible validator stacks — validate LLM inputs &amp; outputs</p>
                </div>
                <button onClick={handleNewGuard} style={btnP}>+ NEW GUARD</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: guards.length > 0 ? '200px 1fr' : '1fr', gap: 14 }}>
                {/* Guard List */}
                {guards.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        {guards.map((g: any) => (
                            <div key={g.id} onClick={() => setSelectedGuardId(g.id)} style={{ padding: '11px 13px', borderRadius: 6, cursor: 'pointer', background: selectedGuardId === g.id ? 'rgba(0,122,204,0.2)' : 'rgba(255,255,255,0.03)', border: selectedGuardId === g.id ? '1px solid rgba(0,122,204,0.4)' : '1px solid rgba(255,255,255,0.05)', transition: '0.15s' }}>
                                <div style={{ fontWeight: 700, fontSize: 12, color: '#eee', marginBottom: 2 }}>{g.name}</div>
                                <div style={{ fontSize: 10, color: '#555' }}>{(g.validators || []).length} validator{(g.validators || []).length !== 1 ? 's' : ''}</div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Editor */}
                <div>
                    {!selectedGuard ? (
                        <div style={{ ...panelBase, textAlign: 'center', padding: 60 }}>
                            <div style={{ fontSize: 38, marginBottom: 10, opacity: 0.2 }}>🛡</div>
                            <div style={{ color: '#444', fontSize: 13 }}>{guards.length === 0 ? 'No guards yet. Click "+ NEW GUARD".' : 'Select a guard to edit.'}</div>
                        </div>
                    ) : (<>
                        {/* Meta */}
                        <div style={panelBase}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
                                <div style={{ flex: 1, marginRight: 14 }}>
                                    <label style={lbl9}>Guard Name</label>
                                    <input style={inp} value={selectedGuard.name} onChange={e => updateGuardLocal('name', e.target.value)} onBlur={() => handleSaveGuard({ name: selectedGuard.name })} />
                                </div>
                                <div style={{ display: 'flex', gap: 7, marginTop: 20 }}>
                                    <button onClick={handleExport} style={btnG} title="Export as guardrails-ai Python">↑ PY</button>
                                    <button onClick={handleDeleteGuard} style={btnD}>DELETE</button>
                                </div>
                            </div>
                            <label style={lbl9}>Description</label>
                            <input style={inp} value={selectedGuard.description || ''} placeholder="Optional description..." onChange={e => updateGuardLocal('description', e.target.value)} onBlur={() => handleSaveGuard({ description: selectedGuard.description })} />
                        </div>

                        {/* Validator Stack */}
                        <div style={panelBase}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                                <h3 style={{ margin: 0, fontSize: 11, fontWeight: 800, color: '#ccc', letterSpacing: 1.5, textTransform: 'uppercase' }}>Validator Stack</h3>
                                <button onClick={() => setShowAddValidator(!showAddValidator)} style={btnP}>{showAddValidator ? '✕ Cancel' : '+ ADD VALIDATOR'}</button>
                            </div>

                            {/* Picker */}
                            {showAddValidator && (
                                <div style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: 14, marginBottom: 14 }}>
                                    <input style={{ ...inp, marginBottom: 10 }} placeholder="🔍 Filter validators..." value={validatorFilter} onChange={e => setValidatorFilter(e.target.value)} autoFocus />
                                    <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
                                        {Object.entries(byCategory).map(([cat, items]: [string, any]) => (
                                            <div key={cat}>
                                                <div style={{ fontSize: 8, fontWeight: 900, color: CATEGORY_COLORS[cat] || '#888', letterSpacing: 2, textTransform: 'uppercase', padding: '7px 3px 3px', borderBottom: `1px solid ${CATEGORY_COLORS[cat] || '#333'}33` }}>{cat}</div>
                                                {items.map((m: any) => (
                                                    <div key={m.type} onClick={() => addValidator(m.type)} style={{ padding: '8px 9px', cursor: 'pointer', borderRadius: 3, background: 'transparent', marginTop: 2, transition: '0.1s' }} onMouseOver={e => (e.currentTarget.style.background = 'rgba(0,122,204,0.15)')} onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                            <span style={{ fontWeight: 700, fontSize: 12, color: '#ddd' }}>{m.label}</span>
                                                            <span style={{ fontSize: 9, color: m.impl === 'llm' ? '#b16286' : '#689d6a', fontWeight: 700 }}>{m.impl === 'llm' ? '🤖 LLM' : '📐 RULE'}</span>
                                                        </div>
                                                        <div style={{ fontSize: 10, color: '#555', marginTop: 2 }}>{m.description}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {(selectedGuard.validators || []).length === 0 && !showAddValidator && (
                                <div style={{ textAlign: 'center', padding: '20px 0', color: '#444', fontSize: 12 }}>No validators. Click "+ ADD VALIDATOR".</div>
                            )}

                            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                                {(selectedGuard.validators || []).map((v: any, idx: number) => {
                                    const meta = validatorRegistry.find((m: any) => m.type === v.type);
                                    return (
                                        <div key={v.id} style={{ background: v.enabled ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.2)', border: `1px solid ${v.enabled ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.02)'}`, borderRadius: 6, padding: 13, opacity: v.enabled ? 1 : 0.5 }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                                    <span style={{ color: '#555', fontSize: 10 }}>#{idx + 1}</span>
                                                    <span style={{ fontWeight: 800, fontSize: 13, color: '#dcdcaa' }}>{meta?.label || v.type}</span>
                                                    {meta?.category && <span style={catBadge(meta.category)}>{meta.category}</span>}
                                                    {meta?.impl && <span style={{ fontSize: 9, color: meta.impl === 'llm' ? '#b16286' : '#689d6a', fontWeight: 700, marginLeft: 4 }}>{meta.impl === 'llm' ? '🤖 LLM' : '📐 RULE'}</span>}
                                                </div>
                                                <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                                                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#888', cursor: 'pointer' }}>
                                                        <input type="checkbox" checked={v.enabled} onChange={e => updateValidator(v.id, { enabled: e.target.checked })} /> ON
                                                    </label>
                                                    <button onClick={() => removeValidator(v.id)} style={{ background: 'rgba(197,48,48,0.6)', color: '#fff', border: 'none', padding: '2px 7px', borderRadius: 3, cursor: 'pointer', fontSize: 10 }}>✕</button>
                                                </div>
                                            </div>
                                            {meta?.description && <div style={{ fontSize: 10, color: '#555', marginBottom: 9 }}>{meta.description}</div>}
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginBottom: v.args && Object.keys(v.args).length > 0 ? 9 : 0 }}>
                                                <div>
                                                    <label style={lbl9}>Validates</label>
                                                    <select value={v.target} onChange={e => updateValidator(v.id, { target: e.target.value })} style={sel}>
                                                        {TARGET_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                                    </select>
                                                </div>
                                                <div>
                                                    <label style={lbl9}>On Fail</label>
                                                    <select value={v.on_fail} onChange={e => updateValidator(v.id, { on_fail: e.target.value })} style={{ ...sel, borderColor: v.on_fail === 'exception' ? '#cc241d88' : undefined }}>
                                                        {ON_FAIL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                                    </select>
                                                </div>
                                            </div>
                                            {meta?.argsSchema && Object.keys(meta.argsSchema).length > 0 && (
                                                <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 4, padding: '9px 11px' }}>
                                                    <div style={{ fontSize: 8, fontWeight: 900, color: '#555', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 7 }}>PARAMETERS</div>
                                                    {Object.entries(meta.argsSchema).map(([key, schema]: [string, any]) => (
                                                        <div key={key} style={{ marginBottom: 7 }}>
                                                            <label style={{ fontSize: 9, color: '#666', display: 'block', marginBottom: 3 }}>{key} — <span style={{ color: '#444' }}>{schema.description}</span></label>
                                                            {schema.type === 'array' ? (
                                                                <input style={inp} value={Array.isArray(v.args[key]) ? v.args[key].join(', ') : (v.args[key] || '')} placeholder="Comma-separated..." onChange={e => updateValidator(v.id, { args: { ...v.args, [key]: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) } })} />
                                                            ) : schema.type === 'number' ? (
                                                                <input type="number" style={inp} value={v.args[key] ?? schema.default} onChange={e => updateValidator(v.id, { args: { ...v.args, [key]: parseFloat(e.target.value) } })} />
                                                            ) : (
                                                                <input style={inp} value={v.args[key] ?? schema.default} onChange={e => updateValidator(v.id, { args: { ...v.args, [key]: e.target.value } })} />
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Apply To */}
                        <div style={panelBase}>
                            <h3 style={{ margin: '0 0 13px', fontSize: 11, fontWeight: 800, color: '#ccc', letterSpacing: 1.5, textTransform: 'uppercase' }}>Apply To</h3>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                <div>
                                    <label style={lbl9}>Agent Profiles</label>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 130, overflowY: 'auto' }}>
                                        {agentProfiles.length === 0
                                            ? <div style={{ color: '#444', fontSize: 11 }}>No agent profiles.</div>
                                            : agentProfiles.map((p: any) => (
                                                <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#ccc', cursor: 'pointer' }}>
                                                    <input type="checkbox" checked={(selectedGuard.appliedToAgents || []).includes(p.id)} onChange={e => {
                                                        const cur = selectedGuard.appliedToAgents || [];
                                                        handleSaveGuard({ appliedToAgents: e.target.checked ? [...cur, p.id] : cur.filter((id: string) => id !== p.id) });
                                                    }} /> {p.name || p.id}
                                                </label>
                                            ))}
                                    </div>
                                </div>
                                <div>
                                    <label style={lbl9}>Workflows</label>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 130, overflowY: 'auto' }}>
                                        {wfList.length === 0
                                            ? <div style={{ color: '#444', fontSize: 11 }}>No workflows.</div>
                                            : wfList.map((w: any) => (
                                                <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#ccc', cursor: 'pointer' }}>
                                                    <input type="checkbox" checked={(selectedGuard.appliedToWorkflows || []).includes(w.id)} onChange={e => {
                                                        const cur = selectedGuard.appliedToWorkflows || [];
                                                        handleSaveGuard({ appliedToWorkflows: e.target.checked ? [...cur, w.id] : cur.filter((id: string) => id !== w.id) });
                                                    }} /> {w.name || w.id}
                                                </label>
                                            ))}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Test Runner */}
                        <div style={panelBase}>
                            <h3 style={{ margin: '0 0 13px', fontSize: 11, fontWeight: 800, color: '#ccc', letterSpacing: 1.5, textTransform: 'uppercase' }}>🧪 Test Guard</h3>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, marginBottom: 10 }}>
                                <textarea rows={3} style={{ ...inp, resize: 'vertical', fontFamily: 'monospace' }} placeholder="Enter sample text to validate..." value={testText} onChange={e => setTestText(e.target.value)} />
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                    <select value={testTarget} onChange={e => setTestTarget(e.target.value as any)} style={{ ...sel, width: 110 }}>
                                        <option value="input">Input</option>
                                        <option value="output">Output</option>
                                    </select>
                                    <button onClick={handleRunTest} disabled={testRunning || !testText} style={{ ...btnP, opacity: testRunning || !testText ? 0.5 : 1, cursor: testRunning || !testText ? 'not-allowed' : 'pointer' }}>
                                        {testRunning ? '⟳ ...' : '▶ RUN'}
                                    </button>
                                </div>
                            </div>
                            {testResult && (
                                <div style={{ background: testResult.passed ? 'rgba(45,160,66,0.1)' : 'rgba(197,48,48,0.1)', border: `1px solid ${testResult.passed ? '#2da04233' : '#cc241d33'}`, borderRadius: 6, padding: 13 }}>
                                    <div style={{ fontWeight: 800, fontSize: 13, color: testResult.passed ? '#2da042' : '#cc241d', marginBottom: 8 }}>
                                        {testResult.error ? `❌ ERROR: ${testResult.error}` : testResult.passed ? '✅ PASSED — All validators cleared' : `⚠️ FAILED — ${(testResult.violations || []).length} violation(s)`}
                                    </div>
                                    {(testResult.violations || []).map((v: any, i: number) => (
                                        <div key={i} style={{ background: 'rgba(197,48,48,0.1)', borderRadius: 4, padding: '8px 10px', marginBottom: 6 }}>
                                            <span style={{ fontWeight: 700, fontSize: 11, color: '#dcdcaa' }}>{v.validatorType}</span>
                                            <span style={{ fontSize: 10, color: '#888', marginLeft: 8 }}>on_fail: {v.on_fail}</span>
                                            <div style={{ fontSize: 11, color: '#cc241d', marginTop: 3 }}>{v.message}</div>
                                            {v.fixedValue !== undefined && <div style={{ fontSize: 10, color: '#569cd6', marginTop: 3 }}>Fixed: {v.fixedValue || '(empty)'}</div>}
                                        </div>
                                    ))}
                                    {testResult.output !== undefined && testResult.output !== testText && (
                                        <div style={{ marginTop: 9, padding: '8px 10px', background: 'rgba(86,156,214,0.1)', borderRadius: 4 }}>
                                            <div style={{ fontSize: 9, fontWeight: 800, color: '#569cd6', letterSpacing: 1, marginBottom: 3 }}>SANITIZED OUTPUT</div>
                                            <div style={{ fontSize: 11, color: '#ccc', fontFamily: 'monospace' }}>{testResult.output || '(empty — refrained)'}</div>
                                        </div>
                                    )}
                                    {(testResult.logs || []).length > 0 && (
                                        <details style={{ marginTop: 9 }}>
                                            <summary style={{ fontSize: 10, color: '#555', cursor: 'pointer' }}>Execution Log ({testResult.logs.length})</summary>
                                            <div style={{ marginTop: 5, padding: 8, background: '#0a0a0a', borderRadius: 4, fontFamily: 'monospace', fontSize: 10, color: '#666' }}>
                                                {(testResult.logs || []).map((l: string, i: number) => <div key={i}>{l}</div>)}
                                            </div>
                                        </details>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Python Export info box */}
                        <div style={{ ...panelBase, borderColor: 'rgba(0,122,204,0.2)', background: 'rgba(0,122,204,0.05)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                    <div style={{ fontWeight: 700, fontSize: 12, color: '#569cd6', marginBottom: 4 }}>↑ Export as Python</div>
                                    <div style={{ fontSize: 11, color: '#555' }}>
                                        Generates a <code style={{ color: '#ce9178' }}>guard_{(selectedGuard.name || 'guard').replace(/\s+/g, '_').toLowerCase()}.py</code> using the real <code style={{ color: '#ce9178' }}>guardrails-ai</code> SDK.
                                        Install with <code style={{ color: '#ce9178' }}>pip install guardrails-ai</code>.
                                    </div>
                                </div>
                                <button onClick={handleExport} style={btnP}>EXPORT PY</button>
                            </div>
                        </div>
                    </>)}
                </div>
            </div>

            {gbStatus && (
                <div style={{ marginTop: 14, padding: '10px 14px', background: 'rgba(78,201,176,0.1)', border: '1px solid rgba(78,201,176,0.3)', borderRadius: 4, color: '#4ec9b0', fontSize: 12 }}>
                    {gbStatus}
                </div>
            )}
        </div>
    );
};


// ═══════════════════════════════════════════════════════════════
// GuardrailsTab — sub-tab wrapper (Guard Builder | Validator Builder)
// ═══════════════════════════════════════════════════════════════
function GuardrailsTab({ settings, api }: { settings: any; api: any }) {
    const [subTab, setSubTab] = useState<'guards' | 'validators' | 'policy'>('guards');

    const pill = (id: 'guards' | 'validators' | 'policy', emoji: string, label: string) => (
        <button
            key={id}
            onClick={() => setSubTab(id)}
            style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '10px 20px',
                background: subTab === id
                    ? 'linear-gradient(135deg,rgba(0,122,204,0.35) 0%,rgba(0,95,158,0.25) 100%)'
                    : 'rgba(255,255,255,0.03)',
                color: subTab === id ? '#fff' : '#777',
                border: subTab === id
                    ? '1px solid rgba(0,122,204,0.55)'
                    : '1px solid rgba(255,255,255,0.06)',
                borderRadius: 8,
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 0.6,
                transition: '0.15s all',
            }}
        >
            <span style={{ fontSize: 15 }}>{emoji}</span>{label}
        </button>
    );

    return (
        <div style={{ fontFamily: "'Inter','Segoe UI',sans-serif" }}>
            {/* Sub-tab switcher */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 22 }}>
                {pill('guards', '🛡', 'Guard Builder')}
                {pill('validators', '🔧', 'Validator Builder')}
                {pill('policy', '📋', 'Policy Config')}
            </div>
            {subTab === 'guards' && <GuardBuilderPanel settings={settings} api={api} />}
            {subTab === 'validators' && <ValidatorBuilderPanel api={api} />}
            {subTab === 'policy' && <PolicyAuthoringPanel settings={settings} api={api} />}
        </div>
    );
}


// ═══════════════════════════════════════════════════════════════
// PolicyAuthoringPanel — structured policy config authoring UI
// ═══════════════════════════════════════════════════════════════
// This panel is an AUTHORING SURFACE ONLY.
// It writes GuardrailPolicyConfig to AppSettings via api.saveSettings().
// No enforcement, no validator execution, no runtime decisions happen here.
// PolicyGate consumes this config at runtime (electron side only).
// ═══════════════════════════════════════════════════════════════

const SEVERITY_OPTIONS: { value: GuardrailSeverity; label: string; color: string }[] = [
    { value: 'info',     label: 'Info',     color: '#458588' },
    { value: 'low',      label: 'Low',      color: '#689d6a' },
    { value: 'medium',   label: 'Medium',   color: '#d79921' },
    { value: 'high',     label: 'High',     color: '#d65d0e' },
    { value: 'critical', label: 'Critical', color: '#cc241d' },
];

const ACTION_OPTIONS: { value: GuardrailAction; label: string; desc: string }[] = [
    { value: 'allow',                label: '✅ Allow',                desc: 'Permit the action' },
    { value: 'warn',                 label: '⚠️ Warn',                  desc: 'Log and allow; surface in audit log' },
    { value: 'deny',                 label: '🚫 Deny',                  desc: 'Block the action; throw PolicyDeniedError' },
    { value: 'require_validation',   label: '🔍 Require Validation',    desc: 'Block until bound validators pass' },
    { value: 'require_confirmation', label: '❓ Require Confirmation',  desc: 'Future: request user confirmation' },
];

function makeDraftRule(): GuardrailRule {
    const now = new Date().toISOString();
    return {
        id: `rule-${Date.now()}`,
        name: 'New Rule',
        description: '',
        enabled: true,
        scopes: [],
        severity: 'medium',
        action: 'warn',
        validatorBindings: [],
        createdAt: now,
        updatedAt: now,
    };
}

function makeDraftBinding(): ValidatorBinding {
    return {
        id: `vb-${Date.now()}`,
        name: 'New Validator',
        providerKind: 'local_guardrails_ai',
        enabled: true,
        executionScopes: [],
        supportedActions: ['require_validation'],
        failOpen: false,
        priority: 0,
    };
}

function PolicyAuthoringPanel({ settings, api }: { settings: any; api: any }) {
    const getPolicy = (): GuardrailPolicyConfig =>
        settings?.guardrailPolicy ?? makeDefaultGuardrailPolicyConfig();

    const [policy, setPolicy] = useState<GuardrailPolicyConfig>(getPolicy);
    const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
    const [selectedBindingId, setSelectedBindingId] = useState<string | null>(null);
    const [status, setPolicyStatus] = useState('');
    const [section, setSection] = useState<'rules' | 'bindings'>('rules');

    const selectedRule = policy.rules.find(r => r.id === selectedRuleId) ?? null;
    const selectedBinding = policy.validatorBindings.find(b => b.id === selectedBindingId) ?? null;

    const flash = (msg: string) => { setPolicyStatus(msg); setTimeout(() => setPolicyStatus(''), 3000); };

    const savePolicy = async (updated: GuardrailPolicyConfig) => {
        const newPolicy = { ...updated, updatedAt: new Date().toISOString() };
        setPolicy(newPolicy);
        if (api?.saveSettings) {
            const currentSettings: AppSettings = settings ?? {};
            await api.saveSettings({ ...currentSettings, guardrailPolicy: newPolicy });
            flash('Policy saved ✓');
        }
    };

    const handleProfileChange = (profileId: string) => {
        savePolicy({ ...policy, activeProfileId: profileId });
    };

    const handleNewRule = () => {
        const rule = makeDraftRule();
        const updated = { ...policy, rules: [...policy.rules, rule] };
        savePolicy(updated);
        setSelectedRuleId(rule.id);
        setSection('rules');
    };

    const handleDeleteRule = () => {
        if (!selectedRuleId) return;
        const updated: GuardrailPolicyConfig = {
            ...policy,
            rules: policy.rules.filter(r => r.id !== selectedRuleId),
            profiles: policy.profiles.map(p => ({
                ...p,
                ruleIds: p.ruleIds.filter(id => id !== selectedRuleId),
            })),
        };
        savePolicy(updated);
        setSelectedRuleId(null);
    };

    const patchRule = (changes: Partial<GuardrailRule>) => {
        if (!selectedRuleId) return;
        const updated = {
            ...policy,
            rules: policy.rules.map(r =>
                r.id === selectedRuleId ? { ...r, ...changes, updatedAt: new Date().toISOString() } : r
            ),
        };
        savePolicy(updated);
    };

    const toggleRuleInProfile = (profileId: string, ruleId: string, include: boolean) => {
        const updated = {
            ...policy,
            profiles: policy.profiles.map(p => {
                if (p.id !== profileId) return p;
                return {
                    ...p,
                    ruleIds: include
                        ? [...p.ruleIds.filter(id => id !== ruleId), ruleId]
                        : p.ruleIds.filter(id => id !== ruleId),
                };
            }),
        };
        savePolicy(updated);
    };

    const handleNewBinding = () => {
        const binding = makeDraftBinding();
        const updated = {
            ...policy,
            validatorBindings: [...policy.validatorBindings, binding],
        };
        savePolicy(updated);
        setSelectedBindingId(binding.id);
        setSection('bindings');
    };

    const handleDeleteBinding = () => {
        if (!selectedBindingId) return;
        const updated = {
            ...policy,
            validatorBindings: policy.validatorBindings.filter(b => b.id !== selectedBindingId),
            rules: policy.rules.map(r => ({
                ...r,
                validatorBindings: r.validatorBindings.filter(b => b.id !== selectedBindingId),
            })),
        };
        savePolicy(updated);
        setSelectedBindingId(null);
    };

    const patchBinding = (changes: Partial<ValidatorBinding>) => {
        if (!selectedBindingId) return;
        const updated = {
            ...policy,
            validatorBindings: policy.validatorBindings.map(b =>
                b.id === selectedBindingId ? { ...b, ...changes } : b
            ),
        };
        savePolicy(updated);
    };

    const toggleBindingOnRule = (bindingId: string, include: boolean) => {
        if (!selectedRule) return;
        const existing = policy.validatorBindings.find(b => b.id === bindingId);
        if (!existing) return;
        patchRule({
            validatorBindings: include
                ? [...selectedRule.validatorBindings.filter(b => b.id !== bindingId), existing]
                : selectedRule.validatorBindings.filter(b => b.id !== bindingId),
        });
    };

    // Styles
    const panelBase: React.CSSProperties = { background: 'rgba(30,30,30,0.7)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: 18, backdropFilter: 'blur(8px)', marginBottom: 14 };
    const inp: React.CSSProperties = { background: '#111', border: '1px solid #333', color: '#eee', padding: '8px 11px', fontSize: 12, borderRadius: 4, width: '100%', outline: 'none', boxSizing: 'border-box' };
    const sel: React.CSSProperties = { ...inp, cursor: 'pointer' };
    const lbl9: React.CSSProperties = { display: 'block', fontSize: 9, fontWeight: 800, color: '#888', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 5 };
    const btnP: React.CSSProperties = { background: 'linear-gradient(135deg,#007acc,#005f9e)', color: '#fff', border: 'none', padding: '7px 14px', borderRadius: 4, cursor: 'pointer', fontWeight: 700, fontSize: 11, letterSpacing: 0.8 };
    const btnD: React.CSSProperties = { background: 'rgba(197,48,48,0.8)', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700 };
    const btnG: React.CSSProperties = { background: 'rgba(255,255,255,0.05)', color: '#bbb', border: '1px solid rgba(255,255,255,0.1)', padding: '7px 13px', borderRadius: 4, cursor: 'pointer', fontSize: 11 };
    const tabBtn = (active: boolean): React.CSSProperties => ({
        padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700,
        background: active ? 'rgba(0,122,204,0.3)' : 'rgba(255,255,255,0.04)',
        color: active ? '#7ab8e8' : '#666',
        border: active ? '1px solid rgba(0,122,204,0.4)' : '1px solid rgba(255,255,255,0.06)',
    });

    const providerMeta = (kind: ValidatorProviderKind) =>
        VALIDATOR_PROVIDER_REGISTRY.find(p => p.kind === kind);

    return (
        <div style={{ fontFamily: "'Inter','Segoe UI',sans-serif" }}>
            {/* Header */}
            <div style={{ marginBottom: 18 }}>
                <h2 style={{ margin: 0, color: '#dcdcaa', fontSize: 18, fontWeight: 800, letterSpacing: 1 }}>📋 POLICY CONFIG</h2>
                <p style={{ margin: '4px 0 0', fontSize: 11, color: '#555' }}>
                    Authoring surface for structured guardrail policy — saved to AppSettings and consumed by PolicyGate at runtime.
                    No enforcement runs here.
                </p>
            </div>

            {/* Active profile selector */}
            <div style={panelBase}>
                <label style={lbl9}>Active Policy Profile</label>
                <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                    {policy.profiles.map(p => (
                        <button
                            key={p.id}
                            onClick={() => handleProfileChange(p.id)}
                            style={{
                                padding: '8px 16px', borderRadius: 6, cursor: 'pointer',
                                fontWeight: 700, fontSize: 11,
                                background: policy.activeProfileId === p.id
                                    ? 'linear-gradient(135deg,rgba(0,122,204,0.4),rgba(0,95,158,0.3))'
                                    : 'rgba(255,255,255,0.04)',
                                color: policy.activeProfileId === p.id ? '#fff' : '#777',
                                border: policy.activeProfileId === p.id
                                    ? '1px solid rgba(0,122,204,0.6)'
                                    : '1px solid rgba(255,255,255,0.07)',
                            }}
                            title={p.description}
                        >
                            {p.name}
                        </button>
                    ))}
                </div>
                {policy.profiles.find(p => p.id === policy.activeProfileId)?.description && (
                    <div style={{ marginTop: 8, fontSize: 11, color: '#555' }}>
                        {policy.profiles.find(p => p.id === policy.activeProfileId)?.description}
                    </div>
                )}
            </div>

            {/* Section tabs: Rules | Validator Bindings */}
            <div style={{ display: 'flex', gap: 7, marginBottom: 14 }}>
                <button style={tabBtn(section === 'rules')} onClick={() => setSection('rules')}>
                    📏 Rules ({policy.rules.length})
                </button>
                <button style={tabBtn(section === 'bindings')} onClick={() => setSection('bindings')}>
                    🔌 Validator Bindings ({policy.validatorBindings.length})
                </button>
            </div>

            {/* ── Rules Section ─────────────────────────────────────────── */}
            {section === 'rules' && (
                <div style={{ display: 'grid', gridTemplateColumns: policy.rules.length > 0 ? '200px 1fr' : '1fr', gap: 14 }}>
                    {/* Rule list */}
                    {policy.rules.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <button onClick={handleNewRule} style={{ ...btnP, marginBottom: 7 }}>+ NEW RULE</button>
                            {policy.rules.map(r => (
                                <div
                                    key={r.id}
                                    onClick={() => setSelectedRuleId(r.id)}
                                    style={{
                                        padding: '10px 12px', borderRadius: 6, cursor: 'pointer',
                                        background: selectedRuleId === r.id ? 'rgba(0,122,204,0.2)' : 'rgba(255,255,255,0.03)',
                                        border: selectedRuleId === r.id ? '1px solid rgba(0,122,204,0.4)' : '1px solid rgba(255,255,255,0.05)',
                                        opacity: r.enabled ? 1 : 0.5,
                                    }}
                                >
                                    <div style={{ fontWeight: 700, fontSize: 12, color: '#eee', marginBottom: 2 }}>{r.name}</div>
                                    <div style={{ fontSize: 9, color: '#555', display: 'flex', gap: 6 }}>
                                        <span style={{ color: SEVERITY_OPTIONS.find(s => s.value === r.severity)?.color }}>{r.severity}</span>
                                        <span>{r.action}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Rule editor or empty state */}
                    <div>
                        {policy.rules.length === 0 ? (
                            <div style={{ ...panelBase, textAlign: 'center', padding: 50 }}>
                                <div style={{ fontSize: 34, opacity: 0.2, marginBottom: 10 }}>📏</div>
                                <div style={{ color: '#444', fontSize: 13 }}>No rules yet.</div>
                                <button onClick={handleNewRule} style={{ ...btnP, marginTop: 16 }}>+ NEW RULE</button>
                            </div>
                        ) : !selectedRule ? (
                            <div style={{ ...panelBase, textAlign: 'center', padding: 50 }}>
                                <div style={{ color: '#444', fontSize: 13 }}>Select a rule to edit.</div>
                            </div>
                        ) : (
                            <>
                                {/* Rule meta */}
                                <div style={panelBase}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
                                        <div style={{ flex: 1, marginRight: 14 }}>
                                            <label style={lbl9}>Rule Name</label>
                                            <input
                                                style={inp}
                                                value={selectedRule.name}
                                                onChange={e => patchRule({ name: e.target.value })}
                                            />
                                        </div>
                                        <div style={{ display: 'flex', gap: 7, marginTop: 18 }}>
                                            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#888', cursor: 'pointer' }}>
                                                <input
                                                    type="checkbox"
                                                    checked={selectedRule.enabled}
                                                    onChange={e => patchRule({ enabled: e.target.checked })}
                                                /> Enabled
                                            </label>
                                            <button onClick={handleDeleteRule} style={btnD}>DELETE</button>
                                        </div>
                                    </div>
                                    <label style={lbl9}>Description</label>
                                    <input
                                        style={{ ...inp, marginBottom: 12 }}
                                        value={selectedRule.description ?? ''}
                                        placeholder="Optional description..."
                                        onChange={e => patchRule({ description: e.target.value })}
                                    />
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                        <div>
                                            <label style={lbl9}>Severity</label>
                                            <select
                                                style={sel}
                                                value={selectedRule.severity}
                                                onChange={e => patchRule({ severity: e.target.value as GuardrailSeverity })}
                                            >
                                                {SEVERITY_OPTIONS.map(o => (
                                                    <option key={o.value} value={o.value}>{o.label}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div>
                                            <label style={lbl9}>Action</label>
                                            <select
                                                style={sel}
                                                value={selectedRule.action}
                                                onChange={e => patchRule({ action: e.target.value as GuardrailAction })}
                                            >
                                                {ACTION_OPTIONS.map(o => (
                                                    <option key={o.value} value={o.value}>{o.label}</option>
                                                ))}
                                            </select>
                                            <div style={{ fontSize: 10, color: '#555', marginTop: 4 }}>
                                                {ACTION_OPTIONS.find(o => o.value === selectedRule.action)?.desc}
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Scopes */}
                                <div style={panelBase}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                                        <h3 style={{ margin: 0, fontSize: 11, fontWeight: 800, color: '#ccc', letterSpacing: 1.5, textTransform: 'uppercase' }}>Scopes</h3>
                                        <button
                                            style={btnG}
                                            onClick={() => patchRule({ scopes: [...selectedRule.scopes, {}] })}
                                        >+ ADD SCOPE</button>
                                    </div>
                                    {selectedRule.scopes.length === 0 && (
                                        <div style={{ color: '#444', fontSize: 11 }}>No scopes — rule applies globally to all contexts.</div>
                                    )}
                                    {selectedRule.scopes.map((scope, idx) => (
                                        <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 9, marginBottom: 8, alignItems: 'end' }}>
                                            <div>
                                                <label style={lbl9}>Scope Kind</label>
                                                <select
                                                    style={sel}
                                                    value={
                                                        scope.executionType ? 'executionType' :
                                                        scope.executionOrigin ? 'executionOrigin' :
                                                        scope.mode ? 'mode' :
                                                        scope.capability ? 'capability' :
                                                        scope.memoryAction ? 'memoryAction' :
                                                        scope.workflowNodeType ? 'workflowNodeType' :
                                                        scope.autonomyAction ? 'autonomyAction' : ''
                                                    }
                                                    onChange={e => {
                                                        const scopes = [...selectedRule.scopes];
                                                        scopes[idx] = { [e.target.value]: '' } as any;
                                                        patchRule({ scopes });
                                                    }}
                                                >
                                                    <option value="">Select kind...</option>
                                                    <option value="executionType">Execution Type</option>
                                                    <option value="executionOrigin">Execution Origin</option>
                                                    <option value="mode">Mode</option>
                                                    <option value="capability">Capability</option>
                                                    <option value="memoryAction">Memory Action</option>
                                                    <option value="workflowNodeType">Workflow Node Type</option>
                                                    <option value="autonomyAction">Autonomy Action</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label style={lbl9}>Value</label>
                                                <input
                                                    style={inp}
                                                    value={Object.values(scope)[0] as string ?? ''}
                                                    placeholder="e.g. rp / chat_turn / fs_write..."
                                                    onChange={e => {
                                                        const scopes = [...selectedRule.scopes];
                                                        const key = Object.keys(scope)[0];
                                                        if (key) scopes[idx] = { [key]: e.target.value } as any;
                                                        patchRule({ scopes });
                                                    }}
                                                />
                                            </div>
                                            <button
                                                style={btnD}
                                                onClick={() => {
                                                    patchRule({ scopes: selectedRule.scopes.filter((_, i) => i !== idx) });
                                                }}
                                            >✕</button>
                                        </div>
                                    ))}
                                </div>

                                {/* Profiles this rule belongs to */}
                                <div style={panelBase}>
                                    <h3 style={{ margin: '0 0 11px', fontSize: 11, fontWeight: 800, color: '#ccc', letterSpacing: 1.5, textTransform: 'uppercase' }}>Assign to Profiles</h3>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                        {policy.profiles.map(p => (
                                            <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: '#ccc', cursor: 'pointer' }}>
                                                <input
                                                    type="checkbox"
                                                    checked={p.ruleIds.includes(selectedRule.id)}
                                                    onChange={e => toggleRuleInProfile(p.id, selectedRule.id, e.target.checked)}
                                                />
                                                {p.name}
                                                {p.readonly && <span style={{ fontSize: 9, color: '#555' }}>(built-in)</span>}
                                            </label>
                                        ))}
                                    </div>
                                </div>

                                {/* Validator bindings attached to this rule */}
                                {selectedRule.action === 'require_validation' && (
                                    <div style={panelBase}>
                                        <h3 style={{ margin: '0 0 11px', fontSize: 11, fontWeight: 800, color: '#ccc', letterSpacing: 1.5, textTransform: 'uppercase' }}>Attached Validator Bindings</h3>
                                        {policy.validatorBindings.length === 0 ? (
                                            <div style={{ color: '#555', fontSize: 11 }}>
                                                No validator bindings defined yet. Create them in the "Validator Bindings" section, then attach here.
                                            </div>
                                        ) : (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                                                {policy.validatorBindings.map(b => (
                                                    <label key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: '#ccc', cursor: 'pointer' }}>
                                                        <input
                                                            type="checkbox"
                                                            checked={selectedRule.validatorBindings.some(vb => vb.id === b.id)}
                                                            onChange={e => toggleBindingOnRule(b.id, e.target.checked)}
                                                        />
                                                        <span style={{ fontWeight: 700 }}>{b.name}</span>
                                                        <span style={{ fontSize: 9, color: '#555' }}>({b.providerKind})</span>
                                                        {!b.enabled && <span style={{ fontSize: 9, color: '#cc241d' }}>DISABLED</span>}
                                                    </label>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* ── Validator Bindings Section ─────────────────────────── */}
            {section === 'bindings' && (
                <div style={{ display: 'grid', gridTemplateColumns: policy.validatorBindings.length > 0 ? '200px 1fr' : '1fr', gap: 14 }}>
                    {policy.validatorBindings.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <button onClick={handleNewBinding} style={{ ...btnP, marginBottom: 7 }}>+ NEW BINDING</button>
                            {policy.validatorBindings.map(b => (
                                <div
                                    key={b.id}
                                    onClick={() => setSelectedBindingId(b.id)}
                                    style={{
                                        padding: '10px 12px', borderRadius: 6, cursor: 'pointer',
                                        background: selectedBindingId === b.id ? 'rgba(0,122,204,0.2)' : 'rgba(255,255,255,0.03)',
                                        border: selectedBindingId === b.id ? '1px solid rgba(0,122,204,0.4)' : '1px solid rgba(255,255,255,0.05)',
                                        opacity: b.enabled ? 1 : 0.5,
                                    }}
                                >
                                    <div style={{ fontWeight: 700, fontSize: 12, color: '#eee', marginBottom: 2 }}>{b.name}</div>
                                    <div style={{ fontSize: 9, color: '#555' }}>
                                        {providerMeta(b.providerKind)?.isRemote ? '🌐 Remote' : '💻 Local'} · {b.providerKind}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    <div>
                        {policy.validatorBindings.length === 0 ? (
                            <div style={{ ...panelBase, textAlign: 'center', padding: 50 }}>
                                <div style={{ fontSize: 34, opacity: 0.2, marginBottom: 10 }}>🔌</div>
                                <div style={{ color: '#444', fontSize: 13 }}>No validator bindings yet.</div>
                                <button onClick={handleNewBinding} style={{ ...btnP, marginTop: 16 }}>+ NEW BINDING</button>
                            </div>
                        ) : !selectedBinding ? (
                            <div style={{ ...panelBase, textAlign: 'center', padding: 50 }}>
                                <div style={{ color: '#444', fontSize: 13 }}>Select a binding to edit.</div>
                            </div>
                        ) : (
                            <>
                                <div style={panelBase}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
                                        <div style={{ flex: 1, marginRight: 14 }}>
                                            <label style={lbl9}>Binding Name</label>
                                            <input
                                                style={inp}
                                                value={selectedBinding.name}
                                                onChange={e => patchBinding({ name: e.target.value })}
                                            />
                                        </div>
                                        <div style={{ display: 'flex', gap: 7, marginTop: 18 }}>
                                            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#888', cursor: 'pointer' }}>
                                                <input
                                                    type="checkbox"
                                                    checked={selectedBinding.enabled}
                                                    onChange={e => patchBinding({ enabled: e.target.checked })}
                                                /> Enabled
                                            </label>
                                            <button onClick={handleDeleteBinding} style={btnD}>DELETE</button>
                                        </div>
                                    </div>

                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                                        <div>
                                            <label style={lbl9}>Provider Kind</label>
                                            <select
                                                style={sel}
                                                value={selectedBinding.providerKind}
                                                onChange={e => patchBinding({ providerKind: e.target.value as ValidatorProviderKind })}
                                            >
                                                {VALIDATOR_PROVIDER_REGISTRY.map(p => (
                                                    <option key={p.kind} value={p.kind}>
                                                        {p.isRemote ? '🌐' : '💻'} {p.label}
                                                    </option>
                                                ))}
                                            </select>
                                            <div style={{ fontSize: 10, color: '#555', marginTop: 4 }}>
                                                {providerMeta(selectedBinding.providerKind)?.description}
                                            </div>
                                        </div>
                                        <div>
                                            <label style={lbl9}>Priority (lower runs first)</label>
                                            <input
                                                type="number"
                                                style={inp}
                                                value={selectedBinding.priority}
                                                min={0}
                                                onChange={e => patchBinding({ priority: parseInt(e.target.value) || 0 })}
                                            />
                                        </div>
                                    </div>

                                    {/* Remote endpoint — shown for remote providers */}
                                    {providerMeta(selectedBinding.providerKind)?.isRemote && (
                                        <div style={{ marginBottom: 12 }}>
                                            <label style={lbl9}>Endpoint URL</label>
                                            <input
                                                style={inp}
                                                value={selectedBinding.endpointUrl ?? ''}
                                                placeholder="https://validator.example.com/v1/check"
                                                onChange={e => patchBinding({ endpointUrl: e.target.value || undefined })}
                                            />
                                        </div>
                                    )}

                                    {/* Timeout */}
                                    <div style={{ marginBottom: 12 }}>
                                        <label style={lbl9}>Timeout (ms)</label>
                                        <input
                                            type="number"
                                            style={inp}
                                            value={selectedBinding.timeoutMs ?? 5000}
                                            min={100}
                                            onChange={e => patchBinding({ timeoutMs: parseInt(e.target.value) || 5000 })}
                                        />
                                    </div>

                                    {/* GuardrailsAI-specific */}
                                    {(selectedBinding.providerKind === 'local_guardrails_ai' || selectedBinding.providerKind === 'remote_guardrails_service') && (
                                        <div style={{ marginBottom: 12 }}>
                                            <label style={lbl9}>Validator Name (GuardrailsAI class)</label>
                                            <input
                                                style={inp}
                                                value={selectedBinding.validatorName ?? ''}
                                                placeholder="e.g. ToxicLanguage"
                                                onChange={e => patchBinding({ validatorName: e.target.value || undefined })}
                                            />
                                        </div>
                                    )}

                                    {/* Presidio-specific */}
                                    {selectedBinding.providerKind === 'local_presidio' && (
                                        <div style={{ marginBottom: 12 }}>
                                            <label style={lbl9}>Entity Types (comma-separated)</label>
                                            <input
                                                style={inp}
                                                value={(selectedBinding.entityTypes ?? []).join(', ')}
                                                placeholder="PERSON, EMAIL_ADDRESS, PHONE_NUMBER"
                                                onChange={e => patchBinding({
                                                    entityTypes: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                                                })}
                                            />
                                        </div>
                                    )}

                                    {/* NeMo-specific */}
                                    {(selectedBinding.providerKind === 'local_nemo_guardrails' || selectedBinding.providerKind === 'remote_nemo_guardrails') && (
                                        <div style={{ marginBottom: 12 }}>
                                            <label style={lbl9}>Rail Set / Config Name</label>
                                            <input
                                                style={inp}
                                                value={selectedBinding.railSet ?? ''}
                                                placeholder="e.g. safe_assistant"
                                                onChange={e => patchBinding({ railSet: e.target.value || undefined })}
                                            />
                                        </div>
                                    )}

                                    {/* OPA-specific */}
                                    {(selectedBinding.providerKind === 'local_opa' || selectedBinding.providerKind === 'remote_opa') && (<>
                                        <div style={{ marginBottom: 12 }}>
                                            <label style={lbl9}>Policy Module</label>
                                            <input
                                                style={inp}
                                                value={selectedBinding.policyModule ?? ''}
                                                placeholder="e.g. policy/guardrails"
                                                onChange={e => patchBinding({ policyModule: e.target.value || undefined })}
                                            />
                                        </div>
                                        <div style={{ marginBottom: 12 }}>
                                            <label style={lbl9}>Rule Name</label>
                                            <input
                                                style={inp}
                                                value={selectedBinding.ruleName ?? ''}
                                                placeholder="e.g. allow"
                                                onChange={e => patchBinding({ ruleName: e.target.value || undefined })}
                                            />
                                        </div>
                                    </>)}

                                    {/* Fail mode */}
                                    <div style={{ marginTop: 4 }}>
                                        <label style={lbl9}>On Validator Failure</label>
                                        <div style={{ display: 'flex', gap: 10 }}>
                                            <label style={{ fontSize: 11, color: '#ccc', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                                                <input
                                                    type="radio"
                                                    name={`failmode-${selectedBinding.id}`}
                                                    checked={!selectedBinding.failOpen}
                                                    onChange={() => patchBinding({ failOpen: false })}
                                                />
                                                🔒 Fail Closed (deny action)
                                            </label>
                                            <label style={{ fontSize: 11, color: '#ccc', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                                                <input
                                                    type="radio"
                                                    name={`failmode-${selectedBinding.id}`}
                                                    checked={selectedBinding.failOpen}
                                                    onChange={() => patchBinding({ failOpen: true })}
                                                />
                                                🔓 Fail Open (allow action)
                                            </label>
                                        </div>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* Status bar */}
            {status && (
                <div style={{ marginTop: 14, padding: '9px 13px', background: 'rgba(78,201,176,0.1)', border: '1px solid rgba(78,201,176,0.3)', borderRadius: 4, color: '#4ec9b0', fontSize: 12 }}>
                    {status}
                </div>
            )}

            {/* Readonly note */}
            <div style={{ marginTop: 18, padding: '10px 14px', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 4 }}>
                <div style={{ fontSize: 10, color: '#444', fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 }}>📋 Runtime Note</div>
                <div style={{ fontSize: 11, color: '#3a5a7a' }}>
                    This config is stored in AppSettings.guardrailPolicy and consumed by PolicyGate (electron/services/policy/PolicyGate.ts) at runtime.
                    No enforcement decisions are made here. Validators are invoked by PolicyGate, not the UI.
                </div>
            </div>
        </div>
    );
}


// ═══════════════════════════════════════════════════════════════
// ValidatorBuilderPanel — custom validator authoring UI
// ═══════════════════════════════════════════════════════════════

/** The schema for a single argument the validator accepts */
interface ArgDef {
    key: string;
    type: 'string' | 'number' | 'boolean' | 'array';
    description: string;
    default: string;    // stored as string; cast on use
    required: boolean;
}

/** A full custom validator definition */
interface CustomValidator {
    id: string;
    name: string;
    description: string;
    category: string;
    impl: 'regex' | 'keyword' | 'length' | 'llm' | 'schema' | 'script';
    // impl-specific config
    regexPattern: string;
    regexFlags: string;
    keywordList: string;         // comma-separated
    keywordMode: 'any' | 'all' | 'none';
    minLength: number;
    maxLength: number;
    llmPrompt: string;          // uses {{value}} placeholder
    llmPassPhrase: string;       // what the LLM should respond if passing
    jsonSchema: string;          // JSON string
    scriptCode: string;          // JS snippet, receives `value`, returns bool
    // args schema (for parameterized validators)
    argsSchema: ArgDef[];
    // test
    testInput: string;
    // meta
    enabled: boolean;
    createdAt: string;
}

const IMPL_OPTIONS = [
    { value: 'regex', label: '📐 Regex Pattern', desc: 'Matches text against a regular expression' },
    { value: 'keyword', label: '🔤 Keyword Filter', desc: 'Allow or block based on keyword presence' },
    { value: 'length', label: '📏 Length Check', desc: 'Enforce min/max character or token length' },
    { value: 'llm', label: '🤖 LLM Judge', desc: 'Use a model to evaluate the value via a prompt' },
    { value: 'schema', label: '📋 JSON Schema', desc: 'Validate structured output against a JSON schema' },
    { value: 'script', label: '⚙️ Custom Script', desc: 'Write a small JS function that returns true/false' },
];

const CATEGORY_OPTIONS = ['Etiquette', 'Brand Risk', 'Data Leakage', 'Jailbreaking', 'Factuality', 'Formatting', 'Custom'];

const ARG_TYPES = ['string', 'number', 'boolean', 'array'] as const;

const VALIDATOR_STORAGE_KEY = 'tala_custom_validators';

function loadCustomValidators(): CustomValidator[] {
    try {
        const raw = localStorage.getItem(VALIDATOR_STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}

function saveCustomValidatorsToStorage(validators: CustomValidator[]) {
    localStorage.setItem(VALIDATOR_STORAGE_KEY, JSON.stringify(validators));
}

function makeNewValidator(): CustomValidator {
    return {
        id: `cv-${Date.now()}`,
        name: 'My Validator',
        description: '',
        category: 'Custom',
        impl: 'regex',
        regexPattern: '',
        regexFlags: 'i',
        keywordList: '',
        keywordMode: 'any',
        minLength: 0,
        maxLength: 10000,
        llmPrompt: 'Does the following text violate safety guidelines? Answer YES or NO only.\n\nText: {{value}}',
        llmPassPhrase: 'NO',
        jsonSchema: '{\n  "type": "object",\n  "properties": {}\n}',
        scriptCode: '// value is the text being validated.\n// Return true to PASS, false to FAIL.\nreturn value.length > 0;',
        argsSchema: [],
        testInput: '',
        enabled: true,
        createdAt: new Date().toISOString(),
    };
}

function ValidatorBuilderPanel({ api }: { api: any }) {
    const [validators, setValidators] = useState<CustomValidator[]>(loadCustomValidators);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [vbStatus, setVbStatus] = useState('');
    const [testResult, setTestResult] = useState<{ passed: boolean; message: string } | null>(null);
    const [testRunning, setTestRunning] = useState(false);
    const [activeSection, setActiveSection] = useState<'config' | 'args' | 'test' | 'export'>('config');

    const selected = validators.find(v => v.id === selectedId) || null;

    const flash = (msg: string) => { setVbStatus(msg); setTimeout(() => setVbStatus(''), 3500); };

    const persist = (list: CustomValidator[]) => {
        setValidators(list);
        saveCustomValidatorsToStorage(list);
    };

    const handleNew = () => {
        const nv = makeNewValidator();
        const updated = [...validators, nv];
        persist(updated);
        setSelectedId(nv.id);
        setActiveSection('config');
        setTestResult(null);
    };

    const handleDelete = () => {
        if (!selected) return;
        if (!confirm(`Delete validator "${selected.name}"?`)) return;
        const updated = validators.filter(v => v.id !== selectedId);
        persist(updated);
        setSelectedId(null);
    };

    const patch = (changes: Partial<CustomValidator>) => {
        if (!selected) return;
        const updated = validators.map(v => v.id === selectedId ? { ...v, ...changes } : v);
        persist(updated);
    };

    const patchArg = (idx: number, changes: Partial<ArgDef>) => {
        if (!selected) return;
        const args = [...selected.argsSchema];
        args[idx] = { ...args[idx], ...changes };
        patch({ argsSchema: args });
    };

    const addArg = () => {
        if (!selected) return;
        patch({ argsSchema: [...selected.argsSchema, { key: 'param', type: 'string', description: '', default: '', required: false }] });
    };

    const removeArg = (idx: number) => {
        if (!selected) return;
        patch({ argsSchema: selected.argsSchema.filter((_, i) => i !== idx) });
    };

    // ── Test runner ────────────────────────────────────────────────────
    const runTest = async () => {
        if (!selected || !selected.testInput) return;
        setTestRunning(true);
        setTestResult(null);
        try {
            const val = selected.testInput;
            let passed = false;
            let message = '';

            switch (selected.impl) {
                case 'regex': {
                    if (!selected.regexPattern) { message = 'No pattern defined.'; break; }
                    const re = new RegExp(selected.regexPattern, selected.regexFlags);
                    passed = re.test(val);
                    message = passed ? `✓ Matched pattern /${selected.regexPattern}/${selected.regexFlags}` : `✗ Did not match pattern /${selected.regexPattern}/${selected.regexFlags}`;
                    break;
                }
                case 'keyword': {
                    const keywords = selected.keywordList.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
                    const lower = val.toLowerCase();
                    if (selected.keywordMode === 'any') {
                        passed = keywords.some(k => lower.includes(k));
                        message = passed ? `✓ Found keyword(s): ${keywords.filter(k => lower.includes(k)).join(', ')}` : '✗ No matching keywords found';
                    } else if (selected.keywordMode === 'all') {
                        const found = keywords.filter(k => lower.includes(k));
                        passed = found.length === keywords.length;
                        message = passed ? '✓ All keywords present' : `✗ Missing: ${keywords.filter(k => !lower.includes(k)).join(', ')}`;
                    } else { // none
                        const found = keywords.filter(k => lower.includes(k));
                        passed = found.length === 0;
                        message = passed ? '✓ No blocked keywords found' : `✗ Found blocked keyword(s): ${found.join(', ')}`;
                    }
                    break;
                }
                case 'length': {
                    const len = val.length;
                    passed = len >= selected.minLength && len <= selected.maxLength;
                    message = passed
                        ? `✓ Length ${len} is within [${selected.minLength}, ${selected.maxLength}]`
                        : `✗ Length ${len} is outside [${selected.minLength}, ${selected.maxLength}]`;
                    break;
                }
                case 'schema': {
                    try {
                        const schema = JSON.parse(selected.jsonSchema);
                        const parsed = JSON.parse(val);
                        // Minimal type check (full AJV not available here)
                        if (schema.type === 'object' && typeof parsed !== 'object') throw new Error('Not an object');
                        if (schema.type === 'array' && !Array.isArray(parsed)) throw new Error('Not an array');
                        if (schema.required) {
                            for (const req of schema.required) {
                                if (!(req in parsed)) throw new Error(`Missing required field: ${req}`);
                            }
                        }
                        passed = true;
                        message = '✓ Value matches JSON schema';
                    } catch (e: any) {
                        message = `✗ Schema validation failed: ${e.message}`;
                    }
                    break;
                }
                case 'script': {
                    try {
                        // eslint-disable-next-line no-new-func
                        const fn = new Function('value', selected.scriptCode);
                        passed = !!fn(val);
                        message = passed ? '✓ Script returned truthy' : '✗ Script returned falsy';
                    } catch (e: any) {
                        message = `✗ Script error: ${e.message}`;
                    }
                    break;
                }
                case 'llm': {
                    if (!api?.chat) { message = '✗ LLM API not available in test context. Use via a Guard at runtime.'; break; }
                    const prompt = selected.llmPrompt.replace('{{value}}', val);
                    const response = await api.chat(prompt);
                    passed = response?.trim().toUpperCase().startsWith(selected.llmPassPhrase.trim().toUpperCase());
                    message = passed ? `✓ LLM responded: "${response?.trim()}"` : `✗ LLM responded: "${response?.trim()}"`;
                    break;
                }
                default:
                    message = 'Unknown impl type';
            }
            setTestResult({ passed, message });
        } catch (e: any) {
            setTestResult({ passed: false, message: `Error: ${e.message}` });
        } finally {
            setTestRunning(false);
        }
    };

    // ── Export this validator as Python ────────────────────────────────
    const exportPython = () => {
        if (!selected) return;
        const sanitizedName = selected.name.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '');
        let implBody = '';
        switch (selected.impl) {
            case 'regex':
                implBody = `        import re\n        pattern = re.compile(r"${selected.regexPattern}", re.${selected.regexFlags.toUpperCase() || 'IGNORECASE'})\n        if not pattern.search(value):\n            return FailResult(error_message="Value did not match required pattern.")\n        return PassResult()`;
                break;
            case 'keyword':
                implBody = `        keywords = [${selected.keywordList.split(',').map(k => `"${k.trim()}"`).join(', ')}]\n        lower = value.lower()\n        found = [k for k in keywords if k in lower]\n        # mode: ${selected.keywordMode}\n        if not found:\n            return FailResult(error_message="No matching keywords found.")\n        return PassResult()`;
                break;
            case 'length':
                implBody = `        if len(value) < ${selected.minLength} or len(value) > ${selected.maxLength}:\n            return FailResult(error_message=f"Length {{len(value)}} outside range [${selected.minLength}, ${selected.maxLength}].")\n        return PassResult()`;
                break;
            case 'llm':
                implBody = `        # LLM-based validator — integrate with your preferred LLM\n        # prompt = f"""${selected.llmPrompt.replace('{{value}}', '{value}')}"""\n        # response = your_llm(prompt)\n        # if not response.strip().upper().startswith("${selected.llmPassPhrase.trim().toUpperCase()}"):\n        #     return FailResult(error_message="LLM judged the value as failing.")\n        return PassResult()  # implement LLM call above`;
                break;
            case 'schema':
                implBody = `        import json\n        schema = ${selected.jsonSchema}\n        import jsonschema\n        try:\n            jsonschema.validate(json.loads(value), schema)\n        except Exception as e:\n            return FailResult(error_message=str(e))\n        return PassResult()`;
                break;
            default:
                implBody = `        # Custom implementation\n        return PassResult()`;
        }
        const argsInit = selected.argsSchema.map(a => `        self.${a.key} = ${a.key} if ${a.key} is not None else ${JSON.stringify(a.default)}`).join('\n');
        const argsParams = selected.argsSchema.map(a => `${a.key}=${JSON.stringify(a.default)}`).join(', ');
        const python = `from guardrails import Validator, register_validator
from guardrails.validators import PassResult, FailResult
from typing import Any, Callable, Dict, Optional, Union

@register_validator(name="${sanitizedName}", data_type="string")
class ${sanitizedName}(Validator):
    """${selected.description || selected.name}
    
    Category: ${selected.category}
    Implementation: ${selected.impl}
    Created by Tala Guard Builder
    """

    def __init__(self, ${argsParams ? argsParams + ', ' : ''}on_fail: Optional[Callable] = None):
        super().__init__(on_fail=on_fail)
${argsInit}

    def validate(self, value: Any, metadata: Dict) -> Union[PassResult, FailResult]:
${implBody}
`;
        const blob = new Blob([python], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `validator_${sanitizedName.toLowerCase()}.py`;
        a.click();
        URL.revokeObjectURL(url);
        flash(`Exported validator_${sanitizedName.toLowerCase()}.py`);
    };

    // ── Styles ──────────────────────────────────────────────────────────
    const panelBase: React.CSSProperties = { background: 'rgba(30,30,30,0.7)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: 20, backdropFilter: 'blur(8px)', marginBottom: 14 };
    const inp: React.CSSProperties = { background: '#111', border: '1px solid #333', color: '#eee', padding: '9px 12px', fontSize: 12, borderRadius: 4, width: '100%', outline: 'none', boxSizing: 'border-box' };
    const sel: React.CSSProperties = { ...inp, cursor: 'pointer' };
    const mono: React.CSSProperties = { ...inp, fontFamily: 'monospace', fontSize: 11, resize: 'vertical' };
    const lbl9: React.CSSProperties = { display: 'block', fontSize: 9, fontWeight: 800, color: '#888', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 5 };
    const btnP: React.CSSProperties = { background: 'linear-gradient(135deg,#007acc,#005f9e)', color: '#fff', border: 'none', padding: '7px 15px', borderRadius: 4, cursor: 'pointer', fontWeight: 700, fontSize: 11, letterSpacing: 0.8 };
    const btnD: React.CSSProperties = { background: 'rgba(197,48,48,0.8)', color: '#fff', border: 'none', padding: '7px 13px', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700 };
    const btnG: React.CSSProperties = { background: 'rgba(255,255,255,0.05)', color: '#ccc', border: '1px solid rgba(255,255,255,0.1)', padding: '7px 13px', borderRadius: 4, cursor: 'pointer', fontSize: 11 };

    const sectionPill = (id: 'config' | 'args' | 'test' | 'export', emoji: string, label: string) => (
        <button
            key={id}
            onClick={() => setActiveSection(id)}
            style={{
                padding: '6px 13px',
                background: activeSection === id ? 'rgba(0,122,204,0.25)' : 'transparent',
                color: activeSection === id ? '#7ab8e8' : '#555',
                border: activeSection === id ? '1px solid rgba(0,122,204,0.4)' : '1px solid transparent',
                borderRadius: 5,
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 700,
                transition: '0.1s',
            }}
        >{emoji} {label}</button>
    );

    return (
        <div style={{ fontFamily: "'Inter','Segoe UI',sans-serif" }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <div>
                    <h2 style={{ margin: 0, color: '#dcdcaa', fontSize: 18, fontWeight: 800, letterSpacing: 1 }}>🔧 VALIDATOR BUILDER</h2>
                    <p style={{ margin: '4px 0 0', fontSize: 11, color: '#666' }}>Build custom validators — regex, keywords, length, LLM-judge, JSON schema, or JS script</p>
                </div>
                <button onClick={handleNew} style={btnP}>+ NEW VALIDATOR</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: validators.length > 0 ? '210px 1fr' : '1fr', gap: 14 }}>
                {/* Left: validator list */}
                {validators.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        {validators.map(v => {
                            const implMeta = IMPL_OPTIONS.find(o => o.value === v.impl);
                            return (
                                <div
                                    key={v.id}
                                    onClick={() => { setSelectedId(v.id); setTestResult(null); setActiveSection('config'); }}
                                    style={{
                                        padding: '11px 13px',
                                        borderRadius: 6,
                                        cursor: 'pointer',
                                        background: selectedId === v.id ? 'rgba(0,122,204,0.2)' : 'rgba(255,255,255,0.03)',
                                        border: selectedId === v.id ? '1px solid rgba(0,122,204,0.4)' : '1px solid rgba(255,255,255,0.05)',
                                        transition: '0.12s',
                                        opacity: v.enabled ? 1 : 0.5,
                                    }}
                                >
                                    <div style={{ fontWeight: 700, fontSize: 12, color: '#eee', marginBottom: 2 }}>{v.name}</div>
                                    <div style={{ fontSize: 10, color: '#666' }}>{implMeta?.label.split(' ').slice(1).join(' ') || v.impl} · {v.category}</div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Right: editor */}
                <div>
                    {!selected ? (
                        <div style={{ ...panelBase, textAlign: 'center', padding: 60 }}>
                            <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.2 }}>🔧</div>
                            <div style={{ color: '#444', fontSize: 13 }}>
                                {validators.length === 0
                                    ? 'No custom validators yet. Click "+ NEW VALIDATOR" to create one.'
                                    : 'Select a validator from the left to edit it.'}
                            </div>
                        </div>
                    ) : (<>
                        {/* Section nav */}
                        <div style={{ display: 'flex', gap: 4, marginBottom: 14, background: 'rgba(255,255,255,0.03)', padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.05)' }}>
                            {sectionPill('config', '⚙️', 'Configuration')}
                            {sectionPill('args', '🧩', 'Args Schema')}
                            {sectionPill('test', '🧪', 'Test')}
                            {sectionPill('export', '↑', 'Export')}
                            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                                <button onClick={exportPython} style={btnG} title="Download as Python validator">↑ PY</button>
                                <button onClick={handleDelete} style={btnD}>DELETE</button>
                            </div>
                        </div>

                        {/* ── CONFIGURATION ─────────────────────────────── */}
                        {activeSection === 'config' && (
                            <div style={panelBase}>
                                {/* Name / Category / Enabled */}
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, marginBottom: 14 }}>
                                    <div>
                                        <label style={lbl9}>Validator Name</label>
                                        <input style={inp} value={selected.name} onChange={e => patch({ name: e.target.value })} />
                                    </div>
                                    <div>
                                        <label style={lbl9}>Category</label>
                                        <select style={sel} value={selected.category} onChange={e => patch({ category: e.target.value })}>
                                            {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                                        </select>
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', paddingBottom: 2 }}>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#888', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                            <input type="checkbox" checked={selected.enabled} onChange={e => patch({ enabled: e.target.checked })} />
                                            Enabled
                                        </label>
                                    </div>
                                </div>

                                {/* Description */}
                                <div style={{ marginBottom: 16 }}>
                                    <label style={lbl9}>Description</label>
                                    <input style={inp} value={selected.description} placeholder="What does this validator check?" onChange={e => patch({ description: e.target.value })} />
                                </div>

                                {/* Implementation type */}
                                <div style={{ marginBottom: 18 }}>
                                    <label style={lbl9}>Implementation Type</label>
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                                        {IMPL_OPTIONS.map(opt => (
                                            <div
                                                key={opt.value}
                                                onClick={() => patch({ impl: opt.value as CustomValidator['impl'] })}
                                                style={{
                                                    padding: '10px 12px',
                                                    borderRadius: 6,
                                                    cursor: 'pointer',
                                                    background: selected.impl === opt.value ? 'rgba(0,122,204,0.18)' : 'rgba(255,255,255,0.02)',
                                                    border: selected.impl === opt.value ? '1px solid rgba(0,122,204,0.5)' : '1px solid rgba(255,255,255,0.05)',
                                                    transition: '0.1s',
                                                }}
                                            >
                                                <div style={{ fontWeight: 700, fontSize: 11, color: selected.impl === opt.value ? '#7ab8e8' : '#bbb', marginBottom: 3 }}>
                                                    {opt.label}
                                                </div>
                                                <div style={{ fontSize: 10, color: '#555' }}>{opt.desc}</div>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* Impl-specific config */}
                                <div style={{ background: 'rgba(0,0,0,0.25)', borderRadius: 6, padding: 16 }}>
                                    <div style={{ fontSize: 9, fontWeight: 800, color: '#666', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 12 }}>
                                        {IMPL_OPTIONS.find(o => o.value === selected.impl)?.label} — Settings
                                    </div>

                                    {selected.impl === 'regex' && (<>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 10 }}>
                                            <div>
                                                <label style={lbl9}>Regex Pattern</label>
                                                <input style={{ ...inp, fontFamily: 'monospace' }} value={selected.regexPattern} placeholder="e.g. \b(word)\b" onChange={e => patch({ regexPattern: e.target.value })} />
                                            </div>
                                            <div>
                                                <label style={lbl9}>Flags</label>
                                                <input style={{ ...inp, fontFamily: 'monospace' }} value={selected.regexFlags} placeholder="i, g, m..." onChange={e => patch({ regexFlags: e.target.value })} />
                                            </div>
                                        </div>
                                        <div style={{ marginTop: 8, fontSize: 10, color: '#556' }}>Pattern test will return PASS if the regex matches the input.</div>
                                    </>)}

                                    {selected.impl === 'keyword' && (<>
                                        <div style={{ marginBottom: 10 }}>
                                            <label style={lbl9}>Keywords (comma-separated)</label>
                                            <input style={inp} value={selected.keywordList} placeholder="badword1, restricted_term, blocklist" onChange={e => patch({ keywordList: e.target.value })} />
                                        </div>
                                        <div>
                                            <label style={lbl9}>Match Mode</label>
                                            <select style={sel} value={selected.keywordMode} onChange={e => patch({ keywordMode: e.target.value as any })}>
                                                <option value="any">ANY — PASS if any keyword found</option>
                                                <option value="all">ALL — PASS only if all keywords found</option>
                                                <option value="none">NONE — PASS only if NO keywords found (blocklist)</option>
                                            </select>
                                        </div>
                                    </>)}

                                    {selected.impl === 'length' && (<>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                            <div>
                                                <label style={lbl9}>Min Length (chars)</label>
                                                <input type="number" style={inp} value={selected.minLength} onChange={e => patch({ minLength: parseInt(e.target.value) || 0 })} />
                                            </div>
                                            <div>
                                                <label style={lbl9}>Max Length (chars)</label>
                                                <input type="number" style={inp} value={selected.maxLength} onChange={e => patch({ maxLength: parseInt(e.target.value) || 10000 })} />
                                            </div>
                                        </div>
                                    </>)}

                                    {selected.impl === 'llm' && (<>
                                        <div style={{ marginBottom: 10 }}>
                                            <label style={lbl9}>Judge Prompt <span style={{ color: '#456', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— use {'{{value}}'} as placeholder</span></label>
                                            <textarea rows={5} style={mono} value={selected.llmPrompt} onChange={e => patch({ llmPrompt: e.target.value })} />
                                        </div>
                                        <div>
                                            <label style={lbl9}>Pass Phrase <span style={{ color: '#456', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— LLM response must START with this to pass</span></label>
                                            <input style={inp} value={selected.llmPassPhrase} placeholder="NO, PASS, SAFE..." onChange={e => patch({ llmPassPhrase: e.target.value })} />
                                        </div>
                                    </>)}

                                    {selected.impl === 'schema' && (<>
                                        <label style={lbl9}>JSON Schema</label>
                                        <textarea rows={8} style={mono} value={selected.jsonSchema} onChange={e => patch({ jsonSchema: e.target.value })} />
                                    </>)}

                                    {selected.impl === 'script' && (<>
                                        <label style={lbl9}>
                                            JavaScript Body <span style={{ color: '#456', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— receives <code style={{ color: '#ce9178' }}>value</code>, must return <code style={{ color: '#4ec9b0' }}>true</code> (PASS) or <code style={{ color: '#f44747' }}>false</code> (FAIL)</span>
                                        </label>
                                        <textarea rows={10} style={mono} value={selected.scriptCode} onChange={e => patch({ scriptCode: e.target.value })} />
                                        <div style={{ marginTop: 6, fontSize: 10, color: '#555' }}>⚠️ Script runs in an isolated <code style={{ color: '#ce9178' }}>Function</code> context — no DOM or module access.</div>
                                    </>)}
                                </div>
                            </div>
                        )}

                        {/* ── ARGS SCHEMA ────────────────────────────────── */}
                        {activeSection === 'args' && (
                            <div style={panelBase}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                                    <div>
                                        <h3 style={{ margin: 0, fontSize: 12, fontWeight: 800, color: '#ccc', letterSpacing: 1, textTransform: 'uppercase' }}>Args Schema</h3>
                                        <p style={{ margin: '4px 0 0', fontSize: 11, color: '#555' }}>
                                            Define parameters users can configure when adding this validator to a Guard.
                                        </p>
                                    </div>
                                    <button onClick={addArg} style={btnP}>+ ADD PARAM</button>
                                </div>

                                {selected.argsSchema.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '30px 0', color: '#444', fontSize: 12 }}>
                                        No parameters defined. Click "+ ADD PARAM" to make this validator configurable.
                                    </div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                        {selected.argsSchema.map((arg, idx) => (
                                            <div key={idx} style={{ background: 'rgba(0,0,0,0.25)', borderRadius: 6, padding: 14 }}>
                                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 1fr 100px auto', gap: 10, alignItems: 'end' }}>
                                                    <div>
                                                        <label style={lbl9}>Key Name</label>
                                                        <input style={{ ...inp, fontFamily: 'monospace' }} value={arg.key} onChange={e => patchArg(idx, { key: e.target.value })} placeholder="param_name" />
                                                    </div>
                                                    <div>
                                                        <label style={lbl9}>Type</label>
                                                        <select style={sel} value={arg.type} onChange={e => patchArg(idx, { type: e.target.value as any })}>
                                                            {ARG_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                                                        </select>
                                                    </div>
                                                    <div>
                                                        <label style={lbl9}>Default Value</label>
                                                        <input style={inp} value={arg.default} onChange={e => patchArg(idx, { default: e.target.value })} placeholder="Default..." />
                                                    </div>
                                                    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', paddingBottom: 2 }}>
                                                        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: '#888', cursor: 'pointer' }}>
                                                            <input type="checkbox" checked={arg.required} onChange={e => patchArg(idx, { required: e.target.checked })} />
                                                            Required
                                                        </label>
                                                    </div>
                                                    <button onClick={() => removeArg(idx)} style={{ ...btnD, padding: '7px 10px' }}>✕</button>
                                                </div>
                                                <div style={{ marginTop: 8 }}>
                                                    <label style={lbl9}>Description</label>
                                                    <input style={inp} value={arg.description} placeholder="What does this parameter control?" onChange={e => patchArg(idx, { description: e.target.value })} />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {selected.argsSchema.length > 0 && (
                                    <div style={{ marginTop: 14, padding: '10px 14px', background: 'rgba(86,156,214,0.07)', border: '1px solid rgba(86,156,214,0.2)', borderRadius: 5 }}>
                                        <div style={{ fontSize: 9, fontWeight: 800, color: '#569cd6', letterSpacing: 1, marginBottom: 6 }}>PREVIEW — argsSchema in JSON</div>
                                        <pre style={{ margin: 0, fontSize: 10, color: '#ce9178', fontFamily: 'monospace', overflowX: 'auto' }}>
                                            {JSON.stringify(
                                                selected.argsSchema.reduce((acc: any, a) => { acc[a.key] = { type: a.type, description: a.description, default: a.default, required: a.required }; return acc; }, {}),
                                                null, 2
                                            )}
                                        </pre>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* ── TEST ──────────────────────────────────────── */}
                        {activeSection === 'test' && (
                            <div style={panelBase}>
                                <h3 style={{ margin: '0 0 14px', fontSize: 12, fontWeight: 800, color: '#ccc', letterSpacing: 1, textTransform: 'uppercase' }}>🧪 Test Validator</h3>

                                <div style={{ marginBottom: 12 }}>
                                    <label style={lbl9}>Sample Input</label>
                                    <textarea
                                        rows={4}
                                        style={{ ...mono, resize: 'vertical' }}
                                        placeholder="Enter text to run through this validator..."
                                        value={selected.testInput}
                                        onChange={e => patch({ testInput: e.target.value })}
                                    />
                                </div>

                                <button
                                    onClick={runTest}
                                    disabled={testRunning || !selected.testInput}
                                    style={{ ...btnP, opacity: testRunning || !selected.testInput ? 0.5 : 1, cursor: testRunning || !selected.testInput ? 'not-allowed' : 'pointer', marginBottom: 14 }}
                                >
                                    {testRunning ? '⟳ Running...' : '▶ RUN TEST'}
                                </button>

                                {testResult && (
                                    <div style={{
                                        padding: 16,
                                        borderRadius: 6,
                                        background: testResult.passed ? 'rgba(45,160,66,0.1)' : 'rgba(197,48,48,0.1)',
                                        border: `1px solid ${testResult.passed ? '#2da04233' : '#cc241d33'}`,
                                    }}>
                                        <div style={{ fontSize: 14, fontWeight: 800, color: testResult.passed ? '#2da042' : '#cc241d', marginBottom: 6 }}>
                                            {testResult.passed ? '✅ PASSED' : '❌ FAILED'}
                                        </div>
                                        <div style={{ fontSize: 12, color: testResult.passed ? '#7ec88e' : '#e06c75', fontFamily: 'monospace' }}>
                                            {testResult.message}
                                        </div>
                                    </div>
                                )}

                                {selected.impl === 'llm' && (
                                    <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(177,98,134,0.1)', border: '1px solid rgba(177,98,134,0.2)', borderRadius: 5, fontSize: 10, color: '#b16286' }}>
                                        🤖 LLM validators call the Tala runtime — test result depends on which inference provider is active.
                                        If no API is available the test will indicate as such.
                                    </div>
                                )}
                            </div>
                        )}

                        {/* ── EXPORT ────────────────────────────────────── */}
                        {activeSection === 'export' && (
                            <div style={panelBase}>
                                <h3 style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 800, color: '#ccc', letterSpacing: 1, textTransform: 'uppercase' }}>↑ Export as Python</h3>
                                <p style={{ margin: '0 0 16px', fontSize: 11, color: '#555' }}>
                                    Generates a <code style={{ color: '#ce9178' }}>guardrails-ai</code>-compatible Python validator class that you can register with <code style={{ color: '#ce9178' }}>@register_validator</code> and publish to the Hub.
                                </p>

                                {/* Python preview */}
                                <div style={{ background: '#0d0d0d', borderRadius: 6, padding: 14, border: '1px solid #222', marginBottom: 14, overflowX: 'auto' }}>
                                    <pre style={{ margin: 0, fontSize: 10, color: '#d4d4d4', fontFamily: 'monospace', lineHeight: 1.55 }}>
                                        {`from guardrails import Validator, register_validator
from guardrails.validators import PassResult, FailResult

@register_validator(name="${selected.name.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '')}", data_type="string")
class ${selected.name.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '')}(Validator):
    """${selected.description || selected.name}"""
    # impl: ${selected.impl} | category: ${selected.category}
    
    def validate(self, value, metadata):
        # ... ${selected.impl} implementation
        return PassResult()`}
                                    </pre>
                                </div>

                                <button onClick={exportPython} style={{ ...btnP, padding: '10px 22px', fontSize: 12 }}>
                                    ↓ DOWNLOAD validator_{selected.name.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}.py
                                </button>

                                <div style={{ marginTop: 16, padding: '12px 14px', background: 'rgba(0,122,204,0.07)', border: '1px solid rgba(0,122,204,0.2)', borderRadius: 5, fontSize: 11, color: '#569cd6' }}>
                                    <strong>To use with guardrails-ai:</strong><br />
                                    1. <code style={{ color: '#ce9178' }}>pip install guardrails-ai</code><br />
                                    2. Place the .py file in your project<br />
                                    3. Import and use: <code style={{ color: '#ce9178' }}>from validator_{selected.name.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()} import {selected.name.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '')}</code>
                                </div>
                            </div>
                        )}
                    </>)}
                </div>
            </div>

            {vbStatus && (
                <div style={{ marginTop: 14, padding: '10px 14px', background: 'rgba(78,201,176,0.1)', border: '1px solid rgba(78,201,176,0.3)', borderRadius: 4, color: '#4ec9b0', fontSize: 12 }}>
                    {vbStatus}
                </div>
            )}
        </div>
    );
}


