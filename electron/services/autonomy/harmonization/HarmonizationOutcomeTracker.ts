/**
 * HarmonizationOutcomeTracker.ts — Phase 5.6 P5.6G
 *
 * Records terminal outcomes of harmonization campaigns and adjusts rule confidence.
 *
 * Responsibilities:
 * - Write an immutable HarmonizationOutcomeRecord for each terminal campaign.
 * - Derive learning notes from the campaign's final state.
 * - Dispatch confidence adjustments to HarmonizationCanonRegistry.
 * - Persist records to disk for cross-session durability.
 * - Support retention window queries for dashboard display.
 *
 * Storage:
 *   <dataDir>/autonomy/harmonization/outcomes/<campaignId>.json
 *
 * Mirrors CampaignOutcomeTracker / RecoveryPackOutcomeTracker patterns.
 * Records are append-only — never mutated after creation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    HarmonizationCampaign,
    HarmonizationCampaignStatus,
    HarmonizationOutcomeRecord,
    HarmonizationCampaignId,
} from '../../../../shared/harmonizationTypes';
import type { HarmonizationCanonRegistry } from './HarmonizationCanonRegistry';
import { telemetry } from '../../TelemetryService';

// ─── Retention ────────────────────────────────────────────────────────────────

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_RETENTION_MS = DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MAX_CACHED_OUTCOMES = 200;

// ─── Terminal statuses ────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set<HarmonizationCampaignStatus>([
    'succeeded', 'failed', 'rolled_back', 'aborted', 'skipped', 'expired',
]);

// ─── HarmonizationOutcomeTracker ──────────────────────────────────────────────

export class HarmonizationOutcomeTracker {
    private readonly outcomesDir: string;
    private cache: HarmonizationOutcomeRecord[] = [];
    private cacheLoaded = false;

    constructor(
        dataDir: string,
        private readonly canonRegistry: HarmonizationCanonRegistry,
    ) {
        this.outcomesDir = path.join(dataDir, 'autonomy', 'harmonization', 'outcomes');
        this._ensureDir(this.outcomesDir);
    }

    // ── Record outcome ──────────────────────────────────────────────────────────

    /**
     * Records the terminal outcome of a harmonization campaign.
     * Adjusts rule confidence based on the outcome.
     * Must only be called when the campaign is in a terminal status.
     */
    record(
        campaign: HarmonizationCampaign,
        options?: {
            driftReducedConfirmed?: boolean;
            regressionDetected?: boolean;
        },
    ): HarmonizationOutcomeRecord {
        const now = new Date().toISOString();
        const succeeded = campaign.status === 'succeeded';
        const rollbackTriggered = campaign.status === 'rolled_back';
        const regressionDetected = options?.regressionDetected ?? false;
        const driftReducedConfirmed = options?.driftReducedConfirmed ?? succeeded;
        const filesModified = succeeded ? campaign.scope.targetFiles.length : 0;

        // Determine confidence delta
        let confidenceDeltaApplied = 0;
        let confidenceOutcome: 'succeeded' | 'failed' | 'regression_detected' | 'skipped' | 'governance_blocked';

        if (regressionDetected) {
            confidenceOutcome = 'regression_detected';
        } else if (succeeded) {
            confidenceOutcome = 'succeeded';
        } else if (campaign.status === 'skipped') {
            confidenceOutcome = 'skipped';
        } else {
            confidenceOutcome = 'failed';
        }

        // Apply confidence adjustment
        const ruleBefore = this.canonRegistry.getById(campaign.ruleId);
        const confidenceBefore = ruleBefore?.confidenceCurrent ?? 0;
        this.canonRegistry.updateConfidence(campaign.ruleId, confidenceOutcome);
        const ruleAfter = this.canonRegistry.getById(campaign.ruleId);
        const confidenceAfter = ruleAfter?.confidenceCurrent ?? confidenceBefore;
        confidenceDeltaApplied = Math.round((confidenceAfter - confidenceBefore) * 1000) / 1000;

        const learningNotes = this._deriveLearningNotes(campaign, succeeded, rollbackTriggered, regressionDetected);

        const record: HarmonizationOutcomeRecord = {
            outcomeId: `houtcome-${uuidv4()}`,
            campaignId: campaign.campaignId,
            ruleId: campaign.ruleId,
            driftId: campaign.driftId,
            subsystem: campaign.scope.targetSubsystem,
            patternClass: campaign.scope.patternClass,
            startedAt: campaign.createdAt,
            endedAt: campaign.updatedAt ?? now,
            finalStatus: campaign.status,
            succeeded,
            driftReducedConfirmed,
            regressionDetected,
            rollbackTriggered,
            filesModified,
            confidenceDeltaApplied,
            learningNotes,
        };

        this._persist(record);
        this._invalidateCache();

        telemetry.operational(
            'autonomy',
            'harmonization_outcome_recorded',
            'info',
            'HarmonizationOutcomeTracker',
            `Outcome recorded: campaign=${campaign.campaignId} status=${campaign.status} ` +
            `rule=${campaign.ruleId} confidenceDelta=${confidenceDeltaApplied}`,
        );

        return record;
    }

    // ── Query ───────────────────────────────────────────────────────────────────

    /**
     * Returns recent outcome records, newest first.
     * Optionally filtered to a time window.
     */
    listOutcomes(windowMs?: number): HarmonizationOutcomeRecord[] {
        if (!this.cacheLoaded) this._loadCache();
        const all = this.cache.slice(0, MAX_CACHED_OUTCOMES);
        if (!windowMs) return [...all];
        const cutoff = Date.now() - windowMs;
        return all.filter(r => new Date(r.endedAt).getTime() >= cutoff);
    }

    /**
     * Returns the outcome record for a specific campaign, or null if not found.
     */
    getRecord(campaignId: HarmonizationCampaignId): HarmonizationOutcomeRecord | null {
        const file = path.join(this.outcomesDir, `${this._safeId(campaignId)}.json`);
        if (!fs.existsSync(file)) return null;
        try {
            return JSON.parse(fs.readFileSync(file, 'utf-8')) as HarmonizationOutcomeRecord;
        } catch {
            return null;
        }
    }

    /**
     * Purges outcome records older than retentionMs.
     */
    purgeExpired(retentionMs = DEFAULT_RETENTION_MS): void {
        const cutoff = Date.now() - retentionMs;
        try {
            const files = fs.readdirSync(this.outcomesDir).filter(f => f.endsWith('.json'));
            for (const f of files) {
                const file = path.join(this.outcomesDir, f);
                try {
                    const rec = JSON.parse(
                        fs.readFileSync(file, 'utf-8'),
                    ) as HarmonizationOutcomeRecord;
                    if (new Date(rec.endedAt).getTime() < cutoff) {
                        fs.unlinkSync(file);
                    }
                } catch {
                    // skip corrupt
                }
            }
            this._invalidateCache();
        } catch {
            // non-fatal
        }
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _deriveLearningNotes(
        campaign: HarmonizationCampaign,
        succeeded: boolean,
        rollbackTriggered: boolean,
        regressionDetected: boolean,
    ): string[] {
        const notes: string[] = [];
        if (succeeded) {
            notes.push(`Harmonization succeeded: ${campaign.scope.targetFiles.length} file(s) converged to canon pattern`);
        }
        if (rollbackTriggered) {
            notes.push('Campaign terminated with rollback — rule confidence reduced');
        }
        if (regressionDetected) {
            notes.push('Post-campaign regression detected — rule confidence significantly reduced');
        }
        if (campaign.haltReason) {
            notes.push(`Campaign halted: ${campaign.haltReason}`);
        }
        if (campaign.status === 'skipped') {
            notes.push(`Campaign was skipped before execution (reason: ${campaign.haltReason ?? 'unspecified'})`);
        }
        return notes;
    }

    private _persist(record: HarmonizationOutcomeRecord): void {
        const file = path.join(this.outcomesDir, `${this._safeId(record.campaignId)}.json`);
        try {
            fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'HarmonizationOutcomeTracker',
                `Failed to persist outcome for campaign ${record.campaignId}: ${err.message}`,
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
                    ) as HarmonizationOutcomeRecord;
                    this.cache.push(rec);
                } catch {
                    // skip corrupt
                }
            }
        } catch {
            // non-fatal
        }
        this.cache.sort(
            (a, b) => new Date(b.endedAt).getTime() - new Date(a.endedAt).getTime(),
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

    /**
     * Returns true if the given status is terminal.
     */
    static isTerminal(status: HarmonizationCampaignStatus): boolean {
        return TERMINAL_STATUSES.has(status);
    }
}
