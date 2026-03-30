/**
 * CampaignSafetyGuard.ts — Phase 5.5 P5.5I
 *
 * Safety bounds enforcement for the campaign layer.
 *
 * Responsibilities:
 * - Check all bounds before each step advance.
 * - Enforce the one-active-campaign-per-subsystem rule.
 * - Enforce cooldown after campaign failure or rollback.
 * - Detect and expire stale campaigns at startup.
 * - Block recursive campaign spawning.
 * - Provide a single checkBounds() entry point for the coordinator.
 *
 * Design principles:
 * - All checks are deterministic and rule-based.
 * - Checks are read-only; the guard never modifies campaign state.
 * - Failure returns a typed BoundsViolation describing which rule triggered.
 */

import type {
    RepairCampaign,
    RepairCampaignStatus,
} from '../../../../shared/repairCampaignTypes';
import type { RepairCampaignRegistry } from './RepairCampaignRegistry';
import { telemetry } from '../../TelemetryService';

// ─── BoundsViolation ──────────────────────────────────────────────────────────

export type BoundsViolationKind =
    | 'MAX_STEPS_EXCEEDED'
    | 'MAX_REASSESSMENTS_EXCEEDED'
    | 'CAMPAIGN_EXPIRED'
    | 'DUPLICATE_ACTIVE_CAMPAIGN'
    | 'COOLDOWN_ACTIVE'
    | 'TERMINAL_STATUS';

export interface BoundsViolation {
    kind: BoundsViolationKind;
    detail: string;
}

// ─── Cooldown store (in-memory, per subsystem) ─────────────────────────────────

interface CooldownRecord {
    subsystem: string;
    reason: 'failure' | 'rollback';
    expiresAt: number;  // epoch ms
}

// ─── CampaignSafetyGuard ──────────────────────────────────────────────────────

export class CampaignSafetyGuard {
    private readonly cooldowns: Map<string, CooldownRecord> = new Map();

    constructor(private readonly registry: RepairCampaignRegistry) {}

    // ── Pre-advance check ───────────────────────────────────────────────────────

    /**
     * Checks all bounds before the coordinator advances a campaign.
     *
     * Returns null when all checks pass.
     * Returns a BoundsViolation when any check fails.
     */
    checkBounds(campaign: RepairCampaign): BoundsViolation | null {
        // ── 1. Terminal status guard ──────────────────────────────────────────
        const TERMINAL: RepairCampaignStatus[] = [
            'succeeded', 'failed', 'rolled_back', 'aborted', 'expired',
        ];
        if (TERMINAL.includes(campaign.status)) {
            return {
                kind: 'TERMINAL_STATUS',
                detail: `Campaign ${campaign.campaignId} is already in terminal status '${campaign.status}'.`,
            };
        }

        // ── 2. Max steps exceeded ──────────────────────────────────────────────
        const attemptedSteps = campaign.steps.filter(
            s => s.status !== 'pending' && s.status !== 'skipped',
        ).length;
        if (attemptedSteps >= campaign.bounds.maxSteps) {
            this._log('warn', campaign.campaignId,
                `MAX_STEPS_EXCEEDED: ${attemptedSteps} steps attempted >= maxSteps=${campaign.bounds.maxSteps}`);
            return {
                kind: 'MAX_STEPS_EXCEEDED',
                detail: `Campaign ${campaign.campaignId} has attempted ${attemptedSteps} steps, ` +
                    `which equals or exceeds bounds.maxSteps=${campaign.bounds.maxSteps}.`,
            };
        }

        // ── 3. Max reassessments exceeded ──────────────────────────────────────
        if (campaign.reassessmentCount >= campaign.bounds.maxReassessments) {
            this._log('warn', campaign.campaignId,
                `MAX_REASSESSMENTS_EXCEEDED: ${campaign.reassessmentCount} >= maxReassessments=${campaign.bounds.maxReassessments}`);
            return {
                kind: 'MAX_REASSESSMENTS_EXCEEDED',
                detail: `Campaign ${campaign.campaignId} has made ${campaign.reassessmentCount} reassessments, ` +
                    `which equals or exceeds bounds.maxReassessments=${campaign.bounds.maxReassessments}.`,
            };
        }

        // ── 4. Age / expiry check ──────────────────────────────────────────────
        if (Date.now() > new Date(campaign.expiresAt).getTime()) {
            this._log('warn', campaign.campaignId,
                `CAMPAIGN_EXPIRED: now > expiresAt=${campaign.expiresAt}`);
            return {
                kind: 'CAMPAIGN_EXPIRED',
                detail: `Campaign ${campaign.campaignId} has exceeded its maximum age ` +
                    `(expiresAt=${campaign.expiresAt}).`,
            };
        }

        // ── 5. Cooldown check ─────────────────────────────────────────────────
        const cooldown = this.cooldowns.get(campaign.subsystem);
        if (cooldown && cooldown.expiresAt > Date.now()) {
            const remainingMs = cooldown.expiresAt - Date.now();
            this._log('warn', campaign.campaignId,
                `COOLDOWN_ACTIVE: subsystem ${campaign.subsystem} cooldown active for ${Math.round(remainingMs / 1000)}s`);
            return {
                kind: 'COOLDOWN_ACTIVE',
                detail: `Subsystem '${campaign.subsystem}' is in cooldown after ${cooldown.reason}. ` +
                    `Cooldown expires in ${Math.round(remainingMs / 1000)}s.`,
            };
        }

        return null; // all checks passed
    }

