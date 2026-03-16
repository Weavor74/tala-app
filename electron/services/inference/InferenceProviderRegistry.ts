/**
 * InferenceProviderRegistry
 *
 * Maintains the canonical registry of all known inference providers and their
 * runtime status. Runs provider probes on demand or on a refresh schedule.
 *
 * Provider types supported:
 *   - ollama          local HTTP API on port 11434
 *   - llamacpp        external llama.cpp server on configurable port
 *   - embedded_llamacpp  bundled llama.cpp managed by LocalEngineService
 *   - vllm            vLLM OpenAI-compat server on configurable port
 *   - koboldcpp       KoboldCpp on configurable port
 *   - cloud           OpenAI-compatible cloud API
 *
 * Design principles:
 *   - A failed probe for one provider never blocks other providers.
 *   - Probe results update descriptor status fields in place.
 *   - All probe events emit structured telemetry.
 *   - Registry is extensible: any adapter implementing IProviderAdapter can be added.
 */

import http from 'http';
import https from 'https';
import path from 'path';
import fs from 'fs';
import type {
    InferenceProviderDescriptor,
    InferenceProviderType,
    InferenceProviderScope,
    InferenceTransportType,
    InferenceProviderHealth,
    InferenceProviderStatus,
    InferenceProviderCapabilities,
    ProviderProbeResult,
    InferenceProviderInventory,
} from '../../../shared/inferenceProviderTypes';
import { telemetry } from '../TelemetryService';

// ─── Default capabilities ─────────────────────────────────────────────────────

const LOCAL_CAPS: InferenceProviderCapabilities = {
    streaming: true,
    toolCalls: true,
    vision: false,
    embeddings: false,
};

const EMBEDDED_CAPS: InferenceProviderCapabilities = {
    streaming: true,
    toolCalls: false,
    vision: false,
    embeddings: false,
};

const CLOUD_CAPS: InferenceProviderCapabilities = {
    streaming: true,
    toolCalls: true,
    vision: true,
    embeddings: true,
};

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function probeHttpEndpoint(url: string, timeoutMs = 3000): Promise<{ ok: boolean; body: string; status: number }> {
    return new Promise((resolve) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { timeout: timeoutMs }, (res) => {
            let body = '';
            res.on('data', (c: Buffer) => (body += c.toString()));
            res.on('end', () => resolve({ ok: (res.statusCode ?? 0) < 400, body, status: res.statusCode ?? 0 }));
        });
        req.on('error', () => resolve({ ok: false, body: '', status: 0 }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: '', status: 0 }); });
    });
}

async function fetchJsonModels(endpoint: string, path_: string, key: string, timeoutMs = 3000): Promise<string[]> {
    const url = `${endpoint}${path_}`;
    const { ok, body } = await probeHttpEndpoint(url, timeoutMs);
    if (!ok) return [];
    try {
        const json = JSON.parse(body);
        const list = json[key];
        if (!Array.isArray(list)) return [];
        return list.map((m: any) => m?.name || m?.id || String(m)).filter(Boolean);
    } catch {
        return [];
    }
}

// ─── Provider probe functions ─────────────────────────────────────────────────

async function probeOllama(endpoint: string): Promise<ProviderProbeResult> {
    const start = Date.now();
    const { ok } = await probeHttpEndpoint(`${endpoint}/api/tags`, 3000);
    const responseTimeMs = Date.now() - start;
    if (!ok) {
        return { providerId: 'ollama', reachable: false, health: 'unavailable', status: 'not_running', models: [], responseTimeMs, error: 'Ollama endpoint not reachable' };
    }
    const models = await fetchJsonModels(endpoint, '/api/tags', 'models', 3000);
    return { providerId: 'ollama', reachable: true, health: 'healthy', status: 'ready', models, responseTimeMs };
}

