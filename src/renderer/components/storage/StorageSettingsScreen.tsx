import { useCallback, useEffect, useMemo, useState } from 'react';
import { BuildStorageRoleAssignmentsCard } from './StorageRoleAssignmentsCard';
import { BuildStorageProviderRegistryCard } from './StorageProviderRegistryCard';
import { BuildStorageProviderWizard } from './StorageProviderWizard';
import { createStorageScreenService, type StorageScreenState } from '../../storage/StorageScreenModel';
import type {
    StorageBridge,
    StorageRegistrySnapshot,
    StorageRole,
} from '../../storage/storageTypes';
import { STORAGE_ROLES } from '../../storage/StorageViewModels';

function resolveBridge(): StorageBridge {
    const tala = (window as unknown as { tala?: { storage?: StorageBridge } }).tala;
    if (!tala?.storage) {
        throw new Error('Storage IPC bridge is unavailable.');
    }
    return tala.storage;
}

function getMissingAssignments(snapshot: StorageRegistrySnapshot): StorageRole[] {
    const assignedRoles = new Set(snapshot.assignments.map((assignment) => assignment.role));
    return STORAGE_ROLES.filter((role) => !assignedRoles.has(role));
}

const buildStorageSettingsScreen = () => {
    const model = useMemo(() => createStorageScreenService(resolveBridge()), []);
    const [state, setState] = useState(model.getState());

    const refreshFromModel = useCallback(() => {
        setState({ ...model.getState() });
    }, [model]);

    useEffect(() => {
        void model.loadSnapshot().then(() => refreshFromModel());
    }, [model, refreshFromModel]);

    const doAction = useCallback(async (fn: () => Promise<StorageScreenState>) => {
        await fn();
        refreshFromModel();
    }, [refreshFromModel]);

    const snapshot = state.snapshot;

    return (
        <div style={{ marginBottom: 30, animation: 'fadeIn 0.2s', background: 'rgba(30, 30, 30, 0.4)', padding: '20px', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.05)', backdropFilter: 'blur(10px)' }}>
            <h3 style={{ color: '#dcdcaa' }}>STORAGE REGISTRY</h3>
            <p style={{ fontSize: 12, opacity: 0.75, marginBottom: 16 }}>
                Backend-authoritative storage assignments and provider registry.
            </p>

            {state.loading && <div style={{ marginBottom: 10, color: '#9cdcfe', fontSize: 12 }}>Loading storage state...</div>}

            {!!state.actionMessage && (
                <div style={{ marginBottom: 10, padding: 10, borderRadius: 4, border: '1px solid #2e7d32', color: '#9be7a0', background: 'rgba(46,125,50,0.12)', fontSize: 12 }}>
                    {state.actionMessage}
                </div>
            )}

            {!!state.lastError && (
                <div style={{ marginBottom: 10, padding: 10, borderRadius: 4, border: '1px solid #b71c1c', color: '#ff9e9e', background: 'rgba(183,28,28,0.16)', fontSize: 12 }}>
                    <strong>{state.lastError.code}</strong>: {state.lastError.message}
                </div>
            )}

            {!snapshot && <div style={{ color: '#aaa', fontSize: 12 }}>Storage snapshot unavailable.</div>}

            {snapshot && (
                <>
                    <div style={{ marginBottom: 12, fontSize: 11, color: '#888' }}>
                        Snapshot v{snapshot.version} updated {snapshot.updatedAt}
                    </div>

                    {getMissingAssignments(snapshot).length > 0 && (
                        <div style={{ marginBottom: 14, padding: 10, borderRadius: 4, border: '1px solid #f57c00', color: '#ffd08a', background: 'rgba(245,124,0,0.12)', fontSize: 12 }}>
                            Missing assignments: {getMissingAssignments(snapshot).map((role) => role.replace(/_/g, ' ')).join(', ')}
                        </div>
                    )}

                    <BuildStorageRoleAssignmentsCard
                        snapshot={snapshot}
                        busy={state.loading}
                        onAssignRole={async (providerId, role) => {
                            await doAction(() => model.assignRole(providerId, role));
                        }}
                        onUnassignRole={async (role) => {
                            await doAction(() => model.unassignRole(role));
                        }}
                    />

                    <BuildStorageProviderRegistryCard
                        snapshot={snapshot}
                        busy={state.loading}
                        onDetectProviders={async () => {
                            await doAction(() => model.detectProviders());
                        }}
                        onValidateProvider={async (providerId) => {
                            await doAction(() => model.validateProvider(providerId));
                        }}
                        onToggleEnabled={async (providerId, enabled) => {
                            await doAction(() => model.setProviderEnabled(providerId, enabled));
                        }}
                        onRemoveProvider={async (providerId) => {
                            await doAction(() => model.removeProvider(providerId));
                        }}
                        onAssignRole={async (providerId, role) => {
                            await doAction(() => model.assignRole(providerId, role));
                        }}
                        onUpdateProviderName={async (providerId, name) => {
                            await doAction(() => model.updateProviderName(providerId, name));
                        }}
                    />

                    <BuildStorageProviderWizard
                        busy={state.loading}
                        snapshot={snapshot}
                        onAddProvider={async (request) => {
                            await doAction(() => model.addProvider(request));
                        }}
                        onValidateProvider={async (providerId) => {
                            await doAction(() => model.validateProvider(providerId));
                        }}
                        onAssignRole={async (providerId, role) => {
                            await doAction(() => model.assignRole(providerId, role));
                        }}
                    />

                    {Object.keys(state.validationByProviderId).length > 0 && (
                        <div style={{ marginTop: 14, background: '#1e1e1e', padding: 12, borderRadius: 6, border: '1px solid #3a3a3a' }}>
                            <h4 style={{ margin: 0, marginBottom: 8, color: '#dcdcaa', fontSize: 13 }}>Validation Results</h4>
                            <div style={{ display: 'grid', gap: 8 }}>
                                {Object.values(state.validationByProviderId).map((result) => (
                                    <div key={`validation-${result.providerId}`} style={{ padding: 8, border: '1px solid #3e3e42', borderRadius: 4, background: '#252526' }}>
                                        <div style={{ fontSize: 12, color: result.ok ? '#9be7a0' : '#ff9e9e', fontWeight: 700 }}>
                                            {result.providerId}: {result.ok ? 'OK' : 'FAILED'}
                                        </div>
                                        {result.warnings.length > 0 && (
                                            <div style={{ fontSize: 11, color: '#ffd08a', marginTop: 4 }}>
                                                Warnings: {result.warnings.join(' | ')}
                                            </div>
                                        )}
                                        {result.errors.length > 0 && (
                                            <div style={{ fontSize: 11, color: '#ff9e9e', marginTop: 4 }}>
                                                Errors: {result.errors.join(' | ')}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export const BuildStorageSettingsScreen = buildStorageSettingsScreen;
