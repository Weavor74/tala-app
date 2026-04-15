import type { CSSProperties } from 'react';
import type { StorageProviderRecord, StorageRegistrySnapshot, StorageRole } from '../../storage/storageTypes';
import {
    buildRoleProviderOptions,
    buildRoleRows,
    mapAuthBadge,
    mapHealthBadge,
    mapLocalityBadge,
} from '../../storage/StorageViewModels';

interface StorageRoleAssignmentsCardProps {
    snapshot: StorageRegistrySnapshot;
    busy: boolean;
    onAssignRole: (providerId: string, role: StorageRole) => Promise<void>;
    onUnassignRole: (role: StorageRole) => Promise<void>;
}

function badgeStyle(tone: 'neutral' | 'good' | 'warn' | 'bad'): CSSProperties {
    const tones: Record<string, { border: string; color: string; background: string }> = {
        neutral: { border: '#555', color: '#aaa', background: '#242424' },
        good: { border: '#2e7d32', color: '#9be7a0', background: 'rgba(46,125,50,0.15)' },
        warn: { border: '#f57c00', color: '#ffd08a', background: 'rgba(245,124,0,0.15)' },
        bad: { border: '#b71c1c', color: '#ff9e9e', background: 'rgba(183,28,28,0.18)' },
    };

    return {
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.8px',
        textTransform: 'uppercase',
        padding: '3px 8px',
        borderRadius: 12,
        border: `1px solid ${tones[tone].border}`,
        color: tones[tone].color,
        background: tones[tone].background,
        display: 'inline-block',
        whiteSpace: 'nowrap',
    };
}

function roleSelectValue(role: StorageRole, providerId: string | null): string {
    if (!providerId) {
        return `__unassigned__:${role}`;
    }
    return providerId;
}

function sortProvidersForRole(snapshot: StorageRegistrySnapshot, role: StorageRole): StorageProviderRecord[] {
    return buildRoleProviderOptions(snapshot, role);
}

const buildStorageRoleAssignmentsCard = ({ snapshot, busy, onAssignRole, onUnassignRole }: StorageRoleAssignmentsCardProps) => {
    const rows = buildRoleRows(snapshot);

    return (
        <div style={{ background: '#1e1e1e', padding: 16, borderRadius: 6, border: '1px solid #3a3a3a', marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h4 style={{ margin: 0, color: '#dcdcaa', fontSize: 14 }}>Storage Registry Role Assignments</h4>
                <span style={{ fontSize: 11, color: '#888' }}>{snapshot.assignments.length} assigned</span>
            </div>

            <div style={{ display: 'grid', gap: 10 }}>
                {rows.map((row) => {
                    const localityBadge = mapLocalityBadge(row.locality);
                    const healthBadge = mapHealthBadge(row.health);
                    const authBadge = mapAuthBadge(row.auth);
                    const options = sortProvidersForRole(snapshot, row.role);

                    return (
                        <div key={row.role} style={{ background: '#252526', border: '1px solid #3e3e42', borderRadius: 4, padding: 10 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                <div>
                                    <div style={{ color: '#fff', fontWeight: 700, fontSize: 12 }}>{row.roleLabel}</div>
                                    <div style={{ color: '#bbb', fontSize: 12 }}>
                                        {row.assignedProviderName} {row.isAssigned ? `(${row.providerKind})` : ''}
                                    </div>
                                </div>

                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                    <span style={badgeStyle(localityBadge.tone)}>{localityBadge.text}</span>
                                    <span style={badgeStyle(healthBadge.tone)}>{healthBadge.text}</span>
                                    <span style={badgeStyle(authBadge.tone)}>{authBadge.text}</span>
                                </div>
                            </div>

                            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
                                <select
                                    aria-label={`assign-${row.role}`}
                                    disabled={busy}
                                    value={roleSelectValue(row.role, row.assignedProviderId)}
                                    onChange={async (event) => {
                                        const next = event.target.value;
                                        if (next.startsWith('__unassigned__:')) {
                                            await onUnassignRole(row.role);
                                            return;
                                        }
                                        await onAssignRole(next, row.role);
                                    }}
                                    style={{
                                        flex: 1,
                                        background: '#121212',
                                        border: '1px solid #333',
                                        color: '#eee',
                                        padding: '8px 10px',
                                        fontSize: 12,
                                        borderRadius: 4,
                                    }}
                                >
                                    <option value={`__unassigned__:${row.role}`}>Unassigned</option>
                                    {options.map((provider) => (
                                        <option key={`${row.role}-${provider.id}`} value={provider.id}>
                                            {provider.name} ({provider.kind})
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export const BuildStorageRoleAssignmentsCard = buildStorageRoleAssignmentsCard;