async function probeLlamaCpp(endpoint: string): Promise<ProviderProbeResult> {
    const start = Date.now();
    const { ok } = await probeHttpEndpoint(`${endpoint}/health`, 3000);
    const responseTimeMs = Date.now() - start;
    if (!ok) {
        // Try root path as fallback
        const { ok: ok2 } = await probeHttpEndpoint(`${endpoint}/`, 3000);
        if (!ok2) {
            return { providerId: 'llamacpp', reachable: false, health: 'unavailable', status: 'not_running', models: [], responseTimeMs: Date.now() - start, error: 'llama.cpp endpoint not reachable' };
        }
    }
    const models = await fetchJsonModels(endpoint, '/v1/models', 'data', 3000);
    return { providerId: 'llamacpp', reachable: true, health: 'healthy', status: 'ready', models: models.length > 0 ? models : ['local-model'], responseTimeMs };
}

async function probeVllm(endpoint: string): Promise<ProviderProbeResult> {
    const start = Date.now();
    const { ok } = await probeHttpEndpoint(`${endpoint}/v1/models`, 3000);
    const responseTimeMs = Date.now() - start;
    if (!ok) {
        return { providerId: 'vllm', reachable: false, health: 'unavailable', status: 'not_running', models: [], responseTimeMs, error: 'vLLM endpoint not reachable' };
    }
    const models = await fetchJsonModels(endpoint, '/v1/models', 'data', 3000);
    return { providerId: 'vllm', reachable: true, health: 'healthy', status: 'ready', models, responseTimeMs };
}

async function probeKoboldCpp(endpoint: string): Promise<ProviderProbeResult> {
    const start = Date.now();
    const { ok } = await probeHttpEndpoint(`${endpoint}/api/v1/model`, 3000);
    const responseTimeMs = Date.now() - start;
    if (!ok) {
        return { providerId: 'koboldcpp', reachable: false, health: 'unavailable', status: 'not_running', models: [], responseTimeMs, error: 'KoboldCpp endpoint not reachable' };
    }
    return { providerId: 'koboldcpp', reachable: true, health: 'healthy', status: 'ready', models: [], responseTimeMs };
}

async function probeCloud(endpoint: string, apiKey?: string): Promise<ProviderProbeResult> {
    const start = Date.now();
    const url = `${endpoint}/v1/models`;
    const lib = url.startsWith('https') ? https : http;

    const result = await new Promise<{ ok: boolean; body: string }>((resolve) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        const req = lib.get(url, { headers, timeout: 5000 }, (res) => {
            let body = '';
            res.on('data', (c: Buffer) => (body += c.toString()));
            res.on('end', () => resolve({ ok: (res.statusCode ?? 0) < 400, body }));
        });
        req.on('error', () => resolve({ ok: false, body: '' }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, body: '' }); });
    });

    const responseTimeMs = Date.now() - start;
    if (!result.ok) {
        return { providerId: 'cloud', reachable: false, health: 'unavailable', status: 'not_running', models: [], responseTimeMs, error: 'Cloud endpoint not reachable' };
    }
    let models: string[] = [];
    try {
        const json = JSON.parse(result.body);
        if (Array.isArray(json.data)) models = json.data.map((m: any) => m.id).filter(Boolean);
    } catch { /* ignore */ }
    return { providerId: 'cloud', reachable: true, health: 'healthy', status: 'ready', models, responseTimeMs };
}

