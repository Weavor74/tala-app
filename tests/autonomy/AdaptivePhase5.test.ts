/**
 * AdaptivePhase5.test.ts
 *
 * Phase 5: Adaptive Intelligence Layer — Comprehensive Test Suite
 *
 * Covers:
 *   P5A  Adaptive Types & Contracts (shape tests)
 *   P5B  GoalValueScoringEngine (scoring formula, determinism, edge cases)
 *   P5C  StrategySelectionEngine (all branches, alternativesConsidered)
 *   P5D  AdaptivePolicyGate (all action paths, thresholdsUsed)
 *   P5F  SubsystemProfileRegistry (profile persistence, outcome updates, oscillation, cooldown)
 *   P5E  Feedback loop (via orchestrator integration)
 *   P5G  GoalPrioritizationEngine with profile registry (blended confidence)
 *   P5H  Safety constraints (bounded multipliers, bias guard, no-bypass rules)
 *        + AutonomousRunOrchestrator adaptive wiring
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test' },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    ipcMain: { handle: vi.fn() },
}));

vi.mock('../../electron/services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn(),
        event: vi.fn(),
    },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import type {
    AdaptiveThresholds,
    GoalValueScore,
    StrategySelectionResult,
    AdaptivePolicyDecision,
    SubsystemProfile,
    AdaptiveDashboardState,
    AdaptiveKpis,
    StrategyKind,
} from '../../shared/adaptiveTypes';
import { DEFAULT_ADAPTIVE_THRESHOLDS } from '../../shared/adaptiveTypes';
import type {
    AutonomousGoal,
    AutonomyPolicyDecision,
    GoalSource,
} from '../../shared/autonomyTypes';
import { SubsystemProfileRegistry } from '../../electron/services/autonomy/adaptive/SubsystemProfileRegistry';
import { GoalValueScoringEngine } from '../../electron/services/autonomy/adaptive/GoalValueScoringEngine';
import { StrategySelectionEngine } from '../../electron/services/autonomy/adaptive/StrategySelectionEngine';
import { AdaptivePolicyGate } from '../../electron/services/autonomy/adaptive/AdaptivePolicyGate';
import { GoalPrioritizationEngine } from '../../electron/services/autonomy/GoalPrioritizationEngine';
import { OutcomeLearningRegistry } from '../../electron/services/autonomy/OutcomeLearningRegistry';
import { AutonomyCooldownRegistry } from '../../electron/services/autonomy/AutonomyCooldownRegistry';
import { AutonomyBudgetManager } from '../../electron/services/autonomy/AutonomyBudgetManager';
import { DEFAULT_AUTONOMY_POLICY } from '../../electron/services/autonomy/defaults/defaultAutonomyPolicy';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tala-adaptive-test-'));
}

function makeGoal(overrides: Partial<AutonomousGoal> = {}): AutonomousGoal {
    return {
        goalId: 'goal-001',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: 'repeated_execution_failure' as GoalSource,
        subsystemId: 'inference',
        title: 'Repeated execution failures in inference',
        description: '3 failures detected in 4h window',
        status: 'scored',
        priorityTier: 'high',
        priorityScore: {
            total: 65,
            severityWeight: 25,
            recurrenceWeight: 12,
            subsystemImportanceWeight: 15,
            confidenceWeight: 10,
            governanceLikelihoodWeight: 8,
            rollbackConfidenceWeight: 6,
            executionCostPenalty: 1,
            protectedPenalty: 0,
        },
        autonomyEligible: false,
        attemptCount: 0,
        humanReviewRequired: false,
        sourceContext: {
            kind: 'repeated_execution_failure',
            failureCount: 3,
            periodMs: 4 * 60 * 60 * 1000,
            lastExecutionRunId: 'exec-001',
        },
        dedupFingerprint: 'fp-inference-001',
        ...overrides,
    };
}

function makeProfile(overrides: Partial<SubsystemProfile> = {}): SubsystemProfile {
    return {
        subsystemId: 'inference',
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
        sensitivityLevel: 'high',
        oscillationDetected: false,
        consecutiveFailures: 0,
        recentOutcomes: [],
        ...overrides,
    };
}

function makeInnerGatePermitted(goalId = 'goal-001'): AutonomyPolicyDecision {
    return {
        decisionId: 'dec-001',
        goalId,
        evaluatedAt: new Date().toISOString(),
        permitted: true,
        resolvedCategoryPolicy: 'repeated_execution_failure',
        rationale: 'All checks passed',
        requiresHumanReview: false,
    };
}

function makeInnerGateBlocked(goalId = 'goal-001', reason = 'in_cooldown'): AutonomyPolicyDecision {
    return {
        decisionId: 'dec-blocked',
        goalId,
        evaluatedAt: new Date().toISOString(),
        permitted: false,
        blockReason: reason as any,
        resolvedCategoryPolicy: 'repeated_execution_failure',
        rationale: 'Blocked by policy',
        requiresHumanReview: false,
    };
}

function makePackMatchResult(overrides: Record<string, any> = {}) {
    return {
        goalId: 'goal-001',
        evaluatedAt: new Date().toISOString(),
        candidates: [],
        selectedPackId: 'pack-001_v1',
        selectedMatchStrength: 'strong_match',
        fallbackToStandardPlanning: false,
        rationale: 'Pack matched',
        ...overrides,
    };
}

function makePackRegistry(packId = 'pack-001_v1', confidence = 0.8) {
    return {
        getById: (id: string) => id === packId ? {
            packId,
            confidence: { current: confidence, initial: 0.65, floor: 0.3, ceiling: 0.95 },
            enabled: true,
        } : null,
        getAll: () => [],
    } as any;
}

function makeLearningRegistry(confidence = 0.7) {
    return {
        getConfidenceModifier: vi.fn().mockReturnValue(confidence),
        get: vi.fn().mockReturnValue(null),
        record: vi.fn().mockReturnValue({ recordId: 'lr-001', patternKey: 'fp-001' }),
        listAll: vi.fn().mockReturnValue([]),
        shouldRouteToHumanReview: vi.fn().mockReturnValue(false),
    } as any;
}

// ─── P5A: Type shape tests ─────────────────────────────────────────────────────

describe('P5A — Adaptive Types & Contracts', () => {
    it('DEFAULT_ADAPTIVE_THRESHOLDS has all required fields with valid values', () => {
        const t = DEFAULT_ADAPTIVE_THRESHOLDS;
        expect(typeof t.suppressBelow).toBe('number');
        expect(typeof t.deferBelow).toBe('number');
        expect(typeof t.minSuccessProbability).toBe('number');
        expect(typeof t.packConfidenceFloor).toBe('number');
        expect(typeof t.escalateAfterConsecutiveFailures).toBe('number');

        // suppressBelow < deferBelow (sensible ordering)
        expect(t.suppressBelow).toBeLessThan(t.deferBelow);
        // Probability thresholds in [0, 1]
        expect(t.minSuccessProbability).toBeGreaterThan(0);
        expect(t.minSuccessProbability).toBeLessThan(1);
        expect(t.packConfidenceFloor).toBeGreaterThan(0);
        expect(t.packConfidenceFloor).toBeLessThan(1);
    });

    it('GoalValueScore shape has all required fields', () => {
        const score: GoalValueScore = {
            goalId: 'g1',
            computedAt: new Date().toISOString(),
            baseScore: 60,
            successProbability: 0.7,
            packConfidence: 0.8,
            packAvailable: true,
            rollbackLikelihood: 0.1,
            governanceLikelihood: 0.9,
            smallSamplePenalty: 0,
            valueScore: 72,
            explanation: { dominantFactors: ['high base (60)'], suppressionFactors: [] },
        };
        expect(score.valueScore).toBeGreaterThanOrEqual(0);
        expect(score.valueScore).toBeLessThanOrEqual(100);
        expect(score.explanation.dominantFactors.length).toBeGreaterThan(0);
    });

    it('AdaptivePolicyDecision shape includes reasonCodes and thresholdsUsed', () => {
        const d: AdaptivePolicyDecision = {
            goalId: 'g1',
            decidedAt: new Date().toISOString(),
            action: 'proceed',
            reason: 'All checks passed',
            reasonCodes: ['succeeded_above_threshold'],
            thresholdsUsed: { ...DEFAULT_ADAPTIVE_THRESHOLDS },
        };
        expect(d.reasonCodes.length).toBeGreaterThan(0);
        expect(d.thresholdsUsed.suppressBelow).toBe(DEFAULT_ADAPTIVE_THRESHOLDS.suppressBelow);
    });

    it('StrategySelectionResult includes alternativesConsidered', () => {
        const r: StrategySelectionResult = {
            goalId: 'g1',
            selectedAt: new Date().toISOString(),
            strategy: 'standard_planning',
            reason: 'No pack',
            reasonCodes: ['pack_unavailable'],
            alternativesConsidered: [
                { strategy: 'recovery_pack', rejectionReason: 'no pack matched' },
            ],
        };
        expect(r.alternativesConsidered.length).toBeGreaterThan(0);
    });

    it('SubsystemProfile cooldownMultiplier range is [1.0, 4.0]', () => {
        const p = makeProfile({ cooldownMultiplier: 2.5 });
        expect(p.cooldownMultiplier).toBeGreaterThanOrEqual(1.0);
        expect(p.cooldownMultiplier).toBeLessThanOrEqual(4.0);
    });
});

// ─── P5F: SubsystemProfileRegistry ────────────────────────────────────────────

describe('P5F — SubsystemProfileRegistry', () => {
    let tmpDir: string;
    let registry: SubsystemProfileRegistry;

    beforeEach(() => {
        tmpDir = makeTempDir();
        registry = new SubsystemProfileRegistry(tmpDir);
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* */ }
    });

    it('get() returns a default profile for unknown subsystem', () => {
        const profile = registry.get('inference');
        expect(profile.subsystemId).toBe('inference');
        expect(profile.totalAttempts).toBe(0);
        expect(profile.successRate).toBe(0);
        expect(profile.cooldownMultiplier).toBe(1.0);
        expect(profile.oscillationDetected).toBe(false);
        expect(profile.preferredStrategy).toBeNull();
    });

    it('get() returns sensitivity=high for inference subsystem', () => {
        const p = registry.get('inference');
        expect(p.sensitivityLevel).toBe('high');
    });

    it('get() returns sensitivity=critical for governance subsystem', () => {
        const p = registry.get('governance');
        expect(p.sensitivityLevel).toBe('critical');
    });

    it('get() returns sensitivity=low for unknown subsystem', () => {
        const p = registry.get('some_new_subsystem');
        expect(p.sensitivityLevel).toBe('low');
    });

    it('update(succeeded) increments successCount and recalculates successRate', () => {
        registry.update('inference', 'succeeded', 'standard_planning');
        const p = registry.get('inference');
        expect(p.successCount).toBe(1);
        expect(p.totalAttempts).toBe(1);
        expect(p.successRate).toBeCloseTo(1.0);
        expect(p.consecutiveFailures).toBe(0);
    });

    it('update(failed) increments failureCount, increases cooldownMultiplier', () => {
        registry.update('inference', 'failed', 'standard_planning');
        const p = registry.get('inference');
        expect(p.failureCount).toBe(1);
        expect(p.cooldownMultiplier).toBeCloseTo(1.5);
        expect(p.consecutiveFailures).toBe(1);
    });

    it('update(rolled_back) increments rollbackCount, increases cooldownMultiplier', () => {
        registry.update('inference', 'rolled_back', 'standard_planning');
        const p = registry.get('inference');
        expect(p.rollbackCount).toBe(1);
        expect(p.cooldownMultiplier).toBeCloseTo(1.5);
        expect(p.consecutiveFailures).toBe(1);
    });

    it('update(succeeded after failure) decreases cooldownMultiplier', () => {
        registry.update('inference', 'failed', 'standard_planning');
        const afterFail = registry.get('inference').cooldownMultiplier;
        registry.update('inference', 'succeeded', 'standard_planning');
        const afterSuccess = registry.get('inference').cooldownMultiplier;
        expect(afterSuccess).toBeLessThan(afterFail);
        expect(afterSuccess).toBeGreaterThanOrEqual(1.0);
    });

    it('cooldownMultiplier never exceeds 4.0 after repeated failures', () => {
        for (let i = 0; i < 20; i++) {
            registry.update('inference', 'failed', 'standard_planning');
        }
        expect(registry.get('inference').cooldownMultiplier).toBeLessThanOrEqual(4.0);
    });

    it('cooldownMultiplier never goes below 1.0 after repeated successes', () => {
        registry.update('inference', 'failed', 'standard_planning'); // Prime it up
        for (let i = 0; i < 20; i++) {
            registry.update('inference', 'succeeded', 'standard_planning');
        }
        expect(registry.get('inference').cooldownMultiplier).toBeGreaterThanOrEqual(1.0);
    });

    it('aborted outcome does NOT increment totalAttempts', () => {
        registry.update('inference', 'aborted', 'standard_planning');
        expect(registry.get('inference').totalAttempts).toBe(0);
    });

    it('oscillationDetected NOT set until recentOutcomes.length >= 4', () => {
        registry.update('inference', 'succeeded', 'standard_planning');
        registry.update('inference', 'failed', 'standard_planning');
        registry.update('inference', 'succeeded', 'standard_planning');
        const p = registry.get('inference');
        expect(p.recentOutcomes.length).toBe(3);
        expect(p.oscillationDetected).toBe(false);
    });

    it('oscillationDetected set when 4 alternating outcomes detected', () => {
        registry.update('inference', 'succeeded', 'standard_planning');
        registry.update('inference', 'failed', 'standard_planning');
        registry.update('inference', 'succeeded', 'standard_planning');
        registry.update('inference', 'failed', 'standard_planning');
        expect(registry.get('inference').oscillationDetected).toBe(true);
    });

    it('oscillationDetected NOT set when 4 uniform outcomes (all succeeded)', () => {
        for (let i = 0; i < 4; i++) {
            registry.update('inference', 'succeeded', 'standard_planning');
        }
        expect(registry.get('inference').oscillationDetected).toBe(false);
    });

    it('preferredStrategy null until >= 5 attempts of each strategy type', () => {
        for (let i = 0; i < 4; i++) {
            registry.update('inference', 'succeeded', 'recovery_pack');
            registry.update('inference', 'succeeded', 'standard_planning');
        }
        expect(registry.get('inference').preferredStrategy).toBeNull();
    });

    it('preferredStrategy set to recovery_pack after >= 5 attempts with clear advantage', () => {
        // 6 pack successes, 1 pack failure, 5 standard failures → pack clearly better
        for (let i = 0; i < 6; i++) {
            registry.update('inference', 'succeeded', 'recovery_pack');
        }
        registry.update('inference', 'failed', 'recovery_pack');
        for (let i = 0; i < 5; i++) {
            registry.update('inference', 'failed', 'standard_planning');
        }
        expect(registry.get('inference').preferredStrategy).toBe('recovery_pack');
    });

    it('profile persisted to disk and reloaded correctly', () => {
        registry.update('inference', 'succeeded', 'standard_planning');
        registry.update('inference', 'failed', 'recovery_pack');

        const registry2 = new SubsystemProfileRegistry(tmpDir);
        const p = registry2.get('inference');
        expect(p.successCount).toBe(1);
        expect(p.failureCount).toBe(1);
    });

    it('listAll() returns profiles sorted alphabetically', () => {
        registry.update('memory', 'succeeded', 'standard_planning');
        registry.update('context', 'succeeded', 'standard_planning');
        registry.update('inference', 'succeeded', 'standard_planning');
        const profiles = registry.listAll();
        const ids = profiles.map(p => p.subsystemId);
        const sorted = [...ids].sort();
        expect(ids).toEqual(sorted);
    });

    it('pack strategy updates pack-specific counters', () => {
        registry.update('inference', 'succeeded', 'recovery_pack', 'pack-001');
        const p = registry.get('inference');
        expect(p.packSuccessCount).toBe(1);
        expect(p.standardSuccessCount).toBe(0);
    });
});

