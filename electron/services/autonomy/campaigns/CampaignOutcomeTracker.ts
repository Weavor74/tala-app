/**
 * CampaignOutcomeTracker.ts — Phase 5.5 P5.5G
 *
 * Campaign outcome tracking and persistence.
 *
 * Responsibilities:
 * - Record terminal campaign outcomes as immutable CampaignExecutionRecord objects.
 * - Derive CampaignOutcomeSummary for dashboard display and learning inputs.
 * - Persist outcome records to disk for cross-session durability.
 * - Support retention window queries.
 *
 * Storage:
 *   <dataDir>/autonomy/campaigns/outcomes/<campaignId>.json
 *
 * Mirrors the pattern of RecoveryPackOutcomeTracker / OutcomeLearningRegistry.
 * Records are append-only — never mutated after creation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    RepairCampaign,
    CampaignExecutionRecord,
    CampaignOutcomeSummary,
    RepairCampaignId,
} from '../../../../shared/repairCampaignTypes';
import { telemetry } from '../../TelemetryService';

// ─── Retention ────────────────────────────────────────────────────────────────

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ─── CampaignOutcomeTracker ───────────────────────────────────────────────────

export class CampaignOutcomeTracker {
    private readonly outcomesDir: string;
    /** In-memory cache of outcome summaries (newest first). */
    private cache: CampaignOutcomeSummary[] = [];
    private cacheLoaded = false;

    constructor(dataDir: string) {
        this.outcomesDir = path.join(dataDir, 'autonomy', 'campaigns', 'outcomes');
        this._ensureDir(this.outcomesDir);
    }

    // ── Record outcome ──────────────────────────────────────────────────────────

    /**
     * Records the terminal outcome of a campaign.
     * Produces and persists a CampaignExecutionRecord and a CampaignOutcomeSummary.
     * Must only be called when the campaign is in a terminal status.
     *
     * @returns The immutable CampaignExecutionRecord that was stored.
     */
    record(campaign: RepairCampaign): CampaignExecutionRecord {
        const now = new Date().toISOString();

        const stepsAttempted = campaign.steps.filter(
            s => s.status !== 'pending' && s.status !== 'skipped',
        ).length;
        const stepsPassed = campaign.steps.filter(s => s.status === 'passed').length;
        const stepsFailed = campaign.steps.filter(s => s.status === 'failed').length;
        const stepsSkipped = campaign.steps.filter(s => s.status === 'skipped').length;
        const stepsRolledBack = campaign.steps.filter(s => s.status === 'rolled_back').length;

        const rollbackFrequency = stepsAttempted > 0
            ? Math.round((stepsRolledBack / stepsAttempted) * 100) / 100
            : 0;

        const haltedStep = campaign.steps.find(
            s => s.status === 'failed' || s.status === 'rolled_back',
        );

        const record: CampaignExecutionRecord = {
            recordId: `outcome-${uuidv4()}`,
            campaignId: campaign.campaignId,
            goalId: campaign.goalId,
            subsystem: campaign.subsystem,
            originType: campaign.originType,
            startedAt: campaign.createdAt,
            endedAt: campaign.updatedAt ?? now,
            finalStatus: campaign.status,
            stepsTotal: campaign.steps.length,
            stepsAttempted,
            stepsPassed,
            stepsFailed,
            stepsSkipped,
            stepsRolledBack,
            totalReassessments: campaign.reassessmentCount,
            haltedAtStepId: haltedStep?.stepId,
            haltReason: campaign.haltReason,
            rollbackTriggered: stepsRolledBack > 0,
            rollbackFrequency,
        };

        this._persist(record);
        this._invalidateCache();

        // Derive learning notes
        const learningNotes = this._deriveLearningNotes(campaign, record);

        const summary: CampaignOutcomeSummary = {
            campaignId: campaign.campaignId,
            goalId: campaign.goalId,
            label: campaign.label,
            subsystem: campaign.subsystem,
            originType: campaign.originType,
            finalStatus: campaign.status,
            succeeded: campaign.status === 'succeeded',
            rolledBack: campaign.status === 'rolled_back',
            deferred: campaign.status === 'deferred',
            stepCount: campaign.steps.length,
            rollbackFrequency,
            completedAt: record.endedAt,
            durationMs: new Date(record.endedAt).getTime() - new Date(record.startedAt).getTime(),
            learningNotes,
        };

        telemetry.operational(
            'autonomy',
            campaign.status === 'succeeded' ? 'campaign_completed' : 'campaign_halted',
            campaign.status === 'succeeded' ? 'info' : 'warn',
            'CampaignOutcomeTracker',
            `Campaign ${campaign.campaignId} outcome recorded: ${campaign.status} ` +
            `(${stepsPassed}/${stepsAttempted} steps passed, rollbackFreq=${rollbackFrequency})`,
        );

        return record;
    }

    // ── Query ───────────────────────────────────────────────────────────────────

    /**
     * Returns recent outcome summaries, newest first.
     * Optionally filtered to a time window.
     */
    listOutcomes(windowMs?: number): CampaignOutcomeSummary[] {
        if (!this.cacheLoaded) this._loadCache();
        if (!windowMs) return [...this.cache];
        const cutoff = Date.now() - windowMs;
        return this.cache.filter(s => new Date(s.completedAt).getTime() >= cutoff);
    }

    /**
     * Returns the execution record for a specific campaign, or null if not found.
     */
    getRecord(campaignId: RepairCampaignId): CampaignExecutionRecord | null {
        const file = path.join(this.outcomesDir, `${this._safeId(campaignId)}.json`);
        if (!fs.existsSync(file)) return null;
        try {
            return JSON.parse(fs.readFileSync(file, 'utf-8')) as CampaignExecutionRecord;
        } catch {
            return null;
        }
    }

    /**
     * Purges outcome records older than retentionMs.
     * Called lazily by listOutcomes or explicitly by the registry.
     */
    purgeExpired(retentionMs = DEFAULT_RETENTION_MS): void {
        const cutoff = Date.now() - retentionMs;
        try {
            const files = fs.readdirSync(this.outcomesDir).filter(f => f.endsWith('.json'));
            for (const f of files) {
                const file = path.join(this.outcomesDir, f);
                try {
                    const rec = JSON.parse(fs.readFileSync(file, 'utf-8')) as CampaignExecutionRecord;
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

    private _persist(record: CampaignExecutionRecord): void {
        const file = path.join(this.outcomesDir, `${this._safeId(record.campaignId)}.json`);
        try {
            fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'CampaignOutcomeTracker',
                `Failed to persist outcome record for campaign ${record.campaignId}: ${err.message}`,
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
                    ) as CampaignExecutionRecord;
                    this.cache.push(this._recordToSummary(rec));
                } catch {
                    // skip corrupt
                }
            }
        } catch {
            // non-fatal
        }
        this.cache.sort((a, b) =>
            new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime(),
        );
        this.cacheLoaded = true;
    }

    private _invalidateCache(): void {
        this.cache = [];
        this.cacheLoaded = false;
    }

    private _recordToSummary(rec: CampaignExecutionRecord): CampaignOutcomeSummary {
        return {
            campaignId: rec.campaignId,
            goalId: rec.goalId,
            label: rec.campaignId,  // label not stored in record; use ID as fallback
            subsystem: rec.subsystem,
            originType: rec.originType,
            finalStatus: rec.finalStatus,
            succeeded: rec.finalStatus === 'succeeded',
            rolledBack: rec.finalStatus === 'rolled_back',
            deferred: rec.finalStatus === 'deferred',
            stepCount: rec.stepsTotal,
            rollbackFrequency: rec.rollbackFrequency,
            completedAt: rec.endedAt,
            durationMs: new Date(rec.endedAt).getTime() - new Date(rec.startedAt).getTime(),
            learningNotes: [],
        };
    }

    private _deriveLearningNotes(
        campaign: RepairCampaign,
        record: CampaignExecutionRecord,
    ): string[] {
        const notes: string[] = [];

        if (record.rollbackFrequency > 0) {
            notes.push(
                `${Math.round(record.rollbackFrequency * 100)}% of steps required rollback ` +
                `(${record.stepsRolledBack} of ${record.stepsAttempted} attempted)`,
            );
        }
        if (record.stepsSkipped > 0) {
            notes.push(`${record.stepsSkipped} optional step(s) were skipped`);
        }
        if (campaign.reassessmentCount > 0) {
            notes.push(`${campaign.reassessmentCount} reassessment decision(s) were made`);
        }
        const haltedReassessment = campaign.reassessmentRecords.find(
            r => r.decision !== 'continue' && r.decision !== 'skip_step',
        );
        if (haltedReassessment) {
            notes.push(
                `Campaign halted at step ${haltedReassessment.stepId} ` +
                `via reassessment rule ${haltedReassessment.triggerRule}`,
            );
        }
        if (record.finalStatus === 'succeeded') {
            notes.push(`Campaign completed successfully in ${record.stepsTotal} step(s)`);
        }

        return notes;
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
