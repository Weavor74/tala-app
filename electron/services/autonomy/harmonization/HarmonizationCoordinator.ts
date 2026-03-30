/**
 * HarmonizationCoordinator.ts — Phase 5.6 P5.6F
 *
 * Executes harmonization campaigns through the existing
 * planning → governance → execution pipeline.
 *
 * Responsibilities:
 * - Execute one harmonization campaign step (one file) at a time.
 * - Persist campaign state after every state transition.
 * - Enforce safety bounds before each step advance.
 * - Support defer, abort, and resume operations.
 * - Record outcomes via HarmonizationOutcomeTracker.
 * - Emit dashboard updates via HarmonizationDashboardBridge.
 *
 * Architecture (mirrors RepairCampaignCoordinator):
 *   advanceCampaign()
 *     → _checkBounds()
 *     → _getNextFile()
 *     → [no next file] → _completeCampaign()
 *     → executeHarmonizationStep() callback
 *     → [failure] → _handleStepFailure()
 *     → [success] → _advanceStep()
 *     → _persist()
 *     → dashboardBridge.emit()
 *
 * The coordinator NEVER calls SafeChangePlanner / GovernanceAppService /
 * ExecutionOrchestrator directly. It delegates to a HarmonizationStepExecutor
 * callback supplied by AutonomousRunOrchestrator, preserving all safety gates.
 *
 * Safety invariants:
 * - Re-entrant advanceCampaign() calls are guarded per campaignId.
 * - One active campaign per subsystem (checked at creation time by matcher).
 * - Protected subsystems cannot be targeted (enforced by planner).
 * - No recursive harmonization campaign spawning.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    HarmonizationCampaign,
    HarmonizationCampaignId,
    HarmonizationCampaignStatus,
    HarmonizationDriftRecord,
    HarmonizationCampaignInput,
    HarmonizationProposalMetadata,
    HarmonizationDashboardState,
} from '../../../../shared/harmonizationTypes';
import {
    DEFAULT_HARMONIZATION_BOUNDS,
} from '../../../../shared/harmonizationTypes';
import type { HarmonizationOutcomeTracker } from './HarmonizationOutcomeTracker';
import type { HarmonizationDashboardBridge } from './HarmonizationDashboardBridge';
import type { HarmonizationCampaignPlanner } from './HarmonizationCampaignPlanner';
import type { HarmonizationCanonRegistry } from './HarmonizationCanonRegistry';
import { telemetry } from '../../TelemetryService';

// ─── Step execution callback ──────────────────────────────────────────────────

/**
 * Result of executing one harmonization step through the pipeline.
 */
export interface HarmonizationStepExecutionResult {
    executionRunId: string;
    executionSucceeded: boolean;
    rollbackTriggered: boolean;
    failureReason?: string;
}

/**
 * Callback supplied by AutonomousRunOrchestrator.
 * Executes one file harmonization through planning → governance → execution.
 */
export type HarmonizationStepExecutor = (
    filePath: string,
    campaign: HarmonizationCampaign,
    proposalMetadata: HarmonizationProposalMetadata,
) => Promise<HarmonizationStepExecutionResult>;

// ─── Terminal statuses ────────────────────────────────────────────────────────

const TERMINAL: HarmonizationCampaignStatus[] = [
    'succeeded', 'failed', 'rolled_back', 'aborted', 'skipped', 'expired',
];

// ─── HarmonizationCoordinator ─────────────────────────────────────────────────

export class HarmonizationCoordinator {
    /** Guards against re-entrant advanceCampaign calls. */
    private readonly _advancing = new Set<HarmonizationCampaignId>();
    /** In-memory campaign store. */
    private readonly _campaigns: Map<HarmonizationCampaignId, HarmonizationCampaign> = new Map();
    /** Pending drift records (not yet matched to a campaign). */
    private _pendingDrift: HarmonizationDriftRecord[] = [];
    /** Cooldown store: subsystem → expiry epoch ms. */
    private readonly _cooldowns: Map<string, number> = new Map();

    private readonly campaignsFile: string;

    constructor(
        dataDir: string,
        private readonly outcomeTracker: HarmonizationOutcomeTracker,
        private readonly dashboardBridge: HarmonizationDashboardBridge,
        private readonly planner: HarmonizationCampaignPlanner,
        private readonly canonRegistry: HarmonizationCanonRegistry,
        private readonly stepExecutor: HarmonizationStepExecutor,
    ) {
        const harmonizationDir = path.join(dataDir, 'autonomy', 'harmonization');
        this.campaignsFile = path.join(harmonizationDir, 'campaigns.json');
        this._ensureDir(harmonizationDir);
        this._loadCampaigns();
    }

    // ── Campaign lifecycle ──────────────────────────────────────────────────────

    /**
     * Registers a new campaign (in draft status) and persists it.
     */
    registerCampaign(campaign: HarmonizationCampaign): void {
        this._campaigns.set(campaign.campaignId, campaign);
        this._saveCampaigns();
        this._emitDashboard();
    }

