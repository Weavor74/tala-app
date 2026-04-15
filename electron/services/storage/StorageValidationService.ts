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
    createStorageOperationError,
} from './storageTypes';

function nowIso(): string {
    return new Date().toISOString();
}

function normalizePath(targetPath: string): string {
    return path.resolve(targetPath).replace(/[\\/]+$/g, '').toLowerCase();
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
        const detectedRolesSupported = profile.supportedRoles.slice();
        const detectedCapabilities = profile.defaultCapabilities.slice();

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
                } else {
                    const reachable = await probeTcpPort(config.host, config.port, 2000);
                    health = {
                        status: reachable ? StorageHealthStatus.DEGRADED : StorageHealthStatus.OFFLINE,
                        checkedAt: nowIso(),
                        reason: reachable ? 'tcp_only_probe' : 'tcp_unreachable',
                    };
                    auth = {
                        mode: StorageAuthMode.BASIC,
                        status: reachable ? StorageAuthStatus.UNAUTHENTICATED : StorageAuthStatus.UNAUTHENTICATED,
                        lastCheckedAt: nowIso(),
                        reason: reachable ? 'pool_not_initialized' : 'tcp_unreachable',
                    };
                    warnings.push('Canonical DB pool is not initialized; validation used TCP reachability only.');
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
