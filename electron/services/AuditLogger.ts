import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { app } from 'electron';
import { redact } from './log_redact';
import { v4 as uuidv4 } from 'uuid';

/**
 * AuditLogger
 * ===========
 * Provides structured, append-only JSONL logging for the Tala app.
 * Adheres to the Engineering Autonomy & Auditability policy.
 */
class AuditLogger {
    private logDir: string;
    private logPath: string;
    private runId: string;
    private activeCorrelationId: string | null = null;
    private activeSessionId: string | null = null;
    private maxSize = 10 * 1024 * 1024; // 10MB rotation

    constructor() {
        // Run ID is stable for this app session
        this.runId = uuidv4();

        // userData is only available in Electron after app is ready or via app.getPath
        // During startup we must be safe.
        try {
            this.logDir = path.join(app.getPath('userData'), 'logs');
            this.logPath = path.join(this.logDir, 'audit-log.jsonl');
            console.log(`[AuditLogger] Initialized at: ${this.logPath}`);
            this.ensureDirectory();
        } catch (e) {
            // Fallback for immediate initialization contexts
            this.logDir = '';
            this.logPath = '';
        }
    }

    private ensureDirectory() {
        if (this.logDir && !fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    /**
     * Sets the active correlation ID for current operations (e.g. a specific chat turn).
     */
    public setCorrelationId(id: string | null) {
        this.activeCorrelationId = id;
    }

    public getCorrelationId(): string {
        return this.activeCorrelationId || 'global';
    }

    public setSessionId(id: string | null) {
        this.activeSessionId = id;
    }

    public getSessionId(): string {
        return this.activeSessionId || 'none';
    }

    public getRunId(): string {
        return this.runId;
    }

    /**
     * Hashes arguments using SHA-256 to allow tracking without logging payloads.
     */
    public hashArgs(args: any): string {
        try {
            const str = JSON.stringify(args || {});
            return crypto.createHash('sha256').update(str).digest('hex');
        } catch (e) {
            return 'hash_fail';
        }
    }

    /**
     * Structured INFO log
     */
    public info(event: string, component: string, data: Record<string, any> = {}, correlationId?: string) {
        this.write('INFO', event, component, data, correlationId);
    }

    /**
     * Structured WARN log
     */
    public warn(event: string, component: string, data: Record<string, any> = {}, correlationId?: string) {
        this.write('WARN', event, component, data, correlationId);
    }

    /**
     * Structured ERROR log
     */
    public error(event: string, component: string, data: Record<string, any> = {}, correlationId?: string) {
        this.write('ERROR', event, component, data, correlationId);
    }

    private write(level: string, event: string, component: string, data: Record<string, any>, correlationId?: string) {
        const record = {
            ts: new Date().toISOString(),
            run_id: this.runId,
            session_id: this.activeSessionId || 'none',
            correlation_id: correlationId || this.activeCorrelationId || 'global',
            level,
            event,
            component,
            ...redact(data)
        };

        const line = JSON.stringify(record) + '\n';

        // Non-blocking write
        setImmediate(() => {
            try {
                if (!this.logPath) {
                    // Try to initialize if it failed earlier
                    this.logDir = path.join(app.getPath('userData'), 'logs');
                    this.logPath = path.join(this.logDir, 'audit-log.jsonl');
                    this.ensureDirectory();
                }

                // Append to log and check for rotation
                fs.appendFileSync(this.logPath, line);

                // Check size for rotation
                const stats = fs.statSync(this.logPath);
                if (stats.size > this.maxSize) {
                    this.rotate();
                }
            } catch (err) {
                console.error(`[AuditLogger][ERROR] Record: ${event} - Log Write Fail:`, err);
                // Last ditch effort to console
                console.log('[AuditLogger][FALLBACK]', line.trim());
            }
        });
    }

    public async rotateLog() {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const rotatedPath = path.join(this.logDir, `audit-log.${timestamp}.jsonl`);
            fs.renameSync(this.logPath, rotatedPath);
            this.info('log_rotated', 'AuditLogger', { old_file: path.basename(rotatedPath) });
        } catch (e) {
            console.error('[AuditLogger] Rotation failed:', e);
        }
    }

    private rotate() {
        this.rotateLog().catch(e => console.error('[AuditLogger] Async rotation fail', e));
    }
}

// Single instance for the app
export const auditLogger = new AuditLogger();