/** Probe embedded llama.cpp using the running port from LocalEngineService status. */
/** @internal Exported for direct unit testing without fs mocking. */
export async function probeEmbeddedLlamaCpp(
    enginePort: number,
    modelPath: string,
    binaryExists: boolean,
    modelExists: boolean,
): Promise<ProviderProbeResult> {
    const start = Date.now();

    if (!binaryExists || !modelExists) {
        return {
            providerId: 'embedded_llamacpp',
            reachable: false,
            health: binaryExists || modelExists ? 'degraded' : 'unavailable',
            status: 'not_running',
            models: modelPath ? [path.basename(modelPath)] : [],
            responseTimeMs: Date.now() - start,
            error: !binaryExists ? 'Embedded binary not found' : 'Embedded model not found',
        };
    }

    // Check if server is already running
    const { ok } = await probeHttpEndpoint(`http://127.0.0.1:${enginePort}/health`, 2000);
    const responseTimeMs = Date.now() - start;
    if (ok) {
        return {
            providerId: 'embedded_llamacpp',
            reachable: true,
            health: 'healthy',
            status: 'ready',
            models: modelPath ? [path.basename(modelPath)] : ['embedded-model'],
            responseTimeMs,
        };
    }

    // Not running but binary + model are present — it can be launched
    return {
        providerId: 'embedded_llamacpp',
        reachable: false,
        health: 'degraded',
        status: 'not_running',
        models: modelPath ? [path.basename(modelPath)] : [],
        responseTimeMs,
    };
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface ProviderRegistryConfig {
    ollama?: { endpoint?: string; enabled?: boolean };
    llamacpp?: { endpoint?: string; enabled?: boolean };
    embeddedLlamaCpp?: { port?: number; modelPath?: string; binaryPath?: string; enabled?: boolean };
    vllm?: { endpoint?: string; enabled?: boolean };
    koboldcpp?: { endpoint?: string; enabled?: boolean };
    cloud?: { endpoint?: string; apiKey?: string; model?: string; enabled?: boolean };
}

// ─── InferenceProviderRegistry ────────────────────────────────────────────────

export class InferenceProviderRegistry {
    private descriptors: Map<string, InferenceProviderDescriptor> = new Map();
    private selectedProviderId: string | undefined;
    private lastRefreshed: string = new Date(0).toISOString();
    private refreshing = false;

    constructor(private config: ProviderRegistryConfig = {}) {
        this._buildInitialDescriptors();
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /** Returns the current provider inventory snapshot. */
    public getInventory(): InferenceProviderInventory {
        return {
            providers: Array.from(this.descriptors.values()),
            selectedProviderId: this.selectedProviderId,
            lastRefreshed: this.lastRefreshed,
            refreshing: this.refreshing,
        };
    }

    /** Returns a single provider descriptor by ID. */
    public getProvider(providerId: string): InferenceProviderDescriptor | undefined {
        return this.descriptors.get(providerId);
    }

    /** Returns all descriptors with status 'ready'. */
    public getReadyProviders(): InferenceProviderDescriptor[] {
        return Array.from(this.descriptors.values()).filter(d => d.ready);
    }

    /** Sets the user-selected provider ID (does not validate readiness). */
    public setSelectedProviderId(id: string | undefined): void {
        this.selectedProviderId = id;
    }

    /** Returns the currently selected provider ID. */
    public getSelectedProviderId(): string | undefined {
        return this.selectedProviderId;
    }

    /**
     * Runs probes for all configured/enabled providers and updates the registry.
     * Failed probes do not block other probes.
     */
    public async refresh(turnId = 'global', agentMode = 'unknown'): Promise<InferenceProviderInventory> {
        this.refreshing = true;
        const probeResults = await this._runAllProbes(turnId, agentMode);

        for (const result of probeResults) {
            const desc = this.descriptors.get(result.providerId);
            if (!desc) continue;
            this._applyProbeResult(desc, result, turnId, agentMode);
        }

        this.lastRefreshed = new Date().toISOString();
        this.refreshing = false;

        telemetry.operational(
            'local_inference',
            'provider_inventory_refreshed',
            'info',
            'InferenceProviderRegistry',
            `Provider inventory refreshed — ${this.getReadyProviders().length} ready out of ${this.descriptors.size}`,
            'success',
            { turnId, mode: agentMode, payload: { readyCount: this.getReadyProviders().length, totalCount: this.descriptors.size } }
        );

        return this.getInventory();
    }

    /**
     * Updates registry config and rebuilds descriptors.
     * Call this when settings change.
     */
    public reconfigure(config: ProviderRegistryConfig): void {
        this.config = config;
        this._buildInitialDescriptors();
    }

    // ------------------------------------------------------------------
    // Private — build initial descriptors
    // ------------------------------------------------------------------

    private _buildInitialDescriptors(): void {
        this.descriptors.clear();

        const ollamaCfg = this.config.ollama;
        if (ollamaCfg?.enabled !== false) {
            this._register(_makeDescriptor({
                providerId: 'ollama',
                displayName: 'Ollama',
                providerType: 'ollama',
                scope: 'local',
                transport: 'http_ollama',
                endpoint: ollamaCfg?.endpoint || 'http://127.0.0.1:11434',
                priority: 10,
                capabilities: LOCAL_CAPS,
            }));
        }

        const llamaCfg = this.config.llamacpp;
        if (llamaCfg?.enabled !== false) {
            const ep = llamaCfg?.endpoint;
            if (ep) {
                this._register(_makeDescriptor({
                    providerId: 'llamacpp',
                    displayName: 'llama.cpp (external)',
                    providerType: 'llamacpp',
                    scope: 'local',
                    transport: 'http_openai_compat',
                    endpoint: ep,
                    priority: 20,
                    capabilities: LOCAL_CAPS,
                }));
            }
        }

        const embCfg = this.config.embeddedLlamaCpp;
        if (embCfg?.enabled !== false) {
            this._register(_makeDescriptor({
                providerId: 'embedded_llamacpp',
                displayName: 'Embedded llama.cpp',
                providerType: 'embedded_llamacpp',
                scope: 'embedded',
                transport: 'http_openai_compat',
                endpoint: `http://127.0.0.1:${embCfg?.port ?? 8080}`,
                priority: 30,
                capabilities: EMBEDDED_CAPS,
                preferredModel: embCfg?.modelPath ? path.basename(embCfg.modelPath) : undefined,
            }));
        }

        const vllmCfg = this.config.vllm;
        if (vllmCfg?.endpoint && vllmCfg?.enabled !== false) {
            this._register(_makeDescriptor({
                providerId: 'vllm',
                displayName: 'vLLM',
                providerType: 'vllm',
                scope: 'local',
                transport: 'http_openai_compat',
                endpoint: vllmCfg.endpoint,
                priority: 25,
                capabilities: LOCAL_CAPS,
            }));
        }

        const koboldCfg = this.config.koboldcpp;
        if (koboldCfg?.endpoint && koboldCfg?.enabled !== false) {
            this._register(_makeDescriptor({
                providerId: 'koboldcpp',
                displayName: 'KoboldCpp',
                providerType: 'koboldcpp',
                scope: 'local',
                transport: 'http_kobold',
                endpoint: koboldCfg.endpoint,
                priority: 40,
                capabilities: { streaming: true, toolCalls: false, vision: false, embeddings: false },
            }));
        }

        const cloudCfg = this.config.cloud;
        if (cloudCfg?.endpoint && cloudCfg?.enabled !== false) {
            this._register(_makeDescriptor({
                providerId: 'cloud',
                displayName: 'Cloud Provider',
                providerType: 'cloud',
                scope: 'cloud',
                transport: 'http_openai_compat',
                endpoint: cloudCfg.endpoint,
                priority: 100,
                capabilities: CLOUD_CAPS,
                apiKey: cloudCfg.apiKey,
                preferredModel: cloudCfg.model,
            }));
        }
    }

    private _register(desc: InferenceProviderDescriptor): void {
        this.descriptors.set(desc.providerId, desc);
    }

    // ------------------------------------------------------------------
    // Private — probing
    // ------------------------------------------------------------------

    private async _runAllProbes(turnId: string, agentMode: string): Promise<ProviderProbeResult[]> {
        const tasks = Array.from(this.descriptors.values()).map(desc =>
            this._probeOne(desc, turnId, agentMode)
                .catch(err => {
                    // Probe errors must not crash the registry
                    const probeError = err instanceof Error ? err.message : String(err);
                    telemetry.operational(
                        'local_inference',
                        'provider_probe_failed',
                        'warn',
                        'InferenceProviderRegistry',
                        `Probe for ${desc.providerId} threw unexpectedly: ${probeError}`,
                        'failure',
                        { turnId, mode: agentMode, payload: { providerId: desc.providerId, error: probeError } }
                    );
                    return {
                        providerId: desc.providerId,
                        reachable: false,
                        health: 'unavailable' as InferenceProviderHealth,
                        status: 'unavailable' as InferenceProviderStatus,
                        models: [],
                        responseTimeMs: 0,
                        error: probeError,
                    } satisfies ProviderProbeResult;
                })
        );
        return Promise.all(tasks);
    }

    private async _probeOne(desc: InferenceProviderDescriptor, turnId: string, agentMode: string): Promise<ProviderProbeResult> {
        let result: ProviderProbeResult;

        switch (desc.providerType) {
            case 'ollama':
                result = await probeOllama(desc.endpoint);
                result.providerId = desc.providerId;
                break;
            case 'llamacpp':
                result = await probeLlamaCpp(desc.endpoint);
                result.providerId = desc.providerId;
                break;
            case 'embedded_llamacpp': {
                const embCfg = this.config.embeddedLlamaCpp ?? {};
                const modelPath = embCfg.modelPath ?? '';
                const binaryPath = embCfg.binaryPath ?? '';
                const binaryExists = binaryPath ? fs.existsSync(binaryPath) : false;
                const modelExists = modelPath ? fs.existsSync(modelPath) : false;
                const port = embCfg.port ?? 8080;
                result = await probeEmbeddedLlamaCpp(port, modelPath, binaryExists, modelExists);
                result.providerId = desc.providerId;
                break;
            }
            case 'vllm':
                result = await probeVllm(desc.endpoint);
                result.providerId = desc.providerId;
                break;
            case 'koboldcpp':
                result = await probeKoboldCpp(desc.endpoint);
                result.providerId = desc.providerId;
                break;
            case 'cloud':
                result = await probeCloud(desc.endpoint, desc.apiKey);
                result.providerId = desc.providerId;
                break;
            default:
                result = { providerId: desc.providerId, reachable: false, health: 'unavailable', status: 'unavailable', models: [], responseTimeMs: 0, error: 'Unknown provider type' };
        }

        return result;
    }

    private _applyProbeResult(
        desc: InferenceProviderDescriptor,
        result: ProviderProbeResult,
        turnId: string,
        agentMode: string,
    ): void {
        const wasReady = desc.ready;
        desc.detected = result.reachable;
        desc.ready = result.status === 'ready';
        desc.health = result.health;
        desc.status = result.status;
        desc.lastProbed = new Date().toISOString();
        desc.lastProbeError = result.error;
        if (result.models.length > 0) desc.models = result.models;

        if (result.reachable && result.status === 'ready') {
            telemetry.operational(
                'local_inference',
                'provider_detected',
                'info',
                'InferenceProviderRegistry',
                `Provider ${desc.displayName} detected and ready (${result.responseTimeMs}ms)`,
                'success',
                { turnId, mode: agentMode, payload: { providerId: desc.providerId, providerType: desc.providerType, models: desc.models.slice(0, 5), responseTimeMs: result.responseTimeMs } }
            );
        } else if (!result.reachable && wasReady) {
            telemetry.operational(
                'local_inference',
                'provider_unavailable',
                'warn',
                'InferenceProviderRegistry',
                `Provider ${desc.displayName} is no longer available`,
                'failure',
                { turnId, mode: agentMode, payload: { providerId: desc.providerId, error: result.error } }
            );
        } else if (!result.reachable) {
            telemetry.operational(
                'local_inference',
                'provider_probe_failed',
                'warn',
                'InferenceProviderRegistry',
                `Provider ${desc.displayName} probe failed: ${result.error ?? 'unreachable'}`,
                'failure',
                { turnId, mode: agentMode, payload: { providerId: desc.providerId, error: result.error } }
            );
        }
    }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function _makeDescriptor(fields: {
    providerId: string;
    displayName: string;
    providerType: InferenceProviderType;
    scope: InferenceProviderScope;
    transport: InferenceTransportType;
    endpoint: string;
    priority: number;
    capabilities: InferenceProviderCapabilities;
    apiKey?: string;
    preferredModel?: string;
}): InferenceProviderDescriptor {
    return {
        ...fields,
        configured: true,
        detected: false,
        ready: false,
        health: 'unknown',
        status: 'configured',
        models: [],
    };
}
