/**
 * HarmonizationMatcher.ts — Phase 5.6 P5.6D
 *
 * Maps detected drift records to canon rules and derives a bounded scope.
 *
 * Responsibilities:
 * - Accept a HarmonizationDriftRecord and the active rule set.
 * - Locate the matching canon rule by ruleId.
 * - Evaluate 5 pre-match safety checks (P5.6I).
 * - Derive a HarmonizationScope limited to maxFiles and a single subsystem.
 * - Prefer narrowest scope: top N files by involvement when truncation needed.
 * - Return HarmonizationMatch with strength, disqualifiers, and safetyApproved.
 *
 * Match strength:
 *   strong_match — all safety checks pass; confidence above minimum margin
 *   weak_match   — drift detected but one or more soft disqualifiers apply
 *   no_match     — rule not found, disabled, or hard safety check failed
 *
 * Safety checks (P5.6I):
 *   1. Rule exists in registry
 *   2. Rule status === 'active'
 *   3. Rule confidence >= confidenceFloor + HARMONIZATION_MIN_CONFIDENCE_MARGIN
 *   4. Drift does not touch a protected subsystem
 *   5. No active harmonization campaign already running for this subsystem
 *   6. Drift severity >= rule.minDriftSeverity
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    HarmonizationDriftRecord,
    HarmonizationCanonRule,
    HarmonizationMatch,
    HarmonizationScope,
    HarmonizationMatchStrength,
} from '../../../../shared/harmonizationTypes';
import {
    DEFAULT_HARMONIZATION_BOUNDS,
    HARMONIZATION_MIN_CONFIDENCE_MARGIN,
} from '../../../../shared/harmonizationTypes';
import { PROTECTED_PATH_SEGMENTS } from './HarmonizationDriftDetector';
import { telemetry } from '../../TelemetryService';

// ─── HarmonizationMatcher ─────────────────────────────────────────────────────

export class HarmonizationMatcher {

    /**
     * Attempts to match a drift record to a canon rule and derive a safe scope.
     *
     * @param drift               Detected drift record.
     * @param rules               Active canon rules from HarmonizationCanonRegistry.
     * @param activeSubsystems    Set of subsystem labels that already have an active
     *                            harmonization campaign (prevents double-targeting).
     * @returns HarmonizationMatch, or null when matching is impossible.
     */
    match(
        drift: HarmonizationDriftRecord,
        rules: HarmonizationCanonRule[],
        activeSubsystems: Set<string> = new Set(),
    ): HarmonizationMatch | null {
        const disqualifiers: string[] = [];

        // ── Check 1: Rule exists ──────────────────────────────────────────────
        const rule = rules.find(r => r.ruleId === drift.ruleId);
        if (!rule) {
            this._logRejected(drift.driftId, drift.ruleId, 'rule_not_found');
            return null;
        }

        // ── Check 2: Rule is active ───────────────────────────────────────────
        if (rule.status !== 'active') {
            const match = this._buildMatch(drift, rule, 'no_match', ['rule_disabled'], false, 'rule_disabled');
            this._logRejected(drift.driftId, drift.ruleId, 'rule_disabled');
            return match;
        }

        // ── Check 3: Confidence above minimum margin ──────────────────────────
        const minConfidence = rule.confidenceFloor + HARMONIZATION_MIN_CONFIDENCE_MARGIN;
        if (rule.confidenceCurrent < minConfidence) {
            disqualifiers.push(
                `Rule confidence ${rule.confidenceCurrent.toFixed(3)} is below minimum ` +
                `(floor=${rule.confidenceFloor} + margin=${HARMONIZATION_MIN_CONFIDENCE_MARGIN})`,
            );
        }

        // ── Check 4: Protected subsystem ─────────────────────────────────────
        if (drift.touchesProtectedSubsystem) {
            disqualifiers.push('Drift touches a protected subsystem');
        }

        // ── Check 5: No active campaign for this subsystem ────────────────────
        const primarySubsystem = this._primarySubsystem(drift.affectedSubsystems);
        if (activeSubsystems.has(primarySubsystem)) {
            disqualifiers.push(
                `active harmonization campaign already exists for subsystem '${primarySubsystem}'`,
            );
        }

        // ── Check 6: Severity threshold ───────────────────────────────────────
        if (drift.driftSeverity < rule.minDriftSeverity) {
            disqualifiers.push(
                `Drift severity ${drift.driftSeverity} is below rule minimum ${rule.minDriftSeverity}`,
            );
        }

        // Hard disqualifiers → no match (protected subsystem or active campaign are hard blocks)
        if (drift.touchesProtectedSubsystem || activeSubsystems.has(primarySubsystem)) {
            const reason = drift.touchesProtectedSubsystem
                ? 'protected_subsystem'
                : 'active_campaign_conflict';
            const match = this._buildMatch(drift, rule, 'no_match', disqualifiers, false, reason);
            this._logRejected(drift.driftId, drift.ruleId, reason);
            return match;
        }

        // Determine strength
        const strength: HarmonizationMatchStrength = disqualifiers.length === 0
            ? 'strong_match'
            : 'weak_match';
        const safetyApproved = strength === 'strong_match';

        // Derive scope (always narrow — limited to maxFiles + single subsystem)
        const scope = this._deriveScope(drift, rule, primarySubsystem);

        const match = this._buildMatch(drift, rule, strength, disqualifiers, safetyApproved, undefined, scope);

        telemetry.operational(
            'autonomy',
            strength === 'strong_match' ? 'harmonization_rule_matched' : 'harmonization_rule_weak_match',
            'info',
            'HarmonizationMatcher',
            `Match: drift=${drift.driftId} rule=${rule.ruleId} strength=${strength} ` +
            `files=${scope.targetFiles.length} subsystem=${primarySubsystem}`,
        );

        return match;
    }

    // ─── Private helpers ───────────────────────────────────────────────────────

    private _deriveScope(
        drift: HarmonizationDriftRecord,
        rule: HarmonizationCanonRule,
        primarySubsystem: string,
    ): HarmonizationScope {
        // Exclude protected files
        const eligible = drift.affectedFiles.filter(
            f => !PROTECTED_PATH_SEGMENTS.some(seg => f.includes(seg)),
        );

        // Narrow to maxFiles — take first N (which are already the most-violated by scan order)
        const maxFiles = DEFAULT_HARMONIZATION_BOUNDS.maxFiles;
        const targetFiles = eligible.slice(0, maxFiles);
        const excludedFiles = eligible.slice(maxFiles);

        return {
            targetSubsystem: primarySubsystem,
            targetFiles,
            patternClass: rule.patternClass,
            intendedConvergence: rule.complianceDescription,
            excludedFiles,
        };
    }

    private _buildMatch(
        drift: HarmonizationDriftRecord,
        rule: HarmonizationCanonRule,
        strength: HarmonizationMatchStrength,
        disqualifiers: string[],
        safetyApproved: boolean,
        safetyBlockReason?: string,
        scope?: HarmonizationScope,
    ): HarmonizationMatch {
        const defaultScope: HarmonizationScope = {
            targetSubsystem: this._primarySubsystem(drift.affectedSubsystems),
            targetFiles: [],
            patternClass: rule.patternClass,
            intendedConvergence: rule.complianceDescription,
            excludedFiles: [],
        };
        return {
            matchId: `match-${uuidv4()}`,
            driftId: drift.driftId,
            ruleId: rule.ruleId,
            matchedAt: new Date().toISOString(),
            strength,
            matchConfidence: rule.confidenceCurrent,
            safetyApproved,
            safetyBlockReason,
            disqualifiers,
            proposedScope: scope ?? defaultScope,
        };
    }

    private _primarySubsystem(subsystems: readonly string[]): string {
        return subsystems[0] ?? 'general';
    }

    private _logRejected(driftId: string, ruleId: string, reason: string): void {
        telemetry.operational(
            'autonomy',
            'harmonization_rule_rejected',
            'info',
            'HarmonizationMatcher',
            `Match rejected: drift=${driftId} rule=${ruleId} reason=${reason}`,
        );
    }
}
