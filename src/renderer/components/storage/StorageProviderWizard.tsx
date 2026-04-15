import { useMemo, useState } from 'react';
import type {
    StorageAddProviderRequest,
    StorageAuthMode,
    StorageLocality,
    StorageProviderKind,
    StorageRegistrySnapshot,
    StorageRole,
    StorageWizardDraft,
} from '../../storage/storageTypes';

const providerKindOptions: Array<{ kind: StorageProviderKind; label: string }> = [
    { kind: 'filesystem', label: 'Filesystem' },
    { kind: 'postgresql', label: 'PostgreSQL' },
    { kind: 'supabase', label: 'Supabase' },
    { kind: 'chromadb', label: 'ChromaDB' },
    { kind: 's3', label: 'S3' },
    { kind: 'google_drive', label: 'Google Drive' },
    { kind: 'sharepoint', label: 'SharePoint' },
    { kind: 'gist', label: 'Gist' },
    { kind: 'sqlite', label: 'SQLite' },
];

const defaultRoleList: StorageRole[] = [
    'canonical_memory',
    'vector_index',
    'blob_store',
    'document_store',
    'backup_target',
    'artifact_store',
];

function normalizeValue(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, '-');
}

function buildFingerprint(draft: StorageWizardDraft): string {
    const endpoint = normalizeValue(draft.connection.endpoint || '');
    const path = normalizeValue(draft.connection.workspaceRelativePath || draft.connection.path || '');
    const database = normalizeValue(draft.connection.database || '');

    if (draft.kind === 'postgresql') {
        return `${endpoint || 'localhost'}:${database || 'tala'}`;
    }
    if (draft.kind === 'filesystem' || draft.kind === 'sqlite') {
        return path || 'data-storage';
    }
    if (draft.kind === 'chromadb') {
        return endpoint || path || 'http://127.0.0.1:8000';
    }

    return endpoint || path || `${draft.kind}-manual`;
}

function buildProviderId(draft: StorageWizardDraft): string {
    return `${draft.kind}:${buildFingerprint(draft)}`;
}

function buildDefaultDraft(): StorageWizardDraft {
    return {
        id: '',
        name: 'Filesystem Storage',
        kind: 'filesystem',
        locality: 'local',
        registrationMode: 'manual',
        connection: {
            workspaceRelativePath: 'data/storage',
            path: 'data/storage',
        },
        authMode: 'none',
        assignRoles: [],
        enabled: true,
    };
}

function getAuthModeForKind(kind: StorageProviderKind): StorageAuthMode {
    if (kind === 'supabase' || kind === 's3' || kind === 'gist') return 'api_key';
    if (kind === 'google_drive' || kind === 'sharepoint') return 'oauth';
    if (kind === 'postgresql') return 'basic';
    return 'none';
}

function getDefaultLocality(kind: StorageProviderKind): StorageLocality {
    if (kind === 'filesystem' || kind === 'postgresql' || kind === 'chromadb' || kind === 'sqlite') {
        return 'local';
    }
    return 'remote';
}

function getSetupText(kind: StorageProviderKind): string {
    if (kind === 'supabase' || kind === 's3' || kind === 'google_drive' || kind === 'sharepoint' || kind === 'gist') {
        return 'Remote provider setup is configuration-only for now. Validation may return needs_setup or unauthenticated.';
    }
    return 'This provider can be locally validated through backend health/auth probes.';
}

interface StorageProviderWizardProps {
    busy: boolean;
    snapshot: StorageRegistrySnapshot | null;
    onAddProvider: (request: StorageAddProviderRequest) => Promise<void>;
    onValidateProvider: (providerId: string) => Promise<void>;
    onAssignRole: (providerId: string, role: StorageRole) => Promise<void>;
}

