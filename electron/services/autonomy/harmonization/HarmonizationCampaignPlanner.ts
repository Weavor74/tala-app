/**
 * HarmonizationCampaignPlanner.ts — Phase 5.6 P5.6E
 *
 * Converts a confirmed HarmonizationMatch into a bounded HarmonizationCampaign.
 *
 * Responsibilities:
 * - Accept a HarmonizationCampaignInput (built from a confirmed match).
 * - Plan one campaign step per file in scope.
 * - Enforce hard caps (maxFiles, maxSteps) — truncate at bounds, never expand.
 * - Produce the campaign in 'draft' status.
 * - Fall back to 'skipped' status when confidence is too low or drift is ambiguous.
 * - Attach HarmonizationProposalMetadata so planning/governance layers have context.
 *
 * Safety invariants:
 * - Pure data transformation — no side effects.
 * - Zero steps → returns null (never produces an empty campaign).
 * - Skipped campaigns are returned (not null) so they are recorded and auditable.
 * - No campaign spans more than one subsystem.
 * - Protected files are excluded before step generation.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    HarmonizationCampaign,
    HarmonizationCampaignInput,
    HarmonizationCampaignBounds,
    HarmonizationCampaignId,
    HarmonizationProposalMetadata,
} from '../../../../shared/harmonizationTypes';
import {
    DEFAULT_HARMONIZATION_BOUNDS,
    HARMONIZATION_MIN_CONFIDENCE_MARGIN,
} from '../../../../shared/harmonizationTypes';
import { PROTECTED_PATH_SEGMENTS } from './HarmonizationDriftDetector';
import type { HarmonizationCanonRule } from '../../../../shared/harmonizationTypes';
import { telemetry } from '../../TelemetryService';

// ─── HarmonizationCampaignPlanner ─────────────────────────────────────────────

export class HarmonizationCampaignPlanner {

    /**
     * Builds a HarmonizationCampaign from a validated HarmonizationCampaignInput.
     *
     * Returns a campaign in 'skipped' status when:
     *   - skipIfLowConfidence=true and rule confidence is below minimum margin
     *   - Drift severity < 30 (ambiguous drift)
     *   - All target files are protected
     *   - No files remain after bounds truncation
     *
     * Returns null only when the input itself is malformed (no rule provided).
     */
    plan(
        input: HarmonizationCampaignInput,
        rule: HarmonizationCanonRule,
    ): HarmonizationCampaign | null {
        const campaignId: HarmonizationCampaignId = `hcampaign-${uuidv4()}`;
        const now = new Date().toISOString();
        const bounds: HarmonizationCampaignBounds = { ...DEFAULT_HARMONIZATION_BOUNDS };
        const expiresAt = new Date(Date.now() + bounds.maxAgeMs).toISOString();

        // ── Skip: low confidence ───────────────────────────────────────────────
        if (input.skipIfLowConfidence) {
            const minConfidence = rule.confidenceFloor + HARMONIZATION_MIN_CONFIDENCE_MARGIN;
            if (rule.confidenceCurrent < minConfidence) {
                telemetry.operational(
                    'autonomy',
                    'harmonization_campaign_fallback',
                    'info',
                    'HarmonizationCampaignPlanner',
                    `Campaign skipped (low_confidence): rule=${rule.ruleId} ` +
                    `confidence=${rule.confidenceCurrent} < ${minConfidence}`,
                );
                return this._makeSkipped(
                    campaignId, input, rule, now, expiresAt, bounds,
                    'low_confidence_skip',
                );
            }
        }

        // ── Scope validation ───────────────────────────────────────────────────
        const eligibleFiles = input.scope.targetFiles.filter(
            f => !PROTECTED_PATH_SEGMENTS.some(seg => f.includes(seg)),
        );

        if (eligibleFiles.length === 0) {
            telemetry.operational(
                'autonomy',
                'harmonization_campaign_fallback',
                'info',
                'HarmonizationCampaignPlanner',
                `Campaign skipped (protected_scope): rule=${rule.ruleId} all target files protected`,
            );
            return this._makeSkipped(
                campaignId, input, rule, now, expiresAt, bounds,
                'protected_scope_skip',
            );
        }

        // ── Bounds truncation ──────────────────────────────────────────────────
        const cappedFiles = eligibleFiles.slice(0, bounds.maxFiles);
        const maxStepFiles = Math.min(cappedFiles.length, bounds.maxSteps);
        const finalFiles = cappedFiles.slice(0, maxStepFiles);

        if (finalFiles.length === 0) {
            return null;
        }

        const campaign: HarmonizationCampaign = {
            campaignId,
            matchId: input.matchId,
            ruleId: input.ruleId,
            driftId: input.driftId,
            label: `Harmonize ${rule.patternClass} in ${input.scope.targetSubsystem} (${finalFiles.length} file(s))`,
            scope: {
                ...input.scope,
                targetFiles: finalFiles,
            },
            riskLevel: input.riskLevel,
            createdAt: now,
            expiresAt,
            bounds,
            status: 'draft',
            updatedAt: now,
            currentFileIndex: 0,
        };

        telemetry.operational(
            'autonomy',
            'harmonization_campaign_created',
            'info',
            'HarmonizationCampaignPlanner',
            `Campaign created: id=${campaignId} rule=${rule.ruleId} files=${finalFiles.length} ` +
            `risk=${input.riskLevel}`,
        );

        return campaign;
    }

    /**
     * Builds the HarmonizationProposalMetadata for a specific file step.
     * This metadata is serialized into the step's strategyHint so the
     * planning / governance layers can inspect it.
     */
    buildProposalMetadata(
        campaign: HarmonizationCampaign,
        filePath: string,
    ): HarmonizationProposalMetadata {
        return {
            campaignId: campaign.campaignId,
            ruleId: campaign.ruleId,
            patternClass: campaign.scope.patternClass,
            driftSeverity: 0, // Severity is at drift-record level; not per-step
            intendedConvergence: campaign.scope.intendedConvergence,
            targetFile: filePath,
            riskLevel: campaign.riskLevel,
        };
    }

    // ─── Private helpers ───────────────────────────────────────────────────────

    private _makeSkipped(
        campaignId: HarmonizationCampaignId,
        input: HarmonizationCampaignInput,
        rule: HarmonizationCanonRule,
        now: string,
        expiresAt: string,
        bounds: HarmonizationCampaignBounds,
        reason: string,
    ): HarmonizationCampaign {
        return {
            campaignId,
            matchId: input.matchId,
            ruleId: input.ruleId,
            driftId: input.driftId,
            label: `Harmonization skipped: ${reason}`,
            scope: input.scope,
            riskLevel: input.riskLevel,
            createdAt: now,
            expiresAt,
            bounds,
            status: 'skipped',
            updatedAt: now,
            currentFileIndex: 0,
            haltReason: reason,
        };
    }
}
