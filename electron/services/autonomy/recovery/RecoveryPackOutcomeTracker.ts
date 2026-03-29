/**
 * RecoveryPackOutcomeTracker.ts — Phase 4.3 P4.3F
 *
 * Records and tracks recovery pack execution outcomes.
 *
 * Responsibilities:
 * - Persist a RecoveryPackExecutionRecord for each pack-backed run.
 * - Compute and apply confidence adjustments to the pack registry.
 * - Provide per-pack outcome summaries for dashboard display.
 * - Provide per-goal attempt counts (for maxAttemptsPerGoal enforcement in matcher).
 *
 * Storage:
 *   <dataDir>/autonomy/recovery/records/<recordId>.json — one file per record
 *
 * Confidence adjustment deltas (deterministic, not model-based):
 *   succeeded:          +0.10
 *   failed:             -0.15
 *   rolled_back:        -0.25
 *   governance_blocked: -0.05
 *   aborted:            -0.10
 *
 * These values mirror OutcomeLearningRegistry deltas (Phase 4 P4F) for consistency.
 *
 * This is NOT model training. Records are local operational memory only.
 * No data is sent to any external service.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    RecoveryPackExecutionRecord,
    RecoveryPackExecutionOutcome,
    RecoveryPackId,
    RecoveryPackOutcomeSummary,
    RecoveryPackDashboardState,
} from '../../../../shared/recoveryPackTypes';
import type { AutonomousGoal, AutonomousRun } from '../../../../shared/autonomyTypes';
import type { RecoveryPackRegistry } from './RecoveryPackRegistry';
import { telemetry } from '../../TelemetryService';

// ─── Confidence adjustment table ──────────────────────────────────────────────

const CONFIDENCE_DELTA: Record<RecoveryPackExecutionOutcome, number> = {
    succeeded:          +0.10,
    failed:             -0.15,
    rolled_back:        -0.25,
    governance_blocked: -0.05,
    aborted:            -0.10,
};

// ─── RecoveryPackOutcomeTracker ───────────────────────────────────────────────

export class RecoveryPackOutcomeTracker {
    private readonly recordsDir: string;
    /** In-memory cache: recordId → record */
    private cache: Map<string, RecoveryPackExecutionRecord> = new Map();
    private cacheLoaded = false;

    constructor(
        dataDir: string,
        private readonly registry: RecoveryPackRegistry,
    ) {
        this.recordsDir = path.join(dataDir, 'autonomy', 'recovery', 'records');
        this._ensureDir(this.recordsDir);
    }

    // ── Record outcome ──────────────────────────────────────────────────────────

    /**
     * Records the outcome of a recovery pack execution attempt.
     * - Creates and persists a RecoveryPackExecutionRecord.
     * - Adjusts confidence in the registry.
     *
     * Should be called from AutonomousRunOrchestrator's finally block when
     * run.recoveryPackId is set.
     */
    record(
        packId: RecoveryPackId,
        goal: AutonomousGoal,
        run: AutonomousRun,
        outcome: RecoveryPackExecutionOutcome,
    ): RecoveryPackExecutionRecord {
        const pack = this.registry.getById(packId);
        const confidenceAtUse = pack?.confidence.current ?? 0;

        // Apply confidence delta
        const delta = CONFIDENCE_DELTA[outcome] ?? 0;
        if (pack) {
            this.registry.updateConfidence(packId, delta, outcome);
        }
        const confidenceAfterAdjustment = this.registry.getById(packId)?.confidence.current ?? confidenceAtUse;

        const record: RecoveryPackExecutionRecord = {
            recordId: uuidv4(),
            packId,
            packVersion: pack?.version ?? 'unknown',
            goalId: goal.goalId,
            runId: run.runId,
            startedAt: run.startedAt,
            completedAt: run.completedAt ?? new Date().toISOString(),
            outcome,
            proposalId: run.proposalId,
            executionRunId: run.executionRunId,
            rollbackTriggered: outcome === 'rolled_back',
            failureReason: run.failureReason ?? run.abortReason,
            confidenceAtUse,
            confidenceAfterAdjustment,
        };

        this._save(record);
        this.cache.set(record.recordId, record);

        telemetry.operational(
            'autonomy',
            'recovery_pack_outcome_recorded',
            'info',
            'RecoveryPackOutcomeTracker',
            `Pack ${packId} outcome '${outcome}' recorded for goal ${goal.goalId} ` +
            `(confidence: ${confidenceAtUse.toFixed(3)} → ${confidenceAfterAdjustment.toFixed(3)})`,
        );

        return record;
    }

    // ── Query ───────────────────────────────────────────────────────────────────

    /**
     * Returns all execution records for a specific pack, newest first.
     */
    listRecordsForPack(packId: RecoveryPackId): RecoveryPackExecutionRecord[] {
        return this._loadAll()
            .filter(r => r.packId === packId)
            .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    }

    /**
     * Returns recent execution records across all packs, newest first.
     */
    listRecentRecords(limit = 20): RecoveryPackExecutionRecord[] {
        return this._loadAll()
            .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
            .slice(0, limit);
    }

    /**
     * Returns a map of packId → attempt count for a specific goalId.
     * Used by RecoveryPackMatcher to enforce maxAttemptsPerGoal.
     */
    getAttemptCountsForGoal(goalId: string): Map<RecoveryPackId, number> {
        const counts = new Map<RecoveryPackId, number>();
        const records = this._loadAll().filter(r => r.goalId === goalId);
        for (const r of records) {
            counts.set(r.packId, (counts.get(r.packId) ?? 0) + 1);
        }
        return counts;
    }

    /**
     * Computes an outcome summary for a single pack.
     */
    getOutcomeSummary(packId: RecoveryPackId): RecoveryPackOutcomeSummary {
        const pack = this.registry.getById(packId);
        const records = this._loadAll().filter(r => r.packId === packId);
        const sorted = records.sort((a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        );

        return {
            packId,
            packVersion: pack?.version ?? 'unknown',
            label: pack?.label ?? packId,
            currentConfidence: pack?.confidence.current ?? 0,
            totalAttempts: records.length,
            successCount: records.filter(r => r.outcome === 'succeeded').length,
            failureCount: records.filter(r => r.outcome === 'failed' || r.outcome === 'aborted').length,
            rollbackCount: records.filter(r => r.outcome === 'rolled_back').length,
            lastAttemptAt: sorted[0]?.startedAt,
            lastOutcome: sorted[0]?.outcome,
            enabled: pack?.enabled ?? false,
        };
    }

    /**
     * Returns the full dashboard state for the recovery pack layer.
     */
    getDashboardState(): RecoveryPackDashboardState {
        const allPacks = this.registry.getAll();
        return {
            registeredPacks: allPacks.map(pack => ({
                pack,
                summary: this.getOutcomeSummary(pack.packId),
            })),
            recentExecutionRecords: this.listRecentRecords(20),
            recoveryPackMatchingEnabled: true,
            lastUpdatedAt: new Date().toISOString(),
        };
    }

    // ── Private ─────────────────────────────────────────────────────────────────

    private _loadAll(): RecoveryPackExecutionRecord[] {
        if (this.cacheLoaded) return [...this.cache.values()];

        try {
            if (!fs.existsSync(this.recordsDir)) return [];
            const files = fs.readdirSync(this.recordsDir).filter(f => f.endsWith('.json'));
            for (const f of files) {
                try {
                    const rec = JSON.parse(
                        fs.readFileSync(path.join(this.recordsDir, f), 'utf-8'),
                    ) as RecoveryPackExecutionRecord;
                    this.cache.set(rec.recordId, rec);
                } catch {
                    // Skip corrupt records
                }
            }
        } catch {
            // Non-fatal
        }

        this.cacheLoaded = true;
        return [...this.cache.values()];
    }

    private _save(record: RecoveryPackExecutionRecord): void {
        const file = path.join(this.recordsDir, `${record.recordId}.json`);
        try {
            fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'RecoveryPackOutcomeTracker',
                `Failed to persist execution record ${record.recordId}: ${err.message}`,
            );
        }
    }

    private _ensureDir(dir: string): void {
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        } catch {
            // Non-fatal
        }
    }
}
