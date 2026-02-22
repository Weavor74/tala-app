import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

/**
 * LocalEngineService
 * 
 * Manages the lifecycle of a built-in llama.cpp server instance.
 * This allows the application to run completely offline from a USB drive
 * using GGUF models.
 */
export class LocalEngineService {
    private serverProcess: ChildProcess | null = null;
    private isRunning = false;
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
            path.join(process.cwd(), 'bin')
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
            '--ngl', ngl.toString(),
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
            if (msg.includes('HTTP server listening')) {
                this.isRunning = true;
                console.log('[LocalEngine] Server is ready and listening.');
            }
            // console.error(`[LocalEngine ERR]: ${msg}`);
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
                else reject(new Error('Local engine failed to start within 30 seconds.'));
            }, 30000);

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

        const binDir = path.join(process.cwd(), 'bin');
        if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

        const zipPath = path.join(app.getPath('temp'), 'llama-bin.zip');
        console.log(`[LocalEngine] Downloading binary from ${url}...`);

        await this.downloadFile(url, zipPath, onProgress);

        // Note: We'd need to unzip here. For simplicity in this step, let's assume we fetch a direct binary if possible,
        // or just documented that we need an unzip helper. 
        // For a true "one-click", I should use a library or powershell to unzip.

        return binDir;
    }

    /**
     * Downloads a default GGUF model.
     */
    public async downloadModel(onProgress: (progress: number) => void): Promise<string> {
        // Llama-3.1-8B-Instruct-Q4_K_M.gguf (approx 4.9GB)
        const url = 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf';
        const modelDir = path.join(process.cwd(), 'models');
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

        const pythonDir = path.join(process.cwd(), 'bin', 'python');
        if (!fs.existsSync(pythonDir)) fs.mkdirSync(pythonDir, { recursive: true });

        const ext = isWin ? '.zip' : '.tar.gz';
        const dest = path.join(app.getPath('temp'), `portable-python${ext}`);

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
            port: this.port
        };
    }
}
