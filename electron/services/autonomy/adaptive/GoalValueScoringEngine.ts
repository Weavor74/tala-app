/**
 * GoalValueScoringEngine.ts — Phase 5 P5B
 *
 * Adaptive value scoring for autonomous goals.
 *
 * Computes a GoalValueScore for each goal by combining:
 *   - Phase 4C base score (from GoalPrioritizationEngine)
 *   - Subsystem profile data (success rate, rollback likelihood)
 *   - Recovery pack confidence (if available)
 *   - Sensitivity tier bonus
 *   - Small-sample guard penalty
 *
 * Scoring formula (all inputs normalized to 0–100):
 *
 *   valueScore = clamp(
 *     baseScore            × 0.50   (P4C priority score carries 50% weight)
 *   + successProbability   × 25     (0.0–1.0 → 0–25 pts)
 *   + packConfidence       × 10     (0.0–1.0 → 0–10 pts)
 *   + sensitivityBonus              (0 | +5 | +10 based on sensitivity tier)
 *   − executionCostScore   × 0.30   (0–15 → 0–4.5 pts penalty)
 *   − rollbackLikelihood   × 15     (0.0–1.0 → 0–15 pts penalty)
 *   + governanceLikelihood × 5      (0.0–1.0 → 0–5 pts bonus)
 *   + smallSamplePenalty            (0 or −5 when totalAttempts < 3)
 *   , 0, 100)
 *
 * successProbability blending:
 *   - 70% from SubsystemProfile.successRate (empirical per-subsystem success rate)
 *   - 30% from OutcomeLearningRegistry confidence modifier (per-pattern history)
 *   - When no history exists, both default to 0.7 (INITIAL_CONFIDENCE baseline)
 *
 * Design principle: DETERMINISTIC FIRST — same inputs → identical output.
 * All inputs are deterministic. No model calls.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    GoalValueScore,
    GoalValueScoreExplanation,
    SubsystemProfile,
} from '../../../../shared/adaptiveTypes';
import type { AutonomousGoal } from '../../../../shared/autonomyTypes';
import type { RecoveryPackMatchResult } from '../../../../shared/recoveryPackTypes';
import type { RecoveryPackRegistry } from '../recovery/RecoveryPackRegistry';
import type { OutcomeLearningRegistry } from '../OutcomeLearningRegistry';

// ─── Constants ────────────────────────────────────────────────────────────────

const INITIAL_CONFIDENCE = 0.7;
const SMALL_SAMPLE_THRESHOLD = 3;
const SMALL_SAMPLE_PENALTY = -5;

// Per-source execution cost scores (higher = more expensive to execute)
const SOURCE_COST_SCORES: Record<string, number> = {
    user_seeded: 15,
    repeated_execution_failure: 8,
    failed_verification: 8,
    telemetry_anomaly: 6,
    repeated_governance_block: 6,
    recurring_reflection_goal: 5,
    stale_subsystem: 4,
    unresolved_backlog_item: 4,
    weak_coverage_signal: 3,
};

// ─── GoalValueScoringEngine ───────────────────────────────────────────────────

export class GoalValueScoringEngine {
    constructor(
        private readonly learningRegistry: OutcomeLearningRegistry,
        /** Optional: used to look up the best pack's current confidence. */
        private readonly packRegistry?: RecoveryPackRegistry,
    ) {}

    /**
     * Scores a goal using adaptive signals from the subsystem profile and
     * recovery pack availability.
     *
     * Deterministic: same goal + same profile + same pack state → same GoalValueScore.
     */
    score(
        goal: AutonomousGoal,
        profile: SubsystemProfile,
        packMatchResult?: RecoveryPackMatchResult,
    ): GoalValueScore {
        const baseScore = goal.priorityScore.total;

        // ── Success probability ─────────────────────────────────────────────────
        // Blend: 70% empirical subsystem success rate + 30% per-pattern confidence
        const patternConfidence = this.learningRegistry.getConfidenceModifier(
            goal.dedupFingerprint,
        );
        const subsystemSuccessRate = profile.totalAttempts < 1
            ? INITIAL_CONFIDENCE // No history yet — start with initial confidence
            : profile.successRate;
        const successProbability = (subsystemSuccessRate * 0.7) + (patternConfidence * 0.3);

        // ── Pack confidence ─────────────────────────────────────────────────────
        let packConfidence = 0;
        let packAvailable = false;

        if (packMatchResult?.selectedPackId && this.packRegistry) {
            const pack = this.packRegistry.getById(packMatchResult.selectedPackId);
            if (pack) {
                packConfidence = pack.confidence.current;
                packAvailable = true;
            }
        } else if (packMatchResult?.selectedPackId) {
            // Pack matched but no registry to look up confidence — use 0.5 as neutral
            packConfidence = 0.5;
            packAvailable = true;
        }

        // ── Sensitivity bonus ───────────────────────────────────────────────────
        let sensitivityBonus = 0;
        if (profile.sensitivityLevel === 'critical') sensitivityBonus = 10;
        else if (profile.sensitivityLevel === 'high') sensitivityBonus = 5;
        // standard and low: no bonus

        // ── Execution cost score ────────────────────────────────────────────────
        const executionCostScore = SOURCE_COST_SCORES[goal.source] ?? 5;

        // ── Rollback likelihood ─────────────────────────────────────────────────
        // From profile when history exists; 0 when no history
        const rollbackLikelihood = profile.totalAttempts < 1 ? 0 : profile.rollbackLikelihood;

        // ── Governance likelihood ───────────────────────────────────────────────
        // 1 − governance block rate; defaults to 0.8 when no history
        const governanceLikelihood = profile.totalAttempts < 1
            ? 0.8
            : 1.0 - (profile.governanceBlockCount / Math.max(1, profile.totalAttempts));

        // ── Small sample guard ──────────────────────────────────────────────────
        const smallSamplePenalty = profile.totalAttempts < SMALL_SAMPLE_THRESHOLD
            ? SMALL_SAMPLE_PENALTY
            : 0;

        // ── Composite value score ───────────────────────────────────────────────
        const raw =
            (baseScore          * 0.50)
            + (successProbability * 25.0)
            + (packConfidence     * 10.0)
            + sensitivityBonus
            - (executionCostScore * 0.30)
            - (rollbackLikelihood * 15.0)
            + (governanceLikelihood * 5.0)
            + smallSamplePenalty;

        const valueScore = Math.round(Math.max(0, Math.min(100, raw)));

        // ── Explanation ─────────────────────────────────────────────────────────
        const explanation = this._buildExplanation(
            baseScore, successProbability, packConfidence, packAvailable,
            sensitivityBonus, executionCostScore, rollbackLikelihood,
            governanceLikelihood, smallSamplePenalty, valueScore,
        );

        return {
            goalId: goal.goalId,
            computedAt: new Date().toISOString(),
            baseScore,
            successProbability: Math.round(successProbability * 1000) / 1000,
            packConfidence: Math.round(packConfidence * 1000) / 1000,
            packAvailable,
            rollbackLikelihood: Math.round(rollbackLikelihood * 1000) / 1000,
            governanceLikelihood: Math.round(governanceLikelihood * 1000) / 1000,
            smallSamplePenalty,
            valueScore,
            explanation,
        };
    }

    // ── Explanation building ─────────────────────────────────────────────────

    private _buildExplanation(
        baseScore: number,
        successProbability: number,
        packConfidence: number,
        packAvailable: boolean,
        sensitivityBonus: number,
        executionCostScore: number,
        rollbackLikelihood: number,
        governanceLikelihood: number,
        smallSamplePenalty: number,
        valueScore: number,
    ): GoalValueScoreExplanation {
        const dominantFactors: string[] = [];
        const suppressionFactors: string[] = [];

        // Dominant: high base score
        if (baseScore >= 60) {
            dominantFactors.push(`high base priority (${baseScore})`);
        }
        // Dominant: high success probability
        if (successProbability >= 0.65) {
            dominantFactors.push(`high success probability (${(successProbability * 100).toFixed(0)}%)`);
        }
        // Dominant: pack available with good confidence
        if (packAvailable && packConfidence >= 0.6) {
            dominantFactors.push(`recovery pack available (conf ${(packConfidence * 100).toFixed(0)}%)`);
        }
        // Dominant: sensitivity bonus
        if (sensitivityBonus > 0) {
            dominantFactors.push(`subsystem sensitivity bonus (+${sensitivityBonus})`);
        }

        // Suppression: low success probability
        if (successProbability < 0.4) {
            suppressionFactors.push(`low success probability (${(successProbability * 100).toFixed(0)}%)`);
        }
        // Suppression: high rollback likelihood
        if (rollbackLikelihood > 0.3) {
            suppressionFactors.push(`high rollback likelihood (${(rollbackLikelihood * 100).toFixed(0)}%)`);
        }
        // Suppression: low governance likelihood
        if (governanceLikelihood < 0.5) {
            suppressionFactors.push(`low governance approval likelihood (${(governanceLikelihood * 100).toFixed(0)}%)`);
        }
        // Suppression: high execution cost
        if (executionCostScore >= 12) {
            suppressionFactors.push(`high execution cost score (${executionCostScore})`);
        }
        // Suppression: small sample penalty
        if (smallSamplePenalty < 0) {
            suppressionFactors.push(`small sample penalty (insufficient history)`);
        }

        if (dominantFactors.length === 0) {
            dominantFactors.push(`base score ${baseScore}`);
        }

        return {
            dominantFactors,
            suppressionFactors,
            notes: valueScore < 20
                ? 'Low value score; goal will likely be suppressed or deferred.'
                : undefined,
        };
    }
}
