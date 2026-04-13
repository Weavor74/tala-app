import fs from 'fs';
import path from 'path';
import { validatePathWithinAppRoot, resolveLogsPath } from './PathResolver';

export interface LogLifecycleConfig {
    maxActiveFileBytes: number;
    rotatedRetentionCount: number;
    recentReadMaxBytes: number;
    recentReadMaxLines?: number;
}

export interface RecentLogWindowOptions {
    maxBytes?: number;
    maxLines?: number;
}

export interface RecentLogWindow {
    lines: string[];
    bytesRead: number;
    totalBytes: number;
    truncatedFromHead: boolean;
    skippedMissing: boolean;
}

export type LogAppendResult = {
    success: boolean;
    rotated: boolean;
    rotationReason?: 'append_precheck' | 'append_postcheck' | 'startup_oversized_existing';
};

const DEFAULT_LOG_LIFECYCLE_CONFIG: LogLifecycleConfig = {
    maxActiveFileBytes: 100 * 1024 * 1024, // 100MB
    rotatedRetentionCount: 5,
    recentReadMaxBytes: 5 * 1024 * 1024, // 5MB
    recentReadMaxLines: 5000,
};

export class LogLifecycleService {
    private readonly logsDir: string;
    private readonly config: LogLifecycleConfig;
    private readonly externalByConfiguration: boolean;

    constructor(
        logsDir: string = resolveLogsPath(),
        config: Partial<LogLifecycleConfig> = {},
        options?: { externalByConfiguration?: boolean }
    ) {
        this.logsDir = path.resolve(logsDir);
        this.config = { ...DEFAULT_LOG_LIFECYCLE_CONFIG, ...config };
        this.externalByConfiguration = Boolean(options?.externalByConfiguration);
        this.ensureLogDirectory();
        this.logOutsideRootIfNeeded();
    }

    public getLogsDir(): string {
        return this.logsDir;
    }

    public ensureLogDirectory(): void {
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
    }

    public appendJsonl(fileName: string, record: unknown): LogAppendResult {
        return this.appendLine(fileName, `${JSON.stringify(record)}\n`);
    }

    public appendLine(fileName: string, line: string): LogAppendResult {
        const activePath = this.resolveManagedLogPath(fileName);
        this.ensureLogDirectory();

        let rotated = false;
        const preRotated = this.rotateIfOversized(activePath, fileName, this.config.maxActiveFileBytes, 'append_precheck');
        rotated = rotated || preRotated;

        fs.appendFileSync(activePath, line, 'utf-8');

        const postRotated = this.rotateIfOversized(activePath, fileName, this.config.maxActiveFileBytes, 'append_postcheck');
        rotated = rotated || postRotated;

        return { success: true, rotated, rotationReason: rotated ? 'append_postcheck' : undefined };
    }

    public rotateOversizedOnStartup(fileName: string): boolean {
        const activePath = this.resolveManagedLogPath(fileName);
        return this.rotateIfOversized(activePath, fileName, this.config.maxActiveFileBytes, 'startup_oversized_existing');
    }

    public pruneRotated(fileName: string): void {
        const parsed = path.parse(fileName);
        const prefix = parsed.name;
        const ext = parsed.ext || '.log';
        const rotated = fs.readdirSync(this.logsDir)
            .filter((name) => name.startsWith(`${prefix}.`) && name.endsWith(ext))
            .map((name) => {
                const match = name.match(new RegExp(`^${this.escapeRegex(prefix)}\\.(\\d+)${this.escapeRegex(ext)}$`));
                return match ? { name, index: Number(match[1]) } : null;
            })
            .filter((item): item is { name: string; index: number } => item !== null)
            .sort((a, b) => a.index - b.index);

        const maxKeep = this.config.rotatedRetentionCount;
        while (rotated.length > maxKeep) {
            const toDelete = rotated.pop();
            if (!toDelete) break;
            const fullPath = path.join(this.logsDir, toDelete.name);
            fs.unlinkSync(fullPath);
            console.log(`[LogLifecycle] prune file=${toDelete.name} reason=retention_limit`);
        }
    }

    public readRecentWindow(fileName: string, options: RecentLogWindowOptions = {}): RecentLogWindow {
        const fullPath = this.resolveManagedLogPath(fileName);
        return this.readRecentWindowFromPath(fullPath, options);
    }

