/**
 * SubsystemProfileRegistry.ts — Phase 5 P5F
 *
 * Per-subsystem adaptive profile store.
 *
 * Responsibilities:
 * - Maintain one SubsystemProfile per subsystem ID.
 * - Update profiles after each autonomous run outcome (feedback loop).
 * - Persist profiles locally to survive restarts.
 * - Provide profiles to GoalValueScoringEngine, StrategySelectionEngine,
 *   and AdaptivePolicyGate.
 *
 * Storage: <dataDir>/autonomy/adaptive/profiles/<subsystemId>.json
 *
 * cooldownMultiplier adjustments (deterministic, bounded):
 *   succeeded:          × 0.7  (floor: 1.0)
 *   failed:             × 1.5  (ceiling: 4.0)
 *   rolled_back:        × 1.5  (ceiling: 4.0)
 *   governance_blocked: no change
 *   aborted:            no change
 *
 * oscillationDetected:
 *   Only evaluated when recentOutcomes.length >= 4.
 *   Looks for ≥ 2 alternating pairs in the last 4 outcomes.
 *
 * preferredStrategy:
 *   Only set when both pack and standard have ≥ 5 attempts.
 *   Requires a ≥ 15 percentage-point success-rate advantage.
 *
 * Design principle: DETERMINISTIC FIRST — no model calls.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
    SubsystemProfile,
    SubsystemSensitivity,
    StrategyKind,
} from '../../../../shared/adaptiveTypes';
import type { AttemptOutcome } from '../../../../shared/autonomyTypes';
import { telemetry } from '../../TelemetryService';

// ─── Constants ────────────────────────────────────────────────────────────────

const COOLDOWN_INCREASE_FACTOR = 1.5;
const COOLDOWN_DECREASE_FACTOR = 0.7;
const COOLDOWN_MIN = 1.0;
const COOLDOWN_MAX = 4.0;
const RECENT_OUTCOMES_MAX = 8;
const PREFERRED_STRATEGY_MIN_ATTEMPTS = 5;
const PREFERRED_STRATEGY_MIN_ADVANTAGE = 0.15; // 15 percentage points
const SMALL_SAMPLE_THRESHOLD = 3;

// ─── Subsystem sensitivity classification ────────────────────────────────────

const CRITICAL_SUBSYSTEMS = new Set([
    'identity', 'soul', 'governance', 'security', 'auth',
]);
const HIGH_SUBSYSTEMS = new Set([
    'inference', 'memory', 'reflection', 'execution', 'mcp',
]);
const STANDARD_SUBSYSTEMS = new Set([
    'retrieval', 'search', 'context', 'router', 'cognitive',
]);

function inferSensitivity(subsystemId: string): SubsystemSensitivity {
    const id = subsystemId.toLowerCase();
    if (CRITICAL_SUBSYSTEMS.has(id)) return 'critical';
    if (HIGH_SUBSYSTEMS.has(id))     return 'high';
    if (STANDARD_SUBSYSTEMS.has(id)) return 'standard';
    return 'low';
}

// ─── SubsystemProfileRegistry ─────────────────────────────────────────────────

export class SubsystemProfileRegistry {
    private readonly profileDir: string;
    private readonly cache: Map<string, SubsystemProfile> = new Map();

    constructor(dataDir: string) {
        const adaptiveDir = path.join(dataDir, 'autonomy', 'adaptive');
        this.profileDir = path.join(adaptiveDir, 'profiles');
        try {
            if (!fs.existsSync(this.profileDir)) {
                fs.mkdirSync(this.profileDir, { recursive: true });
            }
        } catch {
            // Non-fatal; cache-only operation
        }
        this._loadAll();
    }

    // ── Public API ──────────────────────────────────────────────────────────────

    /**
     * Returns the profile for the given subsystem.
     * If no profile has been recorded yet, returns a safe default.
     * Never returns null.
     */
    get(subsystemId: string): SubsystemProfile {
        if (this.cache.has(subsystemId)) {
            return this.cache.get(subsystemId)!;
        }
        return this._defaultProfile(subsystemId);
    }

    /**
     * Records an outcome for a subsystem after an autonomous run completes.
     * Updates the profile in-memory and persists to disk.
     *
     * @param subsystemId  The subsystem the run operated on.
     * @param outcome      The final run outcome.
     * @param strategyUsed The strategy that was used for this run.
     * @param packId       The recovery pack ID (only set when strategyUsed = 'recovery_pack').
     */
    update(
        subsystemId: string,
        outcome: AttemptOutcome,
        strategyUsed: StrategyKind,
        _packId?: string,
    ): SubsystemProfile {
        const existing = this.cache.get(subsystemId) ?? this._defaultProfile(subsystemId);
        const updated = this._applyOutcome(existing, outcome, strategyUsed);
        this.cache.set(subsystemId, updated);
        this._persist(updated);

        telemetry.operational(
            'autonomy',
            'operational',
            'debug',
            'SubsystemProfileRegistry',
            `Profile updated for ${subsystemId}: outcome=${outcome}, strategy=${strategyUsed}, ` +
            `cooldown×=${updated.cooldownMultiplier.toFixed(2)}, successRate=${(updated.successRate * 100).toFixed(0)}%`,
        );

        return updated;
    }

    /**
     * Returns all profiles sorted alphabetically by subsystem ID.
     */
    listAll(): SubsystemProfile[] {
        return [...this.cache.values()].sort((a, b) =>
            a.subsystemId.localeCompare(b.subsystemId),
        );
    }

    // ── Profile computation ─────────────────────────────────────────────────────

    private _applyOutcome(
        profile: SubsystemProfile,
        outcome: AttemptOutcome,
        strategyUsed: StrategyKind,
    ): SubsystemProfile {
        // Step 1: Increment total attempts (aborted outcomes do not count toward learning)
        const isLearnable = outcome !== 'aborted' && outcome !== 'policy_blocked';
        const totalAttempts = isLearnable
            ? profile.totalAttempts + 1
            : profile.totalAttempts;

        // Step 2: Increment outcome counts
        let successCount    = profile.successCount;
        let failureCount    = profile.failureCount;
        let rollbackCount   = profile.rollbackCount;
        let governanceBlockCount = profile.governanceBlockCount;

        if (isLearnable) {
            if (outcome === 'succeeded')         successCount++;
            else if (outcome === 'failed')       failureCount++;
            else if (outcome === 'rolled_back')  rollbackCount++;
            else if (outcome === 'governance_blocked') governanceBlockCount++;
        }

        // Step 3: Update strategy-specific counts (only for pack and standard)
        let packSuccessCount    = profile.packSuccessCount;
        let packFailureCount    = profile.packFailureCount;
        let standardSuccessCount = profile.standardSuccessCount;
        let standardFailureCount = profile.standardFailureCount;

        if (isLearnable) {
            if (strategyUsed === 'recovery_pack') {
                if (outcome === 'succeeded') packSuccessCount++;
                else if (outcome === 'failed' || outcome === 'rolled_back') packFailureCount++;
            } else if (strategyUsed === 'standard_planning') {
                if (outcome === 'succeeded') standardSuccessCount++;
                else if (outcome === 'failed' || outcome === 'rolled_back') standardFailureCount++;
            }
        }

        // Step 4: Recalculate rates from counts (never store rates without counts)
        const successRate      = successCount / Math.max(1, totalAttempts);
        const failureRate      = failureCount / Math.max(1, totalAttempts);
        const rollbackLikelihood = rollbackCount / Math.max(1, totalAttempts);

        // Step 5: Update cooldown multiplier
        let cooldownMultiplier = profile.cooldownMultiplier;
        if (outcome === 'succeeded') {
            cooldownMultiplier = Math.max(COOLDOWN_MIN,
                cooldownMultiplier * COOLDOWN_DECREASE_FACTOR);
        } else if (outcome === 'failed' || outcome === 'rolled_back') {
            cooldownMultiplier = Math.min(COOLDOWN_MAX,
                cooldownMultiplier * COOLDOWN_INCREASE_FACTOR);
        }
        // governance_blocked, aborted, policy_blocked: no change

        // Step 6: Update consecutiveFailures
        let consecutiveFailures = profile.consecutiveFailures;
        if (outcome === 'failed' || outcome === 'rolled_back') {
            consecutiveFailures++;
        } else if (outcome === 'succeeded') {
            consecutiveFailures = 0;
        }

        // Step 7: Update recentOutcomes ring buffer (last 8)
        let recentOutcomes: SubsystemProfile['recentOutcomes'] = [...profile.recentOutcomes];
        if (isLearnable && (
            outcome === 'succeeded' || outcome === 'failed' ||
            outcome === 'rolled_back' || outcome === 'governance_blocked'
        )) {
            recentOutcomes = [
                ...recentOutcomes,
                outcome as 'succeeded' | 'failed' | 'rolled_back' | 'governance_blocked',
            ].slice(-RECENT_OUTCOMES_MAX);
        }

        // Step 8: Oscillation detection (requires ≥ 4 outcomes)
        const oscillationDetected = this._detectOscillation(recentOutcomes);

        // Step 9: Preferred strategy (requires ≥ 5 attempts of each strategy type)
        const preferredStrategy = this._computePreferredStrategy(
            packSuccessCount, packFailureCount, standardSuccessCount, standardFailureCount,
        );

        return {
            subsystemId: profile.subsystemId,
            updatedAt: new Date().toISOString(),
            totalAttempts,
            successCount,
            failureCount,
            rollbackCount,
            governanceBlockCount,
            successRate,
            failureRate,
            rollbackLikelihood,
            cooldownMultiplier,
            preferredStrategy,
            packSuccessCount,
            packFailureCount,
            standardSuccessCount,
            standardFailureCount,
            sensitivityLevel: profile.sensitivityLevel,
            oscillationDetected,
            consecutiveFailures,
            recentOutcomes,
        };
    }

    /**
     * Detects oscillation in the recent outcomes buffer.
     *
     * Oscillation = ≥ 2 alternating pairs (succeed→fail or fail→succeed)
     * in the last 4 outcomes. Only evaluated when length >= 4.
     */
    private _detectOscillation(
        recentOutcomes: SubsystemProfile['recentOutcomes'],
    ): boolean {
        if (recentOutcomes.length < 4) return false;

        const last4 = recentOutcomes.slice(-4);
        let alternatingPairs = 0;

        for (let i = 0; i < last4.length - 1; i++) {
            const a = last4[i];
            const b = last4[i + 1];
            const aIsSuccess = a === 'succeeded';
            const bIsSuccess = b === 'succeeded';
            if (aIsSuccess !== bIsSuccess) {
                alternatingPairs++;
            }
        }

        return alternatingPairs >= 2;
    }

    /**
     * Computes preferred strategy when enough data is available.
     *
     * Requires PREFERRED_STRATEGY_MIN_ATTEMPTS of each strategy.
     * Requires a PREFERRED_STRATEGY_MIN_ADVANTAGE success-rate advantage.
     * Returns null if criteria are not met.
     */
    private _computePreferredStrategy(
        packSuccess: number, packFailure: number,
        standardSuccess: number, standardFailure: number,
    ): StrategyKind | null {
        const packTotal = packSuccess + packFailure;
        const standardTotal = standardSuccess + standardFailure;

        if (packTotal < PREFERRED_STRATEGY_MIN_ATTEMPTS ||
            standardTotal < PREFERRED_STRATEGY_MIN_ATTEMPTS) {
            return null;
        }

        const packSuccessRate     = packSuccess / packTotal;
        const standardSuccessRate = standardSuccess / standardTotal;
        const advantage = packSuccessRate - standardSuccessRate;

        if (advantage >= PREFERRED_STRATEGY_MIN_ADVANTAGE) {
            return 'recovery_pack';
        }
        if (advantage <= -PREFERRED_STRATEGY_MIN_ADVANTAGE) {
            return 'standard_planning';
        }
        return null; // No significant preference
    }

    // ── Default profile ─────────────────────────────────────────────────────────

    private _defaultProfile(subsystemId: string): SubsystemProfile {
        return {
            subsystemId,
            updatedAt: new Date().toISOString(),
            totalAttempts: 0,
            successCount: 0,
            failureCount: 0,
            rollbackCount: 0,
            governanceBlockCount: 0,
            successRate: 0,
            failureRate: 0,
            rollbackLikelihood: 0,
            cooldownMultiplier: 1.0,
            preferredStrategy: null,
            packSuccessCount: 0,
            packFailureCount: 0,
            standardSuccessCount: 0,
            standardFailureCount: 0,
            sensitivityLevel: inferSensitivity(subsystemId),
            oscillationDetected: false,
            consecutiveFailures: 0,
            recentOutcomes: [],
        };
    }

    // ── Persistence ─────────────────────────────────────────────────────────────

    private _persist(profile: SubsystemProfile): void {
        try {
            const filePath = this._filePath(profile.subsystemId);
            fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'SubsystemProfileRegistry',
                `Failed to persist profile for ${profile.subsystemId}: ${err.message}`,
            );
        }
    }

    private _loadAll(): void {
        try {
            if (!fs.existsSync(this.profileDir)) return;
            const files = fs.readdirSync(this.profileDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                try {
                    const raw = fs.readFileSync(path.join(this.profileDir, file), 'utf8');
                    const profile: SubsystemProfile = JSON.parse(raw);
                    if (profile.subsystemId) {
                        this.cache.set(profile.subsystemId, profile);
                    }
                } catch {
                    // Skip corrupted files
                }
            }
        } catch {
            // Non-fatal
        }
    }

    private _filePath(subsystemId: string): string {
        // Sanitize subsystemId for use as filename
        const safe = subsystemId.replace(/[^a-zA-Z0-9_-]/g, '_');
        return path.join(this.profileDir, `${safe}.json`);
    }
}

export { SMALL_SAMPLE_THRESHOLD };
