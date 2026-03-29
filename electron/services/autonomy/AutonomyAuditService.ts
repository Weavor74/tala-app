/**
 * AutonomyAuditService.ts — Phase 4 P4I
 *
 * Persistent local recording of autonomous goal lifecycle and run audit trails.
 *
 * Storage layout:
 *   <dataDir>/autonomy/goals/<goalId>.json       — full goal record
 *   <dataDir>/autonomy/runs/<runId>.json         — full run record
 *   <dataDir>/autonomy/audit/<goalId>.jsonl      — append-only audit log per goal
 *
 * Audit records are written synchronously to guarantee durability.
 * Run JSON files are pretty-printed for inspectability.
 * Mirrors ExecutionAuditService (Phase 3 P3H).
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    AutonomousGoal,
    AutonomousRun,
} from '../../../shared/autonomyTypes';
import { telemetry } from '../TelemetryService';

// ─── Audit record ─────────────────────────────────────────────────────────────

export type AutonomyAuditEventType =
    | 'goal_created'
    | 'goal_status_changed'
    | 'goal_suppressed'
    | 'policy_evaluated'
    | 'policy_approved'
    | 'policy_blocked'
    | 'run_started'
    | 'run_completed'
    | 'run_failed'
    | 'run_aborted'
    | 'planning_triggered'
    | 'governance_submitted'
    | 'governance_resolved'
    | 'execution_triggered'
    | 'outcome_recorded'
    | 'cooldown_applied'
    | 'cooldown_cleared'
    | 'cooldown_cleared_by_operator'
    | 'budget_exhausted'
    | 'global_autonomy_toggled'
    | 'policy_updated';

export interface AutonomyAuditRecord {
    auditId: string;
    timestamp: string;
    event: AutonomyAuditEventType;
    goalId?: string;
    runId?: string;
    subsystemId?: string;
    detail: string;
    data?: Record<string, unknown>;
}

// ─── AutonomyAuditService ─────────────────────────────────────────────────────

export class AutonomyAuditService {
    private readonly goalsDir: string;
    private readonly runsDir: string;
    private readonly auditDir: string;

    constructor(dataDir: string) {
        const autonomyDir = path.join(dataDir, 'autonomy');
        this.goalsDir = path.join(autonomyDir, 'goals');
        this.runsDir = path.join(autonomyDir, 'runs');
        this.auditDir = path.join(autonomyDir, 'audit');
        this._ensureDirs(autonomyDir, this.goalsDir, this.runsDir, this.auditDir);
    }

    // ── Audit record append ─────────────────────────────────────────────────────

    appendAuditRecord(
        event: AutonomyAuditEventType,
        detail: string,
        opts: {
            goalId?: string;
            runId?: string;
            subsystemId?: string;
            data?: Record<string, unknown>;
        } = {},
    ): AutonomyAuditRecord {
        const record: AutonomyAuditRecord = {
            auditId: uuidv4(),
            timestamp: new Date().toISOString(),
            event,
            detail,
            goalId: opts.goalId,
            runId: opts.runId,
            subsystemId: opts.subsystemId,
            data: opts.data,
        };

        const id = opts.goalId ?? opts.runId ?? 'system';
        const filePath = path.join(this.auditDir, `${id}.jsonl`);
        try {
            fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'AutonomyAuditService',
                `Failed to write audit record: ${err.message}`,
            );
        }

        return record;
    }

    readAuditLog(id: string): AutonomyAuditRecord[] {
        const filePath = path.join(this.auditDir, `${id}.jsonl`);
        if (!fs.existsSync(filePath)) return [];
        try {
            return fs.readFileSync(filePath, 'utf-8')
                .split('\n')
                .filter(Boolean)
                .map(line => JSON.parse(line));
        } catch {
            return [];
        }
    }

    // ── Goal persistence ────────────────────────────────────────────────────────

    saveGoal(goal: AutonomousGoal): void {
        const filePath = path.join(this.goalsDir, `${goal.goalId}.json`);
        try {
            fs.writeFileSync(filePath, JSON.stringify(goal, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'AutonomyAuditService',
                `Failed to save goal ${goal.goalId}: ${err.message}`,
            );
        }
    }

    loadGoal(goalId: string): AutonomousGoal | null {
        const filePath = path.join(this.goalsDir, `${goalId}.json`);
        if (!fs.existsSync(filePath)) return null;
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
            return null;
        }
    }

    listGoals(): AutonomousGoal[] {
        const goals: AutonomousGoal[] = [];
        try {
            if (!fs.existsSync(this.goalsDir)) return [];
            const files = fs.readdirSync(this.goalsDir).filter(f => f.endsWith('.json'));
            for (const f of files) {
                try {
                    const goal = JSON.parse(
                        fs.readFileSync(path.join(this.goalsDir, f), 'utf-8'),
                    );
                    goals.push(goal);
                } catch {
                    // Skip corrupt file
                }
            }
        } catch {
            // Non-fatal
        }
        return goals.sort((a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
    }

    // ── Run persistence ─────────────────────────────────────────────────────────

    saveRun(run: AutonomousRun): void {
        const filePath = path.join(this.runsDir, `${run.runId}.json`);
        try {
            fs.writeFileSync(filePath, JSON.stringify(run, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'AutonomyAuditService',
                `Failed to save run ${run.runId}: ${err.message}`,
            );
        }
    }

    loadRun(runId: string): AutonomousRun | null {
        const filePath = path.join(this.runsDir, `${runId}.json`);
        if (!fs.existsSync(filePath)) return null;
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
            return null;
        }
    }

    listRuns(windowMs = 24 * 60 * 60 * 1000): AutonomousRun[] {
        const runs: AutonomousRun[] = [];
        const cutoff = Date.now() - windowMs;
        try {
            if (!fs.existsSync(this.runsDir)) return [];
            const files = fs.readdirSync(this.runsDir).filter(f => f.endsWith('.json'));
            for (const f of files) {
                try {
                    const run = JSON.parse(
                        fs.readFileSync(path.join(this.runsDir, f), 'utf-8'),
                    );
                    if (new Date(run.startedAt).getTime() >= cutoff) {
                        runs.push(run);
                    }
                } catch {
                    // Skip corrupt file
                }
            }
        } catch {
            // Non-fatal
        }
        return runs.sort((a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        );
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _ensureDirs(...dirs: string[]): void {
        for (const dir of dirs) {
            try {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            } catch {
                // Non-fatal
            }
        }
    }
}
