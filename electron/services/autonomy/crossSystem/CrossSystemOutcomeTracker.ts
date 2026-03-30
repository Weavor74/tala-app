/**
 * CrossSystemOutcomeTracker.ts — Phase 6 P6G
 *
 * Records cross-system strategy outcomes for learning and dashboard display.
 *
 * Records are append-only (never mutated after creation except for recurrence marking).
 * Provides recurrence detection: if a cluster is re-opened after being addressed,
 * the prior outcome is marked as recurred.
 *
 * Storage: <dataDir>/autonomy/cross_system/outcomes/<outcomeId>.json
 * Retention: OUTCOME_RETENTION_MS (30d)
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
    CrossSystemOutcomeRecord,
    ClusterId,
} from '../../../../shared/crossSystemTypes';
import { CROSS_SYSTEM_BOUNDS } from '../../../../shared/crossSystemTypes';
import { telemetry } from '../../TelemetryService';

// ─── CrossSystemOutcomeTracker ────────────────────────────────────────────────

export class CrossSystemOutcomeTracker {
    private readonly outcomesDir: string;
    /** In-memory cache of loaded outcome records, newest first. */
    private cache: CrossSystemOutcomeRecord[] = [];
    private cacheLoaded = false;

    constructor(dataDir: string) {
        this.outcomesDir = path.join(dataDir, 'autonomy', 'cross_system', 'outcomes');
        this._ensureDir(this.outcomesDir);
    }

    // ── Record ──────────────────────────────────────────────────────────────────

    /**
     * Persists a new outcome record to disk and updates the in-memory cache.
     */
    record(outcome: CrossSystemOutcomeRecord): void {
        this._persist(outcome);
        this._invalidateCache();

        telemetry.operational(
            'autonomy',
            'operational',
            outcome.succeeded ? 'info' : 'warn',
            'CrossSystemOutcomeTracker',
            `Outcome recorded: ${outcome.outcomeId} cluster=${outcome.clusterId} ` +
            `strategy=${outcome.strategyUsed} succeeded=${outcome.succeeded}`,
        );
    }

    // ── Recurrence detection ────────────────────────────────────────────────────

    /**
     * Marks the most recent outcome for the given cluster as recurred.
     * Called when a previously-addressed cluster is re-opened.
     */
    markRecurred(clusterId: ClusterId): void {
        if (!this.cacheLoaded) this._loadCache();

        const prior = this.cache.find(
            o => o.clusterId === clusterId && o.succeeded && !o.recurred,
        );
        if (!prior) return;

        prior.recurred = true;
        this._persist(prior);

        telemetry.operational(
            'autonomy',
            'operational',
            'warn',
            'CrossSystemOutcomeTracker',
            `Cluster ${clusterId} recurred — outcome ${prior.outcomeId} marked as recurred`,
        );
    }

    // ── Query ───────────────────────────────────────────────────────────────────

    /**
     * Returns outcome records, newest first.
     * Optionally filtered to a retention window.
     */
    listOutcomes(windowMs?: number): CrossSystemOutcomeRecord[] {
        if (!this.cacheLoaded) this._loadCache();
        if (!windowMs) return [...this.cache];
        const cutoff = Date.now() - windowMs;
        return this.cache.filter(o => new Date(o.executedAt).getTime() >= cutoff);
    }

    /**
     * Returns the outcome record with the given ID, or null if not found.
     */
    getOutcome(outcomeId: string): CrossSystemOutcomeRecord | null {
        const file = path.join(this.outcomesDir, `${this._safeId(outcomeId)}.json`);
        if (!fs.existsSync(file)) return null;
        try {
            return JSON.parse(fs.readFileSync(file, 'utf-8')) as CrossSystemOutcomeRecord;
        } catch {
            return null;
        }
    }

    /**
     * Removes outcome records older than OUTCOME_RETENTION_MS.
     */
    purgeExpired(): void {
        const cutoff = Date.now() - CROSS_SYSTEM_BOUNDS.OUTCOME_RETENTION_MS;
        try {
            const files = fs.readdirSync(this.outcomesDir).filter(f => f.endsWith('.json'));
            let purged = 0;
            for (const f of files) {
                const file = path.join(this.outcomesDir, f);
                try {
                    const rec = JSON.parse(
                        fs.readFileSync(file, 'utf-8'),
                    ) as CrossSystemOutcomeRecord;
                    if (new Date(rec.executedAt).getTime() < cutoff) {
                        fs.unlinkSync(file);
                        purged++;
                    }
                } catch {
                    // skip corrupt files
                }
            }
            if (purged > 0) {
                this._invalidateCache();
                telemetry.operational(
                    'autonomy',
                    'operational',
                    'debug',
                    'CrossSystemOutcomeTracker',
                    `Purged ${purged} expired outcome record(s)`,
                );
            }
        } catch {
            // non-fatal
        }
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _persist(outcome: CrossSystemOutcomeRecord): void {
        const file = path.join(this.outcomesDir, `${this._safeId(outcome.outcomeId)}.json`);
        try {
            fs.writeFileSync(file, JSON.stringify(outcome, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'CrossSystemOutcomeTracker',
                `Failed to persist outcome ${outcome.outcomeId}: ${err.message}`,
            );
        }
    }

    private _loadCache(): void {
        this.cache = [];
        try {
            const files = fs.readdirSync(this.outcomesDir).filter(f => f.endsWith('.json'));
            for (const f of files) {
                try {
                    const rec = JSON.parse(
                        fs.readFileSync(path.join(this.outcomesDir, f), 'utf-8'),
                    ) as CrossSystemOutcomeRecord;
                    this.cache.push(rec);
                } catch {
                    // skip corrupt files
                }
            }
        } catch {
            // non-fatal: empty cache if directory unreadable
        }
        this.cache.sort(
            (a, b) => new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime(),
        );
        this.cacheLoaded = true;
    }

    private _invalidateCache(): void {
        this.cache = [];
        this.cacheLoaded = false;
    }

    private _safeId(id: string): string {
        return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
    }

    private _ensureDir(dir: string): void {
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        } catch {
            // non-fatal
        }
    }
}
