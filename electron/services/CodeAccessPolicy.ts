import path from 'path';
import { minimatch } from 'minimatch';

export interface CodeAccessPolicyOptions {
    workspaceRoot: string;
    allowedExtensions?: string[];
    deniedPaths?: string[];
    maxReadSize?: number;
    mode?: 'auto' | 'manual';
}

export class CodeAccessPolicy {
    private workspaceRoot: string;
    private allowedExtensions: Set<string>;
    private deniedPaths: string[];
    private maxReadSize: number;
    private mode: 'auto' | 'manual';

    private static DEFAULT_EXTENSIONS = [
        '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.ps1', '.bat',
        '.sh', '.json', '.jsonl', '.md', '.yml', '.yaml', '.toml', '.ini',
        '.sql', '.txt'
    ];

    private static DEFAULT_DENIED = [
        'node_modules/**',
        '.git/**',
        'bin/**', // Modified handling below for read-only exceptions
        '**/*.exe',
        '**/*.dll',
        '**/*.pyd',
        '**/*.so',
        '**/*.db'
    ];

    private allowedBaseCommands = [
        'npm', 'node', 'npx', 'python', 'pip', 'git', 'tsc', 'eslint', 'vitest', 'pytest',
        'ls', 'dir', 'cd', 'mkdir', 'echo', 'type', 'cat', 'grep', 'find'
    ];

    constructor(options: CodeAccessPolicyOptions) {
        this.workspaceRoot = path.resolve(options.workspaceRoot);
        this.allowedExtensions = new Set(options.allowedExtensions || CodeAccessPolicy.DEFAULT_EXTENSIONS);
        this.deniedPaths = options.deniedPaths || CodeAccessPolicy.DEFAULT_DENIED;
        this.maxReadSize = options.maxReadSize || 2 * 1024 * 1024; // 2MB
        this.mode = options.mode || 'auto';
    }

    public getMode() { return this.mode; }
    public setMode(mode: 'auto' | 'manual') { this.mode = mode; }
    public getWorkspaceRoot() { return this.workspaceRoot; }

    /**
     * Resolves and validates a path against the workspace root and denied patterns.
     */
    public validatePath(relPath: string, operation: 'read' | 'write' | 'delete' = 'read'): { ok: boolean, fullPath: string, error?: string } {
        const fullPath = path.resolve(this.workspaceRoot, relPath);

        // 1. Root Anchor Check
        if (!fullPath.startsWith(this.workspaceRoot)) {
            return { ok: false, fullPath, error: 'Path traversal escape blocked: outside workspace root.' };
        }

        const normalizedRel = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');

        // 2. Extension Check (for files)
        const ext = path.extname(fullPath).toLowerCase();
        if (ext && !this.allowedExtensions.has(ext)) {
            return { ok: false, fullPath, error: `Extension ${ext} is not allowed.` };
        }

        // 3. Denied Paths Check
        for (const pattern of this.deniedPaths) {
            if (minimatch(normalizedRel, pattern, { dot: true })) {
                // Special case: bin/python-win is read-only
                if (operation === 'read' && normalizedRel.startsWith('bin/python-win/')) {
                    continue;
                }
                return { ok: false, fullPath, error: `Path matches denied pattern: ${pattern}` };
            }
        }

        return { ok: true, fullPath };
    }

    /**
     * Validates a shell command against the allowlist and denylist.
     */
    public validateCommand(command: string): { ok: boolean, error?: string } {
        const trimmed = command.trim();
        if (!trimmed) return { ok: false, error: 'Empty command.' };

        const base = trimmed.split(/\s+/)[0].toLowerCase();

        // 1. Deny dangerous patterns
        const dangerous = [
            'rm -rf /', '> /etc/', '> c:\\windows', 'format ', 'mkfs', 'dd ',
            'wget ', 'curl ', 'ssh ', 'scp ' // exfil prevention
        ];
        if (dangerous.some(p => trimmed.toLowerCase().includes(p))) {
            return { ok: false, error: 'Potentially destructive or global command blocked.' };
        }

        // 2. Allowlist check
        if (!this.allowedBaseCommands.includes(base) && !base.startsWith('.') && !base.startsWith('/')) {
            return { ok: false, error: 'Command not in safety whitelist.' };
        }

        return { ok: true };
    }

    public checkReadSize(size: number): boolean {
        return size <= this.maxReadSize;
    }
}
