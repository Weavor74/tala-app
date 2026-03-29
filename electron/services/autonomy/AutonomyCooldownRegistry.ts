/**
 * AutonomyCooldownRegistry.ts — Phase 4 P4H
 *
 * Records and checks cooldown state for autonomous goal patterns.
 *
 * Cooldown is applied after:
 * - execution failure (15 min default)
 * - rollback (60 min default)
 * - governance block (30 min default)
 * - verification failure (15 min default)
 * - budget exhausted (next period)
 *
 * Persisted to <dataDir>/autonomy/cooldowns.json for recovery on restart.
 * Expired records are swept on load and periodically.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    GoalCooldownRecord,
    CooldownReason,
    AutonomyBudget,
} from '../../../shared/autonomyTypes';
import { telemetry } from '../TelemetryService';

// ─── AutonomyCooldownRegistry ─────────────────────────────────────────────────

export class AutonomyCooldownRegistry {
    private records: Map<string, GoalCooldownRecord> = new Map();
    private readonly cooldownFile: string;

    constructor(dataDir: string) {
        const autonomyDir = path.join(dataDir, 'autonomy');
        this.cooldownFile = path.join(autonomyDir, 'cooldowns.json');
        try {
            if (!fs.existsSync(autonomyDir)) {
                fs.mkdirSync(autonomyDir, { recursive: true });
            }
        } catch {
            // Non-fatal
        }
        this._load();
    }

    // ── Cooldown checks ─────────────────────────────────────────────────────────

    /**
     * Returns true if there is an active, non-expired cooldown for the given
     * subsystem + pattern combination.
     */
    isInCooldown(subsystemId: string, patternKey: string): boolean {
        this._sweepExpired();
        const key = this._key(subsystemId, patternKey);
        const record = this.records.get(key);
        if (!record) return false;
        const now = Date.now();
        const expires = new Date(record.expiresAt).getTime();
        return record.active && expires > now;
    }

    /**
     * Returns the active cooldown record, or null if none/expired.
     */
    getCooldownRecord(subsystemId: string, patternKey: string): GoalCooldownRecord | null {
        const key = this._key(subsystemId, patternKey);
        const record = this.records.get(key);
        if (!record) return null;
        if (!record.active || new Date(record.expiresAt).getTime() <= Date.now()) {
            return null;
        }
        return record;
    }

    /**
     * Records a new cooldown for the given subsystem + pattern.
     * Replaces any existing active cooldown (most recent wins for duration).
     */
    recordCooldown(
        subsystemId: string,
        patternKey: string,
        reason: CooldownReason,
        budget: AutonomyBudget,
    ): GoalCooldownRecord {
        const durationMs = this._durationForReason(reason, budget);
        const now = new Date();
        const expiresAt = new Date(now.getTime() + durationMs).toISOString();

        const record: GoalCooldownRecord = {
            cooldownId: uuidv4(),
            subsystemId,
            patternKey,
            reason,
            startedAt: now.toISOString(),
            expiresAt,
            active: true,
        };

        const key = this._key(subsystemId, patternKey);
        this.records.set(key, record);
        this._persist();

        telemetry.operational(
            'autonomy',
            'autonomy_run_cooled_down',
            'info',
            'AutonomyCooldownRegistry',
            `Cooldown applied for ${subsystemId} (${reason}): expires ${expiresAt}`,
        );

        return record;
    }

    /**
     * Clears an active cooldown for the given subsystem + pattern.
     * Operator override — always audited.
     */
    clearCooldown(subsystemId: string, patternKey: string): boolean {
        const key = this._key(subsystemId, patternKey);
        const record = this.records.get(key);
        if (!record) return false;

        record.active = false;
        this.records.set(key, record);
        this._persist();

        telemetry.operational(
            'autonomy',
            'operational',
            'warn',
            'AutonomyCooldownRegistry',
            `Cooldown manually cleared for ${subsystemId} (was: ${record.reason})`,
        );

        return true;
    }

    /**
     * Removes all expired or inactive cooldown records from the in-memory store.
     * Called on load and periodically.
     */
    sweepExpired(): void {
        this._sweepExpired();
        this._persist();
    }

    /**
     * Returns all currently active cooldowns (for dashboard display).
     */
    listActive(): GoalCooldownRecord[] {
        this._sweepExpired();
        const now = Date.now();
        return [...this.records.values()].filter(
            r => r.active && new Date(r.expiresAt).getTime() > now,
        );
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _key(subsystemId: string, patternKey: string): string {
        return `${subsystemId}::${patternKey}`;
    }

    private _durationForReason(reason: CooldownReason, budget: AutonomyBudget): number {
        switch (reason) {
            case 'rollback':             return budget.rollbackCooldownMs;
            case 'governance_block':     return budget.governanceBlockCooldownMs;
            case 'execution_failure':    return budget.failureCooldownMs;
            case 'verification_failure': return budget.failureCooldownMs;
            case 'budget_exhausted':     return budget.periodMs; // Wait out the full period
            default:                     return budget.failureCooldownMs;
        }
    }

    private _sweepExpired(): void {
        const now = Date.now();
        for (const [key, record] of this.records) {
            if (!record.active || new Date(record.expiresAt).getTime() <= now) {
                this.records.delete(key);
            }
        }
    }

    private _load(): void {
        try {
            if (!fs.existsSync(this.cooldownFile)) return;
            const raw = fs.readFileSync(this.cooldownFile, 'utf-8');
            const parsed: GoalCooldownRecord[] = JSON.parse(raw);
            const now = Date.now();
            for (const record of parsed) {
                // Only restore non-expired records
                if (record.active && new Date(record.expiresAt).getTime() > now) {
                    const key = this._key(record.subsystemId, record.patternKey);
                    this.records.set(key, record);
                }
            }
        } catch {
            // Non-fatal — start fresh
        }
    }

    private _persist(): void {
        try {
            const records = [...this.records.values()];
            fs.writeFileSync(this.cooldownFile, JSON.stringify(records, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'AutonomyCooldownRegistry',
                `Failed to persist cooldown records: ${err.message}`,
            );
        }
    }
}