    // ── Pre-create check ────────────────────────────────────────────────────────

    /**
     * Checks whether creating a new campaign for the given subsystem is allowed.
     * Returns null when creation is allowed, or a BoundsViolation otherwise.
     */
    checkCanCreate(subsystem: string): BoundsViolation | null {
        // One active campaign per subsystem
        const existing = this.registry.getActiveForSubsystem(subsystem);
        if (existing) {
            return {
                kind: 'DUPLICATE_ACTIVE_CAMPAIGN',
                detail: `Subsystem '${subsystem}' already has an active campaign (${existing.campaignId} ` +
                    `in status '${existing.status}'). Complete or defer it before creating a new one.`,
            };
        }

        // Cooldown check
        const cooldown = this.cooldowns.get(subsystem);
        if (cooldown && cooldown.expiresAt > Date.now()) {
            const remainingMs = cooldown.expiresAt - Date.now();
            return {
                kind: 'COOLDOWN_ACTIVE',
                detail: `Subsystem '${subsystem}' is in cooldown after ${cooldown.reason}. ` +
                    `Cooldown expires in ${Math.round(remainingMs / 1000)}s.`,
            };
        }

        return null;
    }

    // ── Cooldown management ─────────────────────────────────────────────────────

    /**
     * Records a cooldown for a subsystem after a campaign failure or rollback.
     * The cooldown duration is taken from the campaign's bounds.
     */
    applyCooldown(campaign: RepairCampaign, reason: 'failure' | 'rollback'): void {
        const expiresAt = Date.now() + campaign.bounds.cooldownAfterFailureMs;
        this.cooldowns.set(campaign.subsystem, {
            subsystem: campaign.subsystem,
            reason,
            expiresAt,
        });
        this._log('info', campaign.campaignId,
            `Cooldown applied for subsystem '${campaign.subsystem}' after ${reason} — ` +
            `expires in ${Math.round(campaign.bounds.cooldownAfterFailureMs / 1000)}s`);
    }

    /**
     * Clears the cooldown for a subsystem (operator override).
     */
    clearCooldown(subsystem: string): void {
        this.cooldowns.delete(subsystem);
        telemetry.operational(
            'autonomy',
            'operational',
            'info',
            'CampaignSafetyGuard',
            `Cooldown cleared for subsystem '${subsystem}' by operator override`,
        );
    }

    /**
     * Returns true if the subsystem currently has an active cooldown.
     */
    hasCooldown(subsystem: string): boolean {
        const c = this.cooldowns.get(subsystem);
        return !!(c && c.expiresAt > Date.now());
    }

    // ── Startup recovery ────────────────────────────────────────────────────────

    /**
     * Marks all stale campaigns (past expiresAt) as 'expired'.
     * Called during main process startup, before the coordinator is active.
     *
     * Returns the list of campaigns that were expired.
     */
    recoverStaleCampaigns(): RepairCampaign[] {
        const stale = this.registry.getStaleCampaigns();
        for (const c of stale) {
            c.status = 'expired';
            c.haltReason = `Campaign exceeded maximum age (expiresAt=${c.expiresAt})`;
            this.registry.save(c);
            telemetry.operational(
                'autonomy',
                'campaign_expired',
                'warn',
                'CampaignSafetyGuard',
                `Stale campaign ${c.campaignId} expired at startup (subsystem=${c.subsystem})`,
            );
        }
        return stale;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _log(level: 'info' | 'warn', campaignId: string, detail: string): void {
        telemetry.operational(
            'autonomy',
            'campaign_safety_bound_triggered',
            level,
            'CampaignSafetyGuard',
            `[${campaignId}] ${detail}`,
        );
    }
}