const buildStorageProviderWizard = ({ busy, snapshot, onAddProvider, onValidateProvider, onAssignRole }: StorageProviderWizardProps) => {
    const [step, setStep] = useState(1);
    const [draft, setDraft] = useState<StorageWizardDraft>(buildDefaultDraft());
    const [createdProviderId, setCreatedProviderId] = useState<string | null>(null);

    const createdProvider = useMemo(() => {
        if (!createdProviderId || !snapshot) return null;
        return snapshot.providers.find((provider) => provider.id === createdProviderId) || null;
    }, [createdProviderId, snapshot]);

    function updateDraft(patch: Partial<StorageWizardDraft>): void {
        setDraft((prev) => ({ ...prev, ...patch }));
    }

    function updateConnection(field: keyof StorageWizardDraft['connection'], value: string): void {
        setDraft((prev) => ({
            ...prev,
            connection: {
                ...prev.connection,
                [field]: value,
            },
        }));
    }

    function resetFlow(): void {
        setStep(1);
        setDraft(buildDefaultDraft());
        setCreatedProviderId(null);
    }

    async function handleAddProvider(): Promise<void> {
        const providerId = draft.id.trim() || buildProviderId(draft);
        const request: StorageAddProviderRequest = {
            id: providerId,
            name: draft.name.trim() || providerId,
            kind: draft.kind,
            locality: draft.locality,
            registrationMode: draft.registrationMode,
            enabled: draft.enabled,
            connection: {
                ...draft.connection,
                path: draft.connection.path || draft.connection.workspaceRelativePath,
            },
            auth: {
                mode: draft.authMode,
                status: draft.authMode === 'none' ? 'not_required' : 'unauthenticated',
                lastCheckedAt: null,
                reason: null,
            },
            health: {
                status: 'unknown',
                checkedAt: null,
                reason: null,
            },
        };

        await onAddProvider(request);
        setCreatedProviderId(providerId);
    }

    const supportedRoleChoices = createdProvider?.supportedRoles || [];

    return (
        <div style={{ background: '#1e1e1e', padding: 16, borderRadius: 6, border: '1px solid #3a3a3a' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h4 style={{ margin: 0, color: '#dcdcaa', fontSize: 14 }}>Add Provider</h4>
                <span style={{ fontSize: 11, color: '#888' }}>Step {step} of 6</span>
            </div>

            {step === 1 && (
                <div>
                    <label style={{ display: 'block', color: '#999', fontSize: 10, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>Provider Kind</label>
                    <select
                        value={draft.kind}
                        onChange={(event) => {
                            const nextKind = event.target.value as StorageProviderKind;
                            updateDraft({
                                kind: nextKind,
                                locality: getDefaultLocality(nextKind),
                                authMode: getAuthModeForKind(nextKind),
                                name: providerKindOptions.find((opt) => opt.kind === nextKind)?.label || nextKind,
                            });
                        }}
                        style={{ width: '100%', background: '#121212', border: '1px solid #333', color: '#eee', padding: '10px', borderRadius: 4 }}
                    >
                        {providerKindOptions.map((option) => (
                            <option key={option.kind} value={option.kind}>{option.label}</option>
                        ))}
                    </select>
                </div>
            )}

            {step === 2 && (
                <div style={{ display: 'grid', gap: 12 }}>
                    <div>
                        <label style={{ display: 'block', color: '#999', fontSize: 10, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>Registration Mode</label>
                        <select
                            value={draft.registrationMode}
                            onChange={(event) => updateDraft({ registrationMode: event.target.value as StorageWizardDraft['registrationMode'] })}
                            style={{ width: '100%', background: '#121212', border: '1px solid #333', color: '#eee', padding: '10px', borderRadius: 4 }}
                        >
                            <option value="manual">Manual Config</option>
                            <option value="auto_discovered">Detect Local</option>
                        </select>
                    </div>

                    <div>
                        <label style={{ display: 'block', color: '#999', fontSize: 10, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>Locality</label>
                        <select
                            value={draft.locality}
                            onChange={(event) => updateDraft({ locality: event.target.value as StorageLocality })}
                            style={{ width: '100%', background: '#121212', border: '1px solid #333', color: '#eee', padding: '10px', borderRadius: 4 }}
                        >
                            <option value="local">Local</option>
                            <option value="remote">Remote</option>
                            <option value="hybrid">Hybrid</option>
                        </select>
                    </div>
                </div>
            )}

            {step === 3 && (
                <div style={{ display: 'grid', gap: 10 }}>
                    <div>
                        <label style={{ display: 'block', color: '#999', fontSize: 10, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>Provider Name</label>
                        <input
                            value={draft.name}
                            onChange={(event) => updateDraft({ name: event.target.value })}
                            style={{ width: '100%', background: '#121212', border: '1px solid #333', color: '#eee', padding: '10px', borderRadius: 4 }}
                        />
                    </div>

                    <div>
                        <label style={{ display: 'block', color: '#999', fontSize: 10, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>Provider ID (optional)</label>
                        <input
                            value={draft.id}
                            onChange={(event) => updateDraft({ id: event.target.value })}
                            placeholder={`Auto: ${buildProviderId(draft)}`}
                            style={{ width: '100%', background: '#121212', border: '1px solid #333', color: '#eee', padding: '10px', borderRadius: 4 }}
                        />
                    </div>

                    {(draft.kind === 'filesystem' || draft.kind === 'sqlite' || draft.kind === 'chromadb') && (
                        <div>
                            <label style={{ display: 'block', color: '#999', fontSize: 10, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>Path</label>
                            <input
                                value={draft.connection.path || ''}
                                onChange={(event) => updateConnection('path', event.target.value)}
                                placeholder="data/storage"
                                style={{ width: '100%', background: '#121212', border: '1px solid #333', color: '#eee', padding: '10px', borderRadius: 4 }}
                            />
                        </div>
                    )}

                    {(draft.kind === 'postgresql' || draft.kind === 'chromadb' || draft.locality !== 'local') && (
                        <div>
                            <label style={{ display: 'block', color: '#999', fontSize: 10, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>Endpoint</label>
                            <input
                                value={draft.connection.endpoint || ''}
                                onChange={(event) => updateConnection('endpoint', event.target.value)}
                                placeholder={draft.kind === 'postgresql' ? 'localhost:5432' : 'http://127.0.0.1:8000'}
                                style={{ width: '100%', background: '#121212', border: '1px solid #333', color: '#eee', padding: '10px', borderRadius: 4 }}
                            />
                        </div>
                    )}

                    {draft.kind === 'postgresql' && (
                        <div>
                            <label style={{ display: 'block', color: '#999', fontSize: 10, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>Database</label>
                            <input
                                value={draft.connection.database || ''}
                                onChange={(event) => updateConnection('database', event.target.value)}
                                placeholder="tala"
                                style={{ width: '100%', background: '#121212', border: '1px solid #333', color: '#eee', padding: '10px', borderRadius: 4 }}
                            />
                        </div>
                    )}
                </div>
            )}

            {step === 4 && (
                <div style={{ display: 'grid', gap: 10 }}>
                    <div>
                        <label style={{ display: 'block', color: '#999', fontSize: 10, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>Auth Mode</label>
                        <select
                            value={draft.authMode}
                            onChange={(event) => updateDraft({ authMode: event.target.value as StorageAuthMode })}
                            style={{ width: '100%', background: '#121212', border: '1px solid #333', color: '#eee', padding: '10px', borderRadius: 4 }}
                        >
                            <option value="none">None</option>
                            <option value="basic">Basic</option>
                            <option value="api_key">API Key</option>
                            <option value="oauth">OAuth</option>
                        </select>
                    </div>

                    <p style={{ margin: 0, fontSize: 12, color: '#aaa' }}>{getSetupText(draft.kind)}</p>
                </div>
            )}

            {step === 5 && (
                <div style={{ display: 'grid', gap: 10 }}>
                    {!createdProviderId ? (
                        <button
                            disabled={busy}
                            onClick={handleAddProvider}
                            style={{ background: '#007acc', border: 'none', color: '#fff', borderRadius: 4, padding: '10px 12px', cursor: 'pointer', fontWeight: 700 }}
                        >
                            Add Provider
                        </button>
                    ) : (
                        <>
                            <div style={{ fontSize: 12, color: '#9be7a0' }}>Provider created: {createdProviderId}</div>
                            <button
                                disabled={busy}
                                onClick={async () => onValidateProvider(createdProviderId)}
                                style={{ background: '#2d2d2d', border: '1px solid #444', color: '#ccc', borderRadius: 4, padding: '10px 12px', cursor: 'pointer', fontWeight: 700 }}
                            >
                                Validate Provider
                            </button>
                        </>
                    )}
                </div>
            )}

            {step === 6 && (
                <div style={{ display: 'grid', gap: 8 }}>
                    {!createdProviderId && <div style={{ fontSize: 12, color: '#aaa' }}>Complete step 5 before role assignment.</div>}
                    {createdProviderId && (
                        <>
                            <div style={{ fontSize: 12, color: '#bbb' }}>Assign optional roles for {createdProviderId}</div>
                            {(supportedRoleChoices.length > 0 ? supportedRoleChoices : defaultRoleList).map((role) => (
                                <label key={`wizard-role-${role}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#ddd' }}>
                                    <input
                                        type="checkbox"
                                        checked={draft.assignRoles.includes(role)}
                                        onChange={(event) => {
                                            const nextRoles = event.target.checked
                                                ? [...draft.assignRoles, role]
                                                : draft.assignRoles.filter((item) => item !== role);
                                            updateDraft({ assignRoles: nextRoles });
                                        }}
                                    />
                                    {role.replace(/_/g, ' ')}
                                </label>
                            ))}
                            <button
                                disabled={busy || !createdProviderId}
                                onClick={async () => {
                                    if (!createdProviderId) return;
                                    for (const role of draft.assignRoles) {
                                        // deterministic sequential assignment
                                        // eslint-disable-next-line no-await-in-loop
                                        await onAssignRole(createdProviderId, role);
                                    }
                                }}
                                style={{ background: '#007acc', border: 'none', color: '#fff', borderRadius: 4, padding: '10px 12px', cursor: 'pointer', fontWeight: 700 }}
                            >
                                Apply Role Assignments
                            </button>
                        </>
                    )}
                </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14 }}>
                <button
                    disabled={busy || step === 1}
                    onClick={() => setStep((prev) => Math.max(1, prev - 1))}
                    style={{ background: '#2d2d2d', border: '1px solid #444', color: '#ccc', borderRadius: 4, padding: '8px 12px', cursor: 'pointer' }}
                >
                    Back
                </button>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button
                        disabled={busy}
                        onClick={resetFlow}
                        style={{ background: 'transparent', border: '1px solid #555', color: '#aaa', borderRadius: 4, padding: '8px 12px', cursor: 'pointer' }}
                    >
                        Reset
                    </button>
                    <button
                        disabled={busy || step === 6}
                        onClick={() => setStep((prev) => Math.min(6, prev + 1))}
                        style={{ background: '#2d2d2d', border: '1px solid #444', color: '#ccc', borderRadius: 4, padding: '8px 12px', cursor: 'pointer' }}
                    >
                        Next
                    </button>
                </div>
            </div>
        </div>
    );
};

export const BuildStorageProviderWizard = buildStorageProviderWizard;
