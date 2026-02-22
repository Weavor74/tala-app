import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { app } from 'electron';
import { WebContents } from 'electron';
import { LocalEngineService } from './LocalEngineService';

/**
 * Represents a local AI inference provider detected during a port scan.
 * Contains the engine type, its base endpoint URL, and the list of
 * available models discovered via the engine's API.
 */
export interface ScannedProvider {
    /** The inference engine type — determines the API format used (`ollama`, `llamacpp`, or `vllm`). */
    engine: 'ollama' | 'llamacpp' | 'vllm';
    /** The base HTTP endpoint URL (e.g., `'http://127.0.0.1:11434'` for Ollama). */
    endpoint: string;
    /** Array of model names/IDs available on this engine (e.g., `['llama3:latest', 'codellama:7b']`). */
    models: string[];
}

/**
 * InferenceService
 * 
 * Detects and manages local AI inference providers running on the user's machine.
 * Supports automatic discovery of Ollama, Llama.cpp, LM Studio, and other
 * OpenAI-compatible inference engines via port scanning.
 * 
 * **Supported engines and their default ports:**
 * | Engine | Port | API Format |
 * |--------|------|------------|
 * | Ollama | 11434 | Ollama native (`/api/tags`) |
 * | Llama.cpp / LocalAI | 8080 | OpenAI-compatible (`/v1/models`) |
 * | LM Studio / vLLM | 1234 | OpenAI-compatible (`/v1/models`) |
 * 
 * **How it works:**
 * 1. `scanLocal()` sends HTTP requests to known ports on `127.0.0.1`.
 * 2. For each responsive port, queries the engine-specific API to list models.
 * 3. Returns an array of `ScannedProvider` objects that can be presented to the user.
 * 
 * Additionally supports one-click Ollama installation via `installEngine()`.
 * 
 * @example
 * ```typescript
 * const inference = new InferenceService();
 * const providers = await inference.scanLocal();
 * console.log(providers); // [{ engine: 'ollama', endpoint: '...', models: ['llama3:latest'] }]
 * ```
 */
export class InferenceService {

