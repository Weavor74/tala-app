import { useMemo, useState, type CSSProperties } from 'react';
import type { StorageProviderRecord, StorageRegistrySnapshot, StorageRole } from '../../storage/storageTypes';
import {
    buildProviderConnectionLabel,
    mapAuthBadge,
    mapEnabledBadge,
    mapHealthBadge,
    mapLocalityBadge,
    mapRegistrationBadge,
} from '../../storage/StorageViewModels';

interface StorageProviderCardProps {
    provider: StorageProviderRecord;
    snapshot: StorageRegistrySnapshot;
    busy: boolean;
    onValidate: (providerId: string) => Promise<void>;
    onToggleEnabled: (providerId: string, enabled: boolean) => Promise<void>;
    onRemove: (providerId: string) => Promise<void>;
    onAssignRole: (providerId: string, role: StorageRole) => Promise<void>;
    onUpdateName: (providerId: string, name: string) => Promise<void>;
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

function chipStyle(): CSSProperties {
    return {
        fontSize: 11,
        color: '#bbb',
        border: '1px solid #444',
        borderRadius: 12,
        padding: '2px 8px',
    };
}

function getRoleLabel(role: StorageRole): string {
    return role.replace(/_/g, ' ');
}

const buildStorageProviderCard = ({
    provider,
    snapshot,
    busy,
    onValidate,
    onToggleEnabled,
    onRemove,
    onAssignRole,
    onUpdateName,
}: StorageProviderCardProps) => {
    const [editingName, setEditingName] = useState(false);
    const [draftName, setDraftName] = useState(provider.name);
    const [selectedRole, setSelectedRole] = useState<StorageRole | ''>('');

    const assignedByRole = useMemo(() => {
        const map = new Map<StorageRole, string>();
        for (const assignment of snapshot.assignments) {
            map.set(assignment.role, assignment.providerId);
        }
        return map;
    }, [snapshot.assignments]);

    const badges = {
        locality: mapLocalityBadge(provider.locality),
        registration: mapRegistrationBadge(provider.registrationMode),
        enabled: mapEnabledBadge(provider.enabled),
        health: mapHealthBadge(provider.health.status),
        auth: mapAuthBadge(provider.auth.status),
    };

    return (
        <div style={{ background: '#252526', border: '1px solid #3e3e42', borderRadius: 4, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                    {editingName ? (
                        <div style={{ display: 'flex', gap: 8 }}>
                            <input
                                value={draftName}
                                onChange={(event) => setDraftName(event.target.value)}
                                style={{
                                    flex: 1,
                                    background: '#121212',
                                    border: '1px solid #333',
                                    color: '#eee',
                                    padding: '8px 10px',
                                    fontSize: 12,
                                    borderRadius: 4,
                                }}
                            />
                            <button
                                disabled={busy || draftName.trim().length === 0}
                                onClick={async () => {
                                    await onUpdateName(provider.id, draftName.trim());
                                    setEditingName(false);
                                }}
                                style={{ background: '#007acc', border: 'none', color: '#fff', borderRadius: 4, padding: '0 10px', cursor: 'pointer' }}
                            >
                                Save
                            </button>
                            <button
                                disabled={busy}
                                onClick={() => {
                                    setDraftName(provider.name);
                                    setEditingName(false);
                                }}
                                style={{ background: '#2d2d2d', border: '1px solid #444', color: '#ccc', borderRadius: 4, padding: '0 10px', cursor: 'pointer' }}
                            >
                                Cancel
                            </button>
                        </div>
                    ) : (
                        <>
                            <div style={{ color: '#fff', fontWeight: 700, fontSize: 13 }}>{provider.name}</div>
                            <div style={{ color: '#aaa', fontSize: 11 }}>{provider.kind}</div>
                        </>
                    )}
                </div>

                {!editingName && (
                    <button
                        disabled={busy}
                        onClick={() => setEditingName(true)}
                        style={{ background: '#2d2d2d', border: '1px solid #444', color: '#ccc', borderRadius: 4, padding: '6px 10px', cursor: 'pointer', fontSize: 11 }}
                    >
                        Edit
                    </button>
                )}
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                <span style={badgeStyle(badges.locality.tone)}>{badges.locality.text}</span>
                <span style={badgeStyle(badges.registration.tone)}>{badges.registration.text}</span>
                <span style={badgeStyle(badges.enabled.tone)}>{badges.enabled.text}</span>
                <span style={badgeStyle(badges.health.tone)}>{badges.health.text}</span>
                <span style={badgeStyle(badges.auth.tone)}>{badges.auth.text}</span>
            </div>

            <div style={{ fontSize: 11, color: '#999', marginBottom: 10 }}>{buildProviderConnectionLabel(provider)}</div>

            <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 4 }}>Supported Roles</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {provider.supportedRoles.map((role) => (
                        <span key={`${provider.id}-supported-${role}`} style={chipStyle()}>{getRoleLabel(role)}</span>
                    ))}
                </div>
            </div>

            <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 4 }}>Assigned Roles</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {provider.assignedRoles.length === 0 && <span style={{ ...chipStyle(), color: '#777' }}>none</span>}
                    {provider.assignedRoles.map((role) => (
                        <span key={`${provider.id}-assigned-${role}`} style={{ ...chipStyle(), color: '#dcdcaa' }}>{getRoleLabel(role)}</span>
                    ))}
                </div>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                    disabled={busy}
                    onClick={async () => onValidate(provider.id)}
                    style={{ background: '#2d2d2d', border: '1px solid #444', color: '#ccc', borderRadius: 4, padding: '6px 10px', cursor: 'pointer', fontSize: 11 }}
                >
                    Validate
                </button>
                <button
                    disabled={busy}
                    onClick={async () => onToggleEnabled(provider.id, !provider.enabled)}
                    style={{ background: '#2d2d2d', border: '1px solid #444', color: '#ccc', borderRadius: 4, padding: '6px 10px', cursor: 'pointer', fontSize: 11 }}
                >
                    {provider.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                    disabled={busy}
                    onClick={async () => onRemove(provider.id)}
                    style={{ background: 'transparent', border: '1px solid #893535', color: '#ff9e9e', borderRadius: 4, padding: '6px 10px', cursor: 'pointer', fontSize: 11 }}
                >
                    Remove
                </button>

                <select
                    value={selectedRole}
                    disabled={busy}
                    onChange={(event) => setSelectedRole(event.target.value as StorageRole | '')}
                    style={{
                        minWidth: 180,
                        background: '#121212',
                        border: '1px solid #333',
                        color: '#eee',
                        padding: '7px 10px',
                        fontSize: 11,
                        borderRadius: 4,
                    }}
                >
                    <option value="">Assign Role...</option>
                    {provider.supportedRoles.map((role) => (
                        <option key={`${provider.id}-assign-option-${role}`} value={role}>
                            {getRoleLabel(role)}
                            {assignedByRole.get(role) === provider.id ? ' (assigned)' : ''}
                        </option>
                    ))}
                </select>
                <button
                    disabled={busy || !selectedRole}
                    onClick={async () => {
                        if (!selectedRole) return;
                        await onAssignRole(provider.id, selectedRole);
                        setSelectedRole('');
                    }}
                    style={{ background: '#007acc', border: 'none', color: '#fff', borderRadius: 4, padding: '6px 10px', cursor: 'pointer', fontSize: 11 }}
                >
                    Assign Role
                </button>
            </div>
        </div>
    );
};

export const BuildStorageProviderCard = buildStorageProviderCard;
