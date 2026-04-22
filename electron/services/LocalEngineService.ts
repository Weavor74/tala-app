import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { resolveAppPath, resolveScratchPath } from './PathResolver';

/**
 * Local LLM Engine Service
 * 
 * Manages the lifecycle and orchestration of the built-in llama.cpp server.
 * This service enables TALA's "Offline Mode" by running GGUF models locally,
 * and provides facilities for automatic model and binary downloads.
 * 
 * **Security & Portability:**
 * - Operates entirely offline (no telemetry to external AI providers).
 * - Manages portable Python and binary runtimes for zero-install execution.
 * - Enforces context window constraints and GPU acceleration settings.
 */
export class LocalEngineService {
    private serverProcess: ChildProcess | null = null;
    private isRunning = false;
    private isDownloading = false;
    private downloadProgress = 0;
    private downloadTask = '';
    private port = 8080; // Default llama.cpp port
    private binaryPath: string;

    constructor() {
        this.binaryPath = this.findBinary();
    }

    /**
     * Attempts to locate the llama-server binary across common locations and extensions.
     */
    private findBinary(): string {
        const isWin = process.platform === 'win32';
        const binNames = isWin ? ['llama-server.exe'] : ['llama-server', 'llama-server.bin'];

        // Search locations:
        // 1. App binary folder (production bundle)
        // 2. Local workspace bin folder (development)
        const roots = [
            path.join(app.getAppPath(), 'bin'),
            resolveAppPath('bin')
        ];

        for (const root of roots) {
            for (const name of binNames) {
                const fullPath = path.join(root, name);
                if (fs.existsSync(fullPath)) {
                    console.log(`[LocalEngine] Found binary at: ${fullPath}`);
                    return fullPath;
                }
            }
        }

        // Return a default path even if not found yet (will throw in ignite)
        return path.join(app.getAppPath(), 'bin', binNames[0]);
    }

