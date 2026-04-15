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
import type {
    StorageAuthoritySummaryViewModel,
    StorageProviderVisibilityViewModel,
    StorageRoleVisibilityViewModel,
} from '../../storage/StorageViewModels';

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

function toneForHealth(state: StorageAuthoritySummaryViewModel['registryHealth']['state']): string {
    if (state === 'healthy') return '#9be7a0';
    if (state === 'degraded') return '#ffd08a';
    return '#ff9e9e';
}

function roleAssignmentTypeLabel(assignmentType: StorageRoleVisibilityViewModel['assignmentType']): string {
    if (assignmentType === 'explicit') return 'explicit';
    if (assignmentType === 'bootstrap') return 'bootstrap';
    if (assignmentType === 'inferred') return 'inferred';
    return 'unassigned';
}

function providerOriginLabel(origin: StorageProviderVisibilityViewModel['origin']): string {
    if (origin === 'explicit_registry') return 'explicit registry';
    if (origin === 'bootstrapped_legacy') return 'bootstrapped legacy';
    return 'detected';
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
                Canonical Storage Registry configuration for Provider and Role assignments.
            </p>

            {state.loading && <div style={{ marginBottom: 10, color: '#9cdcfe', fontSize: 12 }}>Loading Storage Registry state...</div>}

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

            {!snapshot && <div style={{ color: '#aaa', fontSize: 12 }}>Storage Registry snapshot unavailable.</div>}

            {snapshot && (
                <>
                    <div style={{ marginBottom: 12, fontSize: 11, color: '#888' }}>
                        Storage Registry snapshot v{snapshot.version} updated {snapshot.updatedAt}
                    </div>

                    {state.authoritySummary && (
                        <div style={{ marginBottom: 14, background: '#1e1e1e', padding: 12, borderRadius: 6, border: '1px solid #3a3a3a' }}>
                            <h4 style={{ margin: 0, marginBottom: 8, color: '#dcdcaa', fontSize: 13 }}>Storage Authority Summary</h4>
                            <div style={{ fontSize: 12, color: '#ddd', marginBottom: 4 }}>
                                Canonical Runtime Authority: {state.authoritySummary.canonicalRuntimeAuthority.providerName}
                            </div>
                            <div style={{ fontSize: 12, color: '#bbb', marginBottom: 4 }}>
                                Derived Providers: {state.authoritySummary.derivedProviders.length}
                            </div>
                            <div style={{ fontSize: 12, color: toneForHealth(state.authoritySummary.registryHealth.state), marginBottom: 4 }}>
                                Registry Health: {state.authoritySummary.registryHealth.state.toUpperCase()}
                            </div>
                            <div style={{ fontSize: 12, color: '#bbb', marginBottom: 6 }}>
                                Bootstrap: {state.authoritySummary.bootstrapState.bootstrappedProviderCount} bootstrapped, {state.authoritySummary.bootstrapState.detectedProviderCount} detected, {state.authoritySummary.bootstrapState.explicitRegistryProviderCount} explicit
                            </div>
                            {state.authoritySummary.authorityState.reasons.length > 0 && (
                                <div style={{ fontSize: 11, color: '#ffd08a' }}>
                                    Authority State: {state.authoritySummary.authorityState.reasons.join(' | ')}
                                </div>
                            )}
                        </div>
                    )}

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

                    {Object.keys(state.providerVisibilityById).length > 0 && (
                        <div style={{ marginTop: 14, background: '#1e1e1e', padding: 12, borderRadius: 6, border: '1px solid #3a3a3a' }}>
                            <h4 style={{ margin: 0, marginBottom: 8, color: '#dcdcaa', fontSize: 13 }}>Provider Visibility (Authority, Origin, Validation)</h4>
                            <div style={{ display: 'grid', gap: 8 }}>
                                {Object.values(state.providerVisibilityById).map((provider) => (
                                    <div key={`provider-visibility-${provider.providerId}`} style={{ padding: 8, border: '1px solid #3e3e42', borderRadius: 4, background: '#252526' }}>
                                        <div style={{ fontSize: 12, color: '#fff', fontWeight: 700 }}>
                                            {provider.providerName} ({provider.providerType})
                                        </div>
                                        <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
                                            status: {provider.status.reachable} | auth: {provider.status.auth} | capable: {provider.status.capable ? 'yes' : 'no'}
                                        </div>
                                        <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
                                            authority: {provider.authorityClass} | origin: {providerOriginLabel(provider.origin)}
                                        </div>
                                        <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
                                            roles: {provider.assignedRoles.length > 0 ? provider.assignedRoles.join(', ') : 'none'}
                                        </div>
                                        <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
                                            capabilities: {provider.capabilities.length > 0 ? provider.capabilities.join(', ') : 'none'}
                                        </div>
                                        <div style={{ fontSize: 11, color: provider.validation.status === 'failed' ? '#ff9e9e' : (provider.validation.status === 'warn' ? '#ffd08a' : (provider.validation.status === 'passed' ? '#9be7a0' : '#bbb')), marginTop: 2 }}>
                                            validation: {provider.validation.status}
                                            {provider.validation.errors.length > 0 ? ` | errors: ${provider.validation.errors.join(' | ')}` : ''}
                                            {provider.validation.warnings.length > 0 ? ` | warnings: ${provider.validation.warnings.join(' | ')}` : ''}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {state.roleVisibility.length > 0 && (
                        <div style={{ marginTop: 14, background: '#1e1e1e', padding: 12, borderRadius: 6, border: '1px solid #3a3a3a' }}>
                            <h4 style={{ margin: 0, marginBottom: 8, color: '#dcdcaa', fontSize: 13 }}>Role Visibility (Assignment Reasoning)</h4>
                            <div style={{ display: 'grid', gap: 8 }}>
                                {state.roleVisibility.map((role) => (
                                    <div key={`role-visibility-${role.role}`} style={{ padding: 8, border: '1px solid #3e3e42', borderRadius: 4, background: '#252526' }}>
                                        <div style={{ fontSize: 12, color: '#fff', fontWeight: 700 }}>
                                            {role.roleLabel}: {role.assignedProvider.providerName}
                                        </div>
                                        <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
                                            assignment type: {roleAssignmentTypeLabel(role.assignmentType)}
                                        </div>
                                        <div style={{ fontSize: 11, color: '#9cdcfe', marginTop: 2 }}>
                                            reason code: {role.decisionReasonCode ?? 'none'}
                                        </div>
                                        <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
                                            eligibility: {role.eligibilityReasoning.join(' | ')}
                                        </div>
                                        <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
                                            blocked alternatives: {role.blockedAlternatives.length}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {(snapshot.assignmentDecisions?.length ?? 0) > 0 && (
                        <div style={{ marginTop: 14, background: '#1e1e1e', padding: 12, borderRadius: 6, border: '1px solid #3a3a3a' }}>
                            <h4 style={{ margin: 0, marginBottom: 8, color: '#dcdcaa', fontSize: 13 }}>Assignment Decision Log</h4>
                            <div style={{ display: 'grid', gap: 8 }}>
                                {[...(snapshot.assignmentDecisions ?? [])].slice(-8).reverse().map((decision, index) => (
                                    <div key={`assignment-decision-${decision.timestamp}-${index}`} style={{ padding: 8, border: '1px solid #3e3e42', borderRadius: 4, background: '#252526', fontSize: 11, color: '#bbb' }}>
                                        {decision.role} | {decision.outcome} | {decision.reasonCode} | provider: {decision.providerId ?? 'none'}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

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
                            <h4 style={{ margin: 0, marginBottom: 8, color: '#dcdcaa', fontSize: 13 }}>Validation (Layered Checks)</h4>
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
                                        <div style={{ fontSize: 11, color: '#bbb', marginTop: 4 }}>
                                            Validation Layers: {Object.entries(result.layeredValidation.dimensions)
                                                .map(([dimension, detail]) => `${dimension}=${detail.status}(${detail.reasonCode})`)
                                                .join(' | ')}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {state.lastAssignmentExplanation && (
                        <div style={{ marginTop: 14, background: '#1e1e1e', padding: 12, borderRadius: 6, border: '1px solid #3a3a3a' }}>
                            <h4 style={{ margin: 0, marginBottom: 8, color: '#dcdcaa', fontSize: 13 }}>Assignment Explanation</h4>
                            <div style={{ fontSize: 12, color: state.lastAssignmentExplanation.outcome === 'succeeded' ? '#9be7a0' : '#ff9e9e', fontWeight: 700 }}>
                                {state.lastAssignmentExplanation.outcome.toUpperCase()} - {state.lastAssignmentExplanation.role}
                            </div>
                            <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
                                provider: {state.lastAssignmentExplanation.provider.providerName}
                            </div>
                            <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
                                reason: {state.lastAssignmentExplanation.reasonCode} | {state.lastAssignmentExplanation.reasonSummary}
                            </div>
                            <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
                                eligibility: {state.lastAssignmentExplanation.eligibilityReasoning.join(' | ')}
                            </div>
                            <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
                                blocked alternatives: {state.lastAssignmentExplanation.blockedAlternatives.length}
                            </div>
                            <div style={{ fontSize: 11, color: '#9cdcfe', marginTop: 2 }}>
                                next steps: {state.lastAssignmentExplanation.nextSteps.join(' | ')}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export const BuildStorageSettingsScreen = buildStorageSettingsScreen;
