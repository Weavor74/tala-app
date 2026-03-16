import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { app } from 'electron';
import { WebContents } from 'electron';
import { LocalEngineService } from './LocalEngineService';
import { LocalInferenceManager } from './LocalInferenceManager';
import { auditLogger } from './AuditLogger';
import { telemetry } from './TelemetryService';
import { InferenceProviderRegistry, type ProviderRegistryConfig } from './inference/InferenceProviderRegistry';
import { ProviderSelectionService } from './inference/ProviderSelectionService';
import type {
    InferenceSelectionRequest,
    InferenceSelectionResult,
    InferenceProviderInventory,
} from '../../shared/inferenceProviderTypes';

/**
 * Represents a local AI inference provider detected during a port scan.
 * @deprecated Use InferenceProviderDescriptor from shared/inferenceProviderTypes.ts.
 *   The registry-based InferenceService.refreshProviders() path supersedes scanLocal().
 */
export interface ScannedProvider {
    engine: 'ollama' | 'llamacpp' | 'vllm';
    endpoint: string;
    models: string[];
}

/**
 * InferenceService — Canonical Inference Coordinator
 *
 * Acts as the single authoritative gate for all inference operations in TALA.
 *
 * Responsibilities:
 * - Provider registry management (via InferenceProviderRegistry)
 * - Deterministic provider selection and fallback (via ProviderSelectionService)
 * - Lifecycle management of the embedded llama.cpp engine (via LocalInferenceManager)
 * - Legacy provider scan API for backward compatibility
 * - Installer flows for external providers (Ollama)
 *
 * Every inference request that touches a local provider must call
 * `selectProvider()` to obtain a validated InferenceSelectionResult before
 * executing. AgentService should never directly probe or switch providers.
 */
export class InferenceService {

    /** Legacy embedded engine — kept for IPC handlers that manage it directly. */
    private localEngine: LocalEngineService = new LocalEngineService();

    /**
     * Hardened lifecycle manager for the embedded llama.cpp engine.
     * Authoritative for embedded provider readiness checks, timeouts, and retries.
     */
    private localInferenceManager: LocalInferenceManager;

    /** Provider registry — source of truth for all known/detected providers. */
    private registry: InferenceProviderRegistry;

    /** Deterministic provider selection policy. */
    private selectionService: ProviderSelectionService;

    constructor(registryConfig?: ProviderRegistryConfig) {
        this.localInferenceManager = new LocalInferenceManager(this.localEngine);
        this.registry = new InferenceProviderRegistry(registryConfig ?? {});
        this.selectionService = new ProviderSelectionService(this.registry);
    }

    // ─── Public — registry / selection API ───────────────────────────────────

    /**
     * Returns the current provider inventory.
     * Safe to call at any time; does not run probes.
     */
    public getProviderInventory(): InferenceProviderInventory {
        return this.registry.getInventory();
    }

    /**
     * Runs provider probes and refreshes the registry.
     * Should be called at startup and when settings change.
     */
    public async refreshProviders(turnId?: string, agentMode?: string): Promise<InferenceProviderInventory> {
        return this.registry.refresh(turnId, agentMode);
    }

    /**
     * Selects the best available provider according to the deterministic policy.
     * Use this before every real inference request.
     */
    public selectProvider(req: InferenceSelectionRequest = {}): InferenceSelectionResult {
        return this.selectionService.select(req);
    }

    /**
     * Sets the user-selected provider ID in the registry.
     * Validated on the next selectProvider() call.
     */
    public setSelectedProvider(providerId: string | undefined): void {
        this.registry.setSelectedProviderId(providerId);

        telemetry.operational(
            'local_inference',
            'provider_selected',
            'info',
            'InferenceService',
            `User selected provider: ${providerId ?? '(cleared)'}`,
            'success',
            { payload: { providerId } }
        );
    }

    /**
     * Reconfigures the provider registry (e.g., when settings change).
     */
    public reconfigureRegistry(config: ProviderRegistryConfig): void {
        this.registry.reconfigure(config);
    }

    // ─── Public — embedded engine management ─────────────────────────────────

    /**
     * Returns the LocalInferenceManager for the embedded llama.cpp engine.
     * IPC handlers and AgentService use this for embedded engine lifecycle.
     */
    public getLocalInferenceManager(): LocalInferenceManager {
        return this.localInferenceManager;
    }

    /**
     * Returns the legacy LocalEngineService.
     * @deprecated Prefer getLocalInferenceManager() for state-managed access.
     */
    public getLocalEngine(): LocalEngineService {
        return this.localEngine;
    }

    // ─── Legacy — backward-compatible scan ───────────────────────────────────