    /**
     * Spawns the llama.cpp server with the specified model and options.
     */
    public async ignite(modelPath: string, options: { port?: number; contextSize?: number; gpus?: number } = {}): Promise<void> {
        if (this.isRunning) {
            console.log('[LocalEngine] Server is already running.');
            return;
        }

        if (!fs.existsSync(modelPath)) {
            throw new Error(`Model file not found: ${modelPath}`);
        }

        // Re-verify binary exists before spawning
        if (!fs.existsSync(this.binaryPath)) {
            // Last ditch effort: refresh path
            this.binaryPath = this.findBinary();
            if (!fs.existsSync(this.binaryPath)) {
                throw new Error(`llama.cpp binary not found. Platforms supported: Windows (llama-server.exe), Unix (llama-server/llama-server.bin). Please place the binary in the 'bin/' folder.`);
            }
        }

        this.port = options.port || 8080;
        const ctx = options.contextSize || 4096;
        const ngl = options.gpus !== undefined ? options.gpus : 99; // Default to all layers on GPU if possible

        const args = [
            '-m', modelPath,
            '--port', this.port.toString(),
            '-c', ctx.toString(),
            '-ngl', ngl.toString(),
            '--embedding' // Enable embedding endpoint by default
        ];

        console.log(`[LocalEngine] Igniting llama.cpp server: ${this.binaryPath} ${args.join(' ')}`);

        this.serverProcess = spawn(this.binaryPath, args, {
            detached: false,
            stdio: 'pipe'
        });

        this.serverProcess.stdout?.on('data', (data) => {
            // console.log(`[LocalEngine OUT]: ${data}`);
        });

        this.serverProcess.stderr?.on('data', (data) => {
            const msg = data.toString();
            // console.log(`[LocalEngine ERR]: ${msg}`);
            // Various success messages across versions
            if (msg.includes('HTTP server listening') || msg.includes('HTTP server is listening') || msg.includes('llama server listening')) {
                this.isRunning = true;
                console.log('[LocalEngine] Server is ready and listening.');
            }
        });

        this.serverProcess.on('exit', (code) => {
            console.log(`[LocalEngine] Server exited with code ${code}`);
            this.isRunning = false;
            this.serverProcess = null;
        });

        // Wait for ready signal or timeout
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.isRunning) resolve();
                else reject(new Error('Local engine failed to start within 60 seconds.'));
            }, 60000);

            const checkReady = setInterval(() => {
                if (this.isRunning) {
                    clearTimeout(timeout);
                    clearInterval(checkReady);
                    resolve();
                }
            }, 500);
        });
    }

    /**
     * Shuts down the local engine.
     */
    public extinguish(): void {
        if (this.serverProcess) {
            console.log('[LocalEngine] Extinguishing server...');
            this.serverProcess.kill();
            this.serverProcess = null;
            this.isRunning = false;
        }
    }

    /**
     * Downloads the appropriate llama-server binary for the current platform.
     */
    public async downloadBinary(onProgress: (progress: number) => void): Promise<string> {
        const isWin = process.platform === 'win32';
        const isMac = process.platform === 'darwin';

        let url = '';
        if (isWin) {
            url = 'https://github.com/ggerganov/llama.cpp/releases/latest/download/llama-b3524-bin-win-vulkan-x64.zip'; // Example version
            // Actually, for USB portability, we might want a more generic one or just the server exe.
            // For now, let's use a known direct link to a server-heavy release.
            url = 'https://github.com/ggerganov/llama.cpp/releases/download/b3524/llama-b3524-bin-win-vulkan-x64.zip';
        } else if (isMac) {
            url = 'https://github.com/ggerganov/llama.cpp/releases/download/b3524/llama-b3524-bin-macos-arm64.zip';
        } else {
            url = 'https://github.com/ggerganov/llama.cpp/releases/download/b3524/llama-b3524-bin-ubuntu-x64.zip';
        }

        const binDir = resolveAppPath('bin');
        if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

        const zipPath = resolveScratchPath(path.join('downloads', 'llama-bin.zip'));
        fs.mkdirSync(path.dirname(zipPath), { recursive: true });
        console.log(`[LocalEngine] Downloading binary from ${url}...`);

        await this.downloadFile(url, zipPath, onProgress);

        // Extraction Logic
        console.log(`[LocalEngine] Extracting binary to ${binDir}...`);
        if (isWin) {
            // Use PowerShell to unzip on Windows
            const cmd = `Expand-Archive -Path "${zipPath}" -DestinationPath "${binDir}" -Force`;
            await new Promise((resolve, reject) => {
                const child = spawn('powershell.exe', ['-Command', cmd]);
                child.on('exit', (code) => {
                    if (code === 0) resolve(true);
                    else reject(new Error(`Extraction failed with code ${code}`));
                });
            });
        }

        // Cleanup zip
        try { fs.unlinkSync(zipPath); } catch (e) { }

        return binDir;
    }

    /**
     * Downloads a default GGUF model.
     */
    public async downloadModel(onProgress: (progress: number) => void): Promise<string> {
        // Llama-3.1-8B-Instruct-Q4_K_M.gguf (approx 4.9GB)
        const url = 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf';
        const modelDir = resolveAppPath('models');
        if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true });

        const dest = path.join(modelDir, 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf');
        console.log(`[LocalEngine] Downloading model to ${dest}...`);

        await this.downloadFile(url, dest, onProgress);
        return dest;
    }

    /**
     * Downloads a portable Python runtime for the current platform.
     */
    public async downloadPython(onProgress: (progress: number) => void): Promise<string> {
        const isWin = process.platform === 'win32';
        const isMac = process.platform === 'darwin';

        let url = '';
        if (isWin) {
            // Official Python 3.11.9 embeddable zip for Windows x64
            url = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip';
        } else if (isMac) {
            // For Mac, we often use a pre-built relocatable python
            url = 'https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-aarch64-apple-darwin-install_only.tar.gz';
        } else {
            url = 'https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-x86_64-unknown-linux-gnu-install_only.tar.gz';
        }

        const pythonDir = resolveAppPath(path.join('bin', 'python'));
        if (!fs.existsSync(pythonDir)) fs.mkdirSync(pythonDir, { recursive: true });

        const ext = isWin ? '.zip' : '.tar.gz';
        const dest = resolveScratchPath(path.join('downloads', `portable-python${ext}`));
        fs.mkdirSync(path.dirname(dest), { recursive: true });

        console.log(`[LocalEngine] Downloading portable Python from ${url}...`);
        await this.downloadFile(url, dest, onProgress);

        // Note: Post-download extraction logic would go here.
        // For a true zero-dependency "one-click", we'd use 'archiver' or native shell commands.

        return pythonDir;
    }

    private downloadFile(url: string, dest: string, onProgress: (progress: number) => void): Promise<void> {
        return new Promise((resolve, reject) => {
            const https = require('https');
            const file = fs.createWriteStream(dest);

            const request = (u: string) => {
                https.get(u, (res: any) => {
                    if (res.statusCode === 301 || res.statusCode === 302) {
                        return request(res.headers.location);
                    }
                    if (res.statusCode !== 200) {
                        reject(new Error(`Failed to download: ${res.statusCode}`));
                        return;
                    }

                    const totalSize = parseInt(res.headers['content-length'] || '0', 10);
                    let downloaded = 0;

                    res.on('data', (chunk: any) => {
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
                }).on('error', (err: any) => {
                    fs.unlink(dest, () => { });
                    reject(err);
                });
            };
            request(url);
        });
    }

    public getStatus() {
        return {
            isRunning: this.isRunning,
            isDownloading: this.isDownloading,
            downloadProgress: this.downloadProgress,
            downloadTask: this.downloadTask,
            port: this.port
        };
    }

    public async ensureReady(): Promise<boolean> {
        if (this.isRunning) return true;

        const modelDir = resolveAppPath('models');
        const defaultModel = path.join(modelDir, 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf');

        if (!fs.existsSync(this.binaryPath) || !fs.existsSync(defaultModel)) {
            this.isDownloading = true;
            try {
                if (!fs.existsSync(this.binaryPath)) {
                    this.downloadTask = 'Downloading Llama.cpp Binary';
                    await this.downloadBinary((p) => this.downloadProgress = p);
                }
                if (!fs.existsSync(defaultModel)) {
                    this.downloadTask = 'Downloading Model (4.9GB)';
                    await this.downloadModel((p) => this.downloadProgress = p);
                }
            } finally {
                this.isDownloading = false;
                this.downloadProgress = 0;
                this.downloadTask = '';
            }
        }
        return true;
    }
}
