/**
 * ExecutionAuditService.ts — Phase 3 P3H
 *
 * Persistent local recording of execution runs.
 *
 * Storage layout:
 *   <dataDir>/execution/runs/<executionId>.json        — full run record
 *   <dataDir>/execution/audit/<executionId>.jsonl      — append-only audit log
 *   <dataDir>/execution/backups/<executionId>/         — pre-apply file backups
 *
 * Audit records are written synchronously to guarantee durability before
 * continuing execution.  Run JSON files are pretty-printed for inspectability.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    ExecutionRun,
    ExecutionAuditRecord,
    ExecutionAuditStage,
    ExecutionAuditEventType,
} from '../../../shared/executionTypes';
import { telemetry } from '../TelemetryService';

// ─── ExecutionAuditService ────────────────────────────────────────────────────

export class ExecutionAuditService {
    private readonly runsDir: string;
    private readonly auditDir: string;
    private readonly backupsDir: string;

    constructor(dataDir: string) {
        const execDir = path.join(dataDir, 'execution');
        this.runsDir = path.join(execDir, 'runs');
        this.auditDir = path.join(execDir, 'audit');
        this.backupsDir = path.join(execDir, 'backups');
        this._ensureDirs(execDir, this.runsDir, this.auditDir, this.backupsDir);
    }

    // ── Audit record append ─────────────────────────────────────────────────────

    /**
     * Appends a single audit record to the per-run JSONL file.
     *
     * Written synchronously — durability is required before execution continues.
     * Returns the created record.
     */
    appendAuditRecord(
        executionId: string,
        proposalId: string,
        stage: ExecutionAuditStage,
        event: ExecutionAuditEventType,
        detail: string,
        actor: 'system' | 'user' = 'system',
        data?: Record<string, unknown>,
    ): ExecutionAuditRecord {
        const record: ExecutionAuditRecord = {
            auditId: uuidv4(),
            executionId,
            proposalId,
            timestamp: new Date().toISOString(),
            stage,
            event,
            actor,
            detail,
            data,
        };

        const filePath = path.join(this.auditDir, `${executionId}.jsonl`);
        try {
            fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'execution',
                'execution.audit.write_error',
                'warn',
                'ExecutionAuditService',
                `Failed to write audit record for ${executionId}: ${err.message}`,
            );
        }

        return record;
    }

    /** Reads all audit records for a run in append order. */
    readAuditLog(executionId: string): ExecutionAuditRecord[] {
        const filePath = path.join(this.auditDir, `${executionId}.jsonl`);
        if (!fs.existsSync(filePath)) return [];

        try {
            return fs
                .readFileSync(filePath, 'utf-8')
                .split('\n')
                .filter(line => line.trim())
                .map(line => JSON.parse(line) as ExecutionAuditRecord);
        } catch (err: any) {
            telemetry.operational(
                'execution',
                'execution.audit.read_error',
                'warn',
                'ExecutionAuditService',
                `Failed to read audit log for ${executionId}: ${err.message}`,
            );
            return [];
        }
    }

    // ── Run persistence ─────────────────────────────────────────────────────────

    /** Persists a full run record. Called at every status transition. */
    saveRun(run: ExecutionRun): void {
        const filePath = path.join(this.runsDir, `${run.executionId}.json`);
        try {
            fs.writeFileSync(filePath, JSON.stringify(run, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'execution',
                'execution.run.persist_error',
                'warn',
                'ExecutionAuditService',
                `Failed to persist run ${run.executionId}: ${err.message}`,
            );
        }
    }

    /** Loads a previously-persisted run record. Returns null if not found. */
    loadRun(executionId: string): ExecutionRun | null {
        const filePath = path.join(this.runsDir, `${executionId}.json`);
        try {
            if (!fs.existsSync(filePath)) return null;
            return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ExecutionRun;
        } catch {
            return null;
        }
    }

    /**
     * Lists all persisted execution runs sorted newest-first.
     * Used on startup to detect in-flight (applying) runs that need recovery.
     */
    listPersistedRuns(): ExecutionRun[] {
        try {
            return fs
                .readdirSync(this.runsDir)
                .filter(f => f.endsWith('.json'))
                .map(f => {
                    try {
                        return JSON.parse(
                            fs.readFileSync(path.join(this.runsDir, f), 'utf-8'),
                        ) as ExecutionRun;
                    } catch {
                        return null;
                    }
                })
                .filter((r): r is ExecutionRun => r !== null)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        } catch {
            return [];
        }
    }

    // ── Backup directory ────────────────────────────────────────────────────────

    /** Returns (and ensures) the backup directory for a specific run. */
    ensureBackupDir(executionId: string): string {
        const dir = path.join(this.backupsDir, executionId);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _ensureDirs(...dirs: string[]): void {
        for (const d of dirs) {
            try {
                if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            } catch {
                // Non-fatal — unavailable in test environments without mocking
            }
        }
    }
}