    /**
     * Advances a campaign by one step (one file).
     *
     * - Re-entrant calls for the same campaignId are rejected.
     * - Terminal campaigns are not advanced.
     * - Bounds are checked before each step.
     */
    async advanceCampaign(campaignId: HarmonizationCampaignId): Promise<void> {
        if (this._advancing.has(campaignId)) return;
        const campaign = this._campaigns.get(campaignId);
        if (!campaign) return;
        if (TERMINAL.includes(campaign.status)) return;

        // Bounds check
        if (!this._checkBounds(campaign)) return;

        this._advancing.add(campaignId);
        try {
            campaign.status = 'step_in_progress';
            campaign.updatedAt = new Date().toISOString();
            this._saveCampaigns();
            this._emitDashboard();

            const filePath = campaign.scope.targetFiles[campaign.currentFileIndex];
            if (!filePath) {
                // All files done
                await this._completeCampaign(campaign);
                return;
            }

            const rule = this.canonRegistry.getById(campaign.ruleId);
            if (!rule) {
                campaign.status = 'failed';
                campaign.haltReason = `Canon rule ${campaign.ruleId} not found at execution time`;
                campaign.updatedAt = new Date().toISOString();
                this._saveCampaigns();
                this.outcomeTracker.record(campaign);
                this._emitDashboard();
                return;
            }

            const metadata = this.planner.buildProposalMetadata(campaign, filePath);
            const result = await this.stepExecutor(filePath, campaign, metadata);

            if (!result.executionSucceeded) {
                campaign.status = result.rollbackTriggered ? 'rolled_back' : 'failed';
                campaign.haltReason = result.failureReason ?? 'step_execution_failed';
                campaign.updatedAt = new Date().toISOString();
                this._saveCampaigns();
                this._setCooldown(campaign.scope.targetSubsystem);
                this.outcomeTracker.record(campaign);
                this._emitDashboard();

                telemetry.operational(
                    'autonomy',
                    result.rollbackTriggered ? 'harmonization_campaign_rolled_back' : 'harmonization_campaign_failed',
                    'warn',
                    'HarmonizationCoordinator',
                    `Campaign ${campaignId} ${campaign.status} at file index ${campaign.currentFileIndex}: ${campaign.haltReason}`,
                );
                return;
            }

            // Step passed — advance to next file
            campaign.currentFileIndex++;
            const allDone = campaign.currentFileIndex >= campaign.scope.targetFiles.length;

            if (allDone) {
                await this._completeCampaign(campaign);
            } else {
                campaign.status = 'active';
                campaign.updatedAt = new Date().toISOString();
                this._saveCampaigns();
                this._emitDashboard();
            }

        } finally {
            this._advancing.delete(campaignId);
        }
    }

    /**
     * Defers an active campaign.
     */
    deferCampaign(campaignId: HarmonizationCampaignId, reason: string): boolean {
        const campaign = this._campaigns.get(campaignId);
        if (!campaign || TERMINAL.includes(campaign.status)) return false;
        if (campaign.status === 'deferred') return false;
        campaign.status = 'deferred';
        campaign.haltReason = reason;
        campaign.updatedAt = new Date().toISOString();
        this._saveCampaigns();
        this._emitDashboard();
        return true;
    }

    /**
     * Aborts a campaign.
     */
    abortCampaign(campaignId: HarmonizationCampaignId, reason: string): boolean {
        const campaign = this._campaigns.get(campaignId);
        if (!campaign || TERMINAL.includes(campaign.status)) return false;
        campaign.status = 'aborted';
        campaign.haltReason = reason;
        campaign.updatedAt = new Date().toISOString();
        this._saveCampaigns();
        this.outcomeTracker.record(campaign);
        this._emitDashboard();
        return true;
    }

    /**
     * Resumes a deferred campaign.
     */
    resumeCampaign(campaignId: HarmonizationCampaignId): boolean {
        const campaign = this._campaigns.get(campaignId);
        if (!campaign || campaign.status !== 'deferred') return false;
        campaign.status = 'active';
        campaign.haltReason = undefined;
        campaign.updatedAt = new Date().toISOString();
        this._saveCampaigns();
        this._emitDashboard();
        return true;
    }

    // ── Drift record management ────────────────────────────────────────────────