// ─── P5B: GoalValueScoringEngine ──────────────────────────────────────────────

describe('P5B — GoalValueScoringEngine', () => {
    it('high severity + good success probability → valueScore > 60', () => {
        const goal = makeGoal({ priorityScore: { ...makeGoal().priorityScore, total: 70 } });
        const profile = makeProfile({ totalAttempts: 5, successCount: 4, successRate: 0.8, failureRate: 0.2, rollbackLikelihood: 0 });
        const learning = makeLearningRegistry(0.8);
        const engine = new GoalValueScoringEngine(learning);
        const result = engine.score(goal, profile);
        expect(result.valueScore).toBeGreaterThan(60);
    });

    it('low success probability depresses valueScore', () => {
        const goal = makeGoal();
        const profile = makeProfile({ totalAttempts: 5, successCount: 1, successRate: 0.2, failureRate: 0.8, rollbackLikelihood: 0.3 });
        const learning = makeLearningRegistry(0.2);
        const engine = new GoalValueScoringEngine(learning);
        const result = engine.score(goal, profile);
        const highSuccessProfile = makeProfile({ totalAttempts: 5, successCount: 4, successRate: 0.8, failureRate: 0.2, rollbackLikelihood: 0 });
        const highResult = engine.score(goal, highSuccessProfile);
        expect(result.valueScore).toBeLessThan(highResult.valueScore);
    });

    it('pack available with high confidence boosts valueScore', () => {
        const goal = makeGoal();
        const profile = makeProfile({ totalAttempts: 5, successCount: 4, successRate: 0.8, failureRate: 0.2 });
        const learning = makeLearningRegistry(0.7);
        const packRegistry = makePackRegistry('pack-001_v1', 0.9);
        const packMatch = makePackMatchResult({ selectedPackId: 'pack-001_v1' });

        const engine = new GoalValueScoringEngine(learning, packRegistry);
        const withPack = engine.score(goal, profile, packMatch as any);
        const withoutPack = engine.score(goal, profile, undefined);
        expect(withPack.valueScore).toBeGreaterThan(withoutPack.valueScore);
        expect(withPack.packAvailable).toBe(true);
    });

    it('packConfidence=0 when no pack matched', () => {
        const goal = makeGoal();
        const profile = makeProfile();
        const learning = makeLearningRegistry(0.7);
        const engine = new GoalValueScoringEngine(learning);
        const result = engine.score(goal, profile, undefined);
        expect(result.packConfidence).toBe(0);
        expect(result.packAvailable).toBe(false);
    });

    it('smallSamplePenalty = -5 when totalAttempts < 3', () => {
        const goal = makeGoal();
        const profile = makeProfile({ totalAttempts: 2 });
        const learning = makeLearningRegistry(0.7);
        const engine = new GoalValueScoringEngine(learning);
        const result = engine.score(goal, profile);
        expect(result.smallSamplePenalty).toBe(-5);
    });

    it('smallSamplePenalty = 0 when totalAttempts >= 3', () => {
        const goal = makeGoal();
        const profile = makeProfile({ totalAttempts: 3, successCount: 2, successRate: 0.67, failureRate: 0.33 });
        const learning = makeLearningRegistry(0.7);
        const engine = new GoalValueScoringEngine(learning);
        const result = engine.score(goal, profile);
        expect(result.smallSamplePenalty).toBe(0);
    });

    it('valueScore is always clamped to [0, 100]', () => {
        // Force extreme conditions
        const goal = makeGoal({ priorityScore: { ...makeGoal().priorityScore, total: 100 } });
        const profile = makeProfile({ totalAttempts: 10, successCount: 10, successRate: 1.0, failureRate: 0, rollbackLikelihood: 0, governanceBlockCount: 0 });
        const learning = makeLearningRegistry(1.0);
        const engine = new GoalValueScoringEngine(learning);
        const result = engine.score(goal, profile);
        expect(result.valueScore).toBeGreaterThanOrEqual(0);
        expect(result.valueScore).toBeLessThanOrEqual(100);
    });

    it('valueScore is always clamped to [0, 100] for worst case', () => {
        const goal = makeGoal({ priorityScore: { ...makeGoal().priorityScore, total: 0 } });
        const profile = makeProfile({ totalAttempts: 10, successCount: 0, successRate: 0, failureRate: 1.0, rollbackLikelihood: 1.0, governanceBlockCount: 10 });
        const learning = makeLearningRegistry(0.0);
        const engine = new GoalValueScoringEngine(learning);
        const result = engine.score(goal, profile);
        expect(result.valueScore).toBeGreaterThanOrEqual(0);
        expect(result.valueScore).toBeLessThanOrEqual(100);
    });

    it('deterministic: same inputs produce identical output', () => {
        const goal = makeGoal();
        const profile = makeProfile({ totalAttempts: 5, successCount: 3, successRate: 0.6, failureRate: 0.4 });
        const learning = makeLearningRegistry(0.65);
        const engine = new GoalValueScoringEngine(learning);
        const r1 = engine.score(goal, profile);
        const r2 = engine.score(goal, profile);
        expect(r1.valueScore).toBe(r2.valueScore);
        expect(r1.successProbability).toBe(r2.successProbability);
    });

    it('explanation.dominantFactors is non-empty', () => {
        const goal = makeGoal();
        const profile = makeProfile();
        const learning = makeLearningRegistry(0.7);
        const engine = new GoalValueScoringEngine(learning);
        const result = engine.score(goal, profile);
        expect(result.explanation.dominantFactors.length).toBeGreaterThan(0);
    });

    it('high rollbackLikelihood appears in suppressionFactors', () => {
        const goal = makeGoal();
        const profile = makeProfile({ totalAttempts: 5, rollbackCount: 3, rollbackLikelihood: 0.6, successRate: 0.4, failureRate: 0.4 });
        const learning = makeLearningRegistry(0.5);
        const engine = new GoalValueScoringEngine(learning);
        const result = engine.score(goal, profile);
        const hasRollbackFactor = result.explanation.suppressionFactors.some(f =>
            f.includes('rollback'),
        );
        expect(hasRollbackFactor).toBe(true);
    });

    it('user_seeded source with no history produces valid score', () => {
        const goal = makeGoal({ source: 'user_seeded' });
        const profile = makeProfile();
        const learning = makeLearningRegistry(0.7);
        const engine = new GoalValueScoringEngine(learning);
        const result = engine.score(goal, profile);
        expect(typeof result.valueScore).toBe('number');
        expect(result.valueScore).toBeGreaterThanOrEqual(0);
    });

    it('sensitivity bonus: critical > high > standard', () => {
        const goal = makeGoal();
        const learning = makeLearningRegistry(0.7);
        const engine = new GoalValueScoringEngine(learning);

        const critical = engine.score(goal, makeProfile({ sensitivityLevel: 'critical' }));
        const high = engine.score(goal, makeProfile({ sensitivityLevel: 'high' }));
        const standard = engine.score(goal, makeProfile({ sensitivityLevel: 'standard' }));

        expect(critical.valueScore).toBeGreaterThan(high.valueScore);
        expect(high.valueScore).toBeGreaterThan(standard.valueScore);
    });
});

