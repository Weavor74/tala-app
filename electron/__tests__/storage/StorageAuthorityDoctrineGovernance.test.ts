import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { refreshSettingsFromDisk, saveSettings } from '../../services/SettingsManager';
import { resolveStoragePath } from '../../services/PathResolver';
import { StorageConfigPersistenceService } from '../../services/storage/storageConfigPersistence';
import { StorageProviderRegistryService } from '../../services/storage/StorageProviderRegistryService';
import { StorageValidationService } from '../../services/storage/StorageValidationService';
import {
    StorageAssignmentReasonCode,
    StorageAuthMode,
    StorageAuthStatus,
    StorageCapability,
    StorageHealthStatus,
    StorageLocality,
    StorageProviderKind,
    StorageRegistrationMode,
    StorageRole,
    StorageValidationDimension,
    StorageValidationDimensionStatus,
} from '../../services/storage/storageTypes';
import {
    buildProviderVisibilityModels,
    buildRoleVisibilityModels,
    buildStorageAuthoritySummary,
} from '../../../src/renderer/storage/StorageViewModels';

function makeSettingsPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-storage-doctrine-'));
    return path.join(dir, 'app_settings.json');
}

function makeRegistry(settingsPath: string): StorageProviderRegistryService {
    const persistence = new StorageConfigPersistenceService(settingsPath);
    return new StorageProviderRegistryService(persistence, undefined, () => '2026-04-15T10:00:00.000Z');
}

function writeSettings(settingsPath: string, patch: Record<string, unknown>): void {
    const ok = saveSettings(settingsPath, patch);
    if (!ok) {
        throw new Error('Failed to write deterministic settings patch');
    }
    refreshSettingsFromDisk(settingsPath, 'StorageAuthorityDoctrineGovernance.writeSettings');
}

