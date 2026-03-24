import { ChildProcess, spawn } from 'child_process';
import path from 'path';

/**
 * WorldService
 * 
 * Manages the "World Engine" MCP server which provides structural workspace analysis.
 */
export class WorldService {
    private process: ChildProcess | null = null;
    private isReady: boolean = false;

    public async ignite(pythonPath: string, scriptPath: string, env: Record<string, string> = {}) {
        if (this.isReady) return;

        console.log(`[WorldService] Igniting World Engine at ${scriptPath}...`);

        this.process = spawn(pythonPath, [scriptPath], {
            env: { ...process.env, ...env },
            cwd: path.dirname(scriptPath)
        });

        this.process.stdout?.on('data', (data) => {
            console.log(`[WorldEngine] ${data}`);
        });

        this.process.stderr?.on('data', (data) => {
            console.error(`[WorldEngine Error] ${data}`);
        });

        this.process.on('close', (code) => {
            console.log(`[WorldEngine] Process exited with code ${code}`);
            this.isReady = false;
        });

        this.isReady = true;
        console.log('[WorldService] World Engine ignited successfully.');
    }

    /** Returns true when the World Engine process is running and ready. */
    public getReadyStatus(): boolean { return this.isReady; }

    public shutdown() {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
    }
}
