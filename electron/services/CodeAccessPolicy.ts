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

    private allowedPrefixes = [
        'npm', 'node', 'npx', 'python', 'pip', 'git', 'tsc', 'eslint', 'vitest', 'pytest',
        'ls', 'dir', 'cd', 'mkdir', 'echo', 'type', 'cat', 'grep', 'find',
        'python.exe', '.\\scripts\\',
        // Common full paths for bundled binaries
        'D:\\src\\client1\\tala-app\\bin\\python-win\\python.exe'
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
     * Normalizes a shell command string by trimming, collapsing whitespace,
     * and stripping wrapping quotes.
     */
    public normalizeCommand(command: string): string {
        let cmd = (command || '').trim();
        // Collapse multiple whitespaces
        cmd = cmd.replace(/\s+/g, ' ');
        // Strip wrapping quotes (e.g. "npm run lint" -> npm run lint)
        if ((cmd.startsWith('"') && cmd.endsWith('"')) || (cmd.startsWith("'") && cmd.endsWith("'"))) {
            cmd = cmd.substring(1, cmd.length - 1);
        }
        return cmd;
    }

    /**
     * Validates a shell command against the allowlist and denylist.
     * Expects a normalized command.
     */
    public validateCommand(command: string): { ok: boolean, error?: string } {
        if (!command) return { ok: false, error: 'Command cannot be empty' };

        const lowerCmd = command.toLowerCase();

        // 1. Block shell chaining / redirection operators anywhere in the command
        // This prevents injection via: cmd1 && cmd2, cmd1 || cmd2, cmd1 | cmd2,
        // cmd1 ; cmd2, cmd > file, cmd < file, cmd &
        // Note: we allow '>' only inside quoted strings would require a full parser;
        // for safety we block unconditionally since agent commands should be atomic.
        const CHAIN_OPS = /[&|;<>]/;
        if (CHAIN_OPS.test(command)) {
            return { ok: false, error: 'Command chaining/redirection operators (&&, ||, |, ;, >, <, &) are not allowed. Use atomic commands only.' };
        }

        // 2. Deny dangerous patterns
        const dangerous = [
            'rm -rf /', 'format ', 'mkfs', 'dd ',
            'wget ', 'curl ', 'ssh ', 'scp ', 'powershell ', 'cmd /c', 'del /s /q /f'
        ];
        if (dangerous.some(p => lowerCmd.includes(p))) {
            return { ok: false, error: 'Potentially destructive or global command blocked.' };
        }

        // 3. Prefix allowlist check
        const isAllowed = this.allowedPrefixes.some(prefix => lowerCmd.startsWith(prefix.toLowerCase()));

        if (!isAllowed && !lowerCmd.startsWith('.') && !lowerCmd.startsWith('/') && !/^[a-z]:\\/i.test(lowerCmd)) {
            return { ok: false, error: `Command not in safety whitelist (Prefix check failed).` };
        }

        return { ok: true };
    }

    public checkReadSize(size: number): boolean {
        return size <= this.maxReadSize;
    }
}
