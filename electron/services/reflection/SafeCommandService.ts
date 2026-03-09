import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface CommandResult {
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    error?: string;
}

export class SafeCommandService {
    private readonly rootDir: string;

    // Commands that are considered safe to run during engineering/validation tasks
    private readonly allowlistPrefixes = [
        'npm run build',
        'npm run typecheck',
        'npm run lint',
        'npm run test',
        'npx tsc',
        'npx eslint',
        'npx jest',
        'git status',
        'git diff',
        'git log',
        'node scripts/'
    ];

    private readonly blockedSubstrings = [
        ' rm ', '-rf', ' del ', ' rmdir ', ' format ', ' fdisk ', ' mkfs',
        '&&', '||', ';', '|', '>', '>>', '<', // basic injection prevention
        'npm install', 'yarn install', 'pnpm install' // prevent arbitrary package additions unless properly audited
    ];

    constructor(rootDir: string) {
        this.rootDir = rootDir;
    }

    private isCommandAllowed(command: string): boolean {
        const cmdTrimmed = command.trim();

        // Block dangerous chars
        for (const blocked of this.blockedSubstrings) {
            if (cmdTrimmed.includes(blocked)) return false;
        }

        // Allow listed prefixes
        for (const prefix of this.allowlistPrefixes) {
            if (cmdTrimmed.startsWith(prefix)) return true;
        }

        return false;
    }

    public async runSafeCommand(command: string, timeoutMs: number = 30000): Promise<CommandResult> {
        if (!this.isCommandAllowed(command)) {
            return {
                command,
                exitCode: 1,
                stdout: '',
                stderr: 'Command blocked by SafeCommandService allowlist.',
                error: 'BLOCKED'
            };
        }

        try {
            console.log(`[SafeCommandService] Executing: ${command}`);
            // Note: exec buffer is finite (typically 1MB defaults). Can be passed in options if needed.
            const { stdout, stderr } = await execAsync(command, {
                cwd: this.rootDir,
                timeout: timeoutMs
            });

            return {
                command,
                exitCode: 0,
                stdout: stdout || '',
                stderr: stderr || ''
            };
        } catch (error: any) {
            return {
                command,
                exitCode: error.code || 1,
                stdout: error.stdout || '',
                stderr: error.stderr || '',
                error: error.message
            };
        }
    }
}
