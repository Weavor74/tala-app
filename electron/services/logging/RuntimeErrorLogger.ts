import fs from 'fs';
import path from 'path';
import { resolveLogsPath } from '../PathResolver';

export type RuntimeErrorSource = 'ipc' | 'process' | 'renderer' | 'system' | 'filesystem';

export interface RuntimeErrorLogInput {
    source: RuntimeErrorSource;
    component: string;
    event: string;
    code?: string;
    message: string;
    stack?: string;
    metadata?: Record<string, unknown>;
}

interface RuntimeErrorLogEntry {
    timestamp: string;
    level: 'error';
    source: RuntimeErrorSource;
    component: string;
    event: string;
    code?: string;
    message: string;
    stack?: string;
    metadata?: Record<string, unknown>;
}

export class RuntimeErrorLogger {
    private static readonly logFilePath = resolveLogsPath('runtime-errors.jsonl');
    private static initialized = false;

    private static ensureReady(): void {
        if (this.initialized) return;
        try {
            fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
            if (!fs.existsSync(this.logFilePath)) {
                fs.writeFileSync(this.logFilePath, '', 'utf-8');
            }
            this.initialized = true;
        } catch (error) {
            console.error('[RuntimeError] failed_to_initialize_logger', error);
        }
    }

    public static log(input: RuntimeErrorLogInput): void {
        void this.logAsync(input);
    }

    public static async logAsync(input: RuntimeErrorLogInput): Promise<void> {
        try {
            this.ensureReady();
            const entry: RuntimeErrorLogEntry = {
                timestamp: new Date().toISOString(),
                level: 'error',
                source: input.source,
                component: input.component || 'unknown',
                event: input.event || 'unknown',
                code: input.code,
                message: String(input.message || 'unknown_error'),
                stack: input.stack,
                metadata: input.metadata,
            };
            const jsonLine = `${JSON.stringify(entry)}\n`;
            await fs.promises.appendFile(this.logFilePath, jsonLine, 'utf-8');
            console.error(`[RuntimeError] source=${entry.source} event=${entry.event} message=${entry.message}`);
        } catch (error) {
            // Must never throw.
            console.error('[RuntimeError] failed_to_write_log_entry', error);
        }
    }

    public static getLogFilePathForTesting(): string {
        this.ensureReady();
        return this.logFilePath;
    }
}