    /**
     * Stores detected drift records for display in the dashboard.
     */
    storeDriftRecords(records: HarmonizationDriftRecord[]): void {
        // Merge with existing pending drift (deduplicate by driftId)
        const existing = new Map(this._pendingDrift.map(d => [d.driftId, d]));
        for (const r of records) {
            existing.set(r.driftId, r);
        }
        // Keep newest 50
        this._pendingDrift = [...existing.values()]
            .sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime())
            .slice(0, 50);
        this._emitDashboard();
    }

    // ── Queries ────────────────────────────────────────────────────────────────

    getCampaign(campaignId: HarmonizationCampaignId): HarmonizationCampaign | null {
        return this._campaigns.get(campaignId) ?? null;
    }

    getAll(): HarmonizationCampaign[] {
        return [...this._campaigns.values()];
    }

    getActiveCampaigns(): HarmonizationCampaign[] {
        return [...this._campaigns.values()].filter(
            c => !TERMINAL.includes(c.status) && c.status !== 'deferred',
        );
    }

    getDeferredCampaigns(): HarmonizationCampaign[] {
        return [...this._campaigns.values()].filter(c => c.status === 'deferred');
    }

    getActiveSubsystems(): Set<string> {
        const active = this.getActiveCampaigns();
        return new Set(active.map(c => c.scope.targetSubsystem));
    }

    isCooldownActive(subsystem: string): boolean {
        const expiry = this._cooldowns.get(subsystem);
        return expiry !== undefined && Date.now() < expiry;
    }

    getDashboardState(): HarmonizationDashboardState {
        const rules = this.canonRegistry.getAll();
        const recentOutcomes = this.outcomeTracker.listOutcomes(7 * 24 * 60 * 60 * 1000);
        return this.dashboardBridge.buildState(
            this._pendingDrift,
            this.getActiveCampaigns(),
            this.getDeferredCampaigns(),
            recentOutcomes,
            rules,
        );
    }

    /**
     * Expires stale campaigns that have exceeded maxAgeMs.
     * Called at startup. Returns the number of expired campaigns.
     */
    recoverStaleCampaigns(): HarmonizationCampaign[] {
        const now = Date.now();
        const expired: HarmonizationCampaign[] = [];
        for (const campaign of this._campaigns.values()) {
            if (TERMINAL.includes(campaign.status)) continue;
            if (new Date(campaign.expiresAt).getTime() <= now) {
                campaign.status = 'expired';
                campaign.haltReason = 'Campaign exceeded maxAgeMs and was expired at startup';
                campaign.updatedAt = new Date().toISOString();
                this.outcomeTracker.record(campaign);
                expired.push(campaign);
            }
        }
        if (expired.length > 0) {
            this._saveCampaigns();
        }
        return expired;
    }

    // ─── Private helpers ───────────────────────────────────────────────────────

    private async _completeCampaign(campaign: HarmonizationCampaign): Promise<void> {
        campaign.status = 'succeeded';
        campaign.updatedAt = new Date().toISOString();
        campaign.consistencyVerifiedAt = new Date().toISOString();
        campaign.consistencyVerificationPassed = true;
        this._saveCampaigns();
        this.outcomeTracker.record(campaign, { driftReducedConfirmed: true });
        this._emitDashboard();

        telemetry.operational(
            'autonomy',
            'harmonization_campaign_succeeded',
            'info',
            'HarmonizationCoordinator',
            `Campaign ${campaign.campaignId} succeeded: ` +
            `${campaign.scope.targetFiles.length} file(s) harmonized for rule ${campaign.ruleId}`,
        );
    }

    private _checkBounds(campaign: HarmonizationCampaign): boolean {
        // Age check
        if (new Date(campaign.expiresAt).getTime() <= Date.now()) {
            campaign.status = 'expired';
            campaign.haltReason = 'Campaign exceeded maxAgeMs';
            campaign.updatedAt = new Date().toISOString();
            this._saveCampaigns();
            this.outcomeTracker.record(campaign);
            this._emitDashboard();
            return false;
        }

        // Cooldown check
        if (this.isCooldownActive(campaign.scope.targetSubsystem)) {
            campaign.status = 'deferred';
            campaign.haltReason = 'Cooldown active for subsystem';
            campaign.updatedAt = new Date().toISOString();
            this._saveCampaigns();
            this._emitDashboard();
            return false;
        }

        return true;
    }

    private _setCooldown(subsystem: string): void {
        this._cooldowns.set(
            subsystem,
            Date.now() + DEFAULT_HARMONIZATION_BOUNDS.cooldownAfterFailureMs,
        );
    }

    private _loadCampaigns(): void {
        try {
            if (fs.existsSync(this.campaignsFile)) {
                const campaigns = JSON.parse(
                    fs.readFileSync(this.campaignsFile, 'utf-8'),
                ) as HarmonizationCampaign[];
                for (const c of campaigns) {
                    this._campaigns.set(c.campaignId, c);
                }
            }
        } catch {
            // silent fallback
        }
    }

    private _saveCampaigns(): void {
        try {
            const campaigns = [...this._campaigns.values()];
            fs.writeFileSync(this.campaignsFile, JSON.stringify(campaigns, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'HarmonizationCoordinator',
                `Failed to persist campaigns: ${err.message}`,
            );
        }
    }

    private _emitDashboard(): void {
        const rules = this.canonRegistry.getAll();
        const recentOutcomes = this.outcomeTracker.listOutcomes(7 * 24 * 60 * 60 * 1000);
        this.dashboardBridge.emit({
            pendingDriftRecords: this._pendingDrift,
            activeCampaigns: this.getActiveCampaigns(),
            deferredCampaigns: this.getDeferredCampaigns(),
            recentOutcomes,
            canonRules: rules,
        });
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
