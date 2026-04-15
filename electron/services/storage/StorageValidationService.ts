import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { APP_ROOT } from '../PathResolver';
import { checkCanonicalDbHealth, getLastDbHealth } from '../db/initMemoryStore';
import { probeTcpPort } from '../db/probeTcpPort';
import { resolveDatabaseConfig } from '../db/resolveDatabaseConfig';
import { StorageProviderRegistryService } from './StorageProviderRegistryService';
import { getStorageCapabilityProfile } from './storageCapabilityMatrix';
import {
    StorageAuthMode,
    StorageAuthStatus,
    StorageCapability,
    StorageHealthStatus,
    StorageOperationErrorCode,
    StorageProviderKind,
    StorageProviderValidationResult,
    StorageRole,
    createStorageOperationError,
} from './storageTypes';

function nowIso(): string {
    return new Date().toISOString();
}

function normalizePath(targetPath: string): string {
    return path.resolve(targetPath).replace(/[\\/]+$/g, '').toLowerCase();
}

function normalizeHost(host: string): string {
    return host.trim().toLowerCase();
}

function isLoopbackHost(host: string): boolean {
    const normalized = normalizeHost(host);
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function hostsMatch(left: string, right: string): boolean {
    const a = normalizeHost(left);
    const b = normalizeHost(right);
    if (isLoopbackHost(a) && isLoopbackHost(b)) {
        return true;
    }
    return a === b;
}

function parseEndpointHostPort(endpoint: string): { host: string; port: number } | null {
    const value = endpoint.trim();
    if (!value) {
        return null;
    }

    try {
        if (value.includes('://')) {
            const parsed = new URL(value);
            const host = parsed.hostname;
            const parsedPort = parsed.port ? Number(parsed.port) : Number.NaN;
            if (!host || Number.isNaN(parsedPort) || parsedPort <= 0) {
                return null;
            }
            return { host, port: parsedPort };
        }
    } catch {
        // fall through and attempt host:port parsing below
    }

    const lastColon = value.lastIndexOf(':');
    if (lastColon <= 0 || lastColon >= value.length - 1) {
        return null;
    }
    const host = value.slice(0, lastColon).trim().replace(/^\[|\]$/g, '');
    const parsedPort = Number(value.slice(lastColon + 1));
    if (!host || Number.isNaN(parsedPort) || parsedPort <= 0) {
        return null;
    }
    return { host, port: parsedPort };
}

function parsePostgresIdentityFromProvider(providerId: string): { host: string; port: number; database: string } | null {
    const match = /^postgresql:([^:]+):(\d+):(.+)$/.exec(providerId);
    if (!match) {
        return null;
    }
    return {
        host: match[1],
        port: Number(match[2]),
        database: match[3],
    };
}

function resolvePostgresProviderIdentity(
    providerId: string,
    connection: { endpoint?: string; database?: string },
): { host: string; port: number; database: string } | null {
    const parsedEndpoint = connection.endpoint ? parseEndpointHostPort(connection.endpoint) : null;
    if (parsedEndpoint && connection.database) {
        return {
            host: parsedEndpoint.host,
            port: parsedEndpoint.port,
            database: connection.database,
        };
    }
    const parsedFromId = parsePostgresIdentityFromProvider(providerId);
    if (parsedFromId) {
        return parsedFromId;
    }
    return null;
}

function withCapability(list: StorageCapability[], capability: StorageCapability): StorageCapability[] {
    return list.includes(capability) ? list : [...list, capability];
}

function withoutCapability(list: StorageCapability[], capability: StorageCapability): StorageCapability[] {
    return list.filter((value) => value !== capability);
}

function withRole(list: StorageRole[], role: StorageRole): StorageRole[] {
    return list.includes(role) ? list : [...list, role];
}

function withoutRole(list: StorageRole[], role: StorageRole): StorageRole[] {
    return list.filter((value) => value !== role);
}

function isWithinAppRoot(targetPath: string): boolean {
    const root = normalizePath(APP_ROOT);
    const target = normalizePath(targetPath);
    return target === root || target.startsWith(`${root}${path.sep}`);
}

async function probeHttp(url: string, timeoutMs = 2500): Promise<boolean> {
    return await new Promise((resolve) => {
        const lib = url.startsWith('https://') ? https : http;
        const request = lib.get(url, { timeout: timeoutMs }, (response) => {
            const statusCode = response.statusCode ?? 0;
            response.resume();
            resolve(statusCode > 0 && statusCode < 500);
        });
        request.on('error', () => resolve(false));
        request.on('timeout', () => {
            request.destroy();
            resolve(false);
        });
    });
}

export class StorageValidationService {
    constructor(private readonly registry: StorageProviderRegistryService) {}

    public async validateProvider(providerId: string): Promise<{ result: StorageProviderValidationResult }> {
        const provider = this.registry.getProviderById(providerId);
        if (!provider) {
            throw createStorageOperationError(StorageOperationErrorCode.PROVIDER_NOT_FOUND, 'Provider not found', { providerId });
        }

        const profile = getStorageCapabilityProfile(provider.kind);
        const warnings: string[] = [];
        const errors: string[] = [];
        let detectedRolesSupported = profile.supportedRoles.slice();
        let detectedCapabilities = profile.defaultCapabilities.slice();

        let health = { ...provider.health };
        let auth = { ...provider.auth };

        for (const role of provider.supportedRoles) {
            if (!profile.supportedRoles.includes(role)) {
                errors.push(`Unsupported role "${role}" for provider kind "${provider.kind}".`);
            }
        }

        if (!profile.allowedLocality.includes(provider.locality)) {
            errors.push(`Locality "${provider.locality}" is not allowed for provider kind "${provider.kind}".`);
        }

        switch (provider.kind) {
            case StorageProviderKind.FILESYSTEM: {
                const targetPath = provider.connection.path;
                if (!targetPath) {
                    health = { status: StorageHealthStatus.DEGRADED, checkedAt: nowIso(), reason: 'missing_path' };
                    errors.push('Filesystem provider path is missing.');
                } else {
                    const exists = fs.existsSync(targetPath);
                    if (!exists) {
                        health = { status: StorageHealthStatus.DEGRADED, checkedAt: nowIso(), reason: 'path_missing' };
                        warnings.push('Filesystem path does not exist yet.');
                    } else {
                        health = { status: StorageHealthStatus.HEALTHY, checkedAt: nowIso(), reason: null };
                    }
                    if (!isWithinAppRoot(targetPath)) {
                        warnings.push('Filesystem path is outside app root; local-first portability is reduced.');
                    }
                }
                auth = { mode: StorageAuthMode.NONE, status: StorageAuthStatus.NOT_REQUIRED, lastCheckedAt: nowIso(), reason: null };
                break;
            }

            case StorageProviderKind.POSTGRESQL: {
                const config = resolveDatabaseConfig();
                const activeTarget = {
                    host: config.host,
                    port: config.port,
                    database: config.database,
                };
                const providerTarget = resolvePostgresProviderIdentity(provider.id, provider.connection);
                const matchesActiveTarget = !!providerTarget
                    && hostsMatch(providerTarget.host, activeTarget.host)
                    && providerTarget.port === activeTarget.port
                    && providerTarget.database.toLowerCase() === activeTarget.database.toLowerCase();

                if (matchesActiveTarget) {
                    const cached = getLastDbHealth();
                    let healthResult = cached;
                    if (!healthResult) {
                        try {
                            healthResult = await checkCanonicalDbHealth();
                        } catch (error) {
                            warnings.push(`Canonical DB health probe failed: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    }
                    if (healthResult) {
                        health = {
                            status: healthResult.reachable ? StorageHealthStatus.HEALTHY : StorageHealthStatus.OFFLINE,
                            checkedAt: nowIso(),
                            reason: healthResult.error ?? null,
                        };
                        auth = {
                            mode: StorageAuthMode.BASIC,
                            status: healthResult.authenticated ? StorageAuthStatus.AUTHENTICATED : StorageAuthStatus.UNAUTHENTICATED,
                            lastCheckedAt: nowIso(),
                            reason: healthResult.error ?? null,
                        };

                        if (healthResult.pgvectorInstalled) {
                            detectedCapabilities = withCapability(detectedCapabilities, StorageCapability.VECTOR_SEARCH);
                            detectedCapabilities = withCapability(detectedCapabilities, StorageCapability.VECTOR_INDEXING);
                            detectedRolesSupported = withRole(detectedRolesSupported, StorageRole.VECTOR_INDEX);
                        } else {
                            detectedCapabilities = withoutCapability(detectedCapabilities, StorageCapability.VECTOR_SEARCH);
                            detectedCapabilities = withoutCapability(detectedCapabilities, StorageCapability.VECTOR_INDEXING);
                            detectedRolesSupported = withoutRole(detectedRolesSupported, StorageRole.VECTOR_INDEX);
                            warnings.push('pgvector extension is not installed on the active Canonical PostgreSQL target; vector_index Role is unavailable.');
                        }
                    } else {
                        const reachable = await probeTcpPort(activeTarget.host, activeTarget.port, 2000);
                        health = {
                            status: reachable ? StorageHealthStatus.DEGRADED : StorageHealthStatus.OFFLINE,
                            checkedAt: nowIso(),
                            reason: reachable ? 'tcp_only_probe' : 'tcp_unreachable',
                        };
                        auth = {
                            mode: StorageAuthMode.BASIC,
                            status: StorageAuthStatus.UNAUTHENTICATED,
                            lastCheckedAt: nowIso(),
                            reason: reachable ? 'pool_not_initialized' : 'tcp_unreachable',
                        };
                        warnings.push('Canonical DB pool is not initialized; Validation used TCP reachability only.');
                    }
                } else {
                    const endpointTarget = providerTarget ?? (provider.connection.endpoint ? (() => {
                        const parsed = parseEndpointHostPort(provider.connection.endpoint as string);
                        if (!parsed) {
                            return null;
                        }
                        return { host: parsed.host, port: parsed.port, database: provider.connection.database ?? '' };
                    })() : null);
                    const probeHost = endpointTarget?.host ?? config.host;
                    const probePort = endpointTarget?.port ?? config.port;
                    const reachable = await probeTcpPort(probeHost, probePort, 2000);
                    health = {
                        status: reachable ? StorageHealthStatus.DEGRADED : StorageHealthStatus.OFFLINE,
                        checkedAt: nowIso(),
                        reason: reachable ? 'tcp_only_probe' : 'tcp_unreachable',
                    };
                    auth = {
                        mode: StorageAuthMode.BASIC,
                        status: StorageAuthStatus.UNAUTHENTICATED,
                        lastCheckedAt: nowIso(),
                        reason: reachable ? 'runtime_db_mismatch' : 'tcp_unreachable',
                    };
                    warnings.push('Provider does not match the active Canonical DB target; runtime auth cannot be reused.');
                }
                break;
            }

            case StorageProviderKind.SQLITE: {
                const dbPath = provider.connection.path;
                if (!dbPath) {
                    health = { status: StorageHealthStatus.OFFLINE, checkedAt: nowIso(), reason: 'missing_path' };
                    errors.push('SQLite provider path is missing.');
                } else if (fs.existsSync(dbPath)) {
                    health = { status: StorageHealthStatus.HEALTHY, checkedAt: nowIso(), reason: null };
                } else {
                    health = { status: StorageHealthStatus.OFFLINE, checkedAt: nowIso(), reason: 'file_not_found' };
                    warnings.push('SQLite database file not found.');
                }
                auth = { mode: StorageAuthMode.NONE, status: StorageAuthStatus.NOT_REQUIRED, lastCheckedAt: nowIso(), reason: null };
                break;
            }

            case StorageProviderKind.CHROMADB: {
                const endpoint = provider.connection.endpoint;
                const pathHint = provider.connection.path;
                let reachable = false;
                if (endpoint) {
                    const base = endpoint.startsWith('http://') || endpoint.startsWith('https://') ? endpoint : `http://${endpoint}`;
                    const probePaths = ['/api/v1/heartbeat', '/api/v1/version', '/'];
                    for (const probePath of probePaths) {
                        // deterministic stop at first reachable endpoint
                        // eslint-disable-next-line no-await-in-loop
                        const ok = await probeHttp(`${base}${probePath}`);
                        if (ok) {
                            reachable = true;
                            break;
                        }
                    }
                } else if (pathHint) {
                    reachable = fs.existsSync(pathHint);
                }

                health = {
                    status: reachable ? StorageHealthStatus.HEALTHY : StorageHealthStatus.UNREACHABLE,
                    checkedAt: nowIso(),
                    reason: reachable ? null : 'chroma_not_reachable',
                };
                auth = {
                    mode: StorageAuthMode.NONE,
                    status: StorageAuthStatus.NOT_REQUIRED,
                    lastCheckedAt: nowIso(),
                    reason: null,
                };
                if (!endpoint && !pathHint) {
                    warnings.push('ChromaDB provider has no endpoint or path configured.');
                }
                break;
            }

            case StorageProviderKind.SUPABASE:
            case StorageProviderKind.S3:
            case StorageProviderKind.GOOGLE_DRIVE:
            case StorageProviderKind.SHAREPOINT:
            case StorageProviderKind.GIST:
                health = {
                    status: StorageHealthStatus.UNKNOWN,
                    checkedAt: nowIso(),
                    reason: 'needs_setup',
                };
                auth = {
                    mode: provider.auth.mode === StorageAuthMode.NONE ? StorageAuthMode.API_KEY : provider.auth.mode,
                    status: StorageAuthStatus.UNAUTHENTICATED,
                    lastCheckedAt: nowIso(),
                    reason: 'needs_setup',
                };
                warnings.push('Remote provider validation is in placeholder mode and requires setup.');
                break;

            case StorageProviderKind.UNKNOWN:
            default:
                health = {
                    status: StorageHealthStatus.UNKNOWN,
                    checkedAt: nowIso(),
                    reason: 'unknown_provider_kind',
                };
                auth = {
                    mode: provider.auth.mode,
                    status: StorageAuthStatus.ERROR,
                    lastCheckedAt: nowIso(),
                    reason: 'unknown_provider_kind',
                };
                errors.push('Unknown provider kind cannot be validated safely.');
                break;
        }

        if (profile.canonicalEligible && !detectedCapabilities.includes(StorageCapability.STRUCTURED_RECORDS)) {
            warnings.push('Provider kind is canonical-eligible but does not advertise structured records capability.');
        }

        const ok = errors.length === 0
            && auth.status !== StorageAuthStatus.ERROR
            && health.status !== StorageHealthStatus.OFFLINE
            && health.status !== StorageHealthStatus.UNREACHABLE;

        this.registry.updateProvider({
            id: provider.id,
            health,
            auth,
            supportedRoles: detectedRolesSupported,
            capabilities: detectedCapabilities,
        });

        return {
            result: {
                providerId: provider.id,
                ok,
                health,
                auth,
                detectedRolesSupported,
                detectedCapabilities,
                warnings,
                errors,
            },
        };
    }
}
