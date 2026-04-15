import fs from 'fs';
import path from 'path';
import { APP_ROOT, resolveStoragePath } from '../PathResolver';
import { loadSettings } from '../SettingsManager';
import { resolveDatabaseConfig } from '../db/resolveDatabaseConfig';
import { StorageProviderRegistryService } from './StorageProviderRegistryService';
import { getStorageCapabilityProfile } from './storageCapabilityMatrix';
import {
    StorageAuthMode,
    StorageAuthStatus,
    StorageDetectionResult,
    StorageHealthStatus,
    StorageLocality,
    StorageProviderKind,
    StorageProviderRecord,
    StorageRegistrationMode,
} from './storageTypes';

interface DetectionCandidate {
    id: string;
    name: string;
    kind: StorageProviderKind;
    locality: StorageLocality;
    connection: StorageProviderRecord['connection'];
    fingerprint: string;
}

function normalizeSlashes(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function toAppRootRelativePath(targetPath: string): string {
    const absolute = path.resolve(targetPath);
    const rel = path.relative(APP_ROOT, absolute);
    if (!rel || rel.startsWith('..')) {
        return normalizeSlashes(absolute);
    }
    return normalizeSlashes(rel);
}

function isLocalHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function parseLocalStorageProviders(settings: Record<string, any>): Array<Record<string, any>> {
    const providers = settings?.storage?.providers;
    if (!Array.isArray(providers)) {
        return [];
    }
    return providers.filter((provider) => !!provider && typeof provider === 'object');
}

export class StorageDetectionService {
    constructor(
        private readonly registry: StorageProviderRegistryService,
        private readonly settingsPathResolver: () => string,
    ) {}

    public detectAndMergeProviders(): StorageDetectionResult {
        const candidates = new Map<string, DetectionCandidate>();
        this.detectFilesystemProvider(candidates);
        this.detectPostgresqlProvider(candidates);
        this.detectSqliteProvider(candidates);
        this.detectChromaProvider(candidates);

        const ordered = Array.from(candidates.values()).sort((a, b) => a.id.localeCompare(b.id));
        for (const candidate of ordered) {
            const existing = this.registry.getProviderById(candidate.id);
            const profile = getStorageCapabilityProfile(candidate.kind);
            if (!existing) {
                this.registry.addProvider({
                    id: candidate.id,
                    name: candidate.name,
                    kind: candidate.kind,
                    locality: candidate.locality,
                    registrationMode: StorageRegistrationMode.AUTO_DISCOVERED,
                    supportedRoles: profile.supportedRoles,
                    capabilities: profile.defaultCapabilities,
                    enabled: true,
                    connection: candidate.connection,
                    auth: {
                        mode: StorageAuthMode.NONE,
                        status: StorageAuthStatus.NOT_REQUIRED,
                        lastCheckedAt: null,
                        reason: null,
                    },
                    health: {
                        status: StorageHealthStatus.UNKNOWN,
                        checkedAt: null,
                        reason: null,
                    },
                });
                continue;
            }

            const nextRegistrationMode = existing.registrationMode === StorageRegistrationMode.MANUAL
                ? StorageRegistrationMode.MANUAL
                : StorageRegistrationMode.AUTO_DISCOVERED;

            this.registry.updateProvider({
                id: candidate.id,
                locality: candidate.locality,
                registrationMode: nextRegistrationMode,
                connection: { ...existing.connection, ...candidate.connection },
                supportedRoles: existing.supportedRoles.length > 0 ? existing.supportedRoles : profile.supportedRoles,
                capabilities: existing.capabilities.length > 0 ? existing.capabilities : profile.defaultCapabilities,
            });
        }

        const snapshot = this.registry.getRegistrySnapshot();
        const detectedProviders = ordered
            .map((candidate) => snapshot.providers.find((provider) => provider.id === candidate.id))
            .filter((provider): provider is StorageProviderRecord => !!provider);

        return {
            detectedProviders,
            mergedSnapshot: snapshot,
        };
    }

    private detectFilesystemProvider(candidates: Map<string, DetectionCandidate>): void {
        const storagePath = resolveStoragePath('storage');
        const relativePath = toAppRootRelativePath(storagePath);
        const id = `filesystem:${relativePath}`;
        candidates.set(id, {
            id,
            name: 'Filesystem Storage',
            kind: StorageProviderKind.FILESYSTEM,
            locality: StorageLocality.LOCAL,
            connection: {
                path: storagePath,
                workspaceRelativePath: relativePath,
            },
            fingerprint: relativePath,
        });
    }

    private detectPostgresqlProvider(candidates: Map<string, DetectionCandidate>): void {
        const config = resolveDatabaseConfig();
        if (!config.host || !isLocalHost(config.host)) {
            return;
        }
        const host = config.host.toLowerCase();
        const id = `postgresql:${host}:${config.port}:${config.database}`;
        candidates.set(id, {
            id,
            name: 'PostgreSQL (Local)',
            kind: StorageProviderKind.POSTGRESQL,
            locality: StorageLocality.LOCAL,
            connection: {
                endpoint: `${host}:${config.port}`,
                database: config.database,
            },
            fingerprint: `${host}:${config.port}:${config.database}`,
        });
    }

    private detectSqliteProvider(candidates: Map<string, DetectionCandidate>): void {
        const settingsPath = this.settingsPathResolver();
        const settings = loadSettings(settingsPath, 'StorageDetectionService.detectSqlite');
        const legacyProviders = parseLocalStorageProviders(settings);

        const candidatePaths = new Set<string>();
        const configuredPaths = new Set<string>();
        candidatePaths.add(resolveStoragePath('tala.db'));
        candidatePaths.add(resolveStoragePath(path.join('memory', 'tala.db')));

        for (const provider of legacyProviders) {
            const rawPath = typeof provider.path === 'string' ? provider.path : '';
            if (!rawPath) {
                continue;
            }
            if (rawPath.toLowerCase().endsWith('.db') || String(provider.type).toLowerCase().includes('sqlite')) {
                const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(APP_ROOT, rawPath);
                candidatePaths.add(absolute);
                configuredPaths.add(path.resolve(absolute));
            }
        }

        const sorted = Array.from(candidatePaths.values()).sort();
        for (const sqlitePath of sorted) {
            const configured = configuredPaths.has(path.resolve(sqlitePath));
            const present = fs.existsSync(sqlitePath);
            if (!present && !configured) {
                continue;
            }
            const relativePath = toAppRootRelativePath(sqlitePath);
            const id = `sqlite:${relativePath}`;
            candidates.set(id, {
                id,
                name: 'SQLite (Local)',
                kind: StorageProviderKind.SQLITE,
                locality: StorageLocality.LOCAL,
                connection: {
                    path: sqlitePath,
                    workspaceRelativePath: relativePath,
                    database: path.basename(sqlitePath),
                },
                fingerprint: relativePath,
            });
        }
    }

    private detectChromaProvider(candidates: Map<string, DetectionCandidate>): void {
        const settingsPath = this.settingsPathResolver();
        const settings = loadSettings(settingsPath, 'StorageDetectionService.detectChroma');
        const legacyProviders = parseLocalStorageProviders(settings);
        const existingChroma = this.registry.getRegistrySnapshot().providers.filter(
            (provider) => provider.kind === StorageProviderKind.CHROMADB,
        );

        const endpointCandidates = new Set<string>();
        const pathCandidates = new Set<string>();

        for (const provider of legacyProviders) {
            const providerType = String(provider.type ?? '').toLowerCase();
            if (providerType !== 'chroma-local' && providerType !== 'chroma-remote') {
                continue;
            }
            const endpoint = typeof provider.endpoint === 'string' ? provider.endpoint.trim() : '';
            const rawPath = typeof provider.path === 'string' ? provider.path.trim() : '';
            if (endpoint && endpoint.includes('127.0.0.1')) {
                endpointCandidates.add(endpoint);
            } else if (providerType === 'chroma-local') {
                endpointCandidates.add('http://127.0.0.1:8000');
            }
            if (rawPath) {
                const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(APP_ROOT, rawPath);
                pathCandidates.add(absolute);
            }
        }

        for (const existing of existingChroma) {
            if (existing.connection.endpoint) {
                endpointCandidates.add(existing.connection.endpoint);
            }
            if (existing.connection.path) {
                pathCandidates.add(existing.connection.path);
            }
        }

        const orderedEndpoints = Array.from(endpointCandidates.values()).sort();
        for (const endpoint of orderedEndpoints) {
            const normalizedEndpoint = endpoint.toLowerCase();
            const id = `chromadb:${normalizedEndpoint}`;
            candidates.set(id, {
                id,
                name: 'ChromaDB (Local)',
                kind: StorageProviderKind.CHROMADB,
                locality: StorageLocality.LOCAL,
                connection: {
                    endpoint,
                },
                fingerprint: normalizedEndpoint,
            });
        }

        if (orderedEndpoints.length > 0) {
            return;
        }

        const orderedPaths = Array.from(pathCandidates.values()).sort();
        for (const chromaPath of orderedPaths) {
            const relativePath = toAppRootRelativePath(chromaPath);
            const id = `chromadb:${relativePath}`;
            candidates.set(id, {
                id,
                name: 'ChromaDB (Local)',
                kind: StorageProviderKind.CHROMADB,
                locality: StorageLocality.LOCAL,
                connection: {
                    path: chromaPath,
                    workspaceRelativePath: relativePath,
                },
                fingerprint: relativePath,
            });
        }
    }
}
