/**
 * GovernanceAuditService.ts — Phase 3.5 P3.5F
 *
 * Append-only structured audit log for the governance layer.
 *
 * Storage layout:
 *   <dataDir>/governance/audit/<proposalId>.jsonl   — per-proposal audit log
 *   <dataDir>/governance/audit/_global.jsonl        — lightweight cross-proposal index
 *
 * Audit records are written synchronously to guarantee durability.
 * Records are never mutated after write — append-only by design.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    GovernanceAuditRecord,
    GovernanceAuditEventType,
    ApprovalActor,
} from '../../../shared/governanceTypes';
import { telemetry } from '../TelemetryService';

// ─── GovernanceAuditService ───────────────────────────────────────────────────

export class GovernanceAuditService {
    private readonly auditDir: string;
    private readonly globalIndexFile: string;

    constructor(dataDir: string) {
        this.auditDir = path.join(dataDir, 'governance', 'audit');
        this.globalIndexFile = path.join(this.auditDir, '_global.jsonl');
        this._ensureDirs();
    }

    // ── Append ──────────────────────────────────────────────────────────────────

    /**
     * Appends a single audit record to the per-proposal JSONL file
     * and a lightweight index entry to _global.jsonl.
     *
     * Written synchronously — durability required before continuing.
     * Returns the created record.
     */
    append(
        proposalId: string,
        decisionId: string,
        event: GovernanceAuditEventType,
        detail: string,
        actor: ApprovalActor | null,
        data?: Record<string, unknown>,
    ): GovernanceAuditRecord {
        const record: GovernanceAuditRecord = {
            auditId: uuidv4(),
            proposalId,
            decisionId,
            timestamp: new Date().toISOString(),
            event,
            actor,
            detail,
            data,
        };

        const proposalFile = path.join(this.auditDir, `${proposalId}.jsonl`);

        try {
            fs.appendFileSync(proposalFile, JSON.stringify(record) + '\n', 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'governance',
                'governance.audit.write_error',
                'warn',
                'GovernanceAuditService',
                `Failed to write audit record for proposal ${proposalId}: ${err.message}`,
            );
        }

        // Append lightweight global index entry
        const indexEntry = {
            auditId: record.auditId,
            proposalId,
            decisionId,
            event,
            timestamp: record.timestamp,
        };
        try {
            fs.appendFileSync(this.globalIndexFile, JSON.stringify(indexEntry) + '\n', 'utf-8');
        } catch {
            // Non-fatal — global index is for convenience, not correctness
        }

        return record;
    }

    // ── Read ─────────────────────────────────────────────────────────────────────

    /**
     * Reads all audit records for a specific proposal in chronological order.
     */
    readAll(proposalId: string): GovernanceAuditRecord[] {
        const filePath = path.join(this.auditDir, `${proposalId}.jsonl`);
        return this._readJsonl<GovernanceAuditRecord>(filePath);
    }

    /**
     * Reads the most recent N records from the global index.
     * Returns lightweight index entries, not full records.
     */
    readGlobalIndex(limit = 100): Array<{
        auditId: string;
        proposalId: string;
        decisionId: string;
        event: GovernanceAuditEventType;
        timestamp: string;
    }> {
        const lines = this._readJsonl<{
            auditId: string;
            proposalId: string;
            decisionId: string;
            event: GovernanceAuditEventType;
            timestamp: string;
        }>(this.globalIndexFile);
        return lines.slice(-limit);
    }

    // ── Private ──────────────────────────────────────────────────────────────────

    private _readJsonl<T>(filePath: string): T[] {
        if (!fs.existsSync(filePath)) return [];
        try {
            return fs.readFileSync(filePath, 'utf-8')
                .split('\n')
                .filter(line => line.trim())
                .map(line => JSON.parse(line) as T);
        } catch (err: any) {
            telemetry.operational(
                'governance',
                'governance.audit.read_error',
                'warn',
                'GovernanceAuditService',
                `Failed to read audit file ${filePath}: ${err.message}`,
            );
            return [];
        }
    }

    private _ensureDirs(): void {
        try {
            if (!fs.existsSync(this.auditDir)) {
                fs.mkdirSync(this.auditDir, { recursive: true });
            }
        } catch {
            // Non-fatal — will fail at append time with a more specific error
        }
    }
}
