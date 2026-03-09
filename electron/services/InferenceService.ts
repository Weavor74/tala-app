import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { app } from 'electron';
import { WebContents } from 'electron';
import { LocalEngineService } from './LocalEngineService';
import { auditLogger } from './AuditLogger';

/**
 * Represents a local AI inference provider detected during a port scan.
 */
export interface ScannedProvider {
    engine: 'ollama' | 'llamacpp' | 'vllm';
    endpoint: string;
    models: string[];
}

/**
 * Local AI Inference Orchestrator.
 * 
 * The `InferenceService` is responsible for detecting and managing local 
 * LLM runners on the user's host machine. It acts as a discovery layer 
 * that allows Tala to use various backends (Ollama, Llama.cpp, vLLM) 
 * without manual configuration.
 * 
 * **Core Responsibilities:**
 * - **Provider Discovery**: Scans standard ports (11434, 8080, 1234) to 
 *   identify active inference engines and their available models.
 * - **Built-in Management**: Controls the lifecycle of the internal 
 *   `LocalEngineService` (bundled Llama.cpp).
 * - **Streamlined Installation**: Provides automated download and launch 
 *   flows for external runners like Ollama.
 * - **Audit Integration**: Logs detection results for system transparency.
 */
export class InferenceService {

    private checkPort(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
                resolve(true);
            }).on('error', () => resolve(false));
            req.end();
        });
    }

    private async fetchOllamaModels(endpoint: string): Promise<string[]> {
        return new Promise((resolve) => {
            http.get(`${endpoint}/api/tags`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.models && Array.isArray(json.models)) {
                            resolve(json.models.map((m: any) => m.name));
                        } else {
                            resolve([]);
                        }
                    } catch (e) {
                        resolve([]);
                    }
                });
            }).on('error', () => resolve([]));
        });
    }

    private async fetchOpenAIModels(endpoint: string): Promise<string[]> {
        return new Promise((resolve) => {
            http.get(`${endpoint}/v1/models`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.data && Array.isArray(json.data)) {
                            resolve(json.data.map((m: any) => m.id));
                        } else {
                            resolve([]);
                        }
                    } catch (e) {
                        resolve([]);
                    }
                });
            }).on('error', () => resolve([]));
        });
    }

    private localEngine: LocalEngineService = new LocalEngineService();

    public getLocalEngine(): LocalEngineService {
        return this.localEngine;
    }

    /**
     * Scans the host machine for active AI inference providers.
     * 
     * **Probing Sequence:**
     * 1. **Built-in**: Checks the internal `llamacpp` engine status.
     * 2. **Ollama**: Probes port 11434 and fetches available tags.
     * 3. **Llama.cpp/LocalAI**: Probes port 8080 for OpenAI-compatible endpoints.
     * 4. **LM Studio/vLLM**: Probes port 1234 for OpenAI-compatible endpoints.
     * 
     * All results are aggregated into `ScannedProvider` objects and logged 
     * to the `AuditLogger`.
     * 
     * @returns A list of detected providers and their supported models.
     */
    public async scanLocal(): Promise<ScannedProvider[]> {
        const found: ScannedProvider[] = [];

        // 1. Check Built-in Engine
        const localStatus = this.localEngine.getStatus();
        if (localStatus.isRunning) {
            const models = await this.fetchOpenAIModels(`http://127.0.0.1:${localStatus.port}`);
            found.push({
                engine: 'llamacpp',
                endpoint: `http://127.0.0.1:${localStatus.port}`,
                models: models.length > 0 ? models : ['tala-built-in']
            });
        }

        // 2. Check Ollama (11434)
        if (await this.checkPort(11434)) {
            const models = await this.fetchOllamaModels('http://127.0.0.1:11434');
            found.push({
                engine: 'ollama',
                endpoint: 'http://127.0.0.1:11434',
                models: models.length > 0 ? models : ['llama3:latest']
            });
        }

        // 3. Check Llama.cpp / LocalAI (8080)
        if (await this.checkPort(8080) && localStatus.port !== 8080) {
            const models = await this.fetchOpenAIModels('http://127.0.0.1:8080');
            found.push({
                engine: 'llamacpp',
                endpoint: 'http://127.0.0.1:8080',
                models: models.length > 0 ? models : ['gpt-3.5-turbo']
            });
        }

        // 4. Check LM Studio / Others (1234)
        if (await this.checkPort(1234)) {
            const models = await this.fetchOpenAIModels('http://127.0.0.1:1234');
            found.push({
                engine: 'vllm',
                endpoint: 'http://127.0.0.1:1234',
                models: models.length > 0 ? models : ['local-model']
            });
        }

        auditLogger.info('engine_scan_results', 'InferenceService', {
            count: found.length,
            providers: found.map(p => ({ engine: p.engine, endpoint: p.endpoint }))
        });

        return found;
    }

    /**
     * Triggers an automated installation flow for an inference engine.
     * 
     * Currently supports **Ollama** on Windows.
     * 
     * **Workflow:**
     * 1. Downloads the installer to the system temp directory.
     * 2. Emits `install-progress` events to the UI.
     * 3. Spawns the installer process in detached mode.
     * 
     * @param engineId - The ID of the engine to install (e.g., 'ollama').
     * @param webContents - Optional Electron window for sending progress updates.
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
            await this.downloadFile(url, dest, (progress) => {
                if (webContents) {
                    webContents.send('install-progress', { engineId, progress });
                }
            });

            console.log(`[Inference] Launching installer: ${dest}`);
            const child = spawn(dest, [], {
                detached: true,
                stdio: 'ignore'
            });
            child.unref();

            auditLogger.info('engine_install_start', 'InferenceService', { engineId });
            return { success: true };
        } catch (e: any) {
            auditLogger.error('engine_install_fail', 'InferenceService', { engineId, error: e.message });
            console.error('[Inference] Installation failed:', e);
            return { success: false, error: e.message };
        }
    }

    private downloadFile(url: string, dest: string, onProgress: (progress: number) => void): Promise<void> {
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(dest);
            https.get(url, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Failed to download: ${res.statusCode}`));
                    return;
                }

                const totalSize = parseInt(res.headers['content-length'] || '0', 10);
                let downloaded = 0;

                res.on('data', (chunk) => {
                    downloaded += chunk.length;
                    if (totalSize > 0) {
                        onProgress(Math.round((downloaded / totalSize) * 100));
                    }
                });

                res.pipe(file);

                file.on('finish', () => {
                    file.close();
                    resolve();
                });
            }).on('error', (err) => {
                fs.unlink(dest, () => { });
                reject(err);
            });
        });
    }
}