    public readRecentWindowFromPath(fullPath: string, options: RecentLogWindowOptions = {}): RecentLogWindow {
        const maxBytes = Math.max(1, options.maxBytes ?? this.config.recentReadMaxBytes);
        const maxLines = options.maxLines ?? this.config.recentReadMaxLines;
        const resolvedPath = path.resolve(fullPath);

        console.log(`[LogInspection] read_recent file=${path.basename(resolvedPath)} maxBytes=${maxBytes}`);

        if (!fs.existsSync(resolvedPath)) {
            return {
                lines: [],
                bytesRead: 0,
                totalBytes: 0,
                truncatedFromHead: false,
                skippedMissing: true,
            };
        }

        const stats = fs.statSync(resolvedPath);
        const totalBytes = stats.size;
        if (totalBytes === 0) {
            return {
                lines: [],
                bytesRead: 0,
                totalBytes: 0,
                truncatedFromHead: false,
                skippedMissing: false,
            };
        }

        const bytesRead = Math.min(totalBytes, maxBytes);
        const readOffset = Math.max(0, totalBytes - bytesRead);
        const truncatedFromHead = readOffset > 0;
        const fd = fs.openSync(resolvedPath, 'r');
        let lines: string[] = [];

        try {
            const buffer = Buffer.alloc(bytesRead);
            fs.readSync(fd, buffer, 0, bytesRead, readOffset);
            let chunk = buffer.toString('utf8');

            // If we only read a tail window, the first line may be partial.
            // Drop the first partial line safely so downstream JSONL parse stays deterministic.
            if (truncatedFromHead) {
                const firstBreak = chunk.indexOf('\n');
                chunk = firstBreak >= 0 ? chunk.slice(firstBreak + 1) : '';
            }

            lines = chunk
                .split(/\r?\n/)
                .map((line) => line.trimEnd())
                .filter((line) => line.trim().length > 0);

            if (typeof maxLines === 'number' && maxLines > 0 && lines.length > maxLines) {
                lines = lines.slice(-maxLines);
            }
        } finally {
            fs.closeSync(fd);
        }

        console.log(`[LogInspection] returned lines=${lines.length} bytes=${bytesRead}`);
        return {
            lines,
            bytesRead,
            totalBytes,
            truncatedFromHead,
            skippedMissing: false,
        };
    }

    private resolveManagedLogPath(fileName: string): string {
        const fullPath = path.resolve(this.logsDir, fileName);
        if (!this.isUnderLogsRoot(fullPath)) {
            throw new Error(`[LogLifecycle] Refusing to manage path outside logs root: ${fullPath}`);
        }
        return fullPath;
    }

    private rotateIfOversized(
        activePath: string,
        fileName: string,
        maxBytes: number,
        reason: 'append_precheck' | 'append_postcheck' | 'startup_oversized_existing'
    ): boolean {
        if (!fs.existsSync(activePath)) return false;
        const size = fs.statSync(activePath).size;
        if (size < maxBytes) return false;

        const parsed = path.parse(fileName);
        const prefix = parsed.name;
        const ext = parsed.ext || '.log';

        for (let i = this.config.rotatedRetentionCount; i >= 1; i--) {
            const candidate = path.join(this.logsDir, `${prefix}.${i}${ext}`);
            if (!fs.existsSync(candidate)) continue;

            if (i === this.config.rotatedRetentionCount) {
                fs.unlinkSync(candidate);
                console.log(`[LogLifecycle] prune file=${path.basename(candidate)} reason=retention_limit`);
            } else {
                const next = path.join(this.logsDir, `${prefix}.${i + 1}${ext}`);
                fs.renameSync(candidate, next);
            }
        }

        const rotatedPath = path.join(this.logsDir, `${prefix}.1${ext}`);
        fs.renameSync(activePath, rotatedPath);
        fs.writeFileSync(activePath, '', 'utf-8');
        const action = reason === 'startup_oversized_existing' ? 'startup rotation' : 'rotate';
        console.log(`[LogLifecycle] ${action} file=${fileName} size=${size} rotated=${path.basename(rotatedPath)}`);
        return true;
    }

    private isUnderLogsRoot(targetPath: string): boolean {
        const normalizedRoot = this.normalizePath(this.logsDir);
        const normalizedTarget = this.normalizePath(targetPath);
        return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
    }

    private normalizePath(input: string): string {
        return path.resolve(input).replace(/[\\/]+$/g, '').toLowerCase();
    }

    private escapeRegex(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private logOutsideRootIfNeeded(): void {
        if (validatePathWithinAppRoot(this.logsDir)) return;
        if (this.externalByConfiguration) {
            console.info(`[PathGuard] external-by-configuration label=logs path=${this.logsDir}`);
            return;
        }
        console.warn(`[PathGuard] write escaped app root path=${this.logsDir}`);
    }
}

let defaultLogLifecycle: LogLifecycleService | null = null;

export function getDefaultLogLifecycle(): LogLifecycleService {
    if (!defaultLogLifecycle) {
        defaultLogLifecycle = new LogLifecycleService();
    }
    return defaultLogLifecycle;
}

