import { FileService } from './FileService';
import { TerminalService } from './TerminalService';
import { CodeAccessPolicy } from './CodeAccessPolicy';
import { auditLogger } from './AuditLogger';
import crypto from 'crypto';
import path from 'path';
import { exec } from 'child_process';

export class CodeControlService {
    constructor(
        private fileService: FileService,
        private terminalService: TerminalService,
        private policy: CodeAccessPolicy
    ) {
        this.fileService.setPolicy(this.policy);
        this.terminalService.setPolicy(this.policy);
    }

    private logAction(actionType: string, data: any) {
        const record = {
            action_type: actionType,
            ...data,
            duration_ms: data.duration || 0,
            timestamp: new Date().toISOString()
        };
        auditLogger.info('code_manipulation', 'CodeControlService', record);
    }

    private getHash(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    public async readText(relPath: string) {
        const start = Date.now();
        try {
            const content = await this.fileService.readFile(relPath);
            if (!this.policy.checkReadSize(Buffer.byteLength(content))) {
                throw new Error('File size exceeds 2MB limit.');
            }
            this.logAction('fs:readText', { path: relPath, bytes: Buffer.byteLength(content), duration: Date.now() - start });
            return { ok: true, content };
        } catch (e: any) {
            this.logAction('fs:readText:error', { path: relPath, error: e.message, duration: Date.now() - start });
            return { ok: false, error: e.message };
        }
    }

    public async writeText(relPath: string, content: string) {
        const start = Date.now();
        if (this.policy.getMode() === 'manual') {
            return { ok: false, error: 'Manual approval required for write operations.', requiresApproval: true, action: 'write', path: relPath };
        }
        try {
            await this.fileService.createFile(relPath, content);
            this.logAction('fs:writeText', { path: relPath, content_hash: this.getHash(content), duration: Date.now() - start });
            return { ok: true, path: relPath };
        } catch (e: any) {
            this.logAction('fs:writeText:error', { path: relPath, error: e.message, duration: Date.now() - start });
            return { ok: false, error: e.message };
        }
    }

    public async list(relPath: string = '') {
        const start = Date.now();
        try {
            const entries = await this.fileService.listDirectory(relPath);
            this.logAction('fs:list', { path: relPath, count: entries.length, duration: Date.now() - start });
            return { ok: true, entries };
        } catch (e: any) {
            return { ok: false, error: e.message };
        }
    }

    public async mkdir(relPath: string) {
        const start = Date.now();
        try {
            await this.fileService.createDirectory(relPath);
            this.logAction('fs:mkdir', { path: relPath, duration: Date.now() - start });
            return { ok: true };
        } catch (e: any) {
            return { ok: false, error: e.message };
        }
    }

    public async move(src: string, dst: string) {
        const start = Date.now();
        if (this.policy.getMode() === 'manual') {
            return { ok: false, error: 'Manual approval required for move operations.', requiresApproval: true, action: 'move', src, dst };
        }
        try {
            await this.fileService.movePath(src, dst);
            this.logAction('fs:move', { src, dst, duration: Date.now() - start });
            return { ok: true };
        } catch (e: any) {
            return { ok: false, error: e.message };
        }
    }

    public async delete(relPath: string) {
        const start = Date.now();
        if (this.policy.getMode() === 'manual') {
            return { ok: false, error: 'Manual approval required for delete operations.', requiresApproval: true, action: 'delete', path: relPath };
        }
        try {
            await this.fileService.deletePath(relPath);
            this.logAction('fs:delete', { path: relPath, duration: Date.now() - start });
            return { ok: true };
        } catch (e: any) {
            return { ok: false, error: e.message };
        }
    }

    public async search(query: string) {
        const start = Date.now();
        try {
            const results = await this.fileService.searchFiles(query);
            this.logAction('fs:search', { query, match_count: results.length, duration: Date.now() - start });
            return { ok: true, results };
        } catch (e: any) {
            return { ok: false, error: e.message };
        }
    }

    public async shellRun(command: string, cwd?: string) {
        console.log(`[CodeControlService] shellRun raw command: ${JSON.stringify(command)}`);
        const start = Date.now();
        if (!command || !command.trim()) {
            const err = new Error('Command cannot be empty');
            console.error(`[CodeControlService] ${err.message}`, err.stack?.split('\n').slice(0, 3).join('\n'));
            throw err;
        }
        const normalizedCmd = this.policy.normalizeCommand(command);

        if (this.policy.getMode() === 'manual') {
            return { ok: false, error: 'Manual approval required for shell execution.', requiresApproval: true, action: 'shell', command: normalizedCmd };
        }

        try {
            // Validate command via policy
            const vCmd = this.policy.validateCommand(normalizedCmd);
            if (!vCmd.ok) throw new Error(vCmd.error);

            // Execute via TerminalService or directly?
            // Requirement says Route through CodeControlService. 
            // We'll use child_process.exec for now as it captures output easily for agents.
            const workspaceRoot = this.policy.getWorkspaceRoot();
            const resolvedCwd = cwd ? path.resolve(workspaceRoot, cwd) : workspaceRoot;

            if (!resolvedCwd.startsWith(workspaceRoot)) {
                throw new Error('CWD must be within workspace root.');
            }

            return new Promise((resolve) => {
                exec(normalizedCmd, { cwd: resolvedCwd, timeout: 60000, env: process.env }, (error: any, stdout: string, stderr: string) => {
                    const duration = Date.now() - start;
                    const result = {
                        ok: !error,
                        exitCode: error ? error.code : 0,
                        stdout: stdout.trim(),
                        stderr: stderr.trim(),
                        duration
                    };
                    this.logAction('shell:run', { command: normalizedCmd, exitCode: result.exitCode, duration });
                    resolve(result);
                });
            });
        } catch (e: any) {
            this.logAction('shell:run:error', { command: normalizedCmd, error: e.message, duration: Date.now() - start });
            return { ok: false, error: e.message };
        }
    }
}