    /**
     * Scans the host machine for active AI inference providers.
     *
     * @deprecated Use refreshProviders() + getProviderInventory() for the
     *   registry-based path. This method is retained for backward-compatibility
     *   with existing IPC handler callers.
     *
     * @returns A list of detected providers and their supported models.
     */
    public async scanLocal(): Promise<ScannedProvider[]> {
        const found: ScannedProvider[] = [];

        // 1. Built-in Engine
        const localStatus = this.localEngine.getStatus();
        if (localStatus.isRunning) {
            const models = await this._fetchOpenAIModels(`http://127.0.0.1:${localStatus.port}`);
            found.push({
                engine: 'llamacpp',
                endpoint: `http://127.0.0.1:${localStatus.port}`,
                models: models.length > 0 ? models : ['tala-built-in'],
            });
        }

        // 2. Ollama (11434)
        if (await this._checkPort(11434)) {
            const models = await this._fetchOllamaModels('http://127.0.0.1:11434');
            found.push({
                engine: 'ollama',
                endpoint: 'http://127.0.0.1:11434',
                models: models.length > 0 ? models : ['llama3:latest'],
            });
        }

        // 3. Llama.cpp / LocalAI (8080)
        if (await this._checkPort(8080) && localStatus.port !== 8080) {
            const models = await this._fetchOpenAIModels('http://127.0.0.1:8080');
            found.push({
                engine: 'llamacpp',
                endpoint: 'http://127.0.0.1:8080',
                models: models.length > 0 ? models : ['gpt-3.5-turbo'],
            });
        }

        // 4. LM Studio / vLLM (1234)
        if (await this._checkPort(1234)) {
            const models = await this._fetchOpenAIModels('http://127.0.0.1:1234');
            found.push({
                engine: 'vllm',
                endpoint: 'http://127.0.0.1:1234',
                models: models.length > 0 ? models : ['local-model'],
            });
        }

        auditLogger.info('engine_scan_results', 'InferenceService', {
            count: found.length,
            providers: found.map(p => ({ engine: p.engine, endpoint: p.endpoint })),
        });

        return found;
    }

    // ─── Engine installer ─────────────────────────────────────────────────────

    /**
     * Triggers an automated installation flow for an inference engine.
     * Currently supports Ollama on Windows.
     */
    public async installEngine(engineId: string, webContents?: WebContents): Promise<{ success: boolean; error?: string }> {
        if (engineId !== 'ollama') {
            return { success: false, error: 'Installation currently only supported for Ollama.' };
        }

        const url = 'https://ollama.com/download/OllamaSetup.exe';
        const tempDir = app.getPath('temp');
        const dest = path.join(tempDir, 'OllamaSetup.exe');

        try {
            console.log(`[Inference] Starting download: ${url}`);
            await this._downloadFile(url, dest, (progress) => {
                if (webContents) {
                    webContents.send('install-progress', { engineId, progress });
                }
            });

            console.log(`[Inference] Launching installer: ${dest}`);
            const child = spawn(dest, [], { detached: true, stdio: 'ignore' });
            child.unref();

            auditLogger.info('engine_install_start', 'InferenceService', { engineId });
            return { success: true };
        } catch (e: any) {
            auditLogger.error('engine_install_fail', 'InferenceService', { engineId, error: e.message });
            console.error('[Inference] Installation failed:', e);
            return { success: false, error: e.message };
        }
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private _checkPort(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            http.get(`http://127.0.0.1:${port}/`, () => resolve(true)).on('error', () => resolve(false)).end();
        });
    }

    private async _fetchOllamaModels(endpoint: string): Promise<string[]> {
        return new Promise((resolve) => {
            http.get(`${endpoint}/api/tags`, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => (data += chunk));
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve(Array.isArray(json.models) ? json.models.map((m: any) => m.name) : []);
                    } catch { resolve([]); }
                });
            }).on('error', () => resolve([]));
        });
    }

    private async _fetchOpenAIModels(endpoint: string): Promise<string[]> {
        return new Promise((resolve) => {
            http.get(`${endpoint}/v1/models`, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => (data += chunk));
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve(Array.isArray(json.data) ? json.data.map((m: any) => m.id) : []);
                    } catch { resolve([]); }
                });
            }).on('error', () => resolve([]));
        });
    }

    private _downloadFile(url: string, dest: string, onProgress: (progress: number) => void): Promise<void> {
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(dest);
            https.get(url, (res) => {
                if (res.statusCode !== 200) { reject(new Error(`Failed to download: ${res.statusCode}`)); return; }
                const totalSize = parseInt(res.headers['content-length'] || '0', 10);
                let downloaded = 0;
                res.on('data', (chunk: Buffer) => {
                    downloaded += chunk.length;
                    if (totalSize > 0) onProgress(Math.round((downloaded / totalSize) * 100));
                });
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
            }).on('error', (err: Error) => { fs.unlink(dest, () => { }); reject(err); });
        });
    }
}
