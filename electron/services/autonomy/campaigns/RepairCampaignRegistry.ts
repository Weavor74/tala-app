/**
 * RepairCampaignRegistry.ts — Phase 5.5 P5.5F (storage)
 *
 * Persistent registry of all repair campaigns.
 *
 * Responsibilities:
 * - Persist the full RepairCampaign object after every state transition.
 * - Load all campaigns from disk on startup (for resume-after-restart).
 * - Enforce the one-active-campaign-per-subsystem invariant.
 * - Provide query methods for active, deferred, and terminal campaigns.
 *
 * Storage layout:
 *   <dataDir>/autonomy/campaigns/active/<campaignId>.json   — full campaign state
 *   <dataDir>/autonomy/campaigns/index.json                  — lightweight index
 *
 * Non-active campaigns (terminal status) are moved to:
 *   <dataDir>/autonomy/campaigns/archive/<campaignId>.json
 *
 * Mirrors the pattern of OutcomeLearningRegistry / RecoveryPackRegistry.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
    RepairCampaign,
    RepairCampaignId,
    RepairCampaignStatus,
} from '../../../../shared/repairCampaignTypes';
import { telemetry } from '../../TelemetryService';

// ─── Terminal statuses (archived after recording) ─────────────────────────────

const TERMINAL_STATUSES = new Set<RepairCampaignStatus>([
    'succeeded', 'failed', 'rolled_back', 'aborted', 'expired',
]);

const ACTIVE_NON_TERMINAL_STATUSES = new Set<RepairCampaignStatus>([
    'draft', 'active', 'step_in_progress',
    'awaiting_checkpoint', 'awaiting_reassessment',
    'paused', 'deferred',
]);

// ─── Index entry ──────────────────────────────────────────────────────────────

interface CampaignIndexEntry {
    campaignId: RepairCampaignId;
    subsystem: string;
    status: RepairCampaignStatus;
    createdAt: string;
    updatedAt: string;
    archived: boolean;
}

type CampaignIndex = Record<string, CampaignIndexEntry>;

// ─── RepairCampaignRegistry ───────────────────────────────────────────────────

export class RepairCampaignRegistry {
    private readonly activeDir: string;
    private readonly archiveDir: string;
    private readonly indexFile: string;
    /** In-memory cache: campaignId → RepairCampaign. */
    private cache: Map<RepairCampaignId, RepairCampaign> = new Map();
    private loaded = false;

    constructor(dataDir: string) {
        const campaignsDir = path.join(dataDir, 'autonomy', 'campaigns');
        this.activeDir = path.join(campaignsDir, 'active');
        this.archiveDir = path.join(campaignsDir, 'archive');
        this.indexFile = path.join(campaignsDir, 'index.json');
        this._ensureDirs();
        this._loadAll();
    }

    // ── Write ───────────────────────────────────────────────────────────────────

    /**
     * Persists the campaign to disk and updates the in-memory cache.
     * Automatically moves terminal campaigns to the archive directory.
     * Must be called after every campaign state transition.
     */
    save(campaign: RepairCampaign): void {
        campaign.updatedAt = new Date().toISOString();
        this.cache.set(campaign.campaignId, campaign);

        const isTerminal = TERMINAL_STATUSES.has(campaign.status);
        const targetDir = isTerminal ? this.archiveDir : this.activeDir;
        const file = path.join(targetDir, `${this._safeId(campaign.campaignId)}.json`);

        // If transitioning from active to terminal, remove from active dir
        if (isTerminal) {
            const activeFile = path.join(this.activeDir, `${this._safeId(campaign.campaignId)}.json`);
            if (fs.existsSync(activeFile)) {
                try { fs.unlinkSync(activeFile); } catch { /* non-fatal */ }
            }
        }

        try {
            fs.writeFileSync(file, JSON.stringify(campaign, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'RepairCampaignRegistry',
                `Failed to persist campaign ${campaign.campaignId}: ${err.message}`,
            );
        }

        this._updateIndex(campaign);
    }

    // ── Query ───────────────────────────────────────────────────────────────────

    /**
     * Returns the campaign with the given ID from the cache, or null.
     */
    getById(campaignId: RepairCampaignId): RepairCampaign | null {
        return this.cache.get(campaignId) ?? null;
    }

    /**
     * Returns all campaigns matching the given status filter.
     * When no filter is provided, returns all campaigns.
     */
    getAll(statusFilter?: RepairCampaignStatus[]): RepairCampaign[] {
        const all = [...this.cache.values()];
        if (!statusFilter) return all;
        return all.filter(c => statusFilter.includes(c.status));
    }

    /**
     * Returns the single active campaign for a subsystem, or null.
     * Used to enforce the one-active-campaign-per-subsystem invariant.
     *
     * "Active" means any non-terminal, non-draft status.
     */
    getActiveForSubsystem(subsystem: string): RepairCampaign | null {
        for (const c of this.cache.values()) {
            if (c.subsystem === subsystem && ACTIVE_NON_TERMINAL_STATUSES.has(c.status)) {
                return c;
            }
        }
        return null;
    }

    /**
     * Returns all campaigns that are in an active (non-terminal) state.
     * Includes paused and deferred campaigns.
     */
    getActiveCampaigns(): RepairCampaign[] {
        return [...this.cache.values()].filter(c =>
            ACTIVE_NON_TERMINAL_STATUSES.has(c.status),
        );
    }

    /**
     * Returns campaigns in 'deferred' or 'paused' state (resumable).
     */
    getDeferredCampaigns(): RepairCampaign[] {
        return [...this.cache.values()].filter(
            c => c.status === 'deferred' || c.status === 'paused',
        );
    }

    /**
     * Returns stale campaigns: non-terminal campaigns that have exceeded expiresAt.
     * Called on startup for recovery.
     */
    getStaleCampaigns(): RepairCampaign[] {
        const now = Date.now();
        return [...this.cache.values()].filter(c =>
            ACTIVE_NON_TERMINAL_STATUSES.has(c.status) &&
            new Date(c.expiresAt).getTime() < now,
        );
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _loadAll(): void {
        // Load active campaigns
        try {
            const files = fs.readdirSync(this.activeDir).filter(f => f.endsWith('.json'));
            for (const f of files) {
                try {
                    const c = JSON.parse(
                        fs.readFileSync(path.join(this.activeDir, f), 'utf-8'),
                    ) as RepairCampaign;
                    this.cache.set(c.campaignId, c);
                } catch {
                    // skip corrupt
                }
            }
        } catch {
            // non-fatal
        }
        this.loaded = true;
    }

    private _updateIndex(campaign: RepairCampaign): void {
        let index: CampaignIndex = {};
        if (fs.existsSync(this.indexFile)) {
            try {
                index = JSON.parse(fs.readFileSync(this.indexFile, 'utf-8')) as CampaignIndex;
            } catch {
                index = {};
            }
        }
        index[campaign.campaignId] = {
            campaignId: campaign.campaignId,
            subsystem: campaign.subsystem,
            status: campaign.status,
            createdAt: campaign.createdAt,
            updatedAt: campaign.updatedAt,
            archived: TERMINAL_STATUSES.has(campaign.status),
        };
        try {
            fs.writeFileSync(this.indexFile, JSON.stringify(index, null, 2), 'utf-8');
        } catch {
            // non-fatal
        }
    }

    private _safeId(id: string): string {
        return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
    }

    private _ensureDirs(): void {
        for (const dir of [this.activeDir, this.archiveDir]) {
            try {
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
            } catch {
                // non-fatal
            }
        }
    }
}