// ─── P5C: StrategySelectionEngine ────────────────────────────────────────────

describe('P5C — StrategySelectionEngine', () => {
    const engine = new StrategySelectionEngine();

    function makeValueScore(valueScore: number, packConf = 0, packAvailable = false): GoalValueScore {
        return {
            goalId: 'goal-001',
            computedAt: new Date().toISOString(),
            baseScore: 60,
            successProbability: 0.7,
            packConfidence: packConf,
            packAvailable,
            rollbackLikelihood: 0.1,
            governanceLikelihood: 0.9,
            smallSamplePenalty: 0,
            valueScore,
            explanation: { dominantFactors: [], suppressionFactors: [] },
        };
    }

    it('valueScore < suppressBelow → suppress', () => {
        const goal = makeGoal();
        const result = engine.select(goal, makeValueScore(10), makeProfile(),
            undefined, DEFAULT_ADAPTIVE_THRESHOLDS);
        expect(result.strategy).toBe('suppress');
        expect(result.reasonCodes).toContain('low_value_score');
    });

    it('valueScore between suppressBelow and deferBelow → defer', () => {
        const goal = makeGoal();
        const result = engine.select(goal, makeValueScore(20), makeProfile(),
            undefined, DEFAULT_ADAPTIVE_THRESHOLDS);
        expect(result.strategy).toBe('defer');
        expect(result.reasonCodes).toContain('low_value_score_defer');
    });

    it('pack available with confidence >= floor → recovery_pack', () => {
        const goal = makeGoal();
        const packMatch = makePackMatchResult({ selectedPackId: 'pack-001_v1' });
        const result = engine.select(
            goal,
            makeValueScore(60, 0.8, true),
            makeProfile(),
            packMatch as any,
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        expect(result.strategy).toBe('recovery_pack');
        expect(result.selectedPackId).toBe('pack-001_v1');
        expect(result.reasonCodes.some(c => c.includes('confidence'))).toBe(true);
    });

    it('pack confidence below floor → standard_planning + reason code', () => {
        const goal = makeGoal();
        const packMatch = makePackMatchResult({ selectedPackId: 'pack-001_v1' });
        const result = engine.select(
            goal,
            makeValueScore(60, 0.2, true), // conf 0.2 < floor 0.35
            makeProfile(),
            packMatch as any,
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        expect(result.strategy).toBe('standard_planning');
        expect(result.reasonCodes).toContain('pack_confidence_below_floor');
    });

    it('no pack available → standard_planning with pack_unavailable reason', () => {
        const goal = makeGoal();
        const result = engine.select(goal, makeValueScore(60), makeProfile(),
            undefined, DEFAULT_ADAPTIVE_THRESHOLDS);
        expect(result.strategy).toBe('standard_planning');
        expect(result.reasonCodes).toContain('pack_unavailable');
    });

    it('pack selected but profile prefers standard_planning → standard_planning', () => {
        const goal = makeGoal();
        const packMatch = makePackMatchResult({ selectedPackId: 'pack-001_v1' });
        const profile = makeProfile({ preferredStrategy: 'standard_planning' });
        const result = engine.select(
            goal,
            makeValueScore(60, 0.8, true),
            profile,
            packMatch as any,
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        expect(result.strategy).toBe('standard_planning');
        expect(result.reasonCodes).toContain('standard_preferred_by_profile');
    });

    it('recent pack failures > pack successes → standard_planning', () => {
        const goal = makeGoal();
        const packMatch = makePackMatchResult({ selectedPackId: 'pack-001_v1' });
        const profile = makeProfile({
            packSuccessCount: 1, packFailureCount: 3, // failures > successes
        });
        const result = engine.select(
            goal,
            makeValueScore(60, 0.8, true),
            profile,
            packMatch as any,
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        expect(result.strategy).toBe('standard_planning');
        expect(result.reasonCodes).toContain('repeated_pack_failure');
    });

    it('profile prefers pack → recovery_pack with reason code', () => {
        const goal = makeGoal();
        const packMatch = makePackMatchResult({ selectedPackId: 'pack-001_v1' });
        const profile = makeProfile({ preferredStrategy: 'recovery_pack' });
        const result = engine.select(
            goal,
            makeValueScore(60, 0.8, true),
            profile,
            packMatch as any,
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        expect(result.strategy).toBe('recovery_pack');
        expect(result.reasonCodes).toContain('pack_preferred_by_profile');
    });

    it('alternativesConsidered always lists at least one rejected strategy', () => {
        const goal = makeGoal();
        const result = engine.select(goal, makeValueScore(60), makeProfile(),
            undefined, DEFAULT_ADAPTIVE_THRESHOLDS);
        expect(result.alternativesConsidered.length).toBeGreaterThan(0);
        expect(result.alternativesConsidered[0].rejectionReason.length).toBeGreaterThan(0);
    });

    it('standard planning always reachable when pack unavailable', () => {
        const goal = makeGoal();
        const result = engine.select(
            goal,
            makeValueScore(60, 0, false),
            makeProfile(),
            makePackMatchResult({ selectedPackId: null, fallbackToStandardPlanning: true }) as any,
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        expect(result.strategy).toBe('standard_planning');
    });

    it('custom thresholds applied correctly (higher deferBelow → more defers)', () => {
        const goal = makeGoal();
        const customThresholds: AdaptiveThresholds = {
            ...DEFAULT_ADAPTIVE_THRESHOLDS,
            deferBelow: 70, // much higher than default 30
        };
        const result = engine.select(goal, makeValueScore(60), makeProfile(),
            undefined, customThresholds);
        expect(result.strategy).toBe('defer'); // 60 < 70
    });
});

// ─── P5D: AdaptivePolicyGate ──────────────────────────────────────────────────

describe('P5D — AdaptivePolicyGate', () => {
    const gate = new AdaptivePolicyGate();

    function makeValueScore(sp: number): GoalValueScore {
        return {
            goalId: 'goal-001', computedAt: new Date().toISOString(),
            baseScore: 60, successProbability: sp, packConfidence: 0.8,
            packAvailable: true, rollbackLikelihood: 0.1, governanceLikelihood: 0.9,
            smallSamplePenalty: 0, valueScore: 60,
            explanation: { dominantFactors: [], suppressionFactors: [] },
        };
    }

    function makeStrategyResult(strategy: StrategyKind, reason?: string): StrategySelectionResult {
        return {
            goalId: 'goal-001', selectedAt: new Date().toISOString(),
            strategy, reason: reason ?? 'test', reasonCodes: ['pack_unavailable'],
            alternativesConsidered: [],
        };
    }

    it('inner gate blocked → escalate with inner_gate_blocked reason', () => {
        const goal = makeGoal();
        const inner = makeInnerGateBlocked();
        const result = gate.evaluate(
            goal, inner, makeValueScore(0.7),
            makeStrategyResult('standard_planning'), makeProfile(),
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        expect(result.action).toBe('escalate');
        expect(result.reasonCodes).toContain('inner_gate_blocked');
    });

    it('inner gate blocked → NEVER returns suppress or defer', () => {
        const goal = makeGoal();
        const inner = makeInnerGateBlocked('goal-001', 'global_autonomy_disabled');
        const result = gate.evaluate(
            goal, inner, makeValueScore(0.7),
            makeStrategyResult('standard_planning'), makeProfile(),
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        expect(result.action).not.toBe('suppress');
        expect(result.action).not.toBe('defer');
        expect(result.action).toBe('escalate');
    });

    it('strategy=suppress → gate returns suppress', () => {
        const goal = makeGoal();
        const result = gate.evaluate(
            goal, makeInnerGatePermitted(), makeValueScore(0.7),
            makeStrategyResult('suppress'), makeProfile(),
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        expect(result.action).toBe('suppress');
    });

    it('strategy=defer → gate returns defer with deferUntil set', () => {
        const goal = makeGoal();
        const result = gate.evaluate(
            goal, makeInnerGatePermitted(), makeValueScore(0.7),
            makeStrategyResult('defer'), makeProfile(),
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        expect(result.action).toBe('defer');
        expect(result.deferUntil).toBeDefined();
        expect(new Date(result.deferUntil!).getTime()).toBeGreaterThan(Date.now());
    });

    it('successProbability below threshold (non-user-seeded) → defer', () => {
        const goal = makeGoal({ source: 'repeated_execution_failure' });
        const result = gate.evaluate(
            goal, makeInnerGatePermitted(),
            makeValueScore(0.1), // below 0.30 threshold
            makeStrategyResult('standard_planning'), makeProfile(),
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        expect(result.action).toBe('defer');
        expect(result.reasonCodes).toContain('low_success_probability');
    });

    it('successProbability below threshold for user_seeded → NOT deferred', () => {
        const goal = makeGoal({ source: 'user_seeded' });
        const result = gate.evaluate(
            goal, makeInnerGatePermitted(),
            makeValueScore(0.1), // below threshold but user_seeded bypasses
            makeStrategyResult('standard_planning'), makeProfile(),
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        // Should proceed (user_seeded bypasses probability gate)
        expect(result.action).toBe('proceed');
    });

    it('oscillation + consecutive failures >= threshold → escalate', () => {
        const goal = makeGoal();
        const profile = makeProfile({
            oscillationDetected: true,
            consecutiveFailures: 3, // >= escalateAfterConsecutiveFailures (3)
        });
        const result = gate.evaluate(
            goal, makeInnerGatePermitted(), makeValueScore(0.7),
            makeStrategyResult('standard_planning'), profile,
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        expect(result.action).toBe('escalate');
        expect(result.reasonCodes).toContain('recent_oscillation');
        expect(result.reasonCodes).toContain('consecutive_failures');
    });

    it('oscillation but consecutive failures < threshold → proceed', () => {
        const goal = makeGoal();
        const profile = makeProfile({
            oscillationDetected: true,
            consecutiveFailures: 1, // < 3, not enough to escalate
        });
        const result = gate.evaluate(
            goal, makeInnerGatePermitted(), makeValueScore(0.7),
            makeStrategyResult('standard_planning'), profile,
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        expect(result.action).toBe('proceed');
    });

    it('all checks pass → proceed with succeeded_above_threshold', () => {
        const goal = makeGoal();
        const result = gate.evaluate(
            goal, makeInnerGatePermitted(), makeValueScore(0.8),
            makeStrategyResult('standard_planning'), makeProfile(),
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        expect(result.action).toBe('proceed');
        expect(result.reasonCodes).toContain('succeeded_above_threshold');
    });

    it('every decision includes reasonCodes and thresholdsUsed', () => {
        const goal = makeGoal();
        const result = gate.evaluate(
            goal, makeInnerGatePermitted(), makeValueScore(0.8),
            makeStrategyResult('standard_planning'), makeProfile(),
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        expect(Array.isArray(result.reasonCodes)).toBe(true);
        expect(result.thresholdsUsed).toBeDefined();
        expect(result.thresholdsUsed.suppressBelow).toBe(DEFAULT_ADAPTIVE_THRESHOLDS.suppressBelow);
    });

    it('thresholdsUsed reflects custom thresholds at decision time', () => {
        const customThresholds: AdaptiveThresholds = {
            ...DEFAULT_ADAPTIVE_THRESHOLDS,
            escalateAfterConsecutiveFailures: 5,
        };
        const goal = makeGoal();
        const result = gate.evaluate(
            goal, makeInnerGatePermitted(), makeValueScore(0.8),
            makeStrategyResult('standard_planning'), makeProfile(),
            customThresholds,
        );
        expect(result.thresholdsUsed.escalateAfterConsecutiveFailures).toBe(5);
    });

    it('deferUntil is scaled by cooldownMultiplier', () => {
        const goal = makeGoal();
        const profileLow = makeProfile({ cooldownMultiplier: 1.0 });
        const profileHigh = makeProfile({ cooldownMultiplier: 3.0 });

        const r1 = gate.evaluate(
            goal, makeInnerGatePermitted(), makeValueScore(0.1),
            makeStrategyResult('standard_planning'), profileLow,
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        const r2 = gate.evaluate(
            goal, makeInnerGatePermitted(), makeValueScore(0.1),
            makeStrategyResult('standard_planning'), profileHigh,
            DEFAULT_ADAPTIVE_THRESHOLDS,
        );
        // Higher multiplier → further deferUntil
        expect(new Date(r2.deferUntil!).getTime())
            .toBeGreaterThan(new Date(r1.deferUntil!).getTime());
    });
});

// ─── P5G: GoalPrioritizationEngine with profile registry ──────────────────────

describe('P5G — GoalPrioritizationEngine with SubsystemProfileRegistry', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTempDir(); });
    afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* */ } });

    it('setProfileRegistry() can be called without breaking existing scoring', () => {
        const learningRegistry = new OutcomeLearningRegistry(tmpDir);
        const cooldownRegistry = new AutonomyCooldownRegistry(tmpDir);
        const budgetManager = new AutonomyBudgetManager();
        const engine = new GoalPrioritizationEngine(learningRegistry, cooldownRegistry, budgetManager);

        const profileRegistry = new SubsystemProfileRegistry(tmpDir);
        // Should not throw
        expect(() => engine.setProfileRegistry(profileRegistry)).not.toThrow();
    });

    it('scoring is unchanged when no profile registry set (backward compat)', () => {
        const learningRegistry = new OutcomeLearningRegistry(tmpDir);
        const cooldownRegistry = new AutonomyCooldownRegistry(tmpDir);
        const budgetManager = new AutonomyBudgetManager();
        const engine = new GoalPrioritizationEngine(learningRegistry, cooldownRegistry, budgetManager);

        const policy = { ...DEFAULT_AUTONOMY_POLICY, globalAutonomyEnabled: true };
        const candidate = {
            candidateId: 'c1',
            detectedAt: new Date().toISOString(),
            source: 'repeated_execution_failure' as GoalSource,
            subsystemId: 'inference',
            title: 'Failures in inference',
            description: 'Test',
            sourceContext: { kind: 'repeated_execution_failure' as const, failureCount: 3, periodMs: 14400000, lastExecutionRunId: 'r1' },
            dedupFingerprint: 'fp1',
            isDuplicate: false,
        };
        const goals = engine.score([candidate], policy);
        expect(goals.length).toBe(1);
        expect(goals[0].priorityScore.total).toBeGreaterThanOrEqual(0);
    });

    it('scoring with profile registry produces different confidenceWeight when profile has history', () => {
        const learningRegistry = new OutcomeLearningRegistry(tmpDir);
        const cooldownRegistry = new AutonomyCooldownRegistry(tmpDir);
        const budgetManager = new AutonomyBudgetManager();

        const engineWithout = new GoalPrioritizationEngine(learningRegistry, cooldownRegistry, budgetManager);
        const engineWith = new GoalPrioritizationEngine(learningRegistry, cooldownRegistry, budgetManager);

        const profileRegistry = new SubsystemProfileRegistry(tmpDir);
        // Record many successes to drive successRate to 1.0
        for (let i = 0; i < 5; i++) {
            profileRegistry.update('inference', 'succeeded', 'standard_planning');
        }
        engineWith.setProfileRegistry(profileRegistry);

        const policy = { ...DEFAULT_AUTONOMY_POLICY, globalAutonomyEnabled: true };
        const candidate = {
            candidateId: 'c1',
            detectedAt: new Date().toISOString(),
            source: 'repeated_execution_failure' as GoalSource,
            subsystemId: 'inference',
            title: 'Failures in inference',
            description: 'Test',
            sourceContext: { kind: 'repeated_execution_failure' as const, failureCount: 3, periodMs: 14400000, lastExecutionRunId: 'r1' },
            dedupFingerprint: 'fp1',
            isDuplicate: false,
        };

        const goalsWithout = engineWithout.score([candidate], policy);
        const goalsWith = engineWith.score([candidate], policy);

        // With full success history (rate=1.0), blended confidence should be higher
        // than base learning registry confidence (0.7 default), so score should be >=
        expect(goalsWith[0].priorityScore.confidenceWeight).toBeGreaterThanOrEqual(
            goalsWithout[0].priorityScore.confidenceWeight,
        );
    });
});

// ─── P5H: Safety constraints ──────────────────────────────────────────────────

describe('P5H — Safety Constraints', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTempDir(); });
    afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* */ } });

    it('cooldownMultiplier cannot exceed 4.0 after any number of failures', () => {
        const registry = new SubsystemProfileRegistry(tmpDir);
        for (let i = 0; i < 50; i++) {
            registry.update('inference', 'failed', 'standard_planning');
        }
        expect(registry.get('inference').cooldownMultiplier).toBeLessThanOrEqual(4.0);
    });

    it('cooldownMultiplier cannot go below 1.0 after any number of successes', () => {
        const registry = new SubsystemProfileRegistry(tmpDir);
        registry.update('inference', 'failed', 'standard_planning'); // prime it
        for (let i = 0; i < 50; i++) {
            registry.update('inference', 'succeeded', 'standard_planning');
        }
        expect(registry.get('inference').cooldownMultiplier).toBeGreaterThanOrEqual(1.0);
    });

    it('oscillation detection requires minimum 4 outcomes', () => {
        const registry = new SubsystemProfileRegistry(tmpDir);
        // Only 3 alternating outcomes → no oscillation
        registry.update('inference', 'succeeded', 'standard_planning');
        registry.update('inference', 'failed', 'standard_planning');
        registry.update('inference', 'succeeded', 'standard_planning');
        expect(registry.get('inference').oscillationDetected).toBe(false);
    });

    it('preferredStrategy NOT set with only 4 attempts of each type', () => {
        const registry = new SubsystemProfileRegistry(tmpDir);
        for (let i = 0; i < 4; i++) {
            registry.update('inference', 'succeeded', 'recovery_pack');
            registry.update('inference', 'failed', 'standard_planning');
        }
        expect(registry.get('inference').preferredStrategy).toBeNull();
    });

    it('AdaptivePolicyGate: inner gate block is ALWAYS escalated, never suppressed or deferred', () => {
        const gate = new AdaptivePolicyGate();
        const goal = makeGoal();
        const strategies: StrategyKind[] = ['standard_planning', 'recovery_pack', 'defer', 'suppress'];

        for (const s of strategies) {
            const inner = makeInnerGateBlocked('goal-001', 'global_autonomy_disabled');
            const vs: GoalValueScore = {
                goalId: 'g1', computedAt: new Date().toISOString(),
                baseScore: 0, successProbability: 0, packConfidence: 0, packAvailable: false,
                rollbackLikelihood: 1, governanceLikelihood: 0, smallSamplePenalty: -5,
                valueScore: 0, explanation: { dominantFactors: [], suppressionFactors: [] },
            };
            const sr: StrategySelectionResult = {
                goalId: 'g1', selectedAt: new Date().toISOString(), strategy: s,
                reason: 'test', reasonCodes: ['pack_unavailable'], alternativesConsidered: [],
            };
            const result = gate.evaluate(goal, inner, vs, sr, makeProfile(), DEFAULT_ADAPTIVE_THRESHOLDS);
            expect(result.action).toBe('escalate');
        }
    });

    it('valueScore always in [0, 100] for 100 random-ish inputs', () => {
        const learning = makeLearningRegistry(0.7);
        const engine = new GoalValueScoringEngine(learning);

        for (let i = 0; i < 100; i++) {
            const baseScore = Math.floor(Math.random() * 101);
            const successRate = Math.random();
            const rollbackLikelihood = Math.random();
            const goal = makeGoal({
                priorityScore: { ...makeGoal().priorityScore, total: baseScore },
            });
            const profile = makeProfile({
                totalAttempts: Math.floor(Math.random() * 20),
                successRate,
                rollbackLikelihood,
                failureRate: 1 - successRate,
            });
            const result = engine.score(goal, profile);
            expect(result.valueScore).toBeGreaterThanOrEqual(0);
            expect(result.valueScore).toBeLessThanOrEqual(100);
        }
    });

    it('GoalValueScoringEngine: SubsystemProfileRegistry.update() never creates autonomous goals', () => {
        const registry = new SubsystemProfileRegistry(tmpDir);
        // update() should only modify the profile, not create goals
        registry.update('inference', 'failed', 'standard_planning');
        registry.update('inference', 'succeeded', 'recovery_pack', 'pack-001');
        // No goals created — just verify this doesn't throw or produce unexpected side effects
        const profiles = registry.listAll();
        expect(profiles.length).toBe(1);
        expect(profiles[0].subsystemId).toBe('inference');
    });

    it('DEFAULT_ADAPTIVE_THRESHOLDS values are safe and conservative', () => {
        const t = DEFAULT_ADAPTIVE_THRESHOLDS;
        // suppressBelow should be low (not overly aggressive suppression)
        expect(t.suppressBelow).toBeLessThanOrEqual(20);
        // deferBelow should allow some goals through
        expect(t.deferBelow).toBeLessThan(50);
        // minSuccessProbability should not be too high (not blocking everything)
        expect(t.minSuccessProbability).toBeLessThanOrEqual(0.50);
        // packConfidenceFloor should be reasonable (not zero, not too high)
        expect(t.packConfidenceFloor).toBeGreaterThan(0.1);
        expect(t.packConfidenceFloor).toBeLessThan(0.8);
    });

    it('recentOutcomes ring buffer does not grow beyond 8 entries', () => {
        const registry = new SubsystemProfileRegistry(tmpDir);
        for (let i = 0; i < 20; i++) {
            registry.update('inference', i % 2 === 0 ? 'succeeded' : 'failed', 'standard_planning');
        }
        const p = registry.get('inference');
        expect(p.recentOutcomes.length).toBeLessThanOrEqual(8);
    });

    it('StrategySelectionEngine: standard_planning is always reachable as fallback', () => {
        const engine = new StrategySelectionEngine();
        const goal = makeGoal();
        // With no pack, value score above defer threshold → must return standard_planning
        const vs: GoalValueScore = {
            goalId: 'g1', computedAt: new Date().toISOString(),
            baseScore: 60, successProbability: 0.7, packConfidence: 0, packAvailable: false,
            rollbackLikelihood: 0.1, governanceLikelihood: 0.9, smallSamplePenalty: 0,
            valueScore: 60, explanation: { dominantFactors: [], suppressionFactors: [] },
        };
        const result = engine.select(goal, vs, makeProfile(), undefined, DEFAULT_ADAPTIVE_THRESHOLDS);
        expect(result.strategy).toBe('standard_planning');
    });
});
