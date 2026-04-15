import { describe, expect, it, vi } from 'vitest';
import { createStorageScreenService } from '../../src/renderer/storage/StorageScreenModel';
import {
    buildAssignmentFailureExplanation,
    buildAssignmentSuccessExplanation,
    buildProviderVisibilityModels,
    buildRoleProviderOptions,
    buildRoleRows,
    buildRoleVisibilityModels,
    buildStorageAuthoritySummary,
    mapAuthBadge,
    mapHealthBadge,
    mapLocalityBadge,
} from '../../src/renderer/storage/StorageViewModels';
import type {
    StorageBridge,
    StorageRegistrySnapshot,
    StorageValidateProviderResponse,
} from '../../src/renderer/storage/storageTypes';

function makeLayeredValidation(overall: 'pass' | 'warn' | 'fail' = 'pass') {
    return {
        overallStatus: overall,
        dimensions: {
            config_schema: { status: 'pass', reasonCode: 'config_schema_valid' },
            authentication: { status: 'pass', reasonCode: 'authentication_valid' },
            reachability: { status: 'pass', reasonCode: 'reachability_reachable' },
            capability_compatibility: { status: 'pass', reasonCode: 'capability_compatible' },
            role_eligibility: { status: 'pass', reasonCode: 'role_eligible' },
            policy_compliance: { status: 'pass', reasonCode: 'policy_compliant' },
            authority_conflicts: { status: 'pass', reasonCode: 'authority_consistent' },
            bootstrap_migration_consistency: { status: 'pass', reasonCode: 'bootstrap_consistent' },
            recoverability: { status: overall === 'fail' ? 'warn' : 'pass', reasonCode: 'recoverable_state' },
        },
        classification: {
            validButNotEligible: false,
            reachableButUnauthorized: false,
            configuredButPolicyBlocked: false,
            canonicalConflictState: false,
        },
    };
}

function makeSnapshot(overrides: Partial<StorageRegistrySnapshot> = {}): StorageRegistrySnapshot {
    return {
        version: 1,
        updatedAt: '2026-04-14T12:00:00.000Z',
        providers: [],
        assignments: [],
        ...overrides,
    };
}

function makeBridge(overrides: Partial<StorageBridge>): StorageBridge {
    const emptySnapshot = makeSnapshot();
    return {
        getSnapshot: vi.fn(async () => emptySnapshot),
        detectProviders: vi.fn(async () => ({ ok: true, detectedProviders: [], snapshot: emptySnapshot })),
        addProvider: vi.fn(async () => ({ ok: true, snapshot: emptySnapshot, changed: {} as any })),
        updateProvider: vi.fn(async () => ({ ok: true, snapshot: emptySnapshot, changed: {} as any })),
        removeProvider: vi.fn(async () => ({ ok: true, snapshot: emptySnapshot, changed: { providerId: 'x' } })),
        validateProvider: vi.fn(async () => ({
            ok: true,
            result: {
                providerId: 'x',
                ok: true,
                health: { status: 'healthy', checkedAt: null, reason: null },
                auth: { mode: 'none', status: 'not_required', lastCheckedAt: null, reason: null },
                detectedRolesSupported: [],
                detectedCapabilities: [],
                warnings: [],
                errors: [],
                layeredValidation: makeLayeredValidation(),
            },
            snapshot: emptySnapshot,
        })),
        assignRole: vi.fn(async () => ({ ok: true, snapshot: emptySnapshot, changed: { role: 'canonical_memory', providerId: 'x', assignedAt: 't' } })),
        unassignRole: vi.fn(async () => ({ ok: true, snapshot: emptySnapshot, changed: { role: 'canonical_memory' } })),
        setProviderEnabled: vi.fn(async () => ({ ok: true, snapshot: emptySnapshot, changed: { providerId: 'x', enabled: true } })),
        ...overrides,
    };
}