describe('Storage authority doctrine governance', () => {
    let settingsPath: string;

    beforeEach(() => {
        settingsPath = makeSettingsPath();
        refreshSettingsFromDisk(settingsPath, 'StorageAuthorityDoctrineGovernance.beforeEach');
    });

    describe('Registry authority', () => {
        it('explicit assignment survives bootstrap', () => {
            writeSettings(settingsPath, {
                storageRegistry: {
                    version: 1,
                    updatedAt: '2026-04-15T10:00:00.000Z',
                    providers: [
                        {
                            id: 'sqlite:explicit-canonical.db',
                            name: 'Explicit Canonical',
                            kind: StorageProviderKind.SQLITE,
                            locality: StorageLocality.LOCAL,
                            registrationMode: StorageRegistrationMode.MANUAL,
                            supportedRoles: [StorageRole.CANONICAL_MEMORY, StorageRole.DOCUMENT_STORE, StorageRole.BACKUP_TARGET],
                            capabilities: [StorageCapability.STRUCTURED_RECORDS, StorageCapability.DOCUMENT_STORAGE, StorageCapability.BACKUP_TARGET],
                            enabled: true,
                            connection: { path: 'explicit-canonical.db' },
                            auth: { mode: StorageAuthMode.NONE, status: StorageAuthStatus.NOT_REQUIRED, lastCheckedAt: null, reason: null },
                            health: { status: StorageHealthStatus.HEALTHY, checkedAt: null, reason: null },
                            assignedRoles: [StorageRole.CANONICAL_MEMORY],
                            createdAt: '2026-04-15T10:00:00.000Z',
                            updatedAt: '2026-04-15T10:00:00.000Z',
                        },
                    ],
                    assignments: [
                        { role: StorageRole.CANONICAL_MEMORY, providerId: 'sqlite:explicit-canonical.db', assignedAt: '2026-04-15T10:00:00.000Z' },
                    ],
                },
                storage: {
                    activeProviderId: 'legacy-chroma',
                    providers: [{ id: 'legacy-chroma', name: 'Legacy Chroma', type: 'chroma-local', path: './data/memory' }],
                },
            });
            const registry = makeRegistry(settingsPath);
            const snapshot = registry.getRegistrySnapshot();
            expect(snapshot.assignments.find((item) => item.role === StorageRole.CANONICAL_MEMORY)?.providerId).toBe('sqlite:explicit-canonical.db');
            expect(snapshot.assignmentDecisions?.some((d) => d.reasonCode === StorageAssignmentReasonCode.EXPLICIT_ASSIGNMENT_PRESERVED)).toBe(true);
        });

        it('bootstrap fills missing roles only', () => {
            writeSettings(settingsPath, {
                storageRegistry: {
                    version: 1,
                    updatedAt: '2026-04-15T10:00:00.000Z',
                    providers: [
                        {
                            id: 'chromadb:http://127.0.0.1:8000',
                            name: 'Manual Vector',
                            kind: StorageProviderKind.CHROMADB,
                            locality: StorageLocality.LOCAL,
                            registrationMode: StorageRegistrationMode.MANUAL,
                            supportedRoles: [StorageRole.VECTOR_INDEX],
                            capabilities: [StorageCapability.VECTOR_INDEXING],
                            enabled: true,
                            connection: { endpoint: 'http://127.0.0.1:8000' },
                            auth: { mode: StorageAuthMode.NONE, status: StorageAuthStatus.NOT_REQUIRED, lastCheckedAt: null, reason: null },
                            health: { status: StorageHealthStatus.HEALTHY, checkedAt: null, reason: null },
                            assignedRoles: [StorageRole.VECTOR_INDEX],
                            createdAt: '2026-04-15T10:00:00.000Z',
                            updatedAt: '2026-04-15T10:00:00.000Z',
                        },
                    ],
                    assignments: [
                        { role: StorageRole.VECTOR_INDEX, providerId: 'chromadb:http://127.0.0.1:8000', assignedAt: '2026-04-15T10:00:00.000Z' },
                    ],
                },
                storage: {
                    activeProviderId: 'legacy-chroma',
                    providers: [{ id: 'legacy-chroma', name: 'Legacy Chroma', type: 'chroma-local', path: './data/memory' }],
                },
                backup: {
                    localPath: './custom-backups',
                },
            });
            const registry = makeRegistry(settingsPath);
            const snapshot = registry.getRegistrySnapshot();
            expect(snapshot.assignments.find((item) => item.role === StorageRole.VECTOR_INDEX)?.providerId).toBe('chromadb:http://127.0.0.1:8000');
            expect(snapshot.assignments.length).toBeGreaterThan(1);
            expect(snapshot.assignmentDecisions?.some((d) => d.reasonCode === StorageAssignmentReasonCode.FILLED_MISSING_ROLE_FROM_BOOTSTRAP)).toBe(true);
        });

        it('bootstrap is idempotent', () => {
            writeSettings(settingsPath, {
                storage: {
                    activeProviderId: 'legacy-chroma',
                    providers: [{ id: 'legacy-chroma', name: 'Legacy Chroma', type: 'chroma-local', path: './data/memory' }],
                },
            });
            const registry = makeRegistry(settingsPath);
            const first = registry.getRegistrySnapshot();
            const firstRunCount = first.legacyBootstrap?.runCount ?? 0;
            const firstProviderIds = first.providers.map((p) => p.id).sort();
            const second = registry.loadPersistedProviderConfig();
            const secondProviderIds = second.providers.map((p) => p.id).sort();
            expect(secondProviderIds).toEqual(firstProviderIds);
            expect(second.legacyBootstrap?.runCount).toBe(firstRunCount);
        });
    });

    describe('Validation doctrine', () => {
        it('provider can be config-valid but role-ineligible', async () => {
            const providerPath = resolveStoragePath(path.join('doctrine-tests', 'role-ineligible'));
            fs.mkdirSync(providerPath, { recursive: true });
            const registry = makeRegistry(settingsPath);
            registry.addProvider({
                id: 'filesystem:role-ineligible',
                name: 'Filesystem Role Ineligible',
                kind: StorageProviderKind.FILESYSTEM,
                locality: StorageLocality.LOCAL,
                registrationMode: StorageRegistrationMode.MANUAL,
                enabled: false,
                connection: { path: providerPath, workspaceRelativePath: 'data/doctrine-tests/role-ineligible' },
            });
            const validation = new StorageValidationService(registry);
            const { result } = await validation.validateProvider('filesystem:role-ineligible');
            expect(result.layeredValidation.dimensions[StorageValidationDimension.CONFIG_SCHEMA].status).toBe(StorageValidationDimensionStatus.PASS);
            expect(result.layeredValidation.dimensions[StorageValidationDimension.ROLE_ELIGIBILITY].status).toBe(StorageValidationDimensionStatus.FAIL);
            expect(result.layeredValidation.classification.validButNotEligible).toBe(true);
        });

        it('provider can classify as reachable-but-auth-invalid', async () => {
            const registry = makeRegistry(settingsPath);
            registry.addProvider({
                id: 'unknown:auth-invalid',
                name: 'Unknown Auth Invalid',
                kind: StorageProviderKind.UNKNOWN,
                locality: StorageLocality.UNKNOWN,
                registrationMode: StorageRegistrationMode.MANUAL,
                enabled: true,
            });
            const validation = new StorageValidationService(registry);
            const { result } = await validation.validateProvider('unknown:auth-invalid');
            expect(result.layeredValidation.dimensions[StorageValidationDimension.AUTHENTICATION].status).toBe(StorageValidationDimensionStatus.FAIL);
            expect(result.layeredValidation.dimensions[StorageValidationDimension.REACHABILITY].status).toBe(StorageValidationDimensionStatus.WARN);
            expect(result.layeredValidation.classification.reachableButUnauthorized).toBe(true);
        });

        it('policy-blocked provider is reported by layered validation', async () => {
            const providerPath = resolveStoragePath(path.join('doctrine-tests', 'policy-blocked'));
            fs.mkdirSync(providerPath, { recursive: true });
            const registry = makeRegistry(settingsPath);
            registry.addProvider({
                id: 'filesystem:policy-blocked',
                name: 'Filesystem Policy Blocked',
                kind: StorageProviderKind.FILESYSTEM,
                locality: StorageLocality.LOCAL,
                registrationMode: StorageRegistrationMode.MANUAL,
                enabled: true,
                connection: { path: providerPath, workspaceRelativePath: 'data/doctrine-tests/policy-blocked' },
            });
            registry.assignRole('filesystem:policy-blocked', StorageRole.BLOB_STORE);
            registry.setProviderEnabled('filesystem:policy-blocked', false);
            const validation = new StorageValidationService(registry);
            const { result } = await validation.validateProvider('filesystem:policy-blocked');
            expect(result.layeredValidation.dimensions[StorageValidationDimension.POLICY_COMPLIANCE].status).toBe(StorageValidationDimensionStatus.FAIL);
            expect(result.layeredValidation.classification.configuredButPolicyBlocked).toBe(true);
        });
    });

    describe('Assignment doctrine', () => {
        it('explicit assignment is preserved', () => {
            const registry = makeRegistry(settingsPath);
            registry.addProvider({
                id: 'sqlite:explicit-preserve.db',
                name: 'SQLite Explicit Preserve',
                kind: StorageProviderKind.SQLITE,
                locality: StorageLocality.LOCAL,
                registrationMode: StorageRegistrationMode.MANUAL,
                enabled: true,
            });
            registry.assignRole('sqlite:explicit-preserve.db', StorageRole.CANONICAL_MEMORY);
            const snapshot = registry.assignRole('sqlite:explicit-preserve.db', StorageRole.CANONICAL_MEMORY);
            expect(snapshot.assignmentDecisions?.slice(-1)[0]?.reasonCode).toBe(StorageAssignmentReasonCode.EXPLICIT_ASSIGNMENT_PRESERVED);
        });

        it('canonical conflict is surfaced with stable reason codes', () => {
            writeSettings(settingsPath, {
                storageRegistry: {
                    version: 1,
                    updatedAt: '2026-04-15T10:00:00.000Z',
                    providers: [
                        {
                            id: 'sqlite:a.db',
                            name: 'SQLite A',
                            kind: StorageProviderKind.SQLITE,
                            locality: StorageLocality.LOCAL,
                            registrationMode: StorageRegistrationMode.MANUAL,
                            supportedRoles: [StorageRole.CANONICAL_MEMORY],
                            capabilities: [StorageCapability.STRUCTURED_RECORDS],
                            enabled: true,
                            connection: { path: 'a.db' },
                            auth: { mode: StorageAuthMode.NONE, status: StorageAuthStatus.NOT_REQUIRED, lastCheckedAt: null, reason: null },
                            health: { status: StorageHealthStatus.HEALTHY, checkedAt: null, reason: null },
                            assignedRoles: [],
                            createdAt: '2026-04-15T10:00:00.000Z',
                            updatedAt: '2026-04-15T10:00:00.000Z',
                        },
                        {
                            id: 'sqlite:b.db',
                            name: 'SQLite B',
                            kind: StorageProviderKind.SQLITE,
                            locality: StorageLocality.LOCAL,
                            registrationMode: StorageRegistrationMode.MANUAL,
                            supportedRoles: [StorageRole.CANONICAL_MEMORY],
                            capabilities: [StorageCapability.STRUCTURED_RECORDS],
                            enabled: true,
                            connection: { path: 'b.db' },
                            auth: { mode: StorageAuthMode.NONE, status: StorageAuthStatus.NOT_REQUIRED, lastCheckedAt: null, reason: null },
                            health: { status: StorageHealthStatus.HEALTHY, checkedAt: null, reason: null },
                            assignedRoles: [],
                            createdAt: '2026-04-15T10:00:00.000Z',
                            updatedAt: '2026-04-15T10:00:00.000Z',
                        },
                    ],
                    assignments: [
                        { role: StorageRole.CANONICAL_MEMORY, providerId: 'sqlite:a.db', assignedAt: '2026-04-15T10:00:00.000Z' },
                        { role: StorageRole.CANONICAL_MEMORY, providerId: 'sqlite:b.db', assignedAt: '2026-04-15T10:00:00.000Z' },
                    ],
                },
            });
            const registry = makeRegistry(settingsPath);
            const snapshot = registry.getRegistrySnapshot();
            expect(snapshot.assignmentDecisions?.some((d) => d.reasonCode === StorageAssignmentReasonCode.BLOCKED_CANONICAL_CONFLICT)).toBe(true);
            expect(snapshot.assignmentDecisions?.some((d) => d.reasonCode === StorageAssignmentReasonCode.RECOVERY_SUGGESTION_ONLY)).toBe(true);
        });

        it('capability mismatch blocks assignment', () => {
            const registry = makeRegistry(settingsPath);
            registry.addProvider({
                id: 'filesystem:capability-mismatch',
                name: 'Filesystem Capability Mismatch',
                kind: StorageProviderKind.FILESYSTEM,
                locality: StorageLocality.LOCAL,
                registrationMode: StorageRegistrationMode.MANUAL,
                enabled: true,
            });
            try {
                registry.assignRole('filesystem:capability-mismatch', StorageRole.VECTOR_INDEX);
                throw new Error('expected capability mismatch');
            } catch (error) {
                const details = (error as { details?: Record<string, unknown> }).details;
                expect(details?.assignmentReasonCode).toBe(StorageAssignmentReasonCode.BLOCKED_CAPABILITY_MISMATCH);
            }
        });
    });

    describe('Recovery doctrine', () => {
        it('canonical auth failure degrades authority without reassignment', () => {
            const registry = makeRegistry(settingsPath);
            registry.addProvider({
                id: 'postgresql:localhost:5432:tala',
                name: 'Canonical Postgres',
                kind: StorageProviderKind.POSTGRESQL,
                locality: StorageLocality.LOCAL,
                registrationMode: StorageRegistrationMode.MANUAL,
                enabled: true,
                health: { status: StorageHealthStatus.HEALTHY, checkedAt: null, reason: null },
                auth: { mode: StorageAuthMode.BASIC, status: StorageAuthStatus.AUTHENTICATED, lastCheckedAt: null, reason: null },
            });
            registry.assignRole('postgresql:localhost:5432:tala', StorageRole.CANONICAL_MEMORY);
            registry.updateProvider({
                id: 'postgresql:localhost:5432:tala',
                auth: { mode: StorageAuthMode.BASIC, status: StorageAuthStatus.BLOCKED, lastCheckedAt: '2026-04-15T10:00:00.000Z', reason: 'test_auth_failure' },
            });
            const snapshot = registry.getRegistrySnapshot();
            const summary = buildStorageAuthoritySummary(snapshot);
            expect(snapshot.assignments.find((a) => a.role === StorageRole.CANONICAL_MEMORY)?.providerId).toBe('postgresql:localhost:5432:tala');
            expect(summary.authorityState.degraded).toBe(true);
            expect(summary.registryHealth.state).toBe('degraded');
        });

        it('invalid provider remains assigned but flagged', () => {
            writeSettings(settingsPath, {
                storageRegistry: {
                    version: 1,
                    updatedAt: '2026-04-15T10:00:00.000Z',
                    providers: [],
                    assignments: [
                        { role: StorageRole.CANONICAL_MEMORY, providerId: 'missing-provider', assignedAt: '2026-04-15T10:00:00.000Z' },
                    ],
                },
            });
            const registry = makeRegistry(settingsPath);
            const snapshot = registry.getRegistrySnapshot();
            const roles = buildRoleVisibilityModels(snapshot);
            const canonicalRow = roles.find((r) => r.role === StorageRole.CANONICAL_MEMORY);
            expect(snapshot.assignments.find((a) => a.role === StorageRole.CANONICAL_MEMORY)?.providerId).toBe('missing-provider');
            expect(snapshot.assignmentDecisions?.some((d) => d.reasonCode === StorageAssignmentReasonCode.PROVIDER_NOT_REGISTERED)).toBe(true);
            expect(canonicalRow?.decisionReasonCode).toBe(StorageAssignmentReasonCode.PROVIDER_NOT_REGISTERED);
        });

        it('legacy config cannot silently override registry after bootstrap completion', () => {
            writeSettings(settingsPath, {
                storageRegistry: {
                    version: 1,
                    updatedAt: '2026-04-15T10:00:00.000Z',
                    providers: [
                        {
                            id: 'sqlite:explicit.db',
                            name: 'Explicit SQLite',
                            kind: StorageProviderKind.SQLITE,
                            locality: StorageLocality.LOCAL,
                            registrationMode: StorageRegistrationMode.MANUAL,
                            supportedRoles: [StorageRole.CANONICAL_MEMORY],
                            capabilities: [StorageCapability.STRUCTURED_RECORDS],
                            enabled: true,
                            connection: { path: 'explicit.db' },
                            auth: { mode: StorageAuthMode.NONE, status: StorageAuthStatus.NOT_REQUIRED, lastCheckedAt: null, reason: null },
                            health: { status: StorageHealthStatus.HEALTHY, checkedAt: null, reason: null },
                            assignedRoles: [StorageRole.CANONICAL_MEMORY],
                            createdAt: '2026-04-15T10:00:00.000Z',
                            updatedAt: '2026-04-15T10:00:00.000Z',
                        },
                    ],
                    assignments: [
                        { role: StorageRole.CANONICAL_MEMORY, providerId: 'sqlite:explicit.db', assignedAt: '2026-04-15T10:00:00.000Z' },
                    ],
                    legacyBootstrap: {
                        completed: true,
                        completedAt: '2026-04-15T10:00:00.000Z',
                        lastAttemptAt: '2026-04-15T10:00:00.000Z',
                        runCount: 1,
                        lastOutcome: 'completed',
                    },
                },
                storage: {
                    activeProviderId: 'legacy-bad',
                    providers: [{ id: 'legacy-bad', name: 'Legacy Bad', type: 'mystery-backend' }],
                },
            });
            const registry = makeRegistry(settingsPath);
            const before = registry.getRegistrySnapshot();
            const beforeRunCount = before.legacyBootstrap?.runCount ?? 0;
            const reloaded = registry.loadPersistedProviderConfig();
            expect(reloaded.providers.some((p) => p.id.includes('legacy-bad'))).toBe(false);
            expect(reloaded.legacyBootstrap?.runCount).toBe(beforeRunCount);
        });
    });

    describe('Diagnostics and UX doctrine', () => {
        it('summary reflects authority state and reason codes are present', () => {
            const registry = makeRegistry(settingsPath);
            const snapshot = registry.getRegistrySnapshot();
            const summary = buildStorageAuthoritySummary(snapshot);
            expect(summary.registryHealth.state).toBe('degraded');
            expect(summary.registryHealth.reasons).toContain('canonical_runtime_authority_unassigned');
            expect(summary.recoveryActions).toContain('assign_canonical_memory_provider');
        });

        it('bootstrap origin is correctly labeled in provider visibility', () => {
            writeSettings(settingsPath, {
                storage: {
                    activeProviderId: 'legacy-chroma',
                    providers: [{ id: 'legacy-chroma', name: 'Legacy Chroma', type: 'chroma-local', path: './data/memory' }],
                },
            });
            const registry = makeRegistry(settingsPath);
            const snapshot = registry.getRegistrySnapshot();
            const visibility = buildProviderVisibilityModels(snapshot, {});
            const hasBootstrappedOrigin = Object.values(visibility).some((provider) => provider.origin === 'bootstrapped_legacy');
            expect(hasBootstrappedOrigin).toBe(true);
            expect(snapshot.legacyBootstrap?.completed).toBe(true);
        });
    });
});
