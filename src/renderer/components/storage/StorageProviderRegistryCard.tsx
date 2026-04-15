import type { StorageProviderRecord, StorageRegistrySnapshot, StorageRole } from '../../storage/storageTypes';
import { BuildStorageProviderCard } from './StorageProviderCard';

interface StorageProviderRegistryCardProps {
    snapshot: StorageRegistrySnapshot;
    busy: boolean;
    onDetectProviders: () => Promise<void>;
    onValidateProvider: (providerId: string) => Promise<void>;
    onToggleEnabled: (providerId: string, enabled: boolean) => Promise<void>;
    onRemoveProvider: (providerId: string) => Promise<void>;
    onAssignRole: (providerId: string, role: StorageRole) => Promise<void>;
    onUpdateProviderName: (providerId: string, name: string) => Promise<void>;
}

function sortProviders(providers: StorageProviderRecord[]): StorageProviderRecord[] {
    return [...providers].sort((a, b) => a.name.localeCompare(b.name));
}

const buildStorageProviderRegistryCard = ({
    snapshot,
    busy,
    onDetectProviders,
    onValidateProvider,
    onToggleEnabled,
    onRemoveProvider,
    onAssignRole,
    onUpdateProviderName,
}: StorageProviderRegistryCardProps) => {
    const providers = sortProviders(snapshot.providers);

    return (
        <div style={{ background: '#1e1e1e', padding: 16, borderRadius: 6, border: '1px solid #3a3a3a', marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h4 style={{ margin: 0, color: '#dcdcaa', fontSize: 14 }}>Storage Registry Providers</h4>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: '#888' }}>{providers.length} total</span>
                    <button
                        disabled={busy}
                        onClick={async () => onDetectProviders()}
                        style={{ background: '#2d2d2d', border: '1px solid #444', color: '#ccc', borderRadius: 4, padding: '6px 10px', cursor: 'pointer', fontSize: 11 }}
                    >
                        Hydrate Registry (Local)
                    </button>
                </div>
            </div>

            <div style={{ display: 'grid', gap: 10 }}>
                {providers.map((provider) => (
                    <BuildStorageProviderCard
                        key={provider.id}
                        provider={provider}
                        snapshot={snapshot}
                        busy={busy}
                        onValidate={onValidateProvider}
                        onToggleEnabled={onToggleEnabled}
                        onRemove={onRemoveProvider}
                        onAssignRole={onAssignRole}
                        onUpdateName={onUpdateProviderName}
                    />
                ))}
            </div>
        </div>
    );
};

export const BuildStorageProviderRegistryCard = buildStorageProviderRegistryCard;