describe('Storage renderer model', () => {
    it('screen loads snapshot and renders role assignments', async () => {
        const snapshot = makeSnapshot({
            providers: [
                {
                    id: 'pg-main',
                    name: 'Postgres Main',
                    kind: 'postgresql',
                    locality: 'local',
                    registrationMode: 'manual',
                    supportedRoles: ['canonical_memory', 'document_store'],
                    capabilities: ['structured_records', 'document_storage'],
                    enabled: true,
                    connection: { endpoint: 'localhost:5432', database: 'tala' },
                    auth: { mode: 'basic', status: 'authenticated', lastCheckedAt: null, reason: null },
                    health: { status: 'healthy', checkedAt: null, reason: null },
                    assignedRoles: ['canonical_memory'],
                    createdAt: '2026-04-14T12:00:00.000Z',
                    updatedAt: '2026-04-14T12:00:00.000Z',
                },
            ],
            assignments: [{ role: 'canonical_memory', providerId: 'pg-main', assignedAt: '2026-04-14T12:00:00.000Z' }],
        });
        const bridge = makeBridge({ getSnapshot: vi.fn(async () => snapshot) });
        const model = createStorageScreenService(bridge);

        await model.loadSnapshot();
        const state = model.getState();
        const rows = buildRoleRows(state.snapshot!);

        expect(state.snapshot?.providers).toHaveLength(1);
        expect(rows.find((row) => row.role === 'canonical_memory')?.assignedProviderName).toBe('Postgres Main');
        expect(state.authoritySummary?.canonicalRuntimeAuthority.providerId).toBe('pg-main');
        expect(state.providerVisibilityById['pg-main']?.authorityClass).toBe('canonical');
        expect(state.roleVisibility.find((item) => item.role === 'canonical_memory')?.assignmentType).toBe('explicit');
    });

    it('providers render with correct badges and states', () => {
        expect(mapHealthBadge('healthy')).toEqual({ text: 'HEALTHY', tone: 'good' });
        expect(mapHealthBadge('offline')).toEqual({ text: 'OFFLINE', tone: 'bad' });
        expect(mapAuthBadge('unauthenticated')).toEqual({ text: 'UNAUTHENTICATED', tone: 'warn' });
        expect(mapLocalityBadge('local')).toEqual({ text: 'LOCAL', tone: 'good' });
    });

    it('validate action triggers IPC and refreshes state', async () => {
        const validatedSnapshot = makeSnapshot({
            providers: [
                {
                    id: 'filesystem:data/storage',
                    name: 'Filesystem Storage',
                    kind: 'filesystem',
                    locality: 'local',
                    registrationMode: 'auto_discovered',
                    supportedRoles: ['blob_store', 'artifact_store', 'backup_target'],
                    capabilities: ['blob_storage'],
                    enabled: true,
                    connection: { path: 'data/storage' },
                    auth: { mode: 'none', status: 'not_required', lastCheckedAt: null, reason: null },
                    health: { status: 'healthy', checkedAt: null, reason: null },
                    assignedRoles: [],
                    createdAt: '2026-04-14T12:00:00.000Z',
                    updatedAt: '2026-04-14T12:00:00.000Z',
                },
            ],
        });

        const validateResponse: StorageValidateProviderResponse = {
            ok: true,
            result: {
                providerId: 'filesystem:data/storage',
                ok: true,
                health: { status: 'healthy', checkedAt: null, reason: null },
                auth: { mode: 'none', status: 'not_required', lastCheckedAt: null, reason: null },
                detectedRolesSupported: ['blob_store', 'artifact_store', 'backup_target'],
                detectedCapabilities: ['blob_storage'],
                warnings: [],
                errors: [],
                layeredValidation: makeLayeredValidation(),
            },
            snapshot: validatedSnapshot,
        };

        const bridge = makeBridge({
            getSnapshot: vi.fn(async () => validatedSnapshot),
            validateProvider: vi.fn(async () => validateResponse),
        });
        const model = createStorageScreenService(bridge);

        await model.loadSnapshot();
        await model.validateProvider('filesystem:data/storage');

        const state = model.getState();
        expect(bridge.validateProvider).toHaveBeenCalledWith({ providerId: 'filesystem:data/storage' });
        expect(state.snapshot?.providers[0].health.status).toBe('healthy');
        expect(state.validationByProviderId['filesystem:data/storage']?.ok).toBe(true);
    });

    it('blocked remove and disable actions surface correctly', async () => {
        const bridge = makeBridge({
            removeProvider: vi.fn(async () => ({
                ok: false,
                error: {
                    code: 'sole_canonical_provider_required',
                    message: 'Cannot remove sole canonical provider.',
                },
            })),
            setProviderEnabled: vi.fn(async () => ({
                ok: false,
                error: {
                    code: 'sole_canonical_provider_required',
                    message: 'Cannot disable sole canonical provider.',
                },
            })),
        });

        const model = createStorageScreenService(bridge);
        await model.removeProvider('pg-main');
        expect(model.getState().lastError?.code).toBe('sole_canonical_provider_required');

        await model.setProviderEnabled('pg-main', false);
        expect(model.getState().lastError?.code).toBe('sole_canonical_provider_required');
    });

    it('add-provider flow handles manual provider draft and validation response', async () => {
        const providerSnapshot = makeSnapshot({
            providers: [
                {
                    id: 'sqlite:data/tala.db',
                    name: 'SQLite Local',
                    kind: 'sqlite',
                    locality: 'local',
                    registrationMode: 'manual',
                    supportedRoles: ['canonical_memory', 'document_store'],
                    capabilities: ['structured_records', 'document_storage'],
                    enabled: true,
                    connection: { path: 'data/tala.db', workspaceRelativePath: 'data/tala.db' },
                    auth: { mode: 'none', status: 'not_required', lastCheckedAt: null, reason: null },
                    health: { status: 'unknown', checkedAt: null, reason: null },
                    assignedRoles: [],
                    createdAt: '2026-04-14T12:00:00.000Z',
                    updatedAt: '2026-04-14T12:00:00.000Z',
                },
            ],
        });

        const bridge = makeBridge({
            addProvider: vi.fn(async () => ({ ok: true, snapshot: providerSnapshot, changed: providerSnapshot.providers[0] })),
            validateProvider: vi.fn(async () => ({
                ok: true,
                result: {
                    providerId: 'sqlite:data/tala.db',
                    ok: true,
                    health: { status: 'healthy', checkedAt: null, reason: null },
                    auth: { mode: 'none', status: 'not_required', lastCheckedAt: null, reason: null },
                    detectedRolesSupported: ['canonical_memory', 'document_store'],
                    detectedCapabilities: ['structured_records', 'document_storage'],
                    warnings: [],
                    errors: [],
                    layeredValidation: makeLayeredValidation(),
                },
                snapshot: providerSnapshot,
            })),
        });

        const model = createStorageScreenService(bridge);
        await model.addProvider({
            id: 'sqlite:data/tala.db',
            name: 'SQLite Local',
            kind: 'sqlite',
            locality: 'local',
            registrationMode: 'manual',
            connection: { path: 'data/tala.db' },
        });
        await model.validateProvider('sqlite:data/tala.db');

        expect(model.getState().snapshot?.providers[0].id).toBe('sqlite:data/tala.db');
        expect(model.getState().validationByProviderId['sqlite:data/tala.db']?.ok).toBe(true);
    });

    it('role assignment UI uses backend-authoritative data only', () => {
        const snapshot = makeSnapshot({
            providers: [
                {
                    id: 'manual-provider',
                    name: 'Manual Provider',
                    kind: 'unknown',
                    locality: 'remote',
                    registrationMode: 'manual',
                    supportedRoles: ['artifact_store'],
                    capabilities: [],
                    enabled: true,
                    connection: {},
                    auth: { mode: 'none', status: 'not_required', lastCheckedAt: null, reason: null },
                    health: { status: 'unknown', checkedAt: null, reason: null },
                    assignedRoles: [],
                    createdAt: '2026-04-14T12:00:00.000Z',
                    updatedAt: '2026-04-14T12:00:00.000Z',
                },
            ],
        });

        const optionsForArtifactStore = buildRoleProviderOptions(snapshot, 'artifact_store');
        const optionsForCanonical = buildRoleProviderOptions(snapshot, 'canonical_memory');

        expect(optionsForArtifactStore.map((provider) => provider.id)).toEqual(['manual-provider']);
        expect(optionsForCanonical).toEqual([]);
    });

    it('builds authority, provider, and role visibility models for diagnostics-friendly inspection', () => {
        const snapshot = makeSnapshot({
            providers: [
                {
                    id: 'pg-main',
                    name: 'Postgres Main',
                    kind: 'postgresql',
                    locality: 'local',
                    registrationMode: 'manual',
                    supportedRoles: ['canonical_memory', 'document_store'],
                    capabilities: ['structured_records', 'document_storage'],
                    enabled: true,
                    connection: { endpoint: 'localhost:5432', database: 'tala' },
                    auth: { mode: 'basic', status: 'authenticated', lastCheckedAt: '2026-04-14T12:00:00.000Z', reason: null },
                    health: { status: 'healthy', checkedAt: '2026-04-14T12:00:00.000Z', reason: null },
                    assignedRoles: ['canonical_memory'],
                    createdAt: '2026-04-14T12:00:00.000Z',
                    updatedAt: '2026-04-14T12:00:00.000Z',
                },
                {
                    id: 'fs-blob',
                    name: 'Filesystem Blob',
                    kind: 'filesystem',
                    locality: 'local',
                    registrationMode: 'auto_discovered',
                    supportedRoles: ['blob_store', 'artifact_store'],
                    capabilities: ['blob_storage', 'artifact_storage'],
                    enabled: true,
                    connection: { path: 'data/storage' },
                    auth: { mode: 'none', status: 'not_required', lastCheckedAt: null, reason: null },
                    health: { status: 'degraded', checkedAt: '2026-04-14T12:00:00.000Z', reason: 'latency' },
                    assignedRoles: ['blob_store'],
                    createdAt: '2026-04-14T12:00:00.000Z',
                    updatedAt: '2026-04-14T12:00:00.000Z',
                },
            ],
            assignments: [
                { role: 'canonical_memory', providerId: 'pg-main', assignedAt: '2026-04-14T12:00:00.000Z' },
                { role: 'blob_store', providerId: 'fs-blob', assignedAt: '2026-04-14T12:00:00.000Z' },
            ],
        });

        const authority = buildStorageAuthoritySummary(snapshot);
        const providers = buildProviderVisibilityModels(snapshot, {});
        const roles = buildRoleVisibilityModels(snapshot);

        expect(authority.canonicalRuntimeAuthority.providerId).toBe('pg-main');
        expect(authority.derivedProviders.map((item) => item.providerId)).toContain('fs-blob');
        expect(providers['pg-main']?.authorityClass).toBe('canonical');
        expect(providers['fs-blob']?.origin).toBe('detected');
        expect(roles.find((item) => item.role === 'canonical_memory')?.assignmentType).toBe('explicit');
    });

    it('produces assignment explanation models for success and failure', () => {
        const snapshot = makeSnapshot({
            providers: [
                {
                    id: 'pg-main',
                    name: 'Postgres Main',
                    kind: 'postgresql',
                    locality: 'local',
                    registrationMode: 'manual',
                    supportedRoles: ['canonical_memory'],
                    capabilities: ['structured_records'],
                    enabled: true,
                    connection: { endpoint: 'localhost:5432', database: 'tala' },
                    auth: { mode: 'basic', status: 'authenticated', lastCheckedAt: null, reason: null },
                    health: { status: 'healthy', checkedAt: null, reason: null },
                    assignedRoles: ['canonical_memory'],
                    createdAt: '2026-04-14T12:00:00.000Z',
                    updatedAt: '2026-04-14T12:00:00.000Z',
                },
            ],
            assignments: [{ role: 'canonical_memory', providerId: 'pg-main', assignedAt: '2026-04-14T12:00:00.000Z' }],
        });

        const success = buildAssignmentSuccessExplanation(snapshot, 'pg-main', 'canonical_memory');
        const failure = buildAssignmentFailureExplanation(
            snapshot,
            'pg-main',
            'canonical_memory',
            { code: 'provider_disabled', message: 'Provider disabled.' },
        );

        expect(success.outcome).toBe('succeeded');
        expect(success.nextSteps).toContain('run_validation');
        expect(failure.outcome).toBe('failed');
        expect(failure.reasonCode).toBe('provider_disabled');
        expect(failure.nextSteps).toContain('enable_provider');
    });
});