    /**
     * Performs a quick TCP health check on a local port.
     * 
     * Sends an HTTP GET request to `http://127.0.0.1:{port}/`. If any response
     * is received (including 404, 500, etc.), the port is considered open.
     * Only network-level errors (connection refused, timeout) return `false`.
     * 
     * @private
     * @param {number} port - The port number to check.
     * @returns {Promise<boolean>} `true` if something is listening on the port.
     */
    private checkPort(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
                // If we get any response, something is there.
                // 404 is fine (Ollama root returns 'Ollama is running')
                resolve(true);
            }).on('error', () => resolve(false));
            req.end();
        });
    }

    /**
     * Fetches the list of available models from an Ollama instance.
     * 
     * Queries the Ollama-specific `/api/tags` endpoint, which returns a JSON
     * object with a `models` array containing objects like `{ name: 'llama3:latest' }`.
     * 
     * @private
     * @param {string} endpoint - The base Ollama endpoint (e.g., `'http://127.0.0.1:11434'`).
     * @returns {Promise<string[]>} Array of model name strings. Returns empty array on error.
     */
    private async fetchOllamaModels(endpoint: string): Promise<string[]> {
        return new Promise((resolve) => {
            http.get(`${endpoint}/api/tags`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        // Ollama returns { models: [ { name: 'llama3:latest' }, ... ] }
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

    /**
     * Fetches the list of available models from an OpenAI-compatible inference server.
     * 
     * Queries the standard `/v1/models` endpoint used by Llama.cpp, LM Studio,
     * vLLM, LocalAI, and other OpenAI-compatible servers. Returns a JSON object
     * with a `data` array containing objects like `{ id: 'model-name' }`.
     * 
     * @private
     * @param {string} endpoint - The base server endpoint (e.g., `'http://127.0.0.1:8080'`).
     * @returns {Promise<string[]>} Array of model ID strings. Returns empty array on error.
     */
    private async fetchOpenAIModels(endpoint: string): Promise<string[]> {
        return new Promise((resolve) => {
            http.get(`${endpoint}/v1/models`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        // OpenAI / LM Studio / LlamaCpp returns { data: [ { id: 'model-name' }, ... ] }
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

    /**
     * Returns the built-in local engine service.
     */
    public getLocalEngine(): LocalEngineService {
        return this.localEngine;
    }

    /**
     * Scans the local machine for running AI inference providers.
     * 
     * Checks well-known ports in sequence:
     * 1. **Built-in Engine (Default port)** — checks if internal llama.cpp is running.
     * 2. **Port 11434** (Ollama) — queries `/api/tags` for model list.
     * 3. **Port 8080** (Llama.cpp / LocalAI) — queries `/v1/models` for model list.
     * 4. **Port 1234** (LM Studio / vLLM / custom) — queries `/v1/models` for model list.
     * 
     * For each responsive port, if no models are found via the API, a sensible
     * fallback model name is provided.
     * 
     * @returns {Promise<ScannedProvider[]>} Array of detected providers with their
     *   engines, endpoints, and available models. Empty array if nothing found.
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
                models: models.length > 0 ? models : ['llama3:latest'] // fallback
            });
        }

        // 3. Check Llama.cpp / LocalAI (8080)
        // Skip if builtin is already on 8080
        if (await this.checkPort(8080) && localStatus.port !== 8080) {
            const models = await this.fetchOpenAIModels('http://127.0.0.1:8080');
            found.push({
                engine: 'llamacpp',
                endpoint: 'http://127.0.0.1:8080',
                models: models.length > 0 ? models : ['gpt-3.5-turbo'] // fallback
            });
        }

        // 4. Check LM Studio / Others (1234)
        if (await this.checkPort(1234)) {
            const models = await this.fetchOpenAIModels('http://127.0.0.1:1234');
            found.push({
                engine: 'vllm', // treat generic OpenAI compatible as vllm/custom
                endpoint: 'http://127.0.0.1:1234',
                models: models.length > 0 ? models : ['local-model']
            });
        }

        return found;
    }

    /**
     * Downloads and launches the installer for a local inference engine.
     * 
     * Currently only supports Ollama on Windows. Downloads `OllamaSetup.exe`
     * from the official URL to the temp directory, then launches the installer
     * as a detached process so the user can complete the interactive setup.
     * 
     * Progress updates are sent to the renderer via `webContents.send('install-progress')`
     * to display a download progress bar in the UI.
     * 
     * @param {string} engineId - The engine to install (only `'ollama'` is supported).
     * @param {WebContents} [webContents] - Optional Electron WebContents for sending
     *   progress updates to the renderer process.
     * @returns {Promise<{ success: boolean; error?: string }>} Result object indicating
     *   success or failure with an error message.
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
            // Launch the installer. On Windows, we can't easily do a truly "silent" install 
            // of the interactive OllamaSetup.exe without special flags, 
            // so we just launch it for the user.
            const child = spawn(dest, [], {
                detached: true,
                stdio: 'ignore'
            });
            child.unref();

            return { success: true };
        } catch (e: any) {
            console.error('[Inference] Installation failed:', e);
            return { success: false, error: e.message };
        }
    }

    /**
     * Downloads a file from a URL to a local destination with progress reporting.
     * 
     * Uses HTTPS GET with streaming to download the file. If the server provides
     * a `Content-Length` header, progress is reported as a percentage (0–100).
     * On error, the partially downloaded file is cleaned up via `fs.unlink()`.
     * 
     * @private
     * @param {string} url - The HTTPS URL to download from.
     * @param {string} dest - The absolute local file path to save the download to.
     * @param {Function} onProgress - Callback invoked with download progress (0–100).
     * @returns {Promise<void>} Resolves when the download is complete.
     * @throws {Error} If the HTTP status is not 200 or a network error occurs.
     */
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
