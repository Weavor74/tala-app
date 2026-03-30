/**
 * HarmonizationCanonRegistry.ts — Phase 5.6 P5.6B
 *
 * Source-controlled registry of harmonization canon rules.
 *
 * Responsibilities:
 * - Load static rule definitions from defaults/harmonizationCanon.ts (never written at runtime).
 * - Load per-rule confidence + enabled overrides from local disk.
 * - Merge static definitions with persisted overrides in memory.
 * - Expose getAll(), getById(), updateConfidence().
 * - Persist only runtime fields (confidence, status, counts) — never static definitions.
 *
 * Storage:
 *   <dataDir>/autonomy/harmonization/canon_registry.json
 *
 * Mirrors RecoveryPackRegistry / OutcomeLearningRegistry patterns exactly.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
    HarmonizationCanonRule,
    HarmonizationRuleId,
    HarmonizationRuleStatus,
} from '../../../../shared/harmonizationTypes';
import { BUILTIN_HARMONIZATION_RULES } from './defaults/harmonizationCanon';
import { telemetry } from '../../TelemetryService';

// ─── Override record shape (persisted) ───────────────────────────────────────

interface CanonRuleOverride {
    status: HarmonizationRuleStatus;
    confidenceCurrent: number;
    confidenceFloor: number;
    confidenceCeiling: number;
    successCount: number;
    failureCount: number;
    regressionCount: number;
    lastAdjustedAt?: string;
}

type OverrideMap = Record<HarmonizationRuleId, CanonRuleOverride>;

// ─── Confidence defaults ──────────────────────────────────────────────────────

const DEFAULT_CONFIDENCE_CURRENT = 0.65;
const DEFAULT_CONFIDENCE_FLOOR = 0.30;
const DEFAULT_CONFIDENCE_CEILING = 0.95;

// ─── Confidence adjustment deltas ────────────────────────────────────────────

const DELTA_SUCCEEDED = +0.04;
const DELTA_FAILED = -0.06;
const DELTA_REGRESSION = -0.10;

// ─── HarmonizationCanonRegistry ──────────────────────────────────────────────

export class HarmonizationCanonRegistry {
    private readonly registryFile: string;
    /** In-memory merged view: static definition + applied overrides. */
    private rules: Map<HarmonizationRuleId, HarmonizationCanonRule> = new Map();

    constructor(dataDir: string) {
        const harmonizationDir = path.join(dataDir, 'autonomy', 'harmonization');
        this.registryFile = path.join(harmonizationDir, 'canon_registry.json');
        this._ensureDir(harmonizationDir);
        this._load();
    }

    // ── Query ───────────────────────────────────────────────────────────────────

    /**
     * Returns all rules. When activeOnly=true, only returns rules with status='active'.
     */
    getAll(activeOnly = false): HarmonizationCanonRule[] {
        const all = [...this.rules.values()];
        return activeOnly ? all.filter(r => r.status === 'active') : all;
    }

    /**
     * Returns the rule with the given ID, or null if not found.
     */
    getById(ruleId: HarmonizationRuleId): HarmonizationCanonRule | null {
        return this.rules.get(ruleId) ?? null;
    }

    // ── Mutation ────────────────────────────────────────────────────────────────

    /**
     * Adjusts the confidence of a rule based on campaign outcome.
     * Clamps to [floor, ceiling]. Persists the updated override.
     *
     * Deltas:
     *   succeeded:          +0.04
     *   failed:             −0.06
     *   regression_detected: −0.10
     *   skipped / governance_blocked: no change
     */
    updateConfidence(
        ruleId: HarmonizationRuleId,
        outcome: 'succeeded' | 'failed' | 'regression_detected' | 'skipped' | 'governance_blocked',
    ): void {
        const rule = this.rules.get(ruleId);
        if (!rule) return;

        let delta = 0;
        if (outcome === 'succeeded') delta = DELTA_SUCCEEDED;
        else if (outcome === 'failed') delta = DELTA_FAILED;
        else if (outcome === 'regression_detected') delta = DELTA_REGRESSION;
        // skipped / governance_blocked → no delta

        if (delta === 0) {
            // still increment counts
            if (outcome === 'succeeded') rule.successCount++;
            return;
        }

        const prev = rule.confidenceCurrent;
        const next = Math.min(
            rule.confidenceCeiling,
            Math.max(rule.confidenceFloor, prev + delta),
        );
        const now = new Date().toISOString();

        rule.confidenceCurrent = next;
        rule.lastAdjustedAt = now;

        if (outcome === 'succeeded') rule.successCount++;
        else if (outcome === 'failed') rule.failureCount++;
        else if (outcome === 'regression_detected') rule.regressionCount++;

        this._persist();

        telemetry.operational(
            'autonomy',
            'harmonization_rule_confidence_adjusted',
            'info',
            'HarmonizationCanonRegistry',
            `Rule ${ruleId}: confidence adjusted ${prev.toFixed(3)} → ${next.toFixed(3)} (outcome=${outcome})`,
        );
    }

    /**
     * Enables or disables a rule by ID.
     */
    setRuleStatus(ruleId: HarmonizationRuleId, status: HarmonizationRuleStatus): void {
        const rule = this.rules.get(ruleId);
        if (!rule) return;
        rule.status = status;
        this._persist();
    }

    // ── Internal ────────────────────────────────────────────────────────────────

    private _load(): void {
        const overrides = this._readOverrides();

        for (const staticDef of BUILTIN_HARMONIZATION_RULES) {
            const override = overrides[staticDef.ruleId];
            const rule: HarmonizationCanonRule = {
                ...staticDef,
                status: override?.status ?? 'active',
                confidenceCurrent: override?.confidenceCurrent ?? DEFAULT_CONFIDENCE_CURRENT,
                confidenceFloor: override?.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR,
                confidenceCeiling: override?.confidenceCeiling ?? DEFAULT_CONFIDENCE_CEILING,
                successCount: override?.successCount ?? 0,
                failureCount: override?.failureCount ?? 0,
                regressionCount: override?.regressionCount ?? 0,
                lastAdjustedAt: override?.lastAdjustedAt,
            };
            this.rules.set(rule.ruleId, rule);
        }
    }

    private _readOverrides(): OverrideMap {
        try {
            if (fs.existsSync(this.registryFile)) {
                return JSON.parse(fs.readFileSync(this.registryFile, 'utf-8')) as OverrideMap;
            }
        } catch {
            // silent fallback
        }
        return {};
    }

    private _persist(): void {
        const map: OverrideMap = {};
        for (const [ruleId, rule] of this.rules) {
            map[ruleId] = {
                status: rule.status,
                confidenceCurrent: rule.confidenceCurrent,
                confidenceFloor: rule.confidenceFloor,
                confidenceCeiling: rule.confidenceCeiling,
                successCount: rule.successCount,
                failureCount: rule.failureCount,
                regressionCount: rule.regressionCount,
                lastAdjustedAt: rule.lastAdjustedAt,
            };
        }
        try {
            fs.writeFileSync(this.registryFile, JSON.stringify(map, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'HarmonizationCanonRegistry',
                `Failed to persist canon registry: ${err.message}`,
            );
        }
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
